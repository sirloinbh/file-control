'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove, recycleBinState } = require('./commands');
const { grant, walk, fileStamp } = require('./target');
const { findBroken } = require('./broken');
const { rejectRepository } = require('./flatten');
const { writeRemovalLog } = require('./removalLog');

// 이보다 최근에 바뀐 파일은 받는 중일 수 있어 남긴다.
const RECENT_MS = 5 * 60 * 1000;
// 휴지통 용량을 넘는 파일은 Windows가 묻지 않고 영구 삭제할 수 있어(#81) 이 크기부터 남긴다. 기본 휴지통 용량은 볼륨의 약 5%다.
const MAX_RECYCLE_SIZE = 1024 * 1024 * 1024;

// 받기 도구가 받는 중인 파일 옆에 두는 표시 파일의 꼬리. x.mp4를 받는 동안 x.mp4.part, x.mp4.aria2처럼 파일 이름 뒤에 붙는다.
// .part: Firefox, yt-dlp, JDownloader, Transmission / .crdownload: Chrome, Edge / .partial: 옛 Edge / .download: Safari / .opdownload: Opera
// .fdmdownload: Free Download Manager / .aria2: aria2 / .ytdl, .part-Frag숫자: yt-dlp / .td, .td.cfg, .xltd: Thunder(迅雷) / .!qB: qBittorrent / .!ut: µTorrent / .bc!: BitComet
// 크기를 미리 잡고 받는 도구(aria2, Thunder)는 받는 중인 파일을 제 이름으로 두므로, 오래 멈춰 있던 받기도 이 표시로만 알 수 있다.
const DOWNLOAD_MARKER = /^(.+?)\.(?:part(?:-frag\d+)?|crdownload|partial|download|opdownload|fdmdownload|aria2|ytdl|td(?:\.cfg)?|xltd|!qb|!ut|bc!)$/i;

// 폴더 안의 표시 파일을 받는 중인 파일 이름(소문자)으로 찾아볼 수 있게 모은다. Windows는 이름의 대소문자를 가리지 않는다.
function downloadMarkers(dir) {
  const markers = new Map();
  for (const name of fs.readdirSync(dir)) {
    const match = DOWNLOAD_MARKER.exec(name);
    if (match && !markers.has(match[1].toLowerCase())) markers.set(match[1].toLowerCase(), name);
  }
  return markers;
}

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
// 의심과 판단 못함은 지우지 않는다.
function planRemoval(dir, { now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const access = grant(dir, ['delete']);
  rejectRepository(access.target, walk(access.target));
  const found = findBroken(dir);
  // 판별이 오래 걸릴 수 있어, 그동안 바뀐 파일을 시각이 미래인 파일로 잘못 보지 않게 판별한 뒤의 시각으로 잰다.
  const checkedAt = now ?? Date.now();
  const plan = { ...found, removals: [], kept: [], interactive: null };
  // 폴더마다 표시 파일 목록을 한 번만 읽는다.
  const markersIn = new Map();
  const markerOf = (file) => {
    const dir = path.dirname(file);
    if (!markersIn.has(dir)) markersIn.set(dir, downloadMarkers(dir));
    return markersIn.get(dir).get(path.basename(file).toLowerCase()) ?? null;
  };
  for (const item of found.broken) {
    const keep = (reason) => plan.kept.push({ path: item.path, reason });
    try {
      const real = access.delete(item.path);
      const stat = fs.lstatSync(real, { bigint: true });
      const hold = holdReason(stat, checkedAt);
      const marker = hold === null ? markerOf(real) : null;
      if (real !== item.path || !stat.isFile() || fileStamp(stat) !== item.stamp) keep('판별한 뒤 파일이 바뀌어 남겼습니다.');
      else if (hold !== null) keep(hold);
      else if (marker !== null) keep(`받기 도구의 표시 파일(${marker})이 옆에 있어 아직 받는 중일 수 있어 남겼습니다. 받기를 그만뒀다면 표시 파일을 지운 뒤 다시 실행합니다.`);
      else if (item.size >= maxSize) keep('1GB 이상이라 휴지통을 거치지 않고 영구 삭제될 수 있어 남겼습니다.');
      else plan.removals.push({ path: real, size: item.size, reason: item.reason, stamp: item.stamp });
    } catch (err) {
      keep(reasonOf(err));
    }
  }
  if (plan.removals.length === 0) return plan;
  // 휴지통이 없는 볼륨에서는 영구 삭제될 수 있어 고정 디스크로 확인된 경우에만 지운다.
  const { interactive, driveType } = recycleBinState(access.target);
  plan.interactive = interactive;
  if (driveType !== 'Fixed') {
    const reason = driveType === null ? '볼륨 종류를 확인하지 못해 남겼습니다.' : `고정 디스크가 아니라(${driveType}) 영구 삭제될 수 있어 남겼습니다.`;
    plan.kept.push(...plan.removals.map((item) => ({ path: item.path, reason })));
    plan.removals = [];
  }
  return plan;
}

// 사람이 본 목록을 나타내는 값. 지울 파일이 늘고 줄거나 하나라도 바뀌면 달라진다.
function confirmationCode(plan) {
  const items = plan.removals.map((item) => [item.path, item.reason, item.stamp]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify([plan.target, items])).digest('hex').slice(0, 12);
}

// 기록을 쓴 뒤 파일이 바뀌었으면 지우지 않는다. 지우는 것은 판별한 그 파일이어야 한다.
function removeOne(access, item) {
  const real = access.delete(item.path);
  if (real !== item.path) throw new FcError(`판별한 뒤 경로가 바뀌어 지우지 않았습니다: ${item.path} -> ${real}`);
  const stat = fs.lstatSync(real, { bigint: true });
  if (!stat.isFile() || fileStamp(stat) !== item.stamp) throw new FcError(`판별한 뒤 파일이 바뀌어 지우지 않았습니다: ${real}`);
  remove([real]);
}

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
function removeBroken(dir, { confirm, dryRun = false, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
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
  plan.removals.forEach((item, index) => {
    try {
      const logged = log.items[index].path;
      if (logged !== item.path) throw new FcError(`판별한 뒤 경로가 바뀌어 지우지 않았습니다: ${item.path} -> ${logged}`);
      removeOne(access, item);
      result.removed.push(item);
    } catch (err) {
      result.failed.push({ path: item.path, reason: recycleFailure(err) });
    }
  });
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
