'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { readMkvMetadata } = require('../src/mkv');
const { addProductNumbers } = require('../src/productName');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mkv-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

const size = (length) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(length));
  b[0] = 0x01;
  return b;
};
const idBytes = (id) => Buffer.from(id.toString(16).padStart(id.toString(16).length + (id.toString(16).length % 2), '0'), 'hex');
const el = (id, ...parts) => {
  const body = Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : part)));
  return Buffer.concat([idBytes(id), size(body.length), body]);
};
const uint = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};
const double = (value) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value);
  return b;
};
const float = (value) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(value);
  return b;
};

const header = (type = 'matroska') => el(0x1a45dfa3, el(0x4282, type));
const info = ({ title, ticks = 90000, scale = 1000000 } = {}) => el(0x1549a966, el(0x2ad7b1, uint(scale)), el(0x4489, double(ticks)), ...(title === undefined ? [] : [el(0x7ba9, title)]));
const videoTrack = (width, height) => el(0xae, el(0x83, Buffer.from([1])), el(0xe0, el(0xb0, uint(width)), el(0xba, uint(height))));
const audioTrack = () => el(0xae, el(0x83, Buffer.from([2])));
const tracks = (...entries) => el(0x1654ae6b, ...entries);
const simple = (name, value) => el(0x67c8, el(0x45a3, name), el(0x4487, value));
const tags = (...parts) => el(0x1254c367, ...parts.map((part) => (Buffer.isBuffer(part) ? part : el(0x7373, simple(part[0], part[1])))));
const cluster = (length = 100) => el(0x1f43b675, Buffer.alloc(length));
const segment = (...parts) => el(0x18538067, ...parts);

function write(dir, name, ...parts) {
  fs.writeFileSync(path.join(dir, name), Buffer.concat(parts));
  return name;
}

test('제목, 길이, 해상도, 코멘트, 비트레이트를 읽는다', () => {
  const dir = tempDir();
  const file = write(dir, 'a.mkv', header(), segment(info({ title: 'ABC-123 제목' }), tracks(audioTrack(), videoTrack(1920, 1080)), tags(['COMMENT', '메모']), cluster()));
  const result = readMkvMetadata(dir, file);
  assert.strictEqual(result.title, 'ABC-123 제목');
  assert.strictEqual(result.comment, '메모');
  assert.strictEqual(result.duration, 90);
  assert.strictEqual(result.width, 1920);
  assert.strictEqual(result.height, 1080);
  assert.strictEqual(result.bitrate, Math.round((fs.statSync(path.join(dir, file)).size * 8) / 90));
});

test('webm도 읽고, 길이는 TimecodeScale을 따른다', () => {
  const dir = tempDir();
  const file = write(dir, 'a.webm', header('webm'), segment(el(0x1549a966, el(0x2ad7b1, uint(1000)), el(0x4489, float(2000000))), tracks(videoTrack(640, 360))));
  const result = readMkvMetadata(dir, file);
  assert.strictEqual(result.duration, 2);
  assert.strictEqual(result.height, 360);
});

test('TimecodeScale이 없으면 기본값을 쓴다', () => {
  const dir = tempDir();
  const file = write(dir, 'a.mkv', header(), segment(el(0x1549a966, el(0x4489, double(5000)))));
  assert.strictEqual(readMkvMetadata(dir, file).duration, 5);
});

test('Cluster 뒤의 요소는 SeekHead로 찾아간다', () => {
  const dir = tempDir();
  const head = (position) => el(0x114d9b74, el(0x4dbb, el(0x53ab, Buffer.from('1254C367', 'hex')), el(0x53ac, uint(position))));
  const before = Buffer.concat([info({ title: 'T' }), cluster(5000)]);
  const position = head(0).length + before.length;
  const file = write(dir, 'a.mkv', header(), segment(head(position), before, tags(['COMMENT', 'XYZ-999 뒤쪽'])));
  assert.strictEqual(readMkvMetadata(dir, file).comment, 'XYZ-999 뒤쪽');
});

