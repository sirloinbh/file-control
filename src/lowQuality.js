'use strict';

const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk, fileSizeInside } = require('./target');
const { LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');
const { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS, isTransportStream } = require('./productName');
const { describeVideo } = require('./duplicates');
const { readMp4Metadata } = require('./mp4');
const { readMkvMetadata } = require('./mkv');

// 저화질 판별 기준의 기본값과 범위(#30). 화면의 짧은 쪽이 360화소 미만이면 저화질로 본다. 비트레이트 기준은 주지 않으면 보지 않는다.
// 비트레이트는 코덱과 내용에 따라 크게 달라 기본값으로 정하기 어렵다.
const DEFAULT_MIN_HEIGHT = 360;
const HEIGHT_LIMIT = 100000;
const BITRATE_LIMIT = 1000000;

// 메타데이터 값이 정상 범위인지 본다(#30 댓글, PR #68 리뷰). 깨진 값이 저화질로 잡혀 삭제 후보가 되지 않게 한다.
// - 화면 크기: 짧은 쪽 16화소 미만은 영상으로 쓰이지 않으므로 깨진 값으로 본다. 긴 쪽 65535 초과도 같다.
//   보이는 크기가 인코딩 해상도와 크게 다르면(짧은 쪽끼리, 긴 쪽끼리 비교해 2배 넘게 차이) 깨진 값으로 본다(1차 리뷰).
//   MP4는 tkhd 화면 크기의 비율이 다르면 그 값을 보이는 크기로 쓰므로, tkhd가 깨져 1920x1080이 1920x100으로 보이면 정상 파일이 저화질로 잡힌다.
//   정상인 화소 비율(720x480 -> 853x480, 1440x1080 -> 1920x1080, 2:1 아나모픽)과 90·270도 회전은 이 범위 안이다.
// - 길이: 7일을 넘으면 길이가 깨진 값이다(timescale이 비정상이면 수조 초가 나온다). 이때 파일 크기로 계산한 비트레이트는 0에 가까워진다.
// - 비트레이트: 길이 1초 미만이면 머리 구조의 비중이 커서 믿지 않는다. 1kbps 미만은 영상이 담길 수 없는 값이라 깨진 값으로 본다.
const MIN_SIDE = 16;
const MAX_SIDE = 65535;
const MAX_DISPLAY_SCALE = 2;
const MAX_DURATION = 7 * 24 * 60 * 60;
const MIN_BITRATE_DURATION = 1;
const MIN_BITRATE = 1000;

const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);
const MKV_EXTENSIONS = new Set(['.mkv', '.webm']);

// 옵션 값을 검사해 { minHeight, minBitrate }로 돌려준다. minBitrate는 kbps이고, null이면 비트레이트를 보지 않는다.
// 값은 정수나 명령줄에서 받은 글자("480")다. 글자는 숫자로만 된 것만 받는다.
function lowQualityCriteria({ minHeight = DEFAULT_MIN_HEIGHT, minBitrate = null } = {}) {
  const check = (value, name, limit) => {
    const number = typeof value === 'string' ? (/^\d+$/.test(value) ? Number(value) : Number.NaN) : value;
    if (!Number.isInteger(number) || number < 1 || number > limit) throw new FcError(`${name}는 1부터 ${limit}까지의 정수로 쓰세요: ${JSON.stringify(value)}`);
    return number;
  };
  return {
    minHeight: check(minHeight, '--min-height', HEIGHT_LIMIT),
    minBitrate: minBitrate === null ? null : check(minBitrate, '--min-bitrate', BITRATE_LIMIT),
  };
}

