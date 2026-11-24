'use strict';

// find-same-content and remove-same-content (#394): grouping by size then SHA-256, the keep rule, and the shared remove flow.
// The Recycle Bin is faked (same approach as removeBroken.test.js), so a real run never touches the real Recycle Bin.

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temp folder is under the user's AppData, a protected path, so the user folder is swapped with a path that does not exist.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const realExecFileSync = childProcess.execFileSync;
const recycled = [];
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) return 'NTFS\r\n';
  const state = volumeStateAnswer(options?.env, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  if (options?.env?.FC_RECYCLE_FILES !== undefined) {
    const lines = [];
    for (const line of options.input.split('\n').filter(Boolean)) {
      const [encoded] = line.split(' ');
      const target = Buffer.from(encoded, 'base64').toString('utf16le');
      recycled.push(target);
      fs.rmSync(target);
      lines.push(`ok ${encoded} `);
    }
    return lines.join('\r\n') + '\r\n';
  }
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET, { recursive: true, force: true });
  return Buffer.alloc(0);
});

// Files made just now are protected from removal, so the clock is moved forward 1 hour.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
test.mock.method(Date, 'now', () => realNow() + HOUR);

const { findSameContent, formatSameContent, removeSameContent, formatRemoveSameContent, chooseKeeper } = require('../src/sameContent');
const { run } = require('../bin/fctl');
const { REMOVAL_LOG } = require('../src/removalLog');

const OLD = new Date(realNow() - HOUR);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-same-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files, when = OLD) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, when, when);
  }
}

const rel = (dir, file) => path.relative(dir, file).split(path.sep).join('/');
const relGroups = (dir, result) => result.groups.map((group) => group.files.map((file) => rel(dir, file.path)).sort());
const notLog = (name) => !REMOVAL_LOG.test(name);

test.beforeEach(() => {
  recycled.length = 0;
});

test('two files with the same bytes and different names are grouped; same size with different bytes are not', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'copy of a.bin': 'AAAA', 'sub/other.txt': 'AAAA', 'b.bin': 'BBBB', 'long.bin': 'ABCDEF' });
  const result = findSameContent(dir);
  assert.deepStrictEqual(relGroups(dir, result), [['a.bin', 'copy of a.bin', 'sub/other.txt']]);
  assert.strictEqual(result.copies, 2);
  assert.strictEqual(result.reclaimable, 8);
  assert.strictEqual(result.checked, 5);
  assert.strictEqual(result.hashed, 4, 'only files that share a size with another file are hashed');
  assert.strictEqual(result.groups[0].hash.length, 64);
});

test('empty files are not compared, and several groups are found across file types', () => {
  const dir = tempDir();
  make(dir, { 'e1.txt': '', 'e2.dat': '', 'p1.jpg': Buffer.from([1, 2, 3, 4, 5]), 'p2.png': Buffer.from([1, 2, 3, 4, 5]), 'd1.docx': 'doc doc', 'd2.pdf': 'doc doc' });
  const result = findSameContent(dir);
  assert.deepStrictEqual(relGroups(dir, result), [['d1.docx', 'd2.pdf'], ['p1.jpg', 'p2.png']]);
});

test('the file to keep is the shortest path, then the oldest, then the first by name', () => {
  const dir = tempDir();
  make(dir, { 'deep/folder/x.bin': 'same', 'y.bin': 'same' });
  let result = findSameContent(dir);
  assert.strictEqual(rel(dir, result.groups[0].keep.path), 'y.bin');
  assert.strictEqual(result.groups[0].keepReason, 'shortest path');
  make(dir, { 'b.bin': 'tie' }, OLD);
  make(dir, { 'a.bin': 'tie' }, new Date(OLD.getTime() - HOUR));
  result = findSameContent(dir);
  const tie = result.groups.find((group) => group.files.some((file) => file.relative === 'a.bin'));
  assert.strictEqual(tie.keep.relative, 'a.bin');
  assert.strictEqual(tie.keepReason, 'oldest of the equally short paths');
  const same = chooseKeeper([{ relative: 'b', mtimeMs: 1 }, { relative: 'a', mtimeMs: 1 }]);
  assert.strictEqual(same.keep.relative, 'a');
  assert.match(same.reason, /first by name/);
});

