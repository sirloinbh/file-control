'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const { FcError } = require('../src/commands');
const { kindFolder, monthFolder, planSortWith, sortBy, formatSort } = require('../src/sort');
const { run } = require('../bin/fctl');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sort-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const file of files) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file);
  }
}

const listAll = (dir) => fs.readdirSync(dir, { recursive: true }).map((p) => p.split(path.sep).join('/')).sort();

test('kindFolder maps extensions to kind folders, case-insensitively, and falls back to Other', () => {
  assert.strictEqual(kindFolder('a.MP4'), 'Videos');
  assert.strictEqual(kindFolder('a.jpg'), 'Images');
  assert.strictEqual(kindFolder('a.pdf'), 'Documents');
  assert.strictEqual(kindFolder('a.zip'), 'Archives');
  assert.strictEqual(kindFolder('a.flac'), 'Audio');
  assert.strictEqual(kindFolder('setup.exe'), 'Installers');
  assert.strictEqual(kindFolder('a.xyz'), 'Other');
  assert.strictEqual(kindFolder('noext'), 'Other');
});

test('monthFolder is YYYY-MM in local time', () => {
  assert.strictEqual(monthFolder(new Date(2026, 10, 5)), '2026-11');
  assert.strictEqual(monthFolder(new Date(2026, 0, 31, 23, 59)), '2026-01');
});

test('sort-by kind --dry-run prints the plan and changes nothing', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'b.pdf', 'c.zip', 'd.xyz']);
  const before = listAll(dir);
  const out = run(['sort-by', dir, '--by=kind', '--dry-run']);
  assert.deepStrictEqual(listAll(dir), before);
  assert.match(out, /\[Preview\] Move: a\.mp4 -> Videos/);
  assert.match(out, /Move: d\.xyz -> Other/);
});

test('sort-by kind moves the files and reports what went where', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'b.pdf', 'sub/keep.mp4']);
  const out = run(['sort-by', dir, '--by=kind']);
  assert.match(out, /Move: a\.mp4 -> Videos/);
  assert.deepStrictEqual(listAll(dir), ['Documents', 'Documents/b.pdf', 'Videos', 'Videos/a.mp4', 'sub', 'sub/keep.mp4']);
});

test('sort-by month uses the modified time', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt']);
  fs.utimesSync(path.join(dir, 'a.txt'), new Date(2025, 2, 10), new Date(2025, 2, 10));
  fs.utimesSync(path.join(dir, 'b.txt'), new Date(2026, 10, 3), new Date(2026, 10, 3));
  run(['sort-by', dir, '--by=month']);
  assert.deepStrictEqual(listAll(dir), ['2025-03', '2025-03/a.txt', '2026-11', '2026-11/b.txt']);
});

test('a name clash keeps the file in place and reports it, never overwriting', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'Videos/a.mp4']);
  fs.writeFileSync(path.join(dir, 'Videos', 'a.mp4'), 'original');
  const result = sortBy(dir, { by: 'kind' });
  assert.strictEqual(result.moved.length, 0);
  assert.strictEqual(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /already exists/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'Videos', 'a.mp4'), 'utf8'), 'original');
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});

test('two files of the same name in a recursive run: the second stays', () => {
  const dir = tempDir();
  make(dir, ['x/a.mp4', 'y/a.mp4']);
  const result = sortBy(dir, { by: 'kind', recursive: true });
  assert.strictEqual(result.moved.length, 1);
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(listAll(dir).filter((p) => p.endsWith('.mp4')).length, 2);
});

test('only files directly in the target by default; --recursive takes subfolders too', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'sub/b.mp4']);
  assert.strictEqual(sortBy(dir, { by: 'kind', dryRun: true }).moved.length, 1);
  assert.strictEqual(sortBy(dir, { by: 'kind', dryRun: true, recursive: true }).moved.length, 2);
  run(['sort-by', dir, '--by=kind', '--recursive']);
  assert.deepStrictEqual(listAll(dir), ['Videos', 'Videos/a.mp4', 'Videos/b.mp4', 'sub']);
});

test('a second run changes nothing (files already in their folder stay)', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'b.pdf']);
  sortBy(dir, { by: 'kind', recursive: true });
  const again = sortBy(dir, { by: 'kind', recursive: true });
  assert.strictEqual(again.moved.length, 0);
  assert.strictEqual(again.stay, 2);
});

test('unfinished downloads, leftovers and folder metadata are not moved', () => {
  const dir = tempDir();
  make(dir, ['a.crdownload', 'b.part', '.fctl-old-1-2-3', 'desktop.ini', 'c.mp4']);
  const result = sortBy(dir, { by: 'kind' });
  assert.deepStrictEqual(result.moved.map((m) => m.name), ['c.mp4']);
  assert.strictEqual(result.skipped.length, 3);
  assert.ok(fs.existsSync(path.join(dir, 'desktop.ini')));
});

