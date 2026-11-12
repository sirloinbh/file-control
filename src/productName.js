'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk, readRange } = require('./target');
const { readMp4Metadata } = require('./mp4');
const { readMkvMetadata } = require('./mkv');
const { extractProductNumbers, findProductNumber, findAttachedProductNumbers, halfWidth } = require('./product');
const { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER, moveWithoutOverwrite, leftoverNote } = require('./flatten');

// 영상 파일만 다룬다. ABC-123 폴더 안의 자막이나 메모까지 이름을 바꾸지 않는다.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.m2ts', '.mpg', '.mpeg']);
// TypeScript 소스와 확장자가 같은 형식. 내용을 확인한 뒤에만 영상으로 본다.
const TRANSPORT_EXTENSIONS = new Set(['.ts', '.mts']);
// MPEG-TS는 188바이트마다, AVCHD는 앞에 4바이트씩 붙어 192바이트마다 0x47로 시작한다.
const TRANSPORT_LAYOUTS = [
  [0, 188],
  [4, 192],
];
const TRANSPORT_HEAD = 4 + 2 * 192 + 1;

function isTransportStream(target, relative) {
  const head = readRange(target, relative, { length: TRANSPORT_HEAD });
  return TRANSPORT_LAYOUTS.some(([start, step]) => head[start] === 0x47 && head[start + step] === 0x47 && head[start + 2 * step] === 0x47);
}
// 메타데이터를 읽을 수 있는 형식. 나머지는 파일명과 폴더명에서만 찾는다.
const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);
const MKV_EXTENSIONS = new Set(['.mkv', '.webm']);

// 메타데이터를 읽지 못해도 파일명과 폴더명으로 계속 찾는다. 사유는 찾지 못했을 때 함께 보고한다.
function readTags(target, entry, ext) {
  const reader = MP4_EXTENSIONS.has(ext) ? readMp4Metadata : MKV_EXTENSIONS.has(ext) ? readMkvMetadata : null;
  if (!reader) return {};
  try {
    return reader(target, entry.relative);
  } catch (err) {
    if (!(err instanceof FcError)) throw err;
    return { metadataError: err.message };
  }
}

// 번호에 글자가 붙어 있어도(ABC-123-01, ABC-123A, 1ABC-123) 이미 든 것으로 본다. ABC-1234는 ABC-123이 아니다.
function containsNumber(name, number) {
  // number는 영문 대문자, 하이픈, 숫자뿐이라 그대로 정규식에 넣어도 된다.
  return new RegExp(`(?<!\\p{Script=Latin}\\p{M}*)${number}(?!\\d)`, 'u').test(halfWidth(name).toUpperCase());
}

// 이름에 번호를 하이픈 없이 적었는지 본다(ABC123, ABC_123, ABC 123, abc123). 앞에 라틴 문자가 붙거나 뒤에 숫자가 이어지면 다른 말이다.
function containsUnhyphenatedNumber(name, number) {
  const [letters, digits] = number.split('-');
  return new RegExp(`(?<!\\p{Script=Latin}\\p{M}*)${letters}[_ ]?${digits}(?!\\d)`, 'u').test(halfWidth(name).toUpperCase());
}

// 제목과 폴더의 번호가 엇갈리면 어느 쪽이 맞는지 알 수 없다. 코멘트는 다른 글을 담을 수 있어 제목이나 폴더에 번호가 있으면 판단에 넣지 않는다.
function chooseNumber(found) {
  const trusted = found.candidates.filter((candidate) => candidate.source !== 'comment');
  const list = trusted.length > 0 ? trusted : found.candidates;
  return list.length === 1 ? list[0] : null;
}

