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
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  onRecycle(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET);
  return Buffer.alloc(0);
});

const { removeBroken, formatRemoveBroken } = require('../src/removeBroken');
const { REMOVAL_LOG } = require('../src/removalLog');
const { run } = require('../bin/fctl');

const OLD = new Date(Date.now() - 60 * 60 * 1000);
const BROKEN = '<html>찾을 수 없음</html>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rmbroken-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

// 받는 중인 파일로 보지 않게 오래전에 바뀐 파일로 만든다.
function make(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, OLD, OLD);
  }
}

const logs = (dir) => fs.readdirSync(dir).filter((name) => REMOVAL_LOG.test(name));

test.beforeEach(() => {
  recycled.length = 0;
  onRecycle = () => {};
});

test('--yes가 없으면 목록만 보여 주고 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const result = removeBroken(dir);
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(result.removals.map((item) => item.path), [path.join(dir, 'a.mp4')]);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.match(formatRemoveBroken(result), /지울 파일: a\.mp4[\s\S]*아직 지우지 않았습니다/);
});

test('--dry-run은 --yes가 있어도 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const result = removeBroken(dir, { yes: true, dryRun: true });
  assert.strictEqual(result.confirmed, false);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
});

test('--yes면 기록을 먼저 남기고 깨진 파일만 휴지통으로 보낸다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'sub/b.zip': Buffer.alloc(64), 'c.jpg': PNG, 'd.txt': '평범한 글', 'e.py': '' });
  let logged = null;
  onRecycle = () => {
    logged ??= logs(dir).length;
  };
  const result = removeBroken(dir, { yes: true });
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

test('깨진 파일이 없으면 기록을 남기지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'd.txt': '평범한 글' });
  const result = removeBroken(dir, { yes: true });
  assert.strictEqual(result.log, null);
  assert.deepStrictEqual(logs(dir), []);
});

test('방금 바뀐 파일은 받는 중일 수 있어 남긴다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), BROKEN);
  const result = removeBroken(dir, { yes: true });
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(logs(dir), []);
  assert.match(result.kept[0].reason, /받는 중/);
  assert.match(formatRemoveBroken(result), /남김: a\.mp4/);
});

test('기록을 쓴 뒤 파일이 바뀌면 지우지 않고 실패로 보고한다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  const { fsyncSync } = fs;
  t.mock.method(fs, 'fsyncSync', (...args) => {
    fsyncSync(...args);
    fs.writeFileSync(path.join(dir, 'a.mp4'), '이제 다른 내용으로 바뀐 파일입니다');
  });
  const result = removeBroken(dir, { yes: true });
  t.mock.restoreAll();
  assert.deepStrictEqual(recycled, [path.join(dir, 'b.mp4')]);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /바뀌어 지우지 않았습니다/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});

test('한 파일이 휴지통으로 가지 못해도 나머지는 계속한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  onRecycle = (target) => {
    if (target.endsWith('a.mp4')) throw new Error('잠김');
  };
  const result = removeBroken(dir, { yes: true });
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.removed.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, 'b.mp4')));
});

test('기록을 남기지 못하면 아무것도 지우지 않는다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  t.mock.method(fs, 'fsyncSync', () => {
    throw Object.assign(new Error('디스크'), { code: 'ENOSPC' });
  });
  assert.throws(() => removeBroken(dir, { yes: true }), /기록 파일을 쓰지 못했습니다/);
  t.mock.restoreAll();
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.deepStrictEqual(logs(dir), []);
});

test('다시 실행해도 제거 기록을 깨진 파일로 보지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  const { log } = removeBroken(dir, { yes: true });
  const again = removeBroken(dir, { yes: true });
  assert.strictEqual(again.removals.length, 0);
  assert.ok(fs.existsSync(log));
  assert.strictEqual(logs(dir).length, 1);
});

test('fctl remove-broken은 --yes가 있어야 지우고, 실패하면 오류로 끝난다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN, 'b.mp4': BROKEN });
  assert.match(run(['remove-broken', dir]), /아직 지우지 않았습니다/);
  assert.match(run(['remove-broken', dir, '--dry-run', '--yes']), /아직 지우지 않았습니다/);
  assert.deepStrictEqual(recycled, []);
  onRecycle = (target) => {
    if (target.endsWith('a.mp4')) throw new Error('잠김');
  };
  assert.throws(() => run(['remove-broken', dir, '--yes']), /실패: a\.mp4/);
  onRecycle = () => {};
  fs.utimesSync(path.join(dir, 'a.mp4'), OLD, OLD);
  assert.match(run(['remove-broken', dir, '--yes']), /휴지통으로 이동: a\.mp4/);
});

test('--yes는 remove-broken에서만 쓰고, --force와 --permanent는 거부한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': BROKEN });
  assert.throws(() => run(['find-broken', dir, '--yes']), /--yes는 remove-broken/);
  assert.throws(() => run(['remove-broken', dir, '--permanent', '--yes']), /--permanent/);
  assert.throws(() => run(['remove-broken', dir, '--force', '--yes']), /--force/);
  assert.deepStrictEqual(recycled, []);
});
