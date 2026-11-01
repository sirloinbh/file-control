'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove } = require('./commands');
const { grant } = require('./target');
const { findBroken } = require('./broken');
const { writeRemovalLog } = require('./removalLog');

// 이보다 최근에 바뀐 파일은 받는 중일 수 있어 남긴다. 시각이 미래인 파일도 언제 바뀌었는지 알 수 없어 남긴다.
const RECENT_MS = 5 * 60 * 1000;

const reasonOf = (err) => (err instanceof FcError ? err.message : `파일을 확인할 수 없습니다. (${err.code ?? err.message})`);

// 깨짐으로 판별한 파일 중 지울 파일을 고른다. 파일은 건드리지 않는다.
// - removals: 지울 파일 ({ path, size, reason, mtimeMs, ino })
// - kept: 깨졌지만 남기는 파일 ({ path, reason })
// 의심과 판단 못함은 지우지 않는다.
function planRemoval(dir, { now = Date.now() } = {}) {
  const found = findBroken(dir);
  const access = grant(found.target, ['delete']);
  const plan = { ...found, removals: [], kept: [] };
  for (const item of found.broken) {
    const keep = (reason) => plan.kept.push({ path: item.path, reason });
    try {
      const real = access.delete(item.path);
      const stat = fs.lstatSync(real);
      if (real !== item.path || !stat.isFile() || stat.size !== item.size) keep('판별한 뒤 파일이 바뀌어 남겼습니다.');
      else if (now - stat.mtimeMs < RECENT_MS) keep('방금 바뀐 파일이라 받는 중일 수 있어 남겼습니다.');
      else plan.removals.push({ path: real, size: item.size, reason: item.reason, mtimeMs: stat.mtimeMs, ino: stat.ino });
    } catch (err) {
      keep(reasonOf(err));
    }
  }
  return plan;
}

// 기록을 쓴 뒤 파일이 바뀌었으면 지우지 않는다. 지우는 것은 판별한 그 파일이어야 한다.
function removeOne(access, item) {
  const real = access.delete(item.path);
  if (real !== item.path) throw new FcError(`판별한 뒤 경로가 바뀌어 지우지 않았습니다: ${item.path} -> ${real}`);
  const stat = fs.lstatSync(real);
  if (!stat.isFile() || stat.size !== item.size || stat.mtimeMs !== item.mtimeMs || stat.ino !== item.ino) throw new FcError(`판별한 뒤 파일이 바뀌어 지우지 않았습니다: ${real}`);
  remove([real]);
}

// 타겟 아래 깨진 파일을 휴지통으로 보낸다. yes가 없거나 dryRun이면 목록만 만들고 아무것도 바꾸지 않는다.
// 지우기 전에 기록 파일을 남기고, 기록을 남기지 못하면 아무것도 지우지 않는다. 한 파일이 실패해도 나머지는 계속한다.
// 돌려주는 값: findBroken의 값에 { confirmed, removals, kept, removed, failed, log }를 더한 것. failed는 { path, reason } 목록이고 log는 기록 파일 경로다.
function removeBroken(dir, { yes = false, dryRun = false, now = Date.now() } = {}) {
  const plan = planRemoval(dir, { now });
  const confirmed = yes && !dryRun;
  const result = { ...plan, confirmed, removed: [], failed: [], log: null };
  if (!confirmed || plan.removals.length === 0) return result;
  const log = writeRemovalLog(plan.target, '깨진 파일', plan.removals.map(({ path: file, reason }) => ({ path: file, reason })), { now: new Date(now) });
  result.log = log.path;
  const access = grant(plan.target, ['delete']);
  for (const item of plan.removals) {
    try {
      removeOne(access, item);
      result.removed.push(item);
    } catch (err) {
      result.failed.push({ path: item.path, reason: err instanceof FcError ? err.message : `휴지통으로 보내지 못했습니다. (${err.code ?? err.message})` });
    }
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
    if (result.removals.length > 0) lines.push('아직 지우지 않았습니다. 목록을 확인한 뒤 --yes를 붙여 다시 실행하면 휴지통으로 보냅니다.');
  }
  return lines.join('\n');
}

module.exports = { planRemoval, removeBroken, formatRemoveBroken };
