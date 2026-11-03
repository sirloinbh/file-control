'use strict';

const path = require('node:path');
const { FcError, formatSize } = require('./commands');
const { grant, walk, fileSizeInside, compareRelative } = require('./target');
const { findProductNumberRanges, halfWidth } = require('./product');
const { LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');
const { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS, isTransportStream } = require('./productName');
const { readMp4Metadata } = require('./mp4');
const { readMkvMetadata } = require('./mkv');

// 길이 기준으로 묶는 조건. 다른 영상을 한 묶음에 넣지 않도록 좁게 잡는다.
// - 길이 차이가 1초 이내. 같은 영상을 다른 형식으로 옮기면 길이가 1초 안쪽으로 달라진다.
// - 화면 비율을 소수 첫째 자리까지 맞춘다(16:9는 1.8, 4:3은 1.3). 저장된 해상도로 계산하고 회전 정보와 화소 비율은 보지 않는다.
//   그래서 세로로 저장한 영상(1080x1920)과 가로 영상은 묶지 않지만, 회전 정보로 세로를 표시하는 휴대폰 영상(1920x1080 + 90도)은 가로로 센다(#106).
// - 60초 미만 영상은 묶지 않는다. 짧은 클립은 길이가 우연히 같은 경우가 많다.
// 해상도와 크기는 보지 않는다. 다시 인코딩한 같은 영상은 이 둘이 달라지고, 어느 것을 남길지는 묶은 뒤에 고른다.
const DURATION_TOLERANCE = 1;
const MIN_DURATION = 60;
const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);
const MKV_EXTENSIONS = new Set(['.mkv', '.webm']);

const SEPARATORS = /[\s._\-–—－＿\u0085]+/g;
// 탐색기가 붙이는 복사본 꼬리. 이름 - 복사본.mp4, 이름 - Copy (2).mp4
const COPY_SUFFIX = /\s+-\s+(?:복사본|copy)(?:\s*\(\d+\))?$/i;
// 같은 번호의 다른 조각을 가르는 표시. 다른 영상을 한 묶음에 넣는 것보다 중복을 놓치는 쪽이 안전하므로 넓게 잡는다.
// 번호를 뺀 나머지를 낱말로 나눠 본다. 화질·코덱 표시와 끝의 (1)·복사본 꼬리는 뺀다.
// - 낱말 속의 숫자(CD2, part 1, -1, [2], 제목3, 1.5)와 원문자 숫자(①)
// - 영문 한 글자 낱말(ABC-123 B, (A), [A], Title A)
// - 로마 숫자(II, xiv, Ⅲ)는 숫자로 바꾼다. 한 글자(I, V, X)는 영문 한 글자로 본다.
// - 前編·後編, 上巻·下巻, 상·하편, 第一話 같은 말
const TOKEN_SEPARATORS = /[\s._\-–—＿\u0085[\](){}【】「」『』《》〈〉〔〕〖〗,+&~!#'"]+/;
const QUALITY = /^(?:\d{3,4}[pi]|\d+fps|\d+bit|\d+k|[xh]26[45]|\d+ch|aac\d*|ac3|dts|ddp?\d*|mp[34]|h?vc1|av1|vp[89]|\d+kbps|\d+mbps)$/i;
const ROMAN = /^(?=[ivxlc]{2,}$)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100 };
const SECTION = /^(?:[前中後]編|[上中下]巻?|[前後]半|[상중하]편?|[전후]편)$/;
const KANJI_NUMBER = /^第?[一二三四五六七八九十百]+[話话巻卷部章回]?$/;
// 원문자 숫자 ①~⑳, 로마 숫자 글자 Ⅰ~Ⅻ, ⅰ~ⅻ를 숫자로 바꾼다.
const NUMBER_SYMBOLS = /[\u2460-\u2473\u2160-\u216b\u2170-\u217b]/g;
const symbolValue = (ch) => {
  const code = ch.charCodeAt(0);
  if (code >= 0x2460 && code <= 0x2473) return code - 0x2460 + 1;
  return code >= 0x2170 ? code - 0x2170 + 1 : code - 0x2160 + 1;
};

