'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { readMp4Metadata } = require('../src/mp4');
const { avcSps, hevcSps, avcC, hvcC } = require('./spsBuilder');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
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

// If rotate is given, it puts the rotation in the whole-movie matrix (mvhd). If absent, it fills with 0 like the old test files.
function mvhd({ timescale = 1000, duration = 10000, version = 0, rotate } = {}) {
  const tail = [Buffer.alloc(16), matrix(rotate), Buffer.alloc(28)];
  if (version === 1) return box('mvhd', u32(0x01000000), u64(0), u64(0), u32(timescale), u64(duration), ...tail);
  return box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(duration), ...tail);
}

// The transform matrix { a b u / c d v / x y w }. If rotate is absent, it fills with 0 like the old test files.
function matrix(rotate) {
  const m = Buffer.alloc(36);
  if (rotate === undefined) return m;
  const one = 0x10000;
  const [a, b, c, d] = { 0: [one, 0, 0, one], 90: [0, one, -one, 0], 180: [-one, 0, 0, -one], 270: [0, -one, one, 0] }[rotate];
  [a, b, 0, c, d, 0, 0, 0, 0x40000000].forEach((value, index) => m.writeInt32BE(value, index * 4));
  return m;
}

function tkhd({ width = 0, height = 0, duration = 0, flags = 3, version = 0, rotate } = {}) {
  const tail = [Buffer.alloc(8), Buffer.alloc(8), matrix(rotate), u32(width * 65536), u32(height * 65536)];
  if (version === 1) return box('tkhd', u32(0x01000000 | flags), u64(0), u64(0), u32(1), u32(0), u64(duration), ...tail);
  return box('tkhd', u32(flags), u32(0), u32(0), u32(1), u32(0), u32(duration), ...tail);
}

function hdlr(kind) {
  return box('hdlr', u32(0), u32(0), latin(kind), Buffer.alloc(13));
}

// pasp is the [horizontal, vertical] pixel aspect ratio. It is attached after avcC as a child box of the sample entry.
// If config is given, it uses that avcC or hvcC box (#113). If not given, it attaches an empty avcC only when there is a pasp.
function stsd(width, height, format = 'avc1', pasp, config) {
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const codec = config ?? (pasp ? box('avcC', Buffer.alloc(7)) : null);
  const extra = [...(codec ? [codec] : []), ...(pasp ? [box('pasp', u32(pasp[0]), u32(pasp[1]))] : [])];
  return box('stsd', u32(0), u32(1), box(format, entry, ...extra));
}

function trak({ kind = 'vide', width = 1920, height = 1080, display, duration = 10000, flags = 3, version = 0, rotate, pasp, config, format = 'avc1' } = {}) {
  const shown = display ?? { width, height };
  return box(
    'trak',
    tkhd({ ...shown, duration, flags, version, rotate }),
    box('mdia', hdlr(kind), box('minf', box('stbl', stsd(kind === 'vide' ? width : 0, kind === 'vide' ? height : 0, format, pasp, config)))),
  );
}

// An ilst entry. kind 1 is UTF-8 and 2 is UTF-16BE.
function item(type, text, kind = 1) {
  const value = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return box(type, box('data', u32(kind), u32(0), value));
}

// An ilst entry looked up by keys number
function numbered(index, text) {
  const value = box('data', u32(1), u32(0), latin(text));
  return Buffer.concat([u32(value.length + 8), u32(index), value]);
}

const isoMeta = (...items) => box('meta', u32(0), hdlr('mdir'), box('ilst', ...items));

function write(dir, ...parts) {
  fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.concat(parts));
  return readMp4Metadata(dir, 'v.mp4', { verifyBitrate: true });
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
    displayWidth: 1920,
    displayHeight: 1080,
    bitrate: Math.round((size * 8) / 10),
    bitrateNote: null,
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
    displayWidth: null,
    displayHeight: null,
    bitrate: null,
    bitrateNote: null,
  });
});

test('moov가 mdat 뒤에 있어도 찾고, mdat 내용은 읽지 않는다', () => {
  const dir = tempDir();
  // It is not fooled even if there is a fake moov inside mdat.
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
  assert.throws(() => write(dir, ftyp(), mdat), /has no moov box/);
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
    assert.throws(() => write(dir, bad), (err) => err instanceof FcError && /Not an MP4\/MOV format/.test(err.message));
  }
});

