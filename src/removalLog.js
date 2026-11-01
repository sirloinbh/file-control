'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant } = require('./target');

// 같은 초에 여러 번 실행해도 기존 기록을 덮어쓰지 않도록 이름 뒤에 번호를 붙여 찾는 횟수
const MAX_NAME_ATTEMPTS = 1000;

const pad = (value, width = 2) => String(value).padStart(width, '0');

function nameStamp(now) {
  const date = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// 사람이 읽는 기록이므로 UTC가 아니라 시간대를 붙인 현지 시각으로 적는다.
function localTime(now) {
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const date = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${zone}`;
}

// 지울 수 있는 일반 파일만 받는다. 기록과 실제 제거 대상이 어긋나지 않게 grant.delete로 확인하고 그 실제 경로를 적는다.
function describeItem(access, item) {
  const label = typeof item?.path === 'string' ? item.path : JSON.stringify(item?.path);
  if (typeof item?.path !== 'string') throw new FcError(`기록할 경로가 올바르지 않습니다: ${label}`);
  if (typeof item.reason !== 'string' || item.reason === '') throw new FcError(`제거 사유가 없습니다: ${label}`);
  const real = access.delete(item.path);
  let stat;
  try {
    stat = fs.lstatSync(real);
  } catch (err) {
    throw new FcError(`파일을 확인할 수 없습니다: ${label} (${err.code})`);
  }
  if (!stat.isFile()) throw new FcError(`파일이 아니라 기록할 수 없습니다: ${label}`);
  return { path: real, size: stat.size, reason: item.reason, ...(item.details === undefined ? {} : { details: item.details }) };
}

function describeItems(access, items) {
  const described = items.map((item) => describeItem(access, item));
  const seen = new Set();
  for (const { path: real } of described) {
    if (seen.has(real)) throw new FcError(`같은 파일이 두 번 있습니다: ${real}`);
    seen.add(real);
  }
  return described;
}

// 비어 있는 이름을 찾는다. dryRun이면 만들지 않고 경로만 돌려주고, 아니면 wx로 만든 뒤 fd를 함께 돌려준다.
// 이미 있는 항목에는 손대지 않는다. 끊어진 정션에 wx로 열면 정션이 가리키는 타겟 밖에 폴더가 생기므로 먼저 lstat으로 본다.
function claimName(access, stamp, dryRun) {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(access.target, `fctl-removed-${stamp}${attempt === 1 ? '' : `-${attempt}`}.json`);
    try {
      if (fs.lstatSync(candidate, { throwIfNoEntry: false })) continue;
      const file = access.write(candidate);
      if (dryRun) return { file };
      return { file, fd: fs.openSync(file, 'wx') };
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (err instanceof FcError) throw err;
      throw new FcError(`기록 파일을 만들지 못했습니다: ${candidate} (${err.code})`);
    }
  }
  throw new FcError(`기록 파일 이름을 정하지 못했습니다: fctl-removed-${stamp}`);
}

function removePartial(file, cause) {
  try {
    fs.rmSync(file);
  } catch (err) {
    throw new FcError(`기록 파일을 끝까지 쓰지 못했고 지우지도 못했습니다: ${file} (${cause.code}, ${err.code})`);
  }
  throw new FcError(`기록 파일을 쓰지 못했습니다: ${file} (${cause.code})`);
}

// 제거 전에 대상의 경로·크기·사유를 타겟 폴더의 날짜가 붙은 JSON 파일로 남긴다. 파일은 지우지 않는다.
// JSON으로 적는 이유: 이름과 사유에 어떤 글자가 있어도 그대로 되살릴 수 있고, CSV처럼 Excel이 =로 시작하는 파일 이름을 수식으로 실행할 일이 없다.
//
// kind: 제거 종류 (예: '깨진 파일'). items: { path, reason, details? } 목록.
// details는 해상도·비트레이트·남긴 파일처럼 종류마다 다른 값이다. path는 타겟 기준 상대경로 또는 절대경로다.
// 돌려주는 값: { path, count, dryRun }. 대상이 없으면 파일을 만들지 않고 null을 돌려준다.
// 대상 하나라도 지울 수 없는 항목이면 FcError를 내고 아무것도 남기지 않는다. 오류 없이 돌아온 뒤에 제거한다.
function writeRemovalLog(dir, kind, items, { dryRun = false, now = new Date() } = {}) {
  if (typeof kind !== 'string' || kind === '') throw new FcError('제거 종류를 지정하세요.');
  if (!Array.isArray(items)) throw new FcError('제거 대상은 목록이어야 합니다.');
  const access = grant(dir, ['write', 'delete']);
  if (items.length === 0) return null;
  const described = describeItems(access, items);
  const { file, fd } = claimName(access, nameStamp(now), dryRun);
  if (dryRun) return { path: file, count: described.length, dryRun };
  const log = { kind, createdAt: localTime(now), target: access.target, count: described.length, items: described };
  let failure;
  try {
    fs.writeFileSync(fd, `${JSON.stringify(log, null, 2)}\n`);
    // 기록이 디스크에 닿기 전에 제거하지 않도록 돌아오기 전에 내보낸다.
    fs.fsyncSync(fd);
  } catch (err) {
    failure = err;
  }
  try {
    fs.closeSync(fd);
  } catch (err) {
    failure ??= err;
  }
  if (failure) removePartial(file, failure);
  return { path: file, count: described.length, dryRun };
}

module.exports = { writeRemovalLog };
