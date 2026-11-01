'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractProductNumbers, findProductNumber } = require('../src/product');

test('extractProductNumbers는 글 어디에 있든 대문자 번호를 찾는다', () => {
  for (const [text, expected] of [
    ['ABC-123', ['ABC-123']],
    ['ABC-123.mp4', ['ABC-123']],
    ['ABC-123.1080p.mp4', ['ABC-123']],
    ['영상 ABC-123.mp4', ['ABC-123']],
    ['영상ABC-123제목', ['ABC-123']],
    ['[ABC-123] 제목', ['ABC-123']],
    ['(ABC-123)_제목', ['ABC-123']],
    ['AB-12', ['AB-12']],
    ['ABCDEF-12345', ['ABCDEF-12345']],
    ['ABC-00123', ['ABC-00123']],
    ['ABC-123-2.mp4', ['ABC-123']],
    ['1-ABC-123', ['ABC-123']],
    ['ＡＢＣ－１２３', ['ABC-123']],
  ]) {
    assert.deepStrictEqual(extractProductNumbers(text), expected, text);
  }
});

test('extractProductNumbers는 여러 번호를 나온 순서대로, 같은 번호는 한 번만 돌려준다', () => {
  assert.deepStrictEqual(extractProductNumbers('XYZ-999 ABC-123 ABC-123 XYZ-999'), ['XYZ-999', 'ABC-123']);
});

test('extractProductNumbers는 형식이 다르면 찾지 않는다', () => {
  for (const text of [
    '',
    'ABC123',
    'ABC_123',
    'ABC 123',
    'A-123',
    'ABCDEFG-123',
    'ABC-1',
    'ABC-123456',
    '1ABC-123',
    'ABC-123A',
    'X264-10',
    '123-456',
    '2024-05-01',
    '아이-123',
    'XYZ-ABC-123',
    'SUMMER-TRIP-20',
  ]) {
    assert.deepStrictEqual(extractProductNumbers(text), [], text);
  }
});

test('extractProductNumbers는 뒤에 숫자 묶음이 이어지는 문자열의 앞부분을 잡지 않는다', () => {
  for (const text of ['ZZZ-2024-05-01', 'CVE-2024-1234', 'TEL-010-1234-5678', '12345678-ABCD-1234-5678-123456789012', 'ABC-123-01.mp4']) {
    assert.deepStrictEqual(extractProductNumbers(text), [], text);
  }
});

test('extractProductNumbers는 기본으로 소문자와 대소문자 혼합을 찾지 않는다', () => {
  for (const text of ['abc-123', 'summer-2023', 'https://site-123.com/x', 'Vlog-2024', 'Report-2023', 'aBc-123', 'ａｂｃ-１２３']) {
    assert.deepStrictEqual(extractProductNumbers(text), [], text);
  }
});

test('extractProductNumbers는 lowercase를 켜면 전부 소문자인 말을 찾고 대소문자 혼합은 찾지 않는다', () => {
  const options = { lowercase: true };
  assert.deepStrictEqual(extractProductNumbers('영상 abc-123.mp4', options), ['ABC-123']);
  assert.deepStrictEqual(extractProductNumbers('ABC-123', options), ['ABC-123']);
  assert.deepStrictEqual(extractProductNumbers('ａｂｃ－１２３', options), ['ABC-123']);
  for (const text of ['Vlog-2024', 'aBc-123', 'summer-trip-20', 'part-01', 'videos-2024']) {
    assert.deepStrictEqual(extractProductNumbers(text, options), [], text);
  }
});

test('extractProductNumbers는 번호를 바꾸는 호환 글자를 숫자로 풀지 않는다', () => {
  assert.deepStrictEqual(extractProductNumbers('ABC-12½'), ['ABC-12']);
  assert.deepStrictEqual(extractProductNumbers('ABC-123²'), ['ABC-123']);
  assert.deepStrictEqual(extractProductNumbers('ABC-123①'), ['ABC-123']);
  for (const text of ['㎏-100', '㎞-42', '℡-123', 'Ⅻ-123', '™-123']) {
    assert.deepStrictEqual(extractProductNumbers(text), [], text);
  }
});

