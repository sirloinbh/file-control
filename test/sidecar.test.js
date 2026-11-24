'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const { fakeRecycleFiles } = require('./fakeRecycleFiles');

// A fake Recycle Bin, installed before commands.js is imported: single targets (rm), file batches (remove-*) and folder batches.
const recycled = [];
const realExecFileSync = childProcess.execFileSync;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  const env = options?.env ?? {};
  const state = volumeStateAnswer(env, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  if (env.FC_RECYCLE_FILES !== undefined) return fakeRecycleFiles(options, (target) => recycled.push(target));
  if (env.FC_TARGET !== undefined) {
    recycled.push(env.FC_TARGET);
    fs.rmSync(env.FC_TARGET, { recursive: true });
    return undefined;
  }
  return realExecFileSync(file, args, options);
});

const { execute } = require('../src/execute');
const { findSidecars, withSidecarPaths } = require('../src/sidecar');
const { planSafeRemovals, runConfirmedRemoval, sidecarDigest } = require('../src/removal');
const { grant, fileStamp } = require('../src/target');
const journal = require('../src/journal');
const { readRecord } = require('./removalRecord');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
const OLD = new Date(realNow() - HOUR);
// The 5-minute hold looks at the creation time too, so the clock runs an hour ahead, as in test/removal.test.js.
test.mock.method(Date, 'now', () => realNow() + HOUR);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sidecar-'));
  const journals = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sidecar-journals-'));
  const before = process.env.FCTL_JOURNAL_DIR;
  process.env.FCTL_JOURNAL_DIR = journals;
  recycled.length = 0;
  test.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(journals, { recursive: true, force: true });
    if (before === undefined) delete process.env.FCTL_JOURNAL_DIR;
    else process.env.FCTL_JOURNAL_DIR = before;
  });
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f);
    fs.utimesSync(full, OLD, OLD);
  }
}

const names = (dir) => fs.readdirSync(dir).sort();
const run = (...argv) => execute(argv);

test('findSidecars: same base name, known extensions, language tags on subtitles only', () => {
  const dir = tempDir();
  make(dir, ['abc.mp4', 'abc.srt', 'abc.ko.srt', 'abc.en-US.vtt', 'abc.jpg', 'abc.nfo', 'abc.ko.jpg', 'abc.txt', 'abcd.srt', 'other.srt']);
  assert.deepStrictEqual(findSidecars(path.join(dir, 'abc.mp4')).map((s) => s.suffix), ['.en-US.vtt', '.jpg', '.ko.srt', '.nfo', '.srt']);
  // A name that is not a video has none.
  assert.deepStrictEqual(findSidecars(path.join(dir, 'abc.srt')), []);
});

test('findSidecars: a second video with the same base name, or a longer base that owns the file, takes it out', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.mkv', 'a.srt', 'b.mp4', 'b.en.mp4', 'b.en.srt', 'b.srt']);
  assert.deepStrictEqual(findSidecars(path.join(dir, 'a.mp4')), [], 'a.mkv shares a.srt, so it is not carried');
  assert.deepStrictEqual(findSidecars(path.join(dir, 'b.mp4')).map((s) => s.suffix), ['.srt'], 'b.en.srt belongs to b.en.mp4');
});

test('findSidecars: links and folders are not sidecars', (t) => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'target.txt']);
  fs.mkdirSync(path.join(dir, 'a.srt'));
  try {
    fs.symlinkSync(path.join(dir, 'target.txt'), path.join(dir, 'a.nfo'));
  } catch {
    t.diagnostic('symbolic links are not available');
  }
  assert.deepStrictEqual(findSidecars(path.join(dir, 'a.mp4')), []);
});

