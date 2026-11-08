'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// 시험 파일이 실제 휴지통으로 가지 않도록 휴지통 호출과 볼륨 확인을 가로챈다. commands.js가 불러올 때 함수를 받아 두므로 require보다 먼저 바꿔 둔다.
const realExecFileSync = childProcess.execFileSync;
const { fakeRecycleFiles } = require('./fakeRecycleFiles');
const recycled = [];
let onRecycle = () => {};
let volume = () => 'True|Fixed\r\n';
// 파일 시스템 확인(#184). 기본은 NTFS로 답하고, 테스트마다 바꿔 exFAT 등을 흉내 낸다.
let format = () => 'NTFS\r\n';
let formatProbes = 0;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) {
    formatProbes += 1;
    return format();
  }
  if (options?.env?.FC_VOLUME !== undefined) return volume();
  // 묶음 휴지통 이동(#216)도 사용자 휴지통을 건드리지 않게 흉내 낸다.
  if (options?.env?.FC_RECYCLE_FILES !== undefined) {
    return fakeRecycleFiles(options, (target) => {
      recycled.push(target);
      onRecycle(target);
    });
  }
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  onRecycle(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET);
  return Buffer.alloc(0);
});

// 생성과 변경 시각은 시험에서 되돌릴 수 없으므로, 파일을 오래전에 만든 것처럼 시계를 1시간 뒤로 옮겨 둔다.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
test.mock.method(Date, 'now', () => realNow() + HOUR);

const { removeLowQuality, formatRemoveLowQuality } = require('../src/removeLowQuality');
const { REMOVAL_LOG } = require('../src/removalLog');
const { run } = require('../bin/fctl');

const OLD = new Date(realNow() - HOUR);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rmlowq-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function put(root, relative, content) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  fs.utimesSync(full, OLD, OLD);
  return full;
}

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

