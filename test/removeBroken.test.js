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
let probes = 0;
const REAL = Symbol('실제 PowerShell 호출');
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_VOLUME !== undefined) {
    probes += 1;
    if (volume === REAL) return realExecFileSync(file, args, options);
    return volume();
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
let skew = HOUR;
test.mock.method(Date, 'now', () => realNow() + skew);

const { removeBroken, formatRemoveBroken, confirmationCode, MAX_RECYCLE_SIZE } = require('../src/removeBroken');
const { recycleBinState, remove, MAX_RECYCLE_PATH } = require('../src/commands');
const { REMOVAL_LOG } = require('../src/removalLog');
const { fileStamp } = require('../src/target');
const { run } = require('../bin/fctl');

const OLD = new Date(realNow() - HOUR);
const BROKEN = '<html>찾을 수 없음</html>';
const SAME_SIZE = '<html>찾을 수 있음</html>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rmbroken-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, OLD, OLD);
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const stampOf = (file) => fileStamp(fs.lstatSync(file, { bigint: true }));

// 같은 크기의 다른 내용으로 다시 쓰고 시각을 되돌린다. Windows는 변경 시각을 시계 단위로 적어서
// 같은 단위 안에 다시 쓰면 식별값이 같다(#116). 실제로는 그런 파일을 변경 시각이 방금이라 5분 보호가 남기지만,
// 시험은 시계를 1시간 뒤로 옮겨 그 보호를 피하므로 식별값이 달라질 때까지 잠깐씩 기다리며 다시 쓴다.
function replaceSameSize(file, content) {
  const before = stampOf(file);
  for (let tries = 0; tries < 100; tries += 1) {
    fs.writeFileSync(file, content);
    fs.utimesSync(file, OLD, OLD);
    if (stampOf(file) !== before) return;
    sleep(2);
  }
  throw new Error('식별값이 바뀌지 않았습니다: ' + file);
}

const logs = (dir) => fs.readdirSync(dir).filter((name) => REMOVAL_LOG.test(name));
// 사람이 목록을 본 뒤 확인값을 붙여 실행하는 순서.
const confirmed = (dir, options = {}) => removeBroken(dir, { ...options, confirm: removeBroken(dir, options).code });
const codeIn = (report) => /--yes=([0-9a-f]+)/.exec(report)[1];

test.beforeEach(() => {
  recycled.length = 0;
  onRecycle = () => {};
  volume = () => 'True|Fixed\r\n';
  probes = 0;
  skew = HOUR;
});

test('확인값이 없으면 목록만 보여 주고 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const result = removeBroken(dir);
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [path.join(dir, 'a.mp4')]);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.match(formatRemoveBroken(result), /지울 파일: a\.mp4[\s\S]*아직 지우지 않았습니다[\s\S]*--yes=[0-9a-f]{12}/);
});

test('--dry-run은 확인값이 맞아도 아무것도 바꾸지 않고 --dry-run 없이 실행하라고 안내한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const result = removeBroken(dir, { confirm: removeBroken(dir).code, dryRun: true });
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  assert.match(formatRemoveBroken(result), /--dry-run 없이 --yes=/);
});

test('확인값이 맞으면 기록을 먼저 남기고 깨진 파일만 휴지통으로 보낸다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'sub/b.zip': Buffer.alloc(64), 'c.jpg': PNG, 'd.txt': '평범한 글', 'e.py': '' });
  let logged = null;
  onRecycle = () => {
    logged ??= logs(dir).length;
  };
  const result = confirmed(dir);
  assert.deepStrictEqual(recycled.sort(), [path.join(dir, 'a.mp4'), path.join(dir, 'sub', 'b.zip')].sort());
  assert.strictEqual(logged, 1, '지우기 전에 기록이 있어야 한다');
  for (const name of ['c.jpg', 'd.txt', 'e.py']) assert.ok(fs.existsSync(path.join(dir, name)), name);
  assert.strictEqual(result.suspect.length, 2);
  const [name] = logs(dir);
  assert.strictEqual(result.log, path.join(dir, name));
  const log = JSON.parse(fs.readFileSync(result.log, 'utf8'));
  assert.strictEqual(log.kind, '깨진 파일');
  assert.deepStrictEqual(log.items.map((item) => item.path).sort(), recycled.slice().sort());
  assert.strictEqual(log.items.find((item) => item.path.endsWith('a.mp4')).size, Buffer.byteLength(BROKEN));
  assert.ok(log.items.every((item) => item.reason.length > 0));
  assert.match(formatRemoveBroken(result), /휴지통으로 이동: a\.mp4[\s\S]*제거 기록: [\s\S]*휴지통 2개, 실패 0개/);
});

