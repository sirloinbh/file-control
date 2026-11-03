'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// 시험 파일이 실제 휴지통으로 가지 않도록 휴지통 호출을 가로챈다. commands.js가 불러올 때 함수를 받아 두므로 require보다 먼저 바꿔 둔다.
const realExecFileSync = childProcess.execFileSync;
const recycled = [];
let onRecycle = () => {};
let volume = () => 'True|Fixed\r\n';
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_VOLUME !== undefined) return volume();
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  onRecycle(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET);
  return Buffer.alloc(0);
});

// 생성과 변경 시각은 시험에서 되돌릴 수 없으므로, 파일을 오래전에 만든 것처럼 시계를 1시간 뒤로 옮겨 둔다.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
let skew = HOUR;
test.mock.method(Date, 'now', () => realNow() + skew);

const { removeDuplicates, formatRemoveDuplicates } = require('../src/removeDuplicates');
const { REMOVAL_LOG } = require('../src/removalLog');
const { run } = require('../bin/fctl');

const OLD = new Date(realNow() - HOUR);

// 길이와 해상도를 읽을 수 있는 최소 MP4. padding으로 크기를 바꾼다.
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
function mp4({ seconds, width = 1920, height = 1080, padding = 0 }) {
  const duration = Math.round(seconds * 1000);
  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(duration), Buffer.alloc(80));
  const tkhd = box('tkhd', u32(3), u32(0), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(52), u32(width * 65536), u32(height * 65536));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const stsd = box('stsd', u32(0), u32(1), box('avc1', entry));
  const hdlr = box('hdlr', u32(0), u32(0), latin('vide'), Buffer.alloc(13));
  const trak = box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd))));
  return Buffer.concat([box('ftyp', latin('isom'), u32(512), latin('isommp42')), box('moov', mvhd, trak), box('mdat', Buffer.alloc(64 + padding))]);
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rmdup-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  const made = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, OLD, OLD);
    made[name] = full;
  }
  return made;
}

const logs = (dir) => fs.readdirSync(dir).filter((name) => REMOVAL_LOG.test(name));
const confirmed = (dir, options = {}) => removeDuplicates(dir, { ...options, confirm: removeDuplicates(dir, options).code });
const codeIn = (report) => /--yes=([0-9a-f]+)/.exec(report)[1];

test.beforeEach(() => {
  recycled.length = 0;
  onRecycle = () => {};
  volume = () => 'True|Fixed\r\n';
  skew = HOUR;
});

test('확인값이 없으면 묶음과 지울 파일만 보여 주고 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 3600 }), 'old/ABC-123 720p.mp4': mp4({ seconds: 3600.4, width: 1280, height: 720 }) });
  const result = removeDuplicates(dir);
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [f['old/ABC-123 720p.mp4']]);
  assert.strictEqual(result.sets[0].keep.path, f['ABC-123.mp4']);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  const lines = formatRemoveDuplicates(result).split('\n');
  assert.strictEqual(lines[0], '묶음 (번호 ABC-123):');
  assert.match(lines[1], /^ {2}남길 파일: ABC-123\.mp4 \(\d+B, 1920x1080, 1:00:00\) \[해상도가 가장 높음\]$/);
  assert.match(lines[2], /^ {2}지울 파일: old[\\/]ABC-123 720p\.mp4 \(\d+B, 1280x720, 1:00:00\)$/);
  assert.match(lines.at(-1), /^아직 지우지 않았습니다\. 목록을 확인한 뒤 --yes=[0-9a-f]{12}를 붙여/);
});

