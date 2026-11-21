'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// The volume probes answer a fixed disk with a Recycle Bin by default, and each test swaps them.
const realExecFileSync = childProcess.execFileSync;
let volume = () => 'True|Fixed\r\n';
let format = () => 'NTFS\r\n';
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) return format();
  const state = volumeStateAnswer(options?.env, () => volume());
  if (state !== undefined) return state;
  return realExecFileSync(file, args, options);
});

const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
test.mock.method(Date, 'now', () => realNow() + HOUR);

const { planSafeRemovals, holdReason, RECENT_MS, MAX_RECYCLE_SIZE } = require('../src/removal');
const { MAX_RECYCLE_PATH } = require('../src/commands');
const { grant, fileStamp } = require('../src/target');

const OLD = new Date(realNow() - HOUR);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-removal-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, name, content = 'x'.repeat(100)) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  fs.utimesSync(full, OLD, OLD);
  return full;
}

const stampOf = (file) => fileStamp(fs.lstatSync(file, { bigint: true }));

// The same callbacks a command gives: a candidate is { path, stamp }.
function plan(dir, candidates, extra = {}) {
  const access = grant(dir, ['delete']);
  return planSafeRemovals(candidates, access, {
    isChanged: (item, real, stat) => fileStamp(stat) !== item.stamp,
    changedReason: 'CHANGED',
    toRemoval: (item, real, stat) => ({ path: real, size: Number(stat.size), stamp: item.stamp }),
    entry: ({ candidate, removal }, reason) => ({ path: (removal ?? candidate).path, reason }),
    ...extra,
  });
}

const candidate = (file) => ({ path: file, stamp: stampOf(file) });
const keptReasons = (result) => result.kept.map((item) => item.reason);

function hardLink(t, dir) {
  const first = make(dir, 'a.bin');
  const second = path.join(dir, 'b.bin');
  try {
    fs.linkSync(first, second);
  } catch {
    t.skip('hard links are not available');
    return null;
  }
  return [first, second];
}

test('a plain old file goes to removals and the session state is read (#308)', () => {
  const dir = tempDir();
  const file = make(dir, 'a.bin');
  const result = plan(dir, [candidate(file)]);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [file]);
  assert.deepStrictEqual(result.kept, []);
  assert.strictEqual(result.interactive, true);
});

test('with no candidates the volume is not checked and interactive stays null (#308)', () => {
  const dir = tempDir();
  assert.deepStrictEqual(plan(dir, []), { removals: [], kept: [], recent: [], interactive: null });
});

test('RECENT_MS is the 5-minute hold and holdReason keeps a file inside it (#308)', () => {
  assert.strictEqual(RECENT_MS, 5 * 60 * 1000);
  const now = Date.now();
  const stat = { mtimeMs: now - 1000, birthtimeMs: 0, ctimeMs: 0 };
  assert.match(holdReason(stat, now), /changed just now/);
  assert.match(holdReason({ ...stat, mtimeMs: now + 1000 }, now), /in the future/);
  assert.strictEqual(holdReason({ ...stat, mtimeMs: now - RECENT_MS - 1 }, now), null);
});

test('rule: a file changed after it was judged is kept with the changed reason (#308)', () => {
  const dir = tempDir();
  const file = make(dir, 'a.bin');
  const result = plan(dir, [{ path: file, stamp: 'other' }]);
  assert.deepStrictEqual(result.removals, []);
  assert.deepStrictEqual(keptReasons(result), ['CHANGED']);
});

test('rule: a file that changed within 5 minutes is kept (#308)', () => {
  const dir = tempDir();
  const file = make(dir, 'a.bin');
  const result = plan(dir, [candidate(file)], { now: realNow() + 30 * 1000 });
  assert.deepStrictEqual(result.removals, []);
  assert.match(keptReasons(result)[0], /changed just now and may still be downloading/);
});

test('rule: a file with a future time is kept (#308)', () => {
  const dir = tempDir();
  const file = make(dir, 'a.bin');
  const result = plan(dir, [candidate(file)], { now: Date.now() - 3 * HOUR });
  assert.match(keptReasons(result)[0], /in the future/);
});

test('rule: a download marker beside the file keeps it (#308)', () => {
  const dir = tempDir();
  const file = make(dir, 'a.mp4');
  make(dir, 'a.mp4.part');
  const result = plan(dir, [candidate(file)]);
  assert.deepStrictEqual(result.removals, []);
  assert.match(keptReasons(result)[0], /marker file \(a\.mp4\.part\)/);
});

