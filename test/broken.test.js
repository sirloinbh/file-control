'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// commands.js가 불러올 때 execFileSync를 받아 두므로 require보다 먼저 바꿔 둔다.
const realExecFileSync = childProcess.execFileSync;
let tarFailure = null;
test.mock.method(childProcess, 'execFileSync', (...args) => {
  if (tarFailure) throw tarFailure;
  return realExecFileSync(...args);
});

const { findBroken, formatBroken } = require('../src/broken');
const { run } = require('../bin/fctl');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-broken-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

const latin = (value) => Buffer.from(value, 'latin1');
const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), latin(type), body]);
}

const ftyp = () => box('ftyp', latin('isom'), u32(512), latin('isommp42'));
const stco = (...offsets) => box('stco', u32(0), u32(offsets.length), ...offsets.map(u32));
const trak = (table) => box('trak', box('mdia', box('minf', box('stbl', table))));
const moov = (table) => box('moov', box('mvhd', Buffer.alloc(100)), trak(table));

function mp4(table = stco(40)) {
  return Buffer.concat([ftyp(), moov(table), box('mdat', Buffer.alloc(64))]);
}

// EBML 크기 칸은 8바이트로 쓴다.
function element(id, ...parts) {
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length) | (1n << 56n));
  return Buffer.concat([Buffer.from(id, 'hex'), size, body]);
}

const ebml = () => element('1a45dfa3', element('4282', latin('matroska')));
const tracks = () => element('1654ae6b', Buffer.alloc(16));
const cluster = () => element('1f43b675', Buffer.alloc(64));
const mkv = (...children) => Buffer.concat([ebml(), element('18538067', ...children)]);

const u16le = (value) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
};
const u32le = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};

// 항목 하나를 무압축으로 담은 zip. CRC는 이 판별에서 보지 않으므로 0으로 둔다.
function zip(name = 'a.txt', content = 'hello') {
  const fileName = latin(name);
  const body = latin(content);
  const local = Buffer.concat([u32le(0x04034b50), Buffer.alloc(14), u32le(body.length), u32le(body.length), u16le(fileName.length), u16le(0), fileName, body]);
  const central = Buffer.concat([u32le(0x02014b50), Buffer.alloc(16), u32le(body.length), u32le(body.length), u16le(fileName.length), Buffer.alloc(12), u32le(0), fileName]);
  const end = Buffer.concat([u32le(0x06054b50), Buffer.alloc(4), u16le(1), u16le(1), u32le(central.length), u32le(local.length), u16le(0)]);
  return Buffer.concat([local, central, end]);
}

function sevenZip({ nextOffset = 0, nextSize = 0, extra = 0 } = {}) {
  const start = Buffer.alloc(20);
  start.writeBigUInt64LE(BigInt(nextOffset), 0);
  start.writeBigUInt64LE(BigInt(nextSize), 8);
  return Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), u32le(zlib.crc32(start)), start, Buffer.alloc(extra)]);
}

function tar() {
  const header = Buffer.alloc(512);
  header.write('a.txt', 0, 'latin1');
  header.write('0000644\0', 100, 'latin1');
  header.write('0000000\0', 108, 'latin1');
  header.write('0000000\0', 116, 'latin1');
  header.write('00000000005\0', 124, 'latin1');
  header.write('00000000000\0', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  header.write('0', 156, 'latin1');
  header.write('ustar\x0000', 257, 'latin1');
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const body = Buffer.alloc(512);
  body.write('hello', 0, 'latin1');
  return Buffer.concat([header, body, Buffer.alloc(1024)]);
}

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// 파일 하나를 만들어 판별 결과 { status, reason }을 돌려준다. 문제를 찾지 못하면 null이다.
function judge(name, content) {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, name), content);
  const result = findBroken(dir);
  assert.deepStrictEqual(result.unreadable, []);
  assert.strictEqual(result.checked, 1);
  for (const status of ['broken', 'suspect']) {
    if (result[status].length > 0) return { status, reason: result[status][0].reason };
  }
  return null;
}

