'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { duplicateKey, titleWords, titlesDiffer, aspectsMatch, groupByMetadata, chooseKeeper, findDuplicateNames, formatDuplicateNames } = require('../src/duplicates');
const { run } = require('../bin/fctl');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
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
  // Quality and codec marks, the first letter of a word, and the trailing (1) and copy tails are not pieces.
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
  // Roman numerals, Roman numeral characters, and circled digits are matched to the same number.
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
  // The same number appearing twice is not a conflict.
  assert.strictEqual(keyOf('ABC-123 [ABC-123].mp4'), 'ABC-123');
});

test('duplicateKey: 번호가 없으면 대소문자, 전각, 구분 문자, 복사본 꼬리를 무시한 이름이 기준이다', () => {
  const names = ['My Movie.mp4', 'my_movie.MKV', 'my.movie.avi', 'My Movie - 복사본.mp4', 'My Movie - Copy (2).mp4', 'My Movie - 복사본 - 복사본.mp4', 'ＭＹ　ＭＯＶＩＥ.mp4'];
  for (const name of names) assert.deepStrictEqual(duplicateKey(name), { kind: 'name', key: 'my movie' }, name);
  // Composed Hangul (names from macOS) is also the same as precomposed.
  assert.strictEqual(keyOf('여행 영상.mp4'.normalize('NFD')), keyOf('여행 영상.mp4'));
  // A tail that looks like a number, (1), may be a different video, so it is left as it is.
  assert.notStrictEqual(keyOf('My Movie (1).mp4'), keyOf('My Movie.mp4'));
  // A lowercase word is not seen as a number.
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
  // Files that are not video and removal records are not looked at.
  put(dir, 'ABC-123.srt');
  put(dir, 'fctl-removed-20261101-120000.json', '{}');
  const conflict = put(dir, 'ABC-123 XYZ-456.mp4');

  const result = findDuplicateNames(dir);
  assert.strictEqual(result.checked, 7);
  const brief = (groups) => groups.map(({ files, keep, ...group }) => ({ ...group, files: files.map(({ path: p, size }) => ({ path: p, size })) }));
  assert.deepStrictEqual(brief(result.groups), [
    { kind: 'number', key: 'ABC-123', number: 'ABC-123', part: null, generic: false, differentTitles: false, files: [{ path: a, size: 4 }, { path: b, size: 2 }] },
    { kind: 'name', key: 'trip', number: null, part: null, generic: false, differentTitles: false, files: [{ path: d, size: 1 }, { path: c, size: 1 }] },
  ]);
  // The test files are not video structures but files that could not be read at all. So it chooses by size, and a format that is not read (.avi) comes before an unreadable .mp4.
  assert.deepStrictEqual(result.groups.map((group) => group.keep), [
    { path: a, reason: 'largest size', doubt: null },
    { path: d, reason: 'excludes files whose duration or resolution could not be read', doubt: null },
  ]);
  // Test files that are not video structure, so the length is unknown. The reason it could not be read stays in note, but the file does not drop out of the group.
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
  // Even inside a leftover folder, a .ts that is not video is not reported. A file to skip is reported as skipped without resolving the path.
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
  assert.deepStrictEqual(result.skipped.map((item) => item.reason), ['Links are not checked.']);
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
  assert.deepStrictEqual(result.skipped, [{ path: path.join(dir, 'movies'), reason: 'Links are not checked.' }]);
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
  // The test files are not video structure, so the length cannot be read. That report is checked in another test.
  const report = formatDuplicateNames(findDuplicateNames(dir))
    .split('\n')
    .filter((line) => !line.startsWith('Could not read duration/resolution: '))
    .join('\n');
  assert.strictEqual(
    report,
    [
      'Duplicate candidates (number ABC-123, 2 files):',
      '  ABC-123 1080p.mkv (2B)',
      '  ABC-123.mp4 (4B) [kept: largest size]',
      'Duplicate candidates (number ABC-123 part 2, 2 files):',
      '  ABC-123 CD2 copy.mp4 (1B)',
      '  ABC-123 CD2.mp4 (1B) [kept: shortest name]',
      'Duplicate candidates (name "trip", 2 files):',
      '  trip.avi (1B) [kept: excludes files whose duration or resolution could not be read]',
      '  Trip.mp4 (1B)',
      'Several numbers: ABC-123 XYZ-456.mp4 (ABC-123, XYZ-456)',
      'Checked 7 videos, 3 duplicate candidate groups (6 files, 0 need checking), 0 same-duration groups (0 files), 7 with unknown duration, 1 with several numbers, 0 undetermined, 0 skipped',
    ].join('\n'),
  );
});

