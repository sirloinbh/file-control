'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeName } = require('../src/normalize');
const { findProductNumberRanges, extractProductNumbers } = require('../src/product');

const cases = [
  // 이슈 예시
  ['영상 abc-123.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  // 위치와 구분 문자
  ['abc-123 영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['ABC-123 영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['ABC-123_영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['영상_abc-123.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['영상 - ABC-123 - 끝.mp4', 'ABC-123 영상 - - 끝.mp4', 'ABC-123'],
  ['앞 ABC-123 뒤.mp4', 'ABC-123 앞 뒤.mp4', 'ABC-123'],
  ['ABC-123.mp4', 'ABC-123.mp4', 'ABC-123'],
  ['abc-123.mp4', 'ABC-123.mp4', 'ABC-123'],
  // 괄호
  ['[abc-123] 영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['영상 (ABC-123).mkv', 'ABC-123 영상.mkv', 'ABC-123'],
  ['【ABC-123】영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['[태그] ABC-123.mp4', 'ABC-123 [태그].mp4', 'ABC-123'],
  // 전각
  ['영상 ＡＢＣ－１２３.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  // 같은 번호가 두 번
  // 대문자 번호를 찾으면 소문자 말은 그대로 남는다.
  ['abc-123 ABC-123.mp4', 'ABC-123 abc-123.mp4', 'ABC-123'],
  ['ABC-123 영상 ABC-123.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  // 화질 꼬리
  ['ABC-123-1080p.mp4', 'ABC-123 1080p.mp4', 'ABC-123'],
  // 확장자
  ['영상 abc-123.MP4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['abc-123', 'ABC-123', 'ABC-123'],
  ['abc-123.tar.GZ', 'ABC-123.tar.gz', 'ABC-123'],
  // 번호가 아닌 알파벳은 그대로
  ['Movie 영상.MP4', 'Movie 영상.mp4', null],
  ['영상.mp4', '영상.mp4', null],
  ['Vlog-2024.mp4', 'Vlog-2024.mp4', null],
  ['PART-12.mp4', 'PART-12.mp4', null],
  ['ABC-123-01.mp4', 'ABC-123-01.mp4', null],
  ['ABC-123A.mp4', 'ABC-123A.mp4', null],
];

for (const [input, name, number] of cases) {
  test(`${input} -> ${name}`, () => {
    const result = normalizeName(input);
    assert.strictEqual(result.name, name);
    assert.strictEqual(result.number, number);
    assert.strictEqual(result.reason, null);
  });
}

test('대문자 번호가 있으면 소문자 말은 번호로 보지 않는다', () => {
  assert.strictEqual(normalizeName('trip-2023 ABC-123.mp4').name, 'ABC-123 trip-2023.mp4');
});

test('다른 번호가 여럿이면 그대로 두고 사유를 알린다', () => {
  for (const input of ['ABC-123 XYZ-999.MP4', 'abc-123 xyz-999.mp4']) {
    const result = normalizeName(input);
    assert.strictEqual(result.name, input);
    assert.strictEqual(result.number, null);
    assert.match(result.reason, /번호가 여럿/);
  }
});

test('점으로 시작하는 이름은 그대로 둔다', () => {
  const result = normalizeName('.abc-123.MP4');
  assert.strictEqual(result.name, '.abc-123.MP4');
  assert.match(result.reason, /점으로 시작/);
});

test('이름이 너무 길어지면 그대로 두고 사유를 알린다', () => {
  // 번호를 앞으로 옮기면 공백 하나만큼 늘어난다. 지운 자리 앞의 글자에 구분 문자가 없어야 한다.
  const long = `${'가'.repeat(243)}(abc-123).mp4`.replace('(', '').replace(')', '');
  const atLimit = `${'가'.repeat(255 - 'abc-123.mp4'.length)}abc-123.mp4`;
  assert.strictEqual(atLimit.length, 255);
  const result = normalizeName(atLimit);
  assert.strictEqual(result.name, atLimit);
  assert.match(result.reason, /이름이 너무 깁니다/);
  assert.strictEqual(normalizeName(long).reason, null);
});

test('정규화한 이름의 끝이 점이나 공백이 되지 않는다', () => {
  for (const input of ['abc-123 .mp4', 'abc-123..mp4', 'abc-123 - .mp4', '. abc-123']) {
    const { name } = normalizeName(input);
    assert.doesNotMatch(name.replace(/\.mp4$/, ''), /[. ]$/, input);
  }
});

test('한 번 더 정규화해도 같다', () => {
  for (const [input] of cases) {
    const once = normalizeName(input).name;
    assert.strictEqual(normalizeName(once).name, once, input);
  }
});

test('번호 위치를 원문 기준으로 돌려준다', () => {
  assert.deepStrictEqual(findProductNumberRanges('영상 ＡＢＣ－１２３ 끝'), [{ number: 'ABC-123', start: 3, end: 10 }]);
  assert.deepStrictEqual(findProductNumberRanges('abc-123 ABC-123', { lowercase: true }), [
    { number: 'ABC-123', start: 0, end: 7 },
    { number: 'ABC-123', start: 8, end: 15 },
  ]);
  assert.deepStrictEqual(findProductNumberRanges('abc-123'), []);
  assert.deepStrictEqual(findProductNumberRanges(undefined), []);
});

test('extractProductNumbers의 결과는 그대로다', () => {
  assert.deepStrictEqual(extractProductNumbers('ABC-123 XYZ-999 ABC-123 abc-456'), ['ABC-123', 'XYZ-999']);
  assert.deepStrictEqual(extractProductNumbers('abc-456', { lowercase: true }), ['ABC-456']);
});
