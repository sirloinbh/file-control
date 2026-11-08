'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, recycleBinState, permanentDeleteReason, MAX_RECYCLE_PATH } = require('./commands');
const { grant, walk, fileStamp, stampVolumeReason } = require('./target');
const { findLowQuality, describeLowQuality, criteriaText } = require('./lowQuality');
const { rejectRepository } = require('./flatten');
const { writeRemovalLog } = require('./removalLog');
const { holdReason, recycleFailure, removeOne, MAX_RECYCLE_SIZE } = require('./removeBroken');
const { markerFinder, markerReason } = require('./downloadMarker');

const reasonOf = (err) => (err instanceof FcError ? err.message : `파일을 확인할 수 없습니다. (${err.code ?? err.message})`);

// 비트레이트로만 저화질이 된 파일은 지우지 않는다. 비트레이트는 파일 크기를 길이로 나눈 값이라, 길이가 부풀어 읽히거나
// 덜 받은 파일이면 정상 영상도 낮게 나온다. 길이를 맞춰 보는 검사(#179)가 생기기 전에는 목록으로만 알린다.
const BITRATE_ONLY = '비트레이트로만 저화질이라 길이가 깨진 값일 수 있어 남겼습니다. 해상도 기준에 걸린 파일만 지웁니다.';

// 저화질 파일 중 지울 파일을 고른다. 파일은 건드리지 않는다(#31).
// - removals: 지울 파일 ({ path, size, width, height, displayWidth, displayHeight, duration, bitrate, reasons, stamp })
// - kept: 저화질이지만 남기는 파일 ({ path, reason, file })
// - interactive: 휴지통으로 보낼 수 있는 세션인지. 지울 파일이 없으면 확인하지 않아 null이다.
// 그 밖의 값(criteria, unreadable, skipped, checked)은 findLowQuality의 것이다.
// remove-broken과 같게 5분 안에 바뀐 파일, 받는 중일 수 있는 파일, 휴지통 설정상 영구 삭제될 파일(#219), 휴지통 경로 한도를 넘는 파일,
// 같은 파일의 다른 이름(하드링크)이 먼저 지울 목록에 있는 파일, 고정 디스크가 아닌 볼륨의 파일은 남긴다.
function planRemoval(dir, { minHeight, minBitrate, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['read', 'delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findLowQuality(dir, { minHeight, minBitrate });
  // 메타데이터를 읽는 데 시간이 걸릴 수 있어 찾은 뒤의 시각으로 잰다.
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
      if (real !== file.path || !stat.isFile()) keep('찾은 뒤 파일이 바뀌어 남겼습니다.');
      else if (real.length > MAX_RECYCLE_PATH) keep(`경로가 ${real.length}자라 휴지통으로 보낼 수 있는 ${MAX_RECYCLE_PATH}자를 넘어 남겼습니다. 이름을 줄이거나 위 폴더로 옮긴 뒤 다시 실행하세요.`);
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
    `같은 파일의 다른 이름(하드링크: ${path.relative(access.target, item.other)})을 이번에 먼저 지우므로 파일의 변경 시각이 바뀌어 함께 지울 수 없어 남겼습니다. 5분 뒤 다시 실행할 때마다 이름을 하나씩 지웁니다.`;
  // 휴지통이 없는 볼륨에서는 영구 삭제될 수 있어 고정 디스크로 확인된 경우에만 지운다.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  // 변경 시각이 없는 볼륨(exFAT 등)에서는 확인값과 5분 보호가 바꿔치기를 막지 못해 지우지 않는다(#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? '볼륨 종류를 확인하지 못해 남겼습니다.' : `고정 디스크가 아니라(${driveType}) 영구 삭제될 수 있어 남겼습니다.`);
    plan.kept.push(...plan.removals.map((item) => ({ path: item.path, reason, file: item })), ...linkKept.map(({ file }) => ({ path: file.path, reason, file })));
    plan.removals = [];
    return plan;
  }
  // 휴지통 설정상 영구 삭제될 파일(바로 제거, 최대 크기 초과, 설정을 읽지 못하면 1GB 이상)은 남긴다(#219, #100과 같은 판정).
  // 그 다른 이름(하드링크)도 같은 사유로 남긴다.
  const dropped = new Map();
  plan.removals = plan.removals.filter((item) => {
    const why = permanentDeleteReason(state, item.size, maxSize);
    if (why === null) return true;
    plan.kept.push({ path: item.path, reason: `${why} 남겼습니다.`, file: item });
    dropped.set(item.path, why);
    return false;
  });
  for (const item of linkKept) {
    const reason = dropped.has(item.other) ? `${dropped.get(item.other)} 남겼습니다.` : linkReason(item);
    plan.kept.push({ path: item.file.path, reason, file: item.file });
  }
  return plan;
}

// 사람이 본 목록을 나타내는 값. 기준이 바뀌거나 지울 파일이 늘고 줄거나 하나라도 바뀌면 달라진다.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['저화질 영상', plan.target, plan.criteria, items])).digest('hex').slice(0, 12);
}

