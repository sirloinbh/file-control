'use strict';

// find (#393): conditions by size, age, extension and name; sorting; the total; protected targets; CLI options.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temp folder is under the user's AppData, a protected path, so the user folder is swapped with a path that does not exist.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const { globMatches, findFiles, formatFind, findCriteria, parseSize, parseAge } = require('../src/find');
const { execute } = require('../src/execute');
const { run } = require('../bin/fctl');
const { misplacedFlagMessage } = require('../src/commandTable');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-find-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel, bytes, ageDays) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    const when = new Date(NOW - ageDays * DAY);
    fs.utimesSync(file, when, when);
  };
  put('a.txt', 2048, 10);
  put('b.TXT', 500, 400);
  put('sub/c.mp4', 3 * 1024 * 1024, 200);
  put('sub/deep/d.mkv', 5 * 1024 * 1024, 5);
  put('sub/e.part', 10, 1);
  return dir;
}

const names = (result) => result.files.map((file) => file.relative.split(path.sep).join('/'));

test('parseSize and parseAge accept the documented units and refuse the rest', () => {
  assert.strictEqual(parseSize('1KB', 'larger'), 1024);
  assert.strictEqual(parseSize('1.5mb', 'larger'), 1.5 * 1024 * 1024);
  assert.strictEqual(parseSize('2048', 'larger'), 2048);
  assert.strictEqual(parseAge('2w', 'older'), 14 * DAY);
  assert.strictEqual(parseAge('6M', 'older'), 180 * DAY);
  for (const bad of ['', 'abc', '-1MB', '1PB', '1 GB x']) assert.throws(() => parseSize(bad, 'larger'), /--larger needs a size/, bad);
  for (const bad of ['', '30', 'd', '1y', '-3d']) assert.throws(() => parseAge(bad, 'older'), /--older needs an age/, bad);
});

test('find <folder> --larger=1KB --ext=txt prints only matching files and a total', (t) => {
  const dir = tree(t);
  const result = findFiles(dir, { larger: '1KB', ext: 'txt' }, { now: NOW });
  assert.deepStrictEqual(names(result), ['a.txt']);
  assert.strictEqual(result.total, 2048);
  assert.strictEqual(result.checked, 5);
  const report = formatFind(result);
  assert.match(report, /2\.0KB .* a\.txt/);
  assert.match(report, /1 file found out of 5 files checked, 2\.0KB in total\./);
});

test('extension matching ignores case and a leading dot, and takes a list', (t) => {
  const dir = tree(t);
  assert.deepStrictEqual(names(findFiles(dir, { ext: '.TXT' }, { now: NOW })), ['a.txt', 'b.TXT']);
  assert.deepStrictEqual(names(findFiles(dir, { ext: 'mp4, mkv' }, { now: NOW })), ['sub/c.mp4', 'sub/deep/d.mkv']);
  assert.throws(() => findCriteria({ ext: ' , ' }), /--ext needs/);
});

test('--older and --newer compare the modified time with the age', (t) => {
  const dir = tree(t);
  assert.deepStrictEqual(names(findFiles(dir, { older: '180d' }, { now: NOW })), ['b.TXT', 'sub/c.mp4']);
  assert.deepStrictEqual(names(findFiles(dir, { newer: '7d' }, { now: NOW })), ['sub/deep/d.mkv', 'sub/e.part']);
  assert.deepStrictEqual(names(findFiles(dir, { older: '1w', newer: '300d' }, { now: NOW })), ['a.txt', 'sub/c.mp4']);
});

test('--larger and --smaller are exclusive bounds, and --name is a case-insensitive glob on the file name', (t) => {
  const dir = tree(t);
  assert.deepStrictEqual(names(findFiles(dir, { larger: '500' }, { now: NOW })).includes('b.TXT'), false);
  assert.deepStrictEqual(names(findFiles(dir, { smaller: '1KB' }, { now: NOW })), ['b.TXT', 'sub/e.part']);
  assert.deepStrictEqual(names(findFiles(dir, { name: '*.PART' }, { now: NOW })), ['sub/e.part']);
  assert.deepStrictEqual(names(findFiles(dir, { name: '?.txt' }, { now: NOW })), ['a.txt', 'b.TXT']);
  assert.deepStrictEqual(names(findFiles(dir, { name: 'sub' }, { now: NOW })), []);
  assert.deepStrictEqual(names(findFiles(dir, { name: 'a.t+t' }, { now: NOW })), []);
  assert.throws(() => findCriteria({ name: '' }), /--name needs a pattern/);
});

