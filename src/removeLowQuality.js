'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, recycleBinState, permanentDeleteReason, MAX_RECYCLE_PATH } = require('./commands');
const { grant, walk, fileStamp, stampVolumeReason } = require('./target');
const { findLowQuality, describeLowQuality, criteriaText } = require('./lowQuality');
const { rejectRepository } = require('./flatten');
const { writeRemovalLog } = require('./removalLog');
const { holdReason, checkOne, recycleInBatches, MAX_RECYCLE_SIZE } = require('./removeBroken');
const { markerFinder, markerReason } = require('./downloadMarker');

const reasonOf = (err) => (err instanceof FcError ? err.message : `Cannot check the file. (${err.code ?? err.message})`);

// A file that is low quality only by bitrate is not deleted. The bitrate is the file size divided by the length, so if the length is read inflated or
// the file was partly downloaded, even a normal video comes out low. Until the check that cross-checks the length (#179) exists, it only reports them in the list.
const BITRATE_ONLY = 'Kept because it is low quality by bitrate only, so the duration may be a corrupt value. Only files that fail the resolution criterion are deleted.';

// It chooses the files to delete among the low-quality files. It does not touch files (#31).
// - removals: files to delete ({ path, size, width, height, displayWidth, displayHeight, duration, bitrate, reasons, stamp })
// - kept: files that are low quality but kept ({ path, reason, file })
// - interactive: whether the session can send to the Recycle Bin. If there are no files to delete, it is not checked and is null.
// The other values (criteria, unreadable, skipped, checked) are those of findLowQuality.
// Like remove-broken, it keeps a file that changed within 5 minutes, a file that may be downloading, a file that would be deleted permanently by the Recycle Bin setting (#219), a file over the Recycle Bin path limit,
// a file whose other name (a hard link) of the same file is already in the list to delete first, and a file on a volume that is not a fixed disk.
function planRemoval(dir, { minHeight, minBitrate, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['read', 'delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findLowQuality(dir, { minHeight, minBitrate });
  // Reading the metadata can take time, so it measures by the time after the search.
  const checkedAt = now ?? Date.now();
  const plan = { ...found, removals: [], kept: [], interactive: null };
  const markerOf = markerFinder();
  const linked = new Map();
  const linkKept = [];
  for (const file of found.low) {
    const keep = (reason) => plan.kept.push({ path: file.path, reason, file });
    if (!file.byResolution) {
      keep(BITRATE_ONLY);
      continue;
    }
    try {
      const real = access.delete(file.path);
      const stat = fs.lstatSync(real, { bigint: true });
      const hold = holdReason(stat, checkedAt);
      const marker = hold === null ? markerReason(markerOf(real)) : null;
      const sameFile = stat.nlink > 1n ? linked.get(`${stat.dev}:${stat.ino}`) : undefined;
      if (real !== file.path || !stat.isFile()) keep('Kept because the file changed after the search.');
      else if (real.length > MAX_RECYCLE_PATH) keep(`Kept because the path is ${real.length} characters, over the ${MAX_RECYCLE_PATH} that can be sent to the Recycle Bin. Shorten the name or move it to a parent folder and run again.`);
      else if (hold !== null) keep(hold);
      else if (marker !== null) keep(marker);
      else if (sameFile !== undefined) linkKept.push({ file, other: sameFile });
      else {
        if (stat.nlink > 1n) linked.set(`${stat.dev}:${stat.ino}`, real);
        plan.removals.push({ ...file, path: real, size: Number(stat.size), stamp: fileStamp(stat) });
      }
    } catch (err) {
      keep(reasonOf(err));
    }
  }
  if (plan.removals.length === 0 && linkKept.length === 0) return plan;
  const linkReason = (item) =>
    `Kept because another name of the same file (hard link: ${path.relative(access.target, item.other)}) is deleted first in this run, which changes the file's modification time, so it cannot be deleted together. Each time you run again after 5 minutes, one name is deleted.`;
  // On a volume with no Recycle Bin, it may be deleted permanently, so it deletes only when it was confirmed to be a fixed disk.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  // On a volume without a change time (exFAT and so on), the confirmation value and the 5-minute protection cannot stop a swap, so it does not delete (#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? 'Kept because the volume type could not be checked.' : `Kept because the drive is not a fixed disk (${driveType}), so it could be permanently deleted.`);
    plan.kept.push(...plan.removals.map((item) => ({ path: item.path, reason, file: item })), ...linkKept.map(({ file }) => ({ path: file.path, reason, file })));
    plan.removals = [];
    return plan;
  }
  // A file that would be deleted permanently by the Recycle Bin setting (remove immediately, over the maximum size, 1GB or more if the setting cannot be read) is kept (#219, the same judgment as #100).
  // Its other names (hard links) are also kept for the same reason.
  const dropped = new Map();
  plan.removals = plan.removals.filter((item) => {
    const why = permanentDeleteReason(state, item.size, maxSize);
    if (why === null) return true;
    plan.kept.push({ path: item.path, reason: `Kept ${why}.`, file: item });
    dropped.set(item.path, why);
    return false;
  });
  for (const item of linkKept) {
    const reason = dropped.has(item.other) ? `Kept ${dropped.get(item.other)}.` : linkReason(item);
    plan.kept.push({ path: item.file.path, reason, file: item.file });
  }
  return plan;
}

// A value that stands for the list a person saw. It changes if the standards change, the files to delete increase or decrease, or any one changes.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['low-quality videos', plan.target, plan.criteria, items])).digest('hex').slice(0, 12);
}

