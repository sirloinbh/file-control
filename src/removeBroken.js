'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove, recycleBinState, recycleTarget, recycleFiles, recycleFailureMessage, permanentRefusal, permanentDeleteReason, UNKNOWN_RECYCLE_LIMIT, MAX_RECYCLE_PATH } = require('./commands');
const { grant, walk, fileStamp, stampVolumeReason } = require('./target');
const { findBroken } = require('./broken');
const { rejectRepository } = require('./flatten');
const { writeRemovalLog } = require('./removalLog');
const { markerFinder, markerReason } = require('./downloadMarker');

// A file changed more recently than this may be downloading, so it is kept.
const RECENT_MS = 5 * 60 * 1000;
// The size to keep when the Recycle Bin capacity could not be confirmed. remove-broken, remove-duplicates, and remove-low-quality
// judge by the volume's Recycle Bin setting (maximum size, remove immediately) (#100, #219), and keep from this size only when the setting could not be read.
const MAX_RECYCLE_SIZE = UNKNOWN_RECYCLE_LIMIT;

const reasonOf = (err) => (err instanceof FcError ? err.message : `Cannot check the file. (${err.code ?? err.message})`);

// A copied file keeps its modification time, so the creation and change times are also looked at together.
function holdReason(stat, now) {
  const latest = Math.max(...[stat.mtimeMs, stat.birthtimeMs, stat.ctimeMs].map(Number));
  if (latest > now) return 'Kept because its time is in the future, so it is unknown when it changed.';
  return now - latest < RECENT_MS ? 'Kept because it changed just now and may still be downloading.' : null;
}

// It chooses the files to delete among those judged broken. It does not touch files.
// - removals: files to delete ({ path, size, reason, stamp })
// - kept: files that are broken but kept ({ path, reason })
// - interactive: whether the session can send to the Recycle Bin. If there are no files to delete, it is not checked and is null.
// Suspicious and could-not-judge files are not deleted. Files that are certain to fail when sent to the Recycle Bin are kept in advance (#101).
// - A file whose path exceeds MAX_RECYCLE_PATH
// - A file whose other name of the same file (a hard link) is already in the list to delete first. If that name is sent to the Recycle Bin, the file's change time changes and
//   this name looks different from the judged file. A file in the Recycle Bin is also a name of the same file, so the link count stays the same.
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findBroken(dir);
  // The judgment can take a long time, so it measures by the time after the judgment so that a file changed in the meantime is not wrongly seen as a file with a future time.
  const checkedAt = now ?? Date.now();
  const plan = { ...found, removals: [], kept: [], interactive: null };
  const markerOf = markerFinder();
  // Hard-link files put into the delete list: file ID => path. Its other names get their reason decided after the volume check.
  const linked = new Map();
  const linkKept = [];
  for (const item of found.broken) {
    const keep = (reason) => plan.kept.push({ path: item.path, reason });
    try {
      const real = access.delete(item.path);
      const stat = fs.lstatSync(real, { bigint: true });
      const hold = holdReason(stat, checkedAt);
      const marker = hold === null ? markerReason(markerOf(real)) : null;
      const sameFile = stat.nlink > 1n ? linked.get(`${stat.dev}:${stat.ino}`) : undefined;
      if (real !== item.path || !stat.isFile() || fileStamp(stat) !== item.stamp) keep('Kept because the file changed after it was judged.');
      else if (real.length > MAX_RECYCLE_PATH) keep(`Kept because the path is ${real.length} characters, over the ${MAX_RECYCLE_PATH} that can be sent to the Recycle Bin. Shorten the name or move it to a parent folder and run again.`);
      else if (hold !== null) keep(hold);
      else if (marker !== null) keep(marker);
      else if (sameFile !== undefined) linkKept.push({ path: item.path, other: sameFile });
      else {
        if (stat.nlink > 1n) linked.set(`${stat.dev}:${stat.ino}`, real);
        plan.removals.push({ path: real, size: item.size, reason: item.reason, stamp: item.stamp });
      }
    } catch (err) {
      keep(reasonOf(err));
    }
  }
  if (plan.removals.length === 0) return plan;
  // On a volume with no Recycle Bin, it may be deleted permanently, so it deletes only when it was confirmed to be a fixed disk.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  // On a volume without a change time (exFAT and so on), the confirmation value and the 5-minute protection cannot stop a swap, so it does not delete (#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? 'Kept because the volume type could not be checked.' : `Kept because the drive is not a fixed disk (${driveType}), so it could be permanently deleted.`);
    plan.kept.push(...[...plan.removals, ...linkKept].map((item) => ({ path: item.path, reason })));
    plan.removals = [];
    return plan;
  }
  // A file that would be deleted permanently by the Recycle Bin setting (remove immediately, over the maximum size) is kept (#100). Its other names (hard links) also have no name to delete this time.
  const dropped = new Map();
  plan.removals = plan.removals.filter((item) => {
    const why = permanentDeleteReason(state, Number(item.size), maxSize);
    if (why === null) return true;
    plan.kept.push({ path: item.path, reason: `Kept ${why}.` });
    dropped.set(item.path, why);
    return false;
  });
  // It deletes only one name of the same file per run, so if there are three or more names, one is reduced each time it runs.
  for (const item of linkKept) {
    if (dropped.has(item.other)) {
      plan.kept.push({ path: item.path, reason: `Kept ${dropped.get(item.other)}.` });
      continue;
    }
    const reason = `Kept because another name of the same file (hard link: ${path.relative(access.target, item.other)}) is deleted first in this run, which changes the file's modification time, so it cannot be deleted together. Each time you run again after 5 minutes, one name is deleted.`;
    plan.kept.push({ path: item.path, reason });
  }
  return plan;
}