test('SeekHead가 다른 종류의 요소를 가리키면 쓰지 않는다', () => {
  const dir = tempDir();
  const head = (position) => el(0x114d9b74, el(0x4dbb, el(0x53ab, Buffer.from('1549A966', 'hex')), el(0x53ac, uint(position))));
  const file = write(dir, 'a.mkv', header(), segment(head(0), cluster(), tags(['TITLE', '뒤'])));
  assert.strictEqual(readMkvMetadata(dir, file).title, null);
});

test('크기를 모르는 Segment도 읽고 Cluster에서 멈춘다', () => {
  const dir = tempDir();
  const unknown = Buffer.from('18538067' + '01FFFFFFFFFFFFFF', 'hex');
  const file = write(dir, 'a.mkv', header(), unknown, info({ title: 'LIVE' }), Buffer.from('1F43B675' + '01FFFFFFFFFFFFFF', 'hex'), Buffer.alloc(50));
  assert.strictEqual(readMkvMetadata(dir, file).title, 'LIVE');
});

test('Info에 제목이 없으면 태그의 TITLE을 쓰고, 코멘트는 DESCRIPTION도 본다', () => {
  const dir = tempDir();
  const file = write(dir, 'a.mkv', header(), segment(info(), tags(['title', '태그 제목'], ['DESCRIPTION', '설명'])));
  const result = readMkvMetadata(dir, file);
  assert.strictEqual(result.title, '태그 제목');
  assert.strictEqual(result.comment, '설명');
});

test('트랙에 붙은 태그는 파일 전체의 값으로 쓰지 않는다', () => {
  const dir = tempDir();
  const trackTag = el(0x7373, el(0x63c0, el(0x63c5, uint(7))), simple('TITLE', '트랙 제목'));
  const globalTag = el(0x7373, el(0x63c0, el(0x63c5, uint(0))), simple('COMMENT', '전체'));
  const file = write(dir, 'a.mkv', header(), segment(info(), tags(trackTag, globalTag)));
  const result = readMkvMetadata(dir, file);
  assert.strictEqual(result.title, null);
  assert.strictEqual(result.comment, '전체');
});

test('64비트 UID가 붙은 태그도 파일 전체의 값으로 쓰지 않는다', () => {
  const dir = tempDir();
  for (const id of [0x63c5, 0x63c9, 0x63c4, 0x63c6]) {
    const tag = el(0x7373, el(0x63c0, el(id, Buffer.from('DEADBEEFCAFEBABE', 'hex'))), simple('TITLE', 'ABC-999'), simple('COMMENT', 'XYZ-111'));
    const file = write(dir, 'a.mkv', header(), segment(tags(tag)));
    const result = readMkvMetadata(dir, file);
    assert.strictEqual(result.title, null);
    assert.strictEqual(result.comment, null);
  }
});

test('영화 수준의 태그만 파일의 제목으로 쓴다', () => {
  const dir = tempDir();
  const level = (value, title) => el(0x7373, el(0x63c0, el(0x68ca, Buffer.from([value]))), simple('TITLE', title));
  const file = write(dir, 'a.mkv', header(), segment(tags(level(70, 'SER-100'), level(30, 'SNG-300'), level(50, 'EPI-200'))));
  assert.strictEqual(readMkvMetadata(dir, file).title, 'EPI-200');
  const series = write(dir, 'b.mkv', header(), segment(tags(level(70, 'SER-100'))));
  assert.strictEqual(readMkvMetadata(dir, series).title, null);
  const empty = write(dir, 'c.mkv', header(), segment(tags(el(0x7373, el(0x63c0, el(0x68ca)), simple('TITLE', 'DEF-111')))));
  assert.strictEqual(readMkvMetadata(dir, empty).title, 'DEF-111');
});

