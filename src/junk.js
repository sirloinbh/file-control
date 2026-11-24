'use strict';

// find-junk and remove-junk (#391): files that are safe to throw away, each listed with the reason it is junk.
//   - unfinished downloads (.crdownload, .part, ...), zero-byte files, temp files (.tmp, ~$ lock files)
//   - "name (1).ext" copies whose content is byte-for-byte the same as "name.ext" next to them
//   - installers (.exe, .msi) that nobody touched for --older (default 30 days)
// find-junk only lists. remove-junk shows the list and a confirmation value, and with --yes=VALUE logs and sends exactly that list to the Recycle Bin,
// through the same keep rules as the other remove commands (src/removal.js): a file that changed, is still being written or downloaded, or sits on a volume
// without a Recycle Bin is kept.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk, fileStamp } = require('./target');
const { parseAge } = require('./find');
const { FOLDER_METADATA } = require('./flatten');
const { LEFTOVER, SYSTEM_FOLDER, rejectRepository } = require('./guards');
const { REMOVAL_LOG } = require('./removalLog');
const { guardedFolders, guardOf } = require('./sort');
const { planSafeRemovals, runConfirmedRemoval, mismatchHints, holdReason, checkOne, FILE_BATCH, MAX_RECYCLE_SIZE } = require('./removal');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OLDER = '30d';
const CHUNK = 1024 * 1024;

const extensions = (list) => new Set(list.split(' '));
const UNFINISHED = extensions('.crdownload .part .partial .download .opdownload');
const TEMP = extensions('.tmp .temp');
const INSTALLERS = extensions('.exe .msi');

const ext = (name) => path.extname(name).toLowerCase();
// "report (1).pdf" -> "report.pdf", "backup (2).tar.gz" -> "backup.tar.gz". Only the " (N)" that browsers and Explorer add before the extension (one or two parts) counts.
const COPY_NAME = /^(.+?) \((\d+)\)((?:\.[^. ()]+){0,2})$/;

function copyOriginal(name) {
  const match = COPY_NAME.exec(name);
  return match ? `${match[1]}${match[3]}` : null;
}

// Whether two files have exactly the same bytes. It stops at the first difference, so different big files cost little.
function sameBytes(a, b) {
  const fa = fs.openSync(a, 'r');
  try {
    const fb = fs.openSync(b, 'r');
    try {
      const x = Buffer.allocUnsafe(CHUNK);
      const y = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const nx = fs.readSync(fa, x, 0, CHUNK, null);
        const ny = fs.readSync(fb, y, 0, CHUNK, null);
        if (nx !== ny) return false;
        if (nx === 0) return true;
        if (!x.subarray(0, nx).equals(y.subarray(0, ny))) return false;
      }
    } finally {
      fs.closeSync(fb);
    }
  } finally {
    fs.closeSync(fa);
  }
}

// The newest of the modified and creation times: a copied installer keeps an old modified time but gets a new creation time.
const lastSeenMs = (stat) => Math.max(Number(stat.mtimeMs), Number(stat.birthtimeMs));

// The age limit in milliseconds (parseAge counts the days, weeks and months of find and gives milliseconds).
function olderMs(text) {
  return parseAge(text ?? DEFAULT_OLDER, 'older');
}