test('깨진 파일이 없으면 기록을 남기지 않고 볼륨도 확인하지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'd.txt': '평범한 글' });
  const result = confirmed(dir);
  assert.strictEqual(result.log, null);
  assert.strictEqual(result.mismatch, false);
  assert.strictEqual(probes, 0);
  assert.deepStrictEqual(logs(dir), []);
});

test('방금 바뀐 파일과 수정 시각을 보존해 방금 복사한 파일은 남긴다', () => {
  skew = 0;
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), BROKEN);
  make(dir, { 'copied.mp4': BROKEN });
  const result = confirmed(dir);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  assert.strictEqual(result.kept.length, 2);
  assert.ok(result.kept.every((item) => /받는 중/.test(item.reason)));
  assert.match(formatRemoveBroken(result), /남김: a\.mp4/);
});

test('시각이 미래인 파일은 사유를 밝히고 남긴다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const future = new Date(realNow() + 3 * HOUR);
  fs.utimesSync(path.join(dir, 'a.mp4'), future, future);
  const result = removeBroken(dir);
  assert.strictEqual(result.removals.length, 0);
  assert.match(result.kept[0].reason, /미래/);
});

test('5분 기준은 가장 늦은 시각에서 잰다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const stat = fs.lstatSync(path.join(dir, 'a.mp4'));
  const latest = Math.max(stat.mtimeMs, stat.birthtimeMs, stat.ctimeMs);
  const FIVE = 5 * 60 * 1000;
  assert.strictEqual(removeBroken(dir, { now: latest + FIVE - 1 }).removals.length, 0);
  assert.strictEqual(removeBroken(dir, { now: latest + FIVE }).removals.length, 1);
});