test('rename moves the subtitle and sidecars with the video, and --dry-run lists them', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'a.ko.srt', 'a.jpg', 'keep.txt']);
  const preview = run('rename', path.join(dir, 'a.mp4'), 'b.mp4', '--dry-run');
  assert.match(preview.report, /\[Preview\] Rename: .*a\.mp4 -> .*b\.mp4/);
  assert.match(preview.report, /a\.ko\.srt -> .*b\.ko\.srt \(sidecar\)/);
  assert.deepStrictEqual(names(dir), ['a.jpg', 'a.ko.srt', 'a.mp4', 'a.srt', 'keep.txt']);
  run('rename', path.join(dir, 'a.mp4'), 'b.mp4');
  assert.deepStrictEqual(names(dir), ['b.jpg', 'b.ko.srt', 'b.mp4', 'b.srt', 'keep.txt']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.ko.srt'), 'utf8'), 'a.ko.srt');
});

test('rename --no-sidecars leaves them, and the flag belongs to rename, mv and rm only', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt']);
  run('rename', path.join(dir, 'a.mp4'), 'b.mp4', '--no-sidecars');
  assert.deepStrictEqual(names(dir), ['a.srt', 'b.mp4']);
  assert.throws(() => run('cp', path.join(dir, 'b.mp4'), path.join(dir, 'c.mp4'), '--no-sidecars'), /--no-sidecars can be used only with rename, mv, and rm/);
});

test('a name taken by one sidecar stops the whole rename (no overwriting)', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'a.jpg', 'b.jpg']);
  assert.throws(() => run('rename', path.join(dir, 'a.mp4'), 'b.mp4'), /Already exists.*b\.jpg|b\.jpg/);
  assert.deepStrictEqual(names(dir), ['a.jpg', 'a.mp4', 'a.srt', 'b.jpg']);
});

test('mv takes the sidecars into the destination, and a taken sidecar name stops the whole move', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'out/placeholder.txt']);
  run('mv', path.join(dir, 'a.mp4'), path.join(dir, 'out'));
  assert.deepStrictEqual(names(path.join(dir, 'out')), ['a.mp4', 'a.srt', 'placeholder.txt']);
  make(dir, ['c.mp4', 'c.srt', 'out/c.srt']);
  assert.throws(() => run('mv', path.join(dir, 'c.mp4'), path.join(dir, 'out')), /Already exists/);
  assert.ok(fs.existsSync(path.join(dir, 'c.mp4')) && fs.existsSync(path.join(dir, 'c.srt')));
  assert.ok(!fs.existsSync(path.join(dir, 'out', 'c.mp4')));
});

test('rm sends the video and its sidecars to the Recycle Bin and lists them in the preview', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'a.nfo', 'z.txt']);
  const preview = run('rm', path.join(dir, 'a.mp4'), '--dry-run');
  assert.strictEqual(preview.report.split('\n').length, 3);
  assert.match(preview.report, /a\.srt/);
  run('rm', path.join(dir, 'a.mp4'));
  assert.deepStrictEqual(names(dir), ['z.txt']);
  assert.strictEqual(recycled.length, 3);
});

test('rm of a video that is also listed with its subtitle does not list the subtitle twice, and a plain file has no sidecars', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'notes.txt', 'notes.srt']);
  assert.deepStrictEqual(withSidecarPaths([path.join(dir, 'a.mp4'), path.join(dir, 'a.srt')]), [path.join(dir, 'a.mp4'), path.join(dir, 'a.srt')]);
  assert.deepStrictEqual(withSidecarPaths([path.join(dir, 'notes.txt')]), [path.join(dir, 'notes.txt')]);
});

