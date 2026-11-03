'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { duplicateKey, groupByMetadata, findDuplicateNames, formatDuplicateNames } = require('../src/duplicates');
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

test('duplicateKey: 괄호·대시 뒤의 글자, 여러 로마 숫자, 원문자, 한국어·한자 조각도 가른다', () => {
  const pairs = [
    ['[ABC-123] B.mp4', '[ABC-123] C.mp4'],
    ['ABC-123(A).mp4', 'ABC-123(B).mp4'],
    ['ABC-123 [A].mp4', 'ABC-123 [B].mp4'],
    ['ABC-123 – A.mp4', 'ABC-123 – B.mp4'],
    ['ABC-123 Title A.mp4', 'ABC-123 Title B.mp4'],
    ['ABC-123 XIII.mp4', 'ABC-123 XIV.mp4'],
    ['ABC-123 ii.mp4', 'ABC-123 iii.mp4'],
    ['ABC-123 Ⅱ.mp4', 'ABC-123 Ⅲ.mp4'],
    ['ABC-123 Part V.mp4', 'ABC-123 Part X.mp4'],
    ['ABC-123 Part I.mp4', 'ABC-123.mp4'],
    ['ABC-123 ①.mp4', 'ABC-123 ②.mp4'],
    ['ABC-123 第一話.mp4', 'ABC-123 第二話.mp4'],
    ['ABC-123 상.mp4', 'ABC-123 하.mp4'],
    ['ABC-123 전편.mp4', 'ABC-123 후편.mp4'],
  ];
  for (const [one, other] of pairs) assert.notStrictEqual(keyOf(one), keyOf(other), `${one} / ${other}`);
  // 로마 숫자, 로마 숫자 글자, 원문자는 같은 숫자로 맞춘다.
  assert.strictEqual(keyOf('ABC-123 III.mp4'), 'ABC-123 #3');
  assert.strictEqual(keyOf('ABC-123 Ⅲ.mp4'), 'ABC-123 #3');
  assert.strictEqual(keyOf('ABC-123 ③.mp4'), 'ABC-123 #3');
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
  const brief = (groups) => groups.map(({ files, ...group }) => ({ ...group, files: files.map(({ path: p, size }) => ({ path: p, size })) }));
  assert.deepStrictEqual(brief(result.groups), [
    { kind: 'number', key: 'ABC-123', number: 'ABC-123', part: null, files: [{ path: a, size: 4 }, { path: b, size: 2 }] },
    { kind: 'name', key: 'trip', number: null, part: null, files: [{ path: d, size: 1 }, { path: c, size: 1 }] },
  ]);
  // 영상 구조가 아닌 시험 파일이라 길이를 모른다. 읽지 못한 사유는 note에 남지만 묶음에서 빠지지는 않는다.
  assert.strictEqual(result.groups[0].files[0].duration, null);
  assert.match(result.groups[0].files[0].note, /.+/);
  assert.strictEqual(result.unknownMetadata, 7);
  assert.deepStrictEqual(result.metadataGroups, []);
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
  // 잔여물 폴더 안이라도 영상이 아닌 .ts는 보고하지 않는다. 건너뛸 파일은 경로를 풀지 않고 건너뜀으로 보고한다.
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
      '살펴본 영상 7개, 중복 후보 묶음 3개(파일 6개), 길이가 같은 묶음 0개(파일 0개), 길이 모름 7개, 번호가 여럿 1개, 판단 못함 0개, 건너뜀 0개',
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

// 길이 기준 묶기 시험용 MP4·MKV. 머리 구조만 있으면 길이와 해상도를 읽는다.
const latin = (text) => Buffer.from(text, 'latin1');
const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), latin(type), body]);
}

function mp4({ seconds, width = 1920, height = 1080, padding = 0 }) {
  const duration = Math.round(seconds * 1000);
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(duration), Buffer.alloc(80));
  const tkhd = box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(52), u32(width * 65536), u32(height * 65536));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const stsd = box('stsd', u32(0), u32(1), box('avc1', entry));
  const hdlr = box('hdlr', u32(0), u32(0), latin('vide'), Buffer.alloc(13));
  const trak = box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd))));
  return Buffer.concat([box('ftyp', latin('isom'), u32(512), latin('isommp42')), box('moov', mvhd, trak), box('mdat', Buffer.alloc(64 + padding))]);
}

function mkv({ seconds, width = 1920, height = 1080 }) {
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
  const ticks = Buffer.alloc(8);
  ticks.writeDoubleBE(seconds * 1000);
  const info = el(0x1549a966, el(0x2ad7b1, u32(1000000)), el(0x4489, ticks));
  const video = el(0xae, el(0x83, Buffer.from([1])), el(0xe0, el(0xb0, u32(width)), el(0xba, u32(height))));
  return Buffer.concat([el(0x1a45dfa3, el(0x4282, 'matroska')), el(0x18538067, info, el(0x1654ae6b, video), el(0x1f43b675, Buffer.alloc(100)))]);
}

const video = (seconds, width = 1920, height = 1080, size = 100) => ({ path: `${seconds}-${width}x${height}-${size}`, size, duration: seconds, width, height, note: null });
const paths = (groups) => groups.map((group) => group.files.map((file) => file.path));

test('groupByMetadata: 길이가 1초 이내이고 화면 비율이 같으면 해상도와 크기가 달라도 묶는다', () => {
  const groups = groupByMetadata([video(600, 1920, 1080, 900), video(600.8, 1280, 720, 300), video(900)]);
  assert.deepStrictEqual(paths(groups), [['600-1920x1080-900', '600.8-1280x720-300']]);
  assert.strictEqual(groups[0].aspect, '1.8');
  assert.strictEqual(groups[0].duration, 600);
  assert.strictEqual(groups[0].sameSize, false);
  assert.strictEqual(groupByMetadata([video(600), video(600)])[0].sameSize, true);
});

