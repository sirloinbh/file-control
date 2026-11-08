'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, unzip, remove, archiveEntries, archiveNames, freshPath, ensureRoomToExtract, oemCodePage } = require('./commands');
const { grant, walk, readRange, fileSizeInside, fileStamp, rejectAmbiguousNames, stampVolumeReason } = require('./target');
const { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER, moveWithoutOverwrite } = require('./flatten');

// tar.exe로 읽는 형식. 겹 확장자를 먼저 본다.
const ARCHIVE = /\.(?:tar\.gz|tar\.bz2|tar\.xz|zip|tar|tgz|tbz2|txz|7z|rar)$/i;

// 원본을 지워도 되는지 내용으로 확인하는 형식. 나머지는 지우지 않는다.
// .tar.gz는 본문이 변해도 tar.exe가 성공하고, .tar는 체크섬이 없다. .tar.xz와 .tar.bz2는 tar 끝 표시 뒤를 읽지 않아 무결성 검사를 건너뛸 수 있다. RAR는 확인하지 못했다.
// tar.exe는 확장자가 아니라 내용으로 형식을 고르므로 앞 바이트도 본다.
const ZIP = /\.zip$/i;
const SEVEN_ZIP = /\.7z$/i;
const ZIP_LOCAL = Buffer.from('PK\x03\x04', 'latin1');
const SEVEN_ZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SEVEN_ZIP_HEADER = 32;
// zip 끝 레코드는 22바이트에 주석이 최대 65535바이트 붙는다.
const ZIP_END_SIZE = 22;
const ZIP_TAIL = ZIP_END_SIZE + 65535;
const ZIP_END = Buffer.from('PK\x05\x06', 'latin1');
const ZIP_CENTRAL = 0x02014b50;
const ZIP_CENTRAL_SIZE = 46;
const ZIP_LOCAL_SIZE = 30;
const ZIP_DESCRIPTOR = 0x08074b50;
const ZIP_MAX = 0xffffffff;
const ZIP64_EXTRA = 0x0001;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_END = 0x06064b50;
const ZIP64_END_SIZE = 56;
// 이 글자가 든 이름은 tar.exe가 _로 바꾸거나 앞부분을 버린다.
const CHANGED_NAME = /[:?*<>|"\x00-\x1f]/;

// 압축 파일 이름에서 확장자를 뺀 폴더 이름. 압축 파일이 아니면 null이다.
function folderName(name) {
  const match = ARCHIVE.exec(name);
  if (!match || match.index === 0) return null;
  return name.slice(0, match.index);
}

// 타겟 아래 압축 파일마다 풀 새 폴더를 정한다. 파일은 건드리지 않는다.
// 이미 있는 폴더와 합치지 않는다. 다시 실행해도 같은 내용을 또 풀지 않게 번호를 붙이지 않고 건너뛴다.
// - extractions: 풀 압축 파일 ({ archive, dest, name })
// - skipped: 다루지 않는 항목 ({ path, reason })
function planExtractions(dir) {
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, extractions: [], skipped: [] };
  const planned = new Set();
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const skip = (reason) => plan.skipped.push({ path: entry.path, reason });
    if (entry.type === 'link') {
      skip('링크는 풀지 않습니다.');
      continue;
    }
    const name = folderName(path.basename(entry.path));
    if (name === null) continue;
    const parts = entry.relative.split(path.sep);
    try {
      if (parts.some((part) => LEFTOVER.test(part))) throw new FcError('이전 작업의 잔여물이라 풀지 않습니다.');
      if (parts.some((part) => SYSTEM_FOLDER.test(part))) throw new FcError('Windows 시스템 폴더 안의 파일이라 풀지 않습니다.');
      if (parts.some((part) => REPOSITORY_FOLDER.test(part))) throw new FcError('저장소 폴더 안의 파일이라 풀지 않습니다.');
      // 풀린 폴더가 .git 같은 이름이 되면 다른 명령이 특별 취급한다. 잔여물 이름은 위에서 압축 파일 이름으로 걸러진다.
      if (SYSTEM_FOLDER.test(name) || REPOSITORY_FOLDER.test(name)) throw new FcError(`특별한 폴더 이름이 되어 풀지 않습니다: ${name}`);
      if (name.length > MAX_NAME) throw new FcError(`폴더 이름이 너무 깁니다: ${name}`);
      const archive = access.read(entry.path);
      const dest = path.join(path.dirname(archive), name);
      const key = dest.toLowerCase();
      if (planned.has(key) || fs.lstatSync(dest, { throwIfNoEntry: false })) throw new FcError(`같은 이름이 이미 있어 풀지 않습니다: ${name}`);
      planned.add(key);
      plan.extractions.push({ archive, dest: access.write(dest), name });
    } catch (err) {
      if (err instanceof FcError) skip(err.message);
      else if (err.syscall) skip(`파일을 확인할 수 없습니다. (${err.code})`);
      else throw err;
    }
  }
  return plan;
}

