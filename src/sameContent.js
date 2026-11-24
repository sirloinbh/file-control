'use strict';

// find-same-content and remove-same-content (#394): files of any type whose bytes are exactly the same.
// - Files are grouped by size first, and only files that share a size are hashed (SHA-256, read in chunks, never loaded whole).
// - In each group one file is kept by a stated rule: the shortest path, then the oldest modification time, then the name. The list shows the rule.
// - find-same-content only lists. remove-same-content uses the shared remove flow of removal.js (confirmation value, removal log, Recycle Bin, keep rules).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, formatSize, recycleTarget } = require('./commands');
const { grant, walk, fileStamp, compareRelative } = require('./target');
const { LEFTOVER, SYSTEM_FOLDER, PROGRAM_FOLDER, rejectRepository } = require('./guards');
const { plural } = require('./plural');
const { planSafeRemovals, runConfirmedRemoval, sidecarDigest, sidecarLines, mismatchHints, holdReason, checkOne, reasonOf, fileIdOf, MAX_RECYCLE_SIZE } = require('./removal');

const CHUNK = 1024 * 1024;
// A progress line is passed on after this many files were hashed.
const PROGRESS_EVERY = 100;

// Why a file is not compared at all, or null. These places are skipped by the other whole-target commands too.
function skipReason(entry) {
  const parts = entry.relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return 'Not compared because it is a leftover from an earlier job.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Not compared because it is inside a Windows system folder.';
  if (parts.slice(0, -1).some((part) => PROGRAM_FOLDER.test(part))) return 'Not compared because it is inside a folder a program uses (such as node_modules).';
  return null;
}

