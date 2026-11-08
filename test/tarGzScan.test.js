'use strict';

// .tar.gz 확인(#197)의 분기별 테스트. 파일을 만들어 별도 프로세스 스캔(scanTarGzSync)으로 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { scanTarGzSync } = require('../src/tarGzScan');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-targz-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// tar 헤더 하나. name은 Buffer나 latin1 문자열, size는 숫자(8진수로 적음)나 12바이트 Buffer(base-256 등)다.
function header(name, size, { type = '0', magic = 'ustar\0', prefix = '', breakChecksum = false } = {}) {
  const block = Buffer.alloc(512);
  (Buffer.isBuffer(name) ? name : Buffer.from(name, 'latin1')).copy(block, 0, 0, 100);
  block.write('0000644\0' + '0000000\0' + '0000000\0', 100, 'latin1');
  if (Buffer.isBuffer(size)) size.copy(block, 124);
  else block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.fill(' ', 148, 156);
  block.write(type, 156, 'latin1');
  block.write(magic, 257, 'latin1');
  if (magic === 'ustar\0') block.write('00', 263, 'latin1');
  block.write(prefix, 345, 'latin1');
  const sum = block.reduce((total, byte) => total + byte, 0) + (breakChecksum ? 1 : 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

const pad = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
const END = Buffer.alloc(1024);

function paxRecord(key, value) {
  const body = Buffer.concat([Buffer.from(` ${key}=`), Buffer.from(value), Buffer.from('\n')]);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length += 1;
  return Buffer.concat([Buffer.from(String(length)), body]);
}

function pax(records) {
  const data = Buffer.concat(Object.entries(records).map(([key, value]) => paxRecord(key, value)));
  return Buffer.concat([header('PaxHeader', data.length, { type: 'x' }), pad(data)]);
}

const file = (name, data, options) => Buffer.concat([header(name, Buffer.byteLength(data), options), pad(Buffer.from(data))]);

function scan(dir, name, tar, { raw = false } = {}) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, raw ? tar : zlib.gzipSync(tar));
  return scanTarGzSync(target);
}

test('정상 tar.gz는 항목 이름과 크기를 돌려준다: pax 이름·크기, ustar prefix, base-256 크기, 크기 없는 하드링크 (#197)', () => {
  const dir = tempDir();
  const base256 = Buffer.alloc(12);
  base256[0] = 0x80;
  base256[11] = 3;
  const tar = Buffer.concat([
    file('a.txt', 'abc'),
    pax({ path: '한글.txt' }), file('ignored.txt', 'xy'),
    pax({ size: '3' }), header('p.txt', 0), pad(Buffer.from('pax')),
    file('n.txt', 'pre', { prefix: 'dir' }),
    header('b.txt', base256), pad(Buffer.from('b56')),
    header('dir2', 0, { type: '5' }),
    header('link.txt', 0, { type: '1' }),
    END,
  ]);
  assert.deepStrictEqual(scan(dir, 'ok.tar.gz', tar), {
    entries: [
      { name: 'a.txt', size: 3 }, { name: '한글.txt', size: 2 }, { name: 'p.txt', size: 3 }, { name: 'dir/n.txt', size: 3 },
      { name: 'b.txt', size: 3 }, { name: 'dir2/', size: 0 }, { name: 'link.txt', size: null },
    ],
  });
  // GNU 형식('ustar  ')은 prefix 칸을 쓰지 않는다.
  assert.deepStrictEqual(scan(dir, 'gnu.tar.gz', Buffer.concat([file('g.txt', 'g', { magic: 'ustar  \0', prefix: 'no' }), END])), { entries: [{ name: 'g.txt', size: 1 }] });
});

test('tar.exe가 그대로 풀지 않거나 풀린 결과로 확인할 수 없는 tar는 사유를 돌려준다 (#197 1차 리뷰)', () => {
  const dir = tempDir();
  const good = zlib.gzipSync(Buffer.concat([file('a.txt', 'a'), END]));
  const cases = {
    // tar.exe는 체크섬이 틀린 헤더를 건너뛰고(Damaged… Retrying) 성공으로 끝낸다.
    checksum: [Buffer.concat([file('a.txt', 'a', { breakChecksum: true }), END]), /체크섬이 맞지 않아/],
    'non-ascii': [Buffer.concat([file(Buffer.from([0xc7, 0xd1, 0x2e, 0x74]), 'a'), END]), /코드페이지에 따라/],
    'empty-pax-path': [Buffer.concat([pax({ path: '' }), file('e.txt', ''), END]), /이름이 비어 있어/],
    'pax-utf8': [Buffer.concat([pax({ path: Buffer.from([0xff, 0x41]) }), file('e.txt', ''), END]), /UTF-8이 아니라/],
    sparse: [Buffer.concat([file('s.txt', 'a', { type: 'S' }), END]), /항목 종류/],
    'gnu-sparse-pax': [Buffer.concat([pax({ 'GNU.sparse.size': '10' }), file('s.txt', 'a'), END]), /희소 파일/],
    symlink: [Buffer.concat([header('l', 0, { type: '2' }), END]), /항목 종류/],
    'hardlink-data': [Buffer.concat([file('h.txt', 'abc', { type: '1' }), END]), /내용이 있는 하드링크/],
    'bad-size': [Buffer.concat([header('a.txt', Buffer.from('zzzzzzzzzzz\0', 'latin1')), END]), /크기를 읽지 못해/],
    'zero-then-data': [Buffer.concat([Buffer.alloc(512), file('a.txt', 'a'), END]), /끝 표시 뒤에/],
    'no-end': [file('a.txt', 'a'), /끝 표시가 없어/],
  };
  for (const [name, [tar, reason]] of Object.entries(cases)) assert.match(scan(dir, `${name}.tar.gz`, tar).reason ?? '', reason, name);
  // 멤버 뒤가 0x00으로 시작하면 Node는 오류 없이 멈추므로 읽은 바이트 수로 잡는다.
  const raw = {
    'zero-gap': Buffer.concat([good, Buffer.alloc(1), good]),
    'zero-tail': Buffer.concat([good, Buffer.alloc(100)]),
    junk: Buffer.concat([good, Buffer.from('junk')]),
    cut: good.subarray(0, good.length - 1),
  };
  for (const [name, data] of Object.entries(raw)) assert.ok(scan(dir, `${name}.tar.gz`, data, { raw: true }).reason, name);
  assert.match(scan(dir, 'zero-gap2.tar.gz', Buffer.concat([good, Buffer.alloc(1), good]), { raw: true }).reason, /gzip 끝 뒤에 다른 데이터/);
  // 없는 파일도 사유로 돌려준다.
  assert.match(scanTarGzSync(path.join(dir, 'missing.tar.gz')).reason, /다시 읽지 못해/);
});