// 항목 수와 파일 수를 돌려준다. 끝까지 받지 못한 파일은 오류 없이 항목 0개로 읽히므로 실패로 본다.
// 링크와 장치 항목은 풀기 전에 거부한다. 링크를 따라 쓰는 것을 tar.exe에만 맡기지 않는다.
// 풀린 크기가 남은 공간에 들어가는지도 본다(#77). dest는 풀 폴더이고, 임시 폴더도 같은 폴더 안에 만든다.
function inspectArchive(archive, dest) {
  const entries = archiveEntries(archive);
  if (entries.length === 0) throw new FcError('압축 파일에 항목이 없습니다. 비어 있거나 끝까지 받지 못한 파일일 수 있습니다.');
  const special = entries.find((entry) => !'-hd'.includes(entry[0]));
  if (special !== undefined) throw new FcError(`압축 파일에 링크나 장치 같은 항목이 들어 있습니다. (종류 ${JSON.stringify(special[0])})`);
  ensureRoomToExtract(dest, entries);
  // 끝이 /인 항목은 데이터가 있어도 폴더로 풀린다.
  const files = entries.filter((entry) => entry[0] !== 'd' && !entry.trimEnd().endsWith('/')).length;
  return { entries: entries.length, files };
}

// 목록과 실제 결과가 다르면 일부를 잃은 것이다. tar.exe는 대소문자만 다른 항목을 오류 없이 덮어쓴다.
// 쓸 수 없는 이름(con.txt, 끝이 점)이나 링크가 나오면 지우기도 어려우므로 결과로 내놓지 않는다.
function checkExtracted(temp, fileCount) {
  let files = 0;
  for (const entry of fs.readdirSync(temp, { recursive: true, withFileTypes: true })) {
    const relative = path.relative(temp, path.join(entry.parentPath, entry.name));
    rejectAmbiguousNames(relative, relative);
    if (entry.isSymbolicLink()) throw new FcError(`압축 파일에 링크가 들어 있습니다: ${relative}`);
    if (entry.isFile()) files += 1;
  }
  if (files !== fileCount) throw new FcError(`압축 파일 목록과 풀린 결과가 다릅니다. 이름이 겹치는 항목이 있을 수 있습니다. (목록 ${fileCount}개, 결과 ${files}개)`);
}

function removeTemp(temp, cause) {
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch (err) {
    throw new FcError(`${cause.message} 임시 폴더를 지우지 못했습니다: ${temp} (${err.code})`);
  }
}

// 임시 폴더에 다 푼 뒤에 이름을 바꾼다. 실패해도 일부만 풀린 폴더가 결과처럼 남지 않는다.
function extractOne(item, access) {
  const archive = access.read(item.archive);
  if (archive !== item.archive) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${item.archive} -> ${archive}`);
  if (!fs.lstatSync(archive).isFile()) throw new FcError(`계획 뒤에 파일이 아니게 됐습니다: ${archive}`);
  if (fs.lstatSync(item.dest, { throwIfNoEntry: false })) throw new FcError(`같은 이름이 이미 있어 풀지 않습니다: ${item.name}`);
  const dest = access.write(item.dest);
  if (dest !== item.dest) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${item.dest} -> ${dest}`);
  const { entries, files } = inspectArchive(archive, path.dirname(item.dest));
  const temp = freshPath(archive, '.fctl-new');
  try {
    unzip(archive, temp, { checkSpace: false });
    checkExtracted(temp, files);
    // renameSync는 대상이 파일이면 덮어쓴다. 푸는 동안 같은 이름이 생겼을 수 있으므로 덮어쓰지 않는 이동을 쓴다.
    if (!moveWithoutOverwrite(temp, dest)) throw new FcError(`같은 이름이 이미 있어 풀지 않습니다: ${item.name}`);
  } catch (err) {
    removeTemp(temp, err instanceof FcError ? err : new FcError(failureReason(err)));
    throw err;
  }
  return entries;
}

