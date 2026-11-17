'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// It intercepts the Recycle Bin call so that test files do not go to the real Recycle Bin. commands.js takes the function when it is imported, so it is swapped before the require.
const realExecFileSync = childProcess.execFileSync;
const { fakeRecycleFiles } = require('./fakeRecycleFiles');
const recycled = [];
// The input passed to the batch Recycle Bin move (for each line, the copy path, stamp, file-to-keep path, and stamp).
const batchInputs = [];
let onRecycle = () => {};
let volume = () => 'True|Fixed\r\n';
// File system check (#184). By default it answers NTFS, and each test swaps it to imitate exFAT and so on.
let format = () => 'NTFS\r\n';
let formatProbes = 0;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) {
    formatProbes += 1;
    return format();
  }
  if (options?.env?.FC_VOLUME !== undefined) return volume();
  // It also imitates the batch Recycle Bin move (#216) so as not to touch the user's Recycle Bin.
  if (options?.env?.FC_RECYCLE_FILES !== undefined) {
    batchInputs.push(options.input);
    return fakeRecycleFiles(options, (target) => {
      recycled.push(target);
      onRecycle(target);
    });
  }
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  onRecycle(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET);
  return Buffer.alloc(0);
});

// The creation and change times cannot be set back in tests, so the clock is moved forward 1 hour as if the file had been made long ago.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
let skew = HOUR;
test.mock.method(Date, 'now', () => realNow() + skew);

const { removeDuplicates, formatRemoveDuplicates } = require('../src/removeDuplicates');
const { REMOVAL_LOG } = require('../src/removalLog');
const { run } = require('../bin/fctl');

const OLD = new Date(realNow() - HOUR);

// A minimal MP4 whose length and resolution can be read. It changes the size with padding.
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
  const trak = box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd, box('stco', u32(0), u32(0))))));
  return Buffer.concat([box('ftyp', latin('isom'), u32(512), latin('isommp42')), box('moov', mvhd, trak), box('mdat', Buffer.alloc(64 + padding))]);
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rmdup-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  const made = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, OLD, OLD);
    made[name] = full;
  }
  return made;
}

const logs = (dir) => fs.readdirSync(dir).filter((name) => REMOVAL_LOG.test(name));
const confirmed = (dir, options = {}) => removeDuplicates(dir, { ...options, confirm: removeDuplicates(dir, options).code });
const codeIn = (report) => /--yes=([0-9a-f]+)/.exec(report)[1];

test.beforeEach(() => {
  recycled.length = 0;
  onRecycle = () => {};
  volume = () => 'True|Fixed\r\n';
  format = () => 'NTFS\r\n';
  formatProbes = 0;
  skew = HOUR;
});

test('확인값이 없으면 묶음과 지울 파일만 보여 주고 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 3600 }), 'old/ABC-123 720p.mp4': mp4({ seconds: 3600.4, width: 1280, height: 720 }) });
  const result = removeDuplicates(dir);
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [f['old/ABC-123 720p.mp4']]);
  assert.strictEqual(result.sets[0].keep.path, f['ABC-123.mp4']);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  const lines = formatRemoveDuplicates(result).split('\n');
  assert.strictEqual(lines[0], 'Group (number ABC-123):');
  assert.match(lines[1], /^ {2}File to keep: ABC-123\.mp4 \(\d+B, 1920x1080, 1:00:00\) \[highest resolution\]$/);
  assert.match(lines[2], /^ {2}To delete: old[\\/]ABC-123 720p\.mp4 \(\d+B, 1280x720, 1:00:00\)$/);
  assert.match(lines.at(-1), /^Nothing has been deleted yet\. After checking the list, run again with --yes=[0-9a-f]{12} to send them/);
});

test('확인값이 맞으면 기록을 먼저 남기고 남길 파일과 길이·화면 비율이 같은 사본만 휴지통으로 보낸다', () => {
  const dir = tempDir();
  const f = make(dir, {
    'ABC-123.mp4': mp4({ seconds: 3600 }),
    'a/ABC-123 720p.mp4': mp4({ seconds: 3600.4, width: 1280, height: 720 }),
    'b/ABC-123 - 복사본.mp4': mp4({ seconds: 3600 }),
    // A trailer with the same number: the length differs, so it is kept.
    'c/ABC-123 trailer.mp4': mp4({ seconds: 90 }),
    // A group matching only by length because the names differ: it is not deleted.
    'x.mp4': mp4({ seconds: 900 }),
    'y.mp4': mp4({ seconds: 900 }),
  });
  let logged = null;
  onRecycle = () => {
    logged ??= logs(dir).length;
  };
  const result = confirmed(dir);
  assert.strictEqual(result.confirmed, true);
  assert.deepStrictEqual(recycled.sort(), [f['a/ABC-123 720p.mp4'], f['b/ABC-123 - 복사본.mp4']].sort());
  assert.strictEqual(logged, 1, '지우기 전에 기록이 있어야 한다');
  for (const name of ['ABC-123.mp4', 'c/ABC-123 trailer.mp4', 'x.mp4', 'y.mp4']) assert.ok(fs.existsSync(f[name]), name);
  assert.deepStrictEqual(result.kept.map((item) => [item.path, item.reason]), [[f['c/ABC-123 trailer.mp4'], 'Kept because the duration differs from the file to keep, so it may not be the same video.']]);
  assert.strictEqual(result.lengthOnly, 1);
  const log = JSON.parse(fs.readFileSync(result.log, 'utf8'));
  assert.strictEqual(log.kind, 'duplicate videos');
  assert.deepStrictEqual(log.items.map((item) => item.path).sort(), recycled.slice().sort());
  assert.ok(log.items.every((item) => item.details.keep === f['ABC-123.mp4'] && item.details.group === 'number ABC-123'));
  const report = formatRemoveDuplicates(result);
  assert.match(report, /Move to the Recycle Bin: a[\\/]ABC-123 720p\.mp4/);
  assert.match(report, /Kept: c[\\/]ABC-123 trailer\.mp4 \(.+\) Kept because the duration differs/);
  assert.match(report, /1 same-duration groups are not deleted because their names differ and they may be different videos/);
  assert.match(report, /Removal log: /);
  assert.match(report.split('\n').at(-1), /^Groups 1, Recycle Bin 2, failed 0, kept 1, same-duration-only groups 1/);
});