test('fctl find-duplicates: 목록을 내고, 타겟 검사와 옵션 검사를 다른 전체 명령과 같이 한다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4');
  put(dir, 'ABC-123 HD.mkv');
  assert.match(run(['find-duplicates', dir]), /Duplicate candidates \(number ABC-123, 2 files\)/);
  assert.throws(() => run(['find-duplicates']), /Usage: fctl find-duplicates <target>/);
  assert.throws(() => run(['find-duplicates', dir, 'extra']), /Only one target/);
  assert.throws(() => run(['find-duplicates', dir, '--force']), /so --force and --permanent cannot be used/);
  assert.throws(() => run(['find-duplicates', dir, '--yes=abc']), /--yes can be used only with remove-broken, remove-duplicates, and remove-low-quality/);
  assert.match(run(['--help']), /find-duplicates <target>/);
});

// MP4 and MKV for the length-criterion grouping test. With only the head structure, the length and resolution are read.
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

// If rotate is 90, it puts a 90 degree rotation in the tkhd transform matrix (a phone portrait video).
function mp4({ seconds, width = 1920, height = 1080, padding = 0, rotate = 0 }) {
  const duration = Math.round(seconds * 1000);
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(duration), Buffer.alloc(80));
  const middle = Buffer.alloc(52);
  if (rotate === 90) {
    middle.writeInt32BE(0x10000, 16 + 4);
    middle.writeInt32BE(-0x10000, 16 + 12);
  }
  const tkhd = box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(duration), middle, u32(width * 65536), u32(height * 65536));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const stsd = box('stsd', u32(0), u32(1), box('avc1', entry));
  const hdlr = box('hdlr', u32(0), u32(0), latin('vide'), Buffer.alloc(13));
  const trak = box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd))));
  return Buffer.concat([box('ftyp', latin('isom'), u32(512), latin('isommp42')), box('moov', mvhd, trak), box('mdat', Buffer.alloc(64 + padding))]);
}

// display is [DisplayWidth, DisplayHeight] (in pixels).
function mkv({ seconds, width = 1920, height = 1080, display }) {
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
  const shown = display ? [el(0x54b0, u32(display[0])), el(0x54ba, u32(display[1]))] : [];
  const video = el(0xae, el(0x83, Buffer.from([1])), el(0xe0, el(0xb0, u32(width)), el(0xba, u32(height)), ...shown));
  return Buffer.concat([el(0x1a45dfa3, el(0x4282, 'matroska')), el(0x18538067, info, el(0x1654ae6b, video), el(0x1f43b675, Buffer.alloc(100)))]);
}

const video = (seconds, width = 1920, height = 1080, size = 100) => ({ path: `${seconds}-${width}x${height}-${size}`, size, duration: seconds, width, height, note: null });
const shownVideo = (seconds, width, height, displayWidth, displayHeight) => ({ ...video(seconds, width, height), path: `${seconds}-${width}x${height}-${displayWidth}x${displayHeight}`, displayWidth, displayHeight });
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
  // A landscape video and a portrait video, 16:9 and 4:3
  assert.deepStrictEqual(groupByMetadata([video(600, 1920, 1080), video(600, 1080, 1920)]), []);
  assert.deepStrictEqual(groupByMetadata([video(600, 1920, 1080), video(600, 640, 480)]), []);
});

test('groupByMetadata: 묶음 안의 어느 두 파일도 1초 넘게 차이 나지 않는다', () => {
  // Even if they continue like 600, 600.9, 601.8, it does not put 600 and 601.8 in one group.
  const groups = groupByMetadata([video(600), video(600.9), video(601.8), video(602.5)]);
  assert.deepStrictEqual(paths(groups), [['600-1920x1080-100', '600.9-1920x1080-100'], ['601.8-1920x1080-100', '602.5-1920x1080-100']]);
});

