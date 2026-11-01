'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { readMp4Metadata } = require('../src/mp4');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mp4-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

const latin = (text) => Buffer.from(text, 'latin1');
const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};
const u64 = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return b;
};

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), latin(type), body]);
}

function largeBox(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(1), latin(type), u64(body.length + 16), body]);
}

const ftyp = () => box('ftyp', latin('isom'), u32(512), latin('isommp42'));

function mvhd({ timescale = 1000, duration = 10000, version = 0 } = {}) {
  if (version === 1) return box('mvhd', u32(0x01000000), u64(0), u64(0), u32(timescale), u64(duration), Buffer.alloc(80));
  return box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80));
}

function tkhd({ width = 0, height = 0, duration = 0, flags = 3, version = 0 } = {}) {
  const tail = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(36), u32(width * 65536), u32(height * 65536)];
  if (version === 1) return box('tkhd', u32(0x01000000 | flags), u64(0), u64(0), u32(1), u32(0), u64(duration), ...tail);
  return box('tkhd', u32(flags), u32(0), u32(0), u32(1), u32(0), u32(duration), ...tail);
}

function hdlr(kind) {
  return box('hdlr', u32(0), u32(0), latin(kind), Buffer.alloc(13));
}

function stsd(width, height, format = 'avc1') {
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  return box('stsd', u32(0), u32(1), box(format, entry));
}

function trak({ kind = 'vide', width = 1920, height = 1080, display, duration = 10000, flags = 3, version = 0 } = {}) {
  const shown = display ?? { width, height };
  return box(
    'trak',
    tkhd({ ...shown, duration, flags, version }),
    box('mdia', hdlr(kind), box('minf', box('stbl', stsd(kind === 'vide' ? width : 0, kind === 'vide' ? height : 0)))),
  );
}

// ilst 항목. kind 1은 UTF-8, 2는 UTF-16BE다.
function item(type, text, kind = 1) {
  const value = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return box(type, box('data', u32(kind), u32(0), value));
}

// keys 번호로 찾는 ilst 항목
function numbered(index, text) {
  const value = box('data', u32(1), u32(0), latin(text));
  return Buffer.concat([u32(value.length + 8), u32(index), value]);
}

const isoMeta = (...items) => box('meta', u32(0), hdlr('mdir'), box('ilst', ...items));

function write(dir, ...parts) {
  fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.concat(parts));
  return readMp4Metadata(dir, 'v.mp4');
}

test('readMp4Metadata는 제목, 코멘트, 길이, 해상도, 비트레이트를 꺼낸다', () => {
  const dir = tempDir();
  const parts = [ftyp(), box('moov', mvhd(), trak(), box('udta', isoMeta(item('©nam', 'ABC-123 제목'), item('©cmt', '설명')))), box('mdat', Buffer.alloc(5000))];
  const size = Buffer.concat(parts).length;
  assert.deepStrictEqual(write(dir, ...parts), {
    title: 'ABC-123 제목',
    comment: '설명',
    duration: 10,
    width: 1920,
    height: 1080,
    bitrate: Math.round((size * 8) / 10),
  });
});

test('찾지 못한 값은 null이다', () => {
  const dir = tempDir();
  assert.deepStrictEqual(write(dir, ftyp(), box('moov', box('free', Buffer.alloc(4)))), {
    title: null,
    comment: null,
    duration: null,
    width: null,
    height: null,
    bitrate: null,
  });
});

test('moov가 mdat 뒤에 있어도 찾고, mdat 내용은 읽지 않는다', () => {
  const dir = tempDir();
  // mdat 안에 가짜 moov가 있어도 속지 않는다.
  const fake = box('moov', mvhd({ duration: 99000 }));
  const result = write(dir, ftyp(), box('mdat', fake), box('moov', mvhd()));
  assert.strictEqual(result.duration, 10);
});

