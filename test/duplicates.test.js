'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { duplicateKey, findDuplicateNames, formatDuplicateNames } = require('../src/duplicates');
const { run } = require('../bin/fctl');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dup-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function put(root, relative, content = 'x') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const keyOf = (name) => duplicateKey(name)?.key ?? null;

test('duplicateKey: 같은 제품번호는 확장자, 화질, 제목, 위치가 달라도 같은 기준이다', () => {
  const names = ['ABC-123.mp4', '[FHD] ABC-123 제목 1080p.mkv', 'ABC-123 Title.avi', 'ABC-123 (1).mp4', 'ＡＢＣ－１２３.mp4'];
  for (const name of names) assert.deepStrictEqual(duplicateKey(name), { kind: 'number', key: 'ABC-123', number: 'ABC-123', part: null }, name);
});

test('duplicateKey: 같은 번호의 다른 조각은 다른 기준이다', () => {
  assert.strictEqual(keyOf('ABC-123 CD2.mp4'), 'ABC-123 #2');
  assert.strictEqual(keyOf('ABC-123 part 2.mp4'), 'ABC-123 #2');
  assert.strictEqual(keyOf('ABC-123.disc-02.mkv'), 'ABC-123 #2');
  assert.strictEqual(keyOf('ABC-123-1.mp4'), 'ABC-123 #1');
  assert.strictEqual(keyOf('ABC-123_B.mp4'), 'ABC-123 #b');
  assert.notStrictEqual(keyOf('ABC-123 CD1.mp4'), keyOf('ABC-123 CD2.mp4'));
  assert.notStrictEqual(keyOf('ABC-123 CD1.mp4'), keyOf('ABC-123.mp4'));
  // 화질·코덱 표시, 낱말 첫 글자, 끝의 (1)과 복사본 꼬리는 조각이 아니다.
  assert.strictEqual(keyOf('ABC-123 1080p.mp4'), 'ABC-123');
  assert.strictEqual(keyOf('ABC-123 x264 60fps 10bit 4K HEVC AAC2.mp4'), 'ABC-123');
  assert.strictEqual(keyOf('ABC-123 Title.mp4'), 'ABC-123');
  assert.strictEqual(keyOf('ABC-123 (1).mp4'), 'ABC-123');
  assert.strictEqual(keyOf('ABC-123 - 복사본 (2).mp4'), 'ABC-123');
});

test('duplicateKey: 번호 바로 뒤가 아닌 자리의 조각 표시도 가른다', () => {
  const pairs = [
    ['ABC-123 FHD 1.mp4', 'ABC-123 FHD 2.mp4'],
    ['ABC-123-1080p-1.mp4', 'ABC-123-1080p-2.mp4'],
    ['ABC-123 제목 1.mp4', 'ABC-123 제목 2.mp4'],
    ['ABC-123 [1].mp4', 'ABC-123 [2].mp4'],
    ['ABC-123 Episode 1.mp4', 'ABC-123 Episode 2.mp4'],
    ['ABC-123 II.mp4', 'ABC-123 III.mp4'],
    ['ABC-123 前編.mp4', 'ABC-123 後編.mp4'],
    ['ABC-123 part1 CD1.mp4', 'ABC-123 part1 CD2.mp4'],
    ['ABC-123 1.mp4', 'ABC-123 1.5.mp4'],
    ['ABC-123.mp4', 'ABC-123 100.mp4'],
  ];
  for (const [one, other] of pairs) assert.notStrictEqual(keyOf(one), keyOf(other), `${one} / ${other}`);
  assert.strictEqual(keyOf('ABC-123 Episode 01.mp4'), 'ABC-123 #1');
});

test('duplicateKey: 전각으로 쓴 조각 표시도 반각과 같다', () => {
  assert.strictEqual(keyOf('ＡＢＣ－１２３　ＣＤ２.mp4'), 'ABC-123 #2');
  assert.strictEqual(keyOf('ＡＢＣ－１２３　２.mp4'), 'ABC-123 #2');
  assert.strictEqual(keyOf('ABC-123 Ｂ.mp4'), 'ABC-123 #b');
});

