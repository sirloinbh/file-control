'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, recycleBinState, recycleTarget, permanentDeleteReason } = require('./commands');
const { grant, walk, fileStamp, readRange, stampVolumeReason } = require('./target');
const { inspect } = require('./broken');
const { findDuplicateNames, aspectKey, aspectsMatch, groupLabel, describeVideo, titlesDiffer, DURATION_TOLERANCE, MIN_DURATION } = require('./duplicates');
const { rejectRepository } = require('./flatten');
const { writeRemovalLog } = require('./removalLog');
const { holdReason, checkOne, recycleInBatches, MAX_RECYCLE_SIZE } = require('./removeBroken');
const { markerFinder, markerReason } = require('./downloadMarker');

const reasonOf = (err) => (err instanceof FcError ? err.message : `Cannot check the file. (${err.code ?? err.message})`);

// Groups with common names such as camera and sequence names (generic of find-duplicates, isGenericGroup) are not deleted, because even with the same name and length they can be different videos (#103, #110).
const GENERIC_REASON = 'Kept because it is a common name such as a camera or sequence name, so videos with the same duration may be different videos.';

// Whether it can be seen as the same video as the file to keep. If the same, null; otherwise it returns the reason for keeping.
// So as not to delete a different video that only has the same name (a trailer with the same number, a WWE-2023 that looks like a product number, #103),
// it is seen as the same video only when the length differs by 1 second or less and the visible aspect ratio is within 3% (aspectsMatch). It is the same criterion as length groups.
// In a number group, if the title differs from the file to keep (titlesDiffer), it is kept even if the length is the same. This is the case with broadcast recordings of a fixed length (WWE-2023 Raw and SmackDown).
// In a group where files with a different title are mixed (differentTitles), it deletes only when both the file to keep and the file to delete have a title and the title words are exactly the same.
// If one side has no title, it cannot be known which video it is a copy of. If a file to keep with no title is a copy of Raw, SmackDown may be the only original.
function sameVideoReason(keeper, file, group) {
  if (keeper.duration === null || aspectKey(keeper) === null) return 'Kept because the duration or resolution of the file to keep is unknown, so it could not be confirmed they are the same video.';
  if (file.duration === null || aspectKey(file) === null) return 'Kept because the duration or resolution is unknown, so it could not be confirmed they are the same video.';
  if (keeper.duration < MIN_DURATION || file.duration < MIN_DURATION) return 'Kept because it is under 60 seconds, so duration cannot confirm they are the same video.';
  if (Math.abs(keeper.duration - file.duration) > DURATION_TOLERANCE) return 'Kept because the duration differs from the file to keep, so it may not be the same video.';
  if (!aspectsMatch(keeper, file)) return 'Kept because the aspect ratio differs from the file to keep, so it may not be the same video.';
  if (titlesDiffer(keeper.title, file.title)) return 'Kept because the number is the same but the title differs from the file to keep, so it may be a different video.';
  if (!group.differentTitles) return null;
  const untitled = (item) => !item.title || item.title.length === 0;
  if (untitled(keeper) || untitled(file)) return 'Kept because the group mixes files with different titles and one has no title, so it could not be confirmed which video it is a copy of.';
  // The judgment that sees a title containing all the words as the same title does not carry on. If the file to keep is WWE, then WWE Raw and WWE SmackDown both become the same title.
  // So in this group it deletes only when the title words are exactly the same.
  const sameWords = keeper.title.length === file.title.length && keeper.title.every((word) => file.title.includes(word));
  if (!sameWords) return 'Kept because the group mixes files with different titles; only files whose title words are identical to the file to keep are deleted, and this file was kept.';
  return null;
}

// Samples to find a stretch filled only with zeros. A download that stopped with the whole size reserved (a torrent and so on) leaves the places not yet downloaded as 0 even when the head structure is normal.
// In compressed video data there is almost no stretch where 4KB is all zeros. A small file is enough with the head structure alone, so it is not looked at.
const ZERO_CHECK_FROM = 1024 * 1024;
const ZERO_SAMPLES = 16;
const ZERO_BLOCK = 4096;

function hasZeroBlock(target, real, size) {
  if (size < ZERO_CHECK_FROM) return false;
  const span = size - ZERO_CHECK_FROM - ZERO_BLOCK;
  for (let index = 0; index < ZERO_SAMPLES; index += 1) {
    const offset = ZERO_CHECK_FROM + Math.floor((span * index) / (ZERO_SAMPLES - 1));
    const block = readRange(target, real, { offset, length: ZERO_BLOCK });
    if (block.length === ZERO_BLOCK && block.every((byte) => byte === 0)) return true;
  }
  return false;
}