// 타겟 아래 영상 파일의 이름에 제품번호를 넣는 계획을 만든다. 파일은 건드리지 않는다.
// - renames: 바꿀 파일 ({ from, to, name, number, source, note })
// - already: 이름에 이미 번호가 있어 그대로 두는 파일 ({ path, number })
//   파일명의 소문자 말(abc-123, trip-2023)은 번호인지 확실하지 않다. 다른 곳에 번호가 없거나 같을 때만 번호로 보고, 다르면 conflicts에 넣는다.
// - notFound: 번호를 찾지 못한 파일 ({ path, note }). note는 메타데이터를 읽지 못한 사유이고 없으면 null이다.
// - conflicts: 찾은 번호가 엇갈려 고르지 않은 파일 ({ path, numbers, note })
//   renames와 conflicts의 note도 메타데이터를 읽지 못한 사유다. 폴더 번호로 바꿔도 제목에 다른 번호가 있었는지 모르므로 알린다(#90).
// - skipped: 다루지 않는 항목 ({ path, reason })
//   읽지 못한 하위 폴더도 여기에 넣고 나머지 파일은 계속 본다. 파일마다 따로 바꾸므로 일부 폴더를 못 봐도 다른 파일에 영향이 없다(#74).
function planProductNames(dir) {
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, renames: [], already: [], notFound: [], conflicts: [], skipped: [] };
  const unreadable = [];
  const entries = walk(access.target, { unreadable });
  for (const folder of unreadable) plan.skipped.push({ path: folder.path, reason: folder.reason });
  for (const entry of entries) {
    if (entry.type === 'dir') continue;
    const skip = (reason) => plan.skipped.push({ path: entry.path, reason });
    // 폴더를 가리키는 링크는 확장자가 없어도 그 안을 보지 않았음을 알린다.
    if (entry.type === 'link') {
      skip('Links are not renamed.');
      continue;
    }
    const name = path.basename(entry.path);
    const { name: base, ext } = path.parse(name);
    const extension = ext.toLowerCase();
    const transport = TRANSPORT_EXTENSIONS.has(extension);
    if (!VIDEO_EXTENSIONS.has(extension) && !transport) continue;
    const parts = entry.relative.split(path.sep);
    try {
      const from = access.read(entry.path);
      // 영상이 아닌 .ts는 어디에 있든 보고하지 않는다. 그래서 건너뛸지 보기 전에 내용을 확인한다.
      if (transport && !isTransportStream(access.target, entry.relative)) continue;
      if (parts.some((part) => LEFTOVER.test(part))) throw new FcError('Not renamed because it is a leftover from an earlier job.');
      if (parts.some((part) => SYSTEM_FOLDER.test(part))) throw new FcError('Not renamed because it is inside a Windows system folder.');
      if (parts.some((part) => REPOSITORY_FOLDER.test(part))) throw new FcError('Not renamed because it is inside a repository folder.');
      if (name.startsWith('.')) throw new FcError('Not renamed because adding the number in front of a name that starts with a dot would make it no longer a hidden name.');
      const inName = extractProductNumbers(name);
      if (inName.length > 0) {
        // 예전 방식의 이동이 중간에 멈추면 번호가 든 이름의 빈 파일이 남았다(#73). 이미 바꾼 영상으로 세지 않고 따로 알린다.
        if (fs.lstatSync(from).size === 0) throw new FcError('The file is empty. It may be a placeholder left when an earlier run stopped midway; check it and delete it.');
        plan.already.push({ path: entry.path, number: inName[0] });
        continue;
      }
      const lowerInName = extractProductNumbers(name, { lowercase: true });
      const { title, comment, metadataError } = readTags(access.target, entry, extension);
      // 파일명은 위에서 봤다. 타겟 자신과 그 위의 폴더 이름은 쓰지 않는다.
      const found = findProductNumber({ title, comment, folders: parts.slice(0, -1).reverse() });
      if (!found) {
        if (lowerInName.length > 0) plan.already.push({ path: entry.path, number: lowerInName[0] });
        else plan.notFound.push({ path: entry.path, note: metadataError ?? null });
        continue;
      }
      const chosen = chooseNumber(found);
      const numbers = found.candidates.map((candidate) => candidate.number);
      if (!chosen) {
        plan.conflicts.push({ path: entry.path, numbers: [...new Set([...lowerInName, ...numbers])], note: metadataError ?? null });
        continue;
      }
      // 하이픈 없이 적은 같은 번호(ABC123, ABC_123, ABC 123)도 이미 있는 것으로 본다(#75).
      if (containsNumber(name, chosen.number) || containsUnhyphenatedNumber(name, chosen.number)) {
        plan.already.push({ path: entry.path, number: chosen.number });
        continue;
      }
      // 글자가 붙어 번호 규칙에 걸리지 않은 다른 번호(ABC-123-01, ABC-123A, 1ABC-123)가 있으면 앞에 번호를 더 넣지 않고 엇갈림으로 알린다(#75).
      const attached = findAttachedProductNumbers(name).filter((number) => number !== chosen.number);
      if (lowerInName.length > 0 || attached.length > 0) {
        plan.conflicts.push({ path: entry.path, numbers: [...new Set([...lowerInName, ...attached, chosen.number])], note: metadataError ?? null });
        continue;
      }
      // 파일 안의 글은 쓰지 않고 형식을 통과한 번호만 이름에 넣으므로 제목의 경로·제어 문자가 이름에 들어오지 않는다.
      const desired = `${chosen.number} ${base}${ext}`;
      if (desired.length > MAX_NAME) throw new FcError(`The name is too long once the number is added: ${desired}`);
      const to = path.join(path.dirname(from), desired);
      if (fs.lstatSync(to, { throwIfNoEntry: false })) throw new FcError(`Not renamed because the name already exists: ${desired}${leftoverNote(from, to)}`);
      plan.renames.push({ from, to: access.write(to), name: desired, number: chosen.number, source: chosen.source, note: metadataError ?? null });
    } catch (err) {
      if (err instanceof FcError) skip(err.message);
      else if (err.syscall) skip(`Cannot check the file. (${err.code})`);
      else throw err;
    }
  }
  return plan;
}