test('normalize renames abc-123.mp4 and its subtitles together, the preview lists them, and a clash skips the whole group', () => {
  const dir = tempDir();
  make(dir, ['clip ABC-123.mp4', 'clip ABC-123.srt', 'clip ABC-123.ko.srt', 'other XYZ-999.mp4', 'other XYZ-999.srt', 'XYZ-999 other.srt']);
  const preview = run('normalize', dir, '--dry-run');
  assert.match(preview.report, /and its sidecar: clip ABC-123\.srt -> ABC-123 clip\.srt/);
  const real = run('normalize', dir);
  assert.deepStrictEqual(names(dir), ['ABC-123 clip.ko.srt', 'ABC-123 clip.mp4', 'ABC-123 clip.srt', 'XYZ-999 other.srt', 'other XYZ-999.mp4', 'other XYZ-999.srt']);
  assert.strictEqual(real.result.renamed.length, 1);
  assert.match(real.report, /Skipped: other XYZ-999\.mp4 \(Not renamed because a subtitle or sidecar file would clash/);
});

test('a rename that only changes the case takes the sidecars along, and the report is true', () => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4', 'abc-123.srt', 'abc-123.ko.srt']);
  const real = run('normalize', dir, '--include-lowercase');
  assert.deepStrictEqual(names(dir), ['ABC-123.ko.srt', 'ABC-123.mp4', 'ABC-123.srt']);
  assert.strictEqual(real.result.renamed.length, 1);
});

test('rename to another extension does not rename the sidecars to themselves', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt']);
  const outcome = run('rename', path.join(dir, 'a.mp4'), 'a.mkv');
  assert.doesNotMatch(outcome.report, /a.srt/);
  assert.deepStrictEqual(names(dir), ['a.mkv', 'a.srt']);
});

test('--force replaces the video but never a sidecar name', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'b.mp4', 'b.srt']);
  assert.throws(() => run('rename', path.join(dir, 'a.mp4'), 'b.mp4', '--force'), /never overwritten/);
  assert.throws(() => run('mv', path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4'), '--force'), /never overwritten/);
  assert.deepStrictEqual(names(dir), ['a.mp4', 'a.srt', 'b.mp4', 'b.srt']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.srt'), 'utf8'), 'b.srt');
});

test('a transport-stream video with the same base name keeps the shared subtitle', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.ts', 'a.srt']);
  assert.deepStrictEqual(findSidecars(path.join(dir, 'a.mp4')), []);
});

test('product-number puts the number in front of the video and its subtitle', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/clip.mp4', 'ABC-123/clip.srt']);
  run('product-number', dir);
  assert.deepStrictEqual(names(path.join(dir, 'ABC-123')), ['ABC-123 clip.mp4', 'ABC-123 clip.srt']);
});

test('the journal lists the sidecar moves, so undo puts the whole group back', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt']);
  run('rename', path.join(dir, 'a.mp4'), 'b.mp4');
  assert.deepStrictEqual(names(dir), ['b.mp4', 'b.srt']);
  const outcome = run('undo');
  assert.deepStrictEqual(names(dir), ['a.mp4', 'a.srt']);
  assert.strictEqual(outcome.failure, undefined);
  assert.ok(journal.listJournals().length >= 2);
});

// The same callbacks the remove-* commands give: a candidate is { path, stamp }.
function planWithSidecars(dir, files) {
  const access = grant(dir, ['delete']);
  const stampOf = (file) => fileStamp(fs.lstatSync(file, { bigint: true }));
  const plan = planSafeRemovals(files.map((file) => ({ path: file, stamp: stampOf(file) })), access, {
    sidecars: true,
    isChanged: (item, real, stat) => fileStamp(stat) !== item.stamp,
    changedReason: 'CHANGED',
    toRemoval: (item, real, stat) => ({ path: real, size: Number(stat.size), stamp: item.stamp, reason: 'duplicate' }),
    entry: ({ candidate, removal }, reason) => ({ path: (removal ?? candidate).path, reason }),
  });
  // A command adds its target to the plan; runConfirmedRemoval needs it.
  return { ...plan, target: access.target };
}