// 타겟 아래 저화질 영상을 휴지통으로 보낸다. confirm이 없거나 dryRun이면 목록만 만들고 아무것도 바꾸지 않는다.
// confirm이 지금 목록의 확인값과 다르면 아무것도 지우지 않고 mismatch를 표시한다.
// 지우기 전에 기록 파일(경로·크기·해상도·비트레이트)을 남기고, 기록을 남기지 못하면 아무것도 지우지 않는다. 한 파일이 실패해도 나머지는 계속한다.
// 돌려주는 값: planRemoval의 값에 { code, dryRun, confirmed, mismatch, removed, failed, log }를 더한 것.
function removeLowQuality(dir, { minHeight, minBitrate, confirm, dryRun = false, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const plan = planRemoval(dir, { minHeight, minBitrate, now, maxSize });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  if (confirm === undefined || dryRun) return result;
  if (confirm !== code) return { ...result, mismatch: true };
  if (plan.removals.length === 0) return result;
  if (plan.interactive !== true) throw new FcError('대화형 세션인지 확인되지 않아 휴지통으로 보낼 수 없습니다. 아무것도 지우지 않았습니다.');
  result.confirmed = true;
  const log = writeRemovalLog(
    plan.target,
    '저화질 영상',
    plan.removals.map((item) => ({
      path: item.path,
      reason: `저화질 영상 (${item.reasons.join(', ')})`,
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
  plan.removals.forEach((item, index) => {
    try {
      const logged = log.items[index].path;
      if (logged !== item.path) throw new FcError(`찾은 뒤 경로가 바뀌어 지우지 않았습니다: ${item.path} -> ${logged}`);
      removeOne(access, item);
      result.removed.push(item);
    } catch (err) {
      result.failed.push({ path: item.path, reason: recycleFailure(err) });
    }
  });
  return result;
}

function formatRemoveLowQuality(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [`기준: ${criteriaText(result.criteria)}`];
  const line = (item) => `${relative(item.path)} (${describeLowQuality(item)}) [${item.reasons.join(', ')}]`;
  if (result.confirmed) {
    for (const item of result.removed) lines.push(`휴지통으로 이동: ${line(item)}`);
  } else {
    for (const item of result.removals) lines.push(`지울 파일: ${line(item)}`);
  }
  for (const item of result.failed) lines.push(`실패: ${relative(item.path)} (${item.reason})`);
  for (const item of result.kept) lines.push(`남김: ${line(item.file)} ${item.reason}`);
  for (const item of result.unreadable) lines.push(`판단 못함, 지우지 않음: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`건너뜀: ${relative(item.path)} (${item.reason})`);
  if (result.log) lines.push(`제거 기록: ${result.log}`);
  const counts = `남김 ${result.kept.length}개, 판단 못함 ${result.unreadable.length}개, 건너뜀 ${result.skipped.length}개`;
  if (result.confirmed) {
    lines.push(`영상 ${result.checked}개 확인, 휴지통 ${result.removed.length}개, 실패 ${result.failed.length}개, ${counts}`);
  } else {
    lines.push(`영상 ${result.checked}개 확인, 지울 파일 ${result.removals.length}개, ${counts}`);
    if (result.removals.length > 0) lines.push(`아직 지우지 않았습니다. 목록을 확인한 뒤 ${result.dryRun ? '--dry-run 없이 ' : ''}같은 기준과 --yes=${result.code}를 붙여 다시 실행하면 휴지통으로 보냅니다.`);
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeLowQuality, formatRemoveLowQuality, confirmationCode };
