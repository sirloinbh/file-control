'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { grant, walk, fileStamp } = require('./target');
const { findLowQuality, describeLowQuality, criteriaText } = require('./lowQuality');
const { rejectRepository } = require('./flatten');
const { planSafeRemovals, runConfirmedRemoval, mismatchHints, MAX_RECYCLE_SIZE } = require('./removal');

// A file that is low quality only by bitrate is not deleted. The bitrate is the file size divided by the length, so if the length is read inflated or
// the file was partly downloaded, even a normal video comes out low. Until the check that cross-checks the length (#179) exists, it only reports them in the list.
const BITRATE_ONLY = 'Kept because it is low quality by bitrate only, so the duration may be a corrupt value. Only files that fail the resolution criterion are deleted.';

// It chooses the files to delete among the low-quality files. It does not touch files (#31).
// - removals: files to delete ({ path, size, width, height, displayWidth, displayHeight, duration, bitrate, reasons, stamp })
// - kept: files that are low quality but kept ({ path, reason, file })
// - interactive: whether the session can send to the Recycle Bin. If there are no files to delete, it is not checked and is null.
// The other values (criteria, unreadable, skipped, checked) are those of findLowQuality.
// The keep rules are the same as remove-broken (removal.js).
function planRemoval(dir, { minHeight, minBitrate, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['read', 'delete']);
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  const found = findLowQuality(dir, { minHeight, minBitrate, entries });
  // Reading the metadata can take time, so it measures by the time after the search.
  const safe = planSafeRemovals(found.low, access, {
    now,
    maxSize,
    precheck: (file) => (file.byResolution ? null : BITRATE_ONLY),
    isChanged: () => false,
    changedReason: 'Kept because the file changed after the search.',
    toRemoval: (file, real, stat) => ({ ...file, path: real, size: Number(stat.size), stamp: fileStamp(stat) }),
    entry: ({ candidate, removal }, reason) => ({ path: (removal ?? candidate).path, reason, file: removal ?? candidate }),
  });
  return { ...found, ...safe };
}

// A value that stands for the list a person saw. It changes if the standards change, the files to delete increase or decrease, or any one changes.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['remove-low-quality', plan.target, plan.criteria, items])).digest('hex').slice(0, 12);
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
  // With nothing to delete, a confirmation value is not a mismatch, so it is reported as an empty plan (#309).
  if (plan.removals.length === 0) return result;
  if (confirm !== code) return { ...result, mismatch: true, mismatchHints: mismatchHints(plan) };
  // It sends in batches like remove-broken (#216). Starting PowerShell for each file takes 0.5 to 0.6 second per file.
  return runConfirmedRemoval(
    plan,
    result,
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
  if (result.mismatch) {
    lines.push('The list changed after the confirmation value was made, so nothing was deleted.');
    for (const item of result.mismatchHints ?? []) lines.push(`Changed: ${relative(item.path)} (${item.reason})`);
  }
  if (result.logWarning) lines.push(`Warning: ${result.logWarning}`);
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