// extra 필드에서 id 항목의 데이터를 찾는다. 없으면 undefined, 구조가 어긋나면 null이다.
function extraField(extra, id) {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const length = extra.readUInt16LE(pos + 2);
    if (pos + 4 + length > extra.length) return null;
    if (extra.readUInt16LE(pos) === id) return extra.subarray(pos + 4, pos + 4 + length);
    pos += 4 + length;
  }
  return pos === extra.length ? undefined : null;
}

const safeNumber = (big) => (big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : null);

// UTF-8 표시가 없는 이름을 tar.exe처럼 OEM 코드페이지로 읽는다(#83). Node가 그 코드페이지를 모르거나 바이트가 맞지 않으면 null이다.
// Node의 CP949는 확장 영역(UHC) 글자를 오류 없이 다른 글자로 읽는다. 이렇게 잘못 읽어도 풀린 결과에 그 이름이 없어 남기므로 지우지는 않는다.
function decodeOemName(bytes) {
  const cp = oemCodePage();
  const label = { 949: 'euc-kr', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 866: 'ibm866' }[cp] ?? (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : null);
  if (label === null) return null;
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Zip64 끝 레코드를 읽어 항목 수와 중앙 디렉터리 위치를 돌려준다(#83). 믿을 수 없으면 사유 문자열이다.
// locatorAt은 32비트 끝 레코드 바로 앞의 Zip64 위치 표시 자리다.
function readZip64End(target, archive, locatorAt) {
  const locator = readRange(target, archive, { offset: locatorAt, length: ZIP64_LOCATOR_SIZE });
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) return '분할 압축의 조각일 수 있어 남겼습니다.';
  const recordOffset = safeNumber(locator.readBigUInt64LE(8));
  const record = recordOffset === null ? Buffer.alloc(0) : readRange(target, archive, { offset: recordOffset, length: ZIP64_END_SIZE });
  if (record.length < ZIP64_END_SIZE || record.readUInt32LE(0) !== ZIP64_END) return 'Zip64 구조를 읽지 못해 남겼습니다.';
  // 레코드 크기(앞 12바이트를 뺀 길이)만큼 지나면 바로 위치 표시가 나와야 한다.
  const recordSize = safeNumber(record.readBigUInt64LE(4));
  if (recordSize === null || recordOffset + 12 + recordSize !== locatorAt) return 'Zip64 구조가 파일 크기와 맞지 않아 남겼습니다.';
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0 || record.readBigUInt64LE(24) !== record.readBigUInt64LE(32)) return '분할 압축의 조각일 수 있어 남겼습니다.';
  const total = safeNumber(record.readBigUInt64LE(32));
  const directorySize = safeNumber(record.readBigUInt64LE(40));
  const directoryOffset = safeNumber(record.readBigUInt64LE(48));
  if (total === null || directorySize === null || directoryOffset === null) return 'Zip64 구조를 읽지 못해 남겼습니다.';
  return { total, directorySize, directoryOffset, directoryEnd: recordOffset };
}

// 항목이 파일 처음부터 중앙 디렉터리 앞까지 빈틈없이 이어지는지 본다. 목록에 없는 항목이 사이에 끼면
// tar.exe는 풀지 않는데 원본을 지우게 된다(#83). 항목의 끝은 로컬 헤더, 압축된 본문, 데이터 설명자를 더한 자리다.
// 앞에서부터 차례로 읽을 때 항목마다 파일을 다시 열지 않도록 1MB씩 읽어 둔다(항목이 수만 개인 zip).
function chunkReader(target, archive, chunk = 1 << 20) {
  let start = 0;
  let data = Buffer.alloc(0);
  return (offset, length) => {
    if (offset < start || offset + length > start + data.length) {
      start = offset;
      data = readRange(target, archive, { offset, length: Math.max(length, chunk) });
    }
    return data.subarray(offset - start, offset - start + length);
  };
}

