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
// 같은 번호의 다른 조각. 낱말 뒤 숫자(CD1, part 2, disc-3)나 번호 바로 뒤의 숫자·글자 하나(ABC-123-1, ABC-123 B)다.
const PART_WORD = /(?<![A-Za-z0-9])(?:cd|disc|disk|part|pt)[\s._-]*(\d{1,3})(?![0-9])/i;
const PART_AFTER_NUMBER = /^[\s._-]*(?:(\d{1,2})|([A-Za-z]))(?![A-Za-z0-9])/;

// 조각 표시를 같은 값으로 맞춘다. CD1, part 01, -1은 모두 1이다. 글자는 소문자로 둔다.
function findPart(base, ranges) {
  const after = PART_AFTER_NUMBER.exec(base.slice(ranges[0].end));
  if (after) return after[1] !== undefined ? String(Number(after[1])) : after[2].toLowerCase();
  let rest = '';
  let at = 0;
  for (const { start, end } of ranges) {
    rest += `${base.slice(at, start)} `;
    at = end;
  }
  const word = PART_WORD.exec(rest + base.slice(at));
  return word ? String(Number(word[1])) : null;
}

// 번호가 없는 이름의 비교값. 대소문자, 전각, 조합형 한글, 구분 문자의 차이와 복사본 꼬리를 없앤다.
function nameKey(base) {
  let current = halfWidth(base.normalize('NFC')).trim();
  for (let previous = null; previous !== current; ) {
    previous = current;
    current = current.replace(COPY_SUFFIX, '');
  }
  return current.replace(SEPARATORS, ' ').trim().toLowerCase();
}

// 영상 파일 이름 하나의 묶음 기준을 돌려준다. 파일은 건드리지 않는 순수 함수다.
// - 이름에 대문자 제품번호가 하나 있으면 { kind: 'number', key, number, part }. 확장자, 화질 표시, 제목이 달라도 번호와 조각이 같으면 같은 묶음이다.
// - 번호가 없으면 { kind: 'name', key }. 확장자를 뺀 이름을 nameKey로 맞춘 값이다.
// - 서로 다른 번호가 여럿이면 { kind: 'conflict', numbers }. 어느 번호로 묶을지 정하지 않는다.
// 소문자 말(abc-123)은 번호로 보지 않는다. trip-2023처럼 보통 말인 경우가 많아서다. 먼저 normalize로 대문자로 바꾸면 번호로 묶인다.
function duplicateKey(fileName) {
  const base = fileName.slice(0, fileName.length - path.extname(fileName).length);
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
// 저장소 폴더 안은 조용히 뺀다. 영상이 아닌 파일(제거 기록 fctl-removed-*.json 포함)은 보지 않는다.
function findDuplicateNames(dir) {
  const access = grant(dir, ['read']);
  const result = { target: access.target, groups: [], conflicts: [], unreadable: [], skipped: [], checked: 0 };
  const byKey = new Map();
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => REPOSITORY_FOLDER.test(part))) continue;
    const name = path.basename(entry.path);
    const extension = path.extname(name).toLowerCase();
    const transport = TRANSPORT_EXTENSIONS.has(extension);
    if (!VIDEO_EXTENSIONS.has(extension) && !transport) continue;
    if (entry.type === 'link') {
      result.skipped.push({ path: entry.path, reason: '링크는 보지 않습니다.' });
      continue;
    }
    const reason = skipReason(parts);
    if (reason !== null) {
      result.skipped.push({ path: entry.path, reason });
      continue;
    }
    try {
      const real = access.read(entry.path);
      // 영상이 아닌 .ts(TypeScript 소스)는 보고하지 않는다.
      if (transport && !isTransportStream(access.target, entry.relative)) continue;
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
