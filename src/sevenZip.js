'use strict';

// It reads the .7z header and checks the entry names (UTF-16), sizes, and whether a CRC exists (#198).
// tar.exe (libarchive) checks the content when extracting only entries that have a CRC (measured on build 26200: it fails with "7-Zip bad CRC"), so an entry without a CRC extracts as a success even if the body changed.
// tar.exe and 7-Zip write the header compressed with LZMA (EncodedHeader), so an LZMA decoder to decode the header is also included. The body is not decoded.
// The result is { entries: [{ name, size, folder }] } or { reason }.

const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const START_HEADER = 32;
// The header (decoded size) and the compressed header are read only up to this size. Hundreds of thousands of entries fit within it.
const MAX_HEADER = 64 * 1024 * 1024;

const ID = {
  END: 0x00, HEADER: 0x01, ARCHIVE_PROPERTIES: 0x02, ADDITIONAL_STREAMS: 0x03, MAIN_STREAMS: 0x04, FILES: 0x05,
  PACK_INFO: 0x06, UNPACK_INFO: 0x07, SUBSTREAMS: 0x08, SIZE: 0x09, CRC: 0x0a, FOLDER: 0x0b, CODERS_UNPACK_SIZE: 0x0c,
  NUM_UNPACK_STREAM: 0x0d, EMPTY_STREAM: 0x0e, EMPTY_FILE: 0x0f, ANTI: 0x10, NAME: 0x11, ENCODED_HEADER: 0x17, DUMMY: 0x19,
};
const LZMA = '030101';
const LZMA2 = '21';
const COPY = '00';

class Broken extends Error {}
const broken = (text) => new Broken(text);

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  byte() {
    if (this.pos >= this.buf.length) throw broken('Kept because the 7z header ends prematurely.');
    return this.buf[this.pos++];
  }

  bytes(n) {
    if (n > this.buf.length - this.pos) throw broken('Kept because the 7z header ends prematurely.');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  // 7z NUMBER: as many following bytes continue as the number of leading 1 bits in the first byte.
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
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw broken('Kept because a value in the 7z header is too large.');
    return Number(value);
  }

  // A NUMBER used as a count. A count larger than the header size is damage.
  count() {
    const value = this.number();
    if (value > this.buf.length * 8 + 8) throw broken('Kept because a count in the 7z header does not add up.');
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

  // The allDefined byte and (if 0) the bit vector
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
    // Like libarchive, kSize must come first. Before that, it does not build the CRC array with a large count (second review).
    else if (id === ID.CRC && sizes.length === count) readDigests(r, count);
    else throw broken('Kept because the 7z header structure could not be read.');
  }
  if (sizes.length !== count) throw broken('Kept because the 7z header structure could not be read.');
  return { packPos, sizes };
}

function readFolder(r) {
  const coders = [];
  const numCoders = r.count();
  if (numCoders === 0 || numCoders > 64) throw broken('Kept because the 7z header structure could not be read.');
  let totalIn = 0;
  let totalOut = 0;
  for (let i = 0; i < numCoders; i += 1) {
    const flags = r.byte();
    if (flags & 0x80) throw broken('Kept because the 7z header structure could not be read.');
    const id = r.bytes(flags & 0x0f).toString('hex');
    const numIn = flags & 0x10 ? r.count() : 1;
    const numOut = flags & 0x10 ? r.count() : 1;
    const props = flags & 0x20 ? r.bytes(r.count()) : Buffer.alloc(0);
    coders.push({ id, numIn, numOut, props });
    totalIn += numIn;
    totalOut += numOut;
  }
  if (totalOut === 0 || totalOut > 64 || totalIn > 64) throw broken('Kept because the 7z header structure could not be read.');
  const bindPairs = Array.from({ length: totalOut - 1 }, () => ({ inIndex: r.count(), outIndex: r.count() }));
  const numPacked = totalIn - bindPairs.length;
  if (numPacked < 1) throw broken('Kept because the 7z header structure could not be read.');
  if (numPacked > 1) for (let i = 0; i < numPacked; i += 1) r.count();
  return { coders, totalOut, bindPairs, numPacked };
}

