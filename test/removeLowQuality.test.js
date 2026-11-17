'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// It intercepts the Recycle Bin call and the volume check so that test files do not go to the real Recycle Bin. commands.js takes the function when it is imported, so it is swapped before the require.
const realExecFileSync = childProcess.execFileSync;
const { fakeRecycleFiles } = require('./fakeRecycleFiles');
const recycled = [];
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
test.mock.method(Date, 'now', () => realNow() + HOUR);

const { removeLowQuality, formatRemoveLowQuality } = require('../src/removeLowQuality');
const { REMOVAL_LOG } = require('../src/removalLog');
const { run } = require('../bin/fctl');

const OLD = new Date(realNow() - HOUR);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rmlowq-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function put(root, relative, content) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  fs.utimesSync(full, OLD, OLD);
  return full;
}

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

// An MP4 with only the head structure. It matches the file size (bitrate) with padding.
function mp4({ seconds = 60, width, height, padding = 0 }) {
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

const names = (root, list) => list.map((item) => path.relative(root, item.path).replaceAll(path.sep, '/')).sort();
const logs = (dir) => fs.readdirSync(dir).filter((name) => REMOVAL_LOG.test(name));

function fixture() {
  const dir = tempDir();
  put(dir, 'hd.mp4', mp4({ width: 1280, height: 720, padding: 8_000_000 }));
  put(dir, 'small.mp4', mp4({ width: 480, height: 270, padding: 8_000_000 }));
  put(dir, 'sub/tiny.mp4', mp4({ width: 320, height: 240, padding: 1_000 }));
  // The resolution is ample but the bitrate is about 13kbps
  put(dir, 'starved.mp4', mp4({ width: 1280, height: 720, padding: 100_000 }));
  put(dir, 'old.avi', 'RIFF');
  return dir;
}

test('remove-low-quality는 확인값 없이는 목록만 보이고, 확인값을 주면 기록을 남긴 뒤 휴지통으로 보낸다 (#31)', () => {
  const dir = fixture();
  recycled.length = 0;
  const preview = removeLowQuality(dir, { minBitrate: 500 });
  assert.deepStrictEqual(names(dir, preview.removals), ['small.mp4', 'sub/tiny.mp4']);
  // A file caught only by bitrate may have a broken length, so it is kept (#179).
  assert.deepStrictEqual(preview.kept.map((item) => [path.basename(item.path), /low quality by bitrate only/.test(item.reason)]), [['starved.mp4', true]]);
  assert.deepStrictEqual(names(dir, preview.unreadable), ['old.avi']);
  assert.strictEqual(recycled.length, 0);
  assert.deepStrictEqual(logs(dir), []);
  const report = formatRemoveLowQuality(preview);
  assert.match(report, /^Criteria: below short side 360 px or bitrate 500 kbps$/m);
  assert.match(report, /^To delete: small\.mp4 \(.*480x270, 1:00, \d+kbps\) \[short side 270 px < 360\]$/m);
  assert.match(report, /^Kept: starved\.mp4 \(.*\) \[bitrate \d+ kbps < 500 kbps\] Kept because it is low quality by bitrate only/m);
  assert.match(report, /^Undetermined, not deleted: old\.avi /m);
  assert.match(report, new RegExp(`with the same criteria and --yes=${preview.code} to send`));

  // If the standards differ, the confirmation value also differs.
  assert.notStrictEqual(removeLowQuality(dir).code, preview.code);
  // With a wrong confirmation value or --dry-run, it does not delete.
  assert.strictEqual(removeLowQuality(dir, { minBitrate: 500, confirm: 'wrong' }).mismatch, true);
  assert.strictEqual(removeLowQuality(dir, { minBitrate: 500, confirm: preview.code, dryRun: true }).confirmed, false);
  assert.strictEqual(recycled.length, 0);

  const done = removeLowQuality(dir, { minBitrate: 500, confirm: preview.code });
  assert.strictEqual(done.confirmed, true);
  assert.deepStrictEqual(names(dir, done.removed), ['small.mp4', 'sub/tiny.mp4']);
  assert.deepStrictEqual(done.failed, []);
  assert.deepStrictEqual(recycled.map((p) => path.relative(dir, p).replaceAll(path.sep, '/')).sort(), ['small.mp4', 'sub/tiny.mp4']);
  assert.ok(fs.existsSync(path.join(dir, 'hd.mp4')) && fs.existsSync(path.join(dir, 'starved.mp4')));
  // The record holds the path, size, and reason, and the resolution, bitrate, and standards.
  const [logName] = logs(dir);
  assert.strictEqual(done.log, path.join(dir, logName));
  const log = JSON.parse(fs.readFileSync(done.log, 'utf8'));
  assert.strictEqual(log.kind, 'low-quality videos');
  assert.strictEqual(log.count, 2);
  const small = log.items.find((item) => item.path.endsWith('small.mp4'));
  assert.strictEqual(small.reason, 'Low-quality video (short side 270 px < 360)');
  assert.deepStrictEqual({ ...small.details, bitrate: typeof small.details.bitrate }, { width: 480, height: 270, displayWidth: 480, displayHeight: 270, duration: 60, bitrate: 'number', criteria: { minHeight: 360, minBitrate: 500 } });
  assert.match(formatRemoveLowQuality(done), /^Move to the Recycle Bin: small\.mp4 /m);
  assert.match(formatRemoveLowQuality(done), /^Removal log: /m);
});

test('remove-low-quality는 확인값을 만든 뒤 파일이 바뀌면 지우지 않고, 방금 바뀐 파일과 1GB 이상은 남긴다 (#31)', () => {
  const dir = tempDir();
  const file = put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  const { code } = removeLowQuality(dir);
  fs.appendFileSync(file, 'x');
  fs.utimesSync(file, OLD, OLD);
  assert.strictEqual(removeLowQuality(dir, { confirm: code }).mismatch, true);
  assert.ok(fs.existsSync(file));
  // A file changed just now: if given the current time without moving the clock, the creation and change times of the file just made are within 5 minutes.
  const fresh = removeLowQuality(dir, { now: realNow() });
  assert.deepStrictEqual(fresh.kept.map((item) => item.reason), ['Kept because it changed just now and may still be downloading.']);
  // If the Recycle Bin maximum size is unknown, it keeps from 1GB (here maxSize) (#219).
  const big = removeLowQuality(dir, { maxSize: 10 });
  assert.deepStrictEqual(big.kept.map((item) => item.reason), ['Kept because it is 1GB or larger and the Recycle Bin maximum size could not be checked, so it could be permanently deleted.']);
  assert.deepStrictEqual(big.removals, []);
});

test('remove-low-quality는 휴지통 설정상 영구 삭제될 파일(바로 제거, 최대 크기 초과)과 그 하드링크 이름을 남긴다 (#219)', (t) => {
  const dir = tempDir();
  put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  const big = put(dir, 'big.mp4', mp4({ width: 480, height: 270, padding: 2 * 1024 * 1024 }));
  fs.linkSync(big, path.join(dir, 'big-link.mp4'));
  fs.utimesSync(big, OLD, OLD);
  t.after(() => {
    volume = () => 'True|Fixed\r\n';
  });
  volume = () => 'True|Fixed|1|26427\r\n';
  const nuke = removeLowQuality(dir);
  assert.deepStrictEqual(nuke.removals, []);
  assert.ok(nuke.kept.length === 3 && nuke.kept.every((item) => /^Kept because this volume is set to remove files immediately.*permanently deleted\.$/.test(item.reason)), JSON.stringify(nuke.kept.map((item) => item.reason)));
  // Maximum size 1MB: only big.mp4 (over 2MB) and its hard link are kept, and small.mp4 is put in the list to delete.
  volume = () => 'True|Fixed|0|1\r\n';
  const plan = removeLowQuality(dir);
  assert.deepStrictEqual(plan.removals.map((item) => path.basename(item.path)), ['small.mp4']);
  const kept = Object.fromEntries(plan.kept.map((item) => [path.basename(item.path), item.reason]));
  assert.strictEqual(kept['big.mp4'], 'Kept because it is larger than the Recycle Bin maximum size (1MB), so Windows would permanently delete it without asking.');
  assert.strictEqual(kept['big-link.mp4'], kept['big.mp4']);
  // If the maximum size is known, the limit for when the capacity is unknown (maxSize) is not used.
  volume = () => 'True|Fixed|0|26427\r\n';
  assert.strictEqual(removeLowQuality(dir, { maxSize: 10 }).removals.length, 2);
});

test('remove-low-quality는 exFAT 볼륨이면 고정 디스크여도 지우지 않는다 (#184)', (t) => {
  const dir = tempDir();
  const file = put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  t.after(() => {
    format = () => 'NTFS\r\n';
  });
  format = () => 'exFAT\r\n';
  recycled.length = 0;
  const plan = removeLowQuality(dir);
  assert.deepStrictEqual(plan.removals, []);
  assert.match(plan.kept[0].reason, /^Kept because exFAT volumes do not record change times/);
  assert.deepStrictEqual(removeLowQuality(dir, { confirm: plan.code }).removed, []);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('remove-low-quality는 고정 디스크가 아니거나 대화형 세션이 아니면 지우지 않는다 (#31)', (t) => {
  const dir = tempDir();
  const file = put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  t.after(() => {
    volume = () => 'True|Fixed\r\n';
  });
  volume = () => 'True|Removable\r\n';
  const removable = removeLowQuality(dir);
  assert.deepStrictEqual(removable.removals, []);
  assert.match(removable.kept[0].reason, /not a fixed disk \(Removable\)/);
  volume = () => 'False|Fixed\r\n';
  const { code } = removeLowQuality(dir);
  assert.throws(() => removeLowQuality(dir, { confirm: code }), /not confirmed that this is an interactive session/);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(logs(dir), []);
});

test('remove-low-quality는 휴지통 이동이 실패한 파일을 보고하고 나머지는 계속한다 (#31)', (t) => {
  const dir = tempDir();
  put(dir, 'a.mp4', mp4({ width: 480, height: 270 }));
  put(dir, 'b.mp4', mp4({ width: 480, height: 270 }));
  t.after(() => {
    onRecycle = () => {};
  });
  onRecycle = (target) => {
    if (target.endsWith('a.mp4')) throw Object.assign(new Error('locked'), { status: 1 });
  };
  const { code } = removeLowQuality(dir);
  const result = removeLowQuality(dir, { confirm: code });
  assert.deepStrictEqual(names(dir, result.removed), ['b.mp4']);
  // It sends in batches (#216), so only that file fails with the reason Windows gave.
  const reason = `Could not send to the Recycle Bin: ${path.join(dir, 'a.mp4')} (locked).`;
  assert.deepStrictEqual(result.failed.map((item) => [path.basename(item.path), item.reason]), [['a.mp4', reason]]);
  assert.ok(formatRemoveLowQuality(result).split(/\r?\n/).includes(`Failed: a.mp4 (${reason})`));
});

test('remove-low-quality 명령은 기준 옵션과 --yes를 받고, 실패나 틀린 확인값은 오류로 끝낸다 (#31)', () => {
  const dir = tempDir();
  put(dir, 'a.mp4', mp4({ width: 854, height: 480 }));
  assert.match(run(['remove-low-quality', dir]), /to delete 0/);
  const listed = run(['remove-low-quality', dir, '--min-height=720']);
  const code = /--yes=([0-9a-f]{12})/.exec(listed)[1];
  assert.throws(() => run(['remove-low-quality', dir, '--yes=000000000000']), /differs from when the confirmation value was made/);
  // If it drops the standards and gives only the confirmation value, it is a different list, so it does not delete.
  assert.throws(() => run(['remove-low-quality', dir, `--yes=${code}`]), /differs from when the confirmation value was made/);
  assert.throws(() => run(['remove-low-quality', dir, '--min-height=720', '--yes']), /Give --yes the confirmation value shown in the list/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.match(run(['remove-low-quality', dir, '--min-height=720', `--yes=${code}`]), /^Move to the Recycle Bin: a\.mp4 /m);
  assert.ok(!fs.existsSync(path.join(dir, 'a.mp4')));
  assert.throws(() => run(['remove-low-quality', dir, '--permanent']), /so --force and --permanent cannot be used/);
});

test('remove-low-quality는 같은 파일의 다른 이름(하드링크)은 한 번에 하나만 지운다 (#31)', () => {
  const dir = tempDir();
  const file = put(dir, 'a.mp4', mp4({ width: 480, height: 270 }));
  fs.linkSync(file, path.join(dir, 'b.mp4'));
  const plan = removeLowQuality(dir);
  assert.deepStrictEqual(names(dir, plan.removals), ['a.mp4']);
  assert.deepStrictEqual(plan.kept.map((item) => [path.basename(item.path), /hard link: a\.mp4/.test(item.reason)]), [['b.mp4', true]]);
});