test('받기 도구의 표시 파일이 옆에 있으면 오래된 파일도 남기고 표시 파일 이름을 보고한다', () => {
  const dir = tempDir();
  // 크기를 미리 잡고 받는 도구는 받는 중인 파일을 제 이름으로 두고 뒤를 0으로 채운다.
  const ZEROS = Buffer.alloc(64);
  make(dir, {
    'x.mp4': BROKEN,
    'x.mp4.part': '받는 중',
    'z.mp4': ZEROS,
    'z.mp4.aria2': '받기 상태',
    'Chrome.mp4': BROKEN,
    'chrome.MP4.crdownload': '',
    'frag.mp4': BROKEN,
    'frag.mp4.part-Frag12': '',
    'thunder.mp4': ZEROS,
    'thunder.mp4.td.cfg': '',
    'qb.mkv': ZEROS,
    'qb.mkv.!qB': '',
    'sub/deep.zip': ZEROS,
    'sub/deep.zip.ytdl': '',
    'gone.mp4': BROKEN,
  });
  // Safari는 받는 중인 파일을 표시 폴더 안에 둔다.
  make(dir, { 'safari.mp4.download/safari.mp4': BROKEN, 'Old.mp4.Download/old.mp4': BROKEN });
  const result = confirmed(dir);
  assert.deepStrictEqual(recycled, [path.join(dir, 'gone.mp4')]);
  const kept = Object.fromEntries(result.kept.map((item) => [path.relative(dir, item.path), item.reason]));
  const expected = {
    'x.mp4': 'x.mp4.part',
    'z.mp4': 'z.mp4.aria2',
    'Chrome.mp4': 'chrome.MP4.crdownload',
    'frag.mp4': 'frag.mp4.part-Frag12',
    'thunder.mp4': 'thunder.mp4.td.cfg',
    'qb.mkv': 'qb.mkv.!qB',
    [path.join('sub', 'deep.zip')]: 'deep.zip.ytdl',
    [path.join('safari.mp4.download', 'safari.mp4')]: 'safari.mp4.download',
    [path.join('Old.mp4.Download', 'old.mp4')]: 'Old.mp4.Download',
  };
  assert.deepStrictEqual(Object.keys(kept).sort(), Object.keys(expected).sort());
  for (const [name, marker] of Object.entries(expected)) {
    assert.ok(kept[name].includes(`(${marker})`), `${name}: ${kept[name]}`);
    assert.match(kept[name], /받는 중일 수 있어 남겼습니다/);
  }
  assert.match(kept[path.join('safari.mp4.download', 'safari.mp4')], /표시 폴더\(safari\.mp4\.download\) 안에 있어/);
  assert.match(formatRemoveBroken(result), /남김: x\.mp4 \(받기 도구의 표시 파일\(x\.mp4\.part\)이 옆에 있어/);
});

test('표시로 보는 꼬리는 모두 대소문자와 관계없이 파일을 남긴다', () => {
  const suffixes = ['.part', '.part-Frag3', '.crdownload', '.partial', '.download', '.opdownload', '.fdmdownload', '.aria2', '.ytdl', '.td', '.td.cfg', '.xltd', '.!qB', '.!ut', '.bc!'];
  for (const suffix of [...suffixes, ...suffixes.map((item) => item.toUpperCase())]) {
    const dir = tempDir();
    make(dir, { 'v.mp4': BROKEN, [`v.mp4${suffix}`]: '' });
    const result = removeBroken(dir);
    assert.strictEqual(result.removals.length, 0, suffix);
    assert.ok(result.kept[0].reason.includes(`(v.mp4${suffix})`), `${suffix}: ${result.kept[0].reason}`);
  }
});

test('방금 바뀐 파일은 표시 파일보다 방금 바뀐 사유를, 표시 파일은 1GB 사유보다 먼저 보고한다', () => {
  const dir = tempDir();
  make(dir, { 'x.mp4.part': '' });
  fs.writeFileSync(path.join(dir, 'x.mp4'), BROKEN);
  const stat = fs.lstatSync(path.join(dir, 'x.mp4'));
  const latest = Math.max(stat.mtimeMs, stat.birthtimeMs, stat.ctimeMs);
  assert.match(removeBroken(dir, { now: latest + 1000 }).kept[0].reason, /방금 바뀐 파일/);
  const big = removeBroken(dir, { maxSize: 1 });
  assert.match(big.kept[0].reason, /표시 파일\(x\.mp4\.part\)/);
});

test('표시 파일을 보려고 폴더를 읽지 못하면 그 폴더의 깨진 파일을 모두 남기고 폴더는 한 번만 읽는다', (t) => {
  const dir = tempDir();
  make(dir, { 'sub/a.mp4': BROKEN, 'sub/b.mp4': BROKEN, 'c.mp4': BROKEN });
  const sub = path.join(dir, 'sub');
  const realReaddir = fs.readdirSync;
  let reads = 0;
  // 판별(walk)은 폴더를 { withFileTypes: true }로 읽으므로, 표시 파일을 보려고 이름 목록만 읽는 것을 막는다.
  t.mock.method(fs, 'readdirSync', function readdir(target, ...rest) {
    if (target === sub && rest.length === 0) {
      reads += 1;
      throw Object.assign(new Error('막힘'), { code: 'EPERM' });
    }
    return realReaddir.call(this, target, ...rest);
  });
  const result = removeBroken(dir);
  assert.deepStrictEqual(result.removals.map((item) => path.basename(item.path)), ['c.mp4']);
  assert.strictEqual(result.kept.length, 2);
  assert.ok(result.kept.every((item) => /폴더를 읽지 못해 남겼습니다\. \(EPERM\)/.test(item.reason)), JSON.stringify(result.kept));
  assert.strictEqual(reads, 1);
});

test('이름이 정확히 이어지지 않거나 다른 폴더에 있는 표시 파일은 파일을 남기지 않는다', () => {
  const dir = tempDir();
  make(dir, {
    'a.mp4': BROKEN,
    'a.mp4.bak': '',
    'a.mp4.part.txt': '',
    'a.part': '',
    'xa.mp4.part': '',
    'a.mp4part': '',
    'other/a.mp4.crdownload': '',
    'b.mp4': BROKEN,
    'sub/b.mp4.aria2': '',
  });
  const result = removeBroken(dir);
  assert.deepStrictEqual(result.removals.map((item) => path.basename(item.path)).sort(), ['a.mp4', 'b.mp4']);
  assert.deepStrictEqual(result.kept, []);
});

test('표시 파일을 지우면 다음 실행에서 지울 수 있다', () => {
  const dir = tempDir();
  make(dir, { 'x.mp4': BROKEN, 'x.mp4.part': '받는 중' });
  const first = removeBroken(dir);
  assert.strictEqual(first.removals.length, 0);
  assert.strictEqual(first.kept.length, 1);
  fs.rmSync(path.join(dir, 'x.mp4.part'));
  confirmed(dir);
  assert.deepStrictEqual(recycled, [path.join(dir, 'x.mp4')]);
});

test('미리 본 뒤 표시 파일이 생기면 아무것도 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'x.mp4': BROKEN, 'y.mp4': BROKEN });
  const { code } = removeBroken(dir);
  make(dir, { 'x.mp4.crdownload': '' });
  const result = removeBroken(dir, { confirm: code });
  assert.strictEqual(result.mismatch, true);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('미리 본 목록에 없던 파일이 생기면 아무것도 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const { code } = removeBroken(dir);
  make(dir, { 'new.mp4': BROKEN });
  const result = removeBroken(dir, { confirm: code });
  assert.strictEqual(result.mismatch, true);
  assert.strictEqual(result.confirmed, false);
  assert.notStrictEqual(result.code, code);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('미리 볼 때 남김이던 파일이 시간이 지나 대상이 되면 아무것도 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  const { code, removals } = removeBroken(dir, { now: realNow() });
  assert.strictEqual(removals.length, 0);
  const result = removeBroken(dir, { confirm: code });
  assert.strictEqual(result.removals.length, 2);
  assert.strictEqual(result.mismatch, true);
  assert.deepStrictEqual(recycled, []);
});

test('같은 크기로 바꾸고 수정 시각을 되돌려도 확인값이 달라진다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const { code } = removeBroken(dir);
  assert.strictEqual(Buffer.byteLength(BROKEN), Buffer.byteLength(SAME_SIZE));
  replaceSameSize(path.join(dir, 'a.mp4'), SAME_SIZE);
  const result = removeBroken(dir, { confirm: code });
  assert.strictEqual(result.mismatch, true);
  assert.deepStrictEqual(recycled, []);
});

test('판별하는 사이에 같은 크기의 다른 파일로 바뀌면 남긴다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const { readSync } = fs;
  let replaced = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const n = readSync(...args);
    if (!replaced) {
      replaced = true;
      replaceSameSize(path.join(dir, 'a.mp4'), SAME_SIZE);
    }
    return n;
  });
  const result = removeBroken(dir);
  t.mock.restoreAll();
  assert.strictEqual(replaced, true);
  assert.deepStrictEqual(result.removals, []);
  assert.match(result.kept[0].reason, /바뀌어 남겼습니다/);
});

