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
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_VOLUME !== undefined) {
    probes += 1;
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

const { removeBroken, formatRemoveBroken } = require('../src/removeBroken');
const { REMOVAL_LOG } = require('../src/removalLog');
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
  make(dir, { 'a.mp4': SAME_SIZE });
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
      make(dir, { 'a.mp4': SAME_SIZE });
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
    make(dir, { 'a.mp4': SAME_SIZE });
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