test('손상된 구조를 거부한다', () => {
  const dir = tempDir();
  const noMoov = /has no moov box/;
  assert.throws(() => write(dir, ftyp()), noMoov);
  // A file whose mdat is truncated
  assert.throws(() => write(dir, ftyp(), u32(9999), latin('mdat'), Buffer.alloc(8)), noMoov);
  // A box whose size is smaller than the header, a 64-bit size that goes past the file
  assert.throws(() => write(dir, ftyp(), u32(4), latin('free'), Buffer.alloc(8)), noMoov);
  assert.throws(() => write(dir, ftyp(), u32(1), latin('free'), u64(0xffffffffffffffffn)), noMoov);
  // A file whose moov is truncated
  assert.throws(() => write(dir, ftyp(), u32(9999), latin('moov'), Buffer.alloc(8)), /moov box of the MP4 file is truncated/);
  // A child that goes past its parent
  const overflow = Buffer.concat([u32(9999), latin('trak'), Buffer.alloc(8)]);
  assert.throws(() => write(dir, ftyp(), box('moov', overflow)), /structure is damaged/);
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
  assert.throws(() => write(dir, ftyp(), many), /too many MP4 boxes/);
});

test('타겟 밖과 없는 파일, 폴더는 거부한다', () => {
  const dir = tempDir();
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, 'o.mp4'), Buffer.concat([ftyp(), box('moov', mvhd())]));
  fs.mkdirSync(path.join(dir, 'd'));
  assert.throws(() => readMp4Metadata(dir, path.join(outside, 'o.mp4')), /outside the target folder/);
  assert.throws(() => readMp4Metadata(dir, 'none.mp4'), FcError);
  assert.throws(() => readMp4Metadata(dir, 'd'), /Not a file/);
});

test('mehd가 있으면 mvhd보다 먼저 쓴다', () => {
  const dir = tempDir();
  const mvex = box('mvex', box('mehd', u32(0), u32(100000)));
  const result = write(dir, ftyp(), box('moov', mvhd({ duration: 1000 }), mvex));
  assert.strictEqual(result.duration, 100);
});

test('mehd가 0이면 mvhd를 쓴다', () => {
  const dir = tempDir();
  const mvex = box('mvex', box('mehd', u32(0), u32(0)));
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), mvex)).duration, 10);
});

test('인코딩 해상도의 너비와 높이를 각각 읽는다', () => {
  const dir = tempDir();
  const result = write(dir, ftyp(), box('moov', trak({ width: 720, height: 480, display: { width: 853, height: 500 } })));
  assert.deepStrictEqual([result.width, result.height], [720, 480]);
});

test('길이가 정해지지 않은 트랙보다 길이가 있는 트랙을 고른다', () => {
  const dir = tempDir();
  const unknown = trak({ width: 1400, height: 1400, duration: 0xffffffff });
  const main = trak({ width: 640, height: 360, duration: 10 });
  assert.strictEqual(write(dir, ftyp(), box('moov', unknown, main)).width, 640);
});

test('트랙과 조각 구조의 어느 층이든 틀린 크기는 손상이다', () => {
  const dir = tempDir();
  const bad = Buffer.concat([u32(4), latin('free')]);
  for (const moov of [
    box('moov', box('trak', bad)),
    box('moov', box('trak', box('mdia', bad))),
    box('moov', box('trak', box('mdia', box('minf', bad)))),
    box('moov', box('trak', box('mdia', box('minf', box('stbl', bad))))),
    box('moov', box('mvex', bad)),
  ]) {
    assert.throws(() => write(dir, ftyp(), moov), /structure is damaged/);
  }
});

test('알 수 없는 버전과 안전 범위를 넘는 길이는 없는 값으로 본다', () => {
  const dir = tempDir();
  // It leaves the values as they are and changes only the version to 2. If the version is not looked at, the value is read.
  const v2 = (full) => {
    const copy = Buffer.from(full);
    copy[8] = 2;
    return copy;
  };
  assert.strictEqual(write(dir, ftyp(), box('moov', v2(mvhd()))).duration, null);
  assert.strictEqual(write(dir, ftyp(), box('moov', mvhd({ duration: 0 }), box('mvex', v2(box('mehd', u32(0), u32(30000)))))).duration, null);
  const track = box('trak', v2(tkhd({ width: 640, height: 360 })), box('mdia', hdlr('vide')));
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
  // A meta that lacks even the 4 bytes that tell the format
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
    assert.throws(() => write(dir, ftyp(), box('moov', bad)), /structure is damaged/);
    assert.strictEqual(write(dir, ftyp(), box('moov', mvhd(), box('udta', bad))).duration, 10);
  }
});

test('8바이트만 남은 64비트 크기 박스는 FcError다', () => {
  const dir = tempDir();
  assert.throws(() => write(dir, ftyp(), u32(1), latin('free')), (err) => err instanceof FcError && /has no moov box/.test(err.message));
});

