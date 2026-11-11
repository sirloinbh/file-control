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

// 비트레이트로만 저화질이 된 파일은 지우지 않는다. 비트레이트는 파일 크기를 길이로 나눈 값이라, 길이가 부풀어 읽히거나
// 덜 받은 파일이면 정상 영상도 낮게 나온다. 길이를 맞춰 보는 검사(#179)가 생기기 전에는 목록으로만 알린다.
const BITRATE_ONLY = 'Kept because it is low quality by bitrate only, so the duration may be a corrupt value. Only files that fail the resolution criterion are deleted.';

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
  // 휴지통이 없는 볼륨에서는 영구 삭제될 수 있어 고정 디스크로 확인된 경우에만 지운다.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  // 변경 시각이 없는 볼륨(exFAT 등)에서는 확인값과 5분 보호가 바꿔치기를 막지 못해 지우지 않는다(#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? 'Kept because the volume type could not be checked.' : `Kept because the drive is not a fixed disk (${driveType}), so it could be permanently deleted.`);
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

// 사람이 본 목록을 나타내는 값. 기준이 바뀌거나 지울 파일이 늘고 줄거나 하나라도 바뀌면 달라진다.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['low-quality videos', plan.target, plan.criteria, items])).digest('hex').slice(0, 12);
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
  // remove-broken처럼 묶어 보낸다(#216). 파일마다 PowerShell을 띄우면 파일당 0.5~0.6초가 걸린다.
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
