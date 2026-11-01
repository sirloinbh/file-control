'use strict';

const path = require('node:path');
const zlib = require('node:zlib');
const { FcError, archiveEntries } = require('./commands');
const { grant, walk, readRange, fileSizeInside } = require('./target');
const { LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');
const { REMOVAL_LOG } = require('./removalLog');
const { checkMp4Structure, FIRST_BOXES } = require('./mp4');
const { checkMkvStructure } = require('./mkv');

const HEAD_SIZE = 1024;
const starts = (head, ...bytes) => head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte);
const text = (head, from, to) => head.toString('latin1', from, to);
const riff = (form) => (head) => text(head, 0, 4) === 'RIFF' && text(head, 8, 12) === form;

// 확장자와 앞 바이트가 정해진 형식. 앞 바이트가 느슨한 형식(mp3, mpg, ts)과 머리글이 없는 옛 tar는 넣지 않는다. 멀쩡한 파일을 깨졌다고 하지 않기 위해서다.
const FORMATS = [
  { name: 'MP4/MOV', extensions: ['mp4', 'm4v', 'm4a', 'mov', '3gp', '3g2'], match: (head) => FIRST_BOXES.has(text(head, 4, 8)) },
  { name: 'MKV/WebM', extensions: ['mkv', 'mka', 'webm'], match: (head) => starts(head, 0x1a, 0x45, 0xdf, 0xa3) },
  { name: 'AVI', extensions: ['avi'], match: riff('AVI ') },
  { name: 'WAV', extensions: ['wav'], match: (head) => riff('WAVE')(head) || text(head, 0, 4) === 'RF64' },
  { name: 'WebP', extensions: ['webp'], match: riff('WEBP') },
  { name: 'WMV/ASF', extensions: ['wmv', 'wma', 'asf'], match: (head) => starts(head, 0x30, 0x26, 0xb2, 0x75) },
  { name: 'FLV', extensions: ['flv'], match: (head) => text(head, 0, 3) === 'FLV' },
  { name: 'FLAC', extensions: ['flac'], match: (head) => text(head, 0, 4) === 'fLaC' },
  { name: 'Ogg', extensions: ['ogg', 'oga', 'ogv', 'opus'], match: (head) => text(head, 0, 4) === 'OggS' },
  { name: 'JPEG', extensions: ['jpg', 'jpeg', 'jfif'], match: (head) => starts(head, 0xff, 0xd8, 0xff) },
  { name: 'PNG', extensions: ['png'], match: (head) => starts(head, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { name: 'GIF', extensions: ['gif'], match: (head) => text(head, 0, 4) === 'GIF8' },
  { name: 'BMP', extensions: ['bmp'], match: (head) => text(head, 0, 2) === 'BM' },
  { name: 'TIFF', extensions: ['tif', 'tiff'], match: (head) => starts(head, 0x49, 0x49, 0x2a, 0x00) || starts(head, 0x4d, 0x4d, 0x00, 0x2a) },
  // PDF 표준은 앞쪽 1024바이트 안에 머리글이 있으면 받아 준다.
  { name: 'PDF', extensions: ['pdf'], match: (head) => head.includes('%PDF-', 0, 'latin1') },
  { name: 'ZIP', extensions: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'jar', 'apk'], match: (head) => starts(head, 0x50, 0x4b, 0x03, 0x04) || starts(head, 0x50, 0x4b, 0x05, 0x06) || starts(head, 0x50, 0x4b, 0x07, 0x08) },
  { name: '7z', extensions: ['7z'], match: (head) => starts(head, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) },
  { name: 'RAR', extensions: ['rar'], match: (head) => text(head, 0, 6) === 'Rar!\x1a\x07' },
  { name: 'gzip', extensions: ['gz', 'tgz'], match: (head) => starts(head, 0x1f, 0x8b) },
  { name: 'bzip2', extensions: ['bz2', 'tbz2'], match: (head) => text(head, 0, 3) === 'BZh' },
  { name: 'xz', extensions: ['xz', 'txz'], match: (head) => starts(head, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) },
];
const BY_EXTENSION = new Map(FORMATS.flatMap((format) => format.extensions.map((extension) => [extension, format])));
const MP4 = BY_EXTENSION.get('mp4');
const MKV = BY_EXTENSION.get('mkv');
const ZIP = BY_EXTENSION.get('zip');
const SEVEN_ZIP = BY_EXTENSION.get('7z');
// tar.exe로 끝까지 읽어 보는 형식. .gz만 있는 파일은 tar가 아닐 수 있어 넣지 않는다.
// 압축한 tar는 끊긴 곳에서 오류가 나지만 본문 변경까지 잡지는 못한다.
const TAR_LISTED = /\.(?:tar|tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|txz)$/i;

const ZIP_END = Buffer.from('PK\x05\x06', 'latin1');
const ZIP_END_SIZE = 22;
const ZIP_TAIL = ZIP_END_SIZE + 65535;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL_SIZE = 46;
// 항목마다 파일을 여는 검사의 한도. 넘는 항목은 보지 않는다.
const ZIP_LOCAL_CHECKS = 5000;
const SEVEN_ZIP_HEADER = 32;

// RIFF 머리글의 크기가 파일보다 크면 잘린 것이다. 0과 최댓값은 크기를 모른 채 쓴 파일이고, 2GB를 넘는 AVI는 RIFF가 여럿이라 더 작기만 하다.
function checkRiff(head, size) {
  if (head.length < 8 || text(head, 0, 4) !== 'RIFF') return null;
  const declared = head.readUInt32LE(4);
  if (declared === 0 || declared === 0xffffffff) return null;
  return declared + 8 > size ? 'RIFF 머리글의 크기보다 파일이 작습니다. 잘린 파일일 수 있습니다.' : null;
}

// zip의 끝 레코드, 중앙 디렉터리, 항목 머리글이 맞물리는지 본다. 항목의 압축 내용(CRC)은 읽지 않는다.
// 분할 압축과 Zip64는 이 방식으로 판단할 수 없어 문제를 찾지 못한 것으로 둔다.
function checkZip(target, real, size) {
  const tailOffset = Math.max(0, size - ZIP_TAIL);
  const tail = readRange(target, real, { offset: tailOffset, length: ZIP_TAIL });
  const at = tail.lastIndexOf(ZIP_END);
  if (at === -1 || at + ZIP_END_SIZE > tail.length) return 'zip 끝 표시가 없습니다. 잘린 파일일 수 있습니다.';
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0) return null;
  const total = tail.readUInt16LE(at + 10);
  const directorySize = tail.readUInt32LE(at + 12);
  const directoryOffset = tail.readUInt32LE(at + 16);
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
  if (directoryOffset + directorySize > tailOffset + at) return 'zip 목록이 끝 표시를 넘습니다. 파일이 손상됐습니다.';
  const directory = readRange(target, real, { offset: directoryOffset, length: directorySize });
  let pos = 0;
  for (let index = 0; index < total; index += 1) {
    if (pos + ZIP_CENTRAL_SIZE > directory.length || directory.readUInt32LE(pos) !== ZIP_CENTRAL) return 'zip 목록이 손상됐습니다.';
    const offset = directory.readUInt32LE(pos + 42);
    if (offset !== 0xffffffff && index < ZIP_LOCAL_CHECKS) {
      const local = readRange(target, real, { offset, length: 4 });
      if (local.length < 4 || local.readUInt32LE(0) !== ZIP_LOCAL) return 'zip 항목의 머리글이 목록과 맞지 않습니다. 파일이 손상됐습니다.';
    }
    pos += ZIP_CENTRAL_SIZE + directory.readUInt16LE(pos + 28) + directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
  }
  return null;
}