function readUnpackInfo(r) {
  if (r.number() !== ID.FOLDER) throw broken('Kept because the 7z header structure could not be read.');
  const count = r.count();
  if (r.byte() !== 0) throw broken('Kept because the 7z header points elsewhere.');
  const folders = Array.from({ length: count }, () => readFolder(r));
  if (r.number() !== ID.CODERS_UNPACK_SIZE) throw broken('Kept because the 7z header structure could not be read.');
  for (const folder of folders) {
    folder.outSizes = Array.from({ length: folder.totalOut }, () => r.number());
    const bound = new Set(folder.bindPairs.map((pair) => pair.outIndex));
    const main = [...folder.outSizes.keys()].filter((i) => !bound.has(i));
    if (main.length !== 1) throw broken('Kept because the 7z header structure could not be read.');
    folder.unpackSize = folder.outSizes[main[0]];
  }
  for (;;) {
    const id = r.number();
    if (id === ID.END) break;
    if (id === ID.CRC) readDigests(r, count).forEach((crc, i) => { folders[i].crc = crc; });
    else throw broken('Kept because the 7z header structure could not be read.');
  }
  return folders;
}

// The size and CRC of the decoded stream (file content) of each folder
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
      if (sum > folder.unpackSize) throw broken('Kept because a size in the 7z header does not add up.');
      sizes.push(folder.unpackSize - sum);
    });
    id = r.number();
  } else {
    folders.forEach((folder, i) => {
      if (counts[i] > 1) throw broken('Kept because the 7z header structure could not be read.');
      if (counts[i] === 1) sizes.push(folder.unpackSize);
    });
  }
  const needDigest = folders.reduce((n, folder, i) => n + (counts[i] === 1 && folder.crc !== undefined ? 0 : counts[i]), 0);
  let digests = new Array(needDigest).fill(undefined);
  // libarchive moves the folder CRC to the entry CRC and checks it only when this block has kCRC. If there is no kCRC, even when the folder CRC exists,
  // it does not check the content and extracts as a success even if the body changed (measured in the first review). So in that case it sees every entry as having no CRC.
  let hasCrcBlock = false;
  for (; id !== ID.END; id = r.number()) {
    if (id !== ID.CRC) throw broken('Kept because the 7z header structure could not be read.');
    digests = readDigests(r, needDigest);
    hasCrcBlock = true;
  }
  let next = 0;
  let at = 0;
  folders.forEach((folder, i) => {
    for (let j = 0; j < counts[i]; j += 1) {
      const fromFolder = counts[i] === 1 && folder.crc !== undefined;
      const digest = fromFolder ? folder.crc : digests[next++];
      const crc = hasCrcBlock ? digest : undefined;
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
    else throw broken('Kept because the 7z header structure could not be read.');
  }
  // Without SubStreamsInfo, tar.exe cannot extract (measured in the first review). By the same criterion it is seen as no CRC.
  info.streams ??= info.folders.map((folder) => ({ size: folder.unpackSize, crc: undefined }));
  const packed = info.folders.reduce((n, folder) => n + folder.numPacked, 0);
  if ((info.pack?.sizes.length ?? 0) !== packed) throw broken('Kept because the 7z header structure could not be read.');
  return info;
}

function readFiles(r) {
  // Each entry must have a name (at least 2 bytes including the trailing NUL), so the count cannot exceed half the remaining header length (so as not to build a large array, first review).
  const count = r.number();
  if (count > (r.buf.length - r.pos) / 2) throw broken('Kept because a count in the 7z header does not add up.');
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
      throw broken('Kept because the 7z has an item marked as deleted.');
    } else if (type === ID.NAME) {
      if (body.byte() !== 0) throw broken('Kept because the 7z header points elsewhere.');
      const text = body.bytes(body.buf.length - 1);
      if (text.length % 2 !== 0) throw broken('Kept because the 7z entry names could not be read.');
      names = [];
      let start = 0;
      for (let i = 0; i < text.length; i += 2) {
        if (text.readUInt16LE(i) !== 0) continue;
        names.push(text.subarray(start, i).toString('utf16le'));
        start = i + 2;
      }
      if (start !== text.length || names.length !== count) throw broken('Kept because the 7z entry names could not be read.');
    }
  }
  if (names === null && count > 0) throw broken('Kept because the 7z has no entry names.');
  return { count, emptyStream, emptyFile, names: names ?? [] };
}