function checkZipLayout(target, archive, entries, directoryOffset) {
  const read = chunkReader(target, archive);
  const sorted = [...entries].sort((a, b) => a.offset - b.offset);
  // 첫 항목이 파일 처음에서 시작하지 않으면 앞쪽에 목록에 없는 항목이 있을 수 있다. 이어 붙인 뒤 오프셋을 고친 zip이 이렇다.
  if (sorted.length > 0 && sorted[0].offset !== 0) return 'zip 앞쪽에 목록에 없는 데이터가 있어 남겼습니다.';
  for (const [i, entry] of sorted.entries()) {
    const expected = i + 1 < sorted.length ? sorted[i + 1].offset : directoryOffset;
    const local = read(entry.offset, ZIP_LOCAL_SIZE);
    if (local.length < ZIP_LOCAL_SIZE || !local.subarray(0, ZIP_LOCAL.length).equals(ZIP_LOCAL)) return 'zip 구조를 읽지 못해 남겼습니다.';
    const dataEnd = entry.offset + ZIP_LOCAL_SIZE + local.readUInt16LE(26) + local.readUInt16LE(28) + entry.compressed;
    const gap = expected - dataEnd;
    if ((local.readUInt16LE(6) & 0x8) === 0) {
      if (gap !== 0) return gap < 0 ? 'zip 항목이 서로 겹쳐 남겼습니다.' : 'zip 항목 사이에 목록에 없는 데이터가 있어 남겼습니다.';
      continue;
    }
    if (gap === 0) return 'zip 항목에 데이터 설명자 표시가 있는데 설명자가 없어 남겼습니다.';
    // 데이터 설명자는 서명(4바이트)이 있을 수도 없을 수도 있고, 크기 칸이 4바이트나 8바이트다(tar.exe의 Zip64는 8바이트).
    // 그래서 길이는 다음 항목까지의 거리로 정하고, CRC와 압축된 크기가 중앙 디렉터리와 같은지 본다.
    const layout = { 12: [false, false], 16: [true, false], 20: [false, true], 24: [true, true] }[gap];
    if (!layout) return gap < 0 ? 'zip 항목이 서로 겹쳐 남겼습니다.' : 'zip 항목 사이에 목록에 없는 데이터가 있어 남겼습니다.';
    const [signed, wide] = layout;
    const descriptor = read(dataEnd, gap);
    if (descriptor.length !== gap || (signed && descriptor.readUInt32LE(0) !== ZIP_DESCRIPTOR)) return 'zip 구조를 읽지 못해 남겼습니다.';
    const at = signed ? 4 : 0;
    const compressed = wide ? safeNumber(descriptor.readBigUInt64LE(at + 4)) : descriptor.readUInt32LE(at + 4);
    if (descriptor.readUInt32LE(at) !== entry.crc || compressed !== entry.compressed) return 'zip 데이터 설명자가 중앙 디렉터리와 달라 남겼습니다. 항목 사이에 다른 데이터가 끼었을 수 있습니다.';
  }
  if (sorted.length === 0 && directoryOffset !== 0) return 'zip 앞쪽에 목록에 없는 데이터가 있어 남겼습니다.';
  return null;
}

