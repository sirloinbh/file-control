'use strict';

// 하드링크 정책(#48): 읽기·삭제·이름 바꾸기는 그대로 두고, 같은 파일의 다른 이름까지 바뀌는 내용 쓰기만 거부한다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('../src/commands');
const { grant } = require('../src/target');

const isWindows = process.platform === 'win32';
// 임시 폴더가 AppData 아래라 grant가 보호 경로로 거부하므로 사용자 폴더를 가짜 경로로 바꿔 둔다(target.test.js와 같다).
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const HARD_LINKED = /changing the content of a hard link would also change \d+ other name\(s\) of the same file/;

// outside/secret.txt와 같은 파일인 target/hard.txt를 만든다.
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-hard-')));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  const target = path.join(root, 'target');
  fs.mkdirSync(outside);
  fs.mkdirSync(target);
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET');
  const hard = path.join(target, 'hard.txt');
  fs.linkSync(secret, hard);
  fs.writeFileSync(path.join(root, 'src.txt'), 'NEW');
  return { root, outside, target, secret, hard, src: path.join(root, 'src.txt') };
}

test('write는 하드링크의 내용을 덮어쓰거나 덧붙이지 않고 다른 이름의 내용을 그대로 둔다 (#48)', () => {
  const { secret, hard } = fixture();
  for (const options of [{ force: true }, { append: true }, { force: true, dryRun: true }, { append: true, dryRun: true }]) {
    assert.throws(() => fc.writeFile(hard, 'X', options), HARD_LINKED, JSON.stringify(options));
  }
  assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'SECRET');
  assert.strictEqual(fc.readFile(hard), 'SECRET');
});

test('cp --force는 하드링크를 덮어쓰지 않고, 합칠 폴더 안에 하드링크가 있으면 아무것도 복사하지 않는다 (#48)', () => {
  const { root, outside, target, secret, hard, src } = fixture();
  assert.throws(() => fc.copy([src], hard, { force: true }), HARD_LINKED);
  assert.throws(() => fc.copy([src], hard, { force: true, dryRun: true }), HARD_LINKED);
  // 폴더를 합치면 같은 이름의 파일을 제자리에 덮어써 다른 이름의 내용이 바뀐다.
  fs.mkdirSync(path.join(root, 'from', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'from', 'a.txt'), 'A');
  fs.writeFileSync(path.join(root, 'from', 'sub', 'b.txt'), 'B');
  // cp는 있는 폴더 안에 같은 이름(target/from)으로 복사하므로, 그 폴더가 이미 있으면 합친다.
  fs.mkdirSync(path.join(target, 'from', 'sub'), { recursive: true });
  fs.linkSync(path.join(outside, 'secret.txt'), path.join(target, 'from', 'sub', 'b.txt'));
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([path.join(root, 'from')], target, { force: true, dryRun }), (err) => HARD_LINKED.test(err.message) && err.message.includes(path.join('from', 'sub', 'b.txt')), `dryRun=${dryRun}`);
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(target, 'from'), { recursive: true }).sort(), ['sub', path.join('sub', 'b.txt')]);
  assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'SECRET');
});

test('cp --force는 여러 원본 중 하나라도 하드링크를 덮어쓰면 아무것도 복사하지 않는다 (#48)', () => {
  const { root, target, secret } = fixture();
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  fs.writeFileSync(path.join(root, 'hard.txt'), 'H');
  assert.throws(() => fc.copy([path.join(root, 'a.txt'), path.join(root, 'hard.txt')], target, { force: true }), HARD_LINKED);
  assert.deepStrictEqual(fs.readdirSync(target), ['hard.txt']);
  assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'SECRET');
  // --force가 없으면 원래처럼 이미 있다고 알린다.
  assert.throws(() => fc.copy([path.join(root, 'hard.txt')], target), /Already exists/);
});

test('cp --force로 폴더를 합칠 때 원본 안의 끊어진 링크는 하드링크 검사를 막지 않는다 (#48)', () => {
  const { root, target } = fixture();
  fs.mkdirSync(path.join(root, 'from', 'gone'), { recursive: true });
  fs.writeFileSync(path.join(root, 'from', 'a.txt'), 'A');
  fs.symlinkSync(path.join(root, 'from', 'gone'), path.join(root, 'from', 'j'), isWindows ? 'junction' : 'dir');
  fs.rmdirSync(path.join(root, 'from', 'gone'));
  fs.mkdirSync(path.join(target, 'from'));
  fc.copy([path.join(root, 'from')], target, { force: true });
  assert.strictEqual(fs.readFileSync(path.join(target, 'from', 'a.txt'), 'utf8'), 'A');
});

test('mv --force·rename·rm --permanent는 하드링크의 이름만 바꾸거나 지우고 다른 이름의 내용은 남는다 (#48)', () => {
  const { target, secret, hard, src } = fixture();
  fc.rename(hard, 'renamed.txt');
  const renamed = path.join(target, 'renamed.txt');
  assert.strictEqual(fc.readFile(renamed), 'SECRET');
  fc.move([src], renamed, { force: true });
  assert.strictEqual(fc.readFile(renamed), 'NEW');
  assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'SECRET');
  assert.strictEqual(fs.statSync(secret).nlink, 1);
  // 링크 수가 1이 되면 다시 쓸 수 있다.
  fs.linkSync(secret, path.join(target, 'again.txt'));
  fc.remove([path.join(target, 'again.txt')], { permanent: true });
  fc.writeFile(secret, 'MINE', { force: true });
  assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'MINE');
});

test('unzip은 기존 하드링크를 새 파일로 바꾸고 다른 이름의 내용을 그대로 둔다 (#48)', { skip: !isWindows }, () => {
  const { root, target, secret } = fixture();
  fs.mkdirSync(path.join(root, 'pack'));
  fs.writeFileSync(path.join(root, 'pack', 'hard.txt'), 'ZIP');
  fc.zip(path.join(root, 'a.zip'), [path.join(root, 'pack', 'hard.txt')]);
  fc.unzip(path.join(root, 'a.zip'), target);
  assert.strictEqual(fs.readFileSync(path.join(target, 'hard.txt'), 'utf8'), 'ZIP');
  assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'SECRET');
});

test('grant는 하드링크를 읽기·삭제로는 내주고 쓰기로는 내주지 않는다 (#48)', () => {
  const { target, hard } = fixture();
  const access = grant(target, ['read', 'write', 'delete']);
  assert.strictEqual(access.read('hard.txt'), hard);
  assert.strictEqual(access.delete('hard.txt'), hard);
  assert.throws(() => access.write('hard.txt'), HARD_LINKED);
  // 새 이름과 하드링크가 아닌 파일은 그대로 쓸 수 있다.
  fs.writeFileSync(path.join(target, 'plain.txt'), 'p');
  assert.strictEqual(access.write('plain.txt'), path.join(target, 'plain.txt'));
  assert.strictEqual(access.write('new.txt'), path.join(target, 'new.txt'));
});
