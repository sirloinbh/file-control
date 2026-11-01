'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// commands.js가 불러올 때 spawnSync를 받아 두므로 require보다 먼저 바꿔 둔다.
const realSpawnSync = childProcess.spawnSync;
let tarResult = null;
test.mock.method(childProcess, 'spawnSync', (...args) => tarResult ?? realSpawnSync(...args));

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

test('앞부분이 모두 0이거나 웹 페이지면 깨졌다고 본다', () => {
  for (const name of ['a.mp4', 'a.mkv', 'a.jpg', 'a.zip', 'a.7z', 'a.rar', 'a.pdf']) {
    assert.strictEqual(judge(name, latin('<html>찾을 수 없음</html>')).status, 'broken', name);
    assert.strictEqual(judge(name, latin('\r\n<!DOCTYPE html><html></html>')).status, 'broken', name);
    assert.strictEqual(judge(name, Buffer.alloc(2048)).status, 'broken', name);
  }
});

test('앞 바이트가 맞지 않아도 정상일 수 있는 파일은 의심으로 둔다', () => {
  const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  const cases = {
    'a.docx': ole2,
    'a.xlsx': ole2,
    'a.pdf': Buffer.concat([latin('DRM 포장'), Buffer.alloc(2048, 0x41)]),
    'a.mp4': Buffer.alloc(376, 0x47),
    'a.m4a': latin('ID3\x04\x00 음악'),
    'a.flac': latin('ID3\x04\x00fLaC'),
    'a.tif': Buffer.from([0x49, 0x49, 0x2b, 0x00, 8, 0]),
    'a.png': latin('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    'a.jar': latin('#!/bin/sh\nexec java -jar "$0"\n'),
    'b.mp4': Buffer.concat([u32(16), latin('uuid'), Buffer.alloc(8, 1)]),
    'a.tar.gz': tar(),
  };
  for (const [name, content] of Object.entries(cases)) assert.strictEqual(judge(name, content)?.status, 'suspect', name);
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
  // 앞쪽까지 받고 나머지는 0인 파일: moov가 뒤에 올 자리가 비어 있다.
  assert.strictEqual(judge('a.mp4', Buffer.concat([ftyp(), Buffer.alloc(4096)])).status, 'broken');
});

test('MP4 구조가 온전하면 뒤에 붙은 데이터는 의심으로만 둔다', () => {
  for (const tail of [Buffer.alloc(64), Buffer.alloc(4096), latin('뒤에 붙은 글입니다.'), Buffer.alloc(32, 0xff)]) {
    assert.strictEqual(judge('a.mp4', Buffer.concat([mp4(), tail])).status, 'suspect');
  }
  assert.strictEqual(judge('a.mp4', Buffer.concat([mp4(), box('free', Buffer.alloc(8))])), null);
  assert.strictEqual(judge('a.mp4', Buffer.concat([mp4(), Buffer.alloc(4)])), null);
});

test('옛 QuickTime과 참조형 MOV는 깨졌다고 하지 않는다', () => {
  assert.strictEqual(judge('a.mov', Buffer.concat([box('moov', box('cmov', Buffer.alloc(32)))])), null);
  assert.strictEqual(judge('a.mov', Buffer.concat([box('moov', box('rmra', Buffer.alloc(32)))])), null);
  const external = box('moov', box('mvhd', Buffer.alloc(100)), box('trak', box('mdia', box('minf', box('dinf', box('dref', u32(0), u32(1), box('alis', u32(0), latin('다른 파일.mov')))), box('stbl', stco(1000000))))));
  assert.strictEqual(judge('a.mov', Buffer.concat([ftyp(), external])), null);
  const selfContained = box('moov', box('mvhd', Buffer.alloc(100)), box('trak', box('mdia', box('minf', box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1)))), box('stbl', stco(1000000))))));
  assert.strictEqual(judge('a.mov', Buffer.concat([ftyp(), selfContained])).status, 'broken');
});

test('위치 문자열이 없는 dref는 이 파일로 보고 위치표를 검사한다', () => {
  const noLocation = box('moov', box('mvhd', Buffer.alloc(100)), box('trak', box('mdia', box('minf', box('dinf', box('dref', u32(0), u32(1), box('url ', u32(0)))), box('stbl', stco(1000000))))));
  assert.strictEqual(judge('a.mp4', Buffer.concat([ftyp(), noLocation])).status, 'broken');
});