// A value that stands for the list a person saw. It changes if the files to delete increase or decrease or if any one changes.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.reason, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify([plan.target, items])).digest('hex').slice(0, 12);
}

// If a file changed after the record was written, it does not delete. What is deleted must be the very file that was judged.
// It looks in Node right before sending a batch, and the Recycle Bin move accepts only paths that went through the same check as rm (the preview of remove).
// Even inside a batch, PowerShell checks again, for each file right before deleting, the real path and the fileStamp (recycleFiles, #194).
function checkOne(access, item) {
  const real = access.delete(item.path);
  if (real !== item.path) throw new FcError(`Not deleted because the path changed after it was judged: ${item.path} -> ${real}`);
  const stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isFile() || fileStamp(stat) !== item.stamp) throw new FcError(`Not deleted because the file changed after it was judged: ${real}`);
  // The volume's Recycle Bin setting was looked at at the planning stage (#100). It is not looked at again here, and the batch script (recycleFiles) looks again right before deleting (#236).
  remove([real], { dryRun: true, checkVolume: false });
  return { path: recycleTarget(real), stamp: item.stamp };
}


// It turns the result of recycleFiles into failure reasons. If ok, it is undefined.
function batchFailure(file, { status, reason }, keep) {
  switch (status) {
    case 'ok':
      return undefined;
    case 'keepchanged':
      return `Not deleted because the file to keep changed or disappeared: ${keep}`;
    case 'moved':
      return `Not deleted because the path changed after it was judged: ${file}`;
    case 'notfile':
    case 'changed':
      return `Not deleted because the file changed after it was judged: ${file}`;
    case 'gone':
      return `Not deleted because the file disappeared after it was judged: ${file}`;
    case 'permanent':
      return permanentRefusal(file, reason);
    case 'error':
      return recycleFailureMessage(file, reason);
    default:
      return `It is unknown whether it was sent to the Recycle Bin: ${file} (${reason}). Check the Recycle Bin and the original location.`;
  }
}

// The number of files sent to PowerShell at once. Each batch gives results and progress lines, so if too large, the progress display looks stalled.
// With 100, it takes about 3 seconds (measured 1.6 seconds for 50).
const FILE_BATCH = 100;

// The PowerShell error message holds the whole script and garbled letters, so it is not used.
function recycleFailure(err) {
  if (err instanceof FcError) return err.message;
  const cause = err.code ?? (err.status == null ? 'unknown error' : `exit code ${err.status}`);
  return `Could not send to the Recycle Bin. (${cause})`;
}