// #127: copies that are certain to fail when sent to the Recycle Bin are kept at the planning stage.
test('남길 파일의 하드링크인 사본은 같은 파일의 다른 이름이라 지우지 않고, 사본끼리 하드링크면 이번에 하나만 지운다 (#127)', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 3600 }), 'x/ABC-123 copy.mp4': mp4({ seconds: 3600 }) });
  // Another name of the file to keep. Deleting it does not reduce space, and it changes the change time of the file to keep.
  const keeperLink = path.join(dir, 'a', 'ABC-123 - 복사본.mp4');
  fs.mkdirSync(path.dirname(keeperLink));
  fs.linkSync(f['ABC-123.mp4'], keeperLink);
  // The same file between copies. Deleting one name changes the change time of the other name.
  const copyLink = path.join(dir, 'y', 'ABC-123 (2).mp4');
  fs.mkdirSync(path.dirname(copyLink));
  fs.linkSync(f['x/ABC-123 copy.mp4'], copyLink);
  const plan = removeDuplicates(dir);
  const keeper = plan.sets[0].keep.path;
  const keeperName = path.relative(dir, keeper);
  const removed = plan.removals.map((item) => path.relative(dir, item.path));
  const kept = Object.fromEntries(plan.kept.map((item) => [path.relative(dir, item.path), item.reason]));
  // A name of the same file as the file to keep is not deleted whichever side becomes the file to keep.
  const keeperTwins = [path.relative(dir, f['ABC-123.mp4']), path.relative(dir, keeperLink)].filter((name) => name !== keeperName);
  for (const name of keeperTwins) assert.match(kept[name] ?? '', /^Kept because it is another name of the same file \(hard link\) as the file to keep, so deleting it would not free space\./, name);
  // If copies are the same file, it deletes only one and defers one to the next run.
  const copyTwins = [path.relative(dir, f['x/ABC-123 copy.mp4']), path.relative(dir, copyLink)];
  assert.strictEqual(copyTwins.filter((name) => removed.includes(name)).length, 1);
  const later = copyTwins.find((name) => !removed.includes(name));
  assert.match(kept[later], /^Kept because another name of the same file \(hard link: .+\) is deleted first in this run/);
  assert.ok(!removed.some((name) => keeperTwins.includes(name)));
  // Even if really deleted, the failure that the file to keep changed does not occur.
  const result = confirmed(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.removed.length, 1);
  assert.ok(fs.existsSync(keeper));
});

test('다른 묶음의 남길 파일과 하드링크인 사본은 지우지 않아, 그 묶음의 사본이 실행 중에 실패하지 않는다 (#127 1차 리뷰)', () => {
  const dir = tempDir();
  const f = make(dir, { 'AAA-100.mp4': mp4({ seconds: 3600 }), 'DEF-456.mp4': mp4({ seconds: 1800 }), 'z/DEF-456 copy.mp4': mp4({ seconds: 1800 }) });
  // A copy of the AAA-100 group is the same file as the file to keep of the DEF-456 group. One file is given two names so that the length looks the same as AAA-100.
  const cross = path.join(dir, 'x', 'AAA-100 copy.mp4');
  fs.mkdirSync(path.dirname(cross));
  fs.writeFileSync(f['DEF-456.mp4'], mp4({ seconds: 3600 }));
  fs.writeFileSync(f['z/DEF-456 copy.mp4'], mp4({ seconds: 3600 }));
  for (const name of ['DEF-456.mp4', 'z/DEF-456 copy.mp4']) fs.utimesSync(f[name], OLD, OLD);
  fs.linkSync(f['DEF-456.mp4'], cross);
  const plan = removeDuplicates(dir);
  const keepers = plan.sets.map((set) => set.keep.path).sort();
  assert.deepStrictEqual(keepers, [f['AAA-100.mp4'], f['DEF-456.mp4']].sort());
  assert.deepStrictEqual(plan.removals.map((item) => item.path), [f['z/DEF-456 copy.mp4']]);
  assert.deepStrictEqual(plan.kept.map((item) => [item.path, item.reason]), [[cross, `Kept because it is another name of the same file (hard link) as the file to keep of another group (DEF-456.mp4), so deleting it would not free space. Deleting it would change the modification time of that file.`]]);
  const result = confirmed(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(recycled, [f['z/DEF-456 copy.mp4']]);
});

test('고정 디스크가 아닌 볼륨에서는 사본끼리 하드링크여도 볼륨 사유로 남긴다 (#127 1차 리뷰)', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 3600 }), 'x/ABC-123 copy.mp4': mp4({ seconds: 3600 }) });
  const copyLink = path.join(dir, 'y', 'ABC-123 (2).mp4');
  fs.mkdirSync(path.dirname(copyLink));
  fs.linkSync(f['x/ABC-123 copy.mp4'], copyLink);
  volume = () => 'True|Removable\r\n';
  const plan = removeDuplicates(dir);
  assert.deepStrictEqual(plan.removals, []);
  assert.strictEqual(plan.kept.length, 2);
  assert.ok(plan.kept.every((item) => /^Kept because the drive is not a fixed disk \(Removable\)/.test(item.reason)), JSON.stringify(plan.kept.map((item) => item.reason)));
});

