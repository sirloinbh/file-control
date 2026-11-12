'use strict';

// It checks the SPS pixel aspect ratio reading with avcC and hvcC made by real encoders (#123).
// test/spsBuilder.js is a helper written in the same order as the reader, so if both are wrong together it cannot catch it. So it is matched against real output.
// How it was made: with FFmpeg 9.0.2 (gyan.dev full build), a 1-second testsrc2 was encoded with '-vf setsar=H/V', put in an MP4, and the avcC and hvcC of stsd were taken out.
// The array of encoder-settings SEI (several KB) that x265 puts in hvcC was left out, and the VPS, SPS, and PPS were not changed.
// The expected value is the sample_aspect_ratio that ffprobe read from the SPS by taking the same video out without a container (-c copy -f h264/hevc).
// Field values were checked with FFmpeg trace_headers. Things that could not be confirmed with real output (only the synthetic SPS test test/videoSps.test.js looks at them):
// - H.264 scaling list: x264 writes cqm only in the PPS. POC type 1: x264 does not write it.
// - The long-term reference list inside the HEVC SPS, PCM, and the profile and level for each sub-layer. x265 does not write reference sets in the SPS (0), so it is seen with hevc_qsv.
// - The number of sub-layer alignment bits (reserved_zero_2bits) of HEVC profile_tier_level: even if it is off by about 2 bits, the later Exp-Golomb fields line up again and
//   the pixel aspect ratio comes out the same. The synthetic SPS test looks at some of them.
// - H.264 emulation prevention: in these H.264 SPSs, it first appears only after the pixel aspect ratio.
//   All HEVC ones have 00 00 03 within the first 8 bytes of the NAL (profile_tier_level), so it is confirmed with real data.
// - Apple VideoToolbox: it cannot be made on Windows (#126).

const test = require('node:test');
const assert = require('node:assert');
const { spsAspect } = require('../src/videoSps');