test('find-same-content lists the groups with the keep rule, changes nothing and reports progress', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'sub/a2.bin': 'AAAA' });
  const lines = [];
  const output = run(['find-same-content', '--', dir]);
  const result = findSameContent(dir, { onProgress: (line) => lines.push(line) });
  assert.match(formatSameContent(result), /Group 1 \(2 files, 4B each, sha256 [0-9a-f]{12}\):\n {2}File to keep: a\.bin \[shortest path\]\n {2}Same content: sub[\\/]a2\.bin/);
  assert.match(output, /Groups 1, extra copies 1 \(up to 4B\), checked 2 files, skipped 0/);
  assert.match(output, /Nothing was changed/);
  assert.deepStrictEqual(lines, ['Hashing 2 files that share a size with another file...']);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.bin', 'sub']);
});

test('a file that changes while it is read is skipped, not grouped', (t) => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'b.bin': 'AAAA', 'c.bin': 'AAAA' });
  const realRead = fs.readSync;
  let touched = false;
  t.mock.method(fs, 'readSync', (fd, ...rest) => {
    const n = realRead(fd, ...rest);
    if (!touched && n > 0) {
      touched = true;
      fs.appendFileSync(path.join(dir, 'b.bin'), 'x');
    }
    return n;
  });
  const result = findSameContent(dir);
  assert.ok(result.skipped.length >= 1);
  assert.ok(result.groups.every((group) => group.files.length >= 2));
});

test('skip rules: a repository is refused, a program folder is not compared', () => {
  const dir = tempDir();
  make(dir, { 'node_modules/x/a.js': 'same', 'node_modules/y/b.js': 'same', 'a.txt': 'same' });
  const result = findSameContent(dir);
  assert.strictEqual(result.groups.length, 0);
  assert.strictEqual(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /folder a program uses/);
  const repo = tempDir();
  make(repo, { '.git/HEAD': 'ref', 'a.txt': 'same', 'b.txt': 'same' });
  assert.throws(() => findSameContent(repo), /repository/);
});

test('without a confirmation value, remove-same-content lists and changes nothing; --dry-run too', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'sub/a2.bin': 'AAAA' });
  const result = removeSameContent(dir);
  assert.strictEqual(result.confirmed, false);
  assert.strictEqual(result.removals.length, 1);
  assert.match(formatRemoveSameContent(result), /File to keep: a\.bin \[shortest path\]\n {2}To delete: sub[\\/]a2\.bin[\s\S]*--yes=[0-9a-f]{12}/);
  const dry = removeSameContent(dir, { confirm: result.code, dryRun: true });
  assert.strictEqual(dry.confirmed, false);
  assert.match(formatRemoveSameContent(dry), /without --dry-run and with --yes=/);
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(fs.readdirSync(dir).filter((name) => !notLog(name)).length, 0);
});

test('remove-same-content --yes=VALUE keeps one file per group and logs the rest', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'copy.bin': 'AAAA', 'sub/c.bin': 'AAAA', 'p.jpg': 'PPPPPP', 'q/p2.jpg': 'PPPPPP', 'solo.txt': 'unique' });
  const output = run(['remove-same-content', '--', dir]);
  const code = /--yes=([0-9a-f]+)/.exec(output)[1];
  const final = run(['remove-same-content', `--yes=${code}`, '--', dir]);
  assert.deepStrictEqual(recycled.map((file) => rel(dir, file)).sort(), ['copy.bin', 'q/p2.jpg', 'sub/c.bin']);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(notLog).sort(), ['a.bin', 'p.jpg', 'q', 'solo.txt', 'sub']);
  assert.match(final, /Groups 2, Recycle Bin 3, failed 0/);
  const [name] = fs.readdirSync(dir).filter((entry) => !notLog(entry));
  const log = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  assert.strictEqual(log.kind, 'files with the same content');
  assert.deepStrictEqual(log.items.map((item) => rel(dir, item.path)).sort(), ['copy.bin', 'q/p2.jpg', 'sub/c.bin']);
  assert.ok(log.items.every((item) => item.outcome === 'removed' && item.details.sha256.length === 64 && item.details.keep));
});