// It sends low-quality videos under the target to the Recycle Bin. If there is no confirm or it is dryRun, it only makes the list and changes nothing.
// If confirm differs from the confirmation value of the current list, it deletes nothing and marks mismatch.
// It leaves the record file (path, size, resolution, bitrate) before deleting, and if it cannot leave the record, it deletes nothing. Even if one file fails, it continues with the rest.
// The returned value: the value of planRemoval plus { code, dryRun, confirmed, mismatch, removed, failed, log }.
function removeLowQuality(dir, { minHeight, minBitrate, confirm, dryRun = false, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const plan = planRemoval(dir, { minHeight, minBitrate, now, maxSize });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  if (confirm === undefined || dryRun) return result;
  if (confirm !== code) return { ...result, mismatch: true };
  if (plan.removals.length === 0) return result;
  if (plan.interactive !== true) throw new FcError('Cannot send to the Recycle Bin because it was not confirmed that this is an interactive session. Nothing was deleted.');
  result.confirmed = true;
  const log = writeRemovalLog(
    plan.target,
    'low-quality videos',
    plan.removals.map((item) => ({
      path: item.path,
      reason: `Low-quality video (${item.reasons.join(', ')})`,
      details: {
        width: item.width,
        height: item.height,
        displayWidth: item.displayWidth,
        displayHeight: item.displayHeight,
        duration: item.duration,
        bitrate: item.bitrate,
        criteria: plan.criteria,
      },
    })),
  );
  result.log = log.path;
  const access = grant(plan.target, ['delete']);
  // It sends in batches like remove-broken (#216). Starting PowerShell for each file takes 0.5 to 0.6 second per file.
  recycleInBatches(plan.removals, log, (item) => checkOne(access, item), {
    removed: (item) => result.removed.push(item),
    failed: (item, reason) => result.failed.push({ path: item.path, reason }),
  });
  return result;
}

function formatRemoveLowQuality(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [`Criteria: ${criteriaText(result.criteria)}`];
  const line = (item) => `${relative(item.path)} (${describeLowQuality(item)}) [${item.reasons.join(', ')}]`;
  if (result.confirmed) {
    for (const item of result.removed) lines.push(`Move to the Recycle Bin: ${line(item)}`);
  } else {
    for (const item of result.removals) lines.push(`To delete: ${line(item)}`);
  }
  for (const item of result.failed) lines.push(`Failed: ${relative(item.path)} (${item.reason})`);
  for (const item of result.kept) lines.push(`Kept: ${line(item.file)} ${item.reason}`);
  for (const item of result.unreadable) lines.push(`Undetermined, not deleted: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  if (result.log) lines.push(`Removal log: ${result.log}`);
  const counts = `kept ${result.kept.length}, undetermined ${result.unreadable.length}, skipped ${result.skipped.length}`;
  if (result.confirmed) {
    lines.push(`Checked ${result.checked} videos, Recycle Bin ${result.removed.length}, failed ${result.failed.length}, ${counts}`);
  } else {
    lines.push(`Checked ${result.checked} videos, to delete ${result.removals.length}, ${counts}`);
    if (result.removals.length > 0) lines.push(`Nothing has been deleted yet. After checking the list, run again ${result.dryRun ? 'without --dry-run and ' : ''}with the same criteria and --yes=${result.code} to send them to the Recycle Bin.`);
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeLowQuality, formatRemoveLowQuality, confirmationCode };