test('removing a duplicate video also sends its subtitle to the Recycle Bin and lists it', () => {
  const dir = tempDir();
  make(dir, ['dup.mp4', 'dup.srt', 'dup.ko.srt', 'keep.mp4', 'keep.srt']);
  const plan = planWithSidecars(dir, [path.join(dir, 'dup.mp4')]);
  assert.deepStrictEqual(plan.removals.map((r) => path.basename(r.path)), ['dup.mp4']);
  assert.deepStrictEqual(plan.sidecars.map((r) => path.basename(r.path)), ['dup.ko.srt', 'dup.srt']);
  assert.match(plan.sidecars[0].reason, /Subtitle or sidecar file of dup\.mp4/);
  // The confirmation value must change with the sidecars: nothing is added when there are none.
  assert.strictEqual(sidecarDigest({ sidecars: [] }).length, 0);
  assert.strictEqual(sidecarDigest(plan).length, 1);
  const result = { removed: [], failed: [] };
  const log = (p) => ({ path: p.path, reason: 'duplicate' });
  runConfirmedRemoval(plan, result, 'test', plan.removals.map(log), {});
  assert.deepStrictEqual(names(dir), ['keep.mp4', 'keep.srt']);
  assert.deepStrictEqual(result.removedSidecars.map((r) => path.basename(r.path)), ['dup.ko.srt', 'dup.srt']);
  const written = readRecord(result.log);
  assert.deepStrictEqual(written.items.map((i) => [path.basename(i.path), i.outcome]), [['dup.mp4', 'removed'], ['dup.ko.srt', 'removed'], ['dup.srt', 'removed']]);
});

test('when the video could not be sent to the Recycle Bin, its sidecars stay', () => {
  const dir = tempDir();
  make(dir, ['dup.mp4', 'dup.srt']);
  const plan = planWithSidecars(dir, [path.join(dir, 'dup.mp4')]);
  // The video changes after it was judged, so it is not deleted.
  fs.appendFileSync(path.join(dir, 'dup.mp4'), 'more');
  const result = { removed: [], failed: [] };
  runConfirmedRemoval(plan, result, 'test', plan.removals.map((p) => ({ path: p.path, reason: 'duplicate' })), {});
  assert.deepStrictEqual(names(dir), ['dup.mp4', 'dup.srt']);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.sidecarKept[0].reason, /video was not sent/);
  const written = readRecord(result.log);
  assert.deepStrictEqual(written.items.map((i) => i.outcome), ['failed', 'failed']);
});

test('a subtitle that changed just now is kept with a reason, and the video still goes', () => {
  const dir = tempDir();
  make(dir, ['dup.mp4', 'dup.srt']);
  fs.utimesSync(path.join(dir, 'dup.srt'), new Date(Date.now()), new Date(Date.now()));
  const plan = planWithSidecars(dir, [path.join(dir, 'dup.mp4')]);
  assert.strictEqual(plan.removals.length, 1);
  assert.deepStrictEqual(plan.sidecars, []);
  assert.match(plan.sidecarKept[0].reason, /changed just now/);
});

test('the sidecar lines of rename and mv use the same path style as the video line (#428)', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'out/placeholder.txt', 'x.mp4', 'x.srt']);
  const before = process.cwd();
  process.chdir(dir);
  try {
    const rename = run('rename', 'a.mp4', 'b.mp4', '--dry-run').report.split('\n');
    assert.deepStrictEqual(rename, ['[Preview] Rename: a.mp4 -> b.mp4', '[Preview] Rename: a.srt -> b.srt (sidecar)']);
    const move = run('mv', 'x.mp4', 'out', '--dry-run').report.split('\n');
    assert.deepStrictEqual(move, [`[Preview] Move: x.mp4 -> ${path.join('out', 'x.mp4')}`, `[Preview] Move: x.srt -> ${path.join('out', 'x.srt')}`]);
  } finally {
    process.chdir(before);
  }
  // A video given as an absolute path keeps absolute sidecar lines.
  const absolute = run('rename', path.join(dir, 'a.mp4'), 'b.mp4', '--dry-run').report.split('\n');
  assert.strictEqual(absolute[1], `[Preview] Rename: ${path.join(dir, 'a.srt')} -> ${path.join(dir, 'b.srt')} (sidecar)`);
});