test('keys의 틀린 값은 안전하게 무시한다', () => {
  const dir = tempDir();
  const ilst = box('ilst', numbered(1, 'T'), numbered(0, 'Z'));
  const withKeys = (keys) => write(dir, ftyp(), box('moov', box('meta', hdlr('mdta'), keys, ilst))).title;
  // A size-0 entry and a large count: the names do not grow endlessly.
  assert.strictEqual(withKeys(box('keys', u32(0), u32(0xffffffff), Buffer.alloc(64))), null);
  // It does not read entries beyond the count.
  const title = box('mdta', latin('com.apple.quicktime.title'));
  assert.strictEqual(withKeys(box('keys', u32(0), u32(0), title)), null);
  // An entry that goes past the remaining length
  assert.strictEqual(withKeys(box('keys', u32(0), u32(1), u32(9999), latin('mdta'))), null);
  // A keys that is too large
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
  const readSync = t.mock.method(fs, 'readSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'read' });
  });
  assert.throws(() => readMp4Metadata(dir, 'v.mp4'), (err) => err instanceof FcError && /EBUSY/.test(err.message));
  readSync.mock.restore();
  // A system error that occurs while checking the target folder is the same.
  t.mock.method(fs.realpathSync, 'native', () => {
    throw Object.assign(new Error('denied'), { code: 'EPERM', syscall: 'realpath' });
  });
  assert.throws(() => readMp4Metadata(dir, 'v.mp4'), (err) => err instanceof FcError && /EPERM/.test(err.message));
});