test('기록을 쓴 뒤 파일이 바뀌면 같은 크기와 시각이어도 지우지 않고 실패로 보고한다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  const { code } = removeBroken(dir);
  const { fsyncSync } = fs;
  t.mock.method(fs, 'fsyncSync', (...args) => {
    fsyncSync(...args);
    replaceSameSize(path.join(dir, 'a.mp4'), SAME_SIZE);
  });
  const result = removeBroken(dir, { confirm: code });
  t.mock.restoreAll();
  assert.deepStrictEqual(recycled, [path.join(dir, 'b.mp4')]);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /바뀌어 지우지 않았습니다/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});

test('저장소이거나 저장소를 담은 타겟은 미리보기부터 거부한다', () => {
  const dir = tempDir();
  make(dir, { 'repo/.git/x.zip': BROKEN, 'repo/a.mp4': BROKEN, 'repo/sub/b.mp4': BROKEN });
  assert.throws(() => removeBroken(dir), /저장소/);
  assert.throws(() => removeBroken(path.join(dir, 'repo')), /저장소/);
  assert.throws(() => removeBroken(path.join(dir, 'repo', '.git')), /저장소/);
  assert.strictEqual(removeBroken(path.join(dir, 'repo', 'sub')).removals.length, 1);
  assert.deepStrictEqual(recycled, []);
});

test('1GB 이상인 파일은 영구 삭제될 수 있어 남긴다', () => {
  const dir = tempDir();
  make(dir, { 'big.mp4': BROKEN, 'small.mp4': '<html></html>' });
  const limit = Buffer.byteLength(BROKEN);
  const result = removeBroken(dir, { maxSize: limit });
  assert.deepStrictEqual(result.removals.map((item) => path.basename(item.path)), ['small.mp4']);
  assert.deepStrictEqual(result.kept.map((item) => path.basename(item.path)), ['big.mp4']);
  assert.match(result.kept[0].reason, /영구 삭제/);
});