test('겹치게 만든 SeekHead로 메모리를 고갈시키지 못한다', () => {
  const dir = tempDir();
  const seekEntry = (position) => el(0x4dbb, el(0x53ab, Buffer.from('114D9B74', 'hex')), el(0x53ac, uint(position)));
  const step = 4 + 8 + seekEntry(0).length;
  let inner = el(0xec, Buffer.alloc(1024 * 1024));
  for (let index = 100; index >= 0; index -= 1) inner = el(0x114d9b74, seekEntry((index + 1) * step), inner);
  const file = write(dir, 'a.mkv', header(), segment(inner));
  assert.throws(() => readMkvMetadata(dir, file), (err) => err instanceof FcError && /너무 많아/.test(err.message));
});

test('SeekHead의 같은 항목은 한 번만 보고 순환해도 끝난다', () => {
  const dir = tempDir();
  const entry = el(0x4dbb, el(0x53ab, Buffer.from('114D9B74', 'hex')), el(0x53ac, uint(0)));
  const file = write(dir, 'a.mkv', header(), segment(el(0x114d9b74, ...Array(5000).fill(entry)), info({ title: 'T' })));
  assert.strictEqual(readMkvMetadata(dir, file).title, 'T');
});

test('Void와 CRC-32 요소를 건너뛴다', () => {
  const dir = tempDir();
  const file = write(dir, 'a.mkv', header(), segment(el(0xec, Buffer.alloc(10)), el(0xbf, uint(1)), el(0x1549a966, el(0xbf, uint(1)), el(0x7ba9, 'T'))));
  assert.strictEqual(readMkvMetadata(dir, file).title, 'T');
});

test('크기를 모르는 표기를 1~8바이트 모두 알아본다', () => {
  const dir = tempDir();
  const forms = ['FF', '7FFF', '3FFFFF', '1FFFFFFF', '0FFFFFFFFF', '07FFFFFFFFFF', '03FFFFFFFFFFFF', '01FFFFFFFFFFFFFF'];
  for (const form of forms) {
    const file = write(dir, 'a.mkv', header(), Buffer.from(`18538067${form}`, 'hex'), info({ title: form }));
    assert.strictEqual(readMkvMetadata(dir, file).title, form);
  }
});

test('영상 트랙이 여럿이면 가장 큰 것을 쓴다', () => {
  const dir = tempDir();
  const file = write(dir, 'a.mkv', header(), segment(tracks(videoTrack(160, 90), videoTrack(1280, 720), videoTrack(320, 180))));
  const result = readMkvMetadata(dir, file);
  assert.deepStrictEqual([result.width, result.height], [1280, 720]);
});

test('없는 값은 null이다', () => {
  const dir = tempDir();
  const file = write(dir, 'a.mkv', header(), segment());
  assert.deepStrictEqual(readMkvMetadata(dir, file), { title: null, comment: null, duration: null, width: null, height: null, bitrate: null });
});

test('길이가 0이거나 숫자가 아니면 null이고 나누기 오류가 없다', () => {
  const dir = tempDir();
  for (const value of [0, NaN, Infinity, -5]) {
    const file = write(dir, 'a.mkv', header(), segment(info({ ticks: value })));
    const result = readMkvMetadata(dir, file);
    assert.strictEqual(result.duration, null);
    assert.strictEqual(result.bitrate, null);
  }
});

test('계산한 길이가 비정상이면 null이다', () => {
  const dir = tempDir();
  for (const [ticks, scale] of [[1e308, 1000000], [5e-324, 1], [1e-300, 1]]) {
    const file = write(dir, 'a.mkv', header(), segment(info({ ticks, scale })));
    const result = readMkvMetadata(dir, file);
    if (result.duration !== null) assert.ok(Number.isFinite(result.duration) && result.duration > 0);
    assert.ok(result.bitrate === null || (Number.isFinite(result.bitrate) && result.bitrate > 0));
  }
  const huge = write(dir, 'b.mkv', header(), segment(info({ ticks: 1e308 })));
  assert.strictEqual(readMkvMetadata(dir, huge).duration, null);
});

