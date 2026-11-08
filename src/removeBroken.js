'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove, recycleBinState, recycleTarget, recycleFiles, recycleFailureMessage, permanentDeleteReason, UNKNOWN_RECYCLE_LIMIT, MAX_RECYCLE_PATH } = require('./commands');
const { grant, walk, fileStamp, stampVolumeReason } = require('./target');
const { findBroken } = require('./broken');
const { rejectRepository } = require('./flatten');
const { writeRemovalLog } = require('./removalLog');
const { markerFinder, markerReason } = require('./downloadMarker');

// 이보다 최근에 바뀐 파일은 받는 중일 수 있어 남긴다.
const RECENT_MS = 5 * 60 * 1000;
// 휴지통 용량을 확인하지 못했을 때 남기는 크기(remove-low-quality가 아직 고정값으로 쓴다). remove-broken·remove-duplicates는
// 볼륨의 휴지통 설정(최대 크기, 바로 제거)으로 판단하고(#100), 설정을 읽지 못했을 때만 이 크기부터 남긴다.
const MAX_RECYCLE_SIZE = UNKNOWN_RECYCLE_LIMIT;

const reasonOf = (err) => (err instanceof FcError ? err.message : `파일을 확인할 수 없습니다. (${err.code ?? err.message})`);

// 복사한 파일은 수정 시각을 보존하므로 생성과 변경 시각까지 함께 본다.
function holdReason(stat, now) {
  const latest = Math.max(...[stat.mtimeMs, stat.birthtimeMs, stat.ctimeMs].map(Number));
  if (latest > now) return '시각이 미래인 파일이라 언제 바뀌었는지 알 수 없어 남겼습니다.';
  return now - latest < RECENT_MS ? '방금 바뀐 파일이라 받는 중일 수 있어 남겼습니다.' : null;
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
      if (real !== item.path || !stat.isFile() || fileStamp(stat) !== item.stamp) keep('판별한 뒤 파일이 바뀌어 남겼습니다.');
      else if (real.length > MAX_RECYCLE_PATH) keep(`경로가 ${real.length}자라 휴지통으로 보낼 수 있는 ${MAX_RECYCLE_PATH}자를 넘어 남겼습니다. 이름을 줄이거나 위 폴더로 옮긴 뒤 다시 실행하세요.`);
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
    const reason = volumeReason ?? (driveType === null ? '볼륨 종류를 확인하지 못해 남겼습니다.' : `고정 디스크가 아니라(${driveType}) 영구 삭제될 수 있어 남겼습니다.`);
    plan.kept.push(...[...plan.removals, ...linkKept].map((item) => ({ path: item.path, reason })));
    plan.removals = [];
    return plan;
  }
  // 휴지통 설정상 영구 삭제될 파일(바로 제거, 최대 크기 초과)은 남긴다(#100). 그 다른 이름(하드링크)도 이번에 지울 이름이 없어진다.
  const dropped = new Map();
  plan.removals = plan.removals.filter((item) => {
    const why = permanentDeleteReason(state, Number(item.size), maxSize);
    if (why === null) return true;
    plan.kept.push({ path: item.path, reason: `${why} 남겼습니다.` });
    dropped.set(item.path, why);
    return false;
  });
  // 한 실행에서 같은 파일의 이름을 하나씩만 지우므로, 이름이 셋 이상이면 실행할 때마다 하나씩 줄어든다.
  for (const item of linkKept) {
    if (dropped.has(item.other)) {
      plan.kept.push({ path: item.path, reason: `${dropped.get(item.other)} 남겼습니다.` });
      continue;
    }
    const reason = `같은 파일의 다른 이름(하드링크: ${path.relative(access.target, item.other)})을 이번에 먼저 지우므로 파일의 변경 시각이 바뀌어 함께 지울 수 없어 남겼습니다. 5분 뒤 다시 실행할 때마다 이름을 하나씩 지웁니다.`;
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
  if (real !== item.path) throw new FcError(`판별한 뒤 경로가 바뀌어 지우지 않았습니다: ${item.path} -> ${real}`);
  const stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isFile() || fileStamp(stat) !== item.stamp) throw new FcError(`판별한 뒤 파일이 바뀌어 지우지 않았습니다: ${real}`);
  remove([real], { dryRun: true });
  return { path: recycleTarget(real), stamp: item.stamp };
}

// 파일 하나를 검사하고 바로 휴지통으로 보낸다. remove-duplicates·remove-low-quality가 쓴다.
function removeOne(access, item) {
  remove([checkOne(access, item).path]);
}

