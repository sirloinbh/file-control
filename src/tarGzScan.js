'use strict';

// .tar.gz·.tgz를 처음부터 끝까지 스트림으로 읽어, tar.exe가 풀린 결과만으로는 알 수 없는 손상을 찾는다(#197).
// - gzip: Node zlib이 멤버마다 CRC와 길이를 확인한다. 잘렸거나 뒤에 gzip이 아닌 데이터가 붙으면 오류가 난다.
//   여러 멤버는 이어서 읽는다. tar.exe는 tar 끝 표시에서 멈추므로, 이어 붙인 tar.gz는 아래 끝 표시 확인에서 걸린다.
// - tar: 헤더 체크섬, 항목 크기만큼의 데이터, 끝 표시(0 블록) 뒤에 0이 아닌 데이터가 없는지 본다. 끝 표시 뒤의 항목은 tar.exe가 풀지 않는다.
// - 이름: pax path(UTF-8)와 GNU 긴 이름(L)을 따른다. pax가 아닌 이름에 ASCII가 아닌 바이트가 있으면 코드페이지에 따라 달라지므로 남긴다.
// 결과는 { entries: [{ name, size }] } 또는 { reason }이다. size가 null이면 크기를 보지 않는다(하드링크).
// keepReason은 동기 함수라 이 파일을 별도 node 프로세스로 실행해 결과를 JSON으로 받는다(scanTarGzSync).

const fs = require('node:fs');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const BLOCK = 512;

function octal(field) {
  // base-256(첫 바이트의 최상위 비트)는 큰 크기를 적는 GNU 확장이다. 음수는 받지 않는다.
  if (field[0] & 0x80) {
    if (field[0] & 0x40) return null;
    let value = BigInt(field[0] & 0x3f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return value;
  }
  const text = field.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (text === '') return 0n;
  if (!/^[0-7]+$/.test(text)) return null;
  return BigInt(`0o${text}`);
}

function checksumMatches(block) {
  const stored = octal(block.subarray(148, 156));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return BigInt(unsigned) === stored || BigInt(signed) === stored;
}

const cString = (buf) => {
  const end = buf.indexOf(0);
  return end === -1 ? buf : buf.subarray(0, end);
};

// pax 기록 "길이 키=값\n"을 읽는다. 구조가 어긋나면 null이다.
function parsePax(data) {
  const records = new Map();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) return null;
    const length = Number(data.subarray(pos, space).toString('latin1'));
    if (!Number.isSafeInteger(length) || length <= space - pos + 1 || pos + length > data.length || data[pos + length - 1] !== 0x0a) return null;
    const record = data.subarray(space + 1, pos + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals === -1) return null;
    records.set(record.subarray(0, equals).toString('utf8'), record.subarray(equals + 1));
    pos += length;
  }
  return records;
}

const isUtf8 = (buf) => Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);