test('moov 없이 조각만 있는 MP4는 의심이고, 잘린 조각은 깨짐이다', () => {
  const fragment = [box('moof', Buffer.alloc(16)), box('mdat', Buffer.alloc(16))];
  assert.strictEqual(judge('a.mp4', Buffer.concat([box('styp', latin('msdh')), box('sidx', Buffer.alloc(16)), ...fragment])).status, 'suspect');
  assert.strictEqual(judge('a.m4v', Buffer.concat([box('styp', latin('msdh')), ...fragment])).status, 'suspect');
  assert.strictEqual(judge('a.mp4', Buffer.concat([ftyp(), ...fragment])).status, 'suspect');
  const whole = Buffer.concat([ftyp(), ...fragment]);
  assert.strictEqual(judge('a.mp4', whole.subarray(0, whole.length - 4)).status, 'broken');
});

test('moov 끝에 쓰레기가 있어도 트랙이 온전하면 의심이다', () => {
  const junk = box('moov', box('mvhd', Buffer.alloc(100)), trak(stco(40)), Buffer.alloc(16, 0xee));
  assert.strictEqual(judge('a.mp4', Buffer.concat([ftyp(), junk, box('mdat', Buffer.alloc(64))])).status, 'suspect');
});

test('MP4 트랙 일부만 틀리면 의심, 모두 틀리면 깨짐이다', () => {
  const good = trak(stco(40));
  const odd = box('trak', Buffer.alloc(16));
  const withTracks = (...tracks) => Buffer.concat([ftyp(), box('moov', box('mvhd', Buffer.alloc(100)), ...tracks), box('mdat', Buffer.alloc(64))]);
  assert.strictEqual(judge('a.mp4', withTracks(good, odd)).status, 'suspect');
  assert.strictEqual(judge('a.mp4', withTracks(odd)).status, 'broken');
  assert.strictEqual(judge('a.mp4', Buffer.concat([ftyp(), box('moov', box('mvhd', Buffer.alloc(100)), box('mvex', Buffer.alloc(8)))])).status, 'suspect');
});

test('조각으로 나뉜 MP4의 빈 위치표는 정상이다', () => {
  assert.strictEqual(judge('a.mp4', Buffer.concat([ftyp(), moov(stco()), box('moof', Buffer.alloc(16)), box('mdat', Buffer.alloc(16))])), null);
});

test('MKV의 잘린 Cluster, 없는 Tracks, 손상된 요소를 찾는다', () => {
  const whole = mkv(tracks(), cluster());
  assert.match(judge('a.mkv', whole.subarray(0, whole.length - 10)).reason, /Segment.*잘린/);
  assert.match(judge('a.mkv', mkv(cluster())).reason, /Tracks/);
  assert.match(judge('a.mkv', mkv(Buffer.alloc(32))).reason, /요소가 손상/);
  assert.match(judge('a.mkv', ebml()).reason, /Segment/);
});

