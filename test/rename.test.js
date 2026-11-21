'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { grant } = require('../src/target');
const { skipReason, applyRename, applyRenames } = require('../src/rename');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rename-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

test('skipReason names leftovers and system folders and passes ordinary paths (#320)', () => {
  assert.strictEqual(skipReason({ relative: path.join('a', 'b.mp4') }), null);
  assert.match(skipReason({ relative: path.join('$RECYCLE.BIN', 'b.mp4') }) ?? '', /system folder|leftover/);
});

test('applyRename renames a planned file and refuses a taken name or a moved path (#320)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'taken.txt'), 't');
  const access = grant(dir, ['write', 'delete']);
  applyRename({ from: path.join(dir, 'a.txt'), to: path.join(dir, 'b.txt'), name: 'b.txt' }, access);
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  assert.throws(() => applyRename({ from: path.join(dir, 'b.txt'), to: path.join(dir, 'taken.txt'), name: 'taken.txt' }, access), (err) => err instanceof FcError && /already exists/.test(err.message));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'taken.txt'), 'utf8'), 't');
  assert.throws(() => applyRename({ from: path.join(dir, 'gone.txt'), to: path.join(dir, 'c.txt'), name: 'c.txt' }, access), FcError);
});

test('applyRenames keeps going after a failure and lets caseOnly short-circuit (#320)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  const plan = {
    target: dir,
    renames: [
      { from: path.join(dir, 'missing.txt'), to: path.join(dir, 'm.txt'), name: 'm.txt' },
      { from: path.join(dir, 'a.txt'), to: path.join(dir, 'b.txt'), name: 'b.txt' },
      { from: path.join(dir, 'x.txt'), to: path.join(dir, 'X.txt'), name: 'X.txt' },
    ],
  };
  const seen = [];
  const result = applyRenames(plan, { caseOnly: (rename) => { seen.push(rename.name); return rename.name === 'X.txt'; } });
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(result.renamed.map((r) => r.name), ['b.txt', 'X.txt']);
  assert.ok(seen.includes('X.txt'));
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  assert.strictEqual(applyRenames(plan, { dryRun: true }).renamed.length, 3);
});
