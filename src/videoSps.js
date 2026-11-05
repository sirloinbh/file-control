'use strict';

// MP4 표본 항목의 avcC(H.264)나 hvcC(HEVC) 안 첫 SPS에서 화소 비율(VUI의 aspect_ratio)을 읽는다(#113).
// 영상 데이터(mdat)는 읽지 않는다. SPS는 처음부터 VUI의 화소 비율까지만 읽고 그 뒤는 보지 않는다.
// 구조가 틀리거나 값이 없으면 null을 돌려준다. 이 값은 보이는 크기 계산에만 쓰이므로 틀린 SPS를 오류로 보지 않는다.

// aspect_ratio_idc 1~16의 화소 비율. H.264(표 E-1)와 HEVC(표 E-1)가 같다. 255는 값을 따로 적는다.
const SAMPLE_ASPECT = [null, [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];
const EXTENDED_SAR = 255;
// 화소 비율 이후를 읽기 위해 SPS 전체가 필요하지는 않지만, 비정상적으로 큰 값은 보지 않는다.
const MAX_SPS = 4096;

// 앞 2바이트가 0이고 다음 바이트가 3이면 그 3은 내용이 아니다(emulation prevention).
function unescape(nal) {
  const out = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

// 비트 단위로 읽는다. 끝을 넘으면 예외 대신 ended를 세우고 0을 돌려주므로, 읽은 뒤 ended를 확인한다.
function bitReader(buffer) {
  let pos = 0;
  const reader = {
    ended: false,
    bit() {
      if (pos >= buffer.length * 8) {
        reader.ended = true;
        return 0;
      }
      const value = (buffer[pos >> 3] >> (7 - (pos & 7))) & 1;
      pos += 1;
      return value;
    },
    bits(count) {
      let value = 0;
      for (let i = 0; i < count; i += 1) value = value * 2 + reader.bit();
      return value;
    },
    skip(count) {
      pos += count;
      if (pos > buffer.length * 8) reader.ended = true;
    },
    // Exp-Golomb. 32비트를 넘는 값은 규격에 없으므로 끝난 것으로 본다.
    ue() {
      let zeros = 0;
      while (reader.bit() === 0) {
        zeros += 1;
        if (zeros > 31 || reader.ended) {
          reader.ended = true;
          return 0;
        }
      }
      return 2 ** zeros - 1 + reader.bits(zeros);
    },
    se() {
      const value = reader.ue();
      return value % 2 === 1 ? (value + 1) / 2 : -value / 2;
    },
  };
  return reader;
}

// VUI의 첫 부분. aspect_ratio_info_present_flag 뒤에 비율이 온다.
function readAspect(r, vuiPresent) {
  if (!vuiPresent || r.ended) return null;
  if (r.bit() === 0) return null;
  const idc = r.bits(8);
  let sar = null;
  if (idc === EXTENDED_SAR) {
    const h = r.bits(16);
    const v = r.bits(16);
    sar = h > 0 && v > 0 ? [h, v] : null;
  } else {
    sar = SAMPLE_ASPECT[idc] ?? null;
  }
  if (r.ended || sar === null) return null;
  return { h: sar[0], v: sar[1] };
}

// H.264 scaling_list(): 크기만큼 delta_scale을 건너뛴다.
function skipAvcScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size && !r.ended; j += 1) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

// chroma_format_idc 등이 있는 높은 프로필
const AVC_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// H.264 SPS (7.3.2.1.1). nal은 NAL 머리 1바이트를 포함한다.
function avcAspect(nal) {
  if (nal.length < 4 || (nal[0] & 0x1f) !== 7) return null;
  const r = bitReader(unescape(nal.subarray(1)));
  const profile = r.bits(8);
  r.skip(16); // constraint_set 플래그, level_idc
  r.ue(); // seq_parameter_set_id
  if (AVC_HIGH_PROFILES.has(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.skip(1); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.skip(1); // qpprime_y_zero_transform_bypass_flag
    if (r.bit() === 1) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12) && !r.ended; i += 1) {
        if (r.bit() === 1) skipAvcScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.skip(1);
    r.se();
    r.se();
    const cycle = r.ue();
    if (cycle > 255) return null;
    for (let i = 0; i < cycle && !r.ended; i += 1) r.se();
  } else if (pocType !== 2) return null;
  r.ue(); // max_num_ref_frames
  r.skip(1); // gaps_in_frame_num_value_allowed_flag
  r.ue(); // pic_width_in_mbs_minus1
  r.ue(); // pic_height_in_map_units_minus1
  if (r.bit() === 0) r.skip(1); // frame_mbs_only_flag가 0이면 mb_adaptive_frame_field_flag
  r.skip(1); // direct_8x8_inference_flag
  if (r.bit() === 1) for (let i = 0; i < 4; i += 1) r.ue(); // frame_cropping
  return readAspect(r, r.bit() === 1);
}

// HEVC profile_tier_level(1, maxSubLayersMinus1) (7.3.3)
function skipProfileTierLevel(r, maxSubLayersMinus1) {
  r.skip(88); // general_profile_space ~ general_inbld_flag/reserved
  r.skip(8); // general_level_idc
  const profilePresent = [];
  const levelPresent = [];
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    profilePresent.push(r.bit());
    levelPresent.push(r.bit());
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i += 1) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i += 1) {
    if (profilePresent[i]) r.skip(88);
    if (levelPresent[i]) r.skip(8);
  }
}

// HEVC scaling_list_data() (7.3.4)
function skipHevcScalingList(r) {
  for (let sizeId = 0; sizeId < 4; sizeId += 1) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (r.ended) return;
      if (r.bit() === 0) {
        r.ue(); // scaling_list_pred_matrix_id_delta
        continue;
      }
      const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
      if (sizeId > 1) r.se(); // scaling_list_dc_coef_minus8
      for (let i = 0; i < coefNum && !r.ended; i += 1) r.se();
    }
  }
}