test('groupByMetadata: 길이 차이가 1초를 넘거나 화면 비율이 다르면 묶지 않는다', () => {
  assert.deepStrictEqual(groupByMetadata([video(600), video(601.5)]), []);
  // 가로 영상과 세로 영상, 16:9와 4:3
  assert.deepStrictEqual(groupByMetadata([video(600, 1920, 1080), video(600, 1080, 1920)]), []);
  assert.deepStrictEqual(groupByMetadata([video(600, 1920, 1080), video(600, 640, 480)]), []);
});

test('groupByMetadata: 묶음 안의 어느 두 파일도 1초 넘게 차이 나지 않는다', () => {
  // 600 ~ 600.9 ~ 601.8처럼 이어져도 600과 601.8을 한 묶음에 넣지 않는다.
  const groups = groupByMetadata([video(600), video(600.9), video(601.8), video(602.5)]);
  assert.deepStrictEqual(paths(groups), [['600-1920x1080-100', '600.9-1920x1080-100'], ['601.8-1920x1080-100', '602.5-1920x1080-100']]);
});

test('groupByMetadata: 60초 미만이거나 길이·해상도를 모르는 영상은 묶지 않는다', () => {
  assert.deepStrictEqual(groupByMetadata([video(59), video(59)]), []);
  const unknown = { ...video(600), duration: null };
  const noSize = { ...video(600), width: null, height: null };
  assert.deepStrictEqual(groupByMetadata([unknown, { ...unknown }, noSize, { ...noSize }]), []);
  assert.strictEqual(groupByMetadata([video(60), video(60)]).length, 1);
});

test('findDuplicateNames: 이름이 달라도 길이와 화면 비율이 같은 MP4·MKV를 묶는다', () => {
  const dir = tempDir();
  const a = put(dir, '여행 영상.mp4', mp4({ seconds: 754.2 }));
  const b = put(dir, path.join('백업', 'trip final.mkv'), mkv({ seconds: 754.6, width: 1280, height: 720 }));
  put(dir, 'other.mp4', mp4({ seconds: 300 }));
  put(dir, 'clip1.mp4', mp4({ seconds: 20 }));
  put(dir, 'clip2.mp4', mp4({ seconds: 20 }));
  // 읽지 못하는 형식은 길이를 모르는 영상으로 센다.
  put(dir, 'old.avi', 'RIFF');
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups, []);
  assert.deepStrictEqual(paths(result.metadataGroups), [[a, b]]);
  assert.deepStrictEqual(
    result.metadataGroups[0].files.map(({ duration, width, height }) => ({ duration, width, height })),
    [
      { duration: 754.2, width: 1920, height: 1080 },
      { duration: 754.6, width: 1280, height: 720 },
    ],
  );
  assert.strictEqual(result.unknownMetadata, 1);
  assert.strictEqual(result.checked, 6);
});

test('findDuplicateNames: 이름 묶음으로 이미 보인 파일만 든 길이 묶음은 되풀이하지 않는다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4', mp4({ seconds: 3600 }));
  put(dir, 'ABC-123 720p.mkv', mkv({ seconds: 3600.4, width: 1280, height: 720 }));
  // 이름 묶음과 다른 파일이 섞이면 길이 묶음으로도 보여 준다.
  put(dir, 'XYZ-999.mp4', mp4({ seconds: 1800 }));
  put(dir, 'XYZ-999 copy.mp4', mp4({ seconds: 1800 }));
  const other = put(dir, 'renamed.mp4', mp4({ seconds: 1800.5 }));
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups.map((group) => group.key), ['ABC-123', 'XYZ-999']);
  assert.strictEqual(result.metadataGroups.length, 1);
  assert.strictEqual(result.metadataGroups[0].files.length, 3);
  assert.ok(result.metadataGroups[0].files.some((file) => file.path === other));
});

test('formatDuplicateNames: 해상도와 길이, 길이가 같은 묶음을 보여 준다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4', mp4({ seconds: 3725 }));
  put(dir, 'ABC-123 720p.mkv', mkv({ seconds: 3725.4, width: 1280, height: 720 }));
  put(dir, 'a.mp4', mp4({ seconds: 95 }));
  put(dir, 'b.mp4', mp4({ seconds: 95 }));
  const report = formatDuplicateNames(findDuplicateNames(dir));
  const lines = report.split('\n');
  assert.strictEqual(lines[0], '중복 후보 (번호 ABC-123, 2개):');
  assert.match(lines[1], /^ {2}ABC-123 720p\.mkv \(\d+B, 1280x720, 1:02:05\)$/);
  assert.match(lines[2], /^ {2}ABC-123\.mp4 \(\d+B, 1920x1080, 1:02:05\)$/);
  assert.strictEqual(lines[3], '길이가 같은 영상 (1:35, 화면 비율 1.8, 크기도 같음, 2개):');
  assert.match(lines[4], /^ {2}a\.mp4 \(\d+B, 1920x1080, 1:35\)$/);
  assert.strictEqual(lines.at(-1), '살펴본 영상 4개, 중복 후보 묶음 1개(파일 2개), 길이가 같은 묶음 1개(파일 2개), 길이 모름 0개, 번호가 여럿 0개, 판단 못함 0개, 건너뜀 0개');
});