test('a link is left in place', () => {
  const dir = tempDir();
  make(dir, ['real.mp4']);
  try {
    fs.symlinkSync(path.join(dir, 'real.mp4'), path.join(dir, 'link.mp4'));
  } catch (err) {
    // Creating a symbolic link needs a privilege on Windows.
    if (err.code === 'EPERM') return;
    throw err;
  }
  const result = sortBy(dir, { by: 'kind' });
  assert.ok(result.skipped.some((s) => /link/.test(s.reason)));
  assert.ok(fs.lstatSync(path.join(dir, 'link.mp4')).isSymbolicLink());
});

test('a project folder is refused', () => {
  const dir = tempDir();
  make(dir, ['package.json', 'a.mp4']);
  assert.throws(() => sortBy(dir, { by: 'kind' }), /project folder/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});

test('--by is required and must be kind or month', () => {
  const dir = tempDir();
  assert.throws(() => run(['sort-by', dir]), /--by=kind or --by=month/);
  assert.throws(() => run(['sort-by', dir, '--by=size']), /--by=kind or --by=month/);
  assert.throws(() => run(['sort-by', dir, '--by']), /Attach a value/);
});

test('--by and --recursive are refused on other commands', () => {
  const dir = tempDir();
  assert.throws(() => run(['flatten', dir, '--by=kind']), /--by can be used only with sort-by/);
  assert.throws(() => run(['flatten', dir, '--recursive']), /--recursive can be used only with sort-by and sort-docs/);
  assert.throws(() => run(['sort-by', dir, '--by=kind', '--force']), FcError);
});

test('planSortWith takes any rule: a nested folder and a stay decision', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt']);
  const plan = planSortWith(dir, (file) => (file.name === 'a.txt' ? { folder: '2026/2026-11' } : { stay: 'no date' }));
  assert.strictEqual(plan.moves.length, 1);
  assert.strictEqual(plan.moves[0].to, path.join(dir, '2026', '2026-11', 'a.txt'));
  assert.deepStrictEqual(plan.skipped.map((s) => s.reason), ['no date']);
});

test('--recursive leaves nested project and program folders whole', () => {
  const dir = tempDir();
  make(dir, ['proj/package.json', 'proj/logo.png', 'sub/node_modules/x/a.png', 'sub/ok.png']);
  const result = sortBy(dir, { by: 'kind', recursive: true });
  assert.deepStrictEqual(result.moved.map((m) => m.name), ['ok.png']);
  assert.strictEqual(result.skipped.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'proj', 'logo.png')));
  assert.ok(fs.existsSync(path.join(dir, 'sub', 'node_modules', 'x', 'a.png')));
});

test('a file already below its destination folder stays (no flattening on a second run)', () => {
  const dir = tempDir();
  make(dir, ['Videos/2020/a.mp4', 'Videos/b.mp4']);
  const result = sortBy(dir, { by: 'kind', recursive: true });
  assert.strictEqual(result.moved.length, 0);
  assert.strictEqual(result.stay, 2);
});

test('a file named like a destination folder is reported once and nothing is lost', () => {
  const dir = tempDir();
  make(dir, ['Videos', 'clip.mp4', 'doc.pdf']);
  const result = sortBy(dir, { by: 'kind' });
  // The file called Videos is itself an Other file, so it moves to Other/ and frees the name for the next run.
  assert.deepStrictEqual(result.moved.map((m) => m.name), ['doc.pdf', 'Videos']);
  assert.strictEqual(result.skipped.length, 1);
  assert.ok(result.skipped.some((s) => /Videos exists and is a file/.test(s.reason)));
  assert.ok(fs.existsSync(path.join(dir, 'clip.mp4')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'Other', 'Videos'), 'utf8'), 'Videos');
});

test('a move that would make a path that is too long is skipped', () => {
  const dir = tempDir();
  make(dir, [`${'n'.repeat(240)}.mp4`]);
  const result = sortBy(dir, { by: 'kind', dryRun: true });
  assert.strictEqual(result.moved.length, 0);
  assert.match(result.skipped[0].reason, /too long/);
});

test('a rule that returns a path outside the target is refused', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  const plan = planSortWith(dir, () => ({ folder: '../out' }));
  assert.strictEqual(plan.moves.length, 0);
  assert.strictEqual(plan.skipped.length, 1);
});

test('.ts files are not videos', () => {
  assert.strictEqual(kindFolder('app.ts'), 'Other');
  assert.strictEqual(kindFolder('clip.m2ts'), 'Videos');
});
