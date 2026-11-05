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
  // VUI가 없거나, 비율이 없거나, 정하지 않음(0)이거나, 예약값(17)이거나, 0이 든 값이면 null이다.
  for (const sar of [undefined, null, 0, 17, [0, 1], [1, 0]]) assert.strictEqual(avc({ sar }), null, JSON.stringify(sar));
});

test('H.264 SPS: 프로필, scaling list, POC 종류, 필드 부호화, 자르기에 따라 달라지는 앞부분을 건너뛴다 (#113)', () => {
  for (const profile of [66, 77, 100, 110, 122, 244, 144]) assert.deepStrictEqual(avc({ profile, sar: 14 }), { h: 4, v: 3 }, `profile ${profile}`);
  for (const pocType of [0, 1, 2]) assert.deepStrictEqual(avc({ pocType, sar: 14 }), { h: 4, v: 3 }, `poc ${pocType}`);
  assert.deepStrictEqual(avc({ frameMbsOnly: 0, sar: 14 }), { h: 4, v: 3 });
  assert.deepStrictEqual(avc({ crop: [0, 0, 0, 4], sar: 14 }), { h: 4, v: 3 });
  assert.deepStrictEqual(avc({ chroma: 3, sar: 14 }), { h: 4, v: 3 });
  // 목록 0은 첫 값에서 next가 0이 되어 그 뒤를 읽지 않고, 목록 6은 64개를 모두 읽는다.
  const scaling = { 0: [-8], 1: [2, -1, 3, ...Array(13).fill(0)], 6: Array(64).fill(1) };
  assert.deepStrictEqual(avc({ scaling, sar: [32, 27] }), { h: 32, v: 27 });
  assert.deepStrictEqual(avc({ chroma: 3, scaling: { ...scaling, 11: Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? -1 : 1)) }, sar: [32, 27] }), { h: 32, v: 27 });
});

test('SPS의 emulation prevention 바이트(00 00 03)를 내용에서 뺀다 (#113)', () => {
  // 32768:1은 0이 30비트 이어져 어떤 정렬에서도 00 00 뒤에 3 이하의 바이트가 와 3이 끼워진다. 자르기 값으로 정렬을 바꿔 가며 본다.
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
  // 참조 집합: 1번은 0번(3개)을 참조해 4칸을 읽고 그중 3개가 남는다. 2번은 1번(3개)을 참조해 4칸을 읽는다.
  const sets = [
    { negative: 2, positive: 1 },
    { inter: [[1], [0, 0], [1], [0, 1]] },
    { inter: [[0, 1], [1], [0, 0], [1]] },
  ];
  assert.deepStrictEqual(hevc({ sets, sar }), expected);
  // 참조 집합의 개수를 잘못 세면 뒤가 어긋난다. 1번이 4개를 남기면 2번은 5칸을 읽어야 한다.
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
  // 버전이 1이 아니거나 SPS가 없거나 NAL 종류가 다르면 null이다.
  assert.strictEqual(spsAspect('avcC', Buffer.from([0, ...config.subarray(1)])), null);
  assert.strictEqual(spsAspect('avcC', Buffer.from([...config.subarray(0, 5), 0xe0])), null);
  assert.strictEqual(spsAspect('avcC', avcC(Buffer.from([0x68, ...sps.subarray(1)]))), null);
  assert.strictEqual(spsAspect('hvcC', hvcC(Buffer.from([0x40, ...hevcNal.subarray(1)]))), null);
  // hvcC 버전 0(초안 시절 먹서)은 받고, 2 이상은 받지 않는다.
  const hevcConfig = hvcC(hevcNal);
  assert.deepStrictEqual(spsAspect('hvcC', Buffer.from([0, ...hevcConfig.subarray(1)])), { h: 32, v: 27 });
  assert.strictEqual(spsAspect('hvcC', Buffer.from([2, ...hevcConfig.subarray(1)])), null);
  // 여러 계층 SPS(nuh_layer_id > 0)는 구조가 달라 읽지 않는다.
  assert.strictEqual(hevc({ layer: 1, sar: [32, 27] }), null);
  assert.strictEqual(spsAspect('esds', config), null);
  // 0이 끝없이 이어지는 Exp-Golomb
  assert.strictEqual(spsAspect('avcC', avcC(Buffer.from([0x67, 100, 0, 40, ...Array(64).fill(0)]))), null);
});