// The SHA-256 of a file, read in chunks. It returns null if the file changed while it was read (its stamp differs afterwards), so a half-written file is never judged.
function hashFile(real, before) {
  const fd = fs.openSync(real, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, CHUNK, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
    if (fileStamp(fs.fstatSync(fd, { bigint: true })) !== before) return null;
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

// The rule for the file to keep: shortest relative path, then oldest modification time, then the name in Windows order.
function chooseKeeper(files) {
  const ordered = [...files].sort((a, b) => a.relative.length - b.relative.length || a.mtimeMs - b.mtimeMs || compareRelative(a.relative, b.relative));
  const [keep, next] = ordered;
  let reason = 'shortest path';
  if (keep.relative.length === next.relative.length) reason = keep.mtimeMs === next.mtimeMs ? 'first by name (same length and time)' : 'oldest of the equally short paths';
  return { keep, reason };
}

// It groups the files under the target that have exactly the same content. It does not touch files.
// It returns { target, checked, hashed, groups, skipped, copies, reclaimable }. A group is { hash, size, files, keep, keepReason }; files are
// { path, relative, size, mtimeMs, stamp } and include the file to keep. Empty files are not compared (every empty file is "the same").
// A file that cannot be read or changed while it was read goes to skipped. If onProgress(line) is given, it is called after every PROGRESS_EVERY files hashed.
function findSameContent(dir, { entries, onProgress: sink } = {}) {
  // A failing progress display does not affect the result.
  const onProgress = sink && ((line) => {
    try {
      sink(line);
    } catch {
      // ignored
    }
  });
  const access = grant(dir, ['read']);
  const listed = entries ?? walk(access.target);
  rejectRepository(access.target, listed);
  const result = { target: access.target, checked: 0, hashed: 0, groups: [], skipped: [], copies: 0, reclaimable: 0 };
  const bySize = new Map();
  for (const entry of listed) {
    if (entry.type !== 'file') continue;
    result.checked += 1;
    const reason = skipReason(entry);
    if (reason !== null) {
      result.skipped.push({ path: entry.path, reason });
      continue;
    }
    try {
      const real = access.read(entry.path);
      const stat = fs.lstatSync(real, { bigint: true });
      if (real !== entry.path || !stat.isFile()) throw new FcError('Not compared because it is not a regular file now.');
      if (stat.size === 0n) continue;
      const file = { path: real, relative: entry.relative, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), stamp: fileStamp(stat) };
      const same = bySize.get(file.size);
      if (same) same.push(file);
      else bySize.set(file.size, [file]);
    } catch (err) {
      result.skipped.push({ path: entry.path, reason: reasonOf(err) });
    }
  }
  const candidates = [...bySize.values()].filter((files) => files.length > 1);
  const total = candidates.reduce((sum, files) => sum + files.length, 0);
  if (total > 0) onProgress?.(`Hashing ${plural(total, 'file')} that share a size with another file...`);
  for (const files of candidates) {
    const byHash = new Map();
    for (const file of files) {
      let hash = null;
      try {
        hash = hashFile(access.read(file.path), file.stamp);
        if (hash === null) result.skipped.push({ path: file.path, reason: 'Not compared because the file changed while it was read.' });
      } catch (err) {
        result.skipped.push({ path: file.path, reason: reasonOf(err) });
      }
      result.hashed += 1;
      if (onProgress && result.hashed % PROGRESS_EVERY === 0) onProgress(`Hashed ${result.hashed} of ${plural(total, 'file')} so far...`);
      if (hash === null) continue;
      const same = byHash.get(hash);
      if (same) same.push(file);
      else byHash.set(hash, [file]);
    }
    for (const [hash, same] of byHash) {
      if (same.length < 2) continue;
      const { keep, reason } = chooseKeeper(same);
      result.groups.push({ hash, size: same[0].size, files: same, keep, keepReason: reason });
      result.copies += same.length - 1;
      result.reclaimable += (same.length - 1) * same[0].size;
    }
  }
  // Groups come out in a stable order: the largest copies first, then by the path of the file to keep.
  result.groups.sort((a, b) => b.size - a.size || compareRelative(a.keep.relative, b.keep.relative));
  result.skipped.sort((a, b) => compareRelative(path.relative(result.target, a.path), path.relative(result.target, b.path)));
  return result;
}

const shortHash = (hash) => hash.slice(0, 12);

function formatSameContent(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  result.groups.forEach((group, index) => {
    lines.push(`Group ${index + 1} (${plural(group.files.length, 'file')}, ${formatSize(group.size)} each, sha256 ${shortHash(group.hash)}):`);
    lines.push(`  File to keep: ${group.keep.relative} [${group.keepReason}]`);
    for (const file of group.files) if (file !== group.keep) lines.push(`  Same content: ${file.relative}`);
  });
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  lines.push(`Groups ${result.groups.length}, extra copies ${result.copies} (up to ${formatSize(result.reclaimable)}), checked ${plural(result.checked, 'file')}, skipped ${result.skipped.length}`);
  if (result.groups.length > 0) lines.push('Nothing was changed. Use remove-same-content to send the extra copies to the Recycle Bin.');
  return lines.join('\n');
}

// ---- remove-same-content ----

// It chooses the files to delete: every copy except the file to keep of each group. It does not touch files.
// - sets: for each group { label, keep: { path, size, reason, stamp } }
// - removals: files to delete ({ path, size, stamp, set, keep, keepStamp, hash, reason }). set is the number in sets.
// - kept: copies that stay ({ path, set, reason })
// - interactive: whether the session can send to the Recycle Bin (null when there is nothing to delete)
// The other values (target, checked, skipped, and so on) are those of findSameContent.
// A group whose file to keep is held back (changed within 5 minutes, not a regular file) deletes nothing. A copy that is another name (hard link) of the file to keep
// or of another group's file to keep stays, because deleting it frees no space and changes the file's change time, which would stop the rest of the run.
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE, onProgress } = {}) {
  const access = grant(dir, ['read', 'delete']);
  const entries = walk(access.target);
  const found = findSameContent(dir, { entries, onProgress });
  const checkedAt = now ?? Date.now();
  const plan = { ...found, sets: [], removals: [], kept: [], interactive: null };
  const keeperIds = new Map();
  const keeperProblems = found.groups.map((group) => {
    try {
      const real = access.read(group.keep.path);
      const stat = fs.lstatSync(real, { bigint: true });
      if (real !== group.keep.path || !stat.isFile() || fileStamp(stat) !== group.keep.stamp) throw new FcError('Kept because the file to keep changed after the search.');
      if (holdReason(stat, checkedAt) !== null) throw new FcError('Kept because the file to keep changed just now or its time is in the future, so it may still be downloading.');
      const id = fileIdOf(stat);
      if (id !== null) keeperIds.set(id, group.keep.path);
      return null;
    } catch (err) {
      return reasonOf(err);
    }
  });
  const candidates = [];
  found.groups.forEach((group, set) => {
    plan.sets.push({ label: `${plural(group.files.length, 'file')}, ${formatSize(group.size)} each, sha256 ${shortHash(group.hash)}`, keep: { ...group.keep, reason: group.keepReason } });
    for (const file of group.files) if (file !== group.keep) candidates.push({ path: file.path, file, set, group, keeperProblem: keeperProblems[set] });
  });
  const pathProblem = (p) => {
    try {
      recycleTarget(p);
      return null;
    } catch (err) {
      if (err instanceof FcError) return err.message;
      throw err;
    }
  };
  const safe = planSafeRemovals(candidates, access, {
    now: checkedAt,
    maxSize,
    sidecars: true,
    sameFileId: fileIdOf,
    precheck: (item) => item.keeperProblem,
    isChanged: (item, real, stat) => fileStamp(stat) !== item.file.stamp,
    changedReason: 'Kept because the file changed after it was compared.',
    pathProblem,
    extraKeep: (item, real, stat) => {
      const twin = keeperIds.get(fileIdOf(stat));
      if (twin === undefined) return null;
      if (twin === item.group.keep.path) return 'Kept because it is another name of the same file (hard link) as the file to keep, so deleting it would not free space.';
      return `Kept because it is another name of the same file (hard link) as the file to keep of another group (${path.relative(access.target, twin)}), so deleting it would not free space.`;
    },
    toRemoval: (item, real, stat) => ({
      path: real,
      size: Number(stat.size),
      stamp: fileStamp(stat),
      set: item.set,
      keep: item.group.keep.path,
      keepStamp: item.group.keep.stamp,
      hash: item.group.hash,
      reason: `Same content as the file to keep: ${item.group.keep.path}`,
    }),
    entry: ({ candidate, removal }, reason) => ({ path: (removal ?? candidate).path, set: candidate.set, reason }),
  });
  // A sidecar that is itself in a group of same-content files (the file to keep of another group, or a copy that was kept) is handled by that group, never taken along with a video:
  // otherwise the keeper of an image group could go to the Recycle Bin with the video it sits beside, and every copy of that image would be gone.
  const grouped = new Set(found.groups.flatMap((group) => group.files.map((file) => file.path.toLowerCase())));
  const sidecars = [];
  const sidecarKept = [...(safe.sidecarKept ?? [])];
  for (const item of safe.sidecars ?? []) {
    if (grouped.has(item.path.toLowerCase())) sidecarKept.push({ path: item.path, of: item.of, reason: 'Kept because it is part of a group of files with the same content, and is handled there.' });
    else sidecars.push(item);
  }
  return { ...plan, ...safe, ...(safe.sidecars ? { sidecars, sidecarKept } : {}) };
}