test('groupByMetadata: 60초 미만이거나 길이·해상도를 모르는 영상은 묶지 않는다', () => {
  assert.deepStrictEqual(groupByMetadata([video(59), video(59)]), []);
  assert.deepStrictEqual(groupByMetadata([video(59.9), video(59.9)]), []);
  const unknown = { ...video(600), duration: null };
  const noSize = { ...video(600), width: null, height: null };
  assert.deepStrictEqual(groupByMetadata([unknown, { ...unknown }, noSize, { ...noSize }]), []);
  assert.strictEqual(groupByMetadata([video(60), video(60)]).length, 1);
});

test('groupByMetadata: 회전과 화소 비율을 반영한 보이는 크기로 화면 비율을 잰다 (#106)', () => {
  // A phone video that shows portrait through rotation information is grouped with a copy saved again as portrait and is not grouped with a landscape video.
  const rotated = shownVideo(600, 1920, 1080, 1080, 1920);
  assert.deepStrictEqual(paths(groupByMetadata([rotated, video(600.4, 1080, 1920), video(600.2, 1920, 1080)])), [[rotated.path, '600.4-1080x1920-100']]);
  // DVD 16:9 (720x480, visible size 853x480) is grouped with 16:9 video and not with 720x480 (3:2), which does not reflect the pixel aspect ratio.
  const dvd = shownVideo(900, 720, 480, 853, 480);
  assert.deepStrictEqual(paths(groupByMetadata([dvd, video(900, 1920, 1080), video(900.5, 720, 480)])), [[dvd.path, '900-1920x1080-100']]);
  assert.strictEqual(groupByMetadata([dvd, video(900, 1920, 1080)])[0].aspect, '1.8');
});

test('groupByMetadata, aspectsMatch: 화면 비율은 3% 이내면 같다고 본다 (#106)', () => {
  // The same video that split into 2.4 and 2.3 when rounded
  assert.deepStrictEqual(paths(groupByMetadata([video(600, 1920, 816), video(600.5, 1920, 818)])), [['600-1920x816-100', '600.5-1920x818-100']]);
  assert.strictEqual(aspectsMatch(video(600, 1920, 800), video(600, 1920, 816)), true);
  // 16:9 (1.78) and 1.85:1 differ by nearly 4%, so they are not the same.
  assert.strictEqual(aspectsMatch(video(600, 1920, 1080), video(600, 1920, 1038)), false);
  assert.deepStrictEqual(groupByMetadata([video(600, 1920, 1080), video(600, 1920, 1038)]), []);
  assert.strictEqual(aspectsMatch(video(600), { ...video(600), width: null }), false);
  // No two files in a group differ by more than 3%. It puts only up to 3% from the narrowest file.
  const groups = groupByMetadata([video(600, 1000, 1000), video(600, 1025, 1000), video(600, 1050, 1000), video(600, 1070, 1000)]);
  assert.deepStrictEqual(paths(groups), [['600-1000x1000-100', '600-1025x1000-100'], ['600-1050x1000-100', '600-1070x1000-100']]);
});

test('groupByMetadata: 길이나 비율이 동떨어진 다른 파일 때문에 같은 영상 쌍이 갈리지 않는다 (#106)', () => {
  const pair = [video(300, 1920, 1080), video(300.5, 1912, 1080)];
  const expected = [['300-1920x1080-100', '300.5-1912x1080-100']];
  assert.deepStrictEqual(paths(groupByMetadata(pair)), expected);
  // A file whose length is entirely different and whose ratio is within 3% of only one side
  assert.deepStrictEqual(paths(groupByMetadata([...pair, video(9000, 1720, 1000)])), expected);
  // A file within the length window but with a different ratio (a portrait video, a video whose ratio is within 3% of only one side)
  assert.deepStrictEqual(paths(groupByMetadata([video(299.4, 1080, 1920), ...pair])), expected);
  assert.deepStrictEqual(paths(groupByMetadata([video(299.4, 1720, 1000), ...pair])), expected);
});