test('4GiB를 넘는 위치의 moov를 읽는다', (t) => {
  // Actually writing would use 6GB of disk, so only the size and the reading are imitated.
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
  const result = readMp4Metadata(dir, 'v.mp4', { verifyBitrate: true });
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

test('보이는 크기: 90·270도 회전이면 너비와 높이를 바꾸고, 인코딩 해상도는 그대로 둔다 (#106)', () => {
  const dir = tempDir();
  const size = (result) => [result.width, result.height, result.displayWidth, result.displayHeight];
  for (const rotate of [90, 270]) {
    assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', trak({ rotate })))), [1920, 1080, 1080, 1920], `${rotate}도`);
    assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', trak({ rotate, version: 1 })))), [1920, 1080, 1080, 1920], `버전 1, ${rotate}도`);
  }
  for (const rotate of [0, 180]) assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', trak({ rotate })))), [1920, 1080, 1920, 1080], `${rotate}도`);
  // It uses the rotation of the chosen main video track.
  const cover = trak({ width: 300, height: 300, duration: 10 });
  assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', cover, trak({ rotate: 90 })))), [1920, 1080, 1080, 1920]);
});

test('보이는 크기: pasp 화소 비율을 너비에 곱하고 회전과 함께 반영한다 (#106)', () => {
  const dir = tempDir();
  const size = (result) => [result.width, result.height, result.displayWidth, result.displayHeight];
  // DVD 16:9 (720x480, pixel aspect ratio 32:27)
  assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', trak({ width: 720, height: 480, pasp: [32, 27] })))), [720, 480, 853, 480]);
  assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', trak({ width: 720, height: 480, pasp: [32, 27], rotate: 90 })))), [720, 480, 480, 853]);
  // A value that holds 1:1 and 0 is not reflected.
  for (const pasp of [[1, 1], [0, 1], [1, 0]]) {
    assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', trak({ width: 720, height: 480, pasp })))), [720, 480, 720, 480], pasp.join(':'));
  }
  // If the encoded resolution is 0 and the tkhd size is used, that value is already the visible size.
  const shown = trak({ width: 0, height: 0, display: { width: 853, height: 480 }, pasp: [32, 27] });
  assert.deepStrictEqual(size(write(dir, ftyp(), box('moov', shown))), [853, 480, 853, 480]);
});

const shownSize = (result) => [result.width, result.height, result.displayWidth, result.displayHeight];
const h264 = (sar) => box('avcC', avcC(avcSps({ width: 720, height: 480, sar })));
const h265 = (sar) => box('hvcC', hvcC(hevcSps({ width: 720, height: 480, sar })));

test('보이는 크기: pasp가 없으면 avcC·hvcC 안 SPS의 화소 비율을 쓴다 (#113)', () => {
  const dir = tempDir();
  const size = (options) => shownSize(write(dir, ftyp(), box('moov', mvhd(), trak({ width: 720, height: 480, ...options }))));
  // DVD 16:9 (pixel aspect ratio 32:27 written directly) and 40:33 from the table
  assert.deepStrictEqual(size({ config: h264([32, 27]) }), [720, 480, 853, 480]);
  assert.deepStrictEqual(size({ config: h265(5), format: 'hvc1' }), [720, 480, 873, 480]);
  assert.deepStrictEqual(size({ config: h265([32, 27]), format: 'hev1', rotate: 90 }), [720, 480, 480, 853]);
  // An SPS with no ratio, 1:1, or unreadable is seen as square pixels.
  for (const config of [h264(undefined), h264(1), box('avcC', Buffer.alloc(7)), box('hvcC', Buffer.alloc(30))]) {
    assert.deepStrictEqual(size({ config }), [720, 480, 720, 480]);
  }
});

test('보이는 크기: tkhd 화면 크기가 인코딩 해상도와 다르면 그 비율을 쓴다 (#113)', () => {
  const dir = tempDir();
  const size = (options) => shownSize(write(dir, ftyp(), box('moov', mvhd(), trak({ width: 720, height: 480, ...options }))));
  assert.deepStrictEqual(size({ display: { width: 853, height: 480 } }), [720, 480, 853, 480]);
  assert.deepStrictEqual(size({ display: { width: 853, height: 480 }, rotate: 270 }), [720, 480, 480, 853]);
  // A case stretched by reducing the height is also seen as a ratio (showing 720x480 as 640x480 gives 4:3).
  assert.deepStrictEqual(size({ display: { width: 640, height: 480 } }), [720, 480, 640, 480]);
  // If the width and height are reduced by the same factor, the pixel aspect ratio is 1.
  assert.deepStrictEqual(shownSize(write(dir, ftyp(), box('moov', trak({ display: { width: 1280, height: 720 } })))), [1920, 1080, 1920, 1080]);
  // A file that writes the coded size (1920x1088) and writes the visible size (1920x1080) in tkhd shows the tkhd size as it is.
  assert.deepStrictEqual(shownSize(write(dir, ftyp(), box('moov', trak({ width: 1920, height: 1088, display: { width: 1920, height: 1080 } })))), [1920, 1088, 1920, 1080]);
  // A file of a rotated video that wrote the size after rotation in tkhd is not seen as a pixel aspect ratio (it shows as portrait, as before).
  for (const rotate of [90, 270]) {
    assert.deepStrictEqual(size({ width: 1920, height: 1080, display: { width: 1080, height: 1920 }, rotate }), [1920, 1080, 1080, 1920], `${rotate}도`);
  }
  assert.deepStrictEqual(shownSize(write(dir, ftyp(), box('moov', mvhd({ rotate: 90 }), trak({ display: { width: 1080, height: 1920 } })))), [1920, 1080, 1080, 1920]);
  // A tkhd that wrote the size after rotation is skipped and the SPS pixel aspect ratio is used (1440x1080 with 4:3 pixels = 1920x1080).
  assert.deepStrictEqual(size({ width: 1440, height: 1080, display: { width: 1080, height: 1440 }, rotate: 90, config: h264(14) }), [1440, 1080, 1080, 1920]);
  // A changed ratio of a video that does not rotate is seen as a pixel aspect ratio.
  assert.deepStrictEqual(size({ width: 1920, height: 1080, display: { width: 1080, height: 1920 } }), [1920, 1080, 1080, 1920]);
  // If the tkhd size is 0 or its integer part is 0 (a value written without the 16-bit shift), it is not used.
  const unshifted = box('trak', box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(10000), Buffer.alloc(16), matrix(0), u32(1920), u32(1080)), box('mdia', hdlr('vide'), box('minf', box('stbl', stsd(1920, 1088)))));
  assert.deepStrictEqual(shownSize(write(dir, ftyp(), box('moov', unshifted))), [1920, 1088, 1920, 1088]);
  // If the tkhd size is 0, it is not used.
  assert.deepStrictEqual(size({ display: { width: 0, height: 0 }, config: h264([32, 27]) }), [720, 480, 853, 480]);
});

test('보이는 크기: 화소 비율은 pasp, tkhd, SPS 순으로 고른다 (#113)', () => {
  const dir = tempDir();
  const size = (options) => shownSize(write(dir, ftyp(), box('moov', mvhd(), trak({ width: 720, height: 480, ...options }))));
  const wide = { width: 853, height: 480 };
  // If pasp exists, its value is used even if it is 1:1.
  assert.deepStrictEqual(size({ pasp: [1, 1], display: wide, config: h264(5) }), [720, 480, 720, 480]);
  assert.deepStrictEqual(size({ pasp: [8, 9], display: wide, config: h264(5) }), [720, 480, 640, 480]);
  // If there is no pasp, tkhd comes before the SPS.
  assert.deepStrictEqual(size({ display: wide, config: h264(5) }), [720, 480, 853, 480]);
  // If tkhd is the same as the encoded resolution, the SPS is used.
  assert.deepStrictEqual(size({ config: h264(5) }), [720, 480, 873, 480]);
  // A pasp that holds 0 is seen as absent and the next value is used.
  assert.deepStrictEqual(size({ pasp: [0, 1], config: h264([32, 27]) }), [720, 480, 853, 480]);
});

test('보이는 크기: mvhd 행렬의 회전을 트랙 회전과 함께 반영한다 (#113)', () => {
  const dir = tempDir();
  const size = (movie, track, order = 'mvhd first') => {
    const parts = [mvhd({ rotate: movie }), trak({ rotate: track })];
    return shownSize(write(dir, ftyp(), box('moov', ...(order === 'mvhd first' ? parts : parts.reverse()))));
  };
  assert.deepStrictEqual(size(90, 0), [1920, 1080, 1080, 1920]);
  assert.deepStrictEqual(size(270, undefined), [1920, 1080, 1080, 1920]);
  assert.deepStrictEqual(size(90, 90), [1920, 1080, 1920, 1080]);
  assert.deepStrictEqual(size(180, 270), [1920, 1080, 1080, 1920]);
  assert.deepStrictEqual(size(0, 90), [1920, 1080, 1080, 1920]);
  // It is reflected even if mvhd is after the tracks.
  assert.deepStrictEqual(size(90, 0, 'trak first'), [1920, 1080, 1080, 1920]);
  // A version 1 mvhd
  const v1 = write(dir, ftyp(), box('moov', mvhd({ version: 1, rotate: 90 }), trak()));
  assert.deepStrictEqual(shownSize(v1), [1920, 1080, 1080, 1920]);
  // A short mvhd that does not include the matrix is seen as having no rotation, and the length is read.
  const short = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(10000), Buffer.alloc(20));
  const result = write(dir, ftyp(), box('moov', short, trak()));
  assert.deepStrictEqual([result.duration, ...shownSize(result)], [10, 1920, 1080, 1920, 1080]);
});

