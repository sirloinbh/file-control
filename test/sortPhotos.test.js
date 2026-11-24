'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const { sortPhotos, SCREENSHOT_NAME } = require('../src/sortPhotos');
const { run } = require('../bin/fctl');
const samples = require('./exifSamples');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sortphotos-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function put(dir, name, data = name) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return full;
}

const listAll = (dir) => fs.readdirSync(dir, { recursive: true }).map((p) => p.split(path.sep).join('/')).sort();

test('a JPEG with a date taken is moved by that date, not by its modified time', () => {
  const dir = tempDir();
  const file = put(dir, 'IMG_1.jpg', samples.jpeg('2023:05:09 08:00:00'));
  fs.utimesSync(file, new Date(2026, 10, 3), new Date(2026, 10, 3));
  const out = run(['sort-photos', dir]);
  assert.deepStrictEqual(listAll(dir), ['2023', '2023/2023-05', '2023/2023-05/IMG_1.jpg']);
  assert.ok(!out.includes('no date taken'));
});

test('a photo without a date taken is moved by its modified time and marked in the report', () => {
  const dir = tempDir();
  const file = put(dir, 'plain.jpg', samples.plainJpeg());
  fs.utimesSync(file, new Date(2022, 0, 20), new Date(2022, 0, 20));
  const out = run(['sort-photos', dir]);
  assert.deepStrictEqual(listAll(dir), ['2022', '2022/2022-01', '2022/2022-01/plain.jpg']);
  assert.match(out, /Move: plain\.jpg -> .*plain\.jpg \(no date taken, used the modified time\)/);
});

test('--dry-run lists the moves with the notes and changes nothing', () => {
  const dir = tempDir();
  put(dir, 'a.jpg', samples.jpeg('2023:05:09 08:00:00'));
  put(dir, 'b.png', samples.png('2021:12:31 23:59:59'));
  put(dir, 'c.jpg', samples.plainJpeg());
  const before = listAll(dir);
  const out = run(['sort-photos', dir, '--dry-run']);
  assert.deepStrictEqual(listAll(dir), before);
  assert.ok(out.includes(`[Preview] Move: a.jpg -> ${path.join('2023', '2023-05', 'a.jpg')}`));
  assert.ok(out.includes(`[Preview] Move: b.png -> ${path.join('2021', '2021-12', 'b.png')}`));
  assert.match(out, /Move: c\.jpg .*\(no date taken/);
});

test('screenshots go to Screenshots, whatever their date', () => {
  const dir = tempDir();
  for (const name of ['Screenshot_20260101.png', 'Screenshot 2026-01-01 101010.png', 'Screen Shot 2020-01-01.png', '스크린샷 2026-01-01.png', '화면 캡처 2026-01-01.png']) {
    put(dir, name, samples.png('2021:12:31 23:59:59'));
  }
  run(['sort-photos', dir]);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'Screenshots')).length, 5);
  assert.deepStrictEqual(fs.readdirSync(dir), ['Screenshots']);
  assert.ok(SCREENSHOT_NAME.test('screenshot.png'));
  assert.ok(!SCREENSHOT_NAME.test('my screenshot.png'));
  assert.ok(!SCREENSHOT_NAME.test('Screenshots_from_trip.jpg'));
  assert.ok(!SCREENSHOT_NAME.test('screenshot-lake.jpg'));
});

test('files that are not photos are left in place and not listed', () => {
  const dir = tempDir();
  put(dir, 'a.jpg', samples.jpeg('2023:05:09 08:00:00'));
  put(dir, 'notes.txt');
  put(dir, 'movie.mp4');
  put(dir, 'anim.gif');
  const out = run(['sort-photos', dir]);
  assert.deepStrictEqual(listAll(dir), ['2023', '2023/2023-05', '2023/2023-05/a.jpg', 'anim.gif', 'movie.mp4', 'notes.txt']);
  assert.ok(!out.includes('notes.txt'));
  assert.match(out, /not concerned 3/);
});

test('a name clash keeps the photo in place and a second run changes nothing', () => {
  const dir = tempDir();
  put(dir, 'a.jpg', samples.jpeg('2023:05:09 08:00:00'));
  put(dir, '2023/2023-05/a.jpg', 'original');
  const result = sortPhotos(dir);
  assert.strictEqual(result.moved.length, 0);
  assert.match(result.skipped[0].reason, /already exists/);
  assert.strictEqual(fs.readFileSync(path.join(dir, '2023', '2023-05', 'a.jpg'), 'utf8'), 'original');
  const other = tempDir();
  put(other, 'b.jpg', samples.jpeg('2023:05:09 08:00:00'));
  sortPhotos(other, { recursive: true });
  const again = sortPhotos(other, { recursive: true });
  assert.strictEqual(again.moved.length, 0);
  assert.strictEqual(again.stay, 1);
});

test('--recursive takes photos from subfolders; by default only the target folder is looked at', () => {
  const dir = tempDir();
  put(dir, 'trip/a.jpg', samples.jpeg('2023:05:09 08:00:00'));
  assert.strictEqual(sortPhotos(dir, { dryRun: true }).moved.length, 0);
  run(['sort-photos', dir, '--recursive']);
  assert.deepStrictEqual(listAll(dir), ['2023', '2023/2023-05', '2023/2023-05/a.jpg', 'trip']);
});

test('--by is refused on sort-photos', () => {
  const dir = tempDir();
  assert.throws(() => run(['sort-photos', dir, '--by=month']), /--by can be used only with/);
});

test('a HEIC photo uses the modified time and the note does not claim it has no date', () => {
  const dir = tempDir();
  const file = put(dir, 'IMG_0001.heic', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]));
  fs.utimesSync(file, new Date(2022, 5, 1), new Date(2022, 5, 1));
  const out = run(['sort-photos', dir]);
  assert.deepStrictEqual(listAll(dir), ['2022', '2022/2022-06', '2022/2022-06/IMG_0001.heic']);
  assert.match(out, /date taken not read for this format/);
  assert.ok(!out.includes('no date taken'));
});

test('--recursive: a screenshot in a subfolder goes to Screenshots even with an EXIF date', () => {
  const dir = tempDir();
  put(dir, 'trip/Screenshot_1.jpg', samples.jpeg('2021:03:04 05:06:07'));
  run(['sort-photos', dir, '--recursive']);
  assert.deepStrictEqual(listAll(dir), ['Screenshots', 'Screenshots/Screenshot_1.jpg', 'trip']);
});