test('duplicateKey: 번호가 여럿이면 묶지 않는다', () => {
  assert.deepStrictEqual(duplicateKey('ABC-123 XYZ-456.mp4'), { kind: 'conflict', numbers: ['ABC-123', 'XYZ-456'] });
  // 같은 번호가 두 번 나오는 것은 엇갈림이 아니다.
  assert.strictEqual(keyOf('ABC-123 [ABC-123].mp4'), 'ABC-123');
});

test('duplicateKey: 번호가 없으면 대소문자, 전각, 구분 문자, 복사본 꼬리를 무시한 이름이 기준이다', () => {
  const names = ['My Movie.mp4', 'my_movie.MKV', 'my.movie.avi', 'My Movie - 복사본.mp4', 'My Movie - Copy (2).mp4', 'My Movie - 복사본 - 복사본.mp4', 'ＭＹ　ＭＯＶＩＥ.mp4'];
  for (const name of names) assert.deepStrictEqual(duplicateKey(name), { kind: 'name', key: 'my movie' }, name);
  // 조합형 한글(macOS에서 온 이름)도 완성형과 같다.
  assert.strictEqual(keyOf('여행 영상.mp4'.normalize('NFD')), keyOf('여행 영상.mp4'));
  // 번호처럼 보이는 꼬리 (1)은 다른 영상일 수 있어 그대로 둔다.
  assert.notStrictEqual(keyOf('My Movie (1).mp4'), keyOf('My Movie.mp4'));
  // 소문자 말은 번호로 보지 않는다.
  assert.deepStrictEqual(duplicateKey('abc-123.mp4'), { kind: 'name', key: 'abc 123' });
  assert.strictEqual(duplicateKey('___.mp4'), null);
});

test('findDuplicateNames: 영상 파일을 번호와 이름으로 묶고 하나뿐인 것은 내놓지 않는다', () => {
  const dir = tempDir();
  const a = put(dir, 'ABC-123.mp4', 'aaaa');
  const b = put(dir, path.join('sub', 'ABC-123 1080p.mkv'), 'bb');
  put(dir, 'ABC-123 CD2.mp4');
  const c = put(dir, 'Trip.mp4');
  const d = put(dir, path.join('old', 'trip - 복사본.avi'));
  put(dir, 'Only.mp4');
  // 영상이 아닌 파일과 제거 기록은 보지 않는다.
  put(dir, 'ABC-123.srt');
  put(dir, 'fctl-removed-20261101-120000.json', '{}');
  const conflict = put(dir, 'ABC-123 XYZ-456.mp4');

  const result = findDuplicateNames(dir);
  assert.strictEqual(result.checked, 7);
  assert.deepStrictEqual(result.groups, [
    { kind: 'number', key: 'ABC-123', number: 'ABC-123', part: null, files: [{ path: a, size: 4 }, { path: b, size: 2 }] },
    { kind: 'name', key: 'trip', number: null, part: null, files: [{ path: d, size: 1 }, { path: c, size: 1 }] },
  ]);
  assert.deepStrictEqual(result.conflicts, [{ path: conflict, numbers: ['ABC-123', 'XYZ-456'] }]);
  assert.deepStrictEqual(result.skipped, []);
  assert.deepStrictEqual(result.unreadable, []);
});

test('findDuplicateNames: 파일을 건드리지 않는다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4');
  put(dir, 'abc-123 copy.mp4');
  const before = fs.readdirSync(dir).sort();
  findDuplicateNames(dir);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before);
});

test('findDuplicateNames: 잔여물, 시스템 폴더는 건너뛰고 저장소 안과 영상이 아닌 .ts는 조용히 뺀다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4');
  put(dir, path.join('.fctl-old-1-2-3', 'ABC-123.mp4'));
  put(dir, path.join('$RECYCLE.BIN', 'ABC-123.mp4'));
  put(dir, path.join('.git', 'ABC-123.mp4'));
  put(dir, 'ABC-123.ts', 'export const x = 1;\n');
  // 잔여물 폴더 안이라도 영상이 아닌 .ts는 보고하지 않는다.
  put(dir, path.join('.fctl-old-1-2-3', 'index.ts'), 'export const x = 1;\n');
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups, []);
  assert.deepStrictEqual(
    result.skipped.map((item) => path.relative(dir, item.path)),
    [path.join('$RECYCLE.BIN', 'ABC-123.mp4'), path.join('.fctl-old-1-2-3', 'ABC-123.mp4')].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1)),
  );
  assert.strictEqual(result.checked, 1);
});