// The LZMA decoder (in the same order as LzmaSpec of the LZMA SDK). The out buffer is the dictionary. LZMA2 (#222) restarts the range decoder for each chunk and
// carries over only the state and properties, so it is kept as a decoder with state. run(input, from, to, end) reads input[from..to) with the range decoder and fills out up to end.
function lzmaDecoder(out) {
  let lc = 0;
  let lp = 0;
  let pb = 0;
  let pos = 0;
  let range = 0;
  let code = 0;
  let input = null;
  let inPos = 0;
  let inEnd = 0;
  const next = () => {
    if (inPos >= inEnd) throw broken('Kept because the compressed data of the 7z header ends prematurely.');
    return input[inPos++];
  };
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
  let literal;
  let isMatch;
  let isRep;
  let isRepG0;
  let isRepG1;
  let isRepG2;
  let isRep0Long;
  let posSlot;
  let posDecoders;
  let align;
  let lenCoder;
  let repLenCoder;
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  // The dictionary start position. A distance that points before it is damage (the dictionary reset of LZMA2).
  let dictStart = 0;

  // maxLcLp is the lc+lp limit of LZMA2 (4, LZMA_LCLP_MAX of xz). If the state is reset often with a larger value, a large table would be filled each time (first review).
  function setProps(byte, maxLcLp = Infinity) {
    if (byte >= 9 * 5 * 5) throw broken('Kept because the LZMA settings of the 7z header could not be read.');
    lc = byte % 9;
    lp = Math.floor(byte / 9) % 5;
    pb = Math.floor(byte / 45);
    if (lc + lp > maxLcLp) throw broken('Kept because the LZMA2 settings of the 7z header could not be read.');
  }

  function resetState() {
    // If the size is the same, it refills the table instead of making a new one.
    const size = 0x300 << (lc + lp);
    if (literal?.length === size) literal.fill(1024);
    else literal = probs(size);
    isMatch = probs(12 << 4);
    isRep = probs(12);
    isRepG0 = probs(12);
    isRepG1 = probs(12);
    isRepG2 = probs(12);
    isRep0Long = probs(12 << 4);
    posSlot = probs(4 << 6);
    posDecoders = probs(115);
    align = probs(16);
    lenCoder = lengthCoder();
    repLenCoder = lengthCoder();
    state = 0;
    rep0 = 0;
    rep1 = 0;
    rep2 = 0;
    rep3 = 0;
  }

  // If it meets the end marker (distance 0xFFFFFFFF), it returns true. If allowEnd is not set, even an end marker is damage.
  function run(data, from, to, end, allowEnd) {
    input = data;
    inPos = from;
    inEnd = to;
    range = 0xffffffff;
    code = 0;
    if (next() !== 0) throw broken('Kept because the compressed data of the 7z header is damaged.');
    for (let i = 0; i < 4; i += 1) code = ((code << 8) | next()) >>> 0;
    if (code === range) throw broken('Kept because the compressed data of the 7z header is damaged.');
    const pbMask = (1 << pb) - 1;
    const lpMask = (1 << lp) - 1;
    while (pos < end) {
      const posState = pos & pbMask;
      if (bit(isMatch, (state << 4) + posState) === 0) {
        // At a position where the dictionary was reset, the previous byte is seen as 0 (first review).
        const prev = pos > dictStart ? out[pos - 1] : 0;
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
        if (pos === dictStart) throw broken('Kept because the compressed data of the 7z header is damaged.');
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
        if (rep0 === 0xffffffff) {
          if (!allowEnd) throw broken('Kept because the compressed data of the 7z header is damaged.');
          return true;
        }
      }
      if (rep0 >= pos - dictStart) throw broken('Kept because the compressed data of the 7z header is damaged.');
      len += 2;
      if (len > end - pos) throw broken('Kept because the compressed data of the 7z header is damaged.');
      for (let i = 0; i < len; i += 1) {
        out[pos] = out[pos - rep0 - 1];
        pos += 1;
      }
    }
    return false;
  }

  return {
    setProps,
    resetState,
    run,
    get pos() { return pos; },
    set pos(value) { pos = value; },
    resetDict() { dictStart = pos; },
    // The position the range decoder read up to (to check that an LZMA2 chunk was read exactly by its compressed size)
    get consumed() { return inPos; },
  };
}