test('extractProductNumbers는 제품번호가 아닌 흔한 말을 대소문자와 관계없이 뺀다', () => {
  for (const text of [
    'PART-01', 'CD-02', 'IMG-1234', 'DSC-0001', 'HD-1080', 'UTF-16', 'COVID-19', 'ISO-9001', 'FY-2023', 'JAN-2024', 'BACKUP-2024',
    'VLOG-2024', 'PG-13', 'TV-14', 'SHA-256', 'AES-256', 'RFC-2616', 'HDR-10', 'HTTP-404', 'CP-949', 'FILM-01', 'AUDIO-2024', 'PHOTOS-2023', 'MARCH-2024', 'TOP-10', 'DAY-01',
  ]) {
    assert.deepStrictEqual(extractProductNumbers(text), [], text);
    assert.deepStrictEqual(extractProductNumbers(text.toLowerCase(), { lowercase: true }), [], text);
  }
  assert.deepStrictEqual(extractProductNumbers('CD-02 ABC-123'), ['ABC-123']);
});

test('extractProductNumbers는 문자열이 아니면 빈 목록이다', () => {
  for (const value of [null, undefined, 5, {}]) {
    assert.deepStrictEqual(extractProductNumbers(value), []);
  }
});

test('extractProductNumbers는 연달아 불러도 결과가 같다', () => {
  assert.deepStrictEqual(extractProductNumbers('ABC-123'), ['ABC-123']);
  assert.deepStrictEqual(extractProductNumbers('ABC-123'), ['ABC-123']);
});

test('findProductNumber는 파일명, 제목, 폴더, 코멘트, 파일명의 소문자 순으로 고른다', () => {
  const all = { fileName: 'AAA-111 fff-666.mp4', title: 'BBB-222', comment: 'CCC-333', folders: ['DDD-444', 'EEE-555'] };
  assert.deepStrictEqual(findProductNumber(all), {
    number: 'AAA-111',
    source: 'fileName',
    candidates: [
      { number: 'AAA-111', source: 'fileName' },
      { number: 'BBB-222', source: 'title' },
      { number: 'DDD-444', source: 'folder' },
      { number: 'EEE-555', source: 'folder' },
      { number: 'CCC-333', source: 'comment' },
      { number: 'FFF-666', source: 'fileName' },
    ],
  });
  assert.strictEqual(findProductNumber({ ...all, fileName: 'x.mp4' }).number, 'BBB-222');
  assert.strictEqual(findProductNumber({ ...all, fileName: 'x.mp4', title: null }).number, 'DDD-444');
  assert.strictEqual(findProductNumber({ ...all, fileName: 'x.mp4', title: null, folders: [] }).number, 'CCC-333');
});

test('findProductNumber는 파일명의 소문자 번호를 인정하되 다른 곳의 번호를 가리지 않는다', () => {
  assert.deepStrictEqual(findProductNumber({ fileName: '영상 abc-123.mp4' }), {
    number: 'ABC-123',
    source: 'fileName',
    candidates: [{ number: 'ABC-123', source: 'fileName' }],
  });
  assert.strictEqual(findProductNumber({ fileName: 'zzz-2023.mp4', title: 'ABC-123' }).number, 'ABC-123');
});

test('findProductNumber는 제목, 코멘트, 폴더의 소문자를 번호로 보지 않는다', () => {
  assert.strictEqual(findProductNumber({ fileName: 'x.mp4', title: 'abc-123', comment: 'https://site-123.com', folders: ['summer-2023'] }), null);
  assert.strictEqual(findProductNumber({ fileName: 'x.mp4', comment: 'https://site-123.com', folders: ['ABC-123'] }).number, 'ABC-123');
});

test('findProductNumber는 같은 번호를 처음 찾은 곳으로 한 번만 넣는다', () => {
  const result = findProductNumber({ fileName: 'x.mp4', title: 'ABC-123', folders: ['ABC-123 제목'] });
  assert.deepStrictEqual(result, { number: 'ABC-123', source: 'title', candidates: [{ number: 'ABC-123', source: 'title' }] });
});

test('findProductNumber는 찾지 못하거나 입력이 없으면 null이다', () => {
  assert.strictEqual(findProductNumber(), null);
  assert.strictEqual(findProductNumber(null), null);
  assert.strictEqual(findProductNumber({}), null);
  assert.strictEqual(findProductNumber({ folders: null }), null);
  assert.strictEqual(findProductNumber({ fileName: 'video.mp4', title: null, comment: null, folders: ['새 폴더'] }), null);
});