// [name, config box kind, pixel aspect ratio horizontal, vertical, config box content (hex)]
const SAMPLES = [
  // h264_qsv (Intel hardware), 720x480
  ['qsv-h264-sar32-27', 'avcC', 32, 27,
    '0164001effe1001e2764001eac2ec0b43dbff0020001b1000003000100000300329da1c2d38001000428eebcb0fdf8f800'],
  // hevc_qsv (Intel hardware), 720x480. 8 reference sets (7 of them use inter prediction), long_term_ref_pics_present=1 (0 long-term references in the SPS)
  ['qsv-hevc-sar32-27', 'hvcC', 32, 27,
    '0101400000008000000000005af000fcfdf8f800000f03200001002240010c01ffff01400000030080000003000003005a14903000000300100000030195210001003d42010101400000030080000003000003005aa005a201e164149b91b01289e846ba6fcb8f5e627644e658fbff0020001b4028000003000800000300c84022000100084401c038e180db20'],
  // libx264 -profile:v baseline, 704x480, POC type 2
  ['x264-baseline-sar10-11', 'avcC', 10, 11,
    '0142c01effe100186742c01ed900b03db031000003000100000300320f162e4801000568cb83cb20'],
  // libx264, 360x202, with frame cropping
  ['x264-crop-sar59-54', 'avcC', 59, 54,
    '0164000dffe1001e6764000dacd94171be593ff003b00361000003000100000300320f14299601000668ebe3cb22c0fdf8f800'],
  // libx264 -profile:v high, 720x480, POC type 0
  ['x264-high-sar32-27', 'avcC', 32, 27,
    '0164001effe1001d6764001eacd940b43dbff0020001b1000003000100000300320f162d9601000668ebe3cb22c0fdf8f800'],
  // libx264 -profile:v high10, 10-bit, 1440x1080
  ['x264-high10-sar4-3', 'avcC', 4, 3,
    '016e0028ffe1001b676e0028a6cd9405a0227e5c3840000003004000000c83c60c658001000668ebe3cb22c0fdfafa00'],
  // libx264 -profile:v high422, 4:2:2, 720x576
  ['x264-high422-sar16-11', 'avcC', 16, 11,
    '017a001effe10019677a001ebcd940b4126c1040000003004000000c83c58b658001000668ebe3cb22c0fef8f800'],
  // libx264 -profile:v high444, 4:4:4, 720x576
  ['x264-high444-sar64-45', 'avcC', 64, 45,
    '01f4001effe1001e67f4001e919b2816824dff80200016880000030008000003019078b16cb001000668ebe3c44844fff8f800'],
  // libx264 interlaced=1, 720x480, frame_mbs_only=0
  ['x264-interlaced-sar32-27', 'avcC', 32, 27,
    '0164001effe1001d6764001eacd940b47b7fe004000362000003000200000300643e28532c01000668fba3cb22c0fdf8f800'],
  // libx264 -profile:v main, 720x480
  ['x264-main-sar40-33', 'avcC', 40, 33,
    '014d401effe10017674d401eeca05a1ed828800000030080000019078b16cb01000568ebe3cb20'],
  // libx264, no setsar, 720x480 (aspect_ratio_idc 1)
  ['x264-nosar', 'avcC', 1, 1,
    '0164001effe100196764001eacd940b43db011000003000100000300320f162d9601000668ebe3cb22c0fdf8f800'],
  // libx265, 360x202, with a conformance window
  ['x265-crop-sar59-54', 'hvcC', 59, 54,
    '0101600000009000000000003cf000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003003c959809210001002f42010101600000030090000003000003003ca00b480d1f265959a4932bffc00ec00d9a02000003000200000300321022000100074401c172b46240'],
  // libx265 scaling-list=<file>, 720x480. The SPS has scaling_list_data directly (4x4 to 32x32, including DC values)
  ['x265-customscaling-sar32-27', 'hvcC', 32, 27,
    '0101600000009000000000005af000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003005a95980921000103cd42010101600000030090000003000003005aa005a201e165959a493e120c04ca1c098e098702638261c284c2f0a0200c8a0b064685832161a160c8a0c820858e100c07c20203e1008080f8402e103c3085091428262850a098a04a09812a868510c422202b22210c4150e04986d82c0cb6c2cd86d84a1e30c38c0461c1808c6040118c1830808c60c0463048c1830118c18151830118c183011868602318306023123060c046308306023181004630604c60c38c341005985db0d36c26db61e6db63db6d82c1adb6db1adb058d8f6db611058db09b6c34d85d85a0884878138782218088443c7088443c1114110f044221e0a8443c110f0442250f044221e088443c50887822110f0442a1e088443c1114110f0442270f044221808878138784c120808090f8402c1f0807cc100807c202c201f080403e140807c20100f84081f080403e100807c8100807c20100f8503e100807c202c20100f840c1f08040321008090f888260ba0b241b490492483e924872492408d249243124920429248209205a124905016a0b20bc141c69868220e8221a342208868d04451a3468221a2068d0443468d0a0d1a08868d1a0883608868d1a0886881a3468221a51a08868d088221a342434698682882c628362c28140f8503614285036140d85836140a06c28836140d850361409850281b0a06c281b0e06c281b0a050368281b0a06c28190a0503614286c281b08050362c282a0b9854c1430291c63184029318c8c63181494c6318c61663181498c6166318c60520a81498c6323181498418c604263050c158306512412246091209836241309121312098489122c130912244896098489122448266244891209848b122448261213120984890d82612246091241258326302e34301714170c05c1005c30170c0270c05c30170c04430170c05c3017305c30170c05c301730602e180b8602e110c05c30170c080b8602e181e170c05c50602e343008e0d184c5048128a1028128a62850a04a088128a1428505c50a04a2850a0422850a1409450a1c09450a1428128605025142850d1428128a62850a04e285048128720d9b2a294c5294514a528e294a52848a5294a50b14a52941514325294a0a8a1d2941514a084a0a8a5145294c52a2b8386084383c261c204c38130c870261c099c3813098702630261c0984c38130f04c261c0984c38130f04c261c09870263026130e04c3870987026130b04c3813204c383c263a0e9844707c70e408470e1a38108e1c1b1c38108e1c60423870211c3848e0423870e0423848e0423870e04261c38108e1c1b1c38108e1a387021438707c70455ffe00400036d01000003000100000300190822000100074401c172b46240'],
  // libx265 Main 10, 720x576
  ['x265-main10-sar16-11', 'hvcC', 16, 11,
    '0102200000009000000000005af000fcfdfafa00000f03200001001840010c01ffff02200000030090000003000003005a959809210001002a42010102200000030090000003000003005aa005a200904d96566924caf0468080000003008000000c8422000100074401c172b46240'],
  // libx265, no setsar, 720x480 (aspect_ratio_idc 1)
  ['x265-nosar', 'hvcC', 1, 1,
    '0101600000009000000000005af000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003005a959809210001002a42010101600000030090000003000003005aa005a201e165959a4932bc05a0200000030020000003032122000100074401c172b46240'],
  // libx265, 720x480
  ['x265-sar32-27', 'hvcC', 32, 27,
    '0101600000009000000000005af000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003005a959809210001002e42010101600000030090000003000003005aa005a201e165959a4932bffc0080006da0200000030020000003032122000100074401c172b46240'],
  // libx265 scaling-list=default, 720x480. scaling_list_enabled=1 but the SPS has no list
  ['x265-scaling-sar4-3', 'hvcC', 4, 3,
    '0101600000009000000000005af000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003005a9d9809210001002b42010101600000030090000003000003005aa005a201e1659d9a49395e1cd010000003001000000301908022000100074401c172b46240'],
  // libx265 temporal-layers=3:b-pyramid=1:bframes=7, 720x480. 3 sub-layers (sps_max_sub_layers_minus1=2)
  ['x265-temporal-sar40-33', 'hvcC', 40, 33,
    '0101600000009000000000005af000fcfdf8f800001b03200001001e40010c04ffff01600000030090000003000003005a00009594aca5650240210001003042010401600000030090000003000003005a0000a005a201e1659594aca565924caf056808000003000800000300c84022000100074401c172b46240'],
  // libx265 temporal-layers=4:b-pyramid=1:bframes=8, 640x360. 4 sub-layers (sps_max_sub_layers_minus1=3)
  ['x265-temporal4-sar4-3', 'hvcC', 4, 3,
    '0101600000009000000000003ff000fcfdf8f800002303200001002140010c06ffff01600000030090000003000003003f000095892b125624c4120480210001003342010601600000030090000003000003003f0000a0050201696595892b125624c41324995e1cd010000003001000000301908022000100074401c172b46240'],
];

