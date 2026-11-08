'use strict';

// .7z 헤더 읽기(#198)의 단위 테스트.
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
  // 이름이 많으면 LZMA의 반복 일치를 많이 거친다.
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
    // 시작 헤더나 헤더 바이트가 하나라도 바뀌면 CRC로 걸린다. (압축된 헤더 끝의 LZMA 마무리 바이트는 풀린 결과에 영향이 없어 넣지 않는다.)
    const headerAt = 32 + Number(data.readBigUInt64LE(12));
    for (const at of [headerAt + 3, headerAt + 1, 10, 30]) {
      const bad = Buffer.from(data);
      bad[at] ^= 0x55;
      assert.match(scan(bad).reason ?? '', /CRC가 맞지 않아|구조를 읽지 못해|손상돼|중간에 끝나|7z 끝 뒤에|목록에 없는 데이터/, `${options} ${at}`);
    }
  }
});

test('직접 만든 7z: UTF-16 이름을 읽고, CRC가 없거나 목록에 없는 데이터가 있거나 헤더가 틀리면 사유를 돌려준다 (#198)', () => {
  const files = [{ name: '한글.txt', data: 'abc' }, { name: 'dir', folder: true }, { name: 'dir/x.txt', data: 'xy' }, { name: 'e.txt', data: '' }];
  assert.deepStrictEqual(scan(sevenZipBuffer(files)).entries, [
    { name: '한글.txt', size: 3, folder: false }, { name: 'dir', size: 0, folder: true }, { name: 'dir/x.txt', size: 2, folder: false }, { name: 'e.txt', size: 0, folder: false },
  ]);
  assert.match(scan(sevenZipBuffer(files, { crc: false })).reason, /CRC가 없어/);
  // 항목 CRC 없이 폴더 CRC만 있으면 libarchive가 검사하지 않으므로 CRC 없음으로 본다(1차 리뷰).
  assert.match(scan(sevenZipBuffer([{ name: 'x.txt', data: 'hello' }], { folderCrcOnly: true })).reason, /CRC가 없어/);
  // 항목 수가 남은 헤더 길이로 가능한 수를 넘으면 큰 배열을 만들기 전에 거부한다.
  assert.match(scan(sevenZipBuffer(files, { mutateHeader: (header) => {
    const at = header.lastIndexOf(Buffer.from([0x05, files.length]));
    return Buffer.concat([header.subarray(0, at + 1), Buffer.from([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]), header.subarray(at + 2)]);
  } })).reason, /개수가 맞지 않아/);
  assert.match(scan(sevenZipBuffer(files, { gap: 4 })).reason, /목록에 없는 데이터/);
  assert.match(scan(Buffer.concat([sevenZipBuffer(files), Buffer.from('z')])).reason, /7z 끝 뒤에/);
  assert.match(scan(sevenZipBuffer(files).subarray(0, 40)).reason, /7z 끝 뒤에|중간에 끝나/);
  assert.match(scan(Buffer.from('not 7z at all, just text that is long enough')).reason, /7z로 시작하지 않아/);
  // 헤더 CRC는 맞지만 내용이 틀린 헤더(다음 헤더 CRC를 다시 계산)
  const broken = sevenZipBuffer(files, { mutateHeader: (header) => header.subarray(0, header.length - 3) });
  assert.ok(scan(broken).reason);
  // CRC는 있지만 지우기 표시(anti) 항목
  assert.match(scan(sevenZipBuffer(files, { anti: true })).reason, /지우기 표시/);
  // 같은 데이터를 헤더 압축 없이(COPY) EncodedHeader로 감싼 것도 읽는다.
  assert.strictEqual(scan(sevenZipBuffer(files, { encoded: true })).entries.length, 4);
  assert.match(scan(sevenZipBuffer(files, { encoded: true, encodedCrc: false })).reason, /헤더에 CRC가 없어/);
  // 헤더 크기 0 등 시작 헤더 값이 맞지 않는 파일
  assert.ok(scan(Buffer.alloc(32)).reason);
});

test('헤더가 LZMA2로 압축된 큰 7z(압축된 헤더가 64KB를 넘어 여러 청크)도 읽는다 (#222)', () => {
  const crypto = require('node:crypto');
  const dir = tempDir();
  const source = path.join(dir, 'many');
  fs.mkdirSync(source);
  // 이름을 무작위로 해 압축이 덜 되게 한다. 압축된 헤더가 LZMA2 청크 한도(64KB)를 넘는다.
  const names = Array.from({ length: 3000 }, () => `${crypto.randomBytes(21).toString('hex')}.t`);
  for (const name of names) fs.writeFileSync(path.join(source, name), '');
  const file = path.join(dir, 'many.7z');
  execFileSync(SYSTEM_TAR, ['-a', '-cf', file, '--options', '7zip:compression=lzma2', '-C', dir, 'many']);
  const data = fs.readFileSync(file);
  // 파일 내용이 비어 있으므로 파일 크기가 거의 압축된 헤더 크기다. 64KB를 넘어야 청크가 여러 개다.
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
  // 끝 표시(0x00)가 없다.
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), ok.subarray(0, ok.length - 1), 11)), /중간에 끝나/);
  // 첫 청크가 사전을 재설정하지 않는다.
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.concat([plain(0x02, a), Buffer.from([0x00])]), 6)), /손상돼/);
  // 속성을 정하지 않은 LZMA 청크
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.concat([plain(0x01, a), Buffer.from([0x80, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0x00])]), 7)), /손상돼/);
  // 풀린 크기가 헤더 크기를 넘는 청크와 잘못된 제어 바이트
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), ok, 5)), /손상돼/);
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), Buffer.from([0x03, 0, 0, 0x41, 0x00]), 1)), /손상돼/);
  assert.match(reason(() => lzma2Decode(Buffer.from([41]), ok, 11)), /LZMA2 설정/);
  // 풀린 크기보다 일찍 끝난다.
  assert.match(reason(() => lzma2Decode(Buffer.from([0x10]), ok, 12)), /중간에 끝나/);
});
