'use strict';

// 시험용 H.264·HEVC SPS와 avcC·hvcC를 규격대로 만든다(#113). 테스트 파일이 아니라 도우미다.

function bitWriter() {
  const out = [];
  const w = {
    u(count, value) {
      for (let i = count - 1; i >= 0; i -= 1) out.push(Math.floor(value / 2 ** i) % 2);
      return w;
    },
    ue(value) {
      const code = value + 1;
      const length = code.toString(2).length;
      for (let i = 0; i < length - 1; i += 1) out.push(0);
      return w.u(length, code);
    },
    se(value) {
      return w.ue(value <= 0 ? -2 * value : 2 * value - 1);
    },
    // rbsp_trailing_bits를 붙여 바이트로 만든다.
    bytes() {
      const bits = [...out, 1];
      while (bits.length % 8 !== 0) bits.push(0);
      const bytes = [];
      for (let i = 0; i < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((acc, bit) => acc * 2 + bit, 0));
      return bytes;
    },
  };
  return w;
}

// 0 두 바이트 뒤에 3 이하의 바이트가 오면 3을 끼운다(emulation prevention).
function escape(bytes) {
  const out = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out;
}

// VUI의 앞부분. sar가 숫자면 aspect_ratio_idc, [h, v]면 255(직접 적음)로 쓴다. 뒤에는 다른 VUI 필드처럼 보이는 비트를 붙인다.
function writeVui(w, sar) {
  if (sar === undefined) return w.u(1, 0);
  w.u(1, 1);
  if (sar === null) w.u(1, 0);
  else if (Array.isArray(sar)) w.u(1, 1).u(8, 255).u(16, sar[0]).u(16, sar[1]);
  else w.u(1, 1).u(8, sar);
  return w.u(1, 0).u(1, 1).u(3, 5);
}

// H.264 SPS. sar: undefined면 VUI 없음, null이면 VUI는 있지만 비율 없음.
// scaling: 높은 프로필의 scaling list. 목록 번호 => delta 값들(next가 0이 되면 그 뒤는 쓰지 않는다).
function avcSps({ profile = 100, width = 1920, height = 1088, crop = null, pocType = 0, frameMbsOnly = 1, chroma = 1, scaling = null, sar } = {}) {
  const w = bitWriter();
  w.u(8, profile).u(8, 0).u(8, 40).ue(0);
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    w.ue(chroma);
    if (chroma === 3) w.u(1, 0);
    w.ue(0).ue(0).u(1, 0);
    w.u(1, scaling ? 1 : 0);
    if (scaling) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i += 1) {
        w.u(1, scaling[i] ? 1 : 0);
        for (const delta of scaling[i] ?? []) w.se(delta);
      }
    }
  }
  w.ue(0).ue(pocType);
  if (pocType === 0) w.ue(2);
  if (pocType === 1) w.u(1, 0).se(-1).se(2).ue(2).se(3).se(-4);
  w.ue(4).u(1, 0).ue(width / 16 - 1).ue(height / (16 * (2 - frameMbsOnly)) - 1).u(1, frameMbsOnly);
  if (!frameMbsOnly) w.u(1, 1);
  w.u(1, 1);
  w.u(1, crop ? 1 : 0);
  if (crop) crop.forEach((value) => w.ue(value));
  writeVui(w, sar);
  return Buffer.from([0x67, ...escape(w.bytes())]);
}