test('정상 파일은 깨졌다고 하지 않는다', () => {
  const good = {
    'a.mp4': mp4(),
    'b.mov': Buffer.concat([box('wide'), box('mdat', Buffer.alloc(64)), moov(stco(16))]),
    'c.mkv': mkv(tracks(), cluster()),
    'd.webm': mkv(cluster(), tracks()),
    'e.zip': zip(),
    'f.docx': zip(),
    'g.7z': sevenZip({ nextOffset: 4, nextSize: 4, extra: 8 }),
    'h.png': png(),
    'i.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
    'j.pdf': latin('\n\n%PDF-1.7\n'),
    'k.wav': Buffer.concat([latin('RIFF'), u32le(4), latin('WAVE')]),
    'l.tar': tar(),
    'm.tar.gz': zlib.gzipSync(tar()),
    'n.gz': zlib.gzipSync('tar가 아닌 내용'),
    'o.txt': latin('아무 내용'),
    'p.mp3': latin('앞 바이트가 느슨한 형식은 보지 않는다'),
    'q': latin('확장자 없음'),
  };
  for (const [name, content] of Object.entries(good)) assert.strictEqual(judge(name, content), null, name);
});

test('크기가 0이면 내용이 꼭 있어야 하는 형식만 깨졌다고 본다', () => {
  assert.strictEqual(judge('a.mp4', '').status, 'broken');
  assert.strictEqual(judge('a.tar', '').status, 'broken');
  assert.strictEqual(judge('__init__.py', '').status, 'suspect');
  assert.strictEqual(judge('.gitkeep', '').status, 'suspect');
});

test('내용이 다른 형식이면 이름만 바뀐 파일일 수 있어 의심으로 둔다', () => {
  const found = judge('a.jpg', png());
  assert.strictEqual(found.status, 'suspect');
  assert.match(found.reason, /JPEG.*PNG/);
});

test('내용이 어느 형식과도 맞지 않으면 깨졌다고 본다', () => {
  for (const name of ['a.mp4', 'a.mkv', 'a.jpg', 'a.zip', 'a.7z', 'a.rar', 'a.pdf']) {
    assert.strictEqual(judge(name, latin('<html>찾을 수 없음</html>')).status, 'broken', name);
    assert.strictEqual(judge(name, Buffer.alloc(2048)).status, 'broken', name);
  }
});

test('MP4의 잘린 mdat, 0으로 채워진 moov, 파일 밖을 가리키는 위치표를 찾는다', () => {
  const whole = mp4();
  assert.match(judge('a.mp4', whole.subarray(0, whole.length - 10)).reason, /mdat.*잘린/);
  assert.match(judge('a.mp4', Buffer.concat([ftyp(), box('mdat', Buffer.alloc(64))])).reason, /moov 박스가 없습니다/);
  const zeroed = Buffer.from(whole);
  const start = ftyp().length + 8;
  zeroed.fill(0, start, start + moov(stco(40)).length - 8);
  assert.match(judge('a.mp4', zeroed).reason, /mvhd/);
  assert.match(judge('a.mp4', mp4(stco(40, 1000000))).reason, /위치표/);
  assert.match(judge('a.mp4', Buffer.concat([ftyp(), box('moov', box('mvhd', Buffer.alloc(100)))])).reason, /트랙/);
  // 끝이 0으로 채워진 파일: 미리 자리를 잡고 받다 멈춘 파일이 이렇다.
  assert.match(judge('a.mp4', Buffer.concat([mp4(), Buffer.alloc(64)])).reason, /0으로 채워/);
});

test('조각으로 나뉜 MP4의 빈 위치표는 정상이다', () => {
  assert.strictEqual(judge('a.mp4', Buffer.concat([ftyp(), moov(stco()), box('moof', Buffer.alloc(16)), box('mdat', Buffer.alloc(16))])), null);
});

test('MKV의 잘린 Cluster, 없는 Tracks, 손상된 요소를 찾는다', () => {
  const whole = mkv(tracks(), cluster());
  assert.match(judge('a.mkv', whole.subarray(0, whole.length - 10)).reason, /Segment.*잘린/);
  assert.match(judge('a.mkv', mkv(cluster())).reason, /Tracks/);
  assert.match(judge('a.mkv', mkv(tracks(), Buffer.alloc(32))).reason, /요소가 손상/);
  assert.match(judge('a.mkv', ebml()).reason, /Segment/);
});

test('크기를 모르는 MKV 요소를 만나면 판단을 멈춘다', () => {
  const unknown = Buffer.concat([Buffer.from('1f43b675', 'hex'), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.alloc(16)]);
  const live = Buffer.concat([ebml(), Buffer.from('18538067', 'hex'), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), tracks(), unknown]);
  assert.strictEqual(judge('a.webm', live), null);
});

