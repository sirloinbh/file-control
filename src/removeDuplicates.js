'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, recycleBinState } = require('./commands');
const { grant, walk, fileStamp, readRange } = require('./target');
const { inspect } = require('./broken');
const { findDuplicateNames, aspectKey, groupLabel, describeVideo, titlesDiffer, DURATION_TOLERANCE, MIN_DURATION } = require('./duplicates');
const { rejectRepository } = require('./flatten');
const { writeRemovalLog } = require('./removalLog');
const { holdReason, recycleFailure, removeOne, MAX_RECYCLE_SIZE } = require('./removeBroken');

const reasonOf = (err) => (err instanceof FcError ? err.message : `파일을 확인할 수 없습니다. (${err.code ?? err.message})`);

// 카메라·순번처럼 흔한 이름의 묶음(find-duplicates의 generic, isGenericGroup)은 이름과 길이가 같아도 다른 영상일 수 있어 지우지 않는다(#103, #110).
const GENERIC_REASON = '카메라·순번처럼 흔한 이름이라 길이가 같아도 다른 영상일 수 있어 남겼습니다.';

// 남길 파일과 같은 영상으로 볼 수 있는지. 같으면 null, 아니면 남기는 사유를 돌려준다.
// 이름만 같은 다른 영상(같은 번호의 예고편, 제품번호처럼 보이는 WWE-2023 등, #103)을 지우지 않도록
// 길이 차이가 1초 이내이고 화면 비율이 같을 때만 같은 영상으로 본다. 길이 묶음과 같은 기준이다.
// 번호 묶음에서 남길 파일과 제목 낱말이 하나도 겹치지 않으면 길이가 같아도 남긴다. 길이가 정해진 방송 녹화(WWE-2023 Raw와 SmackDown)가 그렇다.
function sameVideoReason(keeper, file) {
  if (keeper.duration === null || aspectKey(keeper) === null) return '남길 파일의 길이나 해상도를 몰라 같은 영상인지 확인하지 못해 남겼습니다.';
  if (file.duration === null || aspectKey(file) === null) return '길이나 해상도를 몰라 같은 영상인지 확인하지 못해 남겼습니다.';
  if (keeper.duration < MIN_DURATION || file.duration < MIN_DURATION) return '60초 미만이라 길이로 같은 영상인지 확인할 수 없어 남겼습니다.';
  if (Math.abs(keeper.duration - file.duration) > DURATION_TOLERANCE) return '남길 파일과 길이가 달라 같은 영상이 아닐 수 있어 남겼습니다.';
  if (aspectKey(keeper) !== aspectKey(file)) return '남길 파일과 화면 비율이 달라 같은 영상이 아닐 수 있어 남겼습니다.';
  if (titlesDiffer(keeper.title, file.title)) return '번호는 같지만 남길 파일과 제목이 달라 다른 영상일 수 있어 남겼습니다.';
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
function keeperStamp(access, keeper, now) {
  const real = access.read(keeper.path);
  if (real !== keeper.path) throw new FcError('찾은 뒤 남길 파일의 경로가 바뀌어 남겼습니다.');
  const stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isFile()) throw new FcError('남길 파일이 일반 파일이 아니라 남겼습니다.');
  if (holdReason(stat, now) !== null) throw new FcError('남길 파일이 방금 바뀌었거나 시각이 미래라 받는 중일 수 있어 남겼습니다.');
  const size = Number(stat.size);
  const found = inspect(access.target, real, size);
  if (found !== null) throw new FcError(`남길 파일이 ${found.status === 'broken' ? '깨졌을' : '온전하지 않을'} 수 있어 남겼습니다. (${found.reason})`);
  if (hasZeroBlock(access.target, real, size)) throw new FcError('남길 파일에 0으로만 채워진 구간이 있어 덜 받은 파일일 수 있어 남겼습니다.');
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
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['read', 'delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findDuplicateNames(dir);
  // 길이를 읽는 데 시간이 걸릴 수 있어 찾은 뒤의 시각으로 잰다.
  const checkedAt = now ?? Date.now();
  const plan = { ...found, sets: [], removals: [], kept: [], lengthOnly: found.metadataGroups.filter((group) => !group.alsoNamed).length, interactive: null };
  found.groups.forEach((group, set) => {
    const keeper = group.files.find((file) => file.path === group.keep.path);
    const keep = (file, reason) => plan.kept.push({ path: file.path, set, reason, file });
    let stamp = null;
    let keeperProblem = group.generic ? GENERIC_REASON : null;
    if (keeperProblem === null) {
      try {
        stamp = keeperStamp(access, keeper, checkedAt);
      } catch (err) {
        keeperProblem = reasonOf(err);
      }
    }
    plan.sets.push({ label: groupLabel(group), keep: { ...keeper, reason: group.keep.reason, stamp }, doubt: group.keep.doubt });
    for (const file of group.files) {
      if (file === keeper) continue;
      const reason = keeperProblem ?? sameVideoReason(keeper, file);
      if (reason !== null) {
        keep(file, reason);
        continue;
      }
      try {
        const real = access.delete(file.path);
        const stat = fs.lstatSync(real, { bigint: true });
        const hold = holdReason(stat, checkedAt);
        if (real !== file.path || !stat.isFile()) keep(file, '찾은 뒤 파일이 바뀌어 남겼습니다.');
        else if (hold !== null) keep(file, hold);
        else if (Number(stat.size) >= maxSize) keep(file, '1GB 이상이라 휴지통을 거치지 않고 영구 삭제될 수 있어 남겼습니다.');
        else {
          plan.removals.push({
            path: real,
            size: Number(stat.size),
            duration: file.duration,
            width: file.width,
            height: file.height,
            stamp: fileStamp(stat),
            set,
            keep: keeper.path,
            keepStamp: stamp,
            reason: `중복 영상 (${groupLabel(group)}), 남길 파일: ${keeper.path}`,
          });
        }
      } catch (err) {
        keep(file, reasonOf(err));
      }
    }
  });
  if (plan.removals.length === 0) return plan;
  // 휴지통이 없는 볼륨에서는 영구 삭제될 수 있어 고정 디스크로 확인된 경우에만 지운다.
  const { interactive, driveType } = recycleBinState(access.target);
  plan.interactive = interactive;
  if (driveType !== 'Fixed') {
    const reason = driveType === null ? '볼륨 종류를 확인하지 못해 남겼습니다.' : `고정 디스크가 아니라(${driveType}) 영구 삭제될 수 있어 남겼습니다.`;
    plan.kept.push(...plan.removals.map((item) => ({ path: item.path, set: item.set, reason, file: item })));
    plan.removals = [];
  }
  return plan;
}

// 사람이 본 목록을 나타내는 값. 지울 파일이나 남길 파일이 하나라도 바뀌면 달라진다.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp, item.keep, item.keepStamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['중복 영상', plan.target, items])).digest('hex').slice(0, 12);
}