// 블록을 차례로 받아 tar 구조를 확인하는 상태 기계. push로 데이터를 넣고 finish로 결과를 받는다.
function tarChecker() {
  const entries = [];
  let pending = Buffer.alloc(0);
  let skip = 0; // 건너뛸 데이터 바이트(패딩 포함)
  let collect = null; // { kind, size, chunks, left } pax·긴 이름 데이터
  let pax = null;
  let longName = null;
  let ended = false;
  let reason = null;

  const fail = (text) => {
    if (reason === null) reason = text;
  };

  function header(block) {
    if (block.every((byte) => byte === 0)) {
      ended = true;
      return;
    }
    if (!checksumMatches(block)) return fail('tar 헤더 체크섬이 맞지 않아 남겼습니다.');
    const size = octal(block.subarray(124, 136));
    if (size === null || size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('tar 항목 크기를 읽지 못해 남겼습니다.');
    const type = String.fromCharCode(block[156]);
    const padded = Math.ceil(Number(size) / BLOCK) * BLOCK;
    if (type === 'x' || type === 'L') {
      if (size > 1n << 24n) return fail('tar 확장 헤더가 너무 커서 남겼습니다.');
      collect = { kind: type, size: Number(size), chunks: [], left: padded };
      return;
    }
    if (type === 'g' || type === 'K') {
      skip = padded;
      return;
    }
    const magic = block.subarray(257, 263).toString('latin1');
    let raw = cString(block.subarray(0, 100));
    // POSIX ustar만 prefix 칸을 쓴다. GNU 형식('ustar  ')은 같은 자리에 다른 값을 적는다.
    if (magic === 'ustar\0') {
      const prefix = cString(block.subarray(345, 500));
      if (prefix.length > 0) raw = Buffer.concat([prefix, Buffer.from('/'), raw]);
    }
    let name;
    const paxPath = pax?.get('path');
    if (paxPath !== undefined) {
      if (!isUtf8(paxPath)) return fail('tar 항목 이름이 UTF-8이 아니라 남겼습니다.');
      name = paxPath.toString('utf8');
    } else {
      const bytes = longName ?? raw;
      if (bytes.some((byte) => byte > 0x7f)) return fail('코드페이지에 따라 이름이 달라질 수 있는 항목이 있어 남겼습니다.');
      name = bytes.toString('latin1');
    }
    let entrySize = size;
    const paxSize = pax?.get('size');
    if (paxSize !== undefined) {
      const text = paxSize.toString('latin1');
      if (!/^\d+$/.test(text)) return fail('tar 항목 크기를 읽지 못해 남겼습니다.');
      entrySize = BigInt(text);
      if (entrySize > BigInt(Number.MAX_SAFE_INTEGER)) return fail('tar 항목 크기를 읽지 못해 남겼습니다.');
    }
    if (pax && [...pax.keys()].some((key) => key.startsWith('GNU.sparse'))) return fail('희소 파일 항목이 있어 남겼습니다.');
    pax = null;
    longName = null;
    const dataLength = Math.ceil(Number(entrySize) / BLOCK) * BLOCK;
    if (type === '0' || type === '\0' || type === '7') entries.push({ name, size: Number(entrySize) });
    else if (type === '5') entries.push({ name: name.endsWith('/') ? name : `${name}/`, size: Number(entrySize) });
    else if (type === '1') entries.push({ name, size: null });
    else return fail(`풀린 결과로 확인할 수 없는 tar 항목 종류가 있어 남겼습니다. (종류 ${JSON.stringify(type)})`);
    skip = dataLength;
  }

  function push(chunk) {
    if (reason !== null) return;
    if (ended) {
      if (pending.some((byte) => byte !== 0) || chunk.some((byte) => byte !== 0)) fail('tar 끝 표시 뒤에 다른 데이터가 있어 남겼습니다.');
      pending = Buffer.alloc(0);
      return;
    }
    let data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    while (reason === null && !ended) {
      if (skip > 0) {
        const n = Math.min(skip, data.length);
        skip -= n;
        data = data.subarray(n);
        if (skip > 0) break;
        continue;
      }
      if (collect !== null) {
        const n = Math.min(collect.left, data.length);
        collect.chunks.push(data.subarray(0, n));
        collect.left -= n;
        data = data.subarray(n);
        if (collect.left > 0) break;
        const body = Buffer.concat(collect.chunks).subarray(0, collect.size);
        if (collect.kind === 'x') {
          pax = parsePax(body);
          if (pax === null) fail('tar 확장 헤더를 읽지 못해 남겼습니다.');
        } else {
          longName = cString(body);
        }
        collect = null;
        continue;
      }
      if (data.length < BLOCK) break;
      header(data.subarray(0, BLOCK));
      data = data.subarray(BLOCK);
    }
    if (ended && reason === null && data.some((byte) => byte !== 0)) fail('tar 끝 표시 뒤에 다른 데이터가 있어 남겼습니다.');
    pending = ended ? Buffer.alloc(0) : Buffer.from(data);
  }

  function finish() {
    if (reason !== null) return { reason };
    if (!ended) return { reason: 'tar 끝 표시가 없어 남겼습니다. 끝이 잘렸을 수 있습니다.' };
    return { entries };
  }

  return { push, finish };
}

function scanTarGz(file) {
  return new Promise((resolve) => {
    const checker = tarChecker();
    const gunzip = zlib.createGunzip();
    let done = false;
    const end = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const input = fs.createReadStream(file);
    input.on('error', (err) => end({ reason: `압축 파일을 다시 읽지 못해 남겼습니다. (${err.code})` }));
    gunzip.on('error', (err) => end({ reason: `gzip이 손상됐거나 잘렸거나 뒤에 다른 데이터가 있어 남겼습니다. (${err.code})` }));
    gunzip.on('data', (chunk) => checker.push(chunk));
    gunzip.on('end', () => end(checker.finish()));
    input.pipe(gunzip);
  });
}

// 별도 node 프로세스로 scanTarGz를 실행한다. 큰 파일도 이 프로세스의 메모리에 올리지 않는다.
function scanTarGzSync(file) {
  const { error, status, stdout } = spawnSync(process.execPath, [__filename, file], { encoding: 'utf8', maxBuffer: Infinity, windowsHide: true });
  if (error || status !== 0) return { reason: `tar.gz 내용을 확인하지 못해 남겼습니다. (${error?.code ?? status})` };
  try {
    return JSON.parse(stdout);
  } catch {
    return { reason: 'tar.gz 내용을 확인하지 못해 남겼습니다.' };
  }
}

if (require.main === module) {
  scanTarGz(process.argv[2]).then((result) => process.stdout.write(JSON.stringify(result)));
}

module.exports = { scanTarGz, scanTarGzSync, tarChecker };