// recycleFiles의 결과를 실패 사유로 바꾼다. ok면 undefined다.
function batchFailure(file, { status, reason }) {
  switch (status) {
    case 'ok':
      return undefined;
    case 'moved':
      return `판별한 뒤 경로가 바뀌어 지우지 않았습니다: ${file}`;
    case 'notfile':
    case 'changed':
      return `판별한 뒤 파일이 바뀌어 지우지 않았습니다: ${file}`;
    case 'gone':
      return `판별한 뒤 파일이 사라져 지우지 않았습니다: ${file}`;
    case 'error':
      return recycleFailureMessage(file, reason);
    default:
      return `휴지통으로 보냈는지 알 수 없습니다: ${file} (${reason}). 휴지통과 원래 자리를 확인하세요.`;
  }
}

// 한 번에 PowerShell로 보내는 파일 수. 묶음마다 결과와 진행 줄이 나오므로 너무 크면 진행 표시가 멈춘 것처럼 보인다.
// 100개면 3초 안팎이다(50개 1.6초 실측).
const FILE_BATCH = 100;

// PowerShell 오류 문구에는 스크립트 전문과 깨진 글자가 들어 있어 쓰지 않는다.
function recycleFailure(err) {
  if (err instanceof FcError) return err.message;
  const cause = err.code ?? (err.status == null ? '알 수 없는 오류' : `종료 코드 ${err.status}`);
  return `휴지통으로 보내지 못했습니다. (${cause})`;
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
  if (plan.interactive !== true) throw new FcError('대화형 세션인지 확인되지 않아 휴지통으로 보낼 수 없습니다. 아무것도 지우지 않았습니다.');
  result.confirmed = true;
  const log = writeRemovalLog(plan.target, '깨진 파일', plan.removals.map(({ path: file, reason }) => ({ path: file, reason })));
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
  report(`휴지통으로 보내는 중: ${total}개 (${FILE_BATCH}개씩 묶어 보냅니다)`);
  const fail = (step, item, reason) => {
    result.failed.push({ path: item.path, reason });
    report(`${step} 실패: ${relative(item.path)} (${reason})`);
  };
  for (let start = 0; start < total; start += FILE_BATCH) {
    const batch = [];
    plan.removals.slice(start, start + FILE_BATCH).forEach((item, offset) => {
      const index = start + offset;
      const step = `${index + 1}/${total}`;
      try {
        const logged = log.items[index].path;
        if (logged !== item.path) throw new FcError(`판별한 뒤 경로가 바뀌어 지우지 않았습니다: ${item.path} -> ${logged}`);
        batch.push({ item, step, send: checkOne(access, item) });
      } catch (err) {
        fail(step, item, recycleFailure(err));
      }
    });
    let outcomes;
    try {
      outcomes = recycleFiles(batch.map((entry) => entry.send));
    } catch (err) {
      // 묶음을 시작하지 못하면(비대화형 등) 이 묶음의 파일은 아무것도 지우지 않았다.
      for (const entry of batch) fail(entry.step, entry.item, recycleFailure(err));
      continue;
    }
    batch.forEach((entry, i) => {
      const reason = batchFailure(entry.item.path, outcomes[i]);
      if (reason !== undefined) return fail(entry.step, entry.item, reason);
      result.removed.push(entry.item);
      report(`${entry.step} 휴지통으로 이동: ${relative(entry.item.path)}`);
    });
  }
  return result;
}

function formatRemoveBroken(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  if (result.confirmed) {
    for (const item of result.removed) lines.push(`휴지통으로 이동: ${relative(item.path)} (${item.reason})`);
  } else {
    for (const item of result.removals) lines.push(`지울 파일: ${relative(item.path)} (${item.reason})`);
  }
  for (const item of result.kept) lines.push(`남김: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`실패: ${relative(item.path)} (${item.reason})`);
  for (const item of result.suspect) lines.push(`의심, 지우지 않음: ${relative(item.path)} (${item.reason})`);
  for (const item of result.unreadable) lines.push(`판단 못함, 지우지 않음: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`건너뜀: ${relative(item.path)} (${item.reason})`);
  if (result.log) lines.push(`제거 기록: ${result.log}`);
  const counts = `남김 ${result.kept.length}개, 의심 ${result.suspect.length}개, 판단 못함 ${result.unreadable.length}개, 건너뜀 ${result.skipped.length}개`;
  if (result.confirmed) {
    lines.push(`휴지통 ${result.removed.length}개, 실패 ${result.failed.length}개, ${counts}`);
  } else {
    lines.push(`지울 파일 ${result.removals.length}개, ${counts}`);
    if (result.removals.length > 0) lines.push(`아직 지우지 않았습니다. 목록을 확인한 뒤 ${result.dryRun ? '--dry-run 없이 ' : ''}--yes=${result.code}를 붙여 다시 실행하면 휴지통으로 보냅니다.`);
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeBroken, formatRemoveBroken, confirmationCode, holdReason, recycleFailure, removeOne, MAX_RECYCLE_SIZE };