// 지우기 직전에 남길 파일이 그대로 있는지 다시 본다. 남길 파일이 없어졌으면 사본을 지우지 않는다.
function checkKeeper(access, item) {
  let real;
  let stat;
  try {
    real = access.read(item.keep);
    stat = fs.lstatSync(real, { bigint: true });
  } catch {
    throw new FcError(`남길 파일을 찾을 수 없어 지우지 않았습니다: ${item.keep}`);
  }
  if (real !== item.keep || !stat.isFile() || fileStamp(stat) !== item.keepStamp) throw new FcError(`남길 파일이 바뀌어 지우지 않았습니다: ${item.keep}`);
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
  if (plan.interactive !== true) throw new FcError('대화형 세션인지 확인되지 않아 휴지통으로 보낼 수 없습니다. 아무것도 지우지 않았습니다.');
  result.confirmed = true;
  const log = writeRemovalLog(
    plan.target,
    '중복 영상',
    plan.removals.map((item) => ({ path: item.path, reason: item.reason, details: { keep: item.keep, group: plan.sets[item.set].label } })),
  );
  result.log = log.path;
  const access = grant(plan.target, ['read', 'delete']);
  plan.removals.forEach((item, index) => {
    try {
      const logged = log.items[index].path;
      if (logged !== item.path) throw new FcError(`찾은 뒤 경로가 바뀌어 지우지 않았습니다: ${item.path} -> ${logged}`);
      checkKeeper(access, item);
      removeOne(access, item);
      result.removed.push(item);
    } catch (err) {
      result.failed.push({ path: item.path, set: item.set, reason: recycleFailure(err) });
    }
  });
  return result;
}

function formatRemoveDuplicates(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  const removedPaths = new Set(result.removed.map((item) => item.path));
  result.sets.forEach((set, index) => {
    lines.push(`묶음 (${set.label}):`);
    lines.push(`  남길 파일: ${relative(set.keep.path)} (${describeVideo(set.keep)}) [${set.keep.reason}]`);
    // 길이가 다른 파일은 사본마다 남기지만, 묶음에 다른 영상이 섞였을 수 있음을 함께 알린다.
    if (set.doubt !== null) lines.push(`  주의: ${set.doubt}`);
    for (const item of result.removals.filter((entry) => entry.set === index)) {
      if (!result.confirmed) lines.push(`  지울 파일: ${relative(item.path)} (${describeVideo(item)})`);
      else if (removedPaths.has(item.path)) lines.push(`  휴지통으로 이동: ${relative(item.path)} (${describeVideo(item)})`);
    }
    for (const item of result.failed.filter((entry) => entry.set === index)) lines.push(`  실패: ${relative(item.path)} (${item.reason})`);
    for (const item of result.kept.filter((entry) => entry.set === index)) lines.push(`  남김: ${relative(item.path)} (${describeVideo(item.file)}) ${item.reason}`);
  });
  if (result.lengthOnly > 0) lines.push(`길이만 같은 묶음 ${result.lengthOnly}개는 이름이 달라 다른 영상일 수 있어 지우지 않습니다. find-duplicates로 확인하세요.`);
  for (const item of result.conflicts) lines.push(`번호가 여럿, 지우지 않음: ${relative(item.path)} (${item.numbers.join(', ')})`);
  for (const item of result.unreadable) lines.push(`판단 못함, 지우지 않음: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`건너뜀: ${relative(item.path)} (${item.reason})`);
  if (result.log) lines.push(`제거 기록: ${result.log}`);
  const counts = `남김 ${result.kept.length}개, 길이만 같은 묶음 ${result.lengthOnly}개, 번호가 여럿 ${result.conflicts.length}개, 판단 못함 ${result.unreadable.length}개, 건너뜀 ${result.skipped.length}개`;
  if (result.confirmed) {
    lines.push(`묶음 ${result.sets.length}개, 휴지통 ${result.removed.length}개, 실패 ${result.failed.length}개, ${counts}`);
  } else {
    lines.push(`묶음 ${result.sets.length}개, 지울 파일 ${result.removals.length}개, ${counts}`);
    if (result.removals.length > 0) lines.push(`아직 지우지 않았습니다. 목록을 확인한 뒤 ${result.dryRun ? '--dry-run 없이 ' : ''}--yes=${result.code}를 붙여 다시 실행하면 휴지통으로 보냅니다.`);
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeDuplicates, formatRemoveDuplicates, confirmationCode };