test('MKV의 Segment 앞 Void는 정상이고, Tracks 뒤의 패딩은 의심으로만 둔다', () => {
  assert.strictEqual(judge('a.mkv', Buffer.concat([ebml(), element('ec', Buffer.alloc(8)), element('18538067', tracks(), cluster())])), null);
  assert.strictEqual(judge('a.mkv', mkv(tracks(), Buffer.alloc(32))).status, 'suspect');
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

test('zip 주석 안의 끝 표시에 속지 않고, 뒤에 붙은 데이터는 의심으로만 둔다', () => {
  const whole = zip();
  const comment = latin('주석 PK\x05\x06 끝');
  const commented = Buffer.concat([whole, comment]);
  commented.writeUInt16LE(comment.length, whole.length - 2);
  assert.strictEqual(judge('a.zip', commented), null);
  assert.strictEqual(judge('a.zip', Buffer.concat([whole, latin('뒤에 붙음')])).status, 'suspect');
  const fake = Buffer.alloc(22, 0xff);
  fake.write('PK\x05\x06', 0, 'latin1');
  assert.strictEqual(judge('a.zip', Buffer.concat([whole, fake])).status, 'suspect');
  assert.strictEqual(judge('a.zip', Buffer.concat([zip('a.txt', '앞쪽 내용입니다'), zip('b.txt', '뒤')])).status, 'suspect');
});

test('너무 큰 zip 목록은 메모리에 올리지 않고 판단 못함으로 둔다', () => {
  const dir = tempDir();
  const content = zip();
  // 끝 레코드까지 실제로 넘지 않게 파일을 키우고 목록 크기를 크게 적는다.
  const file = path.join(dir, 'a.zip');
  const big = 65 * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, content.subarray(0, content.length - 22), 0);
  const end = Buffer.from(content.subarray(content.length - 22));
  end.writeUInt32LE(big, 12);
  end.writeUInt32LE(0, 16);
  fs.writeSync(fd, end, 0, end.length, big + 100);
  fs.closeSync(fd);
  const result = findBroken(dir);
  assert.deepStrictEqual(result.broken, []);
  assert.match(result.unreadable[0].reason, /너무 커/);
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

test('tar.exe가 손상이라고 알린 파일만 깨졌다고 본다', { skip: process.platform !== 'win32' }, () => {
  const big = Buffer.concat([tar().subarray(0, 512), crypto.randomBytes(512), Buffer.alloc(1024)]);
  const whole = zlib.gzipSync(big);
  assert.strictEqual(judge('a.tgz', whole.subarray(0, whole.length - 200)).status, 'broken');
  assert.strictEqual(judge('a.tgz', whole.subarray(0, 10)).status, 'broken');
  const longer = Buffer.concat([tar().subarray(0, 1024), Buffer.alloc(0)]);
  longer.write('00000010000\0', 124, 'latin1');
  longer.write('        ', 148, 'latin1');
  const sum = longer.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  longer.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  assert.strictEqual(judge('a.tar', longer).status, 'broken');
  // 종료 코드가 0이어도 손상 문구가 있으면 깨짐이다.
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.tar'), tar());
  tarResult = { status: 0, stdout: Buffer.from('a.txt\n'), stderr: Buffer.from('tar.exe: Damaged tar archive (bad header checksum)\ntar.exe: Retrying...\n') };
  const damaged = findBroken(dir);
  tarResult = null;
  assert.strictEqual(damaged.broken.length, 1);
});

test('잘린 tar와 작은 tar.xz를 실제 tar.exe로 찾는다', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir();
  const source = path.join(dir, 'src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'a.txt'), '작은 파일');
  fs.writeFileSync(path.join(source, 'b.txt'), '작은 파일 둘');
  const TAR = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  const made = (name, ...flags) => {
    const file = path.join(dir, name);
    realSpawnSync(TAR, [...flags, '-cf', file, '-C', source, '.'], { stdio: 'ignore' });
    return fs.readFileSync(file);
  };
  const xz = made('w.tar.xz', '-J');
  assert.strictEqual(judge('a.tar.xz', xz.subarray(0, xz.length >> 1)).status, 'broken');
  const plain = made('w.tar', '--format', 'ustar');
  // 두 번째 항목 머리글 중간에서 자른다.
  assert.strictEqual(judge('a.tar', plain.subarray(0, 512 + 512 + 100)).status, 'broken');
});

test('압축 해제 오류와 잘림 문구는 깨짐이다', () => {
  const phrases = [
    'tar.exe: Truncated tar archive detected while reading next header',
    'tar.exe: Error opening archive: Truncated tar archive detected while reading pax attribute name',
    'tar.exe: Lzma library error:  No progress is possible',
    'tar.exe: Lzma library error:  Corrupted input data',
    'tar.exe: bzip decompression failed',
  ];
  for (const phrase of phrases) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.tar'), tar());
    tarResult = { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(`${phrase}\n`) };
    const result = findBroken(dir);
    tarResult = null;
    assert.strictEqual(result.broken.length, 1, phrase);
  }
});

test('tar로 읽을 수 없는 형식은 의심, 항목이 없으면 의심이다', { skip: process.platform !== 'win32' }, () => {
  assert.strictEqual(judge('a.tar', latin('tar가 아닌 글\n'.repeat(100))).status, 'suspect');
  assert.strictEqual(judge('a.tar.gz', zlib.gzipSync('tar가 아닌 글\n'.repeat(100))).status, 'suspect');
  assert.strictEqual(judge('a.tar', Buffer.alloc(1024)).status, 'suspect');
});

test('tar.exe의 그 밖의 실패는 깨졌다고 하지 않고 판단 못함으로 둔다', () => {
  const failures = [
    { error: Object.assign(new Error('없음'), { code: 'ENOENT' }), status: null },
    { error: Object.assign(new Error('한도'), { code: 'ENOBUFS' }), status: null, stdout: Buffer.alloc(0) },
    { error: Object.assign(new Error('시간'), { code: 'ETIMEDOUT' }), status: null },
    { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('tar.exe: Error reading C:/a.tar\n') },
    { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('tar.exe: Archive entry has empty or unreadable filename ... skipping.\ntar.exe: Error exit delayed from previous errors.\n') },
    { status: 0xc0000409, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    // 항목 이름에 든 말을 손상 문구로 오해하지 않는다.
    { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('tar.exe: Truncated input file: Failed to open\n'.replace(/^tar\.exe: /, 'tar.exe: a/')) },
  ];
  for (const failure of failures) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.tar'), tar());
    tarResult = failure;
    const result = findBroken(dir);
    tarResult = null;
    assert.deepStrictEqual(result.broken, []);
    assert.strictEqual(result.unreadable.length, 1);
    assert.match(result.unreadable[0].reason, /판단하지 않았습니다/);
  }
});

test('파일 하나의 예상 밖 오류가 다른 파일의 결과를 지우지 않는다', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), Buffer.alloc(16));
  fs.writeFileSync(path.join(dir, 'b.mp4'), mp4());
  const { fstatSync } = fs;
  let calls = 0;
  t.mock.method(fs, 'fstatSync', (...args) => {
    calls += 1;
    if (calls === 3) throw new RangeError('예상 밖');
    return fstatSync(...args);
  });
  const result = findBroken(dir);
  t.mock.restoreAll();
  assert.strictEqual(result.broken.length + result.unreadable.length, 2);
});