test('groupByMetadata: 파일이 많이 몰려도 묶음의 가장 좁은·넓은 비율로 비교해 빨리 끝나고 3%를 넘지 않는다', () => {
  // Files crowded in the 1 second and 3% range. The ratios are spread evenly between 1.70 and 1.80.
  const files = Array.from({ length: 10000 }, (_, index) => video(600 + (index % 10) * 0.05, 1700 + (index % 101), 1000));
  const started = Date.now();
  const groups = groupByMetadata(files);
  assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  for (const group of groups) {
    const ratios = group.files.map((file) => file.width / file.height);
    assert.ok(Math.max(...ratios) / Math.min(...ratios) - 1 <= 0.03 + 1e-9);
    assert.ok(group.files.at(-1).duration - group.files[0].duration <= 1);
  }
  assert.strictEqual(groups.reduce((sum, group) => sum + group.files.length, 0), 10000);
});

test('findDuplicateNames: 회전한 MP4와 표시 크기가 있는 MKV를 보이는 크기로 묶고 보고에 보이는 크기를 쓴다 (#106)', () => {
  const dir = tempDir();
  const phone = put(dir, 'phone.mp4', mp4({ seconds: 600, rotate: 90 }));
  const edited = put(dir, 'edited.mp4', mp4({ seconds: 600.4, width: 1080, height: 1920 }));
  put(dir, 'landscape.mp4', mp4({ seconds: 600.2 }));
  const dvd = put(dir, 'dvd.mkv', mkv({ seconds: 900, width: 720, height: 480, display: [853, 480] }));
  const hd = put(dir, 'hd.mp4', mp4({ seconds: 900 }));
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(paths(result.metadataGroups), [[phone, edited], [dvd, hd]]);
  const phoneInfo = result.metadataGroups[0].files[0];
  assert.deepStrictEqual([phoneInfo.width, phoneInfo.height, phoneInfo.displayWidth, phoneInfo.displayHeight], [1920, 1080, 1080, 1920]);
  const report = formatDuplicateNames(result);
  assert.match(report, /^ {2}phone\.mp4 \(\d+B, 1920x1080 \(displayed size 1080x1920\), 10:00\)/m);
  assert.match(report, /^ {2}dvd\.mkv \(\d+B, 720x480 \(displayed size 853x480\), 15:00\)/m);
  assert.match(report, /^ {2}hd\.mp4 \(\d+B, 1920x1080, 15:00\)/m);
  assert.match(report, /^Videos with the same duration \(10:00, aspect ratio 0\.6, same size too, 2 files\):$/m);
});

test('findDuplicateNames: 이름이 달라도 길이와 화면 비율이 같은 MP4·MKV를 묶는다', () => {
  const dir = tempDir();
  const a = put(dir, '여행 영상.mp4', mp4({ seconds: 754.2 }));
  const b = put(dir, path.join('백업', 'trip final.mkv'), mkv({ seconds: 754.6, width: 1280, height: 720 }));
  put(dir, 'other.mp4', mp4({ seconds: 300 }));
  put(dir, 'clip1.mp4', mp4({ seconds: 20 }));
  put(dir, 'clip2.mp4', mp4({ seconds: 20 }));
  // A format that cannot be read counts as a video whose length is unknown.
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

test('findDuplicateNames: 이름 묶음에 이미 든 파일만 있는 길이 묶음은 표시만 하고 보고에서 되풀이하지 않는다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4', mp4({ seconds: 3600 }));
  put(dir, 'ABC-123 720p.mkv', mkv({ seconds: 3600.4, width: 1280, height: 720 }));
  // If a file that is in a name group is mixed with others, it is also shown as a length group.
  put(dir, 'XYZ-999.mp4', mp4({ seconds: 1800 }));
  put(dir, 'XYZ-999 copy.mp4', mp4({ seconds: 1800 }));
  const other = put(dir, 'renamed.mp4', mp4({ seconds: 1800.5 }));
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups.map((group) => group.key), ['ABC-123', 'XYZ-999']);
  // The information that the name and the length both match stays in the result.
  assert.deepStrictEqual(
    result.metadataGroups.map((group) => [group.duration, group.alsoNamed, group.files.length]),
    [
      [1800, false, 3],
      [3600, true, 2],
    ],
  );
  assert.ok(result.metadataGroups[0].files.some((file) => file.path === other));
  const report = formatDuplicateNames(result);
  assert.strictEqual(report.match(/^Videos with the same duration/gm).length, 1);
  assert.match(report, /1 same-duration groups \(3 files\)/);
});