// It checks that the file to keep is as it is now and looks intact, and returns its time stamp. If there is a problem, it raises an FcError.
// If the file to keep is partly downloaded or broken, deleting the copies would lose the only intact video, so it looks at the same judgment as find-broken and the zero-stretch samples (#109).
// If a download tool's marker file is beside it, it may be downloading, so it is kept (#115). A file that reserves the size in advance, like aria2, already has
// the head structure downloaded, and if the zero-stretch samples happen to land only on the downloaded places, it looks intact by the judgment above.
function keeperStamp(access, keeper, now, markerOf) {
  const real = access.read(keeper.path);
  if (real !== keeper.path) throw new FcError('Kept because the path of the file to keep changed after the search.');
  const stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isFile()) throw new FcError('Kept because the file to keep is not a regular file.');
  if (holdReason(stat, now) !== null) throw new FcError('Kept because the file to keep changed just now or its time is in the future, so it may still be downloading.');
  const marker = markerReason(markerOf(real), { keeper: true });
  if (marker !== null) throw new FcError(marker);
  const size = Number(stat.size);
  const found = inspect(access.target, real, size);
  if (found !== null) throw new FcError(`Kept because the file to keep may be ${found.status === 'broken' ? 'broken' : 'not intact'}. (${found.reason})`);
  if (hasZeroBlock(access.target, real, size)) throw new FcError('Kept because the file to keep has a section filled only with zeros, so it may be partly downloaded.');
  return fileStamp(stat);
}