test('exFAT 볼륨에서는 고정 디스크여도 사본을 지우지 않는다 (#184)', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 3600 }), 'x/ABC-123 copy.mp4': mp4({ seconds: 3600 }) });
  format = () => 'exFAT\r\n';
  const plan = removeDuplicates(dir);
  assert.deepStrictEqual(plan.removals, []);
  assert.strictEqual(plan.kept.length, 1);
  assert.match(plan.kept[0].reason, /^Kept because exFAT volumes do not record change times/);
  assert.deepStrictEqual(removeDuplicates(dir, { confirm: plan.code }).removed, []);
  assert.ok(fs.existsSync(f['x/ABC-123 copy.mp4']));
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('다른 사본과 하드링크이면서 경로가 긴 사본은 경로 사유로 남긴다 (#127 1차 리뷰)', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 3600 }), 'x/ABC-123 copy.mp4': mp4({ seconds: 3600 }) });
  const long = path.join(dir, 'x'.repeat(120), 'y'.repeat(120), 'ABC-123 (2).mp4');
  fs.mkdirSync(path.dirname(long), { recursive: true });
  fs.linkSync(f['x/ABC-123 copy.mp4'], long);
  const plan = removeDuplicates(dir);
  const kept = Object.fromEntries(plan.kept.map((item) => [item.path, item.reason]));
  assert.match(kept[long], /^The path is \d+ characters, so it cannot be sent to the Recycle Bin/);
  assert.deepStrictEqual(plan.removals.map((item) => item.path), [f['x/ABC-123 copy.mp4']]);
});

test('전체 경로가 259자를 넘는 사본은 휴지통으로 보낼 수 없어 계획에서 남긴다 (#127)', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 3600 }) });
  const long = path.join(dir, 'x'.repeat(120), 'y'.repeat(120), 'ABC-123 copy.mp4');
  fs.mkdirSync(path.dirname(long), { recursive: true });
  fs.writeFileSync(long, mp4({ seconds: 3600 }));
  fs.utimesSync(long, OLD, OLD);
  assert.ok(long.length > 259);
  const plan = removeDuplicates(dir);
  assert.strictEqual(plan.sets[0].keep.path, f['ABC-123.mp4']);
  assert.deepStrictEqual(plan.removals, []);
  assert.deepStrictEqual(plan.kept.map((item) => [item.path, item.reason]), [[long, `The path is ${long.length} characters, so it cannot be sent to the Recycle Bin (up to 259): ${long}`]]);
});

test('남길 파일의 경로가 259자를 넘어도 그 사본은 지운다 (#216 1차 리뷰)', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123 copy.mp4': mp4({ seconds: 3600 }) });
  const long = path.join(dir, 'x'.repeat(120), 'y'.repeat(120), 'ABC-123.mp4');
  fs.mkdirSync(path.dirname(long), { recursive: true });
  fs.writeFileSync(long, mp4({ seconds: 3600, padding: 100 }));
  fs.utimesSync(long, OLD, OLD);
  assert.ok(long.length > 259);
  const plan = removeDuplicates(dir);
  assert.strictEqual(plan.sets[0].keep.path, long);
  assert.deepStrictEqual(plan.removals.map((item) => item.path), [f['ABC-123 copy.mp4']]);
  const result = removeDuplicates(dir, { confirm: plan.code });
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.removed.map((item) => item.path), [f['ABC-123 copy.mp4']]);
  assert.ok(fs.existsSync(long) && !fs.existsSync(f['ABC-123 copy.mp4']));
});

test('이름만 같은 다른 영상(제품번호처럼 보이는 말, 같은 제목)은 길이나 화면 비율이 다르면 지우지 않는다 (#103)', () => {
  const dir = tempDir();
  make(dir, {
    'WWE-2023 Raw.mp4': mp4({ seconds: 10800 }),
    'WWE-2023 SmackDown.mp4': mp4({ seconds: 7200 }),
    'Holiday.mp4': mp4({ seconds: 600, width: 3840, height: 2160 }),
    'b/holiday.mp4': mp4({ seconds: 600, width: 1080, height: 1920 }),
  });
  const result = removeDuplicates(dir);
  assert.strictEqual(result.sets.length, 2);
  assert.deepStrictEqual(result.removals, []);
  assert.deepStrictEqual(result.kept.map((item) => item.reason).sort(), [
    'Kept because the aspect ratio differs from the file to keep, so it may not be the same video.',
    'Kept because the duration differs from the file to keep, so it may not be the same video.',
  ]);
  const report = formatRemoveDuplicates(result);
  assert.match(report, /^ {2}Caution: The durations differ, so they may not be the same video\.$/m);
  assert.doesNotMatch(report, /--yes=/);
});