// 머리 구조만 있는 MP4. padding으로 파일 크기(비트레이트)를 맞춘다.
function mp4({ seconds = 60, width, height, padding = 0 }) {
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

const names = (root, list) => list.map((item) => path.relative(root, item.path).replaceAll(path.sep, '/')).sort();
const logs = (dir) => fs.readdirSync(dir).filter((name) => REMOVAL_LOG.test(name));

function fixture() {
  const dir = tempDir();
  put(dir, 'hd.mp4', mp4({ width: 1280, height: 720, padding: 8_000_000 }));
  put(dir, 'small.mp4', mp4({ width: 480, height: 270, padding: 8_000_000 }));
  put(dir, 'sub/tiny.mp4', mp4({ width: 320, height: 240, padding: 1_000 }));
  // 해상도는 넉넉하지만 비트레이트가 약 13kbps
  put(dir, 'starved.mp4', mp4({ width: 1280, height: 720, padding: 100_000 }));
  put(dir, 'old.avi', 'RIFF');
  return dir;
}

test('remove-low-quality는 확인값 없이는 목록만 보이고, 확인값을 주면 기록을 남긴 뒤 휴지통으로 보낸다 (#31)', () => {
  const dir = fixture();
  recycled.length = 0;
  const preview = removeLowQuality(dir, { minBitrate: 500 });
  assert.deepStrictEqual(names(dir, preview.removals), ['small.mp4', 'sub/tiny.mp4']);
  // 비트레이트로만 걸린 파일은 길이가 깨졌을 수 있어 남긴다(#179).
  assert.deepStrictEqual(preview.kept.map((item) => [path.basename(item.path), /비트레이트로만 저화질/.test(item.reason)]), [['starved.mp4', true]]);
  assert.deepStrictEqual(names(dir, preview.unreadable), ['old.avi']);
  assert.strictEqual(recycled.length, 0);
  assert.deepStrictEqual(logs(dir), []);
  const report = formatRemoveLowQuality(preview);
  assert.match(report, /^기준: 화면의 짧은 쪽 360화소 또는 비트레이트 500kbps 미만$/m);
  assert.match(report, /^지울 파일: small\.mp4 \(.*480x270, 1:00, \d+kbps\) \[화면의 짧은 쪽 270화소 < 360\]$/m);
  assert.match(report, /^남김: starved\.mp4 \(.*\) \[비트레이트 \d+kbps < 500kbps\] 비트레이트로만 저화질/m);
  assert.match(report, /^판단 못함, 지우지 않음: old\.avi /m);
  assert.match(report, new RegExp(`같은 기준과 --yes=${preview.code}를 붙여`));

  // 기준이 다르면 확인값도 다르다.
  assert.notStrictEqual(removeLowQuality(dir).code, preview.code);
  // 틀린 확인값이나 --dry-run이면 지우지 않는다.
  assert.strictEqual(removeLowQuality(dir, { minBitrate: 500, confirm: 'wrong' }).mismatch, true);
  assert.strictEqual(removeLowQuality(dir, { minBitrate: 500, confirm: preview.code, dryRun: true }).confirmed, false);
  assert.strictEqual(recycled.length, 0);

  const done = removeLowQuality(dir, { minBitrate: 500, confirm: preview.code });
  assert.strictEqual(done.confirmed, true);
  assert.deepStrictEqual(names(dir, done.removed), ['small.mp4', 'sub/tiny.mp4']);
  assert.deepStrictEqual(done.failed, []);
  assert.deepStrictEqual(recycled.map((p) => path.relative(dir, p).replaceAll(path.sep, '/')).sort(), ['small.mp4', 'sub/tiny.mp4']);
  assert.ok(fs.existsSync(path.join(dir, 'hd.mp4')) && fs.existsSync(path.join(dir, 'starved.mp4')));
  // 기록에는 경로·크기·사유와 해상도·비트레이트·기준이 들어 있다.
  const [logName] = logs(dir);
  assert.strictEqual(done.log, path.join(dir, logName));
  const log = JSON.parse(fs.readFileSync(done.log, 'utf8'));
  assert.strictEqual(log.kind, '저화질 영상');
  assert.strictEqual(log.count, 2);
  const small = log.items.find((item) => item.path.endsWith('small.mp4'));
  assert.strictEqual(small.reason, '저화질 영상 (화면의 짧은 쪽 270화소 < 360)');
  assert.deepStrictEqual({ ...small.details, bitrate: typeof small.details.bitrate }, { width: 480, height: 270, displayWidth: 480, displayHeight: 270, duration: 60, bitrate: 'number', criteria: { minHeight: 360, minBitrate: 500 } });
  assert.match(formatRemoveLowQuality(done), /^휴지통으로 이동: small\.mp4 /m);
  assert.match(formatRemoveLowQuality(done), /^제거 기록: /m);
});

test('remove-low-quality는 확인값을 만든 뒤 파일이 바뀌면 지우지 않고, 방금 바뀐 파일과 1GB 이상은 남긴다 (#31)', () => {
  const dir = tempDir();
  const file = put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  const { code } = removeLowQuality(dir);
  fs.appendFileSync(file, 'x');
  fs.utimesSync(file, OLD, OLD);
  assert.strictEqual(removeLowQuality(dir, { confirm: code }).mismatch, true);
  assert.ok(fs.existsSync(file));
  // 방금 바뀐 파일: 시계를 옮기지 않은 지금 시각을 주면 방금 만든 파일의 생성·변경 시각이 5분 안이다.
  const fresh = removeLowQuality(dir, { now: realNow() });
  assert.deepStrictEqual(fresh.kept.map((item) => item.reason), ['방금 바뀐 파일이라 받는 중일 수 있어 남겼습니다.']);
  // 휴지통 최대 크기를 모르면 1GB(여기서는 maxSize)부터 남긴다(#219).
  const big = removeLowQuality(dir, { maxSize: 10 });
  assert.deepStrictEqual(big.kept.map((item) => item.reason), ['1GB 이상이고 휴지통 최대 크기를 확인하지 못해 영구 삭제될 수 있으므로 남겼습니다.']);
  assert.deepStrictEqual(big.removals, []);
});

test('remove-low-quality는 휴지통 설정상 영구 삭제될 파일(바로 제거, 최대 크기 초과)과 그 하드링크 이름을 남긴다 (#219)', (t) => {
  const dir = tempDir();
  put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  const big = put(dir, 'big.mp4', mp4({ width: 480, height: 270, padding: 2 * 1024 * 1024 }));
  fs.linkSync(big, path.join(dir, 'big-link.mp4'));
  fs.utimesSync(big, OLD, OLD);
  t.after(() => {
    volume = () => 'True|Fixed\r\n';
  });
  volume = () => 'True|Fixed|1|26427\r\n';
  const nuke = removeLowQuality(dir);
  assert.deepStrictEqual(nuke.removals, []);
  assert.ok(nuke.kept.length === 3 && nuke.kept.every((item) => /^이 볼륨은 휴지통 설정이 "바로 제거"라 .*남겼습니다\.$/.test(item.reason)), JSON.stringify(nuke.kept.map((item) => item.reason)));
  // 최대 크기 1MB: big.mp4(2MB 넘음)와 그 하드링크만 남기고 small.mp4는 지울 목록에 둔다.
  volume = () => 'True|Fixed|0|1\r\n';
  const plan = removeLowQuality(dir);
  assert.deepStrictEqual(plan.removals.map((item) => path.basename(item.path)), ['small.mp4']);
  const kept = Object.fromEntries(plan.kept.map((item) => [path.basename(item.path), item.reason]));
  assert.strictEqual(kept['big.mp4'], '휴지통 최대 크기(1MB)보다 커서 Windows가 묻지 않고 영구 삭제하므로 남겼습니다.');
  assert.strictEqual(kept['big-link.mp4'], kept['big.mp4']);
  // 최대 크기를 알면 용량을 모를 때의 한도(maxSize)는 쓰지 않는다.
  volume = () => 'True|Fixed|0|26427\r\n';
  assert.strictEqual(removeLowQuality(dir, { maxSize: 10 }).removals.length, 2);
});

test('remove-low-quality는 exFAT 볼륨이면 고정 디스크여도 지우지 않는다 (#184)', (t) => {
  const dir = tempDir();
  const file = put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  t.after(() => {
    format = () => 'NTFS\r\n';
  });
  format = () => 'exFAT\r\n';
  recycled.length = 0;
  const plan = removeLowQuality(dir);
  assert.deepStrictEqual(plan.removals, []);
  assert.match(plan.kept[0].reason, /^exFAT 볼륨은 변경 시각을 적지 않아/);
  assert.deepStrictEqual(removeLowQuality(dir, { confirm: plan.code }).removed, []);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('remove-low-quality는 고정 디스크가 아니거나 대화형 세션이 아니면 지우지 않는다 (#31)', (t) => {
  const dir = tempDir();
  const file = put(dir, 'small.mp4', mp4({ width: 480, height: 270 }));
  t.after(() => {
    volume = () => 'True|Fixed\r\n';
  });
  volume = () => 'True|Removable\r\n';
  const removable = removeLowQuality(dir);
  assert.deepStrictEqual(removable.removals, []);
  assert.match(removable.kept[0].reason, /고정 디스크가 아니라\(Removable\)/);
  volume = () => 'False|Fixed\r\n';
  const { code } = removeLowQuality(dir);
  assert.throws(() => removeLowQuality(dir, { confirm: code }), /대화형 세션인지 확인되지 않아/);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(logs(dir), []);
});

test('remove-low-quality는 휴지통 이동이 실패한 파일을 보고하고 나머지는 계속한다 (#31)', (t) => {
  const dir = tempDir();
  put(dir, 'a.mp4', mp4({ width: 480, height: 270 }));
  put(dir, 'b.mp4', mp4({ width: 480, height: 270 }));
  t.after(() => {
    onRecycle = () => {};
  });
  onRecycle = (target) => {
    if (target.endsWith('a.mp4')) throw Object.assign(new Error('locked'), { status: 1 });
  };
  const { code } = removeLowQuality(dir);
  const result = removeLowQuality(dir, { confirm: code });
  assert.deepStrictEqual(names(dir, result.removed), ['b.mp4']);
  // 묶어 보내므로(#216) 그 파일만 Windows가 준 사유로 실패한다.
  const reason = `휴지통으로 보내지 못했습니다: ${path.join(dir, 'a.mp4')} (locked).`;
  assert.deepStrictEqual(result.failed.map((item) => [path.basename(item.path), item.reason]), [['a.mp4', reason]]);
  assert.ok(formatRemoveLowQuality(result).split(/\r?\n/).includes(`실패: a.mp4 (${reason})`));
});

test('remove-low-quality 명령은 기준 옵션과 --yes를 받고, 실패나 틀린 확인값은 오류로 끝낸다 (#31)', () => {
  const dir = tempDir();
  put(dir, 'a.mp4', mp4({ width: 854, height: 480 }));
  assert.match(run(['remove-low-quality', dir]), /지울 파일 0개/);
  const listed = run(['remove-low-quality', dir, '--min-height=720']);
  const code = /--yes=([0-9a-f]{12})/.exec(listed)[1];
  assert.throws(() => run(['remove-low-quality', dir, '--yes=000000000000']), /목록이 확인값을 만든 때와 달라/);
  // 기준을 빼고 확인값만 주면 다른 목록이라 지우지 않는다.
  assert.throws(() => run(['remove-low-quality', dir, `--yes=${code}`]), /목록이 확인값을 만든 때와 달라/);
  assert.throws(() => run(['remove-low-quality', dir, '--min-height=720', '--yes']), /--yes에는 목록에 나온 확인값을/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.match(run(['remove-low-quality', dir, '--min-height=720', `--yes=${code}`]), /^휴지통으로 이동: a\.mp4 /m);
  assert.ok(!fs.existsSync(path.join(dir, 'a.mp4')));
  assert.throws(() => run(['remove-low-quality', dir, '--permanent']), /--force, --permanent를 쓸 수 없습니다/);
});

test('remove-low-quality는 같은 파일의 다른 이름(하드링크)은 한 번에 하나만 지운다 (#31)', () => {
  const dir = tempDir();
  const file = put(dir, 'a.mp4', mp4({ width: 480, height: 270 }));
  fs.linkSync(file, path.join(dir, 'b.mp4'));
  const plan = removeLowQuality(dir);
  assert.deepStrictEqual(names(dir, plan.removals), ['a.mp4']);
  assert.deepStrictEqual(plan.kept.map((item) => [path.basename(item.path), /하드링크: a\.mp4/.test(item.reason)]), [['b.mp4', true]]);
});
