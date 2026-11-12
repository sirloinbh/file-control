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

// 이보다 최근에 바뀐 파일은 받는 중일 수 있어 남긴다.
const RECENT_MS = 5 * 60 * 1000;
// 휴지통 용량을 확인하지 못했을 때 남기는 크기. remove-broken·remove-duplicates·remove-low-quality는
// 볼륨의 휴지통 설정(최대 크기, 바로 제거)으로 판단하고(#100, #219), 설정을 읽지 못했을 때만 이 크기부터 남긴다.
const MAX_RECYCLE_SIZE = UNKNOWN_RECYCLE_LIMIT;

const reasonOf = (err) => (err instanceof FcError ? err.message : `Cannot check the file. (${err.code ?? err.message})`);

// 복사한 파일은 수정 시각을 보존하므로 생성과 변경 시각까지 함께 본다.
function holdReason(stat, now) {
  const latest = Math.max(...[stat.mtimeMs, stat.birthtimeMs, stat.ctimeMs].map(Number));
  if (latest > now) return 'Kept because its time is in the future, so it is unknown when it changed.';
  return now - latest < RECENT_MS ? 'Kept because it changed just now and may still be downloading.' : null;
}

// 깨짐으로 판별한 파일 중 지울 파일을 고른다. 파일은 건드리지 않는다.
// - removals: 지울 파일 ({ path, size, reason, stamp })
// - kept: 깨졌지만 남기는 파일 ({ path, reason })
// - interactive: 휴지통으로 보낼 수 있는 세션인지. 지울 파일이 없으면 확인하지 않아 null이다.
// 의심과 판단 못함은 지우지 않는다. 휴지통으로 보내다 실패할 것이 확실한 파일은 미리 남긴다(#101).
// - 경로가 MAX_RECYCLE_PATH를 넘는 파일
// - 같은 파일의 다른 이름(하드링크)이 먼저 지울 목록에 있는 파일. 그 이름을 휴지통으로 보내면 파일의 변경 시각이 바뀌어
//   이 이름은 판별한 파일과 달라 보인다. 휴지통 안의 파일도 같은 파일의 이름이라 링크 수는 그대로다.
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findBroken(dir);
  // 판별이 오래 걸릴 수 있어, 그동안 바뀐 파일을 시각이 미래인 파일로 잘못 보지 않게 판별한 뒤의 시각으로 잰다.
  const checkedAt = now ?? Date.now();
  const plan = { ...found, removals: [], kept: [], interactive: null };
  const markerOf = markerFinder();
  // 지울 목록에 넣은 하드링크 파일: 파일 번호 => 경로. 그 다른 이름은 볼륨 확인 뒤에 사유를 정한다.
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
  // 휴지통이 없는 볼륨에서는 영구 삭제될 수 있어 고정 디스크로 확인된 경우에만 지운다.
  const state = recycleBinState(access.target);
  const { interactive, driveType } = state;
  plan.interactive = interactive;
  // 변경 시각이 없는 볼륨(exFAT 등)에서는 확인값과 5분 보호가 바꿔치기를 막지 못해 지우지 않는다(#184).
  const volumeReason = driveType === 'Fixed' ? stampVolumeReason(access.target) : null;
  if (driveType !== 'Fixed' || volumeReason !== null) {
    const reason = volumeReason ?? (driveType === null ? 'Kept because the volume type could not be checked.' : `Kept because the drive is not a fixed disk (${driveType}), so it could be permanently deleted.`);
    plan.kept.push(...[...plan.removals, ...linkKept].map((item) => ({ path: item.path, reason })));
    plan.removals = [];
    return plan;
  }
  // 휴지통 설정상 영구 삭제될 파일(바로 제거, 최대 크기 초과)은 남긴다(#100). 그 다른 이름(하드링크)도 이번에 지울 이름이 없어진다.
  const dropped = new Map();
  plan.removals = plan.removals.filter((item) => {
    const why = permanentDeleteReason(state, Number(item.size), maxSize);
    if (why === null) return true;
    plan.kept.push({ path: item.path, reason: `Kept ${why}.` });
    dropped.set(item.path, why);
    return false;
  });
  // 한 실행에서 같은 파일의 이름을 하나씩만 지우므로, 이름이 셋 이상이면 실행할 때마다 하나씩 줄어든다.
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

// 사람이 본 목록을 나타내는 값. 지울 파일이 늘고 줄거나 하나라도 바뀌면 달라진다.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.reason, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify([plan.target, items])).digest('hex').slice(0, 12);
}