// zip의 중앙 디렉터리를 읽어 항목 목록을 돌려준다. 믿을 수 없으면 사유 문자열을 돌려준다.
// tar.exe는 끝에서 처음 만난 끝 레코드를 믿어서, 잘린 zip 안의 무압축 zip이나 이어 붙인 zip이면 일부만 풀고 성공한다.
// 그래서 끝 레코드가 파일 끝에 딱 맞고 중앙 디렉터리가 바로 앞에 이어지는지 본다. Zip64면 Zip64 끝 레코드로 본다.
function readZipEntries(target, archive, entryCount) {
  const size = fileSizeInside(target, archive);
  const tailOffset = Math.max(0, size - ZIP_TAIL);
  const tail = readRange(target, archive, { offset: tailOffset, length: ZIP_TAIL });
  const at = tail.lastIndexOf(ZIP_END);
  if (at === -1 || at + ZIP_END_SIZE > tail.length) return 'zip 끝 표시가 없어 잘린 파일일 수 있어 남겼습니다.';
  const end = tailOffset + at;
  if (end + ZIP_END_SIZE + tail.readUInt16LE(at + 20) !== size) return 'zip 끝 표시 뒤에 다른 데이터가 있어 남겼습니다.';
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  // 이 디스크의 항목 수와 전체 항목 수가 다르면 tar.exe는 중앙 디렉터리 대신 로컬 헤더를 차례로 읽는다(1차 리뷰에서 실측).
  if (tail.readUInt16LE(at + 8) !== tail.readUInt16LE(at + 10)) return '분할 압축의 조각일 수 있어 남겼습니다.';
  let total = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  let directoryEnd = end;
  const locatorAt = end - ZIP64_LOCATOR_SIZE;
  const locator = locatorAt >= 0 ? readRange(target, archive, { offset: locatorAt, length: 4 }) : Buffer.alloc(0);
  if (locator.length === 4 && locator.readUInt32LE(0) === ZIP64_LOCATOR) {
    // 32비트 끝 레코드의 값은 Zip64 표시(모두 1인 값)이거나 Zip64 끝 레코드와 같아야 한다.
    const zip64 = readZip64End(target, archive, locatorAt);
    if (typeof zip64 === 'string') return zip64;
    if ((disk !== 0 && disk !== 0xffff) || (directoryDisk !== 0 && directoryDisk !== 0xffff)) return '분할 압축의 조각일 수 있어 남겼습니다.';
    const agrees = (short, full, marker) => short === marker || short === full;
    if (!agrees(total, zip64.total, 0xffff) || !agrees(directorySize, zip64.directorySize, ZIP_MAX) || !agrees(directoryOffset, zip64.directoryOffset, ZIP_MAX)) {
      return 'zip 구조가 파일 크기와 맞지 않아 남겼습니다. 잘렸거나 다른 파일이 이어 붙었을 수 있습니다.';
    }
    ({ total, directorySize, directoryOffset, directoryEnd } = zip64);
  } else {
    if (disk !== 0 || directoryDisk !== 0) return '분할 압축의 조각일 수 있어 남겼습니다.';
    if (total === 0xffff || directorySize === ZIP_MAX || directoryOffset === ZIP_MAX) return 'Zip64 표시가 있는데 Zip64 끝 레코드가 없어 남겼습니다.';
  }
  if (directoryOffset + directorySize !== directoryEnd) return 'zip 구조가 파일 크기와 맞지 않아 남겼습니다. 잘렸거나 다른 파일이 이어 붙었을 수 있습니다.';
  if (total !== entryCount) return `zip 항목 수가 풀린 목록과 달라 남겼습니다. (${total}개, ${entryCount}개)`;
  const directory = readRange(target, archive, { offset: directoryOffset, length: directorySize });
  const entries = [];
  let pos = 0;
  while (pos < directory.length) {
    if (pos + ZIP_CENTRAL_SIZE > directory.length || directory.readUInt32LE(pos) !== ZIP_CENTRAL) return 'zip 구조를 읽지 못해 남겼습니다.';
    const nameEnd = pos + ZIP_CENTRAL_SIZE + directory.readUInt16LE(pos + 28);
    const extraEnd = nameEnd + directory.readUInt16LE(pos + 30);
    const entryEnd = extraEnd + directory.readUInt16LE(pos + 32);
    if (entryEnd > directory.length) return 'zip 구조를 읽지 못해 남겼습니다.';
    const bytes = directory.subarray(pos + ZIP_CENTRAL_SIZE, nameEnd);
    const unicode = (directory.readUInt16LE(pos + 8) & 0x800) !== 0;
    let name = bytes.toString('utf8');
    if (!unicode && bytes.some((byte) => byte >= 0x80)) {
      name = decodeOemName(bytes);
      if (name === null) return '코드페이지에 따라 이름이 달라질 수 있는 항목이 있어 남겼습니다.';
    }
    // 32비트 칸이 모두 1이면 Zip64 extra 필드에 원래 크기, 압축된 크기, 로컬 헤더 위치, 디스크 번호 순으로 그 칸만 들어 있다.
    let size = directory.readUInt32LE(pos + 24);
    let compressed = directory.readUInt32LE(pos + 20);
    let offset = directory.readUInt32LE(pos + 42);
    const startDisk = directory.readUInt16LE(pos + 34);
    if (size === ZIP_MAX || compressed === ZIP_MAX || offset === ZIP_MAX || startDisk === 0xffff) {
      const extra = extraField(directory.subarray(nameEnd, extraEnd), ZIP64_EXTRA);
      if (!extra) return 'Zip64 구조를 읽지 못해 남겼습니다.';
      let at64 = 0;
      const take = () => {
        if (at64 + 8 > extra.length) return null;
        const value = safeNumber(extra.readBigUInt64LE(at64));
        at64 += 8;
        return value;
      };
      if (size === ZIP_MAX) size = take();
      if (compressed === ZIP_MAX) compressed = take();
      if (offset === ZIP_MAX) offset = take();
      if (size === null || compressed === null || offset === null) return 'Zip64 구조를 읽지 못해 남겼습니다.';
      if (startDisk === 0xffff && (at64 + 4 > extra.length || extra.readUInt32LE(at64) !== 0)) return '분할 압축의 조각일 수 있어 남겼습니다.';
    } else if (startDisk !== 0) {
      return '분할 압축의 조각일 수 있어 남겼습니다.';
    }
    entries.push({ name, size, compressed, offset, crc: directory.readUInt32LE(pos + 16) });
    pos = entryEnd;
  }
  if (pos !== directory.length || entries.length !== total) return 'zip 구조를 읽지 못해 남겼습니다.';
  const layout = checkZipLayout(target, archive, entries, directoryOffset);
  if (layout !== null) return layout;
  return entries.map(({ name, size }) => ({ name, size }));
}