test('화면 비율은 회전을 반영한 보이는 크기로 비교한다 (#106)', () => {
  const dir = tempDir();
  const made = make(dir, {
    // An original that shows portrait through rotation information and a copy saved again as portrait are the same video.
    'Trip.mp4': mp4({ seconds: 600, rotate: 90, padding: 10 }),
    'old/trip.mp4': mp4({ seconds: 600, width: 1080, height: 1920 }),
    // A landscape video with no rotation information has a different aspect ratio even with the same name and length, so it is kept.
    'b/trip.mp4': mp4({ seconds: 600 }),
  });
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [made['old/trip.mp4']]);
  assert.deepStrictEqual(result.kept.map((item) => [item.path, item.reason]), [[made['b/trip.mp4'], 'Kept because the aspect ratio differs from the file to keep, so it may not be the same video.']]);
  assert.match(formatRemoveDuplicates(result), /^ {2}File to keep: Trip\.mp4 \(\d+B, 1920x1080 \(displayed size 1080x1920\), 10:00\)/m);
});

test('화면 비율이 3% 이내인 사본은 지우고, 16:9와 1.85:1처럼 더 다르면 남긴다 (#106)', () => {
  const dir = tempDir();
  const made = make(dir, {
    'Movie.mp4': mp4({ seconds: 600, width: 1920, height: 818 }),
    // The same video that split into 2.4 and 2.3 when rounded
    'old/movie.mp4': mp4({ seconds: 600, width: 1920, height: 816 }),
    'Film.mp4': mp4({ seconds: 900, width: 1920, height: 1080, padding: 10 }),
    // 1.85:1 is nearly 4% wider than 16:9.
    'old/film.mp4': mp4({ seconds: 900, width: 1920, height: 1038 }),
  });
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [made['old/movie.mp4']]);
  assert.deepStrictEqual(result.kept.map((item) => [item.path, item.reason]), [[made['old/film.mp4'], 'Kept because the aspect ratio differs from the file to keep, so it may not be the same video.']]);
});

test('번호는 같은데 남길 파일과 제목이 겹치지 않는 파일은 길이와 화면 비율이 같아도 지우지 않는다 (#103)', () => {
  const dir = tempDir();
  const made = make(dir, {
    // Broadcast recordings of a fixed length can even have the same length.
    'WWE-2023 Raw.mp4': mp4({ seconds: 10800, padding: 10 }),
    'old/WWE-2023 SmackDown.mp4': mp4({ seconds: 10800 }),
    'IPHONE-15 review.mp4': mp4({ seconds: 600, padding: 10 }),
    'b/IPHONE-15 unboxing.mp4': mp4({ seconds: 600 }),
    // Overlapping only in a repeated word (WWE) makes a different title.
    'WWE-2024 WWE Raw.mp4': mp4({ seconds: 10800, padding: 10 }),
    'b/WWE-2024 WWE SmackDown.mp4': mp4({ seconds: 10800 }),
    // It looks for each file even within one group. In a group where files with a different title are mixed, it deletes only files with exactly the same title words.
    'XYZ-999 좋은 영화.mp4': mp4({ seconds: 300, padding: 10 }),
    'old/XYZ-999 영화 좋은 1080p.mp4': mp4({ seconds: 300 }),
    'old/XYZ-999 좋은 영화 감독판.mp4': mp4({ seconds: 300 }),
    'old/XYZ-999 다른 영상.mp4': mp4({ seconds: 300 }),
    // Even if the title of the file to keep is in both of two different titles, it deletes neither (WWE is in both WWE Raw and WWE SmackDown).
    'WWE-2026 WWE.mp4': mp4({ seconds: 10800, padding: 10 }),
    'a/WWE-2026 WWE Raw.mp4': mp4({ seconds: 10800 }),
    'b/WWE-2026 WWE SmackDown.mp4': mp4({ seconds: 10800 }),
    // In a group with no files of a different title, a title containing all the words is also the same title, so it is deleted.
    'LMN-200 좋은 영화.mp4': mp4({ seconds: 300, padding: 10 }),
    'old/LMN-200 좋은 영화 감독판.mp4': mp4({ seconds: 300 }),
    // In a group where files with a different title are mixed, a file with no title is kept because it is not known which video it is a copy of.
    'old/XYZ-999.mp4': mp4({ seconds: 300 }),
    // Even if the file to keep has no title, it does not delete files with different titles. If it is a copy of Raw, SmackDown may be the only original.
    'WWE-2025.mp4': mp4({ seconds: 10800, padding: 10 }),
    'a/WWE-2025 Raw.mp4': mp4({ seconds: 10800 }),
    'b/WWE-2025 SmackDown.mp4': mp4({ seconds: 10800 }),
    // If the title is on only one side and there are no files of a different title, it deletes.
    'QRS-100 제목.mp4': mp4({ seconds: 300, padding: 10 }),
    'old/QRS-100.mp4': mp4({ seconds: 300 }),
  });
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals.map((item) => item.path).sort(), [made['old/XYZ-999 영화 좋은 1080p.mp4'], made['old/LMN-200 좋은 영화 감독판.mp4'], made['old/QRS-100.mp4']].sort());
  const differ = 'Kept because the number is the same but the title differs from the file to keep, so it may be a different video.';
  const untitled = 'Kept because the group mixes files with different titles and one has no title, so it could not be confirmed which video it is a copy of.';
  const notSame = 'Kept because the group mixes files with different titles; only files whose title words are identical to the file to keep are deleted, and this file was kept.';
  assert.deepStrictEqual(
    result.kept.map((item) => [item.path, item.reason]).sort(),
    [
      [made['old/WWE-2023 SmackDown.mp4'], differ],
      [made['b/IPHONE-15 unboxing.mp4'], differ],
      [made['b/WWE-2024 WWE SmackDown.mp4'], differ],
      [made['old/XYZ-999 다른 영상.mp4'], differ],
      [made['old/XYZ-999.mp4'], untitled],
      [made['a/WWE-2025 Raw.mp4'], untitled],
      [made['b/WWE-2025 SmackDown.mp4'], untitled],
      [made['old/XYZ-999 좋은 영화 감독판.mp4'], notSame],
      [made['a/WWE-2026 WWE Raw.mp4'], notSame],
      [made['b/WWE-2026 WWE SmackDown.mp4'], notSame],
    ].sort(),
  );
  assert.match(formatRemoveDuplicates(result), /^ {2}Kept: old[\\/]XYZ-999 다른 영상\.mp4 \(.+\) Kept because the number is the same but the title differs/m);
});