// It finds the junk under the target. It does not touch files.
// Returns { target, olderMs, junk, kept, skipped }. junk is a list of { path, size, reason, stamp } (a copy also has keep and keepStamp, the file it copies),
// kept are junk files left alone for now (changed a moment ago, so they may still be written), skipped are files not looked at.
function findJunk(dir, { older, now, entries: given } = {}) {
  const limit = olderMs(older);
  const access = grant(dir, ['read']);
  const entries = given ?? walk(access.target);
  rejectRepository(access.target, entries);
  const guarded = guardedFolders(entries);
  const checkedAt = now ?? Date.now();
  const result = { target: access.target, olderMs: limit, junk: [], kept: [], skipped: [] };
  const files = new Map();
  const dllFolders = new Set(entries.filter((e) => e.type === 'file' && ext(e.relative) === '.dll').map((e) => path.dirname(e.relative)));
  const classified = new Set();
  const found = [];

  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const name = path.basename(entry.relative);
    const parts = entry.relative.split(path.sep);
    if (guardOf(entry.relative, guarded) !== undefined) continue;
    if (parts.some((part) => SYSTEM_FOLDER.test(part)) || FOLDER_METADATA.test(name) || LEFTOVER.test(name) || REMOVAL_LOG.test(name)) continue;
    let stat;
    try {
      stat = fs.lstatSync(access.read(entry.path), { bigint: true });
    } catch (err) {
      result.skipped.push({ path: entry.path, reason: err instanceof FcError ? err.message : `Cannot check the file. (${err.code ?? err.message})` });
      continue;
    }
    if (!stat.isFile()) continue;
    files.set(entry.relative, { entry, stat });
    const extension = ext(name);
    let reason = null;
    if (UNFINISHED.has(extension)) reason = 'unfinished download';
    else if (stat.size === 0n) reason = 'empty file (0 bytes)';
    else if (TEMP.has(extension) || name.startsWith('~$')) reason = 'temporary file';
    else if (INSTALLERS.has(extension) && !dllFolders.has(path.dirname(entry.relative))) {
      const age = checkedAt - lastSeenMs(stat);
      if (age >= limit) reason = `installer not touched for ${Math.floor(age / DAY_MS)} days (limit ${Math.round(limit / DAY_MS)} days)`;
    }
    if (reason !== null) {
      classified.add(entry.relative);
      found.push({ entry, stat, reason });
    }
  }

  // A copy counts only when the original is a file beside it that is not junk itself (so it stays when the copy goes) and has exactly the same bytes.
  for (const [relative, { entry, stat }] of files) {
    if (classified.has(relative)) continue;
    const original = copyOriginal(path.basename(relative));
    if (original === null) continue;
    const originalRelative = path.join(path.dirname(relative), original);
    const twin = files.get(originalRelative);
    if (!twin || classified.has(originalRelative) || twin.stat.size !== stat.size) continue;
    try {
      if (!sameBytes(entry.path, twin.entry.path)) continue;
      // If either file changed while it was compared, nothing is said about it.
      if (fileStamp(fs.lstatSync(entry.path, { bigint: true })) !== fileStamp(stat) || fileStamp(fs.lstatSync(twin.entry.path, { bigint: true })) !== fileStamp(twin.stat)) continue;
    } catch {
      continue;
    }
    found.push({ entry, stat, reason: `copy of ${original}, with exactly the same content`, keep: twin.entry.path, keepStamp: fileStamp(twin.stat) });
  }

  found.sort((a, b) => (a.entry.relative < b.entry.relative ? -1 : 1));
  for (const { entry, stat, reason, keep, keepStamp } of found) {
    const hold = holdReason(stat, checkedAt);
    if (hold !== null) {
      result.kept.push({ path: entry.path, reason: hold });
      continue;
    }
    result.junk.push({ path: entry.path, size: Number(stat.size), reason, stamp: fileStamp(stat), ...(keep === undefined ? {} : { keep, keepStamp }) });
  }
  return result;
}

const relativeTo = (target) => (p) => path.relative(target, p) || '.';
const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);

