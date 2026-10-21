'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { resolveTarget, isInside, resolveInside } = require('../src/target');

const isWindows = process.platform === 'win32';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-target-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

test('resolveTarget은 상대경로·..가 섞인 경로를 실제 절대경로로 바꾼다', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  const messy = path.join(dir, 'a', 'b', '..', '.', 'b');
  assert.strictEqual(resolveTarget(messy), path.join(dir, 'a', 'b'));
  assert.strictEqual(resolveTarget(path.relative(process.cwd(), messy)), path.join(dir, 'a', 'b'));
});

test('resolveTarget은 없는 경로, 파일, 빈 값을 거부한다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'f.txt'), '');
  assert.throws(() => resolveTarget(path.join(dir, 'nope')), FcError);
  assert.throws(() => resolveTarget(path.join(dir, 'f.txt')), FcError);
  assert.throws(() => resolveTarget(''), FcError);
  assert.throws(() => resolveTarget(undefined), FcError);
});

test('resolveTarget은 Windows에서 대소문자가 다른 입력을 실제 이름으로 맞춘다', { skip: !isWindows }, () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'Movies'));
  assert.strictEqual(resolveTarget(path.join(dir, 'MOVIES')), path.join(dir, 'Movies'));
});

test('isInside는 타겟 자신과 그 아래 경로만 안으로 본다', () => {
  const target = path.resolve('/data/target');
  assert.ok(isInside(target, target));
  assert.ok(isInside(target, 'a.txt'));
  assert.ok(isInside(target, 'sub/../b.txt'));
  assert.ok(isInside(target, path.join(target, 'x', 'y')));
  assert.ok(isInside(target, '..foo'), '..으로 시작하는 이름은 밖이 아니다');
});

test('isInside는 ..로 빠져나가는 경로와 이름만 비슷한 형제 폴더를 밖으로 본다', () => {
  const target = path.resolve('/data/target');
  assert.ok(!isInside(target, '..'));
  assert.ok(!isInside(target, '../other/a.txt'));
  assert.ok(!isInside(target, 'sub/../../a.txt'));
  assert.ok(!isInside(target, path.resolve('/data/target2/a.txt')));
  assert.ok(!isInside(target, path.resolve('/data')));
});

test('isInside는 Windows에서 다른 드라이브를 밖으로, 대소문자 차이는 안으로 본다', { skip: !isWindows }, () => {
  const target = 'C:\\Data\\Target';
  assert.ok(!isInside(target, 'D:\\Data\\Target\\a.txt'));
  assert.ok(!isInside(target, 'D:a.txt'));
  assert.ok(isInside(target, 'c:\\data\\TARGET\\a.txt'));
  assert.ok(!isInside(target, 'c:\\data\\TARGET2\\a.txt'));
  assert.ok(!isInside(target, '..\\Other'));
});

test('resolveInside는 안쪽 경로를 절대경로로 돌려주고 밖이면 오류를 낸다', () => {
  const target = path.resolve('/data/target');
  assert.strictEqual(resolveInside(target, 'sub/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.throws(() => resolveInside(target, '../a.txt'), FcError);
  assert.throws(() => resolveInside(target, path.resolve('/etc/passwd')), FcError);
});