function romanValue(token) {
  const values = [...token.toLowerCase()].map((ch) => ROMAN_VALUES[ch]);
  return values.reduce((sum, value, index) => sum + (value < (values[index + 1] ?? 0) ? -value : value), 0);
}

const DUPLICATE_TAIL = /\s*\(\d+\)$/;

// 꼬리를 되풀이해 지운다. 이름 - 복사본 (2), 이름 (1) - 복사본
function stripTails(text, tails) {
  let current = text.trim();
  for (let previous = null; previous !== current; ) {
    previous = current;
    for (const tail of tails) current = current.replace(tail, '').trim();
  }
  return current;
}

// 조각 표시를 나온 순서대로 이어 돌려준다. 숫자는 앞의 0을 뺀다. CD1, part 01, -1은 모두 1이다. 없으면 null이다.
// 전각을 반각으로 바꿔도 글자 수가 같으므로 번호 위치를 그대로 쓴다.
function findPart(original, ranges) {
  const base = halfWidth(original);
  const marks = [];
  let rest = '';
  let at = 0;
  for (const { start, end } of ranges) {
    rest += `${base.slice(at, start)} `;
    at = end;
  }
  rest = stripTails(rest + base.slice(at), [COPY_SUFFIX, DUPLICATE_TAIL]).replace(NUMBER_SYMBOLS, (ch) => ` ${symbolValue(ch)} `);
  for (const token of rest.split(TOKEN_SEPARATORS)) {
    if (token === '' || QUALITY.test(token)) continue;
    if (/^[A-Za-z]$/.test(token)) marks.push(token.toLowerCase());
    else if (ROMAN.test(token)) marks.push(String(romanValue(token)));
    else if (SECTION.test(token) || KANJI_NUMBER.test(token)) marks.push(token);
    else for (const digits of token.match(/\d+/g) ?? []) marks.push(String(Number(digits)));
  }
  return marks.length === 0 ? null : marks.join(' ');
}

// 번호가 없는 이름의 비교값. 대소문자, 전각, 조합형 한글, 구분 문자의 차이와 복사본 꼬리를 없앤다.
function nameKey(base) {
  return stripTails(halfWidth(base), [COPY_SUFFIX]).replace(SEPARATORS, ' ').trim().toLowerCase();
}

// 영상 파일 이름 하나의 묶음 기준을 돌려준다. 파일은 건드리지 않는 순수 함수다.
// - 이름에 대문자 제품번호가 하나 있으면 { kind: 'number', key, number, part }. 확장자, 화질 표시, 제목이 달라도 번호와 조각이 같으면 같은 묶음이다.
// - 번호가 없으면 { kind: 'name', key }. 확장자를 뺀 이름을 nameKey로 맞춘 값이다.
// - 서로 다른 번호가 여럿이면 { kind: 'conflict', numbers }. 어느 번호로 묶을지 정하지 않는다.
// 소문자 말(abc-123)은 번호로 보지 않는다. trip-2023처럼 보통 말인 경우가 많아서다. 먼저 normalize로 대문자로 바꾸면 번호로 묶인다.
function duplicateKey(fileName) {
  // 조합형 한글(macOS에서 온 이름)을 먼저 완성형으로 맞춘다. 번호 위치도 맞춘 이름 기준이다.
  const base = fileName.slice(0, fileName.length - path.extname(fileName).length).normalize('NFC');
  const ranges = findProductNumberRanges(base);
  const numbers = [...new Set(ranges.map((range) => range.number))];
  if (numbers.length > 1) return { kind: 'conflict', numbers };
  if (numbers.length === 1) {
    const [number] = numbers;
    const part = findPart(base, ranges);
    return { kind: 'number', key: part === null ? number : `${number} #${part}`, number, part };
  }
  const key = nameKey(base);
  return key === '' ? null : { kind: 'name', key };
}