test('카메라·순번처럼 흔한 이름의 묶음은 길이와 화면 비율이 같아도 지우지 않는다 (#103)', () => {
  const dir = tempDir();
  make(dir, {
    'cardA/FILE0001.MOV': mp4({ seconds: 180, padding: 500 }),
    'cardB/FILE0001.MOV': mp4({ seconds: 180 }),
    '2023/IMG_0001.MOV': mp4({ seconds: 120 }),
    '2024/IMG-0001.mp4': mp4({ seconds: 120 }),
    'GH010001.MP4': mp4({ seconds: 600 }),
    'b/GH010001.MP4': mp4({ seconds: 600 }),
    'x/1.mp4': mp4({ seconds: 600 }),
    'y/1.mp4': mp4({ seconds: 600.5 }),
    'VID_20230101_123456.mp4': mp4({ seconds: 300 }),
    'old/VID_20230101_123456.mp4': mp4({ seconds: 300 }),
    // Names with short English attached between or after digits: iPhone edits, dashcam front and rear cameras, new DJI names
    'a/IMG_E0001.MOV': mp4({ seconds: 90 }),
    'b/IMG_E0001.MOV': mp4({ seconds: 90 }),
    'a/20230101_123456_F.mp4': mp4({ seconds: 60 }),
    'b/20230101_123456_F.mp4': mp4({ seconds: 60 }),
    'a/DJI_20230101123456_0001_D.MP4': mp4({ seconds: 120 }),
    'b/DJI_20230101123456_0001_D.MP4': mp4({ seconds: 120 }),
    // An upper-case dashcam counter that looks like a product number (#110)
    'car1/REC-0001.mp4': mp4({ seconds: 60 }),
    'car2/REC-0001.mp4': mp4({ seconds: 60 }),
    'car1/FRONT-0001.mp4': mp4({ seconds: 180 }),
    'car2/FRONT-0001.mp4': mp4({ seconds: 180 }),
    // Names that are not common names, and product numbers, are deleted as they are.
    'ABC-123.mp4': mp4({ seconds: 300, padding: 10 }),
    'old/ABC-123.mp4': mp4({ seconds: 300 }),
    'Holiday.mp4': mp4({ seconds: 300, padding: 10 }),
    'old/holiday.mp4': mp4({ seconds: 300 }),
    'My Movie 2.mp4': mp4({ seconds: 300, padding: 10 }),
    'old/My Movie 2.mp4': mp4({ seconds: 300 }),
  });
  const result = removeDuplicates(dir);
  assert.strictEqual(result.sets.length, 13);
  assert.deepStrictEqual(result.removals.map((item) => path.relative(dir, item.path)).sort(), [path.join('old', 'ABC-123.mp4'), path.join('old', 'My Movie 2.mp4'), path.join('old', 'holiday.mp4')].sort());
  assert.strictEqual(result.kept.length, 10);
  assert.ok(result.kept.every((item) => item.reason === 'Kept because it is a common name such as a camera or sequence name, so videos with the same duration may be different videos.'));
});

// An MP4 whose video data (mdat) is filled with random bytes. It does not get caught by the zero-stretch samples.
function filled(options) {
  const file = mp4(options);
  const data = 64 + (options.padding ?? 0);
  require('node:crypto').randomFillSync(file, file.length - data);
  return file;
}

test('남길 파일이 잘렸거나 0으로 채워진 덜 받은 파일이면 그 묶음은 지우지 않는다 (#109)', () => {
  const dir = tempDir();
  const MB = 1024 * 1024;
  const cut = filled({ seconds: 600, width: 3840, height: 2160, padding: 5000 });
  make(dir, {
    // It is chosen as the file to keep because of its high resolution, but its end is truncated.
    'ABC-123 4K.mp4': cut.subarray(0, cut.length - 3000),
    'ABC-123.mp4': filled({ seconds: 600 }),
    // The head is normal and the size is fully reserved, but the data is 0.
    'XYZ-999 4K.mp4': mp4({ seconds: 600, width: 3840, height: 2160, padding: 2 * MB }),
    'XYZ-999.mp4': filled({ seconds: 600 }),
    // A large file filled with data is used as the file to keep, and the copies are deleted.
    'QRS-555 4K.mp4': filled({ seconds: 600, width: 3840, height: 2160, padding: 2 * MB }),
    'QRS-555.mp4': filled({ seconds: 600 }),
  });
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals.map((item) => path.basename(item.path)), ['QRS-555.mp4']);
  const reasons = Object.fromEntries(result.kept.map((item) => [path.basename(item.path), item.reason]));
  assert.match(reasons['ABC-123.mp4'], /^Kept because the file to keep may be broken\. \(The mdat box runs past the end of the file/);
  assert.strictEqual(reasons['XYZ-999.mp4'], 'Kept because the file to keep has a section filled only with zeros, so it may be partly downloaded.');
});

