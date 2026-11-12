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

// 카메라·순번처럼 흔한 이름의 묶음(find-duplicates의 generic, isGenericGroup)은 이름과 길이가 같아도 다른 영상일 수 있어 지우지 않는다(#103, #110).
const GENERIC_REASON = 'Kept because it is a common name such as a camera or sequence name, so videos with the same duration may be different videos.';

// 남길 파일과 같은 영상으로 볼 수 있는지. 같으면 null, 아니면 남기는 사유를 돌려준다.
// 이름만 같은 다른 영상(같은 번호의 예고편, 제품번호처럼 보이는 WWE-2023 등, #103)을 지우지 않도록
// 길이 차이가 1초 이내이고 보이는 화면 비율이 3% 이내(aspectsMatch)일 때만 같은 영상으로 본다. 길이 묶음과 같은 기준이다.
// 번호 묶음에서 남길 파일과 제목이 다르면(titlesDiffer) 길이가 같아도 남긴다. 길이가 정해진 방송 녹화(WWE-2023 Raw와 SmackDown)가 그렇다.
// 제목이 다른 파일이 섞인 묶음(differentTitles)에서는 남길 파일과 지울 파일 모두 제목이 있고 제목 낱말이 똑같을 때만 지운다.
// 한쪽에 제목이 없으면 어느 영상의 사본인지 알 수 없다. 제목 없는 남길 파일이 Raw의 사본이면 SmackDown이 하나뿐인 원본일 수 있다.
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
  // 낱말을 모두 담은 제목을 같은 제목으로 보는 판정은 이어지지 않는다. 남길 파일이 WWE이면 WWE Raw와 WWE SmackDown이 모두 같은 제목이 된다.
  // 그래서 이 묶음에서는 제목 낱말이 똑같을 때만 지운다.
  const sameWords = keeper.title.length === file.title.length && keeper.title.every((word) => file.title.includes(word));
  if (!sameWords) return 'Kept because the group mixes files with different titles; only files whose title words are identical to the file to keep are deleted, and this file was kept.';
  return null;
}

// 0으로만 채워진 구간을 찾는 표본. 전체 크기를 미리 잡아 둔 채 멈춘 내려받기(토렌트 등)는 머리 구조가 정상이어도 받지 못한 자리가 0으로 남는다.
// 압축된 영상 데이터에는 4KB가 모두 0인 구간이 거의 없다. 작은 파일은 머리 구조만으로 충분해 보지 않는다.
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

// 남길 파일이 지금 그대로이고 온전해 보이는지 확인하고 그 시각 표시를 돌려준다. 문제가 있으면 FcError를 낸다.
// 남길 파일이 덜 받았거나 깨졌으면 사본을 지울 때 온전한 영상을 잃으므로, find-broken과 같은 판별과 0 구간 표본을 본다(#109).
// 받기 도구의 표시 파일이 옆에 있으면 받는 중일 수 있어 남긴다(#115). aria2처럼 크기를 미리 잡고 받는 파일은
// 머리 구조가 이미 받아졌고 0 구간 표본이 마침 받은 자리에만 걸리면 위 판별로는 온전해 보인다.
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

