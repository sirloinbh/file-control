'use strict';

// The LZMA and LZMA2 decoders used to read the compressed 7z header (#198, #222). The body of a 7z is never decoded.
// Damage is raised as an LzmaError, and readSevenZip turns it into a reason.

class LzmaError extends Error {}
const broken = (text) => new LzmaError(text);

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

module.exports = { lzmaDecode, lzma2Decode, LzmaError };
