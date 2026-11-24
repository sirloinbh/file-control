'use strict';

// du (#395): folder sizes and file counts, largest first, with a total; --depth and --top; unreadable folders; protected targets; CLI options.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temp folder is under the user's AppData, a protected path, so the user folder is swapped with a path that does not exist.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const { folderSizes, formatDu } = require('../src/du');
const { execute } = require('../src/execute');
const { run } = require('../bin/fctl');
const { misplacedFlagMessage } = require('../src/commandTable');

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-du-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel, bytes) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  };
  put('top.txt', 100);
  put('small/a.txt', 1000);
  put('big/b.bin', 3000);
  put('big/inner/c.bin', 5000);
  put('big/inner/deep/d.bin', 2000);
  put('mid/e.bin', 4000);
  fs.mkdirSync(path.join(dir, 'empty'));
  return dir;
}

const rows = (result) => result.folders.map((f) => [f.relative.split(path.sep).join('/'), f.size, f.files]);

test('du <folder> lists subfolders in size order with a total', (t) => {
  const dir = tree(t);
  const result = folderSizes(dir);
  assert.deepStrictEqual(rows(result), [['big', 10000, 3], ['mid', 4000, 1], ['small', 1000, 1], ['empty', 0, 0]]);
  assert.strictEqual(result.total, 15100);
  assert.strictEqual(result.files, 6);
  assert.deepStrictEqual(result.own, { size: 100, files: 1 });
  const report = formatDu(result);
  assert.match(report, /9\.8KB +3 files +big$/m);
  assert.match(report, /1000B +1 file +small$/m);
  assert.match(report, /100B +1 file +\(files directly in the target\)$/m);
  assert.match(report, /^Total: 14\.7KB in 6 files\.$/m);
  assert.ok(report.indexOf('big') < report.indexOf('mid'));
});

test('--depth also lists deeper folders, and --top keeps only the largest', (t) => {
  const dir = tree(t);
  assert.deepStrictEqual(rows(folderSizes(dir, { depth: '2' })).slice(0, 3), [['big', 10000, 3], ['big/inner', 7000, 2], ['mid', 4000, 1]]);
  assert.deepStrictEqual(rows(folderSizes(dir, { depth: '3' })).map((r) => r[0]), ['big', 'big/inner', 'mid', 'big/inner/deep', 'small', 'empty']);
  const top = folderSizes(dir, { top: '2' });
  assert.deepStrictEqual(rows(top), [['big', 10000, 3], ['mid', 4000, 1]]);
  assert.strictEqual(top.hidden, 2);
  assert.match(formatDu(top), /2 more folders not shown; raise --top/);
  assert.strictEqual(top.total, 15100);
});

test('bad --depth and --top values are refused', (t) => {
  const dir = tree(t);
  for (const bad of ['0', '-1', 'x', '1.5', '', '99999999']) {
    assert.throws(() => folderSizes(dir, { depth: bad }), /--depth needs a whole number/, bad);
    assert.throws(() => folderSizes(dir, { top: bad }), /--top needs a whole number/, bad);
  }
});

test('an unreadable folder is reported and the rest is still counted', (t) => {
  const dir = tree(t);
  const real = fs.readdirSync;
  const blocked = path.join(fs.realpathSync.native(dir), 'mid');
  t.mock.method(fs, 'readdirSync', (target, ...rest) => {
    if (String(target) === blocked) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return real(target, ...rest);
  });
  const result = folderSizes(dir);
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.skipped[0].relative, 'mid');
  assert.deepStrictEqual(rows(result)[0], ['big', 10000, 3]);
  assert.ok(!rows(result).some(([name]) => name === 'mid'), 'an unreadable folder is not listed as an empty one');
  assert.strictEqual(result.total, 11100);
  assert.match(formatDu(result), /Skipped: mid \([^)]*\)\nTotal: 10\.8KB in 5 files \(only what could be read\)\./);
});

test('links are not followed or counted', (t) => {
  const dir = tree(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-du-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.bin'), Buffer.alloc(9000));
  try {
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
  } catch {
    t.skip('links cannot be made here');
    return;
  }
  assert.strictEqual(folderSizes(dir).total, 15100);
});

test('protected paths are not walked', () => {
  const root = path.parse(os.tmpdir()).root;
  assert.throws(() => folderSizes(root), /protected path/);
  assert.throws(() => execute(['du', '--', root]), /protected path/);
});

test('the CLI runs du with its options and refuses them on other commands', (t) => {
  const dir = tree(t);
  const report = run(['du', '--depth=2', '--top=3', '--', dir]);
  assert.match(report, /big[\\/]inner/);
  assert.match(report, /Total: /);
  assert.throws(() => run(['du', '--depth', dir]), /Attach a value to --depth/);
  assert.throws(() => run(['du', '--top=0', '--', dir]), /--top needs a whole number/);
  assert.throws(() => run(['du', '--force', '--', dir]), /never overwrites/);
  assert.throws(() => run(['du', dir, 'extra']), /Only one target/);
  assert.throws(() => run(['ls', '--depth=2', dir]), /--depth can be used only with du\./);
  assert.match(misplacedFlagMessage('find', new Set(['top'])), /only with du/);
  assert.strictEqual(misplacedFlagMessage('du', new Set(['depth', 'top'])), undefined);
  assert.match(run(['--help']), /--depth=N/);
  assert.match(run(['--help']), /^ {2}du <target>/m);
});

test('du does not touch files, with or without --dry-run', (t) => {
  const dir = tree(t);
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  execute(['du', '--dry-run', '--', dir]);
  execute(['du', '--', dir]);
  assert.deepStrictEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
});