test('findDuplicateNames: MPEG-TS인 .ts는 영상으로 묶는다', () => {
  const dir = tempDir();
  const packet = Buffer.alloc(188 * 3);
  for (let i = 0; i < 3; i++) packet[i * 188] = 0x47;
  const ts = put(dir, 'ABC-123.ts', packet);
  const mp4 = put(dir, 'ABC-123.mp4');
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups[0].files.map((file) => file.path), [mp4, ts]);
});

test('findDuplicateNames: 링크는 건너뛴다', (t) => {
  const dir = tempDir();
  const real = put(dir, 'ABC-123.mp4');
  try {
    fs.symlinkSync(real, path.join(dir, 'ABC-123 link.mp4'), 'file');
  } catch (err) {
    t.skip(`링크를 만들 수 없습니다. (${err.code})`);
    return;
  }
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups, []);
  assert.deepStrictEqual(result.skipped.map((item) => item.reason), ['링크는 보지 않습니다.']);
});

test('findDuplicateNames: 영상 확장자가 아닌 폴더 링크도 건너뛰었다고 보고한다', (t) => {
  const dir = tempDir();
  const outside = tempDir();
  put(outside, 'ABC-123.mp4');
  put(dir, 'ABC-123.mp4');
  try {
    fs.symlinkSync(outside, path.join(dir, 'movies'), 'junction');
  } catch (err) {
    t.skip(`정션을 만들 수 없습니다. (${err.code})`);
    return;
  }
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups, []);
  assert.deepStrictEqual(result.skipped, [{ path: path.join(dir, 'movies'), reason: '링크는 보지 않습니다.' }]);
});

test('formatDuplicateNames: 묶음과 크기, 요약을 보여 준다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4', 'aaaa');
  put(dir, 'ABC-123 1080p.mkv', 'bb');
  put(dir, 'ABC-123 CD2.mp4');
  put(dir, 'ABC-123 CD2 copy.mp4');
  put(dir, 'Trip.mp4');
  put(dir, 'trip.avi');
  put(dir, 'ABC-123 XYZ-456.mp4');
  const report = formatDuplicateNames(findDuplicateNames(dir));
  assert.strictEqual(
    report,
    [
      '중복 후보 (번호 ABC-123, 2개):',
      '  ABC-123 1080p.mkv (2B)',
      '  ABC-123.mp4 (4B)',
      '중복 후보 (번호 ABC-123 조각 2, 2개):',
      '  ABC-123 CD2 copy.mp4 (1B)',
      '  ABC-123 CD2.mp4 (1B)',
      '중복 후보 (이름 "trip", 2개):',
      '  trip.avi (1B)',
      '  Trip.mp4 (1B)',
      '번호가 여럿: ABC-123 XYZ-456.mp4 (ABC-123, XYZ-456)',
      '살펴본 영상 7개, 중복 후보 묶음 3개(파일 6개), 번호가 여럿 1개, 판단 못함 0개, 건너뜀 0개',
    ].join('\n'),
  );
});

test('fctl find-duplicates: 목록을 내고, 타겟 검사와 옵션 검사를 다른 전체 명령과 같이 한다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4');
  put(dir, 'ABC-123 HD.mkv');
  assert.match(run(['find-duplicates', dir]), /중복 후보 \(번호 ABC-123, 2개\)/);
  assert.throws(() => run(['find-duplicates']), /사용법: fctl find-duplicates <타겟>/);
  assert.throws(() => run(['find-duplicates', dir, 'extra']), /타겟은 하나만/);
  assert.throws(() => run(['find-duplicates', dir, '--force']), /--force, --permanent를 쓸 수 없습니다/);
  assert.throws(() => run(['find-duplicates', dir, '--yes=abc']), /--yes는 remove-broken에서만/);
  assert.match(run(['--help']), /find-duplicates <타겟>/);
});
