'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTakenDate, parseExifDate } = require('../src/exif');
const samples = require('./exifSamples');

function write(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-exif-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

const TAKEN = { year: 2024, month: 7, day: 15 };

test('parseExifDate reads the EXIF text and refuses blank or impossible dates', () => {
  assert.deepStrictEqual(parseExifDate('2024:07:15 10:20:30'), TAKEN);
  assert.strictEqual(parseExifDate('0000:00:00 00:00:00'), null);
  assert.strictEqual(parseExifDate('2024:13:15 10:20:30'), null);
  assert.strictEqual(parseExifDate('1960:01:01 00:00:00'), null);
  assert.strictEqual(parseExifDate('3000:01:01 00:00:00'), null);
  assert.strictEqual(parseExifDate('not a date'), null);
});

test('a JPEG gives its date taken, in either byte order', () => {
  assert.deepStrictEqual(readTakenDate(write('a.jpg', samples.jpeg('2024:07:15 10:20:30'))), TAKEN);
  assert.deepStrictEqual(readTakenDate(write('b.jpg', samples.jpeg('2024:07:15 10:20:30', { big: true }))), TAKEN);
});

test('the date digitized is used when there is no date taken', () => {
  assert.deepStrictEqual(readTakenDate(write('a.jpg', samples.jpeg('2024:07:15 10:20:30', { tag: 0x9004 }))), TAKEN);
  assert.strictEqual(readTakenDate(write('b.jpg', samples.jpeg('2024:07:15 10:20:30', { tag: 0x0132 }))), null);
});

test('PNG, WebP and TIFF give their date taken, found by the first bytes and not the extension', () => {
  assert.deepStrictEqual(readTakenDate(write('a.png', samples.png('2024:07:15 10:20:30'))), TAKEN);
  assert.deepStrictEqual(readTakenDate(write('b.webp', samples.webp('2024:07:15 10:20:30'))), TAKEN);
  assert.deepStrictEqual(readTakenDate(write('c.tif', samples.tiff('2024:07:15 10:20:30'))), TAKEN);
  assert.deepStrictEqual(readTakenDate(write('renamed.dat', samples.jpeg('2024:07:15 10:20:30'))), TAKEN);
});

test('no date, HEIC, damaged and empty files give null and never throw', () => {
  assert.strictEqual(readTakenDate(write('a.jpg', samples.plainJpeg())), null);
  assert.strictEqual(readTakenDate(write('b.jpg', samples.jpeg('0000:00:00 00:00:00'))), null);
  assert.strictEqual(readTakenDate(write('c.heic', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]))), null);
  assert.strictEqual(readTakenDate(write('d.jpg', samples.jpeg('2024:07:15 10:20:30').subarray(0, 30))), null);
  assert.strictEqual(readTakenDate(write('e.jpg', Buffer.alloc(0))), null);
  assert.strictEqual(readTakenDate(write('f.png', Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))), null);
  assert.strictEqual(readTakenDate(path.join(os.tmpdir(), 'fc-exif-no-such-file.jpg')), null);
});

test('a bad IFD offset or a huge entry count does not crash the reader', () => {
  const bad = samples.tiff('2024:07:15 10:20:30');
  bad.writeUInt32LE(0xfffffff0, 4);
  assert.strictEqual(readTakenDate(write('a.tif', bad)), null);
  const many = samples.tiff('2024:07:15 10:20:30');
  many.writeUInt16LE(60000, 8);
  assert.strictEqual(readTakenDate(write('b.tif', many)), null);
});