for (const [name, answer, pattern] of [
  ['이동식', () => 'True|Removable\r\n', /고정 디스크가 아니라\(Removable\)/],
  ['네트워크', () => 'True|Network\r\n', /고정 디스크가 아니라\(Network\)/],
  ['확인 실패', () => { throw new Error('실행 실패'); }, /볼륨 종류를 확인하지 못해/],
  ['알 수 없는 답', () => '뜻밖의 출력', /볼륨 종류를 확인하지 못해/],
]) {
  test(`고정 디스크로 확인되지 않으면 지우지 않고 남긴다: ${name}`, () => {
    const dir = tempDir();
    make(dir, { 'a.mp4': BROKEN });
    volume = answer;
    const result = confirmed(dir);
    assert.strictEqual(result.removals.length, 0);
    assert.match(result.kept[0].reason, pattern);
    assert.deepStrictEqual(recycled, []);
    assert.deepStrictEqual(logs(dir), []);
  });
}

test('비대화형이면 기록을 남기기 전에 멈추고, 볼륨은 실행마다 한 번만 확인한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  volume = () => 'False|Fixed\r\n';
  const { code } = removeBroken(dir);
  assert.strictEqual(probes, 1);
  assert.throws(() => removeBroken(dir, { confirm: code }), /대화형 세션/);
  assert.strictEqual(probes, 2);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('한 파일이 휴지통으로 가지 못해도 나머지는 계속하고, 사유에 스크립트를 적지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  onRecycle = (target) => {
    if (target.endsWith('a.mp4')) throw Object.assign(new Error('Command failed: powershell.exe Add-Type 스크립트 전문'), { status: 3 });
  };
  const result = confirmed(dir);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].reason, '휴지통으로 보내지 못했습니다. (종료 코드 3)');
  assert.strictEqual(result.removed.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, 'b.mp4')));
});

test('remove-broken은 실제로 지울 때 파일마다 몇 번째인지와 결과를 진행 줄로 넘기고, 목록만 볼 때는 넘기지 않는다 (#99)', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN, 'c.mp4': BROKEN });
  onRecycle = (target) => {
    if (target.endsWith('b.mp4')) throw Object.assign(new Error('recycle'), { status: 3 });
  };
  const lines = [];
  const onProgress = (line) => lines.push(line);
  const listed = removeBroken(dir, { onProgress });
  removeBroken(dir, { onProgress, dryRun: true, confirm: listed.code });
  assert.deepStrictEqual(lines, []);
  const result = removeBroken(dir, { onProgress, confirm: listed.code });
  assert.strictEqual(result.removed.length, 2);
  assert.deepStrictEqual(lines, [
    '휴지통으로 보내는 중: 3개 (파일당 0.5초 안팎)',
    '1/3 휴지통으로 이동: a.mp4',
    '2/3 실패: b.mp4 (휴지통으로 보내지 못했습니다. (종료 코드 3))',
    '3/3 휴지통으로 이동: c.mp4',
  ]);
});

test('fctl remove-broken은 진행 줄을 progress로 넘긴다 (#99)', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const code = removeBroken(dir).code;
  const lines = [];
  run(['remove-broken', dir, `--yes=${code}`], { progress: (line) => lines.push(line) });
  assert.deepStrictEqual(lines, ['휴지통으로 보내는 중: 1개 (파일당 0.5초 안팎)', '1/1 휴지통으로 이동: a.mp4']);
});

// 전체 경로가 length자인 파일 경로. 파일 이름이 20자 남짓 남도록 폴더 두 단계로 길이를 맞춘다.
function pathOfLength(dir, length, ext = '.mp4') {
  const rest = length - dir.length - 2 - 20 - ext.length;
  if (rest < 2) throw new Error('임시 폴더 경로가 너무 길어 시험할 수 없습니다: ' + dir);
  const sub = path.join(dir, 'p'.repeat(Math.ceil(rest / 2)), 'q'.repeat(Math.floor(rest / 2) - 1));
  const name = 'r'.repeat(length - sub.length - 1 - ext.length) + ext;
  return path.join(sub, name);
}

test('휴지통으로 보낼 수 없는 긴 경로(260자 이상)는 계획에서 남기고 259자는 지운다 (#101)', () => {
  const dir = tempDir();
  const long = pathOfLength(dir, 260);
  const fits = pathOfLength(dir, 259, '.zip');
  make(dir, { [path.relative(dir, long)]: BROKEN, [path.relative(dir, fits)]: Buffer.alloc(64) });
  const plan = removeBroken(dir);
  assert.deepStrictEqual(plan.removals.map((item) => item.path), [fits]);
  assert.deepStrictEqual(plan.kept, [{ path: long, reason: '경로가 260자라 휴지통으로 보낼 수 있는 259자를 넘어 남겼습니다. 이름을 줄이거나 위 폴더로 옮긴 뒤 다시 실행하세요.' }]);
  const result = confirmed(dir);
  assert.deepStrictEqual(recycled, [fits]);
  assert.deepStrictEqual(result.failed, []);
  assert.ok(fs.existsSync(long));
});

