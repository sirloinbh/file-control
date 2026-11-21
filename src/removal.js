'use strict';

// The rules shared by remove-broken, remove-duplicates, and remove-low-quality (#308).
// Each command keeps only "find the candidates" and "format the report". The rules that keep a file from being lost live here, once:
// - planSafeRemovals: the keep ladder and the volume checks (it does not touch files)
// - runConfirmedRemoval: the confirm -> log -> send driver
// - holdReason, checkOne, recycleInBatches, MAX_RECYCLE_SIZE: the pieces the commands share
const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove, recycleBinState, recycleTarget, recycleFiles, recycleFailureMessage, permanentRefusal, permanentDeleteReason, UNKNOWN_RECYCLE_LIMIT, MAX_RECYCLE_PATH } = require('./commands');
const { grant, fileStamp, stampVolumeReason } = require('./target');
const { writeRemovalLog } = require('./removalLog');
const { markerFinder, markerReason } = require('./downloadMarker');

// A file changed more recently than this may be downloading, so it is kept.
const RECENT_MS = 5 * 60 * 1000;
// The size to keep when the Recycle Bin capacity could not be confirmed. The remove commands
// judge by the volume's Recycle Bin setting (maximum size, remove immediately) (#100, #219), and keep from this size only when the setting could not be read.
const MAX_RECYCLE_SIZE = UNKNOWN_RECYCLE_LIMIT;

const reasonOf = (err) => (err instanceof FcError ? err.message : `Cannot check the file. (${err.code ?? err.message})`);

// A copied file keeps its modification time, so the creation and change times are also looked at together.
function holdReason(stat, now) {
  const latest = Math.max(...[stat.mtimeMs, stat.birthtimeMs, stat.ctimeMs].map(Number));
  if (latest > now) return 'Kept because its time is in the future, so it is unknown when it changed.';
  return now - latest < RECENT_MS ? 'Kept because it changed just now and may still be downloading.' : null;
}

function longPathReason(real) {
  return real.length > MAX_RECYCLE_PATH
    ? `Kept because the path is ${real.length} characters, over the ${MAX_RECYCLE_PATH} that can be sent to the Recycle Bin. Shorten the name or move it to a parent folder and run again.`
    : null;
}

