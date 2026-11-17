'use strict';

// It reads .tar.gz and .tgz as a stream from start to end and finds damage that cannot be known from tar.exe's extracted result alone (#197).
// - gzip: Node zlib checks the CRC and length of each member. If it is truncated or has non-gzip data attached after it, it raises an error.
//   Several members are read in succession. tar.exe stops at the tar end marker, so a concatenated tar.gz is caught in the end marker check below.
// - tar: it checks the header checksum, the data of the size of each entry, and that there is no nonzero data after the end marker (zero blocks). tar.exe does not extract entries after the end marker.
// - Names: it follows the pax path (UTF-8) and the GNU long name (L). If a non-pax name has non-ASCII bytes, it depends on the code page, so it is kept.
// The result is { entries: [{ name, size }] } or { reason }. If size is null, the size is not looked at (a hard link).
// keepReason is a synchronous function, so it runs this file as a separate node process and receives the result as JSON (scanTarGzSync).

const fs = require('node:fs');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const BLOCK = 512;

function octal(field) {
  // base-256 (the top bit of the first byte) is a GNU extension for writing large sizes. A negative value is not accepted.
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

// It reads the pax record "length key=value\n". If the structure is off, it is null.
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

// A state machine that takes blocks in order and checks the tar structure. You put data in with push and receive the result with finish.
function tarChecker() {
  const entries = [];
  let pending = Buffer.alloc(0);
  let skip = 0; // The data bytes to skip (including padding)
  let collect = null; // { kind, size, chunks, left } pax and long-name data
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
    if (!checksumMatches(block)) return fail('Kept because a tar header checksum does not match.');
    const size = octal(block.subarray(124, 136));
    if (size === null || size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('Kept because a tar entry size could not be read.');
    const type = String.fromCharCode(block[156]);
    const padded = Math.ceil(Number(size) / BLOCK) * BLOCK;
    if (type === 'x' || type === 'L') {
      if (size > 1n << 24n) return fail('Kept because a tar extended header is too large.');
      collect = { kind: type, size: Number(size), chunks: [], left: padded };
      return;
    }
    if (type === 'g' || type === 'K') {
      skip = padded;
      return;
    }
    const magic = block.subarray(257, 263).toString('latin1');
    let raw = cString(block.subarray(0, 100));
    // Only POSIX ustar uses the prefix field. The GNU format ('ustar  ') writes a different value in the same place.
    if (magic === 'ustar\0') {
      const prefix = cString(block.subarray(345, 500));
      if (prefix.length > 0) raw = Buffer.concat([prefix, Buffer.from('/'), raw]);
    }
    let name;
    const paxPath = pax?.get('path');
    // An empty pax path is extracted by tar.exe under the header name, so the names diverge (first review).
    if (paxPath !== undefined && paxPath.length === 0) return fail('Kept because the name in a tar extended header is empty.');
    if (paxPath !== undefined) {
      if (!isUtf8(paxPath)) return fail('Kept because a tar entry name is not UTF-8.');
      name = paxPath.toString('utf8');
    } else {
      const bytes = longName ?? raw;
      if (bytes.some((byte) => byte > 0x7f)) return fail('Kept because there is an item whose name may differ depending on the code page.');
      name = bytes.toString('latin1');
    }
    let entrySize = size;
    const paxSize = pax?.get('size');
    if (paxSize !== undefined) {
      const text = paxSize.toString('latin1');
      if (!/^\d+$/.test(text)) return fail('Kept because a tar entry size could not be read.');
      entrySize = BigInt(text);
      if (entrySize > BigInt(Number.MAX_SAFE_INTEGER)) return fail('Kept because a tar entry size could not be read.');
    }
    if (pax && [...pax.keys()].some((key) => key.startsWith('GNU.sparse'))) return fail('Kept because there is a sparse file entry.');
    pax = null;
    longName = null;
    const dataLength = Math.ceil(Number(entrySize) / BLOCK) * BLOCK;
    if (type === '0' || type === '\0' || type === '7') entries.push({ name, size: Number(entrySize) });
    else if (type === '5') entries.push({ name: name.endsWith('/') ? name : `${name}/`, size: Number(entrySize) });
    // For a hard link that has a size, tar.exe may read the following blocks as the next entry, so it diverges from the scan (first review).
    else if (type === '1' && entrySize > 0n) return fail('Kept because there is a hard link entry with content.');
    else if (type === '1') entries.push({ name, size: null });
    else return fail(`Kept because there is a tar entry type that cannot be checked against the extracted result. (type ${JSON.stringify(type)})`);
    skip = dataLength;
  }

  function push(chunk) {
    if (reason !== null) return;
    if (ended) {
      if (pending.some((byte) => byte !== 0) || chunk.some((byte) => byte !== 0)) fail('Kept because there is other data after the tar end marker.');
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
          if (pax === null) fail('Kept because a tar extended header could not be read.');
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
    if (ended && reason === null && data.some((byte) => byte !== 0)) fail('Kept because there is other data after the tar end marker.');
    pending = ended ? Buffer.alloc(0) : Buffer.from(data);
  }

  function finish() {
    if (reason !== null) return { reason };
    if (!ended) return { reason: 'Kept because the tar end marker is missing. The end may be truncated.' };
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
    input.on('error', (err) => end({ reason: `Kept because the archive could not be read again. (${err.code})` }));
    gunzip.on('error', (err) => end({ reason: `Kept because the gzip is damaged, truncated, or has other data after it. (${err.code})` }));
    gunzip.on('data', (chunk) => checker.push(chunk));
    // If the next byte after a member is 0x00, Node stops there without an error and discards the rest (tar.exe does not read it either, first review).
    // So the number of bytes gzip really read must equal the file size.
    gunzip.on('end', () => {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch (err) {
        end({ reason: `Kept because the archive could not be read again. (${err.code})` });
        return;
      }
      if (gunzip.bytesWritten !== size) end({ reason: 'Kept because there is other data after the end of the gzip.' });
      else end(checker.finish());
    });
    input.pipe(gunzip);
  });
}

// It runs scanTarGz in a separate node process. Even a large file is not loaded into this process's memory.
function scanTarGzSync(file) {
  const { error, status, stdout } = spawnSync(process.execPath, [__filename, file], { encoding: 'utf8', maxBuffer: Infinity, windowsHide: true });
  if (error || status !== 0) return { reason: `Kept because the tar.gz content could not be checked. (${error?.code ?? status})` };
  try {
    return JSON.parse(stdout);
  } catch {
    return { reason: 'Kept because the tar.gz content could not be checked.' };
  }
}

if (require.main === module) {
  scanTarGz(process.argv[2]).then((result) => process.stdout.write(JSON.stringify(result)));
}

module.exports = { scanTarGz, scanTarGzSync, tarChecker };