test('빈 TimecodeScale은 기본값으로, 0은 없는 값으로 읽는다', () => {
  const dir = tempDir();
  const empty = write(dir, 'a.mkv', header(), segment(el(0x1549a966, el(0x2ad7b1), el(0x4489, double(5000)))));
  assert.strictEqual(readMkvMetadata(dir, empty).duration, 5);
  const zero = write(dir, 'b.mkv', header(), segment(el(0x1549a966, el(0x2ad7b1, uint(0)), el(0x4489, double(5000)))));
  assert.strictEqual(readMkvMetadata(dir, zero).duration, null);
});

test('MKV/WebM이 아니면 FcError를 낸다', () => {
  const dir = tempDir();
  const cases = { 'text.mkv': Buffer.from('not mkv'), 'empty.mkv': Buffer.alloc(0), 'other.mkv': Buffer.concat([header('other'), segment()]), 'noseg.mkv': header(), 'mp4.mkv': Buffer.from('00000018667479706d703432', 'hex') };
  for (const [name, data] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, name), data);
    assert.throws(() => readMkvMetadata(dir, name), (err) => err instanceof FcError && /MKV\/WebM 형식이 아닙니다/.test(err.message), name);
  }
});

test('잘린 요소는 건너뛰고 앞서 찾은 값을 돌려준다', () => {
  const dir = tempDir();
  const whole = Buffer.concat([header(), segment(info({ title: 'KEEP' }), tracks(videoTrack(640, 360)))]);
  fs.writeFileSync(path.join(dir, 'cut.mkv'), whole.subarray(0, whole.length - 5));
  const result = readMkvMetadata(dir, 'cut.mkv');
  assert.strictEqual(result.title, 'KEEP');
  assert.strictEqual(result.width, null);
});

test('변조된 파일에서도 FcError 말고 다른 예외가 나지 않는다', () => {
  const dir = tempDir();
  const whole = Buffer.concat([header(), segment(info({ title: 'T' }), tracks(videoTrack(640, 360)), tags(['COMMENT', 'C']), cluster(20))]);
  let seed = 12345;
  const next = (limit) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  for (let round = 0; round < 1500; round += 1) {
    const data = Buffer.from(whole);
    for (let hit = 0; hit < 1 + next(4); hit += 1) data[next(data.length)] = next(256);
    const cut = round % 3 === 0 ? data.subarray(0, next(data.length)) : data;
    fs.writeFileSync(path.join(dir, 'f.mkv'), cut);
    try {
      readMkvMetadata(dir, 'f.mkv');
    } catch (err) {
      assert.ok(err instanceof FcError, err.stack);
    }
  }
});

test('큰 파일에서 영상 데이터를 읽지 않는다', (t) => {
  const dir = tempDir();
  const file = write(dir, 'a.mkv', header(), segment(info({ title: 'T' }), cluster(5 * 1024 * 1024)));
  const readSync = t.mock.method(fs, 'readSync');
  readMkvMetadata(dir, file);
  const total = readSync.mock.calls.reduce((sum, call) => sum + call.result, 0);
  t.mock.restoreAll();
  assert.ok(total < 4096, `읽은 바이트: ${total}`);
});

test('보호 경로와 타겟 밖, 없는 파일은 FcError다', () => {
  const dir = tempDir();
  assert.throws(() => readMkvMetadata(process.env.SystemRoot ?? 'C:\\Windows', 'a.mkv'), FcError);
  assert.throws(() => readMkvMetadata(dir, '../a.mkv'), FcError);
  assert.throws(() => readMkvMetadata(dir, 'none.mkv'), FcError);
});

test('product-number가 MKV의 제목과 코멘트에서 번호를 찾는다', () => {
  const dir = tempDir();
  write(dir, 'a.mkv', header(), segment(info({ title: 'ABC-123 제목' })));
  write(dir, 'b.webm', header('webm'), segment(tags(['COMMENT', 'XYZ-999'])));
  fs.writeFileSync(path.join(dir, 'broken.mkv'), 'not mkv');
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(result.renamed.map((item) => [item.name, item.source]).sort(), [['ABC-123 a.mkv', 'title'], ['XYZ-999 b.webm', 'comment']]);
  assert.match(result.notFound[0].note, /MKV\/WebM 형식이 아닙니다/);
});
