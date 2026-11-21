'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// walk is replaced before the modules are loaded, because they take the function when they are imported.
const targetModule = require('../src/target');
const realWalk = targetModule.walk;
const walked = [];
test.mock.method(targetModule, 'walk', (dir, options) => {
  walked.push(dir);
  return realWalk(dir, options);
});

const removeBroken = require('../src/removeBroken');
const removeLowQuality = require('../src/removeLowQuality');
const removeDuplicates = require('../src/removeDuplicates');
const { findLowQuality } = require('../src/lowQuality');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-onewalk-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

for (const [name, plan] of [
  ['remove-broken', (dir) => removeBroken.planRemoval(dir)],
  ['remove-low-quality', (dir) => removeLowQuality.planRemoval(dir)],
  ['remove-duplicates', (dir) => removeDuplicates.planRemoval(dir)],
]) {
  test(`${name} scans the target once per plan (#310)`, () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    walked.length = 0;
    plan(dir);
    assert.strictEqual(walked.length, 1);
  });
}

test('a link that is not a video is not listed as skipped by low-quality (#310)', (t) => {
  const dir = tempDir();
  const other = tempDir();
  try {
    fs.symlinkSync(other, path.join(dir, 'notes.txt'), 'junction');
    fs.symlinkSync(other, path.join(dir, 'clip.mp4'), 'junction');
  } catch {
    t.skip('links are not available');
    return;
  }
  const result = findLowQuality(dir);
  assert.deepStrictEqual(result.skipped.map((item) => path.basename(item.path)), ['clip.mp4']);
});