const UHD = { seconds: 600, width: 3840, height: 2160 };
const reasonsOf = (dir, result) => Object.fromEntries(result.kept.map((item) => [path.relative(dir, item.path), item.reason]));

test('남길 파일 옆에 받기 도구의 표시 파일이 있으면 그 묶음은 지우지 않고 사유를 보고한다 (#115)', () => {
  const dir = tempDir();
  make(dir, {
    // aria2 keeps a status file beside the file with the reserved size. The head structure is already downloaded and looks intact.
    'ABC-123 4K.mp4': mp4(UHD),
    'ABC-123 4K.mp4.aria2': '받기 상태',
    'ABC-123.mp4': mp4({ seconds: 600 }),
    // Safari keeps a file being downloaded inside a marker folder.
    'XYZ-999 4K.mp4.download/XYZ-999 4K.mp4': mp4(UHD),
    'XYZ-999.mp4': mp4({ seconds: 600 }),
    'QRS-555 4K.mp4': mp4(UHD),
    'QRS-555.mp4': mp4({ seconds: 600 }),
  });
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.sets.map((set) => path.basename(set.keep.path)).sort(), ['ABC-123 4K.mp4', 'QRS-555 4K.mp4', 'XYZ-999 4K.mp4']);
  assert.deepStrictEqual(result.removals.map((item) => path.basename(item.path)), ['QRS-555.mp4']);
  const reasons = reasonsOf(dir, result);
  assert.deepStrictEqual(Object.keys(reasons).sort(), ['ABC-123.mp4', 'XYZ-999.mp4']);
  assert.strictEqual(reasons['ABC-123.mp4'], "Kept because the download tool's marker file (ABC-123 4K.mp4.aria2) is next to the file to keep and it may still be downloading. If you gave up the download, delete the marker file and run again.");
  assert.strictEqual(reasons['XYZ-999.mp4'], "Kept because the file to keep is inside the download tool's marker folder (XYZ-999 4K.mp4.download) and may still be downloading.");
  assert.match(formatRemoveDuplicates(result), /Kept: ABC-123\.mp4 \(.*\) Kept because the download tool's marker file \(ABC-123 4K\.mp4\.aria2\) is next to the file to keep/);
  confirmed(dir);
  assert.deepStrictEqual(recycled, [path.join(dir, 'QRS-555.mp4')]);
});

test('사본 옆에 받기 도구의 표시 파일이 있으면 그 사본만 남긴다 (#115)', () => {
  const dir = tempDir();
  const f = make(dir, {
    'ABC-123 4K.mp4': mp4(UHD),
    'ABC-123.mp4': mp4({ seconds: 600 }),
    'abc-123.MP4.part': '',
    'safari/ABC-123.mp4.download/ABC-123.mp4': mp4({ seconds: 600 }),
    'old/ABC-123.mp4': mp4({ seconds: 600 }),
  });
  const result = confirmed(dir);
  assert.deepStrictEqual(recycled, [f['old/ABC-123.mp4']]);
  assert.deepStrictEqual(reasonsOf(dir, result), {
    'ABC-123.mp4': "Kept because the download tool's marker file (abc-123.MP4.part) is next to the file and it may still be downloading. If you gave up the download, delete the marker file and run again.",
    [path.join('safari', 'ABC-123.mp4.download', 'ABC-123.mp4')]: "Kept because the file is inside the download tool's marker folder (ABC-123.mp4.download) and may still be downloading.",
  });
  assert.deepStrictEqual(result.failed, []);
});

