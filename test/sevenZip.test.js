'use strict';

// Unit test of the .7z header reading (#198).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readSevenZip, lzma2Decode } = require('../src/sevenZip');
const { sevenZipBuffer } = require('./sevenZipBuffer');

const SYSTEM_TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-7z-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const scan = (buf) => readSevenZip((offset, length) => buf.subarray(offset, offset + length), buf.length);

test('tar.exe가 만든 7z(LZMA로 압축된 헤더)의 이름·크기·폴더를 읽는다 (#198)', () => {
  const dir = tempDir();
  const source = path.join(dir, 'src');
  fs.mkdirSync(path.join(source, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(source, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(source, 'empty.txt'), '');
  fs.writeFileSync(path.join(source, 'sub', 'b.txt'), 'bb');
  // With many names, it goes through many LZMA repeat matches.
  for (let i = 0; i < 200; i += 1) fs.writeFileSync(path.join(source, 'sub', `many-${i}.txt`), String(i));
  for (const options of [[], ['--options', '7zip:compression=store'], ['--options', '7zip:compression=bzip2'], ['--options', '7zip:compression=lzma2']]) {
    const file = path.join(dir, `a${options.length}.7z`);
    execFileSync(SYSTEM_TAR, ['-a', '-cf', file, ...options, '-C', source, 'a.txt', 'empty.txt', 'sub']);
    const data = fs.readFileSync(file);
    const result = scan(data);
    assert.strictEqual(result.reason, undefined, String(result.reason));
    const byName = Object.fromEntries(result.entries.map((entry) => [entry.name, entry]));
    assert.strictEqual(result.entries.length, 204);
    assert.deepStrictEqual(byName['a.txt'], { name: 'a.txt', size: 5, folder: false });
    assert.deepStrictEqual(byName['empty.txt'], { name: 'empty.txt', size: 0, folder: false });
    assert.deepStrictEqual(byName.sub, { name: 'sub', size: 0, folder: true });
    assert.deepStrictEqual(byName['sub/many-150.txt'], { name: 'sub/many-150.txt', size: 3, folder: false });
    // If even one byte of the start header or the header changes, it is caught by the CRC. (The LZMA finishing byte at the end of the compressed header does not affect the decoded result, so it is not included.)
    const headerAt = 32 + Number(data.readBigUInt64LE(12));
    for (const at of [headerAt + 3, headerAt + 1, 10, 30]) {
      const bad = Buffer.from(data);
      bad[at] ^= 0x55;
      assert.match(scan(bad).reason ?? '', /CRC of the 7z (start )?header does not match|could not be read|is damaged|ends prematurely|after the end of the 7z|not in the listing/, `${options} ${at}`);
    }
  }
});

test('직접 만든 7z: UTF-16 이름을 읽고, CRC가 없거나 목록에 없는 데이터가 있거나 헤더가 틀리면 사유를 돌려준다 (#198)', () => {
  const files = [{ name: '한글.txt', data: 'abc' }, { name: 'dir', folder: true }, { name: 'dir/x.txt', data: 'xy' }, { name: 'e.txt', data: '' }];
  assert.deepStrictEqual(scan(sevenZipBuffer(files)).entries, [
    { name: '한글.txt', size: 3, folder: false }, { name: 'dir', size: 0, folder: true }, { name: 'dir/x.txt', size: 2, folder: false }, { name: 'e.txt', size: 0, folder: false },
  ]);
  assert.match(scan(sevenZipBuffer(files, { crc: false })).reason, /has no CRC/);
  // If there is only a folder CRC and no entry CRC, libarchive does not check, so it is seen as no CRC (first review).
  assert.match(scan(sevenZipBuffer([{ name: 'x.txt', data: 'hello' }], { folderCrcOnly: true })).reason, /has no CRC/);
  // If the entry count exceeds what the remaining header length allows, it refuses before building a large array.
  assert.match(scan(sevenZipBuffer(files, { mutateHeader: (header) => {
    const at = header.lastIndexOf(Buffer.from([0x05, files.length]));
    return Buffer.concat([header.subarray(0, at + 1), Buffer.from([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]), header.subarray(at + 2)]);
  } })).reason, /does not add up/);
  assert.match(scan(sevenZipBuffer(files, { gap: 4 })).reason, /not in the listing/);
  assert.match(scan(Buffer.concat([sevenZipBuffer(files), Buffer.from('z')])).reason, /after the end of the 7z/);
  assert.match(scan(sevenZipBuffer(files).subarray(0, 40)).reason, /after the end of the 7z|ends prematurely/);
  assert.match(scan(Buffer.from('not 7z at all, just text that is long enough')).reason, /does not start as a 7z/);
  // A header whose CRC is right but whose content is wrong (the next-header CRC is recomputed)
  const broken = sevenZipBuffer(files, { mutateHeader: (header) => header.subarray(0, header.length - 3) });
  assert.ok(scan(broken).reason);
  // It has a CRC but has an erase marker (anti) entry
  assert.match(scan(sevenZipBuffer(files, { anti: true })).reason, /marked as deleted/);
  // It also reads the same data wrapped in an EncodedHeader without header compression (COPY).
  assert.strictEqual(scan(sevenZipBuffer(files, { encoded: true })).entries.length, 4);
  assert.match(scan(sevenZipBuffer(files, { encoded: true, encodedCrc: false })).reason, /header has no CRC/);
  // A file whose start header values do not fit, such as a header size of 0
  assert.ok(scan(Buffer.alloc(32)).reason);
});

test('헤더가 LZMA2로 압축된 큰 7z(압축된 헤더가 64KB를 넘어 여러 청크)도 읽는다 (#222)', () => {
  const crypto = require('node:crypto');
  const dir = tempDir();
  const source = path.join(dir, 'many');
  fs.mkdirSync(source);
  // Names are randomized so that they compress less. The compressed header exceeds the LZMA2 chunk limit (64KB).
  const names = Array.from({ length: 3000 }, () => `${crypto.randomBytes(21).toString('hex')}.t`);
  for (const name of names) fs.writeFileSync(path.join(source, name), '');
  const file = path.join(dir, 'many.7z');
  execFileSync(SYSTEM_TAR, ['-a', '-cf', file, '--options', '7zip:compression=lzma2', '-C', dir, 'many']);
  const data = fs.readFileSync(file);
  // The file content is empty, so the file size is almost the compressed header size. It must exceed 64KB for there to be several chunks.
  assert.ok(data.length > 70000, String(data.length));
  const result = scan(data);
  assert.strictEqual(result.reason, undefined, String(result.reason));
  assert.strictEqual(result.entries.length, names.length + 1);
  assert.deepStrictEqual(result.entries.filter((e) => !e.folder).map((e) => e.name.slice('many/'.length)).sort(), [...names].sort());
});

test('lzma2Decode는 압축하지 않은 청크를 잇고, 구조가 어긋난 청크는 사유를 돌려준다 (#222)', () => {
  const plain = (control, bytes) => Buffer.concat([Buffer.from([control, (bytes.length - 1) >> 8, (bytes.length - 1) & 0xff]), bytes]);
  const a = Buffer.from('hello ');
  const b = Buffer.from('world');
  const ok = Buffer.concat([plain(0x01, a), plain(0x02, b), Buffer.from([0x00])]);
  assert.strictEqual(lzma2Decode(Buffer.from([0x10]), ok, 11).toString(), 'hello world');
  const reason = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err.message;
    }
  };
  // There is no end marker (0x00).
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), ok.subarray(0, ok.length - 1), 11)), /ends prematurely/);
  // The first chunk does not reset the dictionary.
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.concat([plain(0x02, a), Buffer.from([0x00])]), 6)), /is damaged/);
  // An LZMA chunk that does not set the properties
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.concat([plain(0x01, a), Buffer.from([0x80, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0x00])]), 7)), /is damaged/);
  // A chunk whose decoded size exceeds the header size, and a wrong control byte
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), ok, 5)), /is damaged/);
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.from([0x03, 0, 0, 0x41, 0x00]), 1)), /is damaged/);
  assert.match(reason(() => lzma2Decode(Buffer.from([41]), ok, 11)), /LZMA2 settings/);
  // It ends earlier than the decoded size.
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), ok, 12)), /ends prematurely/);
  // LZMA2 properties with lc+lp over 4 (lc=8, lp=4) are not accepted (first review: every state reset fills a large table, making it very slow).
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.from([0xe0, 0, 0, 0, 4, 44, 0, 0, 0, 0, 0, 0x00]), 1)), /LZMA2 settings/);
  // 'hello hello hello world' made with xz --format=raw --lzma2=lc=4,lp=0,pb=0. With an uncompressed chunk ending in 0xFF in front
  // and an LZMA chunk that resets the dictionary, the byte before the first literal is seen as 0 (first review).
  const raw = Buffer.from('e0001600100400341a154118b89b3e4fc54dd75df64d0000', 'hex');
  assert.strictEqual(lzma2Decode(Buffer.from([0x10]), raw, 23).toString(), 'hello hello hello world');
  const after = lzma2Decode(Buffer.from([0x10]), Buffer.concat([Buffer.from([0x01, 0x00, 0x01, 0x41, 0xff]), raw]), 25);
  assert.strictEqual(after.subarray(2).toString(), 'hello hello hello world');
  // A chunk that ends after reading less than its compressed size (compressed size increased by 1)
  const loose = Buffer.from(raw);
  loose.writeUInt16BE(loose.readUInt16BE(3) + 1, 3);
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.concat([loose.subarray(0, loose.length - 1), Buffer.from([0x00, 0x00])]), 23)), /is damaged/);
});

