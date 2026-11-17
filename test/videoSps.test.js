'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spsAspect } = require('../src/videoSps');
const { avcSps, hevcSps, avcC, hvcC } = require('./spsBuilder');

const avc = (options) => spsAspect('avcC', avcC(avcSps(options)));
const hevc = (options) => spsAspect('hvcC', hvcC(hevcSps(options)));

test('H.264 SPS: 표의 화소 비율과 직접 적은 비율을 읽는다 (#113)', () => {
  assert.deepStrictEqual(avc({ sar: 5 }), { h: 40, v: 33 });
  assert.deepStrictEqual(avc({ sar: 1 }), { h: 1, v: 1 });
  assert.deepStrictEqual(avc({ sar: 16 }), { h: 2, v: 1 });
  assert.deepStrictEqual(avc({ sar: [32, 27] }), { h: 32, v: 27 });
  // If there is no VUI, no ratio, undefined (0), a reserved value (17), or a value that holds 0, it is null.
  for (const sar of [undefined, null, 0, 17, [0, 1], [1, 0]]) assert.strictEqual(avc({ sar }), null, JSON.stringify(sar));
});

test('H.264 SPS: 프로필, scaling list, POC 종류, 필드 부호화, 자르기에 따라 달라지는 앞부분을 건너뛴다 (#113)', () => {
  for (const profile of [66, 77, 100, 110, 122, 244, 144]) assert.deepStrictEqual(avc({ profile, sar: 14 }), { h: 4, v: 3 }, `profile ${profile}`);
  for (const pocType of [0, 1, 2]) assert.deepStrictEqual(avc({ pocType, sar: 14 }), { h: 4, v: 3 }, `poc ${pocType}`);
  assert.deepStrictEqual(avc({ frameMbsOnly: 0, sar: 14 }), { h: 4, v: 3 });
  assert.deepStrictEqual(avc({ crop: [0, 0, 0, 4], sar: 14 }), { h: 4, v: 3 });
  assert.deepStrictEqual(avc({ chroma: 3, sar: 14 }), { h: 4, v: 3 });
  // In list 0, next becomes 0 at the first value and it does not read after that, and list 6 reads all 64.
  const scaling = { 0: [-8], 1: [2, -1, 3, ...Array(13).fill(0)], 6: Array(64).fill(1) };
  assert.deepStrictEqual(avc({ scaling, sar: [32, 27] }), { h: 32, v: 27 });
  assert.deepStrictEqual(avc({ chroma: 3, scaling: { ...scaling, 11: Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? -1 : 1)) }, sar: [32, 27] }), { h: 32, v: 27 });
});

test('SPS의 emulation prevention 바이트(00 00 03)를 내용에서 뺀다 (#113)', () => {
  // 32768:1 has 30 zero bits in a row, so at any alignment a byte of 3 or less comes after 00 00 and a 3 is inserted. It looks at it while changing the alignment with the crop value.
  for (let shift = 0; shift < 8; shift += 1) {
    const sps = avcSps({ crop: [shift, 0, 0, 0], sar: [0x8000, 1] });
    assert.ok(sps.includes(Buffer.from([0, 0, 3])), `shift ${shift}`);
    assert.deepStrictEqual(spsAspect('avcC', avcC(sps)), { h: 0x8000, v: 1 }, `shift ${shift}`);
  }
});