test('--sort=size lists the largest first and --sort=date the newest first', (t) => {
  const dir = tree(t);
  assert.deepStrictEqual(names(findFiles(dir, { sort: 'size' }, { now: NOW })), ['sub/deep/d.mkv', 'sub/c.mp4', 'a.txt', 'b.TXT', 'sub/e.part']);
  assert.deepStrictEqual(names(findFiles(dir, { sort: 'date' }, { now: NOW })), ['sub/e.part', 'sub/deep/d.mkv', 'a.txt', 'sub/c.mp4', 'b.TXT']);
  assert.throws(() => findCriteria({ sort: 'name' }), /--sort must be one of size, date/);
});

test('conditions that cannot match together are refused', () => {
  assert.throws(() => findCriteria({ larger: '2MB', smaller: '1MB' }), /--larger must be less than --smaller/);
  assert.throws(() => findCriteria({ older: '2d', newer: '1d' }), /--newer must be a longer age than --older/);
});

test('links are not listed and not followed', (t) => {
  const dir = tree(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-find-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  try {
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
  } catch {
    return;
  }
  assert.ok(!names(findFiles(dir, {}, { now: NOW })).some((name) => name.includes('secret')));
});

test('protected paths are not walked', () => {
  const root = path.parse(os.tmpdir()).root;
  assert.throws(() => findFiles(root, {}), /protected path/);
  assert.throws(() => execute(['find', '--', root]), /protected path/);
  assert.throws(() => findFiles(path.join(os.homedir(), '.ssh'), {}), /does not exist|protected path/);
});

test('the CLI runs find with its options and refuses them on other commands', (t) => {
  const dir = tree(t);
  const report = run(['find', `--larger=1KB`, '--ext=txt', '--sort=size', '--', dir]);
  assert.match(report, /a\.txt/);
  assert.doesNotMatch(report, /b\.TXT/);
  assert.match(report, /1 file found/);
  assert.throws(() => run(['find', '--larger', dir]), /Attach a value to --larger/);
  assert.throws(() => run(['find', '--larger=big', '--', dir]), /--larger needs a size/);
  assert.throws(() => run(['find', '--force', '--', dir]), /never overwrites/);
  assert.throws(() => run(['find', dir, 'extra']), /Only one target/);
  assert.throws(() => run(['ls', '--ext=txt', dir]), /--ext can be used only with find\./);
  assert.match(misplacedFlagMessage('flatten', new Set(['larger'])), /only with find/);
  assert.strictEqual(misplacedFlagMessage('find', new Set(['larger', 'sort'])), undefined);
  assert.match(run(['--help']), /--larger=SIZE/);
  assert.match(run(['--help']), /^ {2}find <target>/m);
});

test('find does not touch files, with or without --dry-run', (t) => {
  const dir = tree(t);
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  execute(['find', '--dry-run', '--', dir]);
  execute(['find', '--', dir]);
  assert.deepStrictEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
});

test('a glob with many stars finishes fast and still matches correctly', () => {
  const started = Date.now();
  assert.strictEqual(globMatches('*a*a*a*a*a*a*a*a*b', 'a'.repeat(200)), false);
  assert.strictEqual(globMatches('*a*a*a*a*a*a*a*a*b', `${'a'.repeat(200)}b`), true);
  assert.ok(Date.now() - started < 1000);
  assert.strictEqual(globMatches('a*', 'ABC'), true);
  assert.strictEqual(globMatches('*.p?rt', 'x.PART'), true);
  assert.strictEqual(globMatches('a?c', 'ac'), false);
  assert.strictEqual(globMatches('**', ''), true);
  assert.strictEqual(globMatches('a[b]', 'a[b]'), true);
});
