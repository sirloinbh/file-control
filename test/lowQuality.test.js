'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { lowQualityCriteria, saneInfo, judgeQuality, findLowQuality, formatLowQuality } = require('../src/lowQuality');
const { run } = require('../bin/fctl');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-lowq-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function put(root, relative, content = 'x') {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// 머리 구조만 있는 MP4·MKV. 길이와 해상도를 읽는다. padding으로 파일 크기(비트레이트)를 맞춘다.
const latin = (text) => Buffer.from(text, 'latin1');
const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), latin(type), body]);
}

// rotate가 90이면 tkhd 변환 행렬에 90도 회전을 넣는다(휴대폰 세로 영상). timescale로 깨진 길이를 만든다.
// dataSeconds를 주면 표본 표(stts)에 그 길이를, chunk를 주면 데이터 위치표(stco)에 그 위치를 적는다(#179).
function mp4({ seconds, width = 1920, height = 1080, padding = 0, rotate = 0, timescale = 1000, dataSeconds, chunk = 0 }) {
  const duration = Math.round(seconds * timescale);
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80));
  const middle = Buffer.alloc(52);
  if (rotate === 90) {
    middle.writeInt32BE(0x10000, 16 + 4);
    middle.writeInt32BE(-0x10000, 16 + 12);
  }
  const tkhd = box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(duration), middle, u32(width * 65536), u32(height * 65536));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const stsd = box('stsd', u32(0), u32(1), box('avc1', entry));
  const hdlr = box('hdlr', u32(0), u32(0), latin('vide'), Buffer.alloc(13));
  const tables = [];
  if (dataSeconds !== undefined) {
    tables.push(box('stts', u32(0), u32(1), u32(1), u32(Math.round(dataSeconds * 1000))), box('stco', u32(0), u32(1), u32(chunk)));
  }
  const mdhd = dataSeconds === undefined ? [] : [box('mdhd', u32(0), u32(0), u32(0), u32(1000), u32(duration), u32(0))];
  const trak = box('trak', tkhd, box('mdia', ...mdhd, hdlr, box('minf', box('stbl', stsd, ...tables))));
  return Buffer.concat([box('ftyp', latin('isom'), u32(512), latin('isommp42')), box('moov', mvhd, trak), box('mdat', Buffer.alloc(64 + padding))]);
}

// cueTimes를 주면 그 시각(ms)들로 탐색 표(Cues)를 넣는다(#179). padding으로 파일 크기(비트레이트)를 맞춘다.
function mkv({ seconds, width = 1920, height = 1080, cueTimes = [], padding = 0 }) {
  const size = (length) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(length));
    b[0] = 0x01;
    return b;
  };
  const idBytes = (id) => Buffer.from(id.toString(16).padStart(id.toString(16).length + (id.toString(16).length % 2), '0'), 'hex');
  const el = (id, ...parts) => {
    const body = Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : part)));
    return Buffer.concat([idBytes(id), size(body.length), body]);
  };
  const ticks = Buffer.alloc(8);
  ticks.writeDoubleBE(seconds * 1000);
  const info = el(0x1549a966, el(0x2ad7b1, u32(1000000)), el(0x4489, ticks));
  const video = el(0xae, el(0x83, Buffer.from([1])), el(0xe0, el(0xb0, u32(width)), el(0xba, u32(height))));
  const cues = cueTimes.length === 0 ? [] : [el(0x1c53bb6b, ...cueTimes.map((time) => el(0xbb, el(0xb3, u32(time)))))];
  return Buffer.concat([el(0x1a45dfa3, el(0x4282, 'matroska')), el(0x18538067, info, el(0x1654ae6b, video), ...cues, el(0x1f43b675, Buffer.alloc(100 + padding)))]);
}

const info = (fields) => ({ width: 640, height: 360, displayWidth: null, displayHeight: null, duration: 60, bitrate: 1000000, ...fields });
const names = (root, list) => list.map((item) => path.relative(root, item.path).replaceAll(path.sep, '/')).sort();