// The 7z LZMA coder: after the 5 property bytes (lc, lp, pb and the dictionary size), the range decoder data continues.
function lzmaDecode(props, input, outSize) {
  if (props.length < 5) throw broken('Kept because the LZMA settings of the 7z header could not be read.');
  const out = Buffer.alloc(outSize);
  const lzma = lzmaDecoder(out);
  lzma.setProps(props[0]);
  lzma.resetState();
  lzma.run(input, 0, input.length, outSize, true);
  if (lzma.pos !== outSize) throw broken('Kept because the compressed data of the 7z header ends prematurely.');
  return out;
}

// The 7z LZMA2 coder (#222): 1 property byte (the dictionary size) and chunks. Control byte 0 is the end, 1 and 2 are uncompressed chunks (1 resets the dictionary),
// 0x80 or more is an LZMA chunk. Bits 5 to 6 of an LZMA chunk are the reset level (0 none, 1 state, 2 state+properties, 3 state+properties+dictionary),
// the decoded size is bits 0 to 4 plus the next 2 bytes, and the compressed size is the 2 bytes after that (both plus 1). The range decoder restarts for each chunk.
// The first chunk must reset the dictionary, and the first LZMA chunk after a dictionary reset (0x01, 0xE0 or more) must set the properties (the same conditions as xz and the LZMA SDK).
// After an uncompressed chunk (0x02), the state and the rep distances carry on as they are (second review: xz does not require a state reset here).
function lzma2Decode(props, input, outSize) {
  if (props.length < 1 || props[0] > 40) throw broken('Kept because the LZMA2 settings of the 7z header could not be read.');
  const out = Buffer.alloc(outSize);
  const lzma = lzmaDecoder(out);
  let at = 0;
  let first = true;
  let haveProps = false;
  const byte = () => {
    if (at >= input.length) throw broken('Kept because the compressed data of the 7z header ends prematurely.');
    return input[at++];
  };
  for (;;) {
    const control = byte();
    if (control === 0x00) break;
    if (first && control !== 0x01 && control < 0xe0) throw broken('Kept because the compressed data of the 7z header is damaged.');
    first = false;
    if (control === 0x01 || control === 0x02) {
      const size = ((byte() << 8) | byte()) + 1;
      // If the dictionary is reset, the next LZMA chunk must also set the properties again (the same conditions as xz and the LZMA SDK, first review).
      if (control === 0x01) {
        lzma.resetDict();
        haveProps = false;
      }
      if (size > outSize - lzma.pos || size > input.length - at) throw broken('Kept because the compressed data of the 7z header is damaged.');
      input.copy(out, lzma.pos, at, at + size);
      lzma.pos += size;
      at += size;
      continue;
    }
    if (control < 0x80) throw broken('Kept because the compressed data of the 7z header is damaged.');
    const reset = (control >> 5) & 3;
    const unpacked = (((control & 0x1f) << 16) | (byte() << 8) | byte()) + 1;
    const packed = ((byte() << 8) | byte()) + 1;
    if (reset === 3) lzma.resetDict();
    if (reset >= 2) {
      lzma.setProps(byte(), 4);
      haveProps = true;
    }
    if (!haveProps) throw broken('Kept because the compressed data of the 7z header is damaged.');
    if (reset >= 1) lzma.resetState();
    if (unpacked > outSize - lzma.pos || packed > input.length - at) throw broken('Kept because the compressed data of the 7z header is damaged.');
    lzma.run(input, at, at + packed, lzma.pos + unpacked, false);
    // A chunk must be read exactly by its compressed size (the same condition as xz, first review).
    if (lzma.consumed !== at + packed) throw broken('Kept because the compressed data of the 7z header is damaged.');
    at += packed;
  }
  if (lzma.pos !== outSize) throw broken('Kept because the compressed data of the 7z header ends prematurely.');
  return out;
}