test('64비트 크기 박스와 버전 1 박스를 읽는다', () => {
  const dir = tempDir();
  const result = write(
    dir,
    ftyp(),
    largeBox('mdat', Buffer.alloc(100)),
    largeBox('moov', mvhd({ version: 1, timescale: 600, duration: 6000 }), trak({ version: 1, width: 640, height: 360 })),
  );
  assert.strictEqual(result.duration, 10);
  assert.strictEqual(result.width, 640);
  assert.strictEqual(result.height, 360);
});

test('크기 0인 마지막 최상위 박스는 파일 끝까지다', () => {
  const dir = tempDir();
  const moov = box('moov', mvhd());
  moov.writeUInt32BE(0, 0);
  assert.strictEqual(write(dir, ftyp(), moov).duration, 10);
  const mdat = Buffer.concat([u32(0), latin('mdat'), Buffer.alloc(32)]);
  assert.throws(() => write(dir, ftyp(), mdat), /moov 박스가 없습니다/);
});

test('ftyp이 없는 옛 QuickTime 파일을 읽는다', () => {
  const dir = tempDir();
  assert.strictEqual(write(dir, box('moov', mvhd())).duration, 10);
  assert.strictEqual(write(dir, box('wide'), box('mdat', Buffer.alloc(8)), box('moov', mvhd())).duration, 10);
});

test('길이가 정해지지 않았으면 mehd를 쓰고, 없으면 null이다', () => {
  const dir = tempDir();
  const mvex = box('mvex', box('mehd', u32(0), u32(30000)));
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd({ duration: 0 }), mvex)).duration, 30);
  const mvex1 = box('mvex', box('mehd', u32(0x01000000), u64(5000)));
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd({ duration: 0 }), mvex1)).duration, 5);
  for (const bad of [mvhd({ duration: 0 }), mvhd({ duration: 0xffffffff }), mvhd({ version: 1, duration: 0xffffffffffffffffn }), mvhd({ timescale: 0 })]) {
    const result = write(dir, ftyp(), box('moov', bad));
    assert.strictEqual(result.duration, null);
    assert.strictEqual(result.bitrate, null);
  }
});

test('소리 트랙만 있으면 해상도는 null이다', () => {
  const dir = tempDir();
  const result = write(dir, ftyp(), box('moov', mvhd(), trak({ kind: 'soun' })));
  assert.strictEqual(result.width, null);
  assert.strictEqual(result.height, null);
  assert.strictEqual(result.duration, 10);
});

test('해상도는 인코딩 값을 먼저 쓰고, 0이면 화면 크기를 쓴다', () => {
  const dir = tempDir();
  const anamorphic = trak({ width: 720, height: 480, display: { width: 853, height: 480 } });
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), anamorphic)).width, 720);
  const noSample = trak({ width: 0, height: 0, display: { width: 853, height: 480 } });
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), noSample)).width, 853);
});

test('표지 그림 트랙이 더 커도 본편 해상도를 고른다', () => {
  const dir = tempDir();
  const main = trak({ width: 640, height: 360, duration: 10000 });
  const short = trak({ width: 1400, height: 1400, duration: 40 });
  const off = trak({ width: 3000, height: 3000, duration: 99999, flags: 2 });
  for (const order of [
    [main, short, off],
    [off, short, main],
  ]) {
    const result = write(dir, ftyp(), box('moov', mvhd(), ...order));
    assert.deepStrictEqual([result.width, result.height], [640, 360]);
  }
});

test('재생 시간이 같으면 큰 트랙을, 모두 꺼졌으면 그중에서 고른다', () => {
  const dir = tempDir();
  const small = trak({ width: 320, height: 180 });
  const big = trak({ width: 1280, height: 720 });
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), small, big)).width, 1280);
  const off = trak({ width: 800, height: 450, flags: 0 });
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), off)).width, 800);
});

test('QuickTime 형식 meta(버전·플래그 없음)의 iTunes 항목을 읽는다', () => {
  const dir = tempDir();
  const meta = box('meta', hdlr('mdir'), box('ilst', item('©nam', 'T')));
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', meta))).title, 'T');
});