function formatJunk(result) {
  const relative = relativeTo(result.target);
  const lines = [];
  for (const item of result.junk) lines.push(`Junk: ${relative(item.path)} (${item.reason}; ${formatSize(item.size)})`);
  for (const item of result.kept) lines.push(`Kept: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  const total = result.junk.reduce((sum, item) => sum + item.size, 0);
  lines.push(`Junk ${result.junk.length} (${formatSize(total)}), kept ${result.kept.length}, skipped ${result.skipped.length}`);
  return lines.join('\n');
}

// remove-junk: the junk list, filtered through the shared keep rules of src/removal.js. It does not touch files.
function planRemoval(dir, { older, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const found = findJunk(dir, { older, now });
  const access = grant(dir, ['read', 'delete']);
  const safe = planSafeRemovals(found.junk, access, {
    now,
    maxSize,
    isChanged: (item, real, stat) => fileStamp(stat) !== item.stamp,
    changedReason: 'Kept because the file changed after it was judged.',
    toRemoval: (item, real) => ({ ...item, path: real }),
    entry: ({ candidate, removal }, reason) => ({ path: (removal ?? candidate).path, reason }),
  });
  return { ...found, removals: safe.removals, kept: [...found.kept, ...safe.kept], interactive: safe.interactive, recent: safe.recent };
}

// A value that stands for the list a person saw. It changes if a file to delete or to keep is added, removed or changed, or if the age limit changes the list.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.reason, item.stamp, item.keep ?? null, item.keepStamp ?? null]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['remove-junk', plan.target, items])).digest('hex').slice(0, 12);
}

// Right before a copy is deleted, it checks again that the file it copies is still there and unchanged.
function checkKeeper(access, item) {
  if (item.keep === undefined) return;
  let real;
  let stat;
  try {
    real = access.read(item.keep);
    stat = fs.lstatSync(real, { bigint: true });
  } catch {
    throw new FcError(`Not deleted because the file it copies could not be found: ${item.keep}`);
  }
  if (real !== item.keep || !stat.isFile() || fileStamp(stat) !== item.keepStamp) throw new FcError(`Not deleted because the file it copies changed: ${item.keep}`);
}

// It sends the junk to the Recycle Bin. Without confirm, or with dryRun, it only makes the list and changes nothing.
// If confirm differs from the confirmation value of the current list, it deletes nothing and marks mismatch.
// The removal log is written before deleting; if it cannot be written, nothing is deleted. One failed file does not stop the rest.
function removeJunk(dir, { confirm, dryRun = false, older, now, maxSize = MAX_RECYCLE_SIZE, onProgress } = {}) {
  const plan = planRemoval(dir, { older, now, maxSize });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  if (confirm === undefined || dryRun) return result;
  if (confirm !== code) return { ...result, mismatch: true, mismatchHints: mismatchHints(plan) };
  if (plan.removals.length === 0) return result;
  const total = plan.removals.length;
  const relative = relativeTo(plan.target);
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
    'junk files',
    plan.removals.map((item) => ({ path: item.path, reason: item.reason, ...(item.keep === undefined ? {} : { details: { keep: item.keep } }) })),
    {
      access: ['read', 'delete'],
      onStart: () => report(`Sending to the Recycle Bin: ${total} (in batches of ${FILE_BATCH})`),
      onRemoved: (item, step) => report(`${step} Move to the Recycle Bin: ${relative(item.path)}`),
      onFailed: (item, reason, step) => report(`${step} Failed: ${relative(item.path)} (${reason})`),
      prepare: (access, item) => {
        checkKeeper(access, item);
        return checkOne(access, item);
      },
    },
  );
}

function formatRemoveJunk(result) {
  const relative = relativeTo(result.target);
  const lines = [];
  if (result.confirmed) {
    for (const item of result.removed) lines.push(`Move to the Recycle Bin: ${relative(item.path)} (${item.reason})`);
  } else {
    for (const item of result.removals) lines.push(`To delete: ${relative(item.path)} (${item.reason}; ${formatSize(item.size)})`);
  }
  for (const item of result.kept) lines.push(`Kept: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  if (result.mismatch) {
    lines.push('The list changed after the confirmation value was made, so nothing was deleted.');
    for (const item of result.mismatchHints ?? []) lines.push(`Changed: ${relative(item.path)} (${item.reason})`);
  }
  if (result.logWarning) lines.push(`Warning: ${result.logWarning}`);
  if (result.log) lines.push(`Removal log: ${result.log}`);
  const counts = `kept ${result.kept.length}, skipped ${result.skipped.length}`;
  if (result.confirmed) {
    lines.push(`Recycle Bin ${result.removed.length}, failed ${result.failed.length}, ${counts}`);
  } else {
    lines.push(`To delete ${result.removals.length}, ${counts}`);
    if (result.removals.length > 0) lines.push(`Nothing has been deleted yet. After checking the list, run again ${result.dryRun ? 'without --dry-run and ' : ''}with --yes=${result.code} to send them to the Recycle Bin.`);
  }
  return lines.join('\n');
}

module.exports = { DEFAULT_OLDER, findJunk, formatJunk, planRemoval, removeJunk, formatRemoveJunk, confirmationCode, copyOriginal };