// 기록을 쓴 뒤 파일이 바뀌었으면 지우지 않는다. 지우는 것은 판별한 그 파일이어야 한다.
// 묶음으로 보내기 직전에 Node에서 보고, 휴지통 이동은 rm과 같은 검사(remove의 미리보기)를 거친 경로만 받는다.
// 묶음 안에서도 PowerShell이 파일마다 지우기 직전에 실제 경로와 fileStamp를 다시 본다(recycleFiles, #194).
function checkOne(access, item) {
  const real = access.delete(item.path);
  if (real !== item.path) throw new FcError(`Not deleted because the path changed after it was judged: ${item.path} -> ${real}`);
  const stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isFile() || fileStamp(stat) !== item.stamp) throw new FcError(`Not deleted because the file changed after it was judged: ${real}`);
  // 볼륨 휴지통 설정은 계획 단계에서 봤다(#100). 여기서 다시 보지 않고, 묶음 스크립트(recycleFiles)가 지우기 직전에 다시 본다(#236).
  remove([real], { dryRun: true, checkVolume: false });
  return { path: recycleTarget(real), stamp: item.stamp };
}


// recycleFiles의 결과를 실패 사유로 바꾼다. ok면 undefined다.
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

// 한 번에 PowerShell로 보내는 파일 수. 묶음마다 결과와 진행 줄이 나오므로 너무 크면 진행 표시가 멈춘 것처럼 보인다.
// 100개면 3초 안팎이다(50개 1.6초 실측).
const FILE_BATCH = 100;

// PowerShell 오류 문구에는 스크립트 전문과 깨진 글자가 들어 있어 쓰지 않는다.
function recycleFailure(err) {
  if (err instanceof FcError) return err.message;
  const cause = err.code ?? (err.status == null ? 'unknown error' : `exit code ${err.status}`);
  return `Could not send to the Recycle Bin. (${cause})`;
}

// 타겟 아래 깨진 파일을 휴지통으로 보낸다. confirm이 없거나 dryRun이면 목록만 만들고 아무것도 바꾸지 않는다.
// confirm이 지금 목록의 확인값과 다르면 아무것도 지우지 않고 mismatch를 표시한다.
// 지우기 전에 기록 파일을 남기고, 기록을 남기지 못하면 아무것도 지우지 않는다. 한 파일이 실패해도 나머지는 계속한다.
// 돌려주는 값: planRemoval의 값에 { code, dryRun, confirmed, mismatch, removed, failed, log }를 더한 것. failed는 { path, reason } 목록이고 log는 기록 파일 경로다.
// onProgress(line)를 주면 실제로 지울 때 파일마다 몇 번째인지와 결과를 한 줄로 넘긴다(#99). 묶음(FILE_BATCH개)이 끝날 때마다 그 묶음의 줄이 나온다.
// 파일마다 PowerShell을 띄우면 파일당 0.5~0.6초가 걸려(20개 12.2초, 50개 26.6초) 묶어 보낸다(#194, 50개 1.6초).
function removeBroken(dir, { confirm, dryRun = false, now, maxSize = MAX_RECYCLE_SIZE, onProgress } = {}) {
  const plan = planRemoval(dir, { now, maxSize });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  if (confirm === undefined || dryRun) return result;
  // 본 목록의 파일이 모두 남김이 되어 지울 파일이 없어져도 말없이 성공으로 끝내지 않는다.
  if (confirm !== code) return { ...result, mismatch: true };
  if (plan.removals.length === 0) return result;
  // 비대화형에서는 휴지통으로 보낼 수 없으므로 기록만 쌓이지 않게 기록 전에 멈춘다.
  if (plan.interactive !== true) throw new FcError('Cannot send to the Recycle Bin because it was not confirmed that this is an interactive session. Nothing was deleted.');
  result.confirmed = true;
  const log = writeRemovalLog(plan.target, 'broken files', plan.removals.map(({ path: file, reason }) => ({ path: file, reason })));
  result.log = log.path;
  const access = grant(plan.target, ['delete']);
  const total = plan.removals.length;
  const relative = (p) => path.relative(plan.target, p) || '.';
  // 진행 표시가 던져도 집계와 다음 파일 처리는 그대로 간다(1차 리뷰). 이미 휴지통으로 간 파일을 실패로 세지 않는다.
  const report = (line) => {
    try {
      onProgress?.(line);
    } catch {
      // 진행 표시는 결과에 영향을 주지 않는다.
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

// 지울 목록(removals)을 FILE_BATCH개씩 묶어 휴지통으로 보낸다(#194, #216). remove-broken·remove-duplicates·remove-low-quality가 쓴다.
// 묶음을 보내기 직전에 파일마다 기록 경로를 맞춰 보고 prepare(item)로 Node 검사를 한다. prepare는 recycleFiles에 넘길
// { path, stamp, keep? }를 돌려주고, 문제가 있으면 던진다. PowerShell도 파일마다 지우기 직전에 다시 본다(recycleFiles).
// 결과는 파일마다 on.removed(item, step) 또는 on.failed(item, reason, step)로 알린다. step은 "3/120" 꼴이다.
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
      // 묶음을 시작하지 못하면(비대화형 등) 이 묶음의 파일은 아무것도 지우지 않았다.
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