test('QuickTime 키(mdta) 항목을 읽는다', () => {
  const dir = tempDir();
  const key = (name) => box('mdta', Buffer.from(name, 'utf8'));
  const meta = box(
    'meta',
    hdlr('mdta'),
    box('keys', u32(0), u32(2), key('com.apple.quicktime.title'), key('com.apple.quicktime.description')),
    box('ilst', numbered(1, 'Tt'), numbered(2, 'Dd'), numbered(9, 'Xx')),
  );
  const result = write(dir, ftyp(), box('moov', meta));
  assert.strictEqual(result.title, 'Tt');
  assert.strictEqual(result.comment, 'Dd');
});

test('옛 QuickTime과 3GPP 항목을 읽고, iTunes 형식을 먼저 쓴다', () => {
  const dir = tempDir();
  const classic = (type, text) => {
    const value = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt16BE(value.length, 0);
    head.writeUInt16BE(0x55c4, 2);
    return box(type, head, value, Buffer.from([0, 2, 0, 0, 0x41, 0x42]));
  };
  const gpp = (type, value) => box(type, u32(0), Buffer.from([0x15, 0xc7]), value);
  let result = write(dir, ftyp(), box('moov', box('udta', classic('©nam', '옛제목'), classic('©cmt', '옛코멘트'))));
  assert.strictEqual(result.title, '옛제목');
  assert.strictEqual(result.comment, '옛코멘트');
  result = write(dir, ftyp(), box('moov', box('udta', gpp('titl', Buffer.from('3gp\0', 'utf8')), gpp('dscp', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0, 0x41])])))));
  assert.strictEqual(result.title, '3gp');
  assert.strictEqual(result.comment, 'A');
  result = write(dir, ftyp(), box('moov', box('udta', classic('©nam', '옛'), isoMeta(item('©nam', '새')))));
  assert.strictEqual(result.title, '새');
});

test('코멘트가 없으면 설명 항목을 쓴다', () => {
  const dir = tempDir();
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(item('desc', 'D'), item('ldes', 'L'))))).comment, 'D');
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(item('ldes', 'L'), item('©cmt', 'C'))))).comment, 'C');
});

test('글자 값을 디코드하고, 글자가 아니거나 빈 값은 없는 것으로 본다', () => {
  const dir = tempDir();
  const utf16 = Buffer.from([0xd5, 0x5c, 0xae, 0x00]);
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(item('©nam', utf16, 2))))).title, '한글');
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(item('©nam', '  앞뒤 \0쓰레기'))))).title, '앞뒤');
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(item('©nam', Buffer.from([1, 2, 3]), 21))))).title, null);
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(item('©nam', '   '))))).title, null);
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(box('©nam'))))).title, null);
});

test('값이 너무 크면 없는 것으로 보고 메모리에 올리지 않는다', () => {
  const dir = tempDir();
  const big = item('©nam', Buffer.alloc(64 * 1024 + 1, 0x41));
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(big, item('©cmt', 'C'))))).title, null);
  assert.strictEqual(write(dir, ftyp(), box('moov', box('udta', isoMeta(big, item('©cmt', 'C'))))).comment, 'C');
});

test('udta 끝의 0 표시를 손상으로 보지 않는다', () => {
  const dir = tempDir();
  const result = write(dir, ftyp(), box('moov', mvhd(), box('udta', isoMeta(item('©nam', 'T')), u32(0))));
  assert.strictEqual(result.title, 'T');
  assert.strictEqual(result.duration, 10);
});

test('제목 쪽이 손상돼도 찾은 값과 나머지 값을 돌려준다', () => {
  const dir = tempDir();
  const badItem = Buffer.concat([u32(9999), latin('©cmt'), latin('xx')]);
  const meta = box('meta', u32(0), hdlr('mdir'), box('ilst', item('©nam', 'T'), badItem));
  const result = write(dir, ftyp(), box('moov', box('udta', meta, Buffer.concat([u32(4), latin('oops')])), mvhd()));
  assert.strictEqual(result.title, 'T');
  assert.strictEqual(result.comment, null);
  assert.strictEqual(result.duration, 10);
});