// It sends broken files under the target to the Recycle Bin. If there is no confirm or it is dryRun, it only makes the list and changes nothing.
// If confirm differs from the confirmation value of the current list, it deletes nothing and marks mismatch.
// It leaves the record file before deleting, and if it cannot leave the record, it deletes nothing. Even if one file fails, it continues with the rest.
// The returned value: the value of planRemoval plus { code, dryRun, confirmed, mismatch, removed, failed, log }. failed is a list of { path, reason } and log is the record file path.
// If onProgress(line) is given, when really deleting, it passes on one line per file with how far along it is and the result (#99). Each time a batch (FILE_BATCH files) ends, that batch's lines come out.
// Starting PowerShell for each file takes 0.5 to 0.6 second per file (12.2 seconds for 20, 26.6 seconds for 50), so it sends in batches (#194, 1.6 seconds for 50).
function removeBroken(dir, { confirm, dryRun = false, now, maxSize = MAX_RECYCLE_SIZE, onProgress } = {}) {
  const plan = planRemoval(dir, { now, maxSize });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  if (confirm === undefined || dryRun) return result;
  // Even if all files of the list that was seen become kept and there is nothing to delete, it does not silently end as a success.
  if (confirm !== code) return { ...result, mismatch: true };
  if (plan.removals.length === 0) return result;
  // In a non-interactive session it cannot send to the Recycle Bin, so it stops before the record is written, so that only records do not pile up.
  if (plan.interactive !== true) throw new FcError('Cannot send to the Recycle Bin because it was not confirmed that this is an interactive session. Nothing was deleted.');
  result.confirmed = true;
  const log = writeRemovalLog(plan.target, 'broken files', plan.removals.map(({ path: file, reason }) => ({ path: file, reason })));
  result.log = log.path;
  const access = grant(plan.target, ['delete']);
  const total = plan.removals.length;
  const relative = (p) => path.relative(plan.target, p) || '.';
  // Even if the progress display throws, the tally and the handling of the next file carry on (first review). It does not count a file already in the Recycle Bin as a failure.
  const report = (line) => {
    try {
      onProgress?.(line);
    } catch {
      // The progress display does not affect the result.
    }
  };
  report(`Sending to the Recycle Bin: ${total} (in batches of ${FILE_BATCH})`);
  recycleInBatches(plan.removals, log, (item) => checkOne(access, item), {
    removed: (item, step) => {
      result.removed.push(item);
      report(`${step} Move to the Recycle Bin: ${relative(item.path)}`);
    },
    failed: (item, reason, step) => {
      result.failed.push({ path: item.path, reason });
      report(`${step} Failed: ${relative(item.path)} (${reason})`);
    },
  });
  return result;
}

// It sends the list to delete (removals) to the Recycle Bin in batches of FILE_BATCH (#194, #216). remove-broken, remove-duplicates, and remove-low-quality use it.
// Right before sending a batch, for each file it matches the record path and does the Node check with prepare(item). prepare returns the
// { path, stamp, keep? } to pass to recycleFiles, and throws if there is a problem. PowerShell also checks again for each file right before deleting (recycleFiles).
// It reports the result for each file with on.removed(item, step) or on.failed(item, reason, step). step is in the form "3/120".
function recycleInBatches(removals, log, prepare, on) {
  const total = removals.length;
  for (let start = 0; start < total; start += FILE_BATCH) {
    const batch = [];
    removals.slice(start, start + FILE_BATCH).forEach((item, offset) => {
      const index = start + offset;
      const step = `${index + 1}/${total}`;
      try {
        const logged = log.items[index].path;
        if (logged !== item.path) throw new FcError(`Not deleted because the path changed after it was judged: ${item.path} -> ${logged}`);
        batch.push({ item, step, send: prepare(item) });
      } catch (err) {
        on.failed(item, recycleFailure(err), step);
      }
    });
    let outcomes;
    try {
      outcomes = recycleFiles(batch.map((entry) => entry.send));
    } catch (err) {
      // If it could not start the batch (non-interactive and so on), nothing of this batch's files was deleted.
      for (const entry of batch) on.failed(entry.item, recycleFailure(err), entry.step);
      continue;
    }
    batch.forEach((entry, i) => {
      const reason = batchFailure(entry.item.path, outcomes[i], entry.send.keep?.path);
      if (reason !== undefined) on.failed(entry.item, reason, entry.step);
      else on.removed(entry.item, entry.step);
    });
  }
}

function formatRemoveBroken(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  if (result.confirmed) {
    for (const item of result.removed) lines.push(`Move to the Recycle Bin: ${relative(item.path)} (${item.reason})`);
  } else {
    for (const item of result.removals) lines.push(`To delete: ${relative(item.path)} (${item.reason})`);
  }
  for (const item of result.kept) lines.push(`Kept: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.path)} (${item.reason})`);
  for (const item of result.suspect) lines.push(`Suspect, not deleted: ${relative(item.path)} (${item.reason})`);
  for (const item of result.unreadable) lines.push(`Undetermined, not deleted: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  if (result.log) lines.push(`Removal log: ${result.log}`);
  const counts = `kept ${result.kept.length}, suspect ${result.suspect.length}, undetermined ${result.unreadable.length}, skipped ${result.skipped.length}`;
  if (result.confirmed) {
    lines.push(`Recycle Bin ${result.removed.length}, failed ${result.failed.length}, ${counts}`);
  } else {
    lines.push(`To delete ${result.removals.length}, ${counts}`);
    if (result.removals.length > 0) lines.push(`Nothing has been deleted yet. After checking the list, run again ${result.dryRun ? 'without --dry-run and ' : ''}with --yes=${result.code} to send them to the Recycle Bin.`);
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeBroken, formatRemoveBroken, confirmationCode, holdReason, recycleFailure, checkOne, recycleInBatches, MAX_RECYCLE_SIZE };