test('a wrong confirmation value deletes nothing, and a changed list changes the value', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'b.bin': 'AAAA' });
  const wrong = removeSameContent(dir, { confirm: '000000000000' });
  assert.strictEqual(wrong.mismatch, true);
  assert.match(formatRemoveSameContent(wrong), /nothing was deleted/);
  assert.deepStrictEqual(recycled, []);
  const before = removeSameContent(dir).code;
  make(dir, { 'c.bin': 'AAAA' });
  assert.notStrictEqual(removeSameContent(dir).code, before);
});

test('a stale confirmation value does not delete after the file to keep was rewritten', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'b.bin': 'AAAA' });
  const stale = removeSameContent(dir);
  make(dir, { 'a.bin': 'ZZZZ' });
  const result = removeSameContent(dir, { confirm: stale.code });
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.bin'), 'utf8'), 'AAAA');
});

test('a file that changed within the last 5 minutes is not deleted', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA' });
  make(dir, { 'z/zzzz.bin': 'AAAA' }, new Date(realNow() + HOUR));
  const result = removeSameContent(dir);
  assert.strictEqual(result.removals.length, 0);
  assert.match(result.kept[0].reason, /future|just now/);
});

test('hard links to the file to keep are kept, because deleting them frees no space', (t) => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'sub/copy.bin': 'AAAA' });
  try {
    fs.linkSync(path.join(dir, 'a.bin'), path.join(dir, 'link.bin'));
  } catch {
    t.skip('hard links cannot be made here');
    return;
  }
  const result = removeSameContent(dir);
  assert.deepStrictEqual(result.removals.map((item) => rel(dir, item.path)), ['sub/copy.bin']);
  assert.ok(result.kept.some((item) => rel(dir, item.path) === 'link.bin' && /hard link/.test(item.reason)));
});

test('if the file to keep changes after the list is confirmed, its copies are not deleted', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'sub/b.bin': 'AAAA' });
  const code = removeSameContent(dir).code;
  // The first progress line comes after the removal log is written and before any copy is checked, so the keeper changes in that window.
  const result = removeSameContent(dir, {
    confirm: code,
    onProgress: (line) => {
      if (/^Sending to the Recycle Bin/.test(line)) make(dir, { 'a.bin': 'ZZZZZZ' });
    },
  });
  assert.strictEqual(result.confirmed, true);
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(result.removed.length, 0);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /file to keep changed/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'sub/b.bin'), 'utf8'), 'AAAA');
  assert.match(formatRemoveSameContent(result), /Failed: sub[\\/]b\.bin/);
});

test('a copy that changed after it was hashed is skipped from the group', (t) => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'b.bin': 'AAAA' });
  const realRead = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, ...rest) => {
    const n = realRead(fd, ...rest);
    if (n > 0 && rest[0].subarray(0, n).toString() === 'AAAA') make(dir, { 'b.bin': 'AAAA' }, new Date(OLD.getTime() + 1000));
    return n;
  });
  const result = findSameContent(dir);
  assert.ok(result.skipped.some((item) => /changed while it was read/.test(item.reason)));
  assert.ok(result.groups.every((group) => group.files.length >= 2));
});

test('progress is passed on every 100 hashed files, and a failing progress display does not stop the search', () => {
  const dir = tempDir();
  const files = {};
  for (let i = 0; i < 120; i += 1) files[`f${i}.bin`] = 'same';
  make(dir, files);
  const lines = [];
  const result = findSameContent(dir, { onProgress: (line) => lines.push(line) });
  assert.strictEqual(result.groups[0].files.length, 120);
  assert.deepStrictEqual(lines, ['Hashing 120 files that share a size with another file...', 'Hashed 100 of 120 files so far...']);
  assert.strictEqual(findSameContent(dir, { onProgress: () => { throw new Error('display broke'); } }).groups.length, 1);
});

test('options of other commands are refused, and --yes is listed for the new command', () => {
  const dir = tempDir();
  assert.throws(() => run(['find-same-content', '--yes=abc', '--', dir]), /--yes can be used only with remove-broken, remove-duplicates, remove-low-quality, remove-same-content\./);
  assert.throws(() => run(['find-same-content', '--force', '--', dir]), /never overwrites/);
  assert.throws(() => run(['remove-same-content', dir, 'extra']), /Only one target/);
  assert.throws(() => run(['remove-same-content', '--yes', '--', dir]), /Give --yes the confirmation value/);
  assert.match(run(['--help']), /^ {2}find-same-content <target>/m);
  assert.match(run(['--help']), /^ {2}remove-same-content <target>/m);
});