// 7z 시작 머리글의 CRC와, 머리글이 가리키는 끝이 파일 안인지 본다. 내용은 읽지 않는다.
function check7z(head, size) {
  if (head.length < SEVEN_ZIP_HEADER) return '7z 머리글이 잘렸습니다.';
  if (zlib.crc32(head.subarray(12, SEVEN_ZIP_HEADER)) !== head.readUInt32LE(8)) return '7z 머리글이 손상됐습니다.';
  const end = BigInt(SEVEN_ZIP_HEADER) + head.readBigUInt64LE(12) + head.readBigUInt64LE(20);
  return end > BigInt(size) ? '7z 머리글이 가리키는 끝보다 파일이 작습니다. 잘린 파일일 수 있습니다.' : null;
}

// tar.exe가 끝까지 읽지 못하면 손상이다. tar.exe를 실행하지 못한 경우는 파일 문제가 아니므로 판단 못함으로 나간다.
function checkTarListing(real) {
  let entries;
  try {
    entries = archiveEntries(real);
  } catch (err) {
    if (err instanceof FcError || typeof err.status !== 'number') throw err;
    return { status: 'broken', reason: `tar로 끝까지 읽지 못했습니다. (종료 코드 ${err.status})` };
  }
  return entries.length === 0 ? { status: 'suspect', reason: '압축 파일에 항목이 없습니다. 비어 있거나 끝까지 받지 못한 파일일 수 있습니다.' } : null;
}