// 계획과 실행 사이에 원본이 링크로 바뀌었거나 이름이 찼으면 바꾸지 않는다. 덮어쓰지 않고, 번호를 붙여 피하지도 않는다.
function applyRename(rename, access) {
  const from = access.delete(rename.from);
  if (from !== rename.from) throw new FcError(`The path changed after planning: ${rename.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`No longer a file after planning: ${from}`);
  // 이미 있는 항목에는 손대지 않는다. 끊어진 정션에 wx로 열면 정션이 가리키는 타겟 밖에 폴더가 생긴다.
  const taken = () => new FcError(`Not renamed because the name already exists: ${rename.name}${leftoverNote(from, rename.to)}`);
  if (fs.lstatSync(rename.to, { throwIfNoEntry: false })) throw taken();
  const to = access.write(rename.to);
  if (to !== rename.to) throw new FcError(`The path changed after planning: ${rename.to} -> ${to}`);
  if (!moveWithoutOverwrite(from, to)) throw taken();
}

// 타겟 아래 영상 파일의 이름 앞에 제품번호를 넣는다. 덮어쓰지 않고, 한 파일이 실패해도 나머지는 계속한다.
// 돌려주는 값: { target, dryRun, renamed, already, notFound, conflicts, skipped, failed }. failed는 { from, reason } 목록이다.
function addProductNumbers(dir, { dryRun = false } = {}) {
  return applyProductNames(planProductNames(dir), { dryRun });
}

function applyProductNames(plan, { dryRun = false } = {}) {
  const { renames, target, ...rest } = plan;
  const result = { target, dryRun, renamed: [], ...rest, failed: [] };
  if (dryRun) return { ...result, renamed: renames };
  const access = grant(target, ['write', 'delete']);
  for (const rename of renames) {
    try {
      applyRename(rename, access);
      result.renamed.push(rename);
    } catch (err) {
      result.failed.push({ from: rename.from, reason: err instanceof FcError ? err.message : `Could not rename. (${err.code})` });
    }
  }
  return result;
}

const SOURCE_NAMES = { title: 'title', comment: 'comment', folder: 'folder name' };

function formatProductNumbers(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [];
  for (const item of result.renamed) lines.push(`${prefix}Rename: ${relative(item.from)} -> ${item.name} (${SOURCE_NAMES[item.source]}${item.note ? `, could not read metadata: ${item.note}` : ''})`);
  for (const item of result.already) lines.push(`${prefix}Already present: ${relative(item.path)} (${item.number})`);
  for (const item of result.notFound) lines.push(`${prefix}Not found: ${relative(item.path)}${item.note ? ` (${item.note})` : ''}`);
  for (const item of result.conflicts) lines.push(`${prefix}Numbers disagree: ${relative(item.path)} (${item.numbers.join(', ')}${item.note ? `, could not read metadata: ${item.note}` : ''})`);
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.from)} (${item.reason})`);
  lines.push(
    `${prefix}Rename ${result.renamed.length}, already present ${result.already.length}, not found ${result.notFound.length}, disagree ${result.conflicts.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`,
  );
  return lines.join('\n');
}

module.exports = { planProductNames, applyProductNames, addProductNumbers, formatProductNumbers, containsNumber, isTransportStream, VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS };
