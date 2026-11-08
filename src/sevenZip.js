'use strict';

// .7z 헤더를 읽어 항목 이름(UTF-16)과 크기, CRC가 있는지 확인한다(#198).
// tar.exe(libarchive)는 CRC가 있는 항목만 풀 때 내용을 검사하므로(빌드 26200 실측: "7-Zip bad CRC"로 실패), CRC가 없는 항목은 본문이 변해도 성공으로 풀린다.
// tar.exe와 7-Zip은 헤더를 LZMA로 압축해 적으므로(EncodedHeader) 헤더를 풀 LZMA 디코더도 함께 둔다. 본문은 풀지 않는다.
// 결과는 { entries: [{ name, size, folder }] } 또는 { reason }이다.

const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const START_HEADER = 32;
// 헤더(풀린 크기)와 압축된 헤더는 이 크기까지만 읽는다. 항목 수십만 개도 이 안에 든다.
const MAX_HEADER = 64 * 1024 * 1024;

const ID = {
  END: 0x00, HEADER: 0x01, ARCHIVE_PROPERTIES: 0x02, ADDITIONAL_STREAMS: 0x03, MAIN_STREAMS: 0x04, FILES: 0x05,
  PACK_INFO: 0x06, UNPACK_INFO: 0x07, SUBSTREAMS: 0x08, SIZE: 0x09, CRC: 0x0a, FOLDER: 0x0b, CODERS_UNPACK_SIZE: 0x0c,
  NUM_UNPACK_STREAM: 0x0d, EMPTY_STREAM: 0x0e, EMPTY_FILE: 0x0f, ANTI: 0x10, NAME: 0x11, ENCODED_HEADER: 0x17, DUMMY: 0x19,
};
const LZMA = '030101';
const COPY = '00';