test('rm도 휴지통 한도를 넘는 경로는 PowerShell을 부르지 않고 사유를 밝혀 거부한다 (#101)', () => {
  const dir = tempDir();
  const long = pathOfLength(dir, 300);
  make(dir, { [path.relative(dir, long)]: 'x' });
  assert.throws(() => remove([long]), (err) => err.message === `경로가 300자라 휴지통으로 보낼 수 없습니다(${MAX_RECYCLE_PATH}자까지): ${long}`);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(long));
  assert.strictEqual(MAX_RECYCLE_PATH, 259);
});

const linkReason = (other) => `같은 파일의 다른 이름(하드링크: ${path.basename(other)})을 이번에 먼저 지우므로 파일의 변경 시각이 바뀌어 함께 지울 수 없어 남겼습니다. 5분 뒤 다시 실행할 때마다 이름을 하나씩 지웁니다.`;

test('같은 파일의 하드링크 두 이름은 하나만 지우고 다른 이름은 실제 사유로 남긴다 (#101)', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  fs.linkSync(path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4'));
  const plan = removeBroken(dir);
  assert.strictEqual(plan.removals.length, 1);
  assert.strictEqual(plan.kept.length, 1);
  const [first] = plan.removals;
  const [other] = plan.kept;
  assert.deepStrictEqual([first.path, other.path].sort(), [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')]);
  assert.strictEqual(other.reason, linkReason(first.path));
  const result = confirmed(dir);
  assert.deepStrictEqual(recycled, [first.path]);
  assert.deepStrictEqual(result.failed, []);
  assert.ok(fs.existsSync(other.path));
  // 다시 실행하면 남은 이름은 5분 동안 방금 바뀐 파일로 남고, 그 뒤에는 지운다. 시계를 1분만 옮겨 미래 시각으로 보지 않게 한다.
  skew = 60 * 1000;
  assert.deepStrictEqual(removeBroken(dir).kept, [{ path: other.path, reason: '방금 바뀐 파일이라 받는 중일 수 있어 남겼습니다.' }]);
  skew = HOUR;
  assert.deepStrictEqual(confirmed(dir).removed.map((item) => item.path), [other.path]);
});

test('하드링크 이름이 셋이면 실행할 때마다 하나씩 지운다 (#101)', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  for (const name of ['b.mp4', 'c.mp4']) fs.linkSync(path.join(dir, 'a.mp4'), path.join(dir, name));
  const first = confirmed(dir);
  assert.deepStrictEqual(first.removed.map((item) => item.path), [path.join(dir, 'a.mp4')]);
  assert.deepStrictEqual(first.kept.map((item) => [item.path, item.reason]), ['b.mp4', 'c.mp4'].map((name) => [path.join(dir, name), linkReason('a.mp4')]));
  const second = confirmed(dir);
  assert.deepStrictEqual(second.removed.map((item) => item.path), [path.join(dir, 'b.mp4')]);
  assert.deepStrictEqual(second.kept.map((item) => [item.path, item.reason]), [[path.join(dir, 'c.mp4'), linkReason('b.mp4')]]);
  assert.deepStrictEqual(confirmed(dir).removed.map((item) => item.path), [path.join(dir, 'c.mp4')]);
});

test('고정 디스크가 아니면 하드링크의 다른 이름도 하드링크 사유가 아니라 볼륨 사유로 남긴다 (#101)', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  fs.linkSync(path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4'));
  for (const [answer, reason] of [
    ['True|Removable\r\n', '고정 디스크가 아니라(Removable) 영구 삭제될 수 있어 남겼습니다.'],
    ['', '볼륨 종류를 확인하지 못해 남겼습니다.'],
  ]) {
    volume = () => answer;
    const plan = removeBroken(dir);
    assert.deepStrictEqual(plan.removals, []);
    assert.deepStrictEqual(plan.kept.map((item) => [item.path, item.reason]).sort(), [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')].map((file) => [file, reason]));
  }
});

test('타겟 밖에 다른 이름이 있는 하드링크는 그대로 지운다 (#101)', () => {
  const outside = tempDir();
  const dir = tempDir();
  make(outside, { 'keep.mp4': BROKEN });
  fs.linkSync(path.join(outside, 'keep.mp4'), path.join(dir, 'a.mp4'));
  const result = confirmed(dir);
  assert.deepStrictEqual(recycled, [path.join(dir, 'a.mp4')]);
  assert.deepStrictEqual(result.kept, []);
  assert.ok(fs.existsSync(path.join(outside, 'keep.mp4')));
});

test('기록을 남기지 못하면 아무것도 지우지 않는다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const { code } = removeBroken(dir);
  t.mock.method(fs, 'fsyncSync', () => {
    throw Object.assign(new Error('디스크'), { code: 'ENOSPC' });
  });
  assert.throws(() => removeBroken(dir, { confirm: code }), /기록 파일을 쓰지 못했습니다/);
  t.mock.restoreAll();
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.deepStrictEqual(logs(dir), []);
});

test('다시 실행해도 제거 기록을 깨진 파일로 보지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const { log } = confirmed(dir);
  const again = confirmed(dir);
  assert.strictEqual(again.removals.length, 0);
  assert.ok(fs.existsSync(log));
  assert.strictEqual(logs(dir).length, 1);
});

// 폴더를 옮기고 그 자리에 정션을 둔다. 파일 자체는 그대로라 식별값으로는 잡히지 않는다.
function swapWithJunction(dir) {
  fs.renameSync(path.join(dir, 'sub'), path.join(dir, 'moved'));
  fs.symlinkSync(path.join(dir, 'moved'), path.join(dir, 'sub'), 'junction');
}

test('판별한 뒤 폴더가 정션으로 바뀌면 계획에서 남긴다', (t) => {
  const dir = tempDir();
  make(dir, { 'sub/a.mp4': BROKEN });
  const { closeSync } = fs;
  let swapped = false;
  t.mock.method(fs, 'closeSync', (...args) => {
    closeSync(...args);
    if (!swapped) {
      swapped = true;
      swapWithJunction(dir);
    }
  });
  const result = removeBroken(dir);
  t.mock.restoreAll();
  assert.strictEqual(swapped, true);
  assert.deepStrictEqual(result.removals, []);
  assert.strictEqual(result.kept.length, 1);
  assert.deepStrictEqual(recycled, []);
});

test('계획한 뒤 기록 전에 폴더가 정션으로 바뀌면 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'sub/a.mp4': BROKEN });
  const { code } = removeBroken(dir);
  volume = () => {
    swapWithJunction(dir);
    return 'True|Fixed\r\n';
  };
  let failed;
  try {
    failed = removeBroken(dir, { confirm: code }).failed;
  } catch (err) {
    failed = [{ reason: err.message }];
  }
  assert.strictEqual(failed.length, 1);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'moved', 'a.mp4')));
});