test('미리 본 뒤 남길 파일 옆에 표시 파일이 생기면 아무것도 지우지 않는다 (#115)', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123 4K.mp4': mp4(UHD), 'ABC-123.mp4': mp4({ seconds: 600 }) });
  const { code, removals } = removeDuplicates(dir);
  assert.strictEqual(removals.length, 1);
  make(dir, { 'ABC-123 4K.mp4.crdownload': '' });
  const result = removeDuplicates(dir, { confirm: code });
  assert.strictEqual(result.mismatch, true);
  assert.match(result.kept[0].reason, /marker file \(ABC-123 4K\.mp4\.crdownload\) is next to the file to keep/);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('표시 파일을 보려고 폴더를 읽지 못하면 남길 파일의 폴더는 그 묶음을, 사본의 폴더는 그 사본을 남긴다 (#115)', (t) => {
  const dir = tempDir();
  make(dir, {
    'new/ABC-123 4K.mp4': mp4(UHD),
    'old/ABC-123.mp4': mp4({ seconds: 600 }),
    'XYZ-999.mp4': mp4({ seconds: 600, padding: 100 }),
    'old/XYZ-999.mp4': mp4({ seconds: 600 }),
    'busy/XYZ-999.mp4': mp4({ seconds: 600 }),
  });
  const blocked = [path.join(dir, 'new'), path.join(dir, 'busy')];
  const realReaddir = fs.readdirSync;
  // The search (walk) reads folders with { withFileTypes: true }, so it blocks reading only the name list to look at marker files.
  t.mock.method(fs, 'readdirSync', function readdir(target, ...rest) {
    if (blocked.includes(target) && rest.length === 0) throw Object.assign(new Error('막힘'), { code: 'EPERM' });
    return realReaddir.call(this, target, ...rest);
  });
  const result = removeDuplicates(dir);
  t.mock.restoreAll();
  assert.deepStrictEqual(result.removals.map((item) => path.relative(dir, item.path)), [path.join('old', 'XYZ-999.mp4')]);
  assert.deepStrictEqual(reasonsOf(dir, result), {
    [path.join('old', 'ABC-123.mp4')]: "Kept because the folder of the file to keep could not be read to check for the download tool's marker file. (EPERM)",
    [path.join('busy', 'XYZ-999.mp4')]: "Kept because the folder could not be read to check for the download tool's marker file. (EPERM)",
  });
});

test('비대화형 세션이면 기록을 남기기 전에 멈춘다', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600, padding: 100 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  const { code } = removeDuplicates(dir);
  volume = () => 'False|Fixed\r\n';
  assert.throws(() => removeDuplicates(dir, { confirm: code }), /not confirmed that this is an interactive session/);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('지우는 중에 남길 파일이나 다음 사본이 바뀌면 그 사본은 지우지 않고 실패로 보고한다', () => {
  const dir = tempDir();
  const f = make(dir, {
    'ABC-123.mp4': mp4({ seconds: 600, padding: 100 }),
    'ABC-123 (1).mp4': mp4({ seconds: 600 }),
    'ABC-123 (2).mp4': mp4({ seconds: 600 }),
    'XYZ-999.mp4': mp4({ seconds: 600, padding: 100 }),
    'XYZ-999 (1).mp4': mp4({ seconds: 600 }),
    'XYZ-999 (2).mp4': mp4({ seconds: 600 }),
  });
  // If the first copy of ABC-123 is deleted, it fixes the file to keep, and if the first copy of XYZ-999 is deleted, it fixes the next copy.
  onRecycle = (target) => {
    if (target === f['ABC-123 (1).mp4']) fs.appendFileSync(f['ABC-123.mp4'], 'x');
    if (target === f['XYZ-999 (1).mp4']) fs.appendFileSync(f['XYZ-999 (2).mp4'], 'x');
  };
  const result = confirmed(dir);
  assert.deepStrictEqual(result.removed.map((item) => path.basename(item.path)).sort(), ['ABC-123 (1).mp4', 'XYZ-999 (1).mp4']);
  assert.deepStrictEqual(result.failed.map((item) => path.basename(item.path)).sort(), ['ABC-123 (2).mp4', 'XYZ-999 (2).mp4']);
  assert.match(result.failed.find((item) => item.path === f['ABC-123 (2).mp4']).reason, /Not deleted because the file to keep changed or disappeared/);
  assert.match(result.failed.find((item) => item.path === f['XYZ-999 (2).mp4']).reason, /Not deleted because the file changed after it was judged/);
  assert.ok(fs.existsSync(f['ABC-123 (2).mp4']));
  assert.ok(fs.existsSync(f['XYZ-999 (2).mp4']));
});

test('길이를 모르거나 60초 미만인 묶음은 지우지 않는다', () => {
  const dir = tempDir();
  // An AVI with only a header. It is not broken, but it is a format whose length is not read.
  const avi = Buffer.concat([latin('RIFF'), Buffer.from([4, 0, 0, 0]), latin('AVI ')]);
  make(dir, {
    'Trip.avi': avi,
    'trip - 복사본.avi': avi,
    'clip.mp4': mp4({ seconds: 30 }),
    'sub/clip - 복사본.mp4': mp4({ seconds: 30 }),
    'broken.mp4': 'x',
    'broken - 복사본.mp4': mp4({ seconds: 600 }),
  });
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals, []);
  const reasons = result.kept.map((item) => item.reason).sort();
  assert.deepStrictEqual(reasons, [
    'Kept because it is under 60 seconds, so duration cannot confirm they are the same video.',
    'Kept because the duration or resolution is unknown, so it could not be confirmed they are the same video.',
    'Kept because the duration or resolution of the file to keep is unknown, so it could not be confirmed they are the same video.',
  ].sort());
});

test('남길 파일이나 지울 파일이 방금 바뀌었으면 남긴다', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  skew = 0;
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(result.kept[0].reason, 'Kept because the file to keep changed just now or its time is in the future, so it may still be downloading.');
});

test('휴지통 설정상 영구 삭제될 사본(바로 제거, 최대 크기 초과)은 남기고, 크기 안이면 1GB가 넘어도 지울 목록에 둔다 (#100)', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  try {
    volume = () => 'True|Fixed|1|7164\r\n';
    const nuke = removeDuplicates(dir);
    assert.deepStrictEqual(nuke.removals, []);
    assert.match(nuke.kept[0].reason, /^Kept because this volume is set to remove files immediately instead of using the Recycle Bin, so it would be permanently deleted\.$/);
    volume = () => 'True|Fixed|0|0\r\n';
    const full = removeDuplicates(dir);
    assert.deepStrictEqual(full.removals, []);
    assert.match(full.kept[0].reason, /^Kept because it is larger than the Recycle Bin maximum size \(0MB\), so Windows would permanently delete it without asking\.$/);
    // If the maximum size is known, the limit for when the capacity is unknown (maxSize) is not used.
    volume = () => 'True|Fixed|0|7164\r\n';
    assert.strictEqual(removeDuplicates(dir, { maxSize: 10 }).removals.length, 1);
  } finally {
    volume = () => 'True|Fixed\r\n';
  }
});