function skipReason(parts) {
  if (parts.some((part) => LEFTOVER.test(part))) return '이전 작업의 잔여물이라 보지 않습니다.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Windows 시스템 폴더 안의 파일이라 보지 않습니다.';
  return null;
}

// 길이와 해상도를 읽는다. 읽을 수 있는 형식은 MP4/MOV와 MKV/WebM이다. 모르면 null이고, 읽지 못한 사유는 note에 둔다.
// 영상 데이터는 읽지 않고 머리 구조만 본다.
function readVideoInfo(target, real) {
  const extension = path.extname(real).toLowerCase();
  const reader = MP4_EXTENSIONS.has(extension) ? readMp4Metadata : MKV_EXTENSIONS.has(extension) ? readMkvMetadata : null;
  const unknown = (note) => ({ duration: null, width: null, height: null, note });
  if (!reader) return unknown(null);
  try {
    const { duration, width, height } = reader(target, real);
    const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);
    const info = { duration: positive(duration), width: positive(width), height: positive(height) };
    // 예외 없이 값이 빠진 경우도 사유를 남긴다. 길이를 쓰지 않는 조각 MP4, 녹화가 중단된 MKV/WebM이 그렇다.
    const missing = [info.duration === null && '길이', (info.width === null || info.height === null) && '해상도'].filter(Boolean);
    return { ...info, note: missing.length === 0 ? null : `${missing.join('와 ')} 정보가 없습니다.` };
  } catch (err) {
    if (err instanceof FcError) return unknown(err.message);
    return unknown(`메타데이터를 읽을 수 없습니다. (${err.code ?? err.message})`);
  }
}

// 화면 비율을 소수 첫째 자리까지 맞춘 값. 해상도를 모르면 null이다.
function aspectKey(file) {
  return file.width === null || file.height === null ? null : (Math.round((file.width / file.height) * 10) / 10).toFixed(1);
}

// 파일 목록을 길이와 화면 비율로 묶는다. 파일은 { duration, width, height, ... }이고, 둘 이상인 묶음만 돌려준다. 순수 함수다.
// 길이 순으로 놓고, 묶음의 가장 짧은 파일과 1초 이내인 파일까지 넣는다. 그래서 묶음 안의 어느 두 파일도 1초 넘게 차이 나지 않는다.
// 길이를 모르거나 60초 미만이거나 해상도를 모르는 파일은 묶지 않는다.
function groupByMetadata(files) {
  const buckets = new Map();
  for (const file of files) {
    const aspect = aspectKey(file);
    if (file.duration === null || file.duration < MIN_DURATION || aspect === null) continue;
    if (!buckets.has(aspect)) buckets.set(aspect, []);
    buckets.get(aspect).push(file);
  }
  const groups = [];
  for (const [aspect, list] of buckets) {
    list.sort((a, b) => a.duration - b.duration);
    let current = null;
    for (const file of list) {
      if (current && file.duration - current.files[0].duration <= DURATION_TOLERANCE) current.files.push(file);
      else groups.push((current = { aspect, files: [file] }));
    }
  }
  return groups
    .filter((group) => group.files.length > 1)
    .map((group) => ({ ...group, duration: group.files[0].duration, sameSize: group.files.every((file) => file.size === group.files[0].size) }))
    .sort((a, b) => a.duration - b.duration || (a.aspect < b.aspect ? -1 : 1));
}