test('lowQualityCriteria는 기본으로 짧은 쪽 360화소를 쓰고, 정수가 아닌 기준은 거부한다 (#30)', () => {
  assert.deepStrictEqual(lowQualityCriteria(), { minHeight: 360, minBitrate: null });
  assert.deepStrictEqual(lowQualityCriteria({ minHeight: 480, minBitrate: 500 }), { minHeight: 480, minBitrate: 500 });
  for (const bad of [{ minHeight: 0 }, { minHeight: 360.5 }, { minHeight: Number.NaN }, { minBitrate: -1 }, { minBitrate: 2000000 }]) {
    assert.throws(() => lowQualityCriteria(bad), FcError);
  }
});

test('judgeQuality는 보이는 크기의 짧은 쪽으로 해상도를 보고, 한 기준이라도 미만이면 저화질이다 (#30)', () => {
  const criteria = lowQualityCriteria({ minBitrate: 500 });
  assert.deepStrictEqual(judgeQuality(saneInfo(info({ width: 640, height: 360 })), criteria), { status: 'ok', reasons: [] });
  assert.deepStrictEqual(judgeQuality(saneInfo(info({ width: 480, height: 270 })), criteria).reasons, ['short side 270 px < 360']);
  // 세로 영상(회전 반영 보이는 크기 360x640)은 짧은 쪽이 360이라 저화질이 아니다.
  assert.strictEqual(judgeQuality(saneInfo(info({ width: 640, height: 360, displayWidth: 360, displayHeight: 640 })), criteria).status, 'ok');
  // 화소 비율로 보이는 크기가 줄면 그 크기로 본다.
  assert.strictEqual(judgeQuality(saneInfo(info({ width: 720, height: 480, displayWidth: 720, displayHeight: 300 })), criteria).status, 'low');
  assert.deepStrictEqual(judgeQuality(saneInfo(info({ bitrate: 300000 })), criteria).reasons, ['bitrate 300 kbps < 500 kbps']);
  assert.deepStrictEqual(judgeQuality(saneInfo(info({ width: 320, height: 240, bitrate: 300000 })), criteria).reasons, ['short side 240 px < 360', 'bitrate 300 kbps < 500 kbps']);
  // 비트레이트 기준이 없으면 비트레이트는 보지 않는다.
  assert.strictEqual(judgeQuality(saneInfo(info({ bitrate: 300000 })), lowQualityCriteria()).status, 'ok');
});

test('깨진 메타데이터 값은 저화질로 보지 않고 판단 못함으로 둔다 (#30, PR #68 리뷰)', () => {
  const criteria = lowQualityCriteria({ minBitrate: 500 });
  // 길이가 비정상으로 커서 비트레이트가 0에 가까운 경우
  const longer = judgeQuality(saneInfo(info({ duration: 8.5e12, bitrate: 0 })), criteria);
  assert.strictEqual(longer.status, 'unknown');
  assert.match(longer.reasons.join(' '), /over 7 days and may be corrupt/);
  // 비트레이트가 1kbps 미만
  assert.strictEqual(judgeQuality(saneInfo(info({ bitrate: 200 })), criteria).status, 'unknown');
  // 길이 1초 미만이면 비트레이트를 믿지 않는다.
  assert.strictEqual(judgeQuality(saneInfo(info({ duration: 0.5, bitrate: 100000 })), criteria).status, 'unknown');
  // 해상도가 범위 밖이면 해상도를 모르는 것으로 본다.
  const tiny = judgeQuality(saneInfo(info({ width: 4, height: 2 })), lowQualityCriteria());
  assert.strictEqual(tiny.status, 'unknown');
  assert.match(tiny.reasons.join(' '), /outside the normal range/);
  assert.strictEqual(judgeQuality(saneInfo(info({ width: null, height: null })), lowQualityCriteria()).status, 'unknown');
  // 보이는 크기가 인코딩 해상도와 2배 넘게 다르면 깨진 값이다. tkhd가 깨져 1920x1080이 1920x100으로 보이는 경우(1차 리뷰).
  const squashed = judgeQuality(saneInfo(info({ width: 1920, height: 1080, displayWidth: 1920, displayHeight: 100 })), lowQualityCriteria());
  assert.strictEqual(squashed.status, 'unknown');
  assert.match(squashed.reasons.join(' '), /1920x1080, displayed size 1920x100\) is outside the normal range/);
  // 정상인 화소 비율과 회전, 2:1 아나모픽은 그대로 믿는다.
  for (const [width, height, displayWidth, displayHeight, status] of [[720, 480, 853, 480, 'ok'], [1440, 1080, 1920, 1080, 'ok'], [1920, 1080, 1080, 1920, 'ok'], [1920, 1080, 3840, 1080, 'ok'], [640, 352, 320, 352, 'low']]) {
    assert.strictEqual(judgeQuality(saneInfo(info({ width, height, displayWidth, displayHeight })), lowQualityCriteria()).status, status, `${width}x${height} -> ${displayWidth}x${displayHeight}`);
  }
  // 길이가 있는데 비트레이트만 없으면 그렇게 알린다.
  const noBitrate = judgeQuality(saneInfo(info({ bitrate: null })), criteria);
  assert.deepStrictEqual(noBitrate, { status: 'unknown', reasons: ['Could not judge because the bitrate could not be determined.', 'There is no bitrate information.'] });
  // 해상도가 이미 미만이면 비트레이트를 몰라도 저화질이다.
  assert.strictEqual(judgeQuality(saneInfo(info({ width: 320, height: 240, duration: null, bitrate: null })), criteria).status, 'low');
});