// HEVC st_ref_pic_set(stRpsIdx) (7.3.7). 다음 집합이 참조할 수 있도록 이 집합의 NumDeltaPocs를 돌려준다.
// 참조하는 집합은 개수만 알면 읽을 수 있으므로 값은 기억하지 않는다(FFmpeg와 같은 셈).
function readShortTermRefPicSet(r, index, counts) {
  if (index !== 0 && r.bit() === 1) {
    r.skip(1); // delta_rps_sign
    r.ue(); // abs_delta_rps_minus1
    // SPS 안에서는 delta_idx_minus1이 없으므로 바로 앞 집합을 참조한다.
    let count = 0;
    for (let j = 0; j <= counts[index - 1] && !r.ended; j += 1) {
      const used = r.bit();
      const useDelta = used === 1 ? 1 : r.bit();
      if (used === 1 || useDelta === 1) count += 1;
    }
    return count;
  }
  const negative = r.ue();
  const positive = r.ue();
  if (negative > 16 || positive > 16) {
    r.ended = true;
    return 0;
  }
  for (let i = 0; i < negative + positive && !r.ended; i += 1) {
    r.ue(); // delta_poc_s0/s1_minus1
    r.skip(1); // used_by_curr_pic_s0/s1_flag
  }
  return negative + positive;
}

// HEVC SPS (7.3.2.2). nal은 NAL 머리 2바이트를 포함한다.
function hevcAspect(nal) {
  if (nal.length < 4 || ((nal[0] >> 1) & 0x3f) !== 33) return null;
  // 여러 계층(MV-HEVC 등) SPS는 구조가 달라 읽지 않는다.
  if (((nal[0] & 1) << 5) | (nal[1] >> 3)) return null;
  const r = bitReader(unescape(nal.subarray(2)));
  r.skip(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3);
  r.skip(1); // sps_temporal_id_nesting_flag
  skipProfileTierLevel(r, maxSubLayersMinus1);
  r.ue(); // sps_seq_parameter_set_id
  if (r.ue() === 3) r.skip(1); // chroma_format_idc, separate_colour_plane_flag
  r.ue(); // pic_width_in_luma_samples
  r.ue(); // pic_height_in_luma_samples
  if (r.bit() === 1) for (let i = 0; i < 4; i += 1) r.ue(); // conformance_window
  r.ue(); // bit_depth_luma_minus8
  r.ue(); // bit_depth_chroma_minus8
  const pocLsbBits = r.ue() + 4;
  if (pocLsbBits > 16) return null;
  const orderingAll = r.bit();
  for (let i = orderingAll ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i += 1) {
    r.ue();
    r.ue();
    r.ue();
  }
  for (let i = 0; i < 6; i += 1) r.ue(); // 부호화 블록과 변환 블록 크기, 변환 계층 깊이
  if (r.bit() === 1 && r.bit() === 1) skipHevcScalingList(r); // scaling_list_enabled_flag, sps_scaling_list_data_present_flag
  r.skip(2); // amp_enabled_flag, sample_adaptive_offset_enabled_flag
  if (r.bit() === 1) {
    r.skip(8); // pcm 표본 비트 깊이
    r.ue();
    r.ue();
    r.skip(1);
  }
  const sets = r.ue(); // num_short_term_ref_pic_sets
  if (sets > 64) return null;
  const counts = [];
  for (let i = 0; i < sets && !r.ended; i += 1) counts.push(readShortTermRefPicSet(r, i, counts));
  if (r.bit() === 1) {
    const longTerm = r.ue();
    if (longTerm > 32) return null;
    for (let i = 0; i < longTerm && !r.ended; i += 1) r.skip(pocLsbBits + 1);
  }
  r.skip(2); // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
  return readAspect(r, r.bit() === 1);
}

// avcC: 5바이트 머리 뒤에 SPS 개수(아래 5비트)와 [길이 2바이트, SPS]가 이어진다.
function firstAvcSps(config) {
  if (config.length < 6 || config[0] !== 1) return null;
  const count = config[5] & 0x1f;
  if (count === 0 || config.length < 8) return null;
  const length = config.readUInt16BE(6);
  if (length === 0 || length > MAX_SPS || 8 + length > config.length) return null;
  return config.subarray(8, 8 + length);
}

// hvcC: 22바이트 머리, 배열 개수 1바이트, 배열마다 [종류 1바이트, NAL 개수 2바이트, [길이 2바이트, NAL]...].
function firstHevcSps(config) {
  if (config.length < 23 || config[0] !== 1) return null;
  let offset = 23;
  for (let array = 0; array < config[22]; array += 1) {
    if (offset + 3 > config.length) return null;
    const type = config[offset] & 0x3f;
    const count = config.readUInt16BE(offset + 1);
    offset += 3;
    for (let i = 0; i < count; i += 1) {
      if (offset + 2 > config.length) return null;
      const length = config.readUInt16BE(offset);
      offset += 2;
      if (offset + length > config.length) return null;
      if (type === 33) return length > 0 && length <= MAX_SPS ? config.subarray(offset, offset + length) : null;
      offset += length;
    }
  }
  return null;
}

// kind는 박스 종류('avcC', 'hvcC'), config는 그 박스의 내용이다. 화소 비율 { h, v }나 null을 돌려준다.
function spsAspect(kind, config) {
  if (kind === 'avcC') {
    const sps = firstAvcSps(config);
    return sps && avcAspect(sps);
  }
  if (kind === 'hvcC') {
    const sps = firstHevcSps(config);
    return sps && hevcAspect(sps);
  }
  return null;
}

module.exports = { spsAspect };