test('MP4/MOV가 아니면 거부한다', () => {
  const dir = tempDir();
  for (const bad of [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('%PDF-1.7 aaaaaaaaaaaaaaaa'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])]) {
    assert.throws(() => write(dir, bad), (err) => err instanceof FcError && /MP4\/MOV 형식이 아닙니다/.test(err.message));
  }
});

test('손상된 구조를 거부한다', () => {
  const dir = tempDir();
  const noMoov = /moov 박스가 없습니다/;
  assert.throws(() => write(dir, ftyp()), noMoov);
  // mdat이 잘린 파일
  assert.throws(() => write(dir, ftyp(), u32(9999), latin('mdat'), Buffer.alloc(8)), noMoov);
  // 크기가 헤더보다 작은 박스, 파일을 넘는 64비트 크기
  assert.throws(() => write(dir, ftyp(), u32(4), latin('free'), Buffer.alloc(8)), noMoov);
  assert.throws(() => write(dir, ftyp(), u32(1), latin('free'), u64(0xffffffffffffffffn)), noMoov);
  // moov가 잘린 파일
  assert.throws(() => write(dir, ftyp(), u32(9999), latin('moov'), Buffer.alloc(8)), /moov 박스가 잘렸습니다/);
  // 부모를 넘는 자식
  const overflow = Buffer.concat([u32(9999), latin('trak'), Buffer.alloc(8)]);
  assert.throws(() => write(dir, ftyp(), box('moov', overflow)), /구조가 손상됐습니다/);
});

test('값이 잘린 필수 박스는 없는 값으로 본다', () => {
  const dir = tempDir();
  const short = (type) => box(type, Buffer.alloc(3));
  const result = write(dir, ftyp(), box('moov', short('mvhd'), box('trak', short('tkhd'), box('mdia', hdlr('vide')))));
  assert.strictEqual(result.duration, null);
  assert.strictEqual(result.width, null);
});

test('작은 박스를 끝없이 늘어놓은 파일은 읽기를 멈춘다', () => {
  const dir = tempDir();
  const many = Buffer.alloc(8 * 30000);
  for (let i = 0; i < 30000; i += 1) {
    many.writeUInt32BE(8, i * 8);
    many.write('free', i * 8 + 4, 'latin1');
  }
  assert.throws(() => write(dir, ftyp(), many), /박스가 너무 많아/);
});

test('타겟 밖과 없는 파일, 폴더는 거부한다', () => {
  const dir = tempDir();
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, 'o.mp4'), Buffer.concat([ftyp(), box('moov', mvhd())]));
  fs.mkdirSync(path.join(dir, 'd'));
  assert.throws(() => readMp4Metadata(dir, path.join(outside, 'o.mp4')), /타겟 폴더 밖/);
  assert.throws(() => readMp4Metadata(dir, 'none.mp4'), FcError);
  assert.throws(() => readMp4Metadata(dir, 'd'), /파일이 아닙니다/);
});

test('mehd가 있으면 mvhd보다 먼저 쓴다', () => {
  const dir = tempDir();
  const mvex = box('mvex', box('mehd', u32(0), u32(100000)));
  const result = write(dir, ftyp(), box('moov', mvhd({ duration: 1000 }), mvex));
  assert.strictEqual(result.duration, 100);
});

test('알 수 없는 버전과 안전 범위를 넘는 길이는 없는 값으로 본다', () => {
  const dir = tempDir();
  const v2 = (type, size) => box(type, u32(0x02000000), Buffer.alloc(size));
  assert.strictEqual(write(dir, ftyp(), box('moov', v2('mvhd', 96))).duration, null);
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd({ duration: 0 }), box('mvex', v2('mehd', 8)))).duration, null);
  const track = box('trak', v2('tkhd', 92), box('mdia', hdlr('vide')));
  assert.strictEqual(write(dir, ftyp(), box('moov', track)).width, null);
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd({ version: 1, duration: 2n ** 53n }))).duration, null);
});