test('확인값이 맞으면 기록을 먼저 남기고 남길 파일과 길이·화면 비율이 같은 사본만 휴지통으로 보낸다', () => {
  const dir = tempDir();
  const f = make(dir, {
    'ABC-123.mp4': mp4({ seconds: 3600 }),
    'a/ABC-123 720p.mp4': mp4({ seconds: 3600.4, width: 1280, height: 720 }),
    'b/ABC-123 - 복사본.mp4': mp4({ seconds: 3600 }),
    // 같은 번호의 예고편: 길이가 달라 남긴다.
    'c/ABC-123 trailer.mp4': mp4({ seconds: 90 }),
    // 이름이 달라 길이만 같은 묶음: 지우지 않는다.
    'x.mp4': mp4({ seconds: 900 }),
    'y.mp4': mp4({ seconds: 900 }),
  });
  let logged = null;
  onRecycle = () => {
    logged ??= logs(dir).length;
  };
  const result = confirmed(dir);
  assert.strictEqual(result.confirmed, true);
  assert.deepStrictEqual(recycled.sort(), [f['a/ABC-123 720p.mp4'], f['b/ABC-123 - 복사본.mp4']].sort());
  assert.strictEqual(logged, 1, '지우기 전에 기록이 있어야 한다');
  for (const name of ['ABC-123.mp4', 'c/ABC-123 trailer.mp4', 'x.mp4', 'y.mp4']) assert.ok(fs.existsSync(f[name]), name);
  assert.deepStrictEqual(result.kept.map((item) => [item.path, item.reason]), [[f['c/ABC-123 trailer.mp4'], '남길 파일과 길이가 달라 같은 영상이 아닐 수 있어 남겼습니다.']]);
  assert.strictEqual(result.lengthOnly, 1);
  const log = JSON.parse(fs.readFileSync(result.log, 'utf8'));
  assert.strictEqual(log.kind, '중복 영상');
  assert.deepStrictEqual(log.items.map((item) => item.path).sort(), recycled.slice().sort());
  assert.ok(log.items.every((item) => item.details.keep === f['ABC-123.mp4'] && item.details.group === '번호 ABC-123'));
  const report = formatRemoveDuplicates(result);
  assert.match(report, /휴지통으로 이동: a[\\/]ABC-123 720p\.mp4/);
  assert.match(report, /남김: c[\\/]ABC-123 trailer\.mp4 \(.+\) 남길 파일과 길이가 달라/);
  assert.match(report, /길이만 같은 묶음 1개는 이름이 달라 다른 영상일 수 있어 지우지 않습니다/);
  assert.match(report, /제거 기록: /);
  assert.match(report.split('\n').at(-1), /^묶음 1개, 휴지통 2개, 실패 0개, 남김 1개, 길이만 같은 묶음 1개/);
});

test('이름만 같은 다른 영상(카메라 이름, 제품번호처럼 보이는 말)은 길이가 다르면 지우지 않는다 (#103)', () => {
  const dir = tempDir();
  make(dir, {
    '2023/IMG_0001.MOV': mp4({ seconds: 120 }),
    '2024/IMG_0001.mp4': mp4({ seconds: 300 }),
    'WWE-2023 Raw.mp4': mp4({ seconds: 10800 }),
    'WWE-2023 SmackDown.mp4': mp4({ seconds: 7200 }),
    'GH010001.MP4': mp4({ seconds: 600, width: 3840, height: 2160 }),
    'b/GH010001.MP4': mp4({ seconds: 600, width: 1080, height: 1920 }),
  });
  const result = removeDuplicates(dir);
  assert.strictEqual(result.sets.length, 3);
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(result.kept.length, 3);
  assert.ok(result.kept.some((item) => item.reason === '남길 파일과 화면 비율이 달라 같은 영상이 아닐 수 있어 남겼습니다.'));
  assert.doesNotMatch(formatRemoveDuplicates(result), /--yes=/);
});

