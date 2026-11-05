'use strict';

// 실제 인코더가 만든 avcC·hvcC로 SPS 화소 비율 판독을 확인한다(#123).
// test/spsBuilder.js는 판독기와 같은 순서로 쓴 도우미라 둘이 함께 틀리면 잡지 못한다. 그래서 실제 출력과 맞춰 본다.
// 만든 방법: FFmpeg 9.0.2(gyan.dev full build)로 testsrc2 1초를 '-vf setsar=H/V'로 인코딩해 MP4에 담고 stsd의 avcC·hvcC를 꺼냈다.
// x265가 hvcC에 넣는 인코더 설정 SEI 배열(수 KB)은 뺐고, VPS·SPS·PPS는 바꾸지 않았다.
// 기대값은 같은 영상을 컨테이너 없이(-c copy -f h264/hevc) 꺼내 ffprobe가 SPS에서 읽은 sample_aspect_ratio다.

const test = require('node:test');
const assert = require('node:assert');
const { spsAspect } = require('../src/videoSps');

// [이름, 설정 상자 종류, 화소 비율 가로, 세로, 설정 상자 내용(hex)]. 1:1은 SPS에 비율이 없거나 1:1인 것이다.
const SAMPLES = [
  // h264_qsv (Intel 하드웨어), 720x480
  ['qsv-h264-sar32-27', 'avcC', 32, 27,
    '0164001effe1001e2764001eac2ec0b43dbff0020001b1000003000100000300329da1c2d38001000428eebcb0fdf8f800'],
  // hevc_qsv (Intel 하드웨어), 720x480
  ['qsv-hevc-sar32-27', 'hvcC', 32, 27,
    '0101400000008000000000005af000fcfdf8f800000f03200001002240010c01ffff01400000030080000003000003005a14903000000300100000030195210001003d42010101400000030080000003000003005aa005a201e164149b91b01289e846ba6fcb8f5e627644e658fbff0020001b4028000003000800000300c84022000100084401c038e180db20'],
  // libx264 -profile:v baseline, 704x480
  ['x264-baseline-sar10-11', 'avcC', 10, 11,
    '0142c01effe100186742c01ed900b03db031000003000100000300320f162e4801000568cb83cb20'],
  // libx264 -x264-params cqm=jvt (scaling list), 720x480
  ['x264-cqm-sar32-27', 'avcC', 32, 27,
    '0164001effe1001d6764001eacd940b43dbff0020001b1000003000100000300320f162d9601000768ebe3cb3002c0fdf8f800'],
  // libx264, 360x202 (자르기 값 있음)
  ['x264-crop-sar59-54', 'avcC', 59, 54,
    '0164000dffe1001e6764000dacd94171be593ff003b00361000003000100000300320f14299601000668ebe3cb22c0fdf8f800'],
  // libx264 -profile:v high10, 10비트, 1440x1080
  ['x264-high10-sar4-3', 'avcC', 4, 3,
    '016e0028ffe1001b676e0028a6cd9405a0227e5c3840000003004000000c83c60c658001000668ebe3cb22c0fdfafa00'],
  // libx264 -profile:v high422, 4:2:2, 720x576
  ['x264-high422-sar16-11', 'avcC', 16, 11,
    '017a001effe10019677a001ebcd940b4126c1040000003004000000c83c58b658001000668ebe3cb22c0fef8f800'],
  // libx264 -profile:v high444, 4:4:4, 720x576
  ['x264-high444-sar64-45', 'avcC', 64, 45,
    '01f4001effe1001e67f4001e919b2816824dff80200016880000030008000003019078b16cb001000668ebe3c44844fff8f800'],
  // libx264 -profile:v high, 720x480
  ['x264-high-sar32-27', 'avcC', 32, 27,
    '0164001effe1001d6764001eacd940b43dbff0020001b1000003000100000300320f162d9601000668ebe3cb22c0fdf8f800'],
  // libx264 interlaced=1 (필드 부호화), 720x480
  ['x264-interlaced-sar32-27', 'avcC', 32, 27,
    '0164001effe1001d6764001eacd940b47b7fe004000362000003000200000300643e28532c01000668fba3cb22c0fdf8f800'],
  // libx264 -profile:v main, 720x480
  ['x264-main-sar40-33', 'avcC', 40, 33,
    '014d401effe10017674d401eeca05a1ed828800000030080000019078b16cb01000568ebe3cb20'],
  // libx264, setsar 없음, 720x480
  ['x264-nosar', 'avcC', 1, 1,
    '0164001effe100196764001eacd940b43db011000003000100000300320f162d9601000668ebe3cb22c0fdf8f800'],
  // libx265, 360x202 (conformance window 있음)
  ['x265-crop-sar59-54', 'hvcC', 59, 54,
    '0101600000009000000000003cf000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003003c959809210001002f42010101600000030090000003000003003ca00b480d1f265959a4932bffc00ec00d9a02000003000200000300321022000100074401c172b46240'],
  // libx265 Main 10, 720x576
  ['x265-main10-sar16-11', 'hvcC', 16, 11,
    '0102200000009000000000005af000fcfdfafa00000f03200001001840010c01ffff02200000030090000003000003005a959809210001002a42010102200000030090000003000003005aa005a200904d96566924caf0468080000003008000000c8422000100074401c172b46240'],
  // libx265, setsar 없음, 720x480
  ['x265-nosar', 'hvcC', 1, 1,
    '0101600000009000000000005af000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003005a959809210001002a42010101600000030090000003000003005aa005a201e165959a4932bc05a0200000030020000003032122000100074401c172b46240'],
  // libx265, 720x480
  ['x265-sar32-27', 'hvcC', 32, 27,
    '0101600000009000000000005af000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003005a959809210001002e42010101600000030090000003000003005aa005a201e165959a4932bffc0080006da0200000030020000003032122000100074401c172b46240'],
  // libx265 scaling-list=default:ref=6:bframes=4, 720x480
  ['x265-scaling-sar4-3', 'hvcC', 4, 3,
    '0101600000009000000000005af000fcfdf8f800000f03200001001840010c01ffff01600000030090000003000003005a9d9809210001002b42010101600000030090000003000003005aa005a201e1659d9a49395e1cd010000003001000000301908022000100074401c172b46240'],
  // libx265 temporal-layers=3:b-pyramid=1:bframes=7, 720x480
  ['x265-temporal-sar40-33', 'hvcC', 40, 33,
    '0101600000009000000000005af000fcfdf8f800001b03200001001e40010c04ffff01600000030090000003000003005a00009594aca5650240210001003042010401600000030090000003000003005a0000a005a201e1659594aca565924caf056808000003000800000300c84022000100074401c172b46240'],
];

test('실제 인코더(x264, x265, Intel QSV)의 SPS에서 ffprobe와 같은 화소 비율을 읽는다 (#123)', () => {
  for (const [name, kind, h, v, hex] of SAMPLES) {
    const got = spsAspect(kind, Buffer.from(hex, 'hex'));
    const ratio = got ? got.h / got.v : 1;
    assert.ok(Math.abs(ratio - h / v) < 1e-12, `${name}: ${got ? got.h + ':' + got.v : 'null'}, 기대 ${h}:${v}`);
    if (h !== v) assert.deepStrictEqual(got, { h, v }, name);
  }
});

test('실제 인코더 SPS를 어디서 잘라도 예외 없이 null이거나 같은 비율이다 (#123)', () => {
  for (const [name, kind, , , hex] of SAMPLES) {
    const config = Buffer.from(hex, 'hex');
    const whole = spsAspect(kind, config);
    for (let cut = 0; cut < config.length; cut += 1) {
      const got = spsAspect(kind, config.subarray(0, cut));
      assert.ok(got === null || (got.h > 0 && got.v > 0), `${name} cut ${cut}`);
      if (got && whole) assert.deepStrictEqual(got, whole, `${name} cut ${cut}`);
    }
  }
});