test('고정 디스크가 아니거나 1GB 이상(maxSize)인 사본은 남긴다', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  const big = removeDuplicates(dir, { maxSize: 10 });
  assert.deepStrictEqual(big.removals, []);
  assert.match(big.kept[0].reason, /1GB or larger/);
  volume = () => 'True|Removable\r\n';
  const removable = removeDuplicates(dir);
  assert.deepStrictEqual(removable.removals, []);
  assert.match(removable.kept[0].reason, /not a fixed disk \(Removable\)/);
});

test('확인값을 만든 뒤 남길 파일이 바뀌면 아무것도 지우지 않는다', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  const { code } = removeDuplicates(dir);
  fs.appendFileSync(f['ABC-123.mp4'], 'more');
  fs.utimesSync(f['ABC-123.mp4'], OLD, new Date(OLD.getTime() + 1000));
  const result = removeDuplicates(dir, { confirm: code });
  assert.strictEqual(result.mismatch, true);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('지우는 중에 남길 파일이 없어지면 남은 사본은 지우지 않는다', () => {
  const dir = tempDir();
  const f = make(dir, {
    'ABC-123.mp4': mp4({ seconds: 600, padding: 100 }),
    'ABC-123 (1).mp4': mp4({ seconds: 600 }),
    'ABC-123 (2).mp4': mp4({ seconds: 600 }),
  });
  onRecycle = () => {
    if (fs.existsSync(f['ABC-123.mp4'])) fs.rmSync(f['ABC-123.mp4']);
  };
  const result = confirmed(dir);
  assert.strictEqual(result.removed.length, 1);
  assert.strictEqual(result.failed.length, 1);
  // It sends in batches (#216), so within the same group PowerShell looks at the file to keep again right before deleting a copy and stops.
  assert.strictEqual(result.failed[0].reason, `Not deleted because the file to keep changed or disappeared: ${f['ABC-123.mp4']}`);
  assert.ok(fs.existsSync(result.failed[0].path));
});

test('remove-duplicates는 사본을 묶어 PowerShell 한 번으로 보내고, 사본마다 남길 파일의 경로와 확인값을 함께 넘긴다 (#216)', () => {
  const dir = tempDir();
  const f = make(dir, {
    'ABC-123.mp4': mp4({ seconds: 600, padding: 100 }),
    'ABC-123 (1).mp4': mp4({ seconds: 600 }),
    'ABC-123 (2).mp4': mp4({ seconds: 600 }),
    'DEF-456.mp4': mp4({ seconds: 300, padding: 100 }),
    'DEF-456 (1).mp4': mp4({ seconds: 300 }),
  });
  const plan = removeDuplicates(dir);
  const keepStamps = new Map(plan.removals.map((item) => [item.keep, item.keepStamp]));
  batchInputs.length = 0;
  const result = removeDuplicates(dir, { confirm: plan.code });
  assert.strictEqual(result.removed.length, 3);
  assert.strictEqual(batchInputs.length, 1);
  const decode = (encoded) => Buffer.from(encoded, 'base64').toString('utf16le');
  const lines = batchInputs[0].split('\n').filter(Boolean).map((line) => line.split(' '));
  assert.deepStrictEqual(lines.map(([copy, , keep]) => [path.basename(decode(copy)), path.basename(decode(keep))]).sort(), [
    ['ABC-123 (1).mp4', 'ABC-123.mp4'],
    ['ABC-123 (2).mp4', 'ABC-123.mp4'],
    ['DEF-456 (1).mp4', 'DEF-456.mp4'],
  ]);
  for (const [, , keep, stamp] of lines) assert.strictEqual(stamp, keepStamps.get(decode(keep)));
  assert.ok(fs.existsSync(f['ABC-123.mp4']) && fs.existsSync(f['DEF-456.mp4']));
});

test('--dry-run은 확인값이 맞아도 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  const result = removeDuplicates(dir, { confirm: removeDuplicates(dir).code, dryRun: true });
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  assert.match(formatRemoveDuplicates(result), /without --dry-run and with --yes=/);
});

test('fctl remove-duplicates: 목록과 확인값을 내고, 확인값으로 지우고, 덮어쓰기·영구 삭제 옵션은 거부한다', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 600, padding: 100 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  assert.throws(() => run(['remove-duplicates', dir, '--permanent']), /--permanent/);
  assert.throws(() => run(['remove-duplicates', dir, '--force']), /--force/);
  assert.throws(() => run(['remove-duplicates', dir, '--yes=000000000000']), /differs from when the confirmation value was made/);
  const report = run(['remove-duplicates', dir]);
  assert.deepStrictEqual(recycled, []);
  run(['remove-duplicates', dir, `--yes=${codeIn(report)}`]);
  assert.deepStrictEqual(recycled, [f['ABC-123 (1).mp4']]);
  assert.ok(fs.existsSync(f['ABC-123.mp4']));
  assert.match(run(['--help']), /remove-duplicates <target>/);
});
