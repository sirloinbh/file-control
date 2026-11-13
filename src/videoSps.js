'use strict';

// It reads the pixel aspect ratio (aspect_ratio of the VUI) from the first SPS inside avcC (H.264) or hvcC (HEVC) of the MP4 sample entry (#113).
// It does not read the video data (mdat). It reads the SPS only from the start up to the pixel aspect ratio of the VUI and does not look beyond.
// If the structure is wrong or there is no value, it returns null. This value is used only for computing the visible size, so a wrong SPS is not treated as an error.

// The pixel aspect ratios of aspect_ratio_idc 1 to 16. H.264 (Table E-1) and HEVC (Table E-1) are the same. 255 writes the value separately.
const SAMPLE_ASPECT = [null, [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];
const EXTENDED_SAR = 255;
// The whole SPS is not needed to read after the pixel aspect ratio, but abnormally large values are not looked at.
const MAX_SPS = 4096;

// If the first 2 bytes are 0 and the next byte is 3, that 3 is not content (emulation prevention).
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

// It reads bit by bit. If it goes past the end, instead of an exception it sets ended and returns 0, so check ended after reading.
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
    // Exp-Golomb. A value over 32 bits is not in the specification, so it is seen as finished.
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

// The first part of the VUI. After aspect_ratio_info_present_flag comes the ratio.
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

// H.264 scaling_list(): it skips delta_scale as many times as the size.
function skipAvcScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size && !r.ended; j += 1) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

// High profiles that have chroma_format_idc and so on. 144 is the old High 4:4:4 dropped in 2007, but it has the same structure, so it is accepted like FFmpeg.
const AVC_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 144]);

// H.264 SPS (7.3.2.1.1). nal includes 1 byte of the NAL header.
function avcAspect(nal) {
  if (nal.length < 4 || (nal[0] & 0x1f) !== 7) return null;
  const r = bitReader(unescape(nal.subarray(1)));
  const profile = r.bits(8);
  r.skip(16); // constraint_set flags, level_idc
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
  if (r.bit() === 0) r.skip(1); // If frame_mbs_only_flag is 0, mb_adaptive_frame_field_flag
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

// HEVC st_ref_pic_set(stRpsIdx) (7.3.7). It returns this set's NumDeltaPocs so that the next set can refer to it.
// A referencing set can be read if only the count is known, so values are not remembered (the same as FFmpeg).
function readShortTermRefPicSet(r, index, counts) {
  if (index !== 0 && r.bit() === 1) {
    r.skip(1); // delta_rps_sign
    r.ue(); // abs_delta_rps_minus1
    // Inside the SPS there is no delta_idx_minus1, so it refers to the set right before.
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

// HEVC SPS (7.3.2.2). nal includes 2 bytes of the NAL header.
function hevcAspect(nal) {
  if (nal.length < 4 || ((nal[0] >> 1) & 0x3f) !== 33) return null;
  // SPSs with several layers (MV-HEVC and so on) have a different structure, so they are not read.
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
  for (let i = 0; i < 6; i += 1) r.ue(); // The sizes of coding blocks and transform blocks, and the transform hierarchy depth
  if (r.bit() === 1 && r.bit() === 1) skipHevcScalingList(r); // scaling_list_enabled_flag, sps_scaling_list_data_present_flag
  r.skip(2); // amp_enabled_flag, sample_adaptive_offset_enabled_flag
  if (r.bit() === 1) {
    r.skip(8); // pcm sample bit depth
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

// avcC: after a 5-byte header come the SPS count (the lower 5 bits) and [2-byte length, SPS].
function firstAvcSps(config) {
  if (config.length < 6 || config[0] !== 1) return null;
  const count = config[5] & 0x1f;
  if (count === 0 || config.length < 8) return null;
  const length = config.readUInt16BE(6);
  if (length === 0 || length > MAX_SPS || 8 + length > config.length) return null;
  return config.subarray(8, 8 + length);
}

// hvcC: a 22-byte header, a 1-byte array count, and for each array [1-byte kind, 2-byte NAL count, [2-byte length, NAL]...].
// Some files from the draft era had a muxer write configurationVersion as 0, so 0 is also accepted (the same as FFmpeg).
function firstHevcSps(config) {
  if (config.length < 23 || config[0] > 1) return null;
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

// kind is the box type ('avcC', 'hvcC') and config is the content of that box. It returns the pixel aspect ratio { h, v } or null.
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
