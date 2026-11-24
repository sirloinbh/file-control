'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const { docFolder, sortDocs } = require('../src/sortDocs');
const { run } = require('../bin/fctl');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sortdocs-'));
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

test('docFolder maps document extensions to type folders and ignores the rest', () => {
  assert.strictEqual(docFolder('a.PDF'), 'PDF');
  assert.strictEqual(docFolder('a.docx'), 'Word');
  assert.strictEqual(docFolder('a.csv'), 'Excel');
  assert.strictEqual(docFolder('a.pptx'), 'Slides');
  assert.strictEqual(docFolder('a.hwpx'), 'HWP');
  assert.strictEqual(docFolder('a.md'), 'Text');
  assert.strictEqual(docFolder('a.epub'), 'Other documents');
  assert.strictEqual(docFolder('a.mp4'), undefined);
  assert.strictEqual(docFolder('noext'), undefined);
});

test('sort-docs --dry-run lists each document with its folder and changes nothing', () => {
  const dir = tempDir();
  make(dir, ['a.pdf', 'b.docx', 'c.xlsx', 'd.pptx', 'e.hwp', 'f.txt']);
  const before = listAll(dir);
  const out = run(['sort-docs', dir, '--dry-run']);
  assert.deepStrictEqual(listAll(dir), before);
  for (const [file, folder] of [['a.pdf', 'PDF'], ['b.docx', 'Word'], ['c.xlsx', 'Excel'], ['d.pptx', 'Slides'], ['e.hwp', 'HWP'], ['f.txt', 'Text']]) {
    assert.ok(out.includes(`[Preview] Move: ${file} -> ${path.join(folder, file)}`), file);
  }
});

test('non-document files are left in place and not listed', () => {
  const dir = tempDir();
  make(dir, ['a.pdf', 'movie.mp4', 'photo.jpg', 'setup.exe']);
  const out = run(['sort-docs', dir]);
  assert.deepStrictEqual(listAll(dir), ['PDF', 'PDF/a.pdf', 'movie.mp4', 'photo.jpg', 'setup.exe']);
  assert.ok(!out.includes('movie.mp4'));
  assert.match(out, /not concerned 3/);
});

test('--by=month adds a month folder inside each type folder', () => {
  const dir = tempDir();
  make(dir, ['a.pdf', 'b.pdf']);
  fs.utimesSync(path.join(dir, 'a.pdf'), new Date(2025, 2, 10), new Date(2025, 2, 10));
  fs.utimesSync(path.join(dir, 'b.pdf'), new Date(2026, 10, 3), new Date(2026, 10, 3));
  run(['sort-docs', dir, '--by=month']);
  assert.deepStrictEqual(listAll(dir), ['PDF', 'PDF/2025-03', 'PDF/2025-03/a.pdf', 'PDF/2026-11', 'PDF/2026-11/b.pdf']);
});

test('sort-docs refuses any --by value but month, and never overwrites', () => {
  const dir = tempDir();
  make(dir, ['a.pdf', 'PDF/a.pdf']);
  assert.throws(() => run(['sort-docs', dir, '--by=kind']), /only --by=month/);
  const result = sortDocs(dir);
  assert.strictEqual(result.moved.length, 0);
  assert.match(result.skipped[0].reason, /already exists/);
});

test('a second run changes nothing', () => {
  const dir = tempDir();
  make(dir, ['a.pdf', 'b.docx']);
  sortDocs(dir, { recursive: true });
  const again = sortDocs(dir, { recursive: true });
  assert.strictEqual(again.moved.length, 0);
  assert.strictEqual(again.stay, 2);
});

test('--recursive takes documents from subfolders', () => {
  const dir = tempDir();
  make(dir, ['sub/a.pdf', 'b.docx']);
  run(['sort-docs', dir, '--recursive']);
  assert.deepStrictEqual(listAll(dir), ['PDF', 'PDF/a.pdf', 'Word', 'Word/b.docx', 'sub']);
});

test('--by=month --dry-run lists the month folders and changes nothing', () => {
  const dir = tempDir();
  make(dir, ['a.pdf']);
  fs.utimesSync(path.join(dir, 'a.pdf'), new Date(2025, 2, 10), new Date(2025, 2, 10));
  const out = run(['sort-docs', dir, '--by=month', '--dry-run']);
  assert.ok(out.includes(`[Preview] Move: a.pdf -> ${path.join('PDF', '2025-03', 'a.pdf')}`));
  assert.deepStrictEqual(listAll(dir), ['a.pdf']);
});

test('--by=month --recursive moves nested documents, and a second run changes nothing', () => {
  const dir = tempDir();
  make(dir, ['sub/a.pdf', 'b.docx']);
  fs.utimesSync(path.join(dir, 'sub', 'a.pdf'), new Date(2025, 2, 10), new Date(2025, 2, 10));
  fs.utimesSync(path.join(dir, 'b.docx'), new Date(2026, 10, 3), new Date(2026, 10, 3));
  run(['sort-docs', dir, '--by=month', '--recursive']);
  assert.deepStrictEqual(listAll(dir), ['PDF', 'PDF/2025-03', 'PDF/2025-03/a.pdf', 'Word', 'Word/2026-11', 'Word/2026-11/b.docx', 'sub']);
  const again = sortDocs(dir, { by: 'month', recursive: true });
  assert.strictEqual(again.moved.length, 0);
  assert.strictEqual(again.stay, 2);
});

test('a document already in its type folder stays when --by=month is used later', () => {
  const dir = tempDir();
  make(dir, ['PDF/a.pdf']);
  const result = sortDocs(dir, { by: 'month', recursive: true });
  assert.strictEqual(result.moved.length, 0);
  assert.strictEqual(result.stay, 1);
});

test('sort-docs refuses a project folder and leaves nested project folders whole', () => {
  const dir = tempDir();
  make(dir, ['package.json', 'a.pdf']);
  assert.throws(() => sortDocs(dir), /project folder/);
  const dir2 = tempDir();
  make(dir2, ['proj/package.json', 'proj/readme.md', 'b.pdf']);
  const result = sortDocs(dir2, { recursive: true });
  assert.deepStrictEqual(result.moved.map((m) => m.name), ['b.pdf']);
  assert.ok(fs.existsSync(path.join(dir2, 'proj', 'readme.md')));
});

test('an empty --by value is refused', () => {
  const dir = tempDir();
  assert.throws(() => run(['sort-docs', dir, '--by=']), /only --by=month/);
  assert.throws(() => run(['sort-docs', dir, '--by']), /Attach a value|only --by=month/);
});