// It reads part of the file with read(offset, length). size is the file size.
function readSevenZip(read, size) {
  try {
    if (size < START_HEADER) throw broken('Kept because the 7z header ends prematurely.');
    const start = read(0, START_HEADER);
    if (!start.subarray(0, 6).equals(SIGNATURE)) throw broken('Kept because the content does not start as a 7z.');
    if (zlib.crc32(start.subarray(12, 32)) !== start.readUInt32LE(8)) throw broken('Kept because the CRC of the 7z start header does not match.');
    const nextOffset = start.readBigUInt64LE(12);
    const nextSize = start.readBigUInt64LE(20);
    if (BigInt(START_HEADER) + nextOffset + nextSize !== BigInt(size)) throw broken('Kept because there is other data after the end of the 7z.');
    if (nextSize > BigInt(MAX_HEADER)) throw broken('Kept because the 7z header is too large.');
    const headerAt = START_HEADER + Number(nextOffset);
    let header = read(headerAt, Number(nextSize));
    if (zlib.crc32(header) !== start.readUInt32LE(28)) throw broken('Kept because the CRC of the 7z header does not match.');
    // The positions that the bodies and the compressed header take up. They must continue without a gap from after the start header to before the header, so that there is no data not in the list.
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
      if (id !== ID.ENCODED_HEADER || depth >= 4) throw broken('Kept because the 7z header structure could not be read.');
      const info = readStreamsInfo(r);
      if (info.folders.length !== 1 || info.pack.sizes.length !== 1) throw broken('Kept because the 7z header structure could not be read.');
      const [folder] = info.folders;
      const [coder] = folder.coders;
      if (folder.coders.length !== 1 || ![LZMA, LZMA2, COPY].includes(coder.id)) throw broken('Kept because the compression method of the 7z header could not be read.');
      if (folder.crc === undefined) throw broken('Kept because the 7z header has no CRC.');
      const packSize = info.pack.sizes[0];
      if (packSize > MAX_HEADER || folder.unpackSize > MAX_HEADER) throw broken('Kept because the 7z header is too large.');
      const packAt = START_HEADER + info.pack.packPos;
      if (packAt + packSize > headerAt) throw broken('Kept because the 7z header structure could not be read.');
      addPack(info.pack);
      const packed = read(packAt, packSize);
      const decode = { [LZMA]: lzmaDecode, [LZMA2]: lzma2Decode }[coder.id];
      header = decode === undefined ? packed.subarray(0, folder.unpackSize) : decode(coder.props, packed, folder.unpackSize);
      if (header.length !== folder.unpackSize || zlib.crc32(header) !== folder.crc) throw broken('Kept because the CRC of the 7z header does not match.');
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
        throw broken('Kept because the 7z header structure could not be read.');
      }
    }
    addPack(main.pack);
    ranges.sort((a, b) => a[0] - b[0]);
    let at = START_HEADER;
    for (const [from, to] of ranges) {
      if (from !== at) throw broken('Kept because there is data between 7z entries that is not in the listing.');
      at = to;
    }
    if (at !== headerAt) throw broken('Kept because there is data between 7z entries that is not in the listing.');
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
      if (item === undefined) throw broken('Kept because the number of 7z entries and contents does not match.');
      if (item.crc === undefined) throw broken(`Kept because an item has no CRC, so its content cannot be confirmed intact: ${JSON.stringify(name)}`);
      entries.push({ name, size: item.size, folder: false });
    }
    if (stream !== main.streams.length) throw broken('Kept because the number of 7z entries and contents does not match.');
    return { entries };
  } catch (err) {
    if (err instanceof Broken) return { reason: err.message };
    throw err;
  }
}

module.exports = { readSevenZip, lzmaDecode, lzma2Decode };
