'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { grant, walk, fileStamp } = require('./target');
const { findBroken } = require('./broken');
const { rejectRepository } = require('./guards');
const { planSafeRemovals, runConfirmedRemoval, sidecarDigest, sidecarLines, sidecarCount, mismatchHints, FILE_BATCH, MAX_RECYCLE_SIZE } = require('./removal');

// It chooses the files to delete among those judged broken. It does not touch files.
// - removals: files to delete ({ path, size, reason, stamp })
// - kept: files that are broken but kept ({ path, reason })
// - interactive: whether the session can send to the Recycle Bin. If there are no files to delete, it is not checked and is null.
// Suspicious and could-not-judge files are not deleted. The keep rules (changed file, path length, 5-minute hold, download marker, hard links, volume) are in removal.js.
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['delete']);
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  const found = findBroken(dir, { entries });
  // The judgment can take a long time, so it measures by the time after the judgment so that a file changed in the meantime is not wrongly seen as a file with a future time.
  const safe = planSafeRemovals(found.broken, access, {
    sidecars: true,
    now,
    maxSize,
    isChanged: (item, real, stat) => fileStamp(stat) !== item.stamp,
    changedReason: 'Kept because the file changed after it was judged.',
    toRemoval: (item, real) => ({ path: real, size: item.size, reason: item.reason, stamp: item.stamp }),
    entry: ({ candidate, removal }, reason) => ({ path: (removal ?? candidate).path, reason }),
  });
  return { ...found, ...safe };
}

// A value that stands for the list a person saw. It changes if the files to delete increase or decrease or if any one changes.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.reason, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['remove-broken', plan.target, items, ...sidecarDigest(plan)])).digest('hex').slice(0, 12);
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
  if (confirm !== code) return { ...result, mismatch: true, mismatchHints: mismatchHints(plan) };
  if (plan.removals.length === 0) return result;
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
  return runConfirmedRemoval(plan, result, 'broken files', plan.removals.map(({ path: file, reason }) => ({ path: file, reason })), {
    onStart: () => report(`Sending to the Recycle Bin: ${total} (in batches of ${FILE_BATCH})`),
    onRemoved: (item, step) => report(`${step} Move to the Recycle Bin: ${relative(item.path)}`),
    onFailed: (item, reason, step) => report(`${step} Failed: ${relative(item.path)} (${reason})`),
  });
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
  for (const item of result.undetermined) lines.push(`Undetermined, not deleted: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  lines.push(...sidecarLines(result, relative));
  if (result.mismatch) {
    lines.push('The list changed after the confirmation value was made, so nothing was deleted.');
    for (const item of result.mismatchHints ?? []) lines.push(`Changed: ${relative(item.path)} (${item.reason})`);
  }
  if (result.logWarning) lines.push(`Warning: ${result.logWarning}`);
  if (result.log) lines.push(`Removal log: ${result.log}`);
  const counts = `kept ${result.kept.length}, suspect ${result.suspect.length}, undetermined ${result.undetermined.length}, skipped ${result.skipped.length}`;
  if (result.confirmed) {
    lines.push(`Recycle Bin ${result.removed.length}${sidecarCount(result)}, failed ${result.failed.length}, ${counts}`);
  } else {
    lines.push(`To delete ${result.removals.length}${sidecarCount(result)}, ${counts}`);
    if (result.removals.length > 0) lines.push(`Nothing has been deleted yet. After checking the list, run again ${result.dryRun ? 'without --dry-run and ' : ''}with --yes=${result.code} to send them to the Recycle Bin.`);
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeBroken, formatRemoveBroken, confirmationCode, MAX_RECYCLE_SIZE };
