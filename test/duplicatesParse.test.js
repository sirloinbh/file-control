'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// findProductNumberRanges is counted before duplicates.js is loaded, because it takes the function when it is imported.
const product = require('../src/product');
const realRanges = product.findProductNumberRanges;
let calls = 0;
test.mock.method(product, 'findProductNumberRanges', (...args) => {
  calls += 1;
  return realRanges(...args);
});

const { findDuplicateNames } = require('../src/duplicates');

test('findDuplicateNames parses each file name once (#327)', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-parse-')));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['ABC-123 a.mp4', 'ABC-123 b.mp4', 'plain.mp4']) fs.writeFileSync(path.join(dir, name), '');
  calls = 0;
  findDuplicateNames(dir);
  assert.strictEqual(calls, 3);
});
