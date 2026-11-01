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
  ['영상_abc-123_끝.mp4', 'ABC-123 영상 끝.mp4', 'ABC-123'],
  ['영상 - ABC-123 - 끝.mp4', 'ABC-123 영상 끝.mp4', 'ABC-123'],
  ['앞 ABC-123 뒤.mp4', 'ABC-123 앞 뒤.mp4', 'ABC-123'],
  ['앞 - 뒤 ABC-123.mp4', 'ABC-123 앞 - 뒤.mp4', 'ABC-123'],
  ['ABC-123.mp4', 'ABC-123.mp4', 'ABC-123'],
  ['abc-123.mp4', 'ABC-123.mp4', 'ABC-123'],
  // 괄호
  ['[abc-123] 영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['영상 (ABC-123).mkv', 'ABC-123 영상.mkv', 'ABC-123'],
  ['【ABC-123】영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['[태그] ABC-123.mp4', 'ABC-123 [태그].mp4', 'ABC-123'],
  ['[(abc-123)].mp4', 'ABC-123.mp4', 'ABC-123'],
  ['((abc-123)).mp4', 'ABC-123.mp4', 'ABC-123'],
  ['【(abc-123)】영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['［ＡＢＣ－１２３］ 영상.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['《abc-123》.mp4', 'ABC-123.mp4', 'ABC-123'],
  ['(abc-123 감독판).mp4', 'ABC-123 (감독판).mp4', 'ABC-123'],
  ['[태그 abc-123].mp4', 'ABC-123 [태그].mp4', 'ABC-123'],
  // 전각
  ['영상 ＡＢＣ－１２３.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  ['－ABC-123－.mp4', 'ABC-123.mp4', 'ABC-123'],
  ['＿abc-123＿.mp4', 'ABC-123.mp4', 'ABC-123'],
  // 같은 번호가 두 번
  ['abc-123 ABC-123.mp4', 'ABC-123 abc-123.mp4', 'ABC-123'],
  ['ABC-123 영상 ABC-123.mp4', 'ABC-123 영상.mp4', 'ABC-123'],
  // 화질 꼬리
  ['ABC-123-1080p.mp4', 'ABC-123 1080p.mp4', 'ABC-123'],
  // 번호 바로 뒤의 점은 짝 이름과 조각 이름이라 유지한다
  ['ABC-123.en.srt', 'ABC-123.en.srt', 'ABC-123'],
  ['abc-123.en.srt', 'ABC-123.en.srt', 'ABC-123'],
  ['ABC-123.part1.rar', 'ABC-123.part1.rar', 'ABC-123'],
  ['ABC-123.7z.001', 'ABC-123.7z.001', 'ABC-123'],
  ['abc-123.mp4.bak', 'ABC-123.mp4.bak', 'ABC-123'],
  ['abc-123..mp4', 'ABC-123.mp4', 'ABC-123'],
  // 확장자는 그대로 둔다
  ['영상 abc-123.MP4', 'ABC-123 영상.MP4', 'ABC-123'],
  ['abc-123', 'ABC-123', 'ABC-123'],
  ['abc-123.tar.GZ', 'ABC-123.tar.GZ', 'ABC-123'],
  ['영상 abc-123.tar.gz', 'ABC-123 영상.tar.gz', 'ABC-123'],
  // .tar.mp4는 겹 확장자가 아니다.
  ['영상 abc-123.tar.mp4', 'ABC-123 영상 tar.mp4', 'ABC-123'],
  // 확장자가 아닌 꼬리에 번호가 있는 경우
  ['Title.v2 ABC-123', 'ABC-123 Title.v2', 'ABC-123'],
  ['영상.ABC-123', 'ABC-123 영상', 'ABC-123'],
  // 번호가 아닌 알파벳은 그대로
  ['Movie 영상.MP4', 'Movie 영상.MP4', null],
  ['Mr.Robot', 'Mr.Robot', null],
  ['Dr.Who S01', 'Dr.Who S01', null],
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

test('소문자 말에서 찾은 번호에 표시를 한다', () => {
  assert.strictEqual(normalizeName('abc-123.mp4').inferred, true);
  assert.strictEqual(normalizeName('ABC-123.mp4').inferred, false);
  assert.strictEqual(normalizeName('trip-2023 ABC-123.mp4').inferred, false);
  assert.strictEqual(normalizeName('영상.mp4').inferred, false);
});

test('대문자 번호가 있으면 소문자 말은 번호로 보지 않는다', () => {
  assert.strictEqual(normalizeName('trip-2023 ABC-123.mp4').name, 'ABC-123 trip-2023.mp4');
});

test('다른 번호가 여럿이면 그대로 두고 사유를 알린다', () => {
  for (const input of ['ABC-123 XYZ-999.MP4', 'abc-123 xyz-999.mp4', 'ABC-123.DEF-456', 'def-456.abc-123']) {
    const result = normalizeName(input);
    assert.strictEqual(result.name, input);
    assert.strictEqual(result.number, null);
    assert.match(result.reason, /번호가 여럿/);
  }
});

test('바꾸면 안 되는 이름은 그대로 두고 사유를 알린다', () => {
  const unchanged = {
    '.abc-123.MP4': /숨김이나 임시/,
    '~$abc-123.docx': /숨김이나 임시/,
    'abc-123.': /끝이 점이나 공백/,
    'abc-123...': /끝이 점이나 공백/,
    'abc-123. ': /끝이 점이나 공백/,
    'abc-123.mp4 ': /끝이 점이나 공백/,
    'abc-123.mp4　': /끝이 점이나 공백/,
    'abc-123\u0085': /끝이 점이나 공백/,
    'C:\\x\\abc-123.mp4': /쓸 수 없는 문자/,
    'abc/def abc-123.mp4': /쓸 수 없는 문자/,
    'abc-123.mp4:stream': /쓸 수 없는 문자/,
    'abc-123\u0001.mp4': /쓸 수 없는 문자/,
  };
  for (const [input, reason] of Object.entries(unchanged)) {
    const result = normalizeName(input);
    assert.strictEqual(result.name, input, input);
    assert.match(result.reason, reason, input);
  }
});

test('이름이 너무 길어지면 그대로 두고 사유를 알린다', () => {
  const atLimit = `${'가'.repeat(255 - 'abc-123.mp4'.length)}abc-123.mp4`;
  assert.strictEqual(atLimit.length, 255);
  const result = normalizeName(atLimit);
  assert.strictEqual(result.name, atLimit);
  assert.strictEqual(result.number, 'ABC-123');
  assert.match(result.reason, /이름이 너무 깁니다/);
  assert.strictEqual(normalizeName(`${'가'.repeat(243)}abc-123.mp4`).reason, null);
});

test('한 번 더 정규화해도 같다', () => {
  const parts = ['abc-123', 'ABC-123', 'ＡＢＣ－１２３', '영상', 'x', '.', ' ', '_', '-', '－', '[', ']', '(', ')', '【', '】', '.mp4', '.MP4', '.tar.gz', '.tar', '.TAR', '.en', '1080p', '😀', '\u200b'];
  let seed = 4242;
  const next = (limit) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  const inputs = cases.map(([input]) => input);
  for (let round = 0; round < 20000; round += 1) {
    let input = '';
    for (let count = 1 + next(6); count > 0; count -= 1) input += parts[next(parts.length)];
    inputs.push(input);
  }
  for (const input of inputs) {
    const once = normalizeName(input);
    assert.strictEqual(normalizeName(once.name).name, once.name, JSON.stringify(input));
    assert.doesNotMatch(once.reason === null && once.number ? once.name : 'ok', /[. ]$/, JSON.stringify(input));
    assert.notStrictEqual(once.name, '', JSON.stringify(input));
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