test('보이는 크기: 화소가 정사각형이 아닌 영상을 회전하고 tkhd에 회전한 뒤의 보이는 크기를 적어도 세로로 본다 (#124)', () => {
  const dir = tempDir();
  const size = (options) => shownSize(write(dir, ftyp(), box('moov', mvhd(), trak({ width: 1440, height: 1080, ...options }))));
  // Encoded 1440x1080, pixel aspect ratio 4:3 (visible size 1920x1080), 90 and 270 degree rotation, tkhd 1080x1920
  for (const rotate of [90, 270]) {
    assert.deepStrictEqual(size({ display: { width: 1080, height: 1920 }, rotate, config: h264(14) }), [1440, 1080, 1080, 1920], `H.264 ${rotate}도`);
    assert.deepStrictEqual(size({ display: { width: 1080, height: 1920 }, rotate, config: h265(14), format: 'hvc1' }), [1440, 1080, 1080, 1920], `HEVC ${rotate}도`);
    assert.deepStrictEqual(size({ display: { width: 1080, height: 1920 }, rotate, pasp: [4, 3] }), [1440, 1080, 1080, 1920], `pasp ${rotate}도`);
  }
  // The mvhd-side rotation is the same.
  assert.deepStrictEqual(
    shownSize(write(dir, ftyp(), box('moov', mvhd({ rotate: 90 }), trak({ width: 1440, height: 1080, display: { width: 1080, height: 1920 }, config: h264(14) })))),
    [1440, 1080, 1080, 1920],
  );
  // If it does not rotate, tkhd 1920x1080 is used as a pixel aspect ratio, and a non-rotating 1080x1920 is seen as a pixel aspect ratio as now.
  assert.deepStrictEqual(size({ display: { width: 1920, height: 1080 }, config: h264(14) }), [1440, 1080, 1920, 1080]);
  assert.deepStrictEqual(size({ display: { width: 1080, height: 1920 }, config: h264(14) }), [1440, 1080, 1080, 1920]);
});

test('옛 QuickTime 제목·코멘트를 언어 코드에 맞는 인코딩으로 읽는다 (#69)', () => {
  const dir = tempDir();
  const classic = (type, bytes, language) => {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(bytes.length, 0);
    head.writeUInt16BE(language, 2);
    return box(type, head, bytes);
  };
  const title = (bytes, language) => write(dir, ftyp(), box('moov', box('udta', classic('©nam', Buffer.from(bytes), language)))).title;
  // Mac language codes: English (0) MacRoman, French (1) MacRoman, Japanese (11) Shift_JIS, Traditional Chinese (19) Big5, Korean (23) EUC-KR, Russian (32) Mac Cyrillic, Simplified Chinese (33) GBK
  assert.strictEqual(title([0x63, 0x61, 0x66, 0x8e], 0), 'café');
  assert.strictEqual(title([0x63, 0x61, 0x66, 0x8e], 1), 'café');
  assert.strictEqual(title([0x93, 0xfa, 0x96, 0x7b], 11), '日本');
  assert.strictEqual(title([0xa4, 0xa4, 0xa4, 0xe5], 19), '中文');
  assert.strictEqual(title([0xc7, 0xd1, 0xb1, 0xdb], 23), '한글');
  assert.strictEqual(title([0x8c, 0xe8, 0xf0], 32), 'Мир');
  assert.strictEqual(title([0xd6, 0xd0, 0xce, 0xc4], 33), '中文');
  // 0x7FFF (unspecified) is also a Mac encoding, and a Mac language code not in the table is MacRoman.
  assert.strictEqual(title([0x63, 0x61, 0x66, 0x8e], 0x7fff), 'café');
  assert.strictEqual(title([0x63, 0x61, 0x66, 0x8e], 25), 'café');
  // An ISO 639-2/T language code (0x400 or more) is UTF-8. 0x15c7 is kor and 0x55c4 is und.
  assert.strictEqual(title(Buffer.from('한글 ABC-123'), 0x15c7), '한글 ABC-123');
  assert.strictEqual(title([0x63, 0x61, 0x66, 0x8e], 0x55c4), 'caf\ufffd');
  // Even for a Mac language code, if the content is valid UTF-8, it is read as UTF-8.
  assert.strictEqual(title(Buffer.from('日本 ABC-123'), 0), '日本 ABC-123');
  assert.strictEqual(title(Buffer.from('ABC-123'), 11), 'ABC-123');
  // The comment is the same.
  const comment = write(dir, ftyp(), box('moov', box('udta', classic('©cmt', Buffer.from([0x93, 0xfa, 0x96, 0x7b]), 11)))).comment;
  assert.strictEqual(comment, '日本');
});

