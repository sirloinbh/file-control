'use strict';

// Tests of src/zip.js, src/crc32.js, and the empty 7z (#325).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readZipEntries, checkZip } = require('../src/zip');
const { crc32, crc32Table } = require('../src/crc32');
const { readSevenZip } = require('../src/sevenZip');
const { inspect } = require('../src/broken');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-zip-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The real path, so that a short 8.3 temp path (as on CI runners) is not seen as a link out of the target.
  return fs.realpathSync.native(dir);
}

// A one-entry stored zip with a comment.
function zipWithComment(name, data, comment) {
  const body = Buffer.from(data);
  const nameBytes = Buffer.from(name);
  const crc = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const entryEnd = local.length + nameBytes.length + body.length;
  const directory = Buffer.concat([central, nameBytes]);
  const text = Buffer.from(comment, 'latin1');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(entryEnd, 16);
  end.writeUInt16LE(text.length, 20);
  return Buffer.concat([local, nameBytes, body, directory, end, text]);
}

test('a marker in the comment does not make the zip count as broken, but the delete check keeps it (#325, #347)', () => {
  const dir = tempDir();
  const comment = 'note PK\x05\x06 and more text that is long enough to hold a fake record';
  fs.writeFileSync(path.join(dir, 'c.zip'), zipWithComment('a.txt', 'abc', comment));
  // tar.exe may extract from the record inside the comment, so the delete check keeps the archive.
  assert.match(readZipEntries(dir, path.join(dir, 'c.zip'), 1).reason, /comment contains another end marker/);
  assert.strictEqual(checkZip(dir, path.join(dir, 'c.zip'), fs.statSync(path.join(dir, 'c.zip')).size), null);
});

test('readZipEntries는 끝 표시가 없거나 뒤에 데이터가 붙은 zip의 사유를 { reason }으로 돌려준다 (#325)', () => {
  const dir = tempDir();
  const good = zipWithComment('a.txt', 'abc', '');
  fs.writeFileSync(path.join(dir, 'cut.zip'), good.subarray(0, good.length - 30));
  assert.match(readZipEntries(dir, path.join(dir, 'cut.zip'), 1).reason, /end marker is missing/);
  fs.writeFileSync(path.join(dir, 'tail.zip'), Buffer.concat([good, Buffer.from('junk')]));
  assert.match(readZipEntries(dir, path.join(dir, 'tail.zip'), 1).reason, /other data after the zip end marker/);
  fs.writeFileSync(path.join(dir, 'count.zip'), good);
  assert.match(readZipEntries(dir, path.join(dir, 'count.zip'), 2).reason, /number of zip entries differs/);
});

// An empty 7z is the 32-byte start header only: NextHeaderOffset, NextHeaderSize, and NextHeaderCRC are all 0.
function emptySevenZip() {
  const start = Buffer.alloc(32);
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]).copy(start);
  start.writeUInt32LE(crc32(start.subarray(12, 32)), 8);
  return start;
}

test('항목이 없는 7z는 정상이다 (#325)', () => {
  const data = emptySevenZip();
  assert.deepStrictEqual(readSevenZip((offset, length) => data.subarray(offset, offset + length), data.length), { entries: [] });
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'empty.7z'), data);
  assert.strictEqual(inspect(dir, path.join(dir, 'empty.7z'), data.length), null);
});

test('crc32 대체 구현은 zlib.crc32와 같은 값을 낸다 (#325)', () => {
  for (const sample of [Buffer.alloc(0), Buffer.from('hello world'), Buffer.alloc(5000, 0xab)]) {
    assert.strictEqual(crc32Table(sample), zlib.crc32 ? zlib.crc32(sample) : crc32Table(sample));
    assert.strictEqual(crc32(sample), crc32Table(sample));
  }
});

test('a real zip followed by a fake end record and directory in its comment is kept (#347)', () => {
  const dir = tempDir();
  const fake = zipWithComment('evil.txt', 'xyz', '');
  const real = zipWithComment('a.txt', 'abc', fake.toString('latin1'));
  fs.writeFileSync(path.join(dir, 'fake.zip'), real);
  assert.match(readZipEntries(dir, path.join(dir, 'fake.zip'), 1).reason, /comment contains another end marker/);
  // Without the fake record the same zip is accepted.
  fs.writeFileSync(path.join(dir, 'plain.zip'), zipWithComment('a.txt', 'abc', 'just a note'));
  assert.deepStrictEqual(readZipEntries(dir, path.join(dir, 'plain.zip'), 1), { entries: [{ name: 'a.txt', size: 3 }] });
});

test('checkZip reads the entry headers through one opened handle (#326)', () => {
  const dir = tempDir();
  const count = 300;
  const parts = [];
  const central = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const name = Buffer.from(`f${i}.txt`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name);
    central.push(entry, name);
    offset += 30 + name.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const file = path.join(dir, 'many.zip');
  const data = Buffer.concat([...parts, directory, end]);
  fs.writeFileSync(file, data);
  const open = test.mock.method(fs, 'openSync');
  try {
    assert.strictEqual(checkZip(dir, file, data.length), null);
    // The tail, the directory and the one handle for the headers; not one open per entry.
    assert.ok(open.mock.callCount() <= 5, `openSync calls: ${open.mock.callCount()}`);
  } finally {
    open.mock.restore();
  }
  // A wrong header signature is still found.
  data[30 + 'f0.txt'.length + 0] = 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from('XXXX'), data.subarray(4)]));
  assert.match(checkZip(dir, file, data.length).reason ?? '', /header does not match|damaged/);
});