test('길이를 모르거나 60초 미만인 묶음은 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, {
    'Trip.avi': 'RIFF',
    'trip - 복사본.avi': 'RIFF',
    'clip.mp4': mp4({ seconds: 30 }),
    'sub/clip - 복사본.mp4': mp4({ seconds: 30 }),
    'broken.mp4': 'x',
    'broken - 복사본.mp4': mp4({ seconds: 600 }),
  });
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals, []);
  const reasons = result.kept.map((item) => item.reason).sort();
  assert.deepStrictEqual(reasons, [
    '60초 미만이라 길이로 같은 영상인지 확인할 수 없어 남겼습니다.',
    '길이나 해상도를 몰라 같은 영상인지 확인하지 못해 남겼습니다.',
    '남길 파일의 길이나 해상도를 몰라 같은 영상인지 확인하지 못해 남겼습니다.',
  ].sort());
});

test('남길 파일이나 지울 파일이 방금 바뀌었으면 남긴다', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  skew = 0;
  const result = removeDuplicates(dir);
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(result.kept[0].reason, '남길 파일이 방금 바뀌었거나 시각이 미래라 받는 중일 수 있어 남겼습니다.');
});

test('고정 디스크가 아니거나 1GB 이상(maxSize)인 사본은 남긴다', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  const big = removeDuplicates(dir, { maxSize: 10 });
  assert.deepStrictEqual(big.removals, []);
  assert.match(big.kept[0].reason, /1GB 이상/);
  volume = () => 'True|Removable\r\n';
  const removable = removeDuplicates(dir);
  assert.deepStrictEqual(removable.removals, []);
  assert.match(removable.kept[0].reason, /고정 디스크가 아니라\(Removable\)/);
});

test('확인값을 만든 뒤 남길 파일이 바뀌면 아무것도 지우지 않는다', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  const { code } = removeDuplicates(dir);
  fs.appendFileSync(f['ABC-123.mp4'], 'more');
  fs.utimesSync(f['ABC-123.mp4'], OLD, new Date(OLD.getTime() + 1000));
  const result = removeDuplicates(dir, { confirm: code });
  assert.strictEqual(result.mismatch, true);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('지우는 중에 남길 파일이 없어지면 남은 사본은 지우지 않는다', () => {
  const dir = tempDir();
  const f = make(dir, {
    'ABC-123.mp4': mp4({ seconds: 600, padding: 100 }),
    'ABC-123 (1).mp4': mp4({ seconds: 600 }),
    'ABC-123 (2).mp4': mp4({ seconds: 600 }),
  });
  onRecycle = () => {
    if (fs.existsSync(f['ABC-123.mp4'])) fs.rmSync(f['ABC-123.mp4']);
  };
  const result = confirmed(dir);
  assert.strictEqual(result.removed.length, 1);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /남길 파일을 찾을 수 없어 지우지 않았습니다/);
  assert.ok(fs.existsSync(result.failed[0].path));
});

test('--dry-run은 확인값이 맞아도 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'ABC-123.mp4': mp4({ seconds: 600 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  const result = removeDuplicates(dir, { confirm: removeDuplicates(dir).code, dryRun: true });
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  assert.match(formatRemoveDuplicates(result), /--dry-run 없이 --yes=/);
});

test('fctl remove-duplicates: 목록과 확인값을 내고, 확인값으로 지우고, 덮어쓰기·영구 삭제 옵션은 거부한다', () => {
  const dir = tempDir();
  const f = make(dir, { 'ABC-123.mp4': mp4({ seconds: 600, padding: 100 }), 'ABC-123 (1).mp4': mp4({ seconds: 600 }) });
  assert.throws(() => run(['remove-duplicates', dir, '--permanent']), /--permanent/);
  assert.throws(() => run(['remove-duplicates', dir, '--force']), /--force/);
  assert.throws(() => run(['remove-duplicates', dir, '--yes=000000000000']), /목록이 확인값을 만든 때와 달라/);
  const report = run(['remove-duplicates', dir]);
  assert.deepStrictEqual(recycled, []);
  run(['remove-duplicates', dir, `--yes=${codeIn(report)}`]);
  assert.deepStrictEqual(recycled, [f['ABC-123 (1).mp4']]);
  assert.ok(fs.existsSync(f['ABC-123.mp4']));
  assert.match(run(['--help']), /remove-duplicates <타겟>/);
});