test('한중일 언어 코드는 우연히 UTF-8 규칙에 맞는 두 바이트 글자를 그 언어 인코딩으로 읽고, 키릴 언어 코드를 모두 본다 (1차 리뷰, #69)', () => {
  const dir = tempDir();
  const title = (bytes, language) => {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(bytes.length, 0);
    head.writeUInt16BE(language, 2);
    return write(dir, ftyp(), box('moov', box('udta', box('©nam', head, Buffer.from(bytes))))).title;
  };
  assert.strictEqual(title([0xc4, 0xa1, 0xc5, 0xb2], 23), '치킨');
  assert.strictEqual(title([0xc9, 0xbd, 0xcb, 0xae], 33), '山水');
  assert.strictEqual(title([0xc3, 0xbd], 11), 'ﾃｽ');
  // CJK letters written in UTF-8 are read as UTF-8 as they are.
  assert.strictEqual(title(Buffer.from('치킨 ABC-123'), 23), '치킨 ABC-123');
  assert.strictEqual(title(Buffer.from('山水'), 33), '山水');
  for (const language of [45, 46, 48, 58]) assert.strictEqual(title([0x8c, 0xe8, 0xf0], language), 'Мир', String(language));
});

test('MP4 메타데이터와 구조 확인은 파일을 한 번만 열어 읽는다 (#90)', (t) => {
  const { checkMp4Structure } = require('../src/mp4');
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.concat([ftyp(), box('moov', mvhd(), trak(), box('udta', box('©nam', u32(0), Buffer.from('ABC-123'))))]));
  const open = t.mock.method(fs, 'openSync');
  assert.strictEqual(readMp4Metadata(dir, 'v.mp4').width, 1920);
  assert.strictEqual(open.mock.callCount(), 1);
  checkMp4Structure(dir, path.join(dir, 'v.mp4'), 'v.mp4');
  assert.strictEqual(open.mock.callCount(), 2);
});

test('연 파일이 확인한 경로의 파일과 다르면 읽지 않는다 (#90)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.concat([ftyp(), box('moov', mvhd())]));
  fs.writeFileSync(path.join(dir, 'other.mp4'), Buffer.concat([ftyp(), box('moov', mvhd())]));
  const original = fs.openSync;
  // It opens a different file, as if it were swapped for another file between the check and the open.
  t.mock.method(fs, 'openSync', (p, flags) => original(String(p).endsWith('v.mp4') ? path.join(dir, 'other.mp4') : p, flags));
  assert.throws(() => readMp4Metadata(dir, 'v.mp4'), (err) => err instanceof FcError && /The file changed while reading/.test(err.message));
});

test('경로를 확인한 뒤 열기 전에 파일이 다른 파일이나 타겟 밖을 가리키는 링크로 바뀌면 읽지 않는다 (1차 리뷰, #90)', (t) => {
  const parent = tempDir();
  const dir = path.join(parent, 't');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'v.mp4');
  const content = Buffer.concat([ftyp(), box('moov', mvhd())]);
  fs.writeFileSync(path.join(parent, 'secret.mp4'), content);
  const original = fs.openSync;
  const swapTo = (replace) => {
    fs.writeFileSync(file, content);
    let swapped = false;
    const open = t.mock.method(fs, 'openSync', (p, flags) => {
      // writeFileSync also calls openSync, so it swaps only once.
      if (!swapped && String(p) === file) {
        swapped = true;
        fs.rmSync(file);
        replace();
      }
      return original(p, flags);
    });
    try {
      assert.throws(() => readMp4Metadata(dir, 'v.mp4'), (err) => err instanceof FcError && /The file changed while reading/.test(err.message));
    } finally {
      open.mock.restore();
    }
  };
  // It replaces it with a new file of the same content.
  swapTo(() => fs.writeFileSync(file, content));
  // It replaces it with a link that points to a file outside the target. If there is no permission to create links, this case is skipped.
  try {
    fs.symlinkSync(path.join(parent, 'secret.mp4'), path.join(parent, 'probe.mp4'));
  } catch (err) {
    if (err.code === 'EPERM') return;
    throw err;
  }
  fs.rmSync(path.join(parent, 'probe.mp4'));
  if (fs.existsSync(file)) fs.rmSync(file);
  swapTo(() => fs.symlinkSync(path.join(parent, 'secret.mp4'), file));
});