test('findDuplicateNames: 하나뿐인 이름이나 번호가 여럿인 이름의 파일도 길이로 묶는다', () => {
  const dir = tempDir();
  const conflict = put(dir, 'ABC-123 XYZ-456.mp4', mp4({ seconds: 900 }));
  const single = put(dir, 'ABC-123.mp4', mp4({ seconds: 900.3 }));
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups, []);
  assert.deepStrictEqual(paths(result.metadataGroups), [[conflict, single]]);
  assert.strictEqual(result.metadataGroups[0].alsoNamed, false);
});

test('findDuplicateNames: 길이를 읽지 못한 MP4는 예외 없이 사유와 함께 보고한다', () => {
  const dir = tempDir();
  const broken = put(dir, 'broken.mp4', Buffer.concat([u32(16), latin('ftyp'), latin('isomisom'), u32(100), latin('moov')]));
  put(dir, 'old.avi', 'RIFF');
  const result = findDuplicateNames(dir);
  assert.strictEqual(result.unknownMetadata, 2);
  // A format that cannot be read (avi) has no reason, and only a file in a readable format that could not be read leaves a reason.
  assert.deepStrictEqual(result.metadataErrors.map((item) => item.path), [broken]);
  assert.match(formatDuplicateNames(result), /^Could not read duration\/resolution: broken\.mp4 \(.+\)$/m);
});

test('findDuplicateNames: 예외 없이 길이나 해상도가 빠진 MP4도 사유와 함께 보고한다', () => {
  const dir = tempDir();
  // An MP4 that does not write the length (a fragmented MP4 and so on) and an MP4 without a resolution
  const noLength = put(dir, 'no-length.mp4', mp4({ seconds: 0 }));
  const noSize = put(dir, 'no-size.mp4', mp4({ seconds: 600, width: 0, height: 0 }));
  put(dir, 'no-size copy.mp4', mp4({ seconds: 600, width: 0, height: 0 }));
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.metadataGroups, []);
  assert.strictEqual(result.unknownMetadata, 1);
  const reasons = new Map(result.metadataErrors.map((item) => [item.path, item.reason]));
  assert.match(reasons.get(noLength), /^The duration information is missing\.$|^The duration and resolution information is missing\.$/);
  assert.strictEqual(reasons.get(noSize), 'The resolution information is missing.');
});

