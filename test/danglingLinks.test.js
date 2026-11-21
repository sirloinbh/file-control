'use strict';

// A link whose target is gone is still an item: rm, mv and rename handle it, and write, cp and mv never treat it as a free destination (#312).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('../src/commands');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dangling-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// A junction (no admin rights needed) and a file symlink (may be refused, then skipped) whose targets are gone.
function build() {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(gone);
  const junction = path.join(dir, 'junc');
  fs.symlinkSync(gone, junction, 'junction');
  fs.rmdirSync(gone);
  const links = [junction];
  const goneFile = path.join(dir, 'gone.txt');
  fs.writeFileSync(goneFile, 'x');
  const symlink = path.join(dir, 'sym');
  try {
    fs.symlinkSync(goneFile, symlink, 'file');
    links.push(symlink);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }
  fs.rmSync(goneFile);
  return { dir, links };
}

test('rm deletes a dangling link and leaves its folder alone (#312)', () => {
  const { dir, links } = build();
  for (const link of links) {
    assert.match(fc.remove([link], { permanent: true, dryRun: true })[0], /Delete permanently/);
    fc.remove([link], { permanent: true });
    assert.strictEqual(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  }
  assert.ok(fs.existsSync(dir));
});

test('mv moves a dangling link and rename renames it (#312)', () => {
  const { dir, links } = build();
  for (const [i, link] of links.entries()) {
    const renamed = path.join(dir, `renamed${i}`);
    fc.rename(link, path.basename(renamed));
    assert.ok(fs.lstatSync(renamed).isSymbolicLink());
    const moved = path.join(dir, `moved${i}`);
    fc.move([renamed], moved);
    assert.ok(fs.lstatSync(moved).isSymbolicLink());
    assert.strictEqual(fs.lstatSync(renamed, { throwIfNoEntry: false }), undefined);
  }
});

test('write to a dangling link path fails with Already exists and creates nothing behind it (#312)', () => {
  const { links } = build();
  for (const link of links) {
    assert.throws(() => fc.writeFile(link, 'data'), /Already exists/);
    assert.ok(!fs.existsSync(link));
  }
});

test('write --force, append and cp/mv --force never write through a link (#312)', () => {
  const { dir, links } = build();
  for (const link of links) {
    assert.throws(() => fc.writeFile(link, 'data', { force: true }), /Cannot write through a link/);
    assert.throws(() => fc.writeFile(link, 'data', { append: true }), /Cannot write through a link/);
    assert.ok(!fs.existsSync(link));
    const src = path.join(dir, 'src.txt');
    fs.writeFileSync(src, 'src');
    assert.throws(() => fc.copy([src], link), /Already exists/);
    assert.throws(() => fc.copy([src], link, { force: true }), /link/);
    assert.throws(() => fc.move([src], link), /Already exists/);
    assert.ok(!fs.existsSync(link));
    assert.strictEqual(fs.readFileSync(src, 'utf8'), 'src');
  }
});

test('a path that does not exist at all is still refused by rm, mv and rename (#312)', () => {
  const dir = fs.mkdtempSync(path.join(base, 'n-'));
  const missing = path.join(dir, 'nope');
  assert.throws(() => fc.remove([missing], { permanent: true }), /does not exist/);
  assert.throws(() => fc.move([missing], path.join(dir, 'x')), /does not exist/);
  assert.throws(() => fc.rename(missing, 'x'), /does not exist/);
});