test('기록한 뒤 폴더가 정션으로 바뀌면 지우지 않고 실패로 보고한다', (t) => {
  const dir = tempDir();
  make(dir, { 'sub/a.mp4': BROKEN });
  const { code } = removeBroken(dir);
  const { fsyncSync } = fs;
  t.mock.method(fs, 'fsyncSync', (...args) => {
    fsyncSync(...args);
    swapWithJunction(dir);
  });
  const result = removeBroken(dir, { confirm: code });
  t.mock.restoreAll();
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'moved', 'a.mp4')));
});

test('판단 못함은 지우지 않고 나머지만 지운다', (t) => {
  const dir = tempDir();
  make(dir, { 'locked.mp4': BROKEN, 'b.mp4': BROKEN });
  const { code } = removeBroken(dir);
  const { openSync } = fs;
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (String(file).endsWith('locked.mp4')) throw Object.assign(new Error('잠김'), { code: 'EBUSY' });
    return openSync(file, ...rest);
  });
  const preview = removeBroken(dir);
  assert.notStrictEqual(preview.code, code);
  const result = removeBroken(dir, { confirm: preview.code });
  t.mock.restoreAll();
  assert.strictEqual(result.unreadable.length, 1);
  assert.deepStrictEqual(recycled, [path.join(dir, 'b.mp4')]);
  assert.ok(fs.existsSync(path.join(dir, 'locked.mp4')));
  assert.match(formatRemoveBroken(result), /판단 못함, 지우지 않음: locked\.mp4/);
});