test('읽기에서 길이를 믿지 못한 파일은 비트레이트로 저화질이 되지 않고 판단 못함이다 (#179)', () => {
  const criteria = lowQualityCriteria({ minBitrate: 500 });
  const doubted = judgeQuality(saneInfo(info({ width: 1920, height: 1080, bitrate: 5000, bitrateNote: 'The duration value cannot be trusted.' })), criteria);
  assert.deepStrictEqual(doubted, { status: 'unknown', reasons: ['Could not judge because the bitrate could not be determined.', 'The duration value cannot be trusted.'] });

  const dir = tempDir();
  // 60초짜리 1080p 파일의 길이가 60000초로 적힌 경우: 파일 전체로 계산하면 약 5kbps라 500kbps 기준에 걸린다.
  put(dir, 'stretched.mp4', mp4({ seconds: 60000, dataSeconds: 60, padding: 40_000_000 }));
  // 1시간짜리라고 적혔는데 앞의 일부만 받은 파일. 데이터 위치표가 파일 끝 너머를 가리킨다.
  put(dir, 'partial.mp4', mp4({ seconds: 3600, dataSeconds: 3600, chunk: 1_500_000_000, padding: 100_000 }));
  // 견줄 정상 파일: 표본 표와 길이가 맞고 비트레이트가 기준 미만이면 그대로 저화질이다.
  put(dir, 'starved.mp4', mp4({ seconds: 60, dataSeconds: 60, padding: 750_000 }));
  // MKV도 같다: 탐색 표의 마지막 시각은 58초인데 길이가 60000초로 적힌 파일(1차 리뷰)
  put(dir, 'stretched.mkv', mkv({ seconds: 60000, cueTimes: [0, 30000, 58000], padding: 40_000_000 }));
  const result = findLowQuality(dir, { minBitrate: 500 });
  assert.deepStrictEqual(names(dir, result.low), ['starved.mp4']);
  assert.deepStrictEqual(names(dir, result.unreadable), ['partial.mp4', 'stretched.mkv', 'stretched.mp4']);
  const report = formatLowQuality(result);
  assert.match(report, /^Undetermined: stretched\.mp4 \(Could not judge because the bitrate could not be determined\. The duration value \(60000 s\) is much longer than the sample table duration \(60 s\)/m);
  assert.match(report, /^Undetermined: partial\.mp4 \(.*may be a partial download/m);
});

test('findLowQuality는 MP4·MKV의 해상도와 비트레이트를 읽어 기준 미만을 고르고 파일은 건드리지 않는다 (#30)', () => {
  const dir = tempDir();
  put(dir, 'hd.mp4', mp4({ seconds: 60, width: 1280, height: 720, padding: 8_000_000 }));
  put(dir, 'sub/small.mp4', mp4({ seconds: 60, width: 480, height: 270, padding: 8_000_000 }));
  put(dir, 'portrait.mov', mp4({ seconds: 60, width: 640, height: 360, rotate: 90, padding: 8_000_000 }));
  // 해상도는 넉넉하지만 60초에 약 100KB라 약 13kbps
  put(dir, 'starved.mp4', mp4({ seconds: 60, width: 1280, height: 720, padding: 100_000 }));
  put(dir, 'tiny.mkv', mkv({ seconds: 60, width: 320, height: 240 }));
  put(dir, 'old.avi', 'RIFF');
  put(dir, 'note.txt', 'x');
  // MPEG-TS는 판단 못함으로 알리고, TypeScript 소스(.ts)는 영상이 아니라 보지 않는다.
  const packets = Buffer.alloc(188 * 3);
  for (let offset = 0; offset < packets.length; offset += 188) packets[offset] = 0x47;
  put(dir, 'record.ts', packets);
  put(dir, 'code.ts', 'export const x = 1;');
  put(dir, '.git/objects/x.mp4', mp4({ seconds: 60, width: 160, height: 120 }));
  const before = fs.readdirSync(dir, { recursive: true }).sort();

  const byHeight = findLowQuality(dir);
  assert.deepStrictEqual(names(dir, byHeight.low), ['sub/small.mp4', 'tiny.mkv']);
  assert.deepStrictEqual(names(dir, byHeight.unreadable), ['old.avi', 'record.ts']);
  assert.strictEqual(byHeight.checked, 7);
  const small = byHeight.low.find((file) => file.path.endsWith('small.mp4'));
  assert.deepStrictEqual([small.width, small.height, small.duration], [480, 270, 60]);
  assert.ok(small.bitrate > 1_000_000);

  const byBitrate = findLowQuality(dir, { minBitrate: 500 });
  assert.deepStrictEqual(names(dir, byBitrate.low), ['starved.mp4', 'sub/small.mp4', 'tiny.mkv']);
  assert.deepStrictEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);

  const report = formatLowQuality(byBitrate);
  assert.match(report, /^Criteria: below short side 360 px or bitrate 500 kbps$/m);
  assert.match(report, /^Low quality: starved\.mp4 \(.*1280x720, 1:00, \d+kbps\) \[bitrate \d+ kbps < 500 kbps\]$/m);
  assert.match(report, /^Undetermined: old\.avi \(Cannot read the resolution of the \.avi format\.\)$/m);
  assert.match(report, /^Checked 7 videos, 3 low quality, 2 undetermined, 0 skipped$/m);
});

test('find-low-quality 명령은 기준 옵션을 받고, 잘못된 값과 다른 명령의 기준 옵션을 거부한다 (#30)', () => {
  const dir = tempDir();
  put(dir, 'a.mp4', mp4({ seconds: 60, width: 854, height: 480 }));
  assert.match(run(['find-low-quality', dir]), /0 low quality/);
  assert.match(run(['find-low-quality', dir, '--min-height=720']), /^Low quality: a\.mp4 .*\[short side 480 px < 720\]$/m);
  assert.match(run(['find-low-quality', '--min-bitrate=5000', dir]), /bitrate 5000 kbps/);
  assert.throws(() => run(['find-low-quality', dir, '--min-height=abc']), /--min-height must be an integer from 1 to 100000: "abc"$/);
  assert.throws(() => run(['find-low-quality', dir, '--min-height=']), /--min-height must be an integer from 1 to .*: ""$/);
  assert.throws(() => run(['find-low-quality', dir, '--min-height=720=3']), /--min-height must be an integer from 1 to .*: "720=3"$/);
  assert.throws(() => run(['find-low-quality', dir, '--min-bitrate=1.5']), /--min-bitrate must be an integer from 1 to 1000000: "1\.5"$/);
  // -- 뒤의 --min-height=720은 옵션이 아니라 이름이라 타겟이 둘이 된다.
  assert.throws(() => run(['find-low-quality', dir, '--', '--min-height=720']), /Only one target is accepted/);
  assert.throws(() => run(['find-low-quality', dir, '--min-height']), /Attach a value to --min-height/);
  assert.throws(() => run(['flatten', dir, '--min-height=720']), /--min-height can be used only with find-low-quality and remove-low-quality/);
});