// A value that stands for the list a person saw. It changes if any file to delete or to keep, or its content hash, changes.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp, item.keep, item.keepStamp, item.hash]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['remove-same-content', plan.target, items, ...sidecarDigest(plan)])).digest('hex').slice(0, 12);
}

// Right before deleting, it checks again that the file to keep is still there and unchanged. If it is gone or changed, the copies are not deleted.
function checkKeeper(access, item) {
  let real;
  let stat;
  try {
    real = access.read(item.keep);
    stat = fs.lstatSync(real, { bigint: true });
  } catch {
    throw new FcError(`Not deleted because the file to keep could not be found: ${item.keep}`);
  }
  if (real !== item.keep || !stat.isFile() || fileStamp(stat) !== item.keepStamp) throw new FcError(`Not deleted because the file to keep changed: ${item.keep}`);
}

// It sends the extra copies to the Recycle Bin. Without confirm, or with dryRun, it only makes the list and changes nothing.
// If confirm differs from the confirmation value of the current list, it deletes nothing and marks mismatch.
// The removal log is written before deleting; if it cannot be written, nothing is deleted. One failed file does not stop the rest.
// The returned value: the value of planRemoval plus { code, dryRun, confirmed, mismatch, removed, failed, log }.
function removeSameContent(dir, { confirm, dryRun = false, now, maxSize = MAX_RECYCLE_SIZE, onProgress } = {}) {
  const plan = planRemoval(dir, { now, maxSize, onProgress });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  if (confirm === undefined || dryRun) return result;
  if (confirm !== code) return { ...result, mismatch: true, mismatchHints: mismatchHints(plan) };
  if (plan.removals.length === 0) return result;
  const total = plan.removals.length;
  const relative = (p) => path.relative(plan.target, p) || '.';
  const report = (line) => {
    try {
      onProgress?.(line);
    } catch {
      // The progress display does not affect the result.
    }
  };
  return runConfirmedRemoval(
    plan,
    result,
    'files with the same content',
    plan.removals.map((item) => ({ path: item.path, reason: item.reason, details: { keep: item.keep, group: plan.sets[item.set].label, sha256: item.hash } })),
    {
      access: ['read', 'delete'],
      onStart: () => report(`Sending to the Recycle Bin: ${total}`),
      onRemoved: (item, step) => report(`${step} Move to the Recycle Bin: ${relative(item.path)}`),
      onFailed: (item, reason, step) => report(`${step} Failed: ${relative(item.path)} (${reason})`),
      prepare: (access, item) => {
        checkKeeper(access, item);
        // The file to keep is not deleted, so it does not run the Recycle Bin path check for it; checkOne checks the copy itself.
        return { ...checkOne(access, item), keep: { path: item.keep, stamp: item.keepStamp } };
      },
      failedEntry: (item, reason) => ({ path: item.path, set: item.set, reason }),
    },
  );
}