// It chooses the files to delete among the duplicate videos. It does not touch files.
// It deletes only from name groups (groups of find-duplicates). Each group has a file to keep (#34), and only files whose length and aspect ratio are the same as that file are deleted.
// Groups that match only by length (metadataGroups) can be different videos because the names differ, so they are not deleted. Files do not overlap between name groups, so
// a file kept in one group is never deleted in another.
// - sets: for each group { label, keep: { path, size, duration, width, height, reason, stamp }, doubt }. doubt is the notice from chooseKeeper.
//   A group with a common name such as a camera or sequence name (isGenericGroup) deletes nothing.
// - removals: files to delete ({ path, size, duration, width, height, stamp, set, keep, keepStamp, reason }). set is the number in sets.
// - kept: files that are in a group but kept ({ path, set, reason, file })
// - lengthOnly: the number of groups matching only by length that were not deleted
// - interactive: whether the session can send to the Recycle Bin. If there are no files to delete, it is not checked and is null.
// The other values (conflicts, unreadable, skipped, and so on) are those of findDuplicateNames.
// Copies that are certain to fail when sent to the Recycle Bin, or that are useless to delete, are kept in advance (#127).
// - A path that cannot be sent to the Recycle Bin (over 259 characters, a name ending in a dot or space). It is the same check as rm (recycleTarget).
// - Another name of the same file (a hard link) as the file to keep. Deleting it does not reduce space, and deleting it changes the change time of the file to keep, so
//   the next copy of the same group fails with "the file to keep changed".
// - A copy that is the same file as another copy to be deleted this time. If one name is deleted, this name's change time changes and it looks different from the judged file (the same as remove-broken).
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['read', 'delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findDuplicateNames(dir);
  // Reading the length can take time, so it measures by the time after the search.
  const checkedAt = now ?? Date.now();
  const plan = { ...found, sets: [], removals: [], kept: [], lengthOnly: found.metadataGroups.filter((group) => !group.alsoNamed).length, interactive: null };
  const markerOf = markerFinder();
  // If the file ID is 0, it cannot be known whether it is the same file, so it is not compared (the same as flatten and commands, first review).
  const fileId = (stat) => (stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`);
  // The file to keep of every group { file ID -> path }. If a copy that is the same file as another group's file to keep is deleted, that file to keep's
  // change time changes and that group's copies fail with "the file to keep changed", and no space is freed (first review).
  const keeperIds = new Map();
  for (const group of found.groups) {
    if (group.generic) continue;
    try {
      const id = fileId(fs.lstatSync(group.keep.path, { bigint: true }));
      if (id !== null) keeperIds.set(id, group.keep.path);
    } catch {
      // If the file to keep cannot be read, keeperStamp keeps that group.
    }
  }
  // Among the copies to delete this time, files whose link count is 2 or more { file ID -> path }
  const linked = new Map();
  // Copies kept this time because another copy is deleted first. The reason is decided after checking the volume (the same as remove-broken, first review).
  const linkKept = [];
  // If the path cannot be sent to the Recycle Bin, it returns that reason, otherwise null (the same check as rm, #129).
  const pathProblem = (p) => {
    try {
      recycleTarget(p);
      return null;
    } catch (err) {
      if (err instanceof FcError) return err.message;
      throw err;
    }
  };
  found.groups.forEach((group, set) => {
    const keeper = group.files.find((file) => file.path === group.keep.path);
    const keep = (file, reason) => plan.kept.push({ path: file.path, set, reason, file });
    let stamp = null;
    let keeperProblem = group.generic ? GENERIC_REASON : null;
    if (keeperProblem === null) {
      try {
        stamp = keeperStamp(access, keeper, checkedAt, markerOf);
      } catch (err) {
        keeperProblem = reasonOf(err);
      }
    }
    plan.sets.push({ label: groupLabel(group), keep: { ...keeper, reason: group.keep.reason, stamp }, doubt: group.keep.doubt });
    for (const file of group.files) {
      if (file === keeper) continue;
      const reason = keeperProblem ?? sameVideoReason(keeper, file, group);
      if (reason !== null) {
        keep(file, reason);
        continue;
      }
      try {
        const real = access.delete(file.path);
        const stat = fs.lstatSync(real, { bigint: true });
        const hold = holdReason(stat, checkedAt);
        // If a copy may also be downloading, it is not deleted. It looks in the same order as remove-broken.
        const marker = hold === null ? markerReason(markerOf(real)) : null;
        const id = fileId(stat);
        const twin = id === null ? undefined : keeperIds.get(id);
        // The path check comes before the hard-link judgment. That way it never says "deleted next run" and then keeps it by path the next time (first review).
        const badPath = pathProblem(real);
        if (real !== file.path || !stat.isFile()) keep(file, 'Kept because the file changed after the search.');
        else if (hold !== null) keep(file, hold);
        else if (marker !== null) keep(file, marker);
        else if (badPath !== null) keep(file, badPath);
        else if (twin === keeper.path) keep(file, 'Kept because it is another name of the same file (hard link) as the file to keep, so deleting it would not free space. Deleting it would change the modification time of the file to keep.');
        else if (twin !== undefined) keep(file, `Kept because it is another name of the same file (hard link) as the file to keep of another group (${path.relative(access.target, twin)}), so deleting it would not free space. Deleting it would change the modification time of that file.`);
        else if (stat.nlink > 1n && id !== null && linked.has(id)) linkKept.push({ path: file.path, set, file, other: linked.get(id) });
        else {
          if (stat.nlink > 1n && id !== null) linked.set(id, real);
          plan.removals.push({
            path: real,
            size: Number(stat.size),
            duration: file.duration,
            width: file.width,
            height: file.height,
            displayWidth: file.displayWidth,
            displayHeight: file.displayHeight,
            stamp: fileStamp(stat),
            set,
            keep: keeper.path,
            keepStamp: stamp,
            reason: `Duplicate video (${groupLabel(group)}), file to keep: ${keeper.path}`,
          });
        }
      } catch (err) {
        keep(file, reasonOf(err));
      }
    }
  });
  // linkKept arises only when another name of the same file is in removals, so if removals is empty, linkKept is also empty.
  if (plan.removals.length === 0) return plan;
  // On a volume with no Recycle Bin, it may be deleted permanently, so it deletes only when it was confirmed to be a fixed disk.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  // On a volume without a change time (exFAT and so on), the confirmation value and the 5-minute protection cannot stop a swap, so it does not delete (#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? 'Kept because the volume type could not be checked.' : `Kept because the drive is not a fixed disk (${driveType}), so it could be permanently deleted.`);
    plan.kept.push(...[...plan.removals, ...linkKept].map((item) => ({ path: item.path, set: item.set, reason, file: item.file ?? item })));
    plan.removals = [];
    return plan;
  }
  // A copy that would be deleted permanently by the Recycle Bin setting (remove immediately, over the maximum size) is kept (#100). Its other names (hard links) are also kept for the same reason.
  const dropped = new Map();
  plan.removals = plan.removals.filter((item) => {
    const why = permanentDeleteReason(state, item.size, maxSize);
    if (why === null) return true;
    plan.kept.push({ path: item.path, set: item.set, reason: `Kept ${why}.`, file: item.file ?? item });
    dropped.set(item.path, why);
    return false;
  });
  // It deletes only one name of the same file per run, so if there are three or more names, one is reduced each time it runs.
  for (const item of linkKept) {
    if (dropped.has(item.other)) {
      plan.kept.push({ path: item.path, set: item.set, reason: `Kept ${dropped.get(item.other)}.`, file: item.file });
      continue;
    }
    const reason = `Kept because another name of the same file (hard link: ${path.relative(access.target, item.other)}) is deleted first in this run, which changes the file's modification time, so it cannot be deleted together. Each time you run again after 5 minutes, one name is deleted.`;
    plan.kept.push({ path: item.path, set: item.set, reason, file: item.file });
  }
  return plan;
}

// A value that stands for the list a person saw. It changes if any one of the files to delete or to keep changes.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp, item.keep, item.keepStamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['duplicate videos', plan.target, items])).digest('hex').slice(0, 12);
}