// #179: a test track for cross-checking the length against the sample table. seconds is the real length of the sample table (stts), and header is the length to write in tkhd and mdhd.
// chunk is the position the data position table (stco) will point to.
// With version 1, it writes mdhd with 64-bit times, and with co64, the position table as 64-bit (co64). If entries is given, it writes the stts entry count as that value (the content stays the same).
function dataTrak({ kind = 'vide', seconds, header = seconds, timescale = 1000, chunk = 0, samples = 1, version = 0, co64 = false, entries = 1, pad = false }) {
  const units = Math.round(seconds * timescale);
  const length = Math.round(header * timescale);
  const mdhd = version === 1
    ? box('mdhd', u32(0x01000000), u64(0), u64(0), u32(timescale), u64(length), u32(0))
    : box('mdhd', u32(0), u32(0), u32(0), u32(timescale), u32(length), u32(0));
  // If pad, it fills the remaining entries with length 0 to make a large table that really has as many entries as the count.
  const stts = box('stts', u32(0), u32(entries), u32(samples), u32(units / samples), Buffer.alloc(pad ? (entries - 1) * 8 : 0));
  const stco = co64 ? box('co64', u32(0), u32(1), u64(chunk)) : box('stco', u32(0), u32(1), u32(chunk));
  const stbl = box('stbl', stsd(kind === 'vide' ? 1920 : 0, kind === 'vide' ? 1080 : 0), stts, stco);
  return box('trak', tkhd({ width: 1920, height: 1080, duration: Math.round(header * 1000) }), box('mdia', mdhd, hdlr(kind), box('minf', stbl)));
}

test('길이 값이 표본 표의 길이보다 훨씬 길면 비트레이트를 믿지 않는다 (#179)', () => {
  const dir = tempDir();
  // A file where the mvhd, tkhd, and mdhd lengths of a 60-second video are written as 60000 seconds
  const result = write(dir, ftyp(), box('moov', mvhd({ duration: 60000 * 1000 }), dataTrak({ seconds: 60, header: 60000 })), box('mdat', Buffer.alloc(1000)));
  assert.strictEqual(result.duration, 60000);
  assert.strictEqual(result.bitrate, null);
  assert.match(result.bitrateNote, /^The duration value \(60000 s\) is much longer than the sample table duration \(60 s\)/);
});

test('길이 값이 표본 표와 맞거나 조금 다르면 비트레이트를 계산한다 (#179)', () => {
  const dir = tempDir();
  const same = write(dir, ftyp(), box('moov', mvhd({ duration: 60000 }), dataTrak({ seconds: 60 })), box('mdat', Buffer.alloc(1000)));
  assert.ok(same.bitrate > 0);
  assert.strictEqual(same.bitrateNote, null);
  // One that is slightly longer because of an empty stretch of an edit list and so on (within 2x + 60 seconds) is left as it is.
  const longer = write(dir, ftyp(), box('moov', mvhd({ duration: 170000 }), dataTrak({ seconds: 60, samples: 4 })), box('mdat', Buffer.alloc(1000)));
  assert.ok(longer.bitrate > 0);
  // If the audio track is longer than the video, it matches the longest track.
  const audio = write(dir, ftyp(), box('moov', mvhd({ duration: 3600000 }), dataTrak({ seconds: 60 }), dataTrak({ kind: 'soun', seconds: 3600, timescale: 48000 })), box('mdat', Buffer.alloc(1000)));
  assert.ok(audio.bitrate > 0);
  assert.strictEqual(audio.bitrateNote, null);
  // A file with no sample table (the test files so far) is not cross-checked.
  const plain = write(dir, ftyp(), box('moov', mvhd({ duration: 60000 }), trak()), box('mdat', Buffer.alloc(1000)));
  assert.ok(plain.bitrate > 0);
  assert.strictEqual(plain.bitrateNote, null);
});

test('데이터 위치표가 파일 끝 너머를 가리키는 받다 만 파일은 비트레이트를 믿지 않는다 (#179)', () => {
  const dir = tempDir();
  const result = write(dir, ftyp(), box('moov', mvhd({ duration: 60000 }), dataTrak({ seconds: 60, chunk: 50_000_000 })), box('mdat', Buffer.alloc(1000)));
  assert.strictEqual(result.duration, 60);
  assert.strictEqual(result.bitrate, null);
  assert.match(result.bitrateNote, /may be a partial download/);
});