// 묶음에서 남길 파일을 하나 고른다. files는 { path, size, duration, width, height, note }이고 파일은 건드리지 않는 순수 함수다.
// 아래 기준을 차례로 적용한다. 기준마다 가장 나은 파일들만 다음 기준으로 넘긴다.
// 1. 읽을 수 있는 형식(.mp4, .mkv 등)인데 길이나 해상도를 읽지 못한 파일(note가 있는 파일)은 깨졌을 수 있어 뒤로 뺀다.
//    읽지 않는 형식(.avi 등)은 깨졌는지 모르므로 빼지 않는다.
// 2. 1에서 남은 파일 중 길이를 아는 가장 긴 파일보다 1초 넘게 짧은 파일은 덜 받았거나 잘린 사본일 수 있어 뒤로 뺀다. 길이를 모르는 파일은 빼지 않는다.
// 3. 해상도(가로×세로 화소 수)가 가장 높은 파일. 해상도를 모르는 파일은 아는 파일보다 뒤다.
// 4. 크기가 가장 큰 파일. 해상도가 같으면 더 많은 데이터를 담은 쪽이 화질이 나은 경우가 많다.
// 5. 이름(확장자 포함)이 가장 짧은 파일. 복사본 꼬리(` - 복사본`, ` (1)`, ` copy`)가 붙은 쪽보다 원래 파일일 가능성이 크다.
// 6. 그래도 같으면 경로 순으로 첫 파일. 이름 묶음의 보고 순서와 같게 대소문자를 먼저 무시하고 비교한다.
// 돌려주는 값은 { path, reason, doubt }다. reason은 고른 까닭이고, doubt는 길이를 아는 파일끼리 1초 넘게 달라 같은 영상이 아닐 수 있을 때의 알림이다(없으면 null).
// 파일이 하나도 없으면 null이다. 하나뿐이면 그 파일을 고르고 reason은 '파일이 하나뿐'이다.
function chooseKeeper(files) {
  if (files.length === 0) return null;
  const durations = files.map((file) => file.duration).filter((value) => value !== null);
  // 기준은 남은 후보를 받아 점수 함수를 돌려준다. 길이 기준은 1에서 빠진 파일의 길이를 보지 않도록 남은 후보로 가장 긴 길이를 잰다.
  const criteria = [
    ['길이나 해상도를 읽지 못한 파일을 뺌', () => (file) => (file.note === null ? 1 : 0)],
    [
      '길이가 가장 김',
      (candidates) => {
        const known = candidates.map((file) => file.duration).filter((value) => value !== null);
        const longest = known.length === 0 ? null : Math.max(...known);
        return (file) => (file.duration !== null && longest - file.duration > DURATION_TOLERANCE ? 0 : 1);
      },
    ],
    ['해상도가 가장 높음', () => (file) => (file.width === null || file.height === null ? -1 : file.width * file.height)],
    ['크기가 가장 큼', () => (file) => file.size],
    ['이름이 가장 짧음', () => (file) => -path.basename(file.path).length],
  ];
  let candidates = [...files].sort((a, b) => compareRelative(a.path, b.path));
  const reasons = [];
  for (const [reason, makeScore] of criteria) {
    const score = makeScore(candidates);
    const best = Math.max(...candidates.map(score));
    const kept = candidates.filter((file) => score(file) === best);
    if (kept.length < candidates.length) reasons.push(reason);
    candidates = kept;
  }
  if (files.length === 1) reasons.push('파일이 하나뿐');
  else if (candidates.length > 1) reasons.push(reasons.length === 0 ? '모두 같아 경로 순으로 첫 파일' : '나머지는 같아 경로 순으로 첫 파일');
  const doubt = durations.length > 1 && Math.max(...durations) - Math.min(...durations) > DURATION_TOLERANCE ? '길이가 서로 달라 같은 영상이 아닐 수 있습니다.' : null;
  return { path: candidates[0].path, reason: reasons.join(', '), doubt };
}