test('버전 1 tkhd의 크기, 길이, 켜짐 값을 읽는다', () => {
  const dir = tempDir();
  const shown = trak({ version: 1, width: 0, height: 0, display: { width: 853, height: 480 } });
  const result = write(dir, ftyp(), box('moov', shown));
  assert.deepStrictEqual([result.width, result.height], [853, 480]);
  const long = trak({ version: 1, width: 640, height: 360, duration: 5000 });
  const short = trak({ version: 1, width: 1400, height: 1400, duration: 40 });
  assert.strictEqual(write(dir, ftyp(), box('moov', short, long)).width, 640);
  const off = trak({ version: 1, width: 1400, height: 1400, duration: 9000, flags: 2 });
  assert.strictEqual(write(dir, ftyp(), box('moov', off, long)).width, 640);
});

test('표본 항목이 없으면 화면 크기를 쓴다', () => {
  const dir = tempDir();
  const noEntry = box('stsd', u32(0), u32(0), Buffer.alloc(36));
  const track = box('trak', tkhd({ width: 640, height: 360 }), box('mdia', hdlr('vide'), box('minf', box('stbl', noEntry))));
  assert.strictEqual(write(dir, ftyp(), box('moov', track)).width, 640);
});

test('QuickTime 형식 meta는 hdlr가 먼저 오지 않아도 읽는다', () => {
  const dir = tempDir();
  const onlyList = box('meta', box('ilst', item('©nam', 'T')));
  assert.strictEqual(write(dir, ftyp(), box('moov', onlyList)).title, 'T');
  const keysFirst = box('meta', box('keys', u32(0), u32(1), box('mdta', latin('com.apple.quicktime.title'))), hdlr('mdta'), box('ilst', numbered(1, 'K')));
  assert.strictEqual(write(dir, ftyp(), box('moov', keysFirst)).title, 'K');
  // 형식을 가를 4바이트도 없는 meta
  assert.strictEqual(write(dir, ftyp(), box('moov', box('meta', Buffer.alloc(3)))).title, null);
});

test('안쪽 박스의 크기 0은 끝 표시이고, 다른 틀린 크기는 strict일 때만 오류다', () => {
  const dir = tempDir();
  const zeros = Buffer.alloc(16);
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), zeros)).duration, 10);
  assert.strictEqual(write(dir, ftyp(), box('moov', zeros, mvhd())).duration, null);
  const tagged = write(dir, ftyp(), box('moov', mvhd(), box('udta', isoMeta(item('©nam', 'T')), zeros)));
  assert.strictEqual(tagged.title, 'T');
  for (const bad of [Buffer.concat([u32(4), latin('free')]), Buffer.concat([u32(7), latin('free')]), Buffer.concat([u32(1), latin('free')])]) {
    assert.throws(() => write(dir, ftyp(), box('moov', bad)), /구조가 손상됐습니다/);
    assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), box('udta', bad))).duration, 10);
  }
});

test('8바이트만 남은 64비트 크기 박스는 FcError다', () => {
  const dir = tempDir();
  assert.throws(() => write(dir, ftyp(), u32(1), latin('free')), (err) => err instanceof FcError && /moov 박스가 없습니다/.test(err.message));
});

test('keys의 틀린 값은 안전하게 무시한다', () => {
  const dir = tempDir();
  const ilst = box('ilst', numbered(1, 'T'), numbered(0, 'Z'));
  const withKeys = (keys) => write(dir, ftyp(), box('moov', box('meta', hdlr('mdta'), keys, ilst))).title;
  // 크기 0 항목과 큰 개수: 이름을 끝없이 늘리지 않는다.
  assert.strictEqual(withKeys(box('keys', u32(0), u32(0xffffffff), Buffer.alloc(64))), null);
  // 개수보다 많은 항목은 읽지 않는다.
  const title = box('mdta', latin('com.apple.quicktime.title'));
  assert.strictEqual(withKeys(box('keys', u32(0), u32(0), title)), null);
  // 남은 길이를 넘는 항목
  assert.strictEqual(withKeys(box('keys', u32(0), u32(1), u32(9999), latin('mdta'))), null);
  // 너무 큰 keys
  assert.strictEqual(withKeys(box('keys', u32(0), u32(1), title, Buffer.alloc(64 * 1024))), null);
});

