'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('../src/commands');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('write는 중간 폴더를 만들고, 이미 있는 파일은 --force 없이 덮어쓰지 않는다', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a', 'b', 'note.txt');
  fc.writeFile(file, 'hello');
  assert.strictEqual(fc.readFile(file), 'hello');
  assert.throws(() => fc.writeFile(file, 'bye'), fc.FcError);
  fc.writeFile(file, 'bye', { force: true });
  fc.writeFile(file, '!', { append: true });
  assert.strictEqual(fc.readFile(file), 'bye!');
});

test('ls는 폴더를 먼저, 이름순으로 보여준다', () => {
  const dir = tempDir();
  fc.writeFile(path.join(dir, 'b.txt'), '12');
  fc.writeFile(path.join(dir, 'a.txt'), '1');
  fc.makeDir(path.join(dir, 'z'));
  assert.deepStrictEqual(
    fc.list(dir).map((e) => [e.name, e.type, e.size]),
    [['z', 'dir', null], ['a.txt', 'file', 1], ['b.txt', 'file', 2]],
  );
});

test('rename은 같은 폴더 안에서만 이름을 바꾼다', () => {
  const dir = tempDir();
  const file = path.join(dir, 'old.txt');
  fc.writeFile(file, 'x');
  assert.throws(() => fc.rename(file, 'sub/new.txt'), fc.FcError);
  fc.rename(file, 'new.txt');
  assert.ok(fs.existsSync(path.join(dir, 'new.txt')));
  assert.ok(!fs.existsSync(file));
});

test('mv는 대상이 폴더면 그 안으로 옮기고, 충돌하면 멈춘다', () => {
  const dir = tempDir();
  const dest = path.join(dir, 'dest');
  fc.makeDir(dest);
  fc.writeFile(path.join(dir, '1.txt'), '1');
  fc.writeFile(path.join(dir, '2.txt'), '2');
  fc.move([path.join(dir, '1.txt'), path.join(dir, '2.txt')], dest);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['1.txt', '2.txt']);

  fc.writeFile(path.join(dir, '1.txt'), 'new');
  assert.throws(() => fc.move([path.join(dir, '1.txt')], dest), fc.FcError);
  fc.move([path.join(dir, '1.txt')], dest, { force: true });
  assert.strictEqual(fc.readFile(path.join(dest, '1.txt')), 'new');
});

test('cp는 폴더를 통째로 복사하고 원본을 남긴다', () => {
  const dir = tempDir();
  fc.writeFile(path.join(dir, 'src', 'inner', 'f.txt'), 'f');
  fc.copy([path.join(dir, 'src')], path.join(dir, 'copy'));
  assert.strictEqual(fc.readFile(path.join(dir, 'copy', 'inner', 'f.txt')), 'f');
  assert.ok(fs.existsSync(path.join(dir, 'src', 'inner', 'f.txt')));
});

test('rm --permanent는 폴더를 지우고, 없는 경로는 오류를 낸다', () => {
  const dir = tempDir();
  fc.writeFile(path.join(dir, 'gone', 'f.txt'), 'f');
  fc.remove([path.join(dir, 'gone')], { permanent: true });
  assert.ok(!fs.existsSync(path.join(dir, 'gone')));
  assert.throws(() => fc.remove([path.join(dir, 'nope')], { permanent: true }), fc.FcError);
});

test('zip으로 묶은 것을 unzip하면 같은 내용이 나온다', () => {
  const dir = tempDir();
  fc.writeFile(path.join(dir, 'docs', 'a.txt'), 'A');
  fc.writeFile(path.join(dir, 'b.txt'), 'B');
  const archive = path.join(dir, 'bundle.zip');
  fc.zip(archive, [path.join(dir, 'docs'), path.join(dir, 'b.txt')]);
  assert.throws(() => fc.zip(archive, [path.join(dir, 'b.txt')]), fc.FcError);

  fc.unzip(archive);
  assert.strictEqual(fc.readFile(path.join(dir, 'bundle', 'docs', 'a.txt')), 'A');
  assert.strictEqual(fc.readFile(path.join(dir, 'bundle', 'b.txt')), 'B');
});

test('formatSize는 사람이 읽기 쉬운 단위로 바꾼다', () => {
  assert.strictEqual(fc.formatSize(512), '512B');
  assert.strictEqual(fc.formatSize(1536), '1.5KB');
  assert.strictEqual(fc.formatSize(5 * 1024 ** 3), '5.0GB');
});