// If the file ID is 0, it cannot be known whether it is the same file, so it is not compared.
const fileIdOf = (stat) => (stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`);

const linkReason = (target, other) =>
  `Kept because another name of the same file (hard link: ${path.relative(target, other)}) is deleted first in this run, which changes the file's modification time, so it cannot be deleted together. Each time you run again after 5 minutes, one name is deleted.`;

// It chooses the files to delete among the candidates. It does not touch files.
// candidates: the files a command judged deletable. Each one is passed to the callbacks as it is.
// access: grant(target, [..., 'delete'])
// options:
// - now: the time to measure the hold by (default Date.now() after the search)
// - maxSize: the size to keep when the Recycle Bin setting cannot be read
// - sameFileId(stat): the ID that tells two names of one file apart, or null to not compare (default: device and inode; remove-duplicates passes fileIdOf)
// - precheck(candidate): a reason to keep the candidate before any file check, or null
// - isChanged(candidate, real, stat): whether the file differs from the one that was judged
// - changedReason: the text kept for a changed file
// - pathProblem(real): the reason the path cannot be sent to the Recycle Bin, or null (default: longer than MAX_RECYCLE_PATH)
// - extraKeep(candidate, real, stat): another command-specific reason to keep, or null (checked after the path, before hard links)
// - toRemoval(candidate, real, stat): the item to put into removals
// - entry({ candidate, removal }, reason): the item to put into kept. removal is set once the candidate was already in removals.
// The ladder, in order: changed file, hold (5 minutes, future time), download marker, path, extraKeep, another name of a file that is already to be deleted.
// Then, only if something is left: a volume that is not a fixed disk or has no change time, and the Recycle Bin setting (would be deleted permanently).
// It returns { removals, kept, interactive }. interactive is null when there is nothing to delete.
function planSafeRemovals(candidates, access, options = {}) {
  const { now, maxSize = MAX_RECYCLE_SIZE, sameFileId = (stat) => `${stat.dev}:${stat.ino}`, precheck, isChanged, changedReason, pathProblem = longPathReason, extraKeep, toRemoval, entry } = options;
  const checkedAt = now ?? Date.now();
  const plan = { removals: [], kept: [], interactive: null };
  const markerOf = markerFinder();
  const origin = new Map();
  // Hard-link files put into the delete list: file ID => path. Its other names get their reason decided after the volume check.
  const linked = new Map();
  const linkKept = [];
  for (const candidate of candidates) {
    const keep = (reason) => plan.kept.push(entry({ candidate }, reason));
    const early = precheck?.(candidate) ?? null;
    if (early !== null) {
      keep(early);
      continue;
    }
    try {
      const real = access.delete(candidate.path);
      const stat = fs.lstatSync(real, { bigint: true });
      const hold = holdReason(stat, checkedAt);
      // If a file may also be downloading, it is not deleted.
      const marker = hold === null ? markerReason(markerOf(real)) : null;
      const id = stat.nlink > 1n ? sameFileId(stat) : null;
      const sameFile = id === null ? undefined : linked.get(id);
      const pathReason = pathProblem(real);
      const extra = extraKeep?.(candidate, real, stat) ?? null;
      if (real !== candidate.path || !stat.isFile() || isChanged(candidate, real, stat)) keep(changedReason);
      else if (hold !== null) keep(hold);
      else if (marker !== null) keep(marker);
      else if (pathReason !== null) keep(pathReason);
      else if (extra !== null) keep(extra);
      else if (sameFile !== undefined) linkKept.push({ candidate, other: sameFile });
      else {
        if (id !== null) linked.set(id, real);
        const removal = toRemoval(candidate, real, stat);
        origin.set(removal, candidate);
        plan.removals.push(removal);
      }
    } catch (err) {
      keep(reasonOf(err));
    }
  }
  // Another name of a file arises only when the first name is in removals, so if removals is empty, linkKept is also empty.
  if (plan.removals.length === 0) return plan;
  // On a volume with no Recycle Bin, it may be deleted permanently, so it deletes only when it was confirmed to be a fixed disk.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  const keepRemoval = (removal, reason) => plan.kept.push(entry({ candidate: origin.get(removal), removal }, reason));
  // On a volume without a change time (exFAT and so on), the confirmation value and the 5-minute protection cannot stop a swap, so it does not delete (#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? 'Kept because the volume type could not be checked.' : `Kept because the drive is not a fixed disk (${driveType}), so it could be permanently deleted.`);
    for (const removal of plan.removals) keepRemoval(removal, reason);
    for (const { candidate } of linkKept) plan.kept.push(entry({ candidate }, reason));
    plan.removals = [];
    return plan;
  }
  // A file that would be deleted permanently by the Recycle Bin setting (remove immediately, over the maximum size) is kept (#100, #219). Its other names (hard links) also have no name to delete this time.
  const dropped = new Map();
  plan.removals = plan.removals.filter((removal) => {
    const why = permanentDeleteReason(state, Number(removal.size), maxSize);
    if (why === null) return true;
    keepRemoval(removal, `Kept ${why}.`);
    dropped.set(removal.path, why);
    return false;
  });
  // It deletes only one name of the same file per run, so if there are three or more names, one is reduced each time it runs.
  for (const { candidate, other } of linkKept) {
    plan.kept.push(entry({ candidate }, dropped.has(other) ? `Kept ${dropped.get(other)}.` : linkReason(access.target, other)));
  }
  return plan;
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

// It sends the list to delete (removals) to the Recycle Bin in batches of FILE_BATCH (#194, #216).
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

// The confirm -> log -> send driver. It fills result.confirmed, result.log, result.removed, and result.failed, and returns result.
// - plan: { target, removals, interactive }
// - label: what the record is about ("broken files" and so on)
// - logItems: the items to record, in the order of plan.removals ({ path, reason, details? })
// - hooks.prepare(access, item): the check that runs right before each item is sent. It returns what to pass to recycleFiles (default: checkOne).
// - hooks.access: the permissions to grant (default ['delete'])
// - hooks.onStart(): called once the record is written, before the first item is sent
// - hooks.onRemoved(item, step) and hooks.onFailed(item, reason, step): called for each result
// - hooks.failedEntry(item, reason): the item to put into result.failed (default { path, reason })
// It leaves the record file before deleting, and if it cannot leave the record, it deletes nothing. Even if one file fails, it continues with the rest.
// In a non-interactive session it cannot send to the Recycle Bin, so it stops before the record is written, so that only records do not pile up.
function runConfirmedRemoval(plan, result, label, logItems, hooks = {}) {
  if (plan.interactive !== true) throw new FcError('Cannot send to the Recycle Bin because it was not confirmed that this is an interactive session. Nothing was deleted.');
  result.confirmed = true;
  const log = writeRemovalLog(plan.target, label, logItems);
  result.log = log.path;
  const access = grant(plan.target, hooks.access ?? ['delete']);
  hooks.onStart?.();
  const prepare = hooks.prepare ?? checkOne;
  const failedEntry = hooks.failedEntry ?? ((item, reason) => ({ path: item.path, reason }));
  recycleInBatches(plan.removals, log, (item) => prepare(access, item), {
    removed: (item, step) => {
      result.removed.push(item);
      hooks.onRemoved?.(item, step);
    },
    failed: (item, reason, step) => {
      result.failed.push(failedEntry(item, reason));
      hooks.onFailed?.(item, reason, step);
    },
  });
  return result;
}

module.exports = { planSafeRemovals, runConfirmedRemoval, holdReason, checkOne, recycleInBatches, recycleFailure, reasonOf, longPathReason, fileIdOf, RECENT_MS, MAX_RECYCLE_SIZE, FILE_BATCH };