// 항목이 원래 이름 그대로 풀렸는지 본다. 내용은 남아도 이름은 원본에만 있을 수 있다.
// 미리보기에서는 풀린 결과가 없으니 이름 글자만 본다. size가 없으면 크기는 보지 않는다.
function checkEntryNames(entries, dest, dryRun) {
  for (const { name, size } of entries) {
    if (CHANGED_NAME.test(name)) return `풀면 이름이 바뀌는 항목이 있어 남겼습니다: ${JSON.stringify(name)}`;
    const relative = name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    const folder = relative === '' || relative.endsWith('/');
    if (folder && size > 0) return `폴더 항목에 내용이 있어 남겼습니다: ${JSON.stringify(name)}`;
    if (dryRun) continue;
    const stat = fs.lstatSync(path.join(dest, relative), { throwIfNoEntry: false });
    if (!stat) return `같은 이름으로 풀리지 않은 항목이 있어 남겼습니다: ${JSON.stringify(name)}`;
    if (folder ? !stat.isDirectory() : size !== undefined && (!stat.isFile() || stat.size !== size)) return `풀린 크기가 달라 남겼습니다: ${JSON.stringify(name)}`;
  }
  return null;
}

// 원본을 지우면 안 되는 사유. 지워도 되면 null이다.
function keepReason(access, item, entryCount, dryRun) {
  const { archive, dest } = item;
  const head = readRange(access.target, archive, { length: SEVEN_ZIP_HEADER });
  if (ZIP.test(archive)) {
    if (!head.subarray(0, ZIP_LOCAL.length).equals(ZIP_LOCAL)) return '내용이 zip으로 시작하지 않아 남겼습니다.';
    const entries = readZipEntries(access.target, archive, entryCount);
    return typeof entries === 'string' ? entries : checkEntryNames(entries, dest, dryRun);
  }
  if (SEVEN_ZIP.test(archive)) {
    if (head.length < SEVEN_ZIP_HEADER || !head.subarray(0, SEVEN_ZIP_MAGIC.length).equals(SEVEN_ZIP_MAGIC)) return '내용이 7z로 시작하지 않아 남겼습니다.';
    // tar.exe는 첫 7z만 읽으므로, 머리글이 가리키는 끝이 파일 끝과 맞는지 본다. 어긋나면 뒤에 붙은 내용을 풀지 못했을 수 있다.
    const end = BigInt(SEVEN_ZIP_HEADER) + head.readBigUInt64LE(12) + head.readBigUInt64LE(20);
    if (end !== BigInt(fileSizeInside(access.target, archive))) return '7z 끝 뒤에 다른 데이터가 있어 남겼습니다.';
    const names = archiveNames(archive);
    if (names.some((name) => /[^\x00-\x7f]/.test(name))) return '코드페이지에 따라 이름이 달라질 수 있는 항목이 있어 남겼습니다.';
    return checkEntryNames(names.map((name) => ({ name })), dest, dryRun);
  }
  return '이 형식은 풀린 내용이 온전한지 확인할 수 없어 남겼습니다.';
}

// 푼 압축 파일이 그 뒤로 바뀌었으면 지우지 않는다. 지우는 것은 내용을 확인한 그 파일이어야 한다.
// before는 풀기 전에 잡은 fileStamp다. 변경 시각까지 보므로 같은 크기로 제자리에서 다시 쓰고 수정 시각을 되돌려도 알아챈다.
function removeArchive(access, item, before, dryRun) {
  const archive = access.delete(item.archive);
  if (archive !== item.archive) throw new FcError(`풀고 난 뒤 경로가 바뀌어 지우지 않았습니다: ${item.archive} -> ${archive}`);
  const stat = fs.lstatSync(archive, { bigint: true });
  if (!stat.isFile() || fileStamp(stat) !== before) throw new FcError(`풀고 난 뒤 파일이 바뀌어 지우지 않았습니다: ${archive}`);
  remove([archive], { dryRun });
}