// 읽은 메타데이터를 정상 범위만 남겨 { shortSide, width, height, displayWidth, displayHeight, duration, bitrate, notes }로 바꾼다.
// 범위를 벗어난 값은 null로 두고 사유를 notes에 적는다. 순수 함수다.
function saneInfo(info) {
  const notes = [];
  const number = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  let width = number(info.width);
  let height = number(info.height);
  let displayWidth = number(info.displayWidth);
  let displayHeight = number(info.displayHeight);
  if (displayWidth === null || displayHeight === null) [displayWidth, displayHeight] = [width, height];
  let shortSide = null;
  if (displayWidth !== null && displayHeight !== null && width !== null && height !== null) {
    const sides = [width, height, displayWidth, displayHeight];
    const coded = [width, height].sort((a, b) => a - b);
    const shown = [displayWidth, displayHeight].sort((a, b) => a - b);
    const scaled = coded.some((side, index) => Math.max(side, shown[index]) / Math.min(side, shown[index]) > MAX_DISPLAY_SCALE);
    if (Math.min(...sides) < MIN_SIDE || Math.max(...sides) > MAX_SIDE || scaled) {
      notes.push(`해상도 값(${width}x${height}, 보이는 크기 ${displayWidth}x${displayHeight})이 정상 범위를 벗어나 깨진 값일 수 있습니다.`);
      width = height = displayWidth = displayHeight = null;
    } else {
      shortSide = Math.min(displayWidth, displayHeight);
    }
  } else {
    notes.push('해상도 정보가 없습니다.');
  }
  let duration = number(info.duration);
  if (duration !== null && duration > MAX_DURATION) {
    notes.push(`길이 값(${Math.round(duration)}초)이 7일을 넘어 깨진 값일 수 있습니다.`);
    duration = null;
  }
  let bitrate = duration === null || duration < MIN_BITRATE_DURATION ? null : number(info.bitrate);
  // 읽기에서 길이를 트랙·실제 데이터와 맞춰 보고 믿지 못한 경우(받다 만 파일, 깨진 길이, #179)
  if (duration !== null && typeof info.bitrateNote === 'string') {
    notes.push(info.bitrateNote);
    bitrate = null;
  }
  if (bitrate !== null && bitrate < MIN_BITRATE) {
    notes.push(`비트레이트 값(${bitrate}bps)이 너무 작아 깨진 값일 수 있습니다.`);
    bitrate = null;
  }
  if (bitrate === null && !notes.some((note) => /길이|비트레이트/.test(note))) notes.push(duration === null ? '길이 정보가 없어 비트레이트를 알 수 없습니다.' : duration < MIN_BITRATE_DURATION ? '길이가 1초 미만이라 비트레이트를 믿을 수 없습니다.' : '비트레이트 정보가 없습니다.');
  return { width, height, displayWidth, displayHeight, shortSide, duration, bitrate, notes };
}

// 기준으로 판별한다. 순수 함수다. { status: 'low' | 'ok' | 'unknown', reasons }를 돌려준다.
// 저화질이면 해상도 기준에 걸렸는지(byResolution)도 함께 돌려준다. 비트레이트로만 걸린 파일은 길이가 깨졌을 수 있어 지우지 않는다(#31, #179).
// 어느 한 기준이라도 미만이면 저화질이다. 미만인 기준이 없고 볼 기준 중 하나라도 값을 모르면 판단 못함이다.
function judgeQuality(info, criteria) {
  const reasons = [];
  const unknown = [];
  if (info.shortSide === null) unknown.push('해상도');
  else if (info.shortSide < criteria.minHeight) reasons.push(`화면의 짧은 쪽 ${info.shortSide}화소 < ${criteria.minHeight}`);
  if (criteria.minBitrate !== null) {
    if (info.bitrate === null) unknown.push('비트레이트');
    else if (info.bitrate < criteria.minBitrate * 1000) reasons.push(`비트레이트 ${Math.round(info.bitrate / 1000)}kbps < ${criteria.minBitrate}kbps`);
  }
  if (reasons.length > 0) return { status: 'low', reasons, byResolution: info.shortSide !== null && info.shortSide < criteria.minHeight };
  if (unknown.length > 0) return { status: 'unknown', reasons: [`${unknown.join('와 ')}를 알 수 없어 판단하지 못했습니다.`, ...info.notes] };
  return { status: 'ok', reasons: [] };
}

function skipReason(parts) {
  if (parts.some((part) => LEFTOVER.test(part))) return '이전 작업의 잔여물이라 보지 않습니다.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Windows 시스템 폴더 안의 파일이라 보지 않습니다.';
  return null;
}