function formatRemoveSameContent(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  const removedPaths = new Set(result.removed.map((item) => item.path));
  result.sets.forEach((set, index) => {
    lines.push(`Group (${set.label}):`);
    lines.push(`  File to keep: ${relative(set.keep.path)} [${set.keep.reason}]`);
    for (const item of result.removals.filter((entry) => entry.set === index)) {
      if (!result.confirmed) lines.push(`  To delete: ${relative(item.path)}`);
      else if (removedPaths.has(item.path)) lines.push(`  Move to the Recycle Bin: ${relative(item.path)}`);
    }
    for (const item of result.failed.filter((entry) => entry.set === index)) lines.push(`  Failed: ${relative(item.path)} (${item.reason})`);
    for (const item of result.kept.filter((entry) => entry.set === index)) lines.push(`  Kept: ${relative(item.path)} ${item.reason}`);
  });
  lines.push(...sidecarLines(result, relative));
  for (const item of result.failed.filter((entry) => entry.sidecar)) lines.push(`Failed: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  if (result.mismatch) {
    lines.push('The list changed after the confirmation value was made, so nothing was deleted.');
    for (const item of result.mismatchHints ?? []) lines.push(`Changed: ${relative(item.path)} (${item.reason})`);
  }
  if (result.logWarning) lines.push(`Warning: ${result.logWarning}`);
  if (result.log) lines.push(`Removal log: ${result.log}`);
  const counts = `kept ${result.kept.length}, skipped ${result.skipped.length}`;
  if (result.confirmed) {
    lines.push(`Groups ${result.sets.length}, Recycle Bin ${result.removed.length}, failed ${result.failed.length}, ${counts}`);
  } else {
    lines.push(`Groups ${result.sets.length}, to delete ${result.removals.length}, ${counts}`);
    if (result.removals.length > 0) lines.push(`Nothing has been deleted yet. After checking the list, run again ${result.dryRun ? 'without --dry-run and ' : ''}with --yes=${result.code} to send them to the Recycle Bin.`);
  }
  return lines.join('\n');
}

module.exports = { findSameContent, formatSameContent, planRemoval, removeSameContent, formatRemoveSameContent, confirmationCode, chooseKeeper };