// 타겟 아래 영상 파일을 이름 기준과 길이 기준으로 묶어 중복 후보를 찾는다. 파일은 건드리지 않는다.
// 묶음마다 남길 파일(keep: chooseKeeper의 결과)을 붙인다. 이름 묶음과 길이 묶음은 따로 고르므로, 두 묶음에 함께 든 파일은 한쪽에서는 남기고 다른 쪽에서는 남기지 않을 수 있다.
// - groups: 이름이 같은 묶음 ({ kind, key, number, part, files }). 파일이 둘 이상인 것만 넣는다.
//   번호 묶음을 먼저, 그 안에서는 기준값 순으로 둔다. 파일은 타겟 안의 경로 순이다.
// - metadataGroups: 길이와 화면 비율이 같은 묶음 ({ aspect, duration, sameSize, alsoNamed, files }). groupByMetadata를 보라.
//   alsoNamed는 파일이 모두 한 이름 묶음에 이미 든 묶음이다. 파일은 길이 순이다.
//   files의 항목은 { path, size, duration, width, height, note }다. 모르는 값은 null이고, note는 메타데이터를 읽지 못한 사유다.
// - unknownMetadata: 길이를 모르는 영상 수. 읽지 못하는 형식(avi, wmv 등)과 읽지 못한 파일이 든다.
// - metadataErrors: 읽을 수 있는 형식인데 길이나 해상도를 읽지 못한 파일 ({ path, reason })
// - conflicts: 번호가 여럿이라 이름으로 묶지 않은 파일 ({ path, numbers }). 길이로는 묶을 수 있다.
// - unreadable: 크기나 내용을 읽지 못해 묶지 않은 파일 ({ path, reason })
// - skipped: 다루지 않는 항목 ({ path, reason })
// - checked: 살펴본 영상 파일 수
// 링크는 확장자와 관계없이 건너뜀으로 보고한다. 저장소 폴더 안은 조용히 뺀다. 영상이 아닌 파일(제거 기록 fctl-removed-*.json 포함)은 보지 않는다.
function findDuplicateNames(dir) {
  const access = grant(dir, ['read']);
  const result = { target: access.target, groups: [], metadataGroups: [], unknownMetadata: 0, metadataErrors: [], conflicts: [], unreadable: [], skipped: [], checked: 0 };
  const byKey = new Map();
  const videos = [];
  const nameGroupOf = new Map();
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => REPOSITORY_FOLDER.test(part))) continue;
    // 폴더를 가리키는 링크도 확장자와 관계없이 그 안을 보지 않았음을 알린다.
    if (entry.type === 'link') {
      result.skipped.push({ path: entry.path, reason: '링크는 보지 않습니다.' });
      continue;
    }
    const name = path.basename(entry.path);
    const extension = path.extname(name).toLowerCase();
    const transport = TRANSPORT_EXTENSIONS.has(extension);
    if (!VIDEO_EXTENSIONS.has(extension) && !transport) continue;
    try {
      // 영상이 아닌 .ts(TypeScript 소스)는 어디에 있든 보고하지 않는다. 그래서 건너뛸지 보기 전에 내용을 확인한다.
      if (transport && !isTransportStream(access.target, entry.relative)) continue;
      const reason = skipReason(parts);
      if (reason !== null) {
        result.skipped.push({ path: entry.path, reason });
        continue;
      }
      const real = access.read(entry.path);
      result.checked += 1;
      const size = fileSizeInside(access.target, real);
      const file = { path: real, size, ...readVideoInfo(access.target, real) };
      videos.push(file);
      if (file.duration === null) result.unknownMetadata += 1;
      const found = duplicateKey(name);
      if (found === null) continue;
      if (found.kind === 'conflict') {
        result.conflicts.push({ path: real, numbers: found.numbers });
        continue;
      }
      const id = `${found.kind}\0${found.key}`;
      if (!byKey.has(id)) byKey.set(id, { kind: found.kind, key: found.key, number: found.number ?? null, part: found.part ?? null, files: [] });
      byKey.get(id).files.push(file);
      nameGroupOf.set(file, id);
    } catch (err) {
      const message = err instanceof FcError ? err.message : `파일을 읽을 수 없습니다. (${err.code ?? err.message})`;
      result.unreadable.push({ path: entry.path, reason: message });
    }
  }
  const order = (a, b) => (a.kind === b.kind ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.kind === 'number' ? -1 : 1);
  result.groups = [...byKey.values()]
    .filter((group) => group.files.length > 1)
    .sort(order)
    .map((group) => ({ ...group, keep: chooseKeeper(group.files) }));
  // 파일이 모두 한 이름 묶음에 든 길이 묶음은 alsoNamed로 표시한다. 보고에서는 되풀이하지 않지만, 이름과 길이가 함께 맞는다는 정보는 남긴다.
  // 하나뿐이라 이름 묶음에 나오지 않는 파일은 이름 묶음에 든 것으로 보지 않는다.
  const shown = (file) => (byKey.get(nameGroupOf.get(file))?.files.length ?? 0) > 1;
  const sameNameGroup = (group) => group.files.every((file) => shown(file) && nameGroupOf.get(file) === nameGroupOf.get(group.files[0]));
  result.metadataGroups = groupByMetadata(videos).map((group) => ({ ...group, alsoNamed: sameNameGroup(group), keep: chooseKeeper(group.files) }));
  result.metadataErrors = videos.filter((file) => file.note !== null).map((file) => ({ path: file.path, reason: file.note }));
  return result;
}

