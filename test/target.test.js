'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { resolveTarget, isInside, resolveInside, walk } = require('../src/target');

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

// Windows에서는 디렉토리 심볼릭 링크에 관리자 권한이 필요해서 정션을 쓴다.
function linkDir(from, to) {
  fs.symlinkSync(from, to, isWindows ? 'junction' : 'dir');
}

function listing(dir) {
  return walk(dir).map((e) => [e.relative.split(path.sep).join('/'), e.type]);
}

test('walk는 하위 폴더까지 재귀로 읽고, 폴더가 그 안의 항목보다 먼저 오게 정렬한다', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.writeFileSync(path.join(dir, 'a', 'b', 'deep.txt'), '');
  fs.writeFileSync(path.join(dir, 'a', 'x.txt'), '');
  fs.writeFileSync(path.join(dir, 'a.txt'), '');
  fs.writeFileSync(path.join(dir, 'a b.txt'), '');
  assert.deepStrictEqual(listing(dir), [
    ['a', 'dir'],
    ['a/b', 'dir'],
    ['a/b/deep.txt', 'file'],
    ['a/x.txt', 'file'],
    ['a b.txt', 'file'],
    ['a.txt', 'file'],
    ['empty', 'dir'],
  ]);
});

test('walk의 path는 타겟 기준 절대경로이고, 상대경로·..가 섞인 타겟도 받는다', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), '');
  const [sub, file] = walk(path.join(dir, 'sub', '..'));
  assert.strictEqual(sub.path, path.join(dir, 'sub'));
  assert.strictEqual(file.path, path.join(dir, 'sub', 'f.txt'));
});

test('walk는 링크·정션을 link로만 표시하고 따라 들어가지 않는다', () => {
  const root = tempDir();
  const outside = path.join(root, 'outside');
  const target = path.join(root, 'target');
  fs.mkdirSync(outside);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(outside, 'secret.txt'), '');
  linkDir(outside, path.join(target, 'escape'));
  linkDir(target, path.join(target, 'loop'));
  assert.deepStrictEqual(listing(target), [
    ['escape', 'link'],
    ['loop', 'link'],
  ]);
});

test('walk는 빈 폴더면 빈 목록을, 없는 경로나 파일이면 오류를 낸다', () => {
  const dir = tempDir();
  assert.deepStrictEqual(walk(dir), []);
  fs.writeFileSync(path.join(dir, 'f.txt'), '');
  assert.throws(() => walk(path.join(dir, 'nope')), FcError);
  assert.throws(() => walk(path.join(dir, 'f.txt')), FcError);
});