test('옛 QuickTime과 3GPP의 틀린 길이와 너무 큰 값은 없는 값으로 본다', () => {
  const dir = tempDir();
  const udta = (...parts) => write(dir, ftyp(), box('moov', box('udta', ...parts)));
  const head = (size) => {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(size, 0);
    return b;
  };
  assert.strictEqual(udta(box('©nam', head(100), latin('ab'))).title, null);
  assert.strictEqual(udta(box('©nam', head(0), latin('ab'))).title, null);
  assert.strictEqual(udta(box('©nam', Buffer.alloc(3))).title, null);
  assert.strictEqual(udta(box('©nam', head(65000), Buffer.alloc(64 * 1024, 0x41))).title, null);
  assert.strictEqual(udta(box('titl', Buffer.alloc(6))).title, null);
  assert.strictEqual(udta(box('titl', Buffer.alloc(64 * 1024 + 1, 0x41))).title, null);
});

test('UTF-16LE BOM을 따른다', () => {
  const dir = tempDir();
  const value = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글', 'utf16le')]);
  const result = write(dir, ftyp(), box('moov', box('udta', box('titl', u32(0), Buffer.alloc(2), value))));
  assert.strictEqual(result.title, '한글');
});

test('경로와 입출력 문제는 FcError다', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.concat([ftyp(), box('moov', mvhd())]));
  for (const bad of ['v\0.mp4', undefined, 5, 'v.mp4:ads', 'v.mp4::$DATA']) {
    assert.throws(() => readMp4Metadata(dir, bad), FcError, String(bad));
  }
  t.mock.method(fs, 'readSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'read' });
  });
  assert.throws(() => readMp4Metadata(dir, 'v.mp4'), (err) => err instanceof FcError && /EBUSY/.test(err.message));
});

test('4GiB를 넘는 위치의 moov를 읽는다', (t) => {
  // 실제로 쓰면 디스크를 6GB 쓰므로 크기와 읽기만 흉내 낸다.
  const dir = tempDir();
  const gap = 6 * 2 ** 30;
  const head = Buffer.concat([ftyp(), u32(1), latin('mdat'), u64(gap + 16)]);
  const moov = box('moov', mvhd(), trak());
  const total = head.length + gap + moov.length;
  const file = path.join(dir, 'v.mp4');
  fs.writeFileSync(file, '');
  const { statSync, fstatSync } = fs;
  const withSize = (stat) => Object.create(stat, { size: { value: total } });
  t.mock.method(fs, 'statSync', (p, options) => (String(p) === file ? withSize(statSync(p, options)) : statSync(p, options)));
  t.mock.method(fs, 'fstatSync', (fd, options) => withSize(fstatSync(fd, options)));
  t.mock.method(fs, 'readSync', (fd, buffer, at, length, position) => {
    buffer.fill(0, at, at + length);
    if (position < head.length) return head.copy(buffer, at, position, Math.min(head.length, position + length));
    if (position >= head.length + gap) return moov.copy(buffer, at, position - head.length - gap, Math.min(moov.length, position - head.length - gap + length));
    return length;
  });
  const result = readMp4Metadata(dir, 'v.mp4');
  assert.strictEqual(result.width, 1920);
  assert.strictEqual(result.bitrate, Math.round((total * 8) / 10));
});

test('mdat과 표본 표, 큰 값의 내용은 읽지 않는다', (t) => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'v.mp4'),
    Buffer.concat([ftyp(), box('mdat', Buffer.alloc(2 ** 22)), box('moov', mvhd(), box('trak', box('mdia', box('minf', box('stbl', box('stsz', Buffer.alloc(2 ** 22)))))), box('udta', isoMeta(item('covr', Buffer.alloc(2 ** 22), 13))))]),
  );
  const readSync = t.mock.method(fs, 'readSync');
  assert.strictEqual(readMp4Metadata(dir, 'v.mp4').duration, 10);
  const bytes = readSync.mock.calls.reduce((sum, call) => sum + call.result, 0);
  assert.ok(bytes < 4096, `${bytes}바이트를 읽음`);
});