// HEVC SPS. sets: st_ref_pic_set 목록. { negative, positive } 또는 { inter: [[used, useDelta], ...] }.
function hevcSps({ width = 1920, height = 1080, maxSubLayers = 1, subLayers = [], conformance = null, ordering = 1, scaling = false, pcm = false, sets = [], longTerm = null, sar, layer = 0 } = {}) {
  const w = bitWriter();
  w.u(4, 0).u(3, maxSubLayers - 1).u(1, 1);
  // profile_tier_level: general 88비트 + level 8비트
  w.u(2, 0).u(1, 0).u(5, 1).u(32, 0x60000000).u(1, 1).u(1, 0).u(1, 0).u(1, 1).u(43, 0).u(1, 0).u(8, 93);
  for (let i = 0; i < maxSubLayers - 1; i += 1) w.u(1, subLayers[i]?.profile ? 1 : 0).u(1, subLayers[i]?.level ? 1 : 0);
  if (maxSubLayers - 1 > 0) for (let i = maxSubLayers - 1; i < 8; i += 1) w.u(2, 0);
  for (let i = 0; i < maxSubLayers - 1; i += 1) {
    if (subLayers[i]?.profile) w.u(32, 0xffffffff).u(32, 0x12345678).u(24, 0xabcdef);
    if (subLayers[i]?.level) w.u(8, 90);
  }
  w.ue(0).ue(1).ue(width).ue(height);
  w.u(1, conformance ? 1 : 0);
  if (conformance) conformance.forEach((value) => w.ue(value));
  w.ue(0).ue(0).ue(4);
  w.u(1, ordering);
  for (let i = ordering ? 0 : maxSubLayers - 1; i <= maxSubLayers - 1; i += 1) w.ue(4).ue(0).ue(0);
  w.ue(0).ue(3).ue(0).ue(3).ue(1).ue(1);
  w.u(1, scaling ? 1 : 0);
  if (scaling) {
    w.u(1, 1);
    for (let sizeId = 0; sizeId < 4; sizeId += 1) {
      for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
        // 큰 목록 하나는 값을 직접 적고 나머지는 앞 목록을 따른다.
        if (sizeId === 2 && matrixId === 1) {
          w.u(1, 1).se(3);
          for (let i = 0; i < 64; i += 1) w.se(i % 2 === 0 ? 1 : -2);
        } else if (sizeId === 0 && matrixId === 0) {
          w.u(1, 1);
          for (let i = 0; i < 16; i += 1) w.se(1);
        } else {
          w.u(1, 0).ue(0);
        }
      }
    }
  }
  w.u(1, 1).u(1, 1);
  w.u(1, pcm ? 1 : 0);
  if (pcm) w.u(4, 7).u(4, 7).ue(0).ue(1).u(1, 0);
  w.ue(sets.length);
  sets.forEach((set, index) => {
    if (index !== 0) w.u(1, set.inter ? 1 : 0);
    if (set.inter) {
      w.u(1, 0).ue(0);
      for (const [used, useDelta] of set.inter) {
        w.u(1, used);
        if (!used) w.u(1, useDelta);
      }
    } else {
      w.ue(set.negative).ue(set.positive);
      for (let i = 0; i < set.negative + set.positive; i += 1) w.ue(i).u(1, 1);
    }
  });
  w.u(1, longTerm ? 1 : 0);
  if (longTerm) {
    w.ue(longTerm);
    for (let i = 0; i < longTerm; i += 1) w.u(8, i * 3).u(1, 1);
  }
  w.u(1, 1).u(1, 0);
  writeVui(w, sar);
  return Buffer.from([(33 << 1) | (layer >> 5), ((layer & 0x1f) << 3) | 1, ...escape(w.bytes())]);
}

const u16 = (value) => [value >> 8, value & 0xff];

// avcC: SPS 하나와 PPS 하나
function avcC(sps) {
  const pps = [0x68, 0xce, 0x3c, 0x80];
  return Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, ...u16(sps.length), ...sps, 1, ...u16(pps.length), ...pps]);
}

// hvcC: VPS 배열을 SPS 배열 앞에 둔다.
function hvcC(sps) {
  const vps = [0x40, 0x01, 0x0c, 0x01, 0xff, 0xff];
  const head = Buffer.alloc(22);
  head[0] = 1;
  return Buffer.concat([head, Buffer.from([2, 0x20, 0, 1, ...u16(vps.length), ...vps, 0xa1, 0, 1, ...u16(sps.length), ...sps])]);
}

module.exports = { avcSps, hevcSps, avcC, hvcC, escape };