// 파일 하나를 판별해 { status, reason }을 돌려준다. 문제를 찾지 못하면 null이다. 입출력 문제는 예외로 나간다.
// - broken: 이 형식으로 열 수 없다고 판단한 파일이다.
// - suspect: 의심스럽지만 정상일 수 있어 제거 대상으로 삼지 않는다. 이름만 바뀐 파일과 뜻이 있을 수 있는 빈 파일이 그렇다.
function inspect(target, real, size) {
  const extension = path.extname(real).slice(1).toLowerCase();
  const format = BY_EXTENSION.get(extension);
  const listed = TAR_LISTED.test(real);
  if (size === 0) {
    // __init__.py, .gitkeep처럼 빈 파일이 뜻을 갖는 경우가 많아, 내용이 꼭 있어야 하는 형식만 깨졌다고 본다.
    if (format || listed) return { status: 'broken', reason: '크기가 0입니다.' };
    return { status: 'suspect', reason: '크기가 0입니다.' };
  }
  if (!format && !listed) return null;
  const head = readRange(target, real, { length: HEAD_SIZE });
  if (format && !format.match(head)) {
    const actual = FORMATS.find((other) => other.match(head));
    if (actual) return { status: 'suspect', reason: `확장자는 ${format.name}인데 내용은 ${actual.name}입니다. 이름만 바뀐 파일일 수 있습니다.` };
    return { status: 'broken', reason: `내용이 ${format.name} 형식으로 시작하지 않습니다.` };
  }
  let reason = checkRiff(head, size);
  if (reason === null && format === MP4) reason = checkMp4Structure(target, real, real);
  if (reason === null && format === MKV) reason = checkMkvStructure(target, real, real);
  if (reason === null && format === ZIP) reason = checkZip(target, real, size);
  if (reason === null && format === SEVEN_ZIP) reason = check7z(head, size);
  if (reason !== null) return { status: 'broken', reason };
  return listed ? checkTarListing(real) : null;
}

function skipReason(entry) {
  const parts = entry.relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return '이전 작업의 잔여물이라 보지 않습니다.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Windows 시스템 폴더 안의 파일이라 보지 않습니다.';
  return null;
}

// 타겟 아래 파일에서 깨진 파일을 찾는다. 파일은 건드리지 않는다.
// - broken: 깨진 파일 ({ path, size, reason })
// - suspect: 의심스럽지만 정상일 수 있는 파일 ({ path, size, reason })
// - unreadable: 잠겼거나 읽지 못해 판단하지 못한 파일 ({ path, reason }). 깨진 파일이 아니다.
// - skipped: 다루지 않는 항목 ({ path, reason })
// - checked: 살펴본 파일 수
// 저장소 폴더 안과 제거 기록 파일은 조용히 뺀다. 저장소의 파일은 수가 많고, 기록은 제거 대상이 될 수 없다.
function findBroken(dir) {
  const access = grant(dir, ['read']);
  const result = { target: access.target, broken: [], suspect: [], unreadable: [], skipped: [], checked: 0 };
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => REPOSITORY_FOLDER.test(part)) || REMOVAL_LOG.test(path.basename(entry.path))) continue;
    if (entry.type === 'link') {
      result.skipped.push({ path: entry.path, reason: '링크는 보지 않습니다.' });
      continue;
    }
    const reason = skipReason(entry);
    if (reason !== null) {
      result.skipped.push({ path: entry.path, reason });
      continue;
    }
    result.checked += 1;
    try {
      const real = access.read(entry.path);
      const size = fileSizeInside(access.target, real);
      const found = inspect(access.target, real, size);
      if (found) result[found.status].push({ path: real, size, reason: found.reason });
    } catch (err) {
      if (err instanceof FcError) result.unreadable.push({ path: entry.path, reason: err.message });
      else if (err.syscall) result.unreadable.push({ path: entry.path, reason: `파일을 읽을 수 없습니다. (${err.code})` });
      else throw err;
    }
  }
  return result;
}

function formatBroken(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  for (const item of result.broken) lines.push(`깨짐: ${relative(item.path)} (${item.reason})`);
  for (const item of result.suspect) lines.push(`의심: ${relative(item.path)} (${item.reason})`);
  for (const item of result.unreadable) lines.push(`판단 못함: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`건너뜀: ${relative(item.path)} (${item.reason})`);
  lines.push(`살펴본 파일 ${result.checked}개, 깨짐 ${result.broken.length}개, 의심 ${result.suspect.length}개, 판단 못함 ${result.unreadable.length}개, 건너뜀 ${result.skipped.length}개`);
  return lines.join('\n');
}

module.exports = { findBroken, formatBroken };
