'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractProductNumbers, findProductNumber } = require('../src/product');

test('extractProductNumbers는 글 어디에 있든 대문자로 찾는다', () => {
  for (const [text, expected] of [
    ['ABC-123', ['ABC-123']],
    ['abc-123', ['ABC-123']],
    ['ABC-123.mp4', ['ABC-123']],
    ['영상 abc-123.mp4', ['ABC-123']],
    ['영상abc-123제목', ['ABC-123']],
    ['[ABC-123] 제목', ['ABC-123']],
    ['(abc-123)_제목', ['ABC-123']],
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
  assert.deepStrictEqual(extractProductNumbers('xyz-999 ABC-123 abc-123 XYZ-999'), ['XYZ-999', 'ABC-123']);
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
    'x264-10',
    '123-456',
    '2024-05-01',
    '아이-123',
    'Vlog-2024',
    'Report-2023',
    'aBc-123',
    'summer-trip-20',
    'XYZ-ABC-123',
  ]) {
    assert.deepStrictEqual(extractProductNumbers(text), [], text);
  }
});

test('extractProductNumbers는 제품번호가 아닌 흔한 말을 대소문자와 관계없이 뺀다', () => {
  for (const text of ['PART-01', 'part-01', 'CD-02', 'IMG-1234', 'DSC-0001', 'HD-1080', 'uhd-2160', 'UTF-16', 'COVID-19', 'ISO-9001', 'FY-2023', 'JAN-2024', 'BACKUP-2024', 'Season-01']) {
    assert.deepStrictEqual(extractProductNumbers(text), [], text);
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

test('findProductNumber는 파일명, 제목, 코멘트, 폴더 순으로 고른다', () => {
  const all = { fileName: 'aaa-111.mp4', title: 'bbb-222', comment: 'ccc-333', folders: ['ddd-444', 'eee-555'] };
  assert.deepStrictEqual(findProductNumber(all), {
    number: 'AAA-111',
    source: 'fileName',
    candidates: [
      { number: 'AAA-111', source: 'fileName' },
      { number: 'BBB-222', source: 'title' },
      { number: 'CCC-333', source: 'comment' },
      { number: 'DDD-444', source: 'folder' },
      { number: 'EEE-555', source: 'folder' },
    ],
  });
  assert.strictEqual(findProductNumber({ ...all, fileName: 'x.mp4' }).source, 'title');
  assert.strictEqual(findProductNumber({ ...all, fileName: 'x.mp4', title: null }).source, 'comment');
  const onlyFolders = findProductNumber({ ...all, fileName: 'x.mp4', title: null, comment: null });
  assert.strictEqual(onlyFolders.source, 'folder');
  assert.strictEqual(onlyFolders.number, 'DDD-444');
});

test('findProductNumber는 같은 번호를 처음 찾은 곳으로 한 번만 넣는다', () => {
  const result = findProductNumber({ fileName: 'x.mp4', title: 'abc-123', folders: ['ABC-123 제목'] });
  assert.deepStrictEqual(result, { number: 'ABC-123', source: 'title', candidates: [{ number: 'ABC-123', source: 'title' }] });
});

test('findProductNumber는 찾지 못하면 null이다', () => {
  assert.strictEqual(findProductNumber(), null);
  assert.strictEqual(findProductNumber({}), null);
  assert.strictEqual(findProductNumber({ fileName: 'video.mp4', title: null, comment: null, folders: ['새 폴더'] }), null);
});
