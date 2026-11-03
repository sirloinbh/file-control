'use strict';

const path = require('node:path');
const { FcError, formatSize } = require('./commands');
const { grant, walk, fileSizeInside } = require('./target');
const { findProductNumberRanges, halfWidth } = require('./product');
const { LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');
const { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS, isTransportStream } = require('./productName');

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

// 타겟 아래 영상 파일을 이름 기준으로 묶어 중복 후보를 찾는다. 파일은 건드리지 않는다.
// - groups: 파일이 둘 이상인 묶음 ({ kind, key, number, part, files }). files는 { path, size } 목록이다.
//   번호 묶음을 먼저, 그 안에서는 기준값 순으로 둔다. 파일은 타겟 안의 경로 순이다.
// - conflicts: 번호가 여럿이라 묶지 않은 파일 ({ path, numbers })
// - unreadable: 크기나 내용을 읽지 못해 묶지 않은 파일 ({ path, reason })
// - skipped: 다루지 않는 항목 ({ path, reason })
// - checked: 살펴본 영상 파일 수
// 링크는 확장자와 관계없이 건너뜀으로 보고한다. 저장소 폴더 안은 조용히 뺀다. 영상이 아닌 파일(제거 기록 fctl-removed-*.json 포함)은 보지 않는다.
function findDuplicateNames(dir) {
  const access = grant(dir, ['read']);
  const result = { target: access.target, groups: [], conflicts: [], unreadable: [], skipped: [], checked: 0 };
  const byKey = new Map();
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
      const found = duplicateKey(name);
      if (found === null) continue;
      if (found.kind === 'conflict') {
        result.conflicts.push({ path: real, numbers: found.numbers });
        continue;
      }
      const size = fileSizeInside(access.target, real);
      const id = `${found.kind}\0${found.key}`;
      if (!byKey.has(id)) byKey.set(id, { kind: found.kind, key: found.key, number: found.number ?? null, part: found.part ?? null, files: [] });
      byKey.get(id).files.push({ path: real, size });
    } catch (err) {
      const message = err instanceof FcError ? err.message : `파일을 읽을 수 없습니다. (${err.code ?? err.message})`;
      result.unreadable.push({ path: entry.path, reason: message });
    }
  }
  const order = (a, b) => (a.kind === b.kind ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.kind === 'number' ? -1 : 1);
  result.groups = [...byKey.values()].filter((group) => group.files.length > 1).sort(order);
  return result;
}

function formatDuplicateNames(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  for (const group of result.groups) {
    const label = group.kind === 'number' ? `번호 ${group.number}${group.part === null ? '' : ` 조각 ${group.part}`}` : `이름 "${group.key}"`;
    lines.push(`중복 후보 (${label}, ${group.files.length}개):`);
    for (const file of group.files) lines.push(`  ${relative(file.path)} (${formatSize(file.size)})`);
  }
  for (const item of result.conflicts) lines.push(`번호가 여럿: ${relative(item.path)} (${item.numbers.join(', ')})`);
  for (const item of result.unreadable) lines.push(`판단 못함: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`건너뜀: ${relative(item.path)} (${item.reason})`);
  const files = result.groups.reduce((sum, group) => sum + group.files.length, 0);
  lines.push(
    `살펴본 영상 ${result.checked}개, 중복 후보 묶음 ${result.groups.length}개(파일 ${files}개), 번호가 여럿 ${result.conflicts.length}개, 판단 못함 ${result.unreadable.length}개, 건너뜀 ${result.skipped.length}개`,
  );
  return lines.join('\n');
}

module.exports = { duplicateKey, findDuplicateNames, formatDuplicateNames };