class Broken extends Error {}
const broken = (text) => new Broken(text);

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  byte() {
    if (this.pos >= this.buf.length) throw broken('7z 헤더가 중간에 끝나 남겼습니다.');
    return this.buf[this.pos++];
  }

  bytes(n) {
    if (n > this.buf.length - this.pos) throw broken('7z 헤더가 중간에 끝나 남겼습니다.');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  // 7z NUMBER: 첫 바이트의 앞쪽 1 비트 수만큼 뒤 바이트가 이어진다.
  number() {
    const first = this.byte();
    let mask = 0x80;
    let value = 0n;
    for (let i = 0; i < 8; i += 1) {
      if ((first & mask) === 0) {
        const high = BigInt(first & (mask - 1));
        value |= high << BigInt(8 * i);
        break;
      }
      value |= BigInt(this.byte()) << BigInt(8 * i);
      mask >>= 1;
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw broken('7z 헤더의 값이 너무 커서 남겼습니다.');
    return Number(value);
  }

  // 개수로 쓰는 NUMBER. 헤더 크기를 넘는 개수는 손상이다.
  count() {
    const value = this.number();
    if (value > this.buf.length * 8 + 8) throw broken('7z 헤더의 개수가 맞지 않아 남겼습니다.');
    return value;
  }

  uint32() {
    return this.bytes(4).readUInt32LE(0);
  }

  bits(n) {
    const out = [];
    let byte = 0;
    for (let i = 0; i < n; i += 1) {
      if (i % 8 === 0) byte = this.byte();
      out.push((byte & (0x80 >> (i % 8))) !== 0);
    }
    return out;
  }

  // allDefined 바이트와(0이면) 비트 벡터
  defined(n) {
    return this.byte() !== 0 ? new Array(n).fill(true) : this.bits(n);
  }
}

function readDigests(r, n) {
  const defined = r.defined(n);
  return defined.map((has) => (has ? r.uint32() : undefined));
}

function readPackInfo(r) {
  const packPos = r.number();
  const count = r.count();
  let sizes = [];
  for (;;) {
    const id = r.number();
    if (id === ID.END) break;
    if (id === ID.SIZE) sizes = Array.from({ length: count }, () => r.number());
    else if (id === ID.CRC) readDigests(r, count);
    else throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  }
  if (sizes.length !== count) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  return { packPos, sizes };
}

function readFolder(r) {
  const coders = [];
  const numCoders = r.count();
  if (numCoders === 0 || numCoders > 64) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  let totalIn = 0;
  let totalOut = 0;
  for (let i = 0; i < numCoders; i += 1) {
    const flags = r.byte();
    if (flags & 0x80) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
    const id = r.bytes(flags & 0x0f).toString('hex');
    const numIn = flags & 0x10 ? r.count() : 1;
    const numOut = flags & 0x10 ? r.count() : 1;
    const props = flags & 0x20 ? r.bytes(r.count()) : Buffer.alloc(0);
    coders.push({ id, numIn, numOut, props });
    totalIn += numIn;
    totalOut += numOut;
  }
  if (totalOut === 0 || totalOut > 64 || totalIn > 64) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  const bindPairs = Array.from({ length: totalOut - 1 }, () => ({ inIndex: r.count(), outIndex: r.count() }));
  const numPacked = totalIn - bindPairs.length;
  if (numPacked < 1) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  if (numPacked > 1) for (let i = 0; i < numPacked; i += 1) r.count();
  return { coders, totalOut, bindPairs, numPacked };
}

function readUnpackInfo(r) {
  if (r.number() !== ID.FOLDER) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  const count = r.count();
  if (r.byte() !== 0) throw broken('7z 헤더가 다른 곳을 가리켜 남겼습니다.');
  const folders = Array.from({ length: count }, () => readFolder(r));
  if (r.number() !== ID.CODERS_UNPACK_SIZE) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  for (const folder of folders) {
    folder.outSizes = Array.from({ length: folder.totalOut }, () => r.number());
    const bound = new Set(folder.bindPairs.map((pair) => pair.outIndex));
    const main = [...folder.outSizes.keys()].filter((i) => !bound.has(i));
    if (main.length !== 1) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
    folder.unpackSize = folder.outSizes[main[0]];
  }
  for (;;) {
    const id = r.number();
    if (id === ID.END) break;
    if (id === ID.CRC) readDigests(r, count).forEach((crc, i) => { folders[i].crc = crc; });
    else throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  }
  return folders;
}

// 폴더마다 풀린 스트림(파일 내용)의 크기와 CRC
function readSubStreams(r, folders) {
  const counts = folders.map(() => 1);
  let id = r.number();
  if (id === ID.NUM_UNPACK_STREAM) {
    folders.forEach((_, i) => { counts[i] = r.count(); });
    id = r.number();
  }
  const streams = [];
  const sizes = [];
  if (id === ID.SIZE) {
    folders.forEach((folder, i) => {
      if (counts[i] === 0) return;
      let sum = 0;
      for (let j = 0; j < counts[i] - 1; j += 1) {
        const size = r.number();
        sum += size;
        sizes.push(size);
      }
      if (sum > folder.unpackSize) throw broken('7z 헤더의 크기가 맞지 않아 남겼습니다.');
      sizes.push(folder.unpackSize - sum);
    });
    id = r.number();
  } else {
    folders.forEach((folder, i) => {
      if (counts[i] > 1) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
      if (counts[i] === 1) sizes.push(folder.unpackSize);
    });
  }
  const needDigest = folders.reduce((n, folder, i) => n + (counts[i] === 1 && folder.crc !== undefined ? 0 : counts[i]), 0);
  let digests = new Array(needDigest).fill(undefined);
  for (; id !== ID.END; id = r.number()) {
    if (id === ID.CRC) digests = readDigests(r, needDigest);
    else throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  }
  let next = 0;
  let at = 0;
  folders.forEach((folder, i) => {
    for (let j = 0; j < counts[i]; j += 1) {
      const crc = counts[i] === 1 && folder.crc !== undefined ? folder.crc : digests[next++];
      streams.push({ size: sizes[at++], crc });
    }
  });
  return streams;
}

function readStreamsInfo(r) {
  const info = { pack: null, folders: [], streams: null };
  for (;;) {
    const id = r.number();
    if (id === ID.END) break;
    if (id === ID.PACK_INFO) info.pack = readPackInfo(r);
    else if (id === ID.UNPACK_INFO) info.folders = readUnpackInfo(r);
    else if (id === ID.SUBSTREAMS) info.streams = readSubStreams(r, info.folders);
    else throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  }
  info.streams ??= info.folders.map((folder) => ({ size: folder.unpackSize, crc: folder.crc }));
  const packed = info.folders.reduce((n, folder) => n + folder.numPacked, 0);
  if ((info.pack?.sizes.length ?? 0) !== packed) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
  return info;
}

function readFiles(r) {
  const count = r.count();
  let emptyStream = new Array(count).fill(false);
  let emptyFile = [];
  let names = null;
  for (;;) {
    const type = r.number();
    if (type === ID.END) break;
    const size = r.number();
    const body = new Reader(r.bytes(size));
    if (type === ID.EMPTY_STREAM) {
      emptyStream = body.bits(count);
    } else if (type === ID.EMPTY_FILE) {
      emptyFile = body.bits(emptyStream.filter(Boolean).length);
    } else if (type === ID.ANTI) {
      throw broken('7z에 지우기 표시 항목이 있어 남겼습니다.');
    } else if (type === ID.NAME) {
      if (body.byte() !== 0) throw broken('7z 헤더가 다른 곳을 가리켜 남겼습니다.');
      const text = body.bytes(body.buf.length - 1);
      if (text.length % 2 !== 0) throw broken('7z 항목 이름을 읽지 못해 남겼습니다.');
      names = [];
      let start = 0;
      for (let i = 0; i < text.length; i += 2) {
        if (text.readUInt16LE(i) !== 0) continue;
        names.push(text.subarray(start, i).toString('utf16le'));
        start = i + 2;
      }
      if (start !== text.length || names.length !== count) throw broken('7z 항목 이름을 읽지 못해 남겼습니다.');
    }
  }
  if (names === null && count > 0) throw broken('7z 항목 이름이 없어 남겼습니다.');
  return { count, emptyStream, emptyFile, names: names ?? [] };
}

// LZMA 디코더(LZMA SDK의 LzmaSpec과 같은 순서). 풀린 크기를 알 때 그만큼만 푼다. 출력 버퍼가 사전이다.
function lzmaDecode(props, input, outSize) {
  if (props.length < 5 || props[0] >= 9 * 5 * 5) throw broken('7z 헤더의 LZMA 설정을 읽지 못해 남겼습니다.');
  const lc = props[0] % 9;
  const lp = Math.floor(props[0] / 9) % 5;
  const pb = Math.floor(props[0] / 45);
  const out = Buffer.alloc(outSize);
  let inPos = 0;
  const next = () => {
    if (inPos >= input.length) throw broken('7z 헤더의 압축 데이터가 중간에 끝나 남겼습니다.');
    return input[inPos++];
  };
  let range = 0xffffffff;
  let code = 0;
  if (next() !== 0) throw broken('7z 헤더의 압축 데이터가 손상돼 남겼습니다.');
  for (let i = 0; i < 4; i += 1) code = ((code << 8) | next()) >>> 0;
  if (code === range) throw broken('7z 헤더의 압축 데이터가 손상돼 남겼습니다.');
  const probs = (n) => new Uint16Array(n).fill(1024);
  const bit = (p, i) => {
    const v = p[i];
    const bound = (range >>> 11) * v;
    let b;
    if (code < bound) {
      p[i] = v + ((2048 - v) >>> 5);
      range = bound;
      b = 0;
    } else {
      p[i] = v - (v >>> 5);
      code -= bound;
      range -= bound;
      b = 1;
    }
    if (range < 0x1000000) {
      range = (range * 256) >>> 0;
      code = ((code * 256) + next()) >>> 0;
    }
    return b;
  };
  const direct = (n) => {
    let res = 0;
    for (let i = 0; i < n; i += 1) {
      range >>>= 1;
      let t = 0;
      if (code >= range) {
        code -= range;
        t = 1;
      }
      res = ((res * 2) + t) >>> 0;
      if (range < 0x1000000) {
        range = (range * 256) >>> 0;
        code = ((code * 256) + next()) >>> 0;
      }
    }
    return res;
  };
  const tree = (p, base, n) => {
    let m = 1;
    for (let i = 0; i < n; i += 1) m = (m << 1) + bit(p, base + m);
    return m - (1 << n);
  };
  const reverse = (p, base, n) => {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < n; i += 1) {
      const b = bit(p, base + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  };
  const lengthCoder = () => ({ choice: probs(2), low: probs(16 << 3), mid: probs(16 << 3), high: probs(256) });
  const length = (c, posState) => {
    if (bit(c.choice, 0) === 0) return tree(c.low, posState << 3, 3);
    if (bit(c.choice, 1) === 0) return 8 + tree(c.mid, posState << 3, 3);
    return 16 + tree(c.high, 0, 8);
  };
  const literal = probs(0x300 << (lc + lp));
  const isMatch = probs(12 << 4);
  const isRep = probs(12);
  const isRepG0 = probs(12);
  const isRepG1 = probs(12);
  const isRepG2 = probs(12);
  const isRep0Long = probs(12 << 4);
  const posSlot = probs(4 << 6);
  const posDecoders = probs(115);
  const align = probs(16);
  const lenCoder = lengthCoder();
  const repLenCoder = lengthCoder();
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let pos = 0;
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  while (pos < outSize) {
    const posState = pos & pbMask;
    if (bit(isMatch, (state << 4) + posState) === 0) {
      const prev = pos > 0 ? out[pos - 1] : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let match = out[pos - rep0 - 1];
        do {
          const matchBit = (match >> 7) & 1;
          match <<= 1;
          const b = bit(literal, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | b;
          if (matchBit !== b) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | bit(literal, base + symbol);
      out[pos++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len;
    if (bit(isRep, state) !== 0) {
      if (pos === 0) throw broken('7z 헤더의 압축 데이터가 손상돼 남겼습니다.');
      if (bit(isRepG0, state) === 0) {
        if (bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1];
          pos += 1;
          continue;
        }
      } else {
        let dist;
        if (bit(isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (bit(isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = length(repLenCoder, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = length(lenCoder, posState);
      state = state < 7 ? 7 : 10;
      const lenState = len < 3 ? len : 3;
      const slot = tree(posSlot, lenState << 6, 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const numDirect = (slot >> 1) - 1;
        let dist = ((2 | (slot & 1)) << numDirect) >>> 0;
        if (slot < 14) dist += reverse(posDecoders, dist - slot, numDirect);
        else dist += direct(numDirect - 4) * 16 + reverse(align, 0, 4);
        rep0 = dist >>> 0;
      }
      if (rep0 === 0xffffffff) break;
      if (rep0 >= pos) throw broken('7z 헤더의 압축 데이터가 손상돼 남겼습니다.');
    }
    len += 2;
    if (len > outSize - pos) throw broken('7z 헤더의 압축 데이터가 손상돼 남겼습니다.');
    for (let i = 0; i < len; i += 1) {
      out[pos] = out[pos - rep0 - 1];
      pos += 1;
    }
  }
  if (pos !== outSize) throw broken('7z 헤더의 압축 데이터가 중간에 끝나 남겼습니다.');
  return out;
}

// read(offset, length)로 파일 일부를 읽는다. size는 파일 크기다.
function readSevenZip(read, size) {
  try {
    if (size < START_HEADER) throw broken('7z 헤더가 중간에 끝나 남겼습니다.');
    const start = read(0, START_HEADER);
    if (!start.subarray(0, 6).equals(SIGNATURE)) throw broken('내용이 7z로 시작하지 않아 남겼습니다.');
    if (zlib.crc32(start.subarray(12, 32)) !== start.readUInt32LE(8)) throw broken('7z 시작 헤더의 CRC가 맞지 않아 남겼습니다.');
    const nextOffset = start.readBigUInt64LE(12);
    const nextSize = start.readBigUInt64LE(20);
    if (BigInt(START_HEADER) + nextOffset + nextSize !== BigInt(size)) throw broken('7z 끝 뒤에 다른 데이터가 있어 남겼습니다.');
    if (nextSize > BigInt(MAX_HEADER)) throw broken('7z 헤더가 너무 커서 남겼습니다.');
    const headerAt = START_HEADER + Number(nextOffset);
    let header = read(headerAt, Number(nextSize));
    if (zlib.crc32(header) !== start.readUInt32LE(28)) throw broken('7z 헤더의 CRC가 맞지 않아 남겼습니다.');
    // 본문과 압축된 헤더가 차지하는 자리. 시작 헤더 뒤부터 헤더 앞까지 빈틈없이 이어져야 목록에 없는 데이터가 없다.
    const ranges = [];
    const addPack = (pack) => {
      let at = START_HEADER + (pack?.packPos ?? 0);
      for (const length of pack?.sizes ?? []) {
        ranges.push([at, at + length]);
        at += length;
      }
    };
    for (let depth = 0; ; depth += 1) {
      const r = new Reader(header);
      const id = r.number();
      if (id === ID.HEADER) break;
      if (id !== ID.ENCODED_HEADER || depth >= 4) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
      const info = readStreamsInfo(r);
      if (info.folders.length !== 1 || info.pack.sizes.length !== 1) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
      const [folder] = info.folders;
      const [coder] = folder.coders;
      if (folder.coders.length !== 1 || ![LZMA, COPY].includes(coder.id)) throw broken('7z 헤더의 압축 방식을 읽지 못해 남겼습니다.');
      if (folder.crc === undefined) throw broken('7z 헤더에 CRC가 없어 남겼습니다.');
      const packSize = info.pack.sizes[0];
      if (packSize > MAX_HEADER || folder.unpackSize > MAX_HEADER) throw broken('7z 헤더가 너무 커서 남겼습니다.');
      const packAt = START_HEADER + info.pack.packPos;
      if (packAt + packSize > headerAt) throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
      addPack(info.pack);
      const packed = read(packAt, packSize);
      header = coder.id === COPY ? packed.subarray(0, folder.unpackSize) : lzmaDecode(coder.props, packed, folder.unpackSize);
      if (header.length !== folder.unpackSize || zlib.crc32(header) !== folder.crc) throw broken('7z 헤더의 CRC가 맞지 않아 남겼습니다.');
    }
    const r = new Reader(header);
    r.number();
    let main = { pack: null, folders: [], streams: [] };
    let files = { count: 0, emptyStream: [], emptyFile: [], names: [] };
    for (;;) {
      const id = r.number();
      if (id === ID.END) break;
      if (id === ID.ARCHIVE_PROPERTIES) {
        for (let type = r.number(); type !== ID.END; type = r.number()) r.bytes(r.number());
      } else if (id === ID.MAIN_STREAMS) {
        main = readStreamsInfo(r);
      } else if (id === ID.FILES) {
        files = readFiles(r);
      } else {
        throw broken('7z 헤더의 구조를 읽지 못해 남겼습니다.');
      }
    }
    addPack(main.pack);
    ranges.sort((a, b) => a[0] - b[0]);
    let at = START_HEADER;
    for (const [from, to] of ranges) {
      if (from !== at) throw broken('7z 항목 사이에 목록에 없는 데이터가 있어 남겼습니다.');
      at = to;
    }
    if (at !== headerAt) throw broken('7z 항목 사이에 목록에 없는 데이터가 있어 남겼습니다.');
    const entries = [];
    let stream = 0;
    let empty = 0;
    for (let i = 0; i < files.count; i += 1) {
      const name = files.names[i];
      if (files.emptyStream[i]) {
        const isFile = files.emptyFile[empty++] === true;
        entries.push({ name, size: 0, folder: !isFile });
        continue;
      }
      const item = main.streams[stream++];
      if (item === undefined) throw broken('7z 항목과 내용의 수가 맞지 않아 남겼습니다.');
      if (item.crc === undefined) throw broken(`CRC가 없어 내용이 온전한지 확인할 수 없는 항목이 있어 남겼습니다: ${JSON.stringify(name)}`);
      entries.push({ name, size: item.size, folder: false });
    }
    if (stream !== main.streams.length) throw broken('7z 항목과 내용의 수가 맞지 않아 남겼습니다.');
    return { entries };
  } catch (err) {
    if (err instanceof Broken) return { reason: err.message };
    throw err;
  }
}

module.exports = { readSevenZip, lzmaDecode };