// 중복 영상 중 지울 파일을 고른다. 파일은 건드리지 않는다.
// 이름 묶음(find-duplicates의 groups)에서만 지운다. 묶음마다 남길 파일(#34)을 두고, 그 파일과 길이·화면 비율이 같은 파일만 지운다.
// 길이만 같은 묶음(metadataGroups)은 이름이 달라 다른 영상일 수 있으므로 지우지 않는다. 이름 묶음끼리는 파일이 겹치지 않으므로,
// 한 묶음에서 남긴 파일이 다른 묶음에서 지워지는 일은 없다.
// - sets: 묶음마다 { label, keep: { path, size, duration, width, height, reason, stamp }, doubt }. doubt는 chooseKeeper의 알림이다.
//   카메라·순번처럼 흔한 이름의 묶음(isGenericGroup)은 아무것도 지우지 않는다.
// - removals: 지울 파일 ({ path, size, duration, width, height, stamp, set, keep, keepStamp, reason }). set은 sets의 번호다.
// - kept: 묶음에 들었지만 남기는 파일 ({ path, set, reason, file })
// - lengthOnly: 지우지 않은 길이만 같은 묶음 수
// - interactive: 휴지통으로 보낼 수 있는 세션인지. 지울 파일이 없으면 확인하지 않아 null이다.
// 그 밖의 값(conflicts, unreadable, skipped 등)은 findDuplicateNames의 것이다.
// 휴지통으로 보내다 실패할 것이 확실하거나 지워도 소용없는 사본은 미리 남긴다(#127).
// - 휴지통으로 보낼 수 없는 경로(259자 초과, 끝이 점·공백인 이름). rm과 같은 검사(recycleTarget)다.
// - 남길 파일과 같은 파일(하드링크)의 다른 이름. 지워도 공간이 줄지 않고, 지우면 남길 파일의 변경 시각이 바뀌어
//   같은 묶음의 다음 사본이 "남길 파일이 바뀌었다"로 실패한다.
// - 이번에 지울 다른 사본과 같은 파일인 사본. 한 이름을 지우면 이 이름의 변경 시각이 바뀌어 판별한 파일과 달라 보인다(remove-broken과 같다).
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['read', 'delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findDuplicateNames(dir);
  // 길이를 읽는 데 시간이 걸릴 수 있어 찾은 뒤의 시각으로 잰다.
  const checkedAt = now ?? Date.now();
  const plan = { ...found, sets: [], removals: [], kept: [], lengthOnly: found.metadataGroups.filter((group) => !group.alsoNamed).length, interactive: null };
  const markerOf = markerFinder();
  // 파일 번호가 0이면 같은 파일인지 알 수 없어 비교하지 않는다(flatten·commands와 같다, 1차 리뷰).
  const fileId = (stat) => (stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`);
  // 모든 묶음의 남길 파일 { 파일 ID -> 경로 }. 다른 묶음의 남길 파일과 같은 파일인 사본을 지우면 그 남길 파일의
  // 변경 시각이 바뀌어 그 묶음의 사본이 "남길 파일이 바뀌었다"로 실패하고, 공간도 줄지 않는다(1차 리뷰).
  const keeperIds = new Map();
  for (const group of found.groups) {
    if (group.generic) continue;
    try {
      const id = fileId(fs.lstatSync(group.keep.path, { bigint: true }));
      if (id !== null) keeperIds.set(id, group.keep.path);
    } catch {
      // 남길 파일을 읽지 못하면 keeperStamp가 그 묶음을 남긴다.
    }
  }
  // 이번에 지울 사본 중 링크 수가 2 이상인 파일 { 파일 ID -> 경로 }
  const linked = new Map();
  // 다른 사본을 먼저 지우므로 이번에는 남기는 사본. 사유는 볼륨을 확인한 뒤 정한다(remove-broken과 같다, 1차 리뷰).
  const linkKept = [];
  // 휴지통으로 보낼 수 없는 경로면 그 사유를, 아니면 null을 돌려준다(rm과 같은 검사, #129).
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
        // 사본도 받는 중일 수 있으면 지우지 않는다. remove-broken과 같은 순서로 본다.
        const marker = hold === null ? markerReason(markerOf(real)) : null;
        const id = fileId(stat);
        const twin = id === null ? undefined : keeperIds.get(id);
        // 경로 검사는 하드링크 판정보다 먼저 한다. 그래야 "다음 실행에 지운다"고 했다가 다음에 경로로 남기는 일이 없다(1차 리뷰).
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
  // linkKept는 같은 파일의 다른 이름이 removals에 있을 때만 생기므로, removals가 비면 linkKept도 비어 있다.
  if (plan.removals.length === 0) return plan;
  // 휴지통이 없는 볼륨에서는 영구 삭제될 수 있어 고정 디스크로 확인된 경우에만 지운다.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  // 변경 시각이 없는 볼륨(exFAT 등)에서는 확인값과 5분 보호가 바꿔치기를 막지 못해 지우지 않는다(#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? 'Kept because the volume type could not be checked.' : `Kept because the drive is not a fixed disk (${driveType}), so it could be permanently deleted.`);
    plan.kept.push(...[...plan.removals, ...linkKept].map((item) => ({ path: item.path, set: item.set, reason, file: item.file ?? item })));
    plan.removals = [];
    return plan;
  }
  // 휴지통 설정상 영구 삭제될 사본(바로 제거, 최대 크기 초과)은 남긴다(#100). 그 다른 이름(하드링크)도 같은 사유로 남는다.
  const dropped = new Map();
  plan.removals = plan.removals.filter((item) => {
    const why = permanentDeleteReason(state, item.size, maxSize);
    if (why === null) return true;
    plan.kept.push({ path: item.path, set: item.set, reason: `Kept ${why}.`, file: item.file ?? item });
    dropped.set(item.path, why);
    return false;
  });
  // 한 실행에서 같은 파일의 이름을 하나씩만 지우므로, 이름이 셋 이상이면 실행할 때마다 하나씩 줄어든다.
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

// 사람이 본 목록을 나타내는 값. 지울 파일이나 남길 파일이 하나라도 바뀌면 달라진다.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp, item.keep, item.keepStamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['duplicate videos', plan.target, items])).digest('hex').slice(0, 12);
}

// 지우기 직전에 남길 파일이 그대로 있는지 다시 본다. 남길 파일이 없어졌으면 사본을 지우지 않는다.
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

// 타겟 아래 중복 영상을 휴지통으로 보낸다. confirm이 없거나 dryRun이면 목록만 만들고 아무것도 바꾸지 않는다.
// confirm이 지금 목록의 확인값과 다르면 아무것도 지우지 않고 mismatch를 표시한다.
// 지우기 전에 기록 파일을 남기고, 기록을 남기지 못하면 아무것도 지우지 않는다. 한 파일이 실패해도 나머지는 계속한다.
// 돌려주는 값: planRemoval의 값에 { code, dryRun, confirmed, mismatch, removed, failed, log }를 더한 것.
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
  // remove-broken처럼 묶어 보낸다(#216). 남길 파일은 묶음을 보내기 직전에 Node가 보고(checkKeeper), PowerShell도 사본마다
  // 지우기 직전에 실제 경로·파일 여부·fileStamp를 다시 본다(keep). 묶음 도중 남길 파일이 바뀌면 남은 사본을 지우지 않는다.
  recycleInBatches(
    plan.removals,
    log,
    (item) => {
      checkKeeper(access, item);
      // 남길 파일은 지우지 않으므로 휴지통 경로 검사(recycleTarget)를 하지 않는다. 경로가 긴 남길 파일의 사본도 지운다(1차 리뷰).
      // checkKeeper가 실제 경로와 같은지 이미 봤고, PowerShell은 \\?\ 접두어로 긴 경로를 연다.
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
    // 길이가 다른 파일은 사본마다 남기지만, 묶음에 다른 영상이 섞였을 수 있음을 함께 알린다.
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