// 초를 h:mm:ss 또는 m:ss로 쓴다.
function formatDuration(seconds) {
  const total = Math.round(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (value) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function describe(file) {
  const parts = [formatSize(file.size)];
  if (file.width !== null && file.height !== null) parts.push(`${file.width}x${file.height}`);
  if (file.duration !== null) parts.push(formatDuration(file.duration));
  return parts.join(', ');
}

function formatDuplicateNames(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  // 묶음의 파일 줄. 남길 파일에는 고른 까닭을 붙이고, 같은 영상이 아닐 수 있으면 주의 줄을 덧붙인다.
  const pushFiles = (group) => {
    for (const file of group.files) {
      const keep = file.path === group.keep.path ? ` [남김: ${group.keep.reason}]` : '';
      lines.push(`  ${relative(file.path)} (${describe(file)})${keep}`);
    }
    if (group.keep.doubt !== null) lines.push(`  주의: ${group.keep.doubt}`);
  };
  for (const group of result.groups) {
    const label = group.kind === 'number' ? `번호 ${group.number}${group.part === null ? '' : ` 조각 ${group.part}`}` : `이름 "${group.key}"`;
    lines.push(`중복 후보 (${label}, ${group.files.length}개):`);
    pushFiles(group);
  }
  const metadataGroups = result.metadataGroups.filter((group) => !group.alsoNamed);
  for (const group of metadataGroups) {
    const same = group.sameSize ? ', 크기도 같음' : '';
    lines.push(`길이가 같은 영상 (${formatDuration(group.duration)}, 화면 비율 ${group.aspect}${same}, ${group.files.length}개):`);
    pushFiles(group);
  }
  for (const item of result.conflicts) lines.push(`번호가 여럿: ${relative(item.path)} (${item.numbers.join(', ')})`);
  for (const item of result.metadataErrors) lines.push(`길이·해상도 못 읽음: ${relative(item.path)} (${item.reason})`);
  for (const item of result.unreadable) lines.push(`판단 못함: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`건너뜀: ${relative(item.path)} (${item.reason})`);
  const files = result.groups.reduce((sum, group) => sum + group.files.length, 0);
  const metadataFiles = metadataGroups.reduce((sum, group) => sum + group.files.length, 0);
  lines.push(
    `살펴본 영상 ${result.checked}개, 중복 후보 묶음 ${result.groups.length}개(파일 ${files}개), 길이가 같은 묶음 ${metadataGroups.length}개(파일 ${metadataFiles}개), 길이 모름 ${result.unknownMetadata}개, 번호가 여럿 ${result.conflicts.length}개, 판단 못함 ${result.unreadable.length}개, 건너뜀 ${result.skipped.length}개`,
  );
  return lines.join('\n');
}

module.exports = { duplicateKey, groupByMetadata, chooseKeeper, findDuplicateNames, formatDuplicateNames, DURATION_TOLERANCE, MIN_DURATION };
