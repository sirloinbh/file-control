'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fc = require('../src/commands');

const isWindows = process.platform === 'win32';

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

test('mv --force는 원본과 대상이 겹치면 미리보기와 실제 모두 거부하고 아무것도 지우지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.writeFile(p('d', 'd', 'inner.txt'), 'inner');
  fc.writeFile(p('d', 'sub', 'g.txt'), 'g');
  const cases = [
    [p('a.txt'), p('a.txt')],
    [p('a.txt'), dir],
    [p('d'), dir],
    [p('d'), p('d', 'sub')],
    [p('d', 'sub'), p('d', 'sub', 'x')],
    [p('d', 'd'), dir + path.sep + 'd' + path.sep + '..'],
    [p('d', 'd'), p('d')],
  ];
  for (const [src, dest] of cases) {
    for (const dryRun of [true, false]) {
      assert.throws(() => fc.move([src], dest, { force: true, dryRun }), fc.FcError, `${src} -> ${dest}`);
    }
    assert.strictEqual(fc.readFile(p('a.txt')), 'A');
    assert.strictEqual(fc.readFile(p('d', 'f.txt')), 'f');
    assert.strictEqual(fc.readFile(p('d', 'd', 'inner.txt')), 'inner');
    assert.strictEqual(fc.readFile(p('d', 'sub', 'g.txt')), 'g');
  }
});

test('mv --force는 Windows에서 대소문자나 8.3 이름만 다른 같은 파일도 거부한다', { skip: !isWindows }, () => {
  const dir = tempDir();
  const file = path.join(dir, 'long-file-name.txt');
  fc.writeFile(file, 'keep');
  assert.throws(() => fc.move([file], path.join(dir, 'LONG-FILE-NAME.TXT'), { force: true }), /원본과 대상이 같습니다/);
  const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in (long-file-name.txt) do @echo %~sI'], { cwd: dir, encoding: 'utf8' }).trim();
  // 8.3 이름이 꺼진 드라이브에서는 긴 이름이 그대로 나오는데, 그래도 같은 파일이므로 거부되어야 한다.
  assert.throws(() => fc.move([file], short, { force: true }), /원본과 대상이 같습니다/);
  assert.strictEqual(fc.readFile(file), 'keep');
});

test('mv --force는 정션을 거쳐 같은 항목을 가리켜도 거부하고, 링크 자체를 옮기는 것은 허용한다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('real', 'x.txt'), 'x');
  fc.writeFile(p('real', 'y', 'z.txt'), 'z');
  fs.symlinkSync(p('real'), p('alias'), isWindows ? 'junction' : 'dir');
  assert.throws(() => fc.move([p('real', 'x.txt')], p('alias', 'x.txt'), { force: true }), /원본과 대상이 같습니다/);
  assert.throws(() => fc.move([p('real')], p('alias', 'y'), { force: true }), /자기 안으로/);
  assert.throws(() => fc.move([p('real', 'y')], p('alias'), { force: true }), fc.FcError);
  assert.strictEqual(fc.readFile(p('real', 'x.txt')), 'x');
  assert.strictEqual(fc.readFile(p('real', 'y', 'z.txt')), 'z');
  fc.move([p('alias')], p('real', 'moved-link'), { force: true });
  assert.ok(!fs.existsSync(p('alias')));
  assert.strictEqual(fc.readFile(p('real', 'moved-link', 'x.txt')), 'x');
});

test('mv --force는 겹치지 않는 대상은 전처럼 덮어쓴다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'new');
  fc.writeFile(p('a-b.txt'), 'old');
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.writeFile(p('d-2', 'old.txt'), 'old');
  fc.move([p('a.txt')], p('a-b.txt'), { force: true });
  assert.strictEqual(fc.readFile(p('a-b.txt')), 'new');
  fc.move([p('d')], p('d-2'), { force: true });
  assert.strictEqual(fc.readFile(p('d-2', 'd', 'f.txt')), 'f');
  assert.strictEqual(fc.readFile(p('d-2', 'old.txt')), 'old');
});

test('zip --force는 압축 파일 자신을 묶으려 하면 내용을 지우지 않고 거부한다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  const archive = p('bundle.zip');
  fc.zip(archive, [p('a.txt')]);
  const size = fs.statSync(archive).size;
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.zip(archive, [archive], { force: true, dryRun }), /압축 파일 자신/);
    assert.throws(() => fc.zip(archive, [p('a.txt'), archive], { force: true, dryRun }), /압축 파일 자신/);
  }
  assert.strictEqual(fs.statSync(archive).size, size);
  fc.unzip(archive, p('out'));
  assert.strictEqual(fc.readFile(p('out', 'a.txt')), 'A');
});

test('zip은 압축 파일이 원본 폴더 안에 있어도 원본 내용을 묶는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.zip(p('d', 'out.zip'), [p('d')]);
  fc.zip(p('d', 'out.zip'), [p('d')], { force: true });
  fc.unzip(p('d', 'out.zip'), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'd', 'f.txt')), 'f');
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