test('HEVC SPS: 화소 비율을 읽고, 하위 계층·자르기·scaling list·PCM·참조 집합·장기 참조를 건너뛴다 (#113)', () => {
  assert.deepStrictEqual(hevc({ sar: 5 }), { h: 40, v: 33 });
  assert.deepStrictEqual(hevc({ sar: [4, 3] }), { h: 4, v: 3 });
  for (const sar of [undefined, null, 0, 200]) assert.strictEqual(hevc({ sar }), null, JSON.stringify(sar));
  const expected = { h: 32, v: 27 };
  const sar = [32, 27];
  assert.deepStrictEqual(hevc({ maxSubLayers: 3, subLayers: [{ profile: 1, level: 1 }, { level: 1 }], sar }), expected);
  assert.deepStrictEqual(hevc({ maxSubLayers: 3, ordering: 0, sar }), expected);
  assert.deepStrictEqual(hevc({ conformance: [0, 0, 0, 4], sar }), expected);
  assert.deepStrictEqual(hevc({ scaling: true, sar }), expected);
  assert.deepStrictEqual(hevc({ pcm: true, sar }), expected);
  assert.deepStrictEqual(hevc({ longTerm: 2, sar }), expected);
  // Reference sets: set 1 refers to set 0 (3 entries) and reads 4 slots, of which 3 remain. Set 2 refers to set 1 (3 entries) and reads 4 slots.
  const sets = [
    { negative: 2, positive: 1 },
    { inter: [[1], [0, 0], [1], [0, 1]] },
    { inter: [[0, 1], [1], [0, 0], [1]] },
  ];
  assert.deepStrictEqual(hevc({ sets, sar }), expected);
  // If the count of the reference set is counted wrong, what follows goes off. If set 1 leaves 4, set 2 must read 5 slots.
  const four = [{ negative: 2, positive: 1 }, { inter: [[1], [1], [1], [1]] }, { inter: [[1], [1], [1], [1], [0, 0]] }];
  assert.deepStrictEqual(hevc({ sets: four, sar }), expected);
});

test('잘리거나 틀린 SPS와 설정 상자는 null이고 예외를 내지 않는다 (#113)', () => {
  const sps = avcSps({ sar: [32, 27] });
  for (let cut = 0; cut < sps.length; cut += 1) {
    const result = spsAspect('avcC', avcC(sps.subarray(0, cut)));
    assert.ok(result === null || (result.h > 0 && result.v > 0), `cut ${cut}`);
  }
  const hevcNal = hevcSps({ sar: [32, 27] });
  for (let cut = 0; cut < hevcNal.length; cut += 1) {
    const result = spsAspect('hvcC', hvcC(hevcNal.subarray(0, cut)));
    assert.ok(result === null || (result.h > 0 && result.v > 0), `cut ${cut}`);
  }
  const config = avcC(sps);
  for (let cut = 0; cut < config.length - 4; cut += 1) assert.deepStrictEqual(spsAspect('avcC', config.subarray(0, cut)), cut >= 8 + sps.length ? spsAspect('avcC', config) : null, `avcC cut ${cut}`);
  // If the version is not 1, there is no SPS, or the NAL kind differs, it is null.
  assert.strictEqual(spsAspect('avcC', Buffer.from([0, ...config.subarray(1)])), null);
  assert.strictEqual(spsAspect('avcC', Buffer.from([...config.subarray(0, 5), 0xe0])), null);
  assert.strictEqual(spsAspect('avcC', avcC(Buffer.from([0x68, ...sps.subarray(1)]))), null);
  assert.strictEqual(spsAspect('hvcC', hvcC(Buffer.from([0x40, ...hevcNal.subarray(1)]))), null);
  // An hvcC of version 0 (a muxer of the draft era) is accepted, and 2 or more is not accepted.
  const hevcConfig = hvcC(hevcNal);
  assert.deepStrictEqual(spsAspect('hvcC', Buffer.from([0, ...hevcConfig.subarray(1)])), { h: 32, v: 27 });
  assert.strictEqual(spsAspect('hvcC', Buffer.from([2, ...hevcConfig.subarray(1)])), null);
  // An SPS with several layers (nuh_layer_id > 0) has a different structure, so it is not read.
  assert.strictEqual(hevc({ layer: 1, sar: [32, 27] }), null);
  assert.strictEqual(spsAspect('esds', config), null);
  // An Exp-Golomb with zeros continuing endlessly
  assert.strictEqual(spsAspect('avcC', avcC(Buffer.from([0x67, 100, 0, 40, ...Array(64).fill(0)]))), null);
});