test('formatDuplicateNames: 길이를 반올림해 시·분·초로 쓴다', () => {
  const dir = tempDir();
  put(dir, 'a.mp4', mp4({ seconds: 3599.6 }));
  put(dir, 'b.mp4', mp4({ seconds: 3599.6 }));
  assert.match(formatDuplicateNames(findDuplicateNames(dir)), /^Videos with the same duration \(1:00:00, /m);
});

test('formatDuplicateNames: 해상도와 길이, 길이가 같은 묶음을 보여 준다', () => {
  const dir = tempDir();
  put(dir, 'ABC-123.mp4', mp4({ seconds: 3725 }));
  put(dir, 'ABC-123 720p.mkv', mkv({ seconds: 3725.4, width: 1280, height: 720 }));
  put(dir, 'a.mp4', mp4({ seconds: 95 }));
  put(dir, 'b.mp4', mp4({ seconds: 95 }));
  const report = formatDuplicateNames(findDuplicateNames(dir));
  const lines = report.split('\n');
  assert.strictEqual(lines[0], 'Duplicate candidates (number ABC-123, 2 files):');
  assert.match(lines[1], /^ {2}ABC-123 720p\.mkv \(\d+B, 1280x720, 1:02:05\)$/);
  assert.match(lines[2], /^ {2}ABC-123\.mp4 \(\d+B, 1920x1080, 1:02:05\) \[kept: highest resolution\]$/);
  assert.strictEqual(lines[3], 'Videos with the same duration (1:35, aspect ratio 1.8, same size too, 2 files):');
  assert.match(lines[4], /^ {2}a\.mp4 \(\d+B, 1920x1080, 1:35\) \[kept: all equal, first by path\]$/);
  assert.match(lines[5], /^ {2}b\.mp4 \(\d+B, 1920x1080, 1:35\)$/);
  assert.strictEqual(lines.at(-1), 'Checked 4 videos, 1 duplicate candidate groups (2 files, 0 need checking), 1 same-duration groups (2 files), 0 with unknown duration, 0 with several numbers, 0 undetermined, 0 skipped');
});

// Choosing the file to keep (#34). The path uses only the file name.
const clip = (name, { size = 100, duration = 600, width = 1920, height = 1080, note = null } = {}) => ({ path: name, size, duration, width, height, note });

test('chooseKeeper: 해상도가 가장 높은 파일을 고르고, 해상도가 같으면 크기가 큰 파일을 고른다', () => {
  assert.deepStrictEqual(chooseKeeper([clip('a.mp4', { size: 900, width: 1280, height: 720 }), clip('b.mkv', { size: 500 })]), {
    path: 'b.mkv',
    reason: 'highest resolution',
    doubt: null,
  });
  assert.deepStrictEqual(chooseKeeper([clip('a.mp4', { size: 300 }), clip('b.mp4', { size: 700 }), clip('c.mp4', { size: 900, width: 640, height: 360 })]), {
    path: 'b.mp4',
    reason: 'highest resolution, largest size',
    doubt: null,
  });
  // A file whose resolution is unknown comes after one whose resolution is known.
  assert.strictEqual(chooseKeeper([clip('a.avi', { size: 5000, duration: null, width: null, height: null }), clip('b.mp4', { width: 640, height: 360 })]).path, 'b.mp4');
});

test('chooseKeeper: 길이·해상도를 읽지 못한 파일은 해상도가 높아도 뒤로 뺀다', () => {
  const broken = clip('big.mp4', { size: 9000, duration: null, width: null, height: null, note: '구조가 깨졌습니다.' });
  assert.deepStrictEqual(chooseKeeper([broken, clip('small.mp4', { width: 640, height: 360 })]), {
    path: 'small.mp4',
    reason: 'excludes files whose duration or resolution could not be read',
    doubt: null,
  });
  // A format that is not read (no note) is not moved back.
  const avi = clip('a.avi', { size: 50, duration: null, width: null, height: null });
  assert.strictEqual(chooseKeeper([avi, { ...broken, path: 'b.mp4' }]).path, 'a.avi');
});

test('chooseKeeper: 가장 긴 파일보다 1초 넘게 짧은 파일은 해상도가 높아도 뒤로 빼고 같은 영상이 아닐 수 있다고 알린다', () => {
  const keep = chooseKeeper([clip('ABC-123 4K.mp4', { duration: 300, width: 3840, height: 2160 }), clip('ABC-123.mp4', { duration: 7200 })]);
  assert.deepStrictEqual(keep, { path: 'ABC-123.mp4', reason: 'longest duration', doubt: 'The durations differ, so they may not be the same video.' });
  // A difference within 1 second is seen as the same length and not reported. A file whose length is unknown is not moved back.
  assert.deepStrictEqual(chooseKeeper([clip('a.mp4', { duration: 600, width: 3840, height: 2160 }), clip('b.mp4', { duration: 600.9 })]), {
    path: 'a.mp4',
    reason: 'highest resolution',
    doubt: null,
  });
  assert.deepStrictEqual(chooseKeeper([clip('a.avi', { size: 900, duration: null }), clip('b.mp4', { duration: 600 })]), {
    path: 'a.avi',
    reason: 'largest size',
    doubt: null,
  });
});

test('chooseKeeper: 나머지가 같으면 이름이 짧은 파일, 그것도 같으면 경로 순으로 첫 파일을 고른다', () => {
  assert.deepStrictEqual(chooseKeeper([clip('movie - 복사본.mp4'), clip('movie (1).mp4'), clip('movie.mp4')]), {
    path: 'movie.mp4',
    reason: 'shortest name',
    doubt: null,
  });
  assert.deepStrictEqual(chooseKeeper([clip(path.join('b', 'x.mp4')), clip(path.join('a', 'x.mp4'))]), {
    path: path.join('a', 'x.mp4'),
    reason: 'all equal, first by path',
    doubt: null,
  });
  assert.strictEqual(chooseKeeper([clip('b.mp4', { size: 50 }), clip('c.mp4'), clip('a.mp4')]).reason, 'largest size, the rest equal, first by path');
  // Path order ignores case first, as in the report. So a comes before B.
  assert.strictEqual(chooseKeeper([clip(path.join('B', 'x.mp4')), clip(path.join('a', 'x.mp4'))]).path, path.join('a', 'x.mp4'));
});

test('chooseKeeper: 길이를 읽지 못한 것으로 빠진 파일의 길이로는 남은 파일을 짧다고 보지 않는다', () => {
  // Even if the file dropped for having a length but no resolution is the longest, the remaining files are compared by length with each other.
  const noSize = clip('x.mp4', { duration: 7200, width: null, height: null, note: 'The resolution information is missing.' });
  assert.deepStrictEqual(chooseKeeper([noSize, clip('long.mp4', { duration: 7000, width: 1280, height: 720 }), clip('short.mp4', { duration: 300 })]), {
    path: 'long.mp4',
    reason: 'excludes files whose duration or resolution could not be read, longest duration',
    doubt: 'The durations differ, so they may not be the same video.',
  });
  const avi = clip('a.avi', { duration: null, width: null, height: null });
  assert.strictEqual(chooseKeeper([noSize, clip('b.mp4'), avi]).path, 'b.mp4');
});

test('chooseKeeper: 파일이 없으면 null, 하나뿐이면 그 파일을 고른다', () => {
  assert.strictEqual(chooseKeeper([]), null);
  assert.deepStrictEqual(chooseKeeper([clip('a.mp4')]), { path: 'a.mp4', reason: 'only one file', doubt: null });
});

test('findDuplicateNames: 이름 묶음과 길이 묶음에 남길 파일을 붙이고, 길이가 다른 이름 묶음은 주의를 보여 준다', () => {
  const dir = tempDir();
  const full = put(dir, 'ABC-123.mp4', mp4({ seconds: 7200, width: 1280, height: 720 }));
  put(dir, path.join('new', 'ABC-123 4K.mp4'), mp4({ seconds: 300, width: 3840, height: 2160 }));
  put(dir, 'x.mp4', mp4({ seconds: 900 }));
  const bigger = put(dir, 'y.mkv', mkv({ seconds: 900.5, width: 3840, height: 2160 }));
  const result = findDuplicateNames(dir);
  assert.deepStrictEqual(result.groups[0].keep, { path: full, reason: 'longest duration', doubt: 'The durations differ, so they may not be the same video.' });
  assert.deepStrictEqual(result.metadataGroups[0].keep, { path: bigger, reason: 'highest resolution', doubt: null });
  const lines = formatDuplicateNames(result).split('\n');
  assert.strictEqual(lines[0], 'Duplicate candidates (number ABC-123, 2 files):');
  assert.match(lines[1], /^ {2}ABC-123\.mp4 \(\d+B, 1280x720, 2:00:00\) \[kept: longest duration\]$/);
  assert.match(lines[2], /^ {2}new[\\/]ABC-123 4K\.mp4 \(\d+B, 3840x2160, 5:00\)$/);
  assert.strictEqual(lines[3], '  Caution: The durations differ, so they may not be the same video.');
  assert.strictEqual(lines[4], 'Videos with the same duration (15:00, aspect ratio 1.8, 2 files):');
  assert.match(lines[6], /^ {2}y\.mkv \(\d+B, 3840x2160, 15:01\) \[kept: highest resolution\]$/);
});

test('titleWords: 번호 묶음의 제목 낱말에서 번호, 조각, 화질·배포 표시, 복사본 꼬리를 뺀다 (#103)', () => {
  assert.deepStrictEqual(titleWords('WWE-2023 Raw.mp4'), ['raw']);
  assert.deepStrictEqual(titleWords('IPHONE-15 review.mp4'), ['review']);
  assert.deepStrictEqual(titleWords('[FHD] ABC-123 제목 1080p.mkv'), ['제목']);
  assert.deepStrictEqual(titleWords('ABC-123 Title - 복사본.mp4'), ['title']);
  assert.deepStrictEqual(titleWords('ABC-123 제목3 (1).mp4'), ['제목']);
  for (const name of ['ABC-123.mp4', 'ABC-123 CD2.mp4', 'ABC-123 part 2 HD 자막.mp4', 'ABC-123 前編 Ⅱ 第一話.mp4', 'ABC-123 B x264.mp4', 'ABC-123 HEVC leak.mp4']) assert.deepStrictEqual(titleWords(name), [], name);
  // If there is no number or several numbers, it does not decide title words.
  assert.strictEqual(titleWords('Trip.mp4'), null);
  assert.strictEqual(titleWords('ABC-123 XYZ-456.mp4'), null);
});

test('titlesDiffer: 둘 다 제목이 있는데 어느 쪽 낱말도 다른 쪽에 모두 들어 있지 않으면 다르다고 본다', () => {
  assert.strictEqual(titlesDiffer(['raw'], ['smackdown']), true);
  // A repeated name or overlapping in only one article makes a different title.
  assert.strictEqual(titlesDiffer(['wwe', 'raw'], ['wwe', 'smackdown']), true);
  assert.strictEqual(titlesDiffer(['the', 'review'], ['the', 'unboxing']), true);
  assert.strictEqual(titlesDiffer(['좋은', '영화'], ['좋은', '영화', '감독판']), false);
  assert.strictEqual(titlesDiffer(['좋은', '영화', '감독판'], ['영화']), false);
  assert.strictEqual(titlesDiffer(['제목'], []), false);
  assert.strictEqual(titlesDiffer(null, ['제목']), false);
});

test('findDuplicateNames: 번호는 같은데 제목이 다른 묶음과 카메라·순번 이름 묶음에 주의를 붙인다 (#103)', () => {
  const dir = tempDir();
  put(dir, 'WWE-2023 Raw.mp4');
  put(dir, 'WWE-2023 SmackDown.mp4');
  put(dir, 'IPHONE-15 review.mp4');
  put(dir, path.join('b', 'IPHONE-15 unboxing.mp4'));
  // If the title is on only one side or overlaps, no caution is added.
  put(dir, 'ABC-123.mp4');
  put(dir, path.join('sub', '[FHD] ABC-123 제목 1080p.mkv'));
  put(dir, 'XYZ-999 좋은 영화.mp4');
  put(dir, 'XYZ-999 좋은 영화 감독판.mp4');
  // Common names that cameras add
  put(dir, path.join('2023', 'IMG_0001.MOV'));
  put(dir, path.join('2024', 'img 0001.mp4'));
  put(dir, 'GH010001.MP4');
  put(dir, path.join('b', 'GH010001.MP4'));
  put(dir, 'DJI_0001.MP4');
  put(dir, path.join('b', 'DJI_0001.MP4'));
  put(dir, path.join('x', '1.mp4'));
  put(dir, path.join('y', '1.mp4'));
  put(dir, path.join('car1', 'REC-0001.mp4'));
  put(dir, path.join('car2', 'REC-0001.mp4'));
  // A name a person gave is not a common name.
  put(dir, 'Holiday.mp4');
  put(dir, path.join('old', 'holiday.mp4'));

  const result = findDuplicateNames(dir);
  const flags = Object.fromEntries(result.groups.map((group) => [group.key, [group.generic, group.differentTitles]]));
  assert.deepStrictEqual(flags, {
    'ABC-123': [false, false],
    'IPHONE-15': [false, true],
    'REC-0001': [true, false],
    'WWE-2023': [false, true],
    'XYZ-999': [false, false],
    1: [true, false],
    'dji 0001': [true, false],
    gh010001: [true, false],
    holiday: [false, false],
    'img 0001': [true, false],
  });
  const report = formatDuplicateNames(result);
  const blockOf = (label) => report.split('\n').slice(report.split('\n').indexOf(label)).join('\n');
  assert.match(blockOf('Duplicate candidates (number WWE-2023, 2 files):'), /^Duplicate candidates \(number WWE-2023, 2 files\):\n {2}.+\n {2}.+\n {2}Caution: The number is the same but the titles differ, so they may be different videos\. remove-duplicates deletes only files whose title words are identical to the file to keep in this group\.\n/);
  assert.match(blockOf('Duplicate candidates (name "img 0001", 2 files):'), /^Duplicate candidates \(name "img 0001", 2 files\):\n {2}.+\n {2}.+\n {2}Caution: This is a common name such as a camera or sequence name, so videos with the same name may be different videos\. remove-duplicates does not delete this group\.\n/);
  assert.match(blockOf('Duplicate candidates (number ABC-123, 2 files):'), /^Duplicate candidates \(number ABC-123, 2 files\):\n {2}.+\n {2}.+\nDuplicate candidates/);
  assert.match(report, /10 duplicate candidate groups \(20 files, 7 need checking\)/);
});