test('확인값은 타겟, 경로, 사유, 식별값 중 하나만 달라도 달라지고 순서에는 영향받지 않는다', () => {
  const a = { path: 'C:\\t\\a.mp4', reason: '깨짐', stamp: '1:2:3:4' };
  const b = { path: 'C:\\t\\b.mp4', reason: '깨짐', stamp: '5:6:7:8' };
  const base = confirmationCode({ target: 'C:\\t', removals: [a, b] });
  assert.strictEqual(confirmationCode({ target: 'C:\\t', removals: [b, a] }), base);
  for (const changed of [
    { target: 'C:\\u', removals: [a, b] },
    { target: 'C:\\t', removals: [{ ...a, path: 'C:\\t\\c.mp4' }, b] },
    { target: 'C:\\t', removals: [{ ...a, reason: '다른 사유' }, b] },
    { target: 'C:\\t', removals: [{ ...a, stamp: '1:2:3:9' }, b] },
    { target: 'C:\\t', removals: [a] },
  ]) assert.notStrictEqual(confirmationCode(changed), base);
});

test('영구 삭제를 피하는 크기 기준은 1GB다', () => {
  assert.strictEqual(MAX_RECYCLE_SIZE, 1024 * 1024 * 1024);
});

test('볼륨 확인은 실제 PowerShell에서 세션과 드라이브 종류를 돌려준다', { skip: process.platform !== 'win32' }, () => {
  volume = REAL;
  const state = recycleBinState(os.tmpdir());
  assert.strictEqual(typeof state.interactive, 'boolean');
  assert.match(state.driveType, /^(?:Fixed|Removable|Network|CDRom|Ram|NoRootDirectory|Unknown)$/);
});

test('본 목록의 파일이 모두 남김이 되면 맞지 않는 값으로 보고한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const { code } = removeBroken(dir);
  volume = () => 'True|Removable\r\n';
  const result = removeBroken(dir, { confirm: code });
  assert.strictEqual(result.removals.length, 0);
  assert.strictEqual(result.mismatch, true);
  assert.throws(() => run(['remove-broken', dir, `--yes=${code}`]), /아무것도 지우지 않았습니다/);
  assert.deepStrictEqual(recycled, []);
});

test('fctl remove-broken은 확인값이 맞아야 지운다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  const code = codeIn(run(['remove-broken', dir]));
  assert.match(run(['remove-broken', dir, '--dry-run', `--yes=${code}`]), /--dry-run 없이/);
  assert.match(run(['remove-broken', dir, '--dry-run', '--yes']), /아직 지우지 않았습니다/);
  const isRefused = (pattern) => (err) => pattern.test(err.message) && /아직 지우지 않았습니다/.test(err.output);
  assert.throws(() => run(['remove-broken', dir, '--yes']), isRefused(/확인값을 붙이세요/));
  assert.throws(() => run(['remove-broken', dir, '--yes=']), isRefused(/아무것도 지우지 않았습니다/));
  assert.throws(() => run(['remove-broken', dir, '--yes=000000000000']), isRefused(/아무것도 지우지 않았습니다/));
  assert.deepStrictEqual(recycled, []);
  assert.match(run(['remove-broken', dir, `--yes=${code}`]), /휴지통으로 이동: a\.mp4/);
  assert.strictEqual(recycled.length, 2);
});

test('fctl remove-broken은 실패해도 옮긴 파일을 표준 출력 보고에 담고 오류로 끝난다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  const code = codeIn(run(['remove-broken', dir]));
  onRecycle = (target) => {
    if (target.endsWith('a.mp4')) throw new Error('잠김');
  };
  assert.throws(() => run(['remove-broken', dir, `--yes=${code}`]), (err) => {
    assert.match(err.message, /보내지 못한 파일이 1개/);
    assert.doesNotMatch(err.message, /휴지통으로 이동/);
    assert.match(err.output, /휴지통으로 이동: b\.mp4/);
    assert.match(err.output, /실패: a\.mp4/);
    return true;
  });
});

test('--yes는 remove-broken에서만 쓰고, --force와 --permanent는 거부한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  assert.throws(() => run(['find-broken', dir, '--yes']), /--yes는 remove-broken/);
  assert.throws(() => run(['find-broken', dir, '--yes=abc']), /--yes는 remove-broken/);
  assert.throws(() => run(['remove-broken', dir, '--permanent', '--yes']), /--permanent/);
  assert.throws(() => run(['remove-broken', dir, '--force', '--yes']), /--force/);
  assert.deepStrictEqual(recycled, []);
});