test('잘린 RIFF를 찾는다', () => {
  assert.match(judge('a.avi', Buffer.concat([latin('RIFF'), u32le(1000), latin('AVI ')])).reason, /RIFF/);
  assert.strictEqual(judge('a.avi', Buffer.concat([latin('RIFF'), u32le(0), latin('AVI ')])), null);
  // 크기 칸에 파일 전체 크기를 적는 프로그램도 있다.
  assert.strictEqual(judge('a.wav', Buffer.concat([latin('RIFF'), u32le(12), latin('WAVE')])), null);
  // 파이프로 쓴 파일은 크기 칸이 2GB 언저리일 수 있다.
  for (const value of [0x7ffff024, 0x7fffffff]) assert.strictEqual(judge('a.wav', Buffer.concat([latin('RIFF'), u32le(value), latin('WAVE')])).status, 'suspect');
});

test('RIFF 검사는 RIFF 형식에만 한다', { skip: process.platform !== 'win32' }, () => {
  const named = Buffer.from(tar());
  named.write('RIFF.txt', 0, 'latin1');
  named.write('        ', 148, 'latin1');
  const sum = named.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  named.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  assert.strictEqual(judge('a.tar', named), null);
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
    'repo/.git/a.mp4': '<html></html>',
    '.fctl-new-1-2-3/a.mp4': '<html></html>',
    'sub/a.mp4': '<html></html>',
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
  fs.writeFileSync(path.join(dir, 'a.mp4'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'b.jpg'), png());
  const report = formatBroken(findBroken(dir));
  assert.match(report, /깨짐: a\.mp4 \(/);
  assert.match(report, /의심: b\.jpg \(/);
  assert.match(report, /살펴본 파일 2개, 깨짐 1개, 의심 1개, 판단 못함 0개, 건너뜀 0개/);
});

test('fctl find-broken은 보고만 하고 성공으로 끝난다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), '<html></html>');
  assert.match(run(['find-broken', dir]), /깨짐: a\.mp4/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});