// Right before deleting, it checks again that the file to keep is still there. If the file to keep is gone, it does not delete the copies.
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

// It sends duplicate videos under the target to the Recycle Bin. If there is no confirm or it is dryRun, it only makes the list and changes nothing.
// If confirm differs from the confirmation value of the current list, it deletes nothing and marks mismatch.
// It leaves the record file before deleting, and if it cannot leave the record, it deletes nothing. Even if one file fails, it continues with the rest.
// The returned value: the value of planRemoval plus { code, dryRun, confirmed, mismatch, removed, failed, log }.
function removeDuplicates(dir, { confirm, dryRun = false, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const plan = planRemoval(dir, { now, maxSize });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  if (confirm === undefined || dryRun) return result;
  if (confirm !== code) return { ...result, mismatch: true };
  if (plan.removals.length === 0) return result;
  if (plan.interactive !== true) throw new FcError('Cannot send to the Recycle Bin because it was not confirmed that this is an interactive session. Nothing was deleted.');
  result.confirmed = true;
  const log = writeRemovalLog(
    plan.target,
    'duplicate videos',
    plan.removals.map((item) => ({ path: item.path, reason: item.reason, details: { keep: item.keep, group: plan.sets[item.set].label } })),
  );
  result.log = log.path;
  const access = grant(plan.target, ['read', 'delete']);
  // It sends in batches like remove-broken (#216). Right before sending a batch, Node looks at the file to keep (checkKeeper), and for each copy PowerShell
  // also checks again right before deleting the real path, the file-ness, and the fileStamp (keep). If the file to keep changes in the middle of a batch, the remaining copies are not deleted.
  recycleInBatches(
    plan.removals,
    log,
    (item) => {
      checkKeeper(access, item);
      // The file to keep is not deleted, so it does not run the Recycle Bin path check (recycleTarget). A copy of a file to keep with a long path is also deleted (first review).
      // checkKeeper already looked at whether it equals the real path, and PowerShell opens a long path with the \\?\ prefix.
      return { ...checkOne(access, item), keep: { path: item.keep, stamp: item.keepStamp } };
    },
    {
      removed: (item) => result.removed.push(item),
      failed: (item, reason) => result.failed.push({ path: item.path, set: item.set, reason }),
    },
  );
  return result;
}

function formatRemoveDuplicates(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  const removedPaths = new Set(result.removed.map((item) => item.path));
  result.sets.forEach((set, index) => {
    lines.push(`Group (${set.label}):`);
    lines.push(`  File to keep: ${relative(set.keep.path)} (${describeVideo(set.keep)}) [${set.keep.reason}]`);
    // Files of a different length are kept for each copy, but it also reports that different videos may be mixed in the group.
    if (set.doubt !== null) lines.push(`  Caution: ${set.doubt}`);
    for (const item of result.removals.filter((entry) => entry.set === index)) {
      if (!result.confirmed) lines.push(`  To delete: ${relative(item.path)} (${describeVideo(item)})`);
      else if (removedPaths.has(item.path)) lines.push(`  Move to the Recycle Bin: ${relative(item.path)} (${describeVideo(item)})`);
    }
    for (const item of result.failed.filter((entry) => entry.set === index)) lines.push(`  Failed: ${relative(item.path)} (${item.reason})`);
    for (const item of result.kept.filter((entry) => entry.set === index)) lines.push(`  Kept: ${relative(item.path)} (${describeVideo(item.file)}) ${item.reason}`);
  });
  if (result.lengthOnly > 0) lines.push(`${result.lengthOnly} same-duration groups are not deleted because their names differ and they may be different videos. Check them with find-duplicates.`);
  for (const item of result.conflicts) lines.push(`Several numbers, not deleted: ${relative(item.path)} (${item.numbers.join(', ')})`);
  for (const item of result.unreadable) lines.push(`Undetermined, not deleted: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  if (result.log) lines.push(`Removal log: ${result.log}`);
  const counts = `kept ${result.kept.length}, same-duration-only groups ${result.lengthOnly}, several numbers ${result.conflicts.length}, undetermined ${result.unreadable.length}, skipped ${result.skipped.length}`;
  if (result.confirmed) {
    lines.push(`Groups ${result.sets.length}, Recycle Bin ${result.removed.length}, failed ${result.failed.length}, ${counts}`);
  } else {
    lines.push(`Groups ${result.sets.length}, to delete ${result.removals.length}, ${counts}`);
    if (result.removals.length > 0) lines.push(`Nothing has been deleted yet. After checking the list, run again ${result.dryRun ? 'without --dry-run and ' : ''}with --yes=${result.code} to send them to the Recycle Bin.`);
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeDuplicates, formatRemoveDuplicates, confirmationCode };