test('rule: a path over the Recycle Bin limit is kept with the long-path message (#308)', (t) => {
  const dir = tempDir();
  const file = path.join(dir, `${'n'.repeat(Math.max(1, MAX_RECYCLE_PATH + 1 - dir.length - 5))}.bin`);
  try {
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, OLD, OLD);
  } catch {
    t.skip('this file system does not allow such a name');
    return;
  }
  assert.ok(file.length > MAX_RECYCLE_PATH);
  const result = plan(dir, [candidate(file)]);
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(keptReasons(result)[0], `Kept because the path is ${file.length} characters, over the ${MAX_RECYCLE_PATH} that can be sent to the Recycle Bin. Shorten the name or move it to a parent folder and run again.`);
});

test('rule: a command-specific extraKeep runs after the path check (#308)', () => {
  const dir = tempDir();
  const file = make(dir, 'a.bin');
  const result = plan(dir, [candidate(file)], { extraKeep: () => 'EXTRA' });
  assert.deepStrictEqual(keptReasons(result), ['EXTRA']);
});

test('rule: precheck keeps a candidate without looking at the file (#308)', () => {
  const dir = tempDir();
  const result = plan(dir, [{ path: path.join(dir, 'missing.bin'), stamp: 'x' }], { precheck: () => 'EARLY' });
  assert.deepStrictEqual(keptReasons(result), ['EARLY']);
});

test('rule: a file that cannot be checked is kept (#308)', () => {
  const dir = tempDir();
  const result = plan(dir, [{ path: path.join(dir, 'missing.bin'), stamp: 'x' }]);
  assert.strictEqual(result.kept.length, 1);
  assert.deepStrictEqual(result.removals, []);
});

test('rule: another name of a file already to be deleted is kept, once per run (#308)', (t) => {
  const dir = tempDir();
  const names = hardLink(t, dir);
  if (names === null) return;
  const [first, second] = names;
  const result = plan(dir, [candidate(first), candidate(second)]);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [first]);
  assert.strictEqual(result.kept.length, 1);
  assert.strictEqual(result.kept[0].path, second);
  assert.match(result.kept[0].reason, /another name of the same file \(hard link: a\.bin\) is deleted first/);
});

test('rule: a volume that is not a fixed disk keeps every file, including hard-link names (#308)', (t) => {
  const dir = tempDir();
  const names = hardLink(t, dir);
  if (names === null) return;
  volume = () => 'True|Removable\r\n';
  t.after(() => {
    volume = () => 'True|Fixed\r\n';
  });
  const result = plan(dir, names.map(candidate));
  assert.deepStrictEqual(result.removals, []);
  assert.deepStrictEqual(result.kept.map((item) => item.path).sort(), [...names].sort());
  for (const reason of keptReasons(result)) assert.match(reason, /not a fixed disk \(Removable\)/);
});

test('rule: a volume without a change time keeps the file (#308)', (t) => {
  const dir = tempDir();
  const file = make(dir, 'a.bin');
  format = () => 'exFAT\r\n';
  t.after(() => {
    format = () => 'NTFS\r\n';
  });
  const result = plan(dir, [candidate(file)]);
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(result.kept.length, 1);
});

test('rule: a file the Recycle Bin would delete permanently is kept, and so is its other name (#308)', (t) => {
  const dir = tempDir();
  const names = hardLink(t, dir);
  if (names === null) return;
  const result = plan(dir, names.map(candidate), { maxSize: 10 });
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(result.kept.length, 2);
  for (const reason of keptReasons(result)) assert.match(reason, /^Kept /);
});

test('MAX_RECYCLE_SIZE is the fallback limit when the Recycle Bin setting cannot be read (#308)', () => {
  assert.strictEqual(MAX_RECYCLE_SIZE, 1024 * 1024 * 1024);
});

test('the ladder order is changed, hold, marker, path, extra rule (#308)', () => {
  const dir = tempDir();
  const file = make(dir, 'a.mp4');
  make(dir, 'a.mp4.part');
  const both = plan(dir, [candidate(file)], { now: realNow() + 30 * 1000, extraKeep: () => 'EXTRA' });
  assert.match(keptReasons(both)[0], /changed just now/);
  const marker = plan(dir, [candidate(file)], { extraKeep: () => 'EXTRA' });
  assert.match(keptReasons(marker)[0], /marker file/);
  const changed = plan(dir, [{ path: file, stamp: 'other' }], { now: realNow() + 30 * 1000 });
  assert.deepStrictEqual(keptReasons(changed), ['CHANGED']);
});

test('rule: a candidate that is not a regular file is kept as changed (#308)', () => {
  const dir = tempDir();
  const sub = path.join(dir, 'folder.bin');
  fs.mkdirSync(sub);
  const result = plan(dir, [{ path: sub, stamp: 'x' }]);
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(result.kept.length, 1);
});
