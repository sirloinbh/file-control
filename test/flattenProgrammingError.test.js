'use strict';

// A programming error in the folder phase of flatten is not hidden as a kept folder (#318).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { flatten } = require('../src/flatten');

test('flatten rethrows a TypeError from the folder phase with the partial result attached', (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-318-flatten-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => path.join(base, 'home'));
  const dir = path.join(base, 'work');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', '1.txt'), 'x');
  let moved = false;
  const real = fs.readdirSync;
  // After the move has been reported, the folder listing returns a broken value: walk() hits a TypeError (not iterable), which is a bug, not a read failure.
  const listing = t.mock.method(fs, 'readdirSync', (...args) => (moved ? null : real(...args)));
  let error = null;
  try {
    flatten(dir, { onProgress: (line) => { if (line.startsWith('Move: ')) moved = true; } });
  } catch (err) {
    error = err;
  }
  // Restore at once: the cleanup below (rmSync) lists folders too, and on Node 22 it would hit the broken listing.
  listing.mock.restore();
  assert.ok(error instanceof TypeError, String(error));
  assert.strictEqual(error.partial.moved.length, 1, 'the moved file stays in the partial result');
  assert.deepStrictEqual(error.partial.keptFolders, []);
  assert.ok(fs.existsSync(path.join(dir, '1.txt')));
});