test('조각 파일(mvex)은 moov의 빈 표본 표와 길이를 맞춰 보지 않는다 (#179)', () => {
  const dir = tempDir();
  const mvex = box('mvex', box('mehd', u32(0), u32(600000)));
  const result = write(dir, ftyp(), box('moov', mvhd({ duration: 0 }), dataTrak({ seconds: 1 }), mvex), box('mdat', Buffer.alloc(1000)));
  assert.strictEqual(result.duration, 600);
  assert.ok(result.bitrate > 0);
  assert.strictEqual(result.bitrateNote, null);
});

test('verifyBitrate를 켜지 않으면 표본 표와 데이터 위치표를 읽지 않고 비트레이트를 null로 둔다 (#207)', (t) => {
  const dir = tempDir();
  // A 60-second video that has a sample table of 200,000 entries (1.6MB)
  const parts = [ftyp(), box('moov', mvhd({ duration: 60000 }), dataTrak({ seconds: 60, entries: 200_000, pad: true })), box('mdat', Buffer.alloc(1000))];
  fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.concat(parts));
  const readBytes = (options) => {
    const readSync = t.mock.method(fs, 'readSync');
    const result = readMp4Metadata(dir, 'v.mp4', options);
    const bytes = readSync.mock.calls.reduce((sum, call) => sum + call.result, 0);
    readSync.mock.restore();
    return { result, bytes };
  };
  for (const options of [undefined, {}, { verifyBitrate: false }]) {
    const { result, bytes } = readBytes(options);
    assert.strictEqual(result.duration, 60);
    assert.strictEqual(result.width, 1920);
    assert.strictEqual(result.bitrate, null);
    assert.strictEqual(result.bitrateNote, null);
    assert.ok(bytes < 64 * 1024, `${bytes}바이트를 읽음`);
  }
  const on = readBytes({ verifyBitrate: true });
  assert.ok(on.result.bitrate > 0);
  assert.ok(on.bytes >= 1_600_000, `${on.bytes}바이트를 읽음`);
  // The reason for a partly downloaded file is also written only when it is turned on.
  const cut = [ftyp(), box('moov', mvhd({ duration: 60000 }), dataTrak({ seconds: 60, chunk: 50_000_000 })), box('mdat', Buffer.alloc(1000))];
  fs.writeFileSync(path.join(dir, 'v.mp4'), Buffer.concat(cut));
  assert.strictEqual(readMp4Metadata(dir, 'v.mp4').bitrateNote, null);
  assert.match(readMp4Metadata(dir, 'v.mp4', { verifyBitrate: true }).bitrateNote, /may be a partial download/);
  // If turned off, it never reads after the header of the stts and stco boxes (the entry count and entries) (first review). If turned on, it reads.
  const bytes = Buffer.concat(cut);
  const payloads = ['stts', 'stco'].map((type) => {
    const at = bytes.indexOf(type) - 4;
    return [at + 8, at + bytes.readUInt32BE(at)];
  });
  const touched = (options) => {
    const readSync = t.mock.method(fs, 'readSync');
    readMp4Metadata(dir, 'v.mp4', options);
    const positions = readSync.mock.calls.map((call) => call.arguments[4]);
    readSync.mock.restore();
    return payloads.map(([start, end]) => positions.some((at) => at >= start && at < end));
  };
  assert.deepStrictEqual(touched(undefined), [false, false]);
  // If turned on, it learns from the position table that it is a partly downloaded file and stops, so it does not get as far as stts. Reading stts is checked by the large table test above.
  assert.deepStrictEqual(touched({ verifyBitrate: true }), [false, true]);
});

test('mdhd 버전 1, co64, 읽지 않는 stts에서도 길이를 맞춰 본다 (#179, 1차 리뷰)', () => {
  const dir = tempDir();
  const v1 = write(dir, ftyp(), box('moov', mvhd({ duration: 60000 * 1000 }), dataTrak({ seconds: 60, timescale: 90000, version: 1 })), box('mdat', Buffer.alloc(1000)));
  assert.match(v1.bitrateNote, /sample table duration \(60 s\)/);
  const cut = write(dir, ftyp(), box('moov', mvhd({ duration: 60000 }), dataTrak({ seconds: 60, co64: true, chunk: 2 ** 33 })), box('mdat', Buffer.alloc(1000)));
  assert.match(cut.bitrateNote, /may be a partial download/);
  // An stts whose entry count is written larger than the table size is not read, and since it cannot be cross-checked, the bitrate is computed as is.
  const odd = write(dir, ftyp(), box('moov', mvhd({ duration: 60000 }), dataTrak({ seconds: 1, entries: 5 })), box('mdat', Buffer.alloc(1000)));
  assert.ok(odd.bitrate > 0);
  assert.strictEqual(odd.bitrateNote, null);
});