// 타겟 아래 영상 중 기준 미만인 저화질 파일을 찾는다. 파일은 건드리지 않는다.
// 해상도와 비트레이트를 읽는 형식은 MP4/MOV와 MKV/WebM이다. 그 밖의 영상은 판단 못함으로 알린다. 저장소 폴더 안은 보지 않는다.
// - low: 저화질 파일 ({ path, size, width, height, displayWidth, displayHeight, duration, bitrate, reasons, byResolution })
// - unreadable: 판단 못한 영상 ({ path, reason })
// - skipped: 링크·잔여물·시스템 폴더 ({ path, reason })
// - checked: 읽은 영상 수, criteria: 쓴 기준
function findLowQuality(dir, options = {}) {
  const criteria = lowQualityCriteria(options);
  const access = grant(dir, ['read']);
  const result = { target: access.target, criteria, low: [], unreadable: [], skipped: [], checked: 0 };
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => REPOSITORY_FOLDER.test(part))) continue;
    if (entry.type === 'link') {
      result.skipped.push({ path: entry.path, reason: '링크는 보지 않습니다.' });
      continue;
    }
    const extension = path.extname(entry.path).toLowerCase();
    const transport = TRANSPORT_EXTENSIONS.has(extension);
    if (!VIDEO_EXTENSIONS.has(extension) && !transport) continue;
    try {
      if (transport && !isTransportStream(access.target, entry.relative)) continue;
      const skip = skipReason(parts);
      if (skip !== null) {
        result.skipped.push({ path: entry.path, reason: skip });
        continue;
      }
      const real = access.read(entry.path);
      result.checked += 1;
      const reader = MP4_EXTENSIONS.has(extension) ? readMp4Metadata : MKV_EXTENSIONS.has(extension) ? readMkvMetadata : null;
      if (reader === null) {
        result.unreadable.push({ path: real, reason: `${extension} 형식은 해상도를 읽지 못합니다.` });
        continue;
      }
      const size = fileSizeInside(access.target, real);
      // 비트레이트를 판단에 쓰므로 표본 표·탐색 표로 길이를 맞춰 보게 한다(#207).
      const info = saneInfo(reader(access.target, real, { verifyBitrate: true }));
      const judged = judgeQuality(info, criteria);
      if (judged.status === 'unknown') result.unreadable.push({ path: real, reason: judged.reasons.join(' ') });
      if (judged.status !== 'low') continue;
      const { width, height, displayWidth, displayHeight, duration, bitrate } = info;
      result.low.push({ path: real, size, width, height, displayWidth, displayHeight, duration, bitrate, reasons: judged.reasons, byResolution: judged.byResolution });
    } catch (err) {
      result.unreadable.push({ path: entry.path, reason: err instanceof FcError ? err.message : `파일을 읽을 수 없습니다. (${err.code ?? err.message})` });
    }
  }
  return result;
}

// 영상 설명에 비트레이트를 붙인다. 10.0MB, 640x352, 1:00, 800kbps
function describeLowQuality(file) {
  const base = describeVideo(file);
  return file.bitrate === null ? base : `${base}, ${Math.round(file.bitrate / 1000)}kbps`;
}

function criteriaText(criteria) {
  const parts = [`화면의 짧은 쪽 ${criteria.minHeight}화소`];
  if (criteria.minBitrate !== null) parts.push(`비트레이트 ${criteria.minBitrate}kbps`);
  return `${parts.join(' 또는 ')} 미만`;
}

function formatLowQuality(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [`기준: ${criteriaText(result.criteria)}`];
  for (const file of result.low) lines.push(`저화질: ${relative(file.path)} (${describeLowQuality(file)}) [${file.reasons.join(', ')}]`);
  for (const item of result.unreadable) lines.push(`판단 못함: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`건너뜀: ${relative(item.path)} (${item.reason})`);
  lines.push(`영상 ${result.checked}개 확인, 저화질 ${result.low.length}개, 판단 못함 ${result.unreadable.length}개, 건너뜀 ${result.skipped.length}개`);
  return lines.join('\n');
}

module.exports = { lowQualityCriteria, saneInfo, judgeQuality, findLowQuality, formatLowQuality, describeLowQuality, criteriaText, DEFAULT_MIN_HEIGHT };