test('실제 인코더(x264, x265, Intel QSV)의 SPS에서 ffprobe와 같은 화소 비율을 읽는다 (#123)', () => {
  for (const [name, kind, h, v, hex] of SAMPLES) {
    assert.deepStrictEqual(spsAspect(kind, Buffer.from(hex, 'hex')), { h, v }, name);
  }
});

// The position of the SPS inside the config box: [2-byte length position, SPS start]
function spsAt(kind, config) {
  if (kind === 'avcC') return [6, 8];
  let offset = 23;
  for (let i = 0; i < config[22]; i += 1) {
    const type = config[offset] & 0x3f;
    const count = config.readUInt16BE(offset + 1);
    offset += 3;
    for (let j = 0; j < count; j += 1) {
      if (type === 33) return [offset, offset + 2];
      offset += 2 + config.readUInt16BE(offset);
    }
  }
  throw new Error('SPS 없음');
}

test('실제 인코더 SPS를 중간에서 잘라도 예외 없이 null이거나 같은 비율이다 (#123)', () => {
  for (const [name, kind, h, v, hex] of SAMPLES) {
    const config = Buffer.from(hex, 'hex');
    const [lengthAt, start] = spsAt(kind, config);
    const length = config.readUInt16BE(lengthAt);
    // It shortens the SPS itself by cut bytes and fixes the length to match. It looks at the case where the bit reading goes past the end, not the config box length check.
    for (let cut = 0; cut < length; cut += 1) {
      const shorter = Buffer.from(config.subarray(0, start + cut));
      shorter.writeUInt16BE(cut, lengthAt);
      const got = spsAspect(kind, shorter);
      assert.ok(got === null || (got.h === h && got.v === v), `${name} cut ${cut}: ${JSON.stringify(got)}`);
    }
  }
});