test('잘린 zip과 항목 머리글이 틀린 zip을 찾는다', () => {
  const whole = zip();
  assert.match(judge('a.zip', whole.subarray(0, whole.length - 30)).reason, /끝 표시/);
  const damaged = Buffer.from(whole);
  damaged.fill(0, 0, 4);
  damaged.write('PK\x07\x08', 0, 'latin1');
  assert.match(judge('a.zip', damaged).reason, /항목의 머리글/);
  const beyond = Buffer.from(whole);
  beyond.writeUInt32LE(1000, beyond.length - 22 + 16);
  assert.match(judge('a.zip', beyond).reason, /목록이 끝 표시/);
  assert.match(judge('a.docx', whole.subarray(0, 20)).reason, /끝 표시/);
});

test('분할 zip과 Zip64는 이 방식으로 판단하지 않는다', () => {
  const split = zip();
  split.writeUInt16LE(1, split.length - 22 + 4);
  assert.strictEqual(judge('a.zip', split), null);
  const large = zip();
  large.writeUInt32LE(0xffffffff, large.length - 22 + 16);
  assert.strictEqual(judge('a.zip', large), null);
});

test('잘린 7z와 머리글이 손상된 7z를 찾는다', () => {
  assert.match(judge('a.7z', sevenZip({ nextOffset: 100, nextSize: 4 })).reason, /잘린/);
  assert.match(judge('a.7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])).reason, /머리글이 잘렸/);
  const damaged = sevenZip();
  damaged[14] ^= 0xff;
  assert.match(judge('a.7z', damaged).reason, /머리글이 손상/);
});

test('잘린 tar.gz를 찾는다', () => {
  const big = Buffer.concat([tar().subarray(0, 512), crypto.randomBytes(512), Buffer.alloc(1024)]);
  const whole = zlib.gzipSync(big);
  assert.strictEqual(judge('a.tgz', whole.subarray(0, whole.length - 200)).status, 'broken');
});

test('tar.exe를 실행하지 못하면 깨졌다고 하지 않고 판단 못함으로 둔다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.tar'), tar());
  tarFailure = Object.assign(new Error('없음'), { code: 'ENOENT', syscall: 'spawnSync' });
  const result = findBroken(dir);
  tarFailure = null;
  assert.deepStrictEqual(result.broken, []);
  assert.strictEqual(result.unreadable.length, 1);
  assert.match(result.unreadable[0].reason, /ENOENT/);
});

test('잘린 RIFF를 찾는다', () => {
  assert.match(judge('a.avi', Buffer.concat([latin('RIFF'), u32le(1000), latin('AVI ')])).reason, /RIFF/);
  assert.strictEqual(judge('a.avi', Buffer.concat([latin('RIFF'), u32le(0), latin('AVI ')])), null);
});

test('잠겨서 읽지 못한 파일은 깨졌다고 하지 않는다', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), mp4());
  const { openSync } = fs;
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (String(file).endsWith('a.mp4')) throw Object.assign(new Error('잠김'), { code: 'EBUSY', syscall: 'open' });
    return openSync(file, ...rest);
  });
  const result = findBroken(dir);
  t.mock.restoreAll();
  assert.deepStrictEqual(result.broken, []);
  assert.strictEqual(result.unreadable.length, 1);
  assert.match(result.unreadable[0].reason, /EBUSY/);
});

test('파일을 건드리지 않고, 기록 파일과 저장소와 링크와 잔여물은 판별에서 뺀다', () => {
  const dir = tempDir();
  const files = {
    'fctl-removed-2026-11-02-120000.json': '{}',
    'repo/.git/a.mp4': '깨짐',
    '.fctl-new-1-2-3/a.mp4': '깨짐',
    'sub/a.mp4': '깨짐',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'link'), 'junction');
  const before = fs.readFileSync(path.join(dir, 'sub', 'a.mp4'));
  const result = findBroken(dir);
  assert.deepStrictEqual(result.broken.map((item) => path.relative(dir, item.path)), [path.join('sub', 'a.mp4')]);
  assert.deepStrictEqual(result.broken[0].size, before.length);
  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.skipped.length, 2);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'sub', 'a.mp4')), before);
  assert.ok(fs.existsSync(path.join(dir, 'fctl-removed-2026-11-02-120000.json')));
});

test('formatBroken은 상태별 줄과 개수를 보여 준다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), '깨짐');
  fs.writeFileSync(path.join(dir, 'b.jpg'), png());
  const report = formatBroken(findBroken(dir));
  assert.match(report, /깨짐: a\.mp4 \(/);
  assert.match(report, /의심: b\.jpg \(/);
  assert.match(report, /살펴본 파일 2개, 깨짐 1개, 의심 1개, 판단 못함 0개, 건너뜀 0개/);
});

test('fctl find-broken은 보고만 하고 성공으로 끝난다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), '깨짐');
  assert.match(run(['find-broken', dir]), /깨짐: a\.mp4/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});