function removalFailure(err) {
  if (err instanceof FcError) return err.message;
  return `풀었지만 원본을 확인하거나 휴지통으로 보내지 못했습니다. (${err.code ?? err.status})`;
}

function failureReason(err) {
  if (err instanceof FcError) return err.message;
  // tar.exe의 오류는 코드페이지로 나와 한글이 깨지므로 종료 코드만 쓴다.
  if (err.status !== undefined && err.status !== null) return `압축을 풀지 못했습니다. 손상됐거나, 암호가 걸렸거나, 타겟 밖을 가리키는 경로나 쓸 수 없는 이름이 있을 수 있습니다. (tar 종료 코드 ${err.status})`;
  return `압축을 풀지 못했습니다. (${err.code})`;
}

// 타겟 아래 압축 파일을 각각 새 폴더에 푼다. 풀려 나온 압축 파일을 다시 풀지는 않는다.
// removeArchives를 주면 정상으로 풀린 압축 파일을 휴지통으로 보낸다. 건너뛰거나 실패한 압축 파일은 지우지 않는다.
// 돌려주는 값: { target, dryRun, removeArchives, extracted, skipped, removed, kept, failed }.
// extracted는 { archive, dest, name, entries }, removed는 경로, kept와 failed는 { archive, reason } 목록이다. 풀렸지만 지우지 못한 파일은 failed에 넣는다.
function extractArchives(dir, options = {}) {
  return applyExtractions(planExtractions(dir), options);
}

function applyExtractions(plan, { dryRun = false, removeArchives = false } = {}) {
  const result = { target: plan.target, dryRun, removeArchives, extracted: [], skipped: plan.skipped, removed: [], kept: [], failed: [] };
  const access = grant(plan.target, removeArchives ? ['read', 'write', 'delete'] : ['read', 'write']);
  // 변경 시각이 없는 볼륨(exFAT 등)에서는 푼 뒤 같은 크기로 바뀐 압축 파일을 알아보지 못해 지우지 않는다(#184).
  const volumeReason = removeArchives && plan.extractions.length > 0 ? stampVolumeReason(plan.target) : null;
  for (const item of plan.extractions) {
    let before;
    let entries;
    try {
      // ReFS의 파일 번호는 2^53을 넘어 숫자로 받으면 정밀도를 잃으므로 bigint로 받는다.
      before = fileStamp(fs.lstatSync(item.archive, { bigint: true }));
      entries = dryRun ? inspectArchive(item.archive, path.dirname(item.dest)).entries : extractOne(item, access);
      result.extracted.push({ ...item, entries });
    } catch (err) {
      result.failed.push({ archive: item.archive, reason: failureReason(err) });
      continue;
    }
    if (!removeArchives) continue;
    try {
      const reason = volumeReason ?? keepReason(access, item, entries, dryRun);
      if (reason !== null) {
        result.kept.push({ archive: item.archive, reason });
        continue;
      }
      removeArchive(access, item, before, dryRun);
      result.removed.push(item.archive);
    } catch (err) {
      result.failed.push({ archive: item.archive, reason: removalFailure(err) });
    }
  }
  return result;
}

function formatExtractions(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[미리보기] ' : '';
  const lines = [];
  for (const item of result.extracted) lines.push(`${prefix}압축 해제: ${relative(item.archive)} -> ${relative(item.dest)} (항목 ${item.entries}개)`);
  for (const archive of result.removed) lines.push(`${prefix}휴지통으로 이동: ${relative(archive)}`);
  for (const item of result.kept) lines.push(`${prefix}남김: ${relative(item.archive)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`${prefix}건너뜀: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`실패: ${relative(item.archive)} (${item.reason})`);
  const removal = result.removeArchives ? `, 휴지통 ${result.removed.length}개, 남김 ${result.kept.length}개` : '';
  lines.push(`${prefix}압축 해제 ${result.extracted.length}개${removal}, 건너뜀 ${result.skipped.length}개, 실패 ${result.failed.length}개`);
  return lines.join('\n');
}

module.exports = { planExtractions, applyExtractions, extractArchives, formatExtractions };