test('lzma2Decode는 압축하지 않은 청크(0x02) 뒤의 상태 재설정 없는 LZMA 청크(0x80)를 xz처럼 이어서 푼다 (#222 2차 리뷰)', () => {
  const crypto = require('node:crypto');
  // A stream that bundles 'abcdefghij' repeated 220,000 times with xz --format=raw --lzma2=preset=6 (chunks 0xFF, 0x81).
  const stream = Buffer.from('ffff1a01775d00309888983ecbe26f34b352b73046111cd3e4d363f4dd2d4092a4a96357b6033b217e06eae7679f95f1bb53cc6ea748c86626a30487599a0984bab3f27bdb2537bda25944808b1e8fa29bc79a57cc3a3bcfd151c7a9430b18918856ac997b0cb323cf4c047dd57af33e14536276ac59e4e55b0508f9c7daadfcfb522b74cd1e5b2042f9dd533df82964093b80cb2a6cdfb53bf0c4bd2e5faa0f3e4b664290130eff1093f8717859f80bcdff9528460fa9fc7cdefb9a302e56c08f85f38381c065c42553f8f591363105a5b0ee6fc1704d470cd19111aaad601dbaceb127185c5986e9665258bee976ac59e4e55b0508f9c7daadfcfb522b74cd1e5b2042f9dd533df82964093b80cb2a6cdfb53bf0c4bd2e5faa0f3e4b664290130eff1093f8717859f80bcdff9528460fa9fc7cdefb9a302e56c08f85f38381c065c42553f8f591363105a5b0ee6fc1704d470cd19111aaad601dbaceb127185c5986e9665258bee976ac59e4e55b0508f9c7daadfcfb522b74b325ff628192a4001400ec7353a7fdbeae7c311a9fb78d31625b83bf000000', 'hex');
  const text = Buffer.from('abcdefghij'.repeat(220000));
  assert.ok(lzma2Decode(Buffer.from([0x16]), stream, text.length).equals(text));
  // It inserts a 0x02 chunk ('XYZ') between the two chunks. The result must match the xz -dc result (2,200,003 bytes) and the SHA-256.
  const mid = Buffer.concat([stream.subarray(0, 382), Buffer.from([0x02, 0x00, 0x02, 0x58, 0x59, 0x5a]), stream.subarray(382)]);
  const out = lzma2Decode(Buffer.from([0x16]), mid, text.length + 3);
  assert.strictEqual(crypto.createHash('sha256').update(out).digest('hex'), '7a8d8bbc9771088f46bc641dc93e56c8b299435bc99910ee92919d44f8c0543d');
});
