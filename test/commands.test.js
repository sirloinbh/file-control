'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { execFileSync } = childProcess;
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

function linkDir(from, to) {
  fs.symlinkSync(from, to, isWindows ? 'junction' : 'dir');
}

test('mv --force는 링크를 자기가 가리키는 곳이나 그 상위 위로 옮기지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('real', 'x.txt'), 'x');
  fc.writeFile(p('parent', 'child', 'y.txt'), 'y');
  fc.makeDir(p('other'));
  linkDir(p('real'), p('other', 'real'));
  linkDir(p('parent', 'child'), p('other', 'parent'));
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.move([p('other', 'real')], dir, { force: true, dryRun }), /원본과 대상이 같습니다/);
    assert.throws(() => fc.move([p('other', 'parent')], dir, { force: true, dryRun }), /링크가 가리키는 곳/);
  }
  assert.strictEqual(fc.readFile(p('real', 'x.txt')), 'x');
  assert.strictEqual(fc.readFile(p('parent', 'child', 'y.txt')), 'y');
});

test('mv는 여러 원본이 겹치면 하나도 옮기기 전에 거부한다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  const reset = () => {
    fs.rmSync(p('w'), { recursive: true, force: true });
    fc.writeFile(p('w', 'a'), 'A');
    fc.writeFile(p('w', 'x'), 'X');
    fc.writeFile(p('w', 'd', 'a'), 'dA');
    fc.writeFile(p('w', 'd', 'f.txt'), 'f');
    fc.writeFile(p('w', 'd', 'sub', 'g.txt'), 'g');
    fc.writeFile(p('w', 'dest', 'a'), 'destA');
    fc.writeFile(p('w', 'dest', 'd', 'f.txt'), 'destF');
    linkDir(p('w', 'dest'), p('w', 'al'));
  };
  const q = (...parts) => p('w', ...parts);
  const cases = [
    [[q('d'), q('dest', 'd', 'f.txt')], q('dest')],
    [[q('d'), q('al', 'd', 'f.txt')], q('dest')],
    [[q('a'), q('d', 'a')], q('dest')],
    [[q('a'), q('dest', 'a')], q('dest')],
    [[q('x'), q('d', 'sub')], q('d')],
    [[q('d'), q('d', 'f.txt')], q('dest')],
  ];
  for (const [sources, dest] of cases) {
    reset();
    assert.throws(() => fc.move(sources, dest, { force: true }), fc.FcError, sources.join(' '));
    assert.strictEqual(fc.readFile(q('a')), 'A');
    assert.strictEqual(fc.readFile(q('x')), 'X');
    assert.strictEqual(fc.readFile(q('d', 'a')), 'dA');
    assert.strictEqual(fc.readFile(q('d', 'f.txt')), 'f');
    assert.strictEqual(fc.readFile(q('d', 'sub', 'g.txt')), 'g');
    assert.strictEqual(fc.readFile(q('dest', 'a')), 'destA');
    assert.strictEqual(fc.readFile(q('dest', 'd', 'f.txt')), 'destF');
  }
  // 하위 항목을 먼저 옮긴 뒤 폴더를 옮기는 순서는 실패하지 않는다.
  reset();
  fc.move([q('d', 'f.txt'), q('d')], q('dest'), { force: true });
  assert.strictEqual(fc.readFile(q('dest', 'f.txt')), 'f');
  assert.strictEqual(fc.readFile(q('dest', 'd', 'a')), 'dA');
});

test('mv는 d/.처럼 끝나는 원본도 d와 같은 대상으로 옮겨 기존 폴더를 지우지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.writeFile(p('d', 'sub', 'g.txt'), 'g');
  fc.writeFile(p('e', 'old.txt'), 'old');
  fc.writeFile(p('e', 'f', 'keep.txt'), 'keep');
  fc.move([`${p('d', 'sub', '..')}${path.sep}.`], p('e'), { force: true });
  assert.strictEqual(fc.readFile(p('e', 'd', 'f.txt')), 'f');
  assert.strictEqual(fc.readFile(p('e', 'old.txt')), 'old');
  assert.strictEqual(fc.readFile(p('e', 'f', 'keep.txt')), 'keep');
});

test('mv --force는 이동이 실패하면 대상을 되돌린다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src.txt'), 'new');
  fc.writeFile(p('target.txt'), 'old');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === p('src.txt')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.throws(() => fc.move([p('src.txt')], p('target.txt'), { force: true }), /locked/);
  assert.strictEqual(fc.readFile(p('src.txt')), 'new');
  assert.strictEqual(fc.readFile(p('target.txt')), 'old');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['src.txt', 'target.txt']);
});

test('mv --force는 대상을 치우지 못하면 아무것도 바꾸지 않는다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src.txt'), 'new');
  fc.writeFile(p('target.txt'), 'old');
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  assert.throws(() => fc.move([p('src.txt')], p('target.txt'), { force: true }), /locked/);
  assert.strictEqual(fc.readFile(p('src.txt')), 'new');
  assert.strictEqual(fc.readFile(p('target.txt')), 'old');
});

test('mv --force는 다른 드라이브 복사가 실패하면 대상을 되돌리고 원본을 남긴다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src.txt'), 'new');
  fc.writeFile(p('target.txt'), 'old');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === p('src.txt')) throw Object.assign(new Error('cross'), { code: 'EXDEV' });
    return rename(from, to);
  });
  t.mock.method(fs, 'cpSync', (from, to) => {
    fs.writeFileSync(to, 'partial');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  assert.throws(() => fc.move([p('src.txt')], p('target.txt'), { force: true }), /disk full/);
  assert.strictEqual(fc.readFile(p('src.txt')), 'new');
  assert.strictEqual(fc.readFile(p('target.txt')), 'old');
});

test('mv --force는 다른 드라이브 복사 뒤 원본 정리가 실패하면 새 대상과 이전 대상을 모두 남긴다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src.txt'), 'new');
  fc.writeFile(p('target.txt'), 'old');
  const rename = fs.renameSync;
  const rm = fs.rmSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === p('src.txt')) throw Object.assign(new Error('cross'), { code: 'EXDEV' });
    return rename(from, to);
  });
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === p('src.txt')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rm(target, options);
  });
  assert.throws(() => fc.move([p('src.txt')], p('target.txt'), { force: true }), /이전 대상은/);
  assert.strictEqual(fc.readFile(p('target.txt')), 'new');
  const aside = fs.readdirSync(dir).find((name) => name.includes('.fctl-old-'));
  assert.strictEqual(fc.readFile(p(aside)), 'old');
});

test('mv --force는 성공하면 치워 둔 대상을 남기지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src.txt'), 'new');
  fc.writeFile(p('target.txt'), 'old');
  fc.writeFile(p('tree', 'n.txt'), 'n');
  fc.writeFile(p('dest', 'tree', 'old.txt'), 'old');
  fc.move([p('src.txt')], p('target.txt'), { force: true });
  fc.move([p('tree')], p('dest'), { force: true });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['dest', 'target.txt']);
  assert.deepStrictEqual(fs.readdirSync(p('dest')), ['tree']);
  assert.deepStrictEqual(fs.readdirSync(p('dest', 'tree')), ['n.txt']);
});

test('mv·zip은 실제 경로를 확인할 수 없으면 지우지 않고 거부한다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p('b.txt'), 'B');
  t.mock.method(fs.realpathSync, 'native', () => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  assert.throws(() => fc.move([p('a.txt')], p('b.txt'), { force: true }), /실제 경로를 확인할 수 없습니다/);
  assert.throws(() => fc.zip(p('b.txt'), [p('a.txt')], { force: true }), /실제 경로를 확인할 수 없습니다/);
  assert.strictEqual(fc.readFile(p('a.txt')), 'A');
  assert.strictEqual(fc.readFile(p('b.txt')), 'B');
});

test('mv·zip은 대체 데이터 스트림 경로를 거부한다', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('bb'), 'body');
  fs.writeFileSync(`${p('bb')}:st`, 'stream');
  assert.throws(() => fc.move([`${p('bb')}:st`], p('bb'), { force: true }), /대체 데이터 스트림/);
  assert.throws(() => fc.zip(`${p('bb')}:st`, [p('bb')], { force: true }), /대체 데이터 스트림/);
  assert.strictEqual(fc.readFile(p('bb')), 'body');
});

test('mv·zip은 UNC 별칭으로 같은 항목을 가리켜도 내용을 잃지 않는다', { skip: !isWindows }, (t) => {
  const dir = fs.realpathSync.native(tempDir());
  const unc = (p) => `\\\\localhost\\${p[0]}$${p.slice(2)}`;
  if (!fs.existsSync(unc(dir))) return t.skip('이 환경에는 관리 공유가 없다');
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p('d', 'sub', 'g.txt'), 'g');
  assert.throws(() => fc.move([p('a.txt')], unc(p('a.txt')), { force: true }), fc.FcError);
  assert.throws(() => fc.move([p('d', 'sub')], unc(p('d')), { force: true }));
  assert.strictEqual(fc.readFile(p('a.txt')), 'A');
  assert.strictEqual(fc.readFile(p('d', 'sub', 'g.txt')), 'g');
  fc.zip(p('b.zip'), [p('a.txt')]);
  const size = fs.statSync(p('b.zip')).size;
  assert.throws(() => fc.zip(unc(p('b.zip')), [p('b.zip')], { force: true }), /압축 파일 자신/);
  assert.strictEqual(fs.statSync(p('b.zip')).size, size);
});

test('mv·cp는 UNC 별칭으로 폴더를 자기 안으로 옮기거나 복사하지 않는다', { skip: !isWindows }, (t) => {
  const dir = fs.realpathSync.native(tempDir());
  const unc = (p) => `\\\\localhost\\${p[0]}$${p.slice(2)}`;
  if (!fs.existsSync(unc(dir))) return t.skip('이 환경에는 관리 공유가 없다');
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.writeFile(p('d', 'sub', 'g.txt'), 'g');
  // 검사가 뚫리면 복사가 끝나지 않으므로, 테스트가 멈추지 않게 복사를 막아 둔다.
  t.mock.method(fs, 'cpSync', () => {
    throw new Error('복사가 시작됨');
  });
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.move([p('d')], unc(p('d', 'sub', 'x')), { force: true, dryRun }), /자기 안으로/);
    assert.throws(() => fc.move([p('d')], unc(p('d', 'sub')), { force: true, dryRun }), /자기 안으로/);
    assert.throws(() => fc.move([unc(p('d'))], p('d', 'sub', 'x'), { force: true, dryRun }), /자기 안으로/);
    assert.throws(() => fc.move([p('d', 'sub')], unc(p('d')), { force: true, dryRun }), fc.FcError);
    assert.throws(() => fc.copy([p('d')], unc(p('d', 'sub', 'x')), { force: true, dryRun }), /자기 안으로/);
    assert.throws(() => fc.copy([unc(p('d'))], p('d', 'sub', 'x'), { force: true, dryRun }), /자기 안으로/);
  }
  assert.strictEqual(fc.readFile(p('d', 'f.txt')), 'f');
  assert.strictEqual(fc.readFile(p('d', 'sub', 'g.txt')), 'g');
  assert.deepStrictEqual(fs.readdirSync(p('d', 'sub')), ['g.txt']);
});

test('mv·cp는 링크 자체를 그것이 가리키는 폴더 안으로 옮기거나 복사하는 것은 막지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('real', 'x.txt'), 'x');
  linkDir(p('real'), p('alias'));
  assert.match(fc.move([p('alias')], p('real', 'k'), { dryRun: true })[0], /미리보기/);
  assert.match(fc.copy([p('alias')], p('real', 'k'), { dryRun: true })[0], /미리보기/);
});

test('mv --force는 대상 이름이 길어도 치워 두었다가 덮어쓴다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  const long = 'L'.repeat(240);
  fc.writeFile(p('a'), 'new');
  fc.writeFile(p(long), 'old');
  fc.move([p('a')], p(long), { force: true });
  assert.strictEqual(fc.readFile(p(long)), 'new');
  assert.deepStrictEqual(fs.readdirSync(dir), [long]);
});

test('mv --force는 끝 구분자가 붙은 파일 대상도 덮어쓴다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a'), 'new');
  fc.writeFile(p('b'), 'old');
  fc.move([p('a')], `${p('b')}${path.sep}`, { force: true });
  assert.strictEqual(fc.readFile(p('b')), 'new');
  assert.deepStrictEqual(fs.readdirSync(dir), ['b']);
});

test('mv --force는 치워 둘 이름이 이미 있으면 덮어쓰지 않고 다른 이름을 쓴다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a'), 'new');
  fc.writeFile(p('b'), 'old');
  t.mock.method(Date, 'now', () => 12345);
  const taken = `.fctl-old-${process.pid}-12345-0`;
  fc.writeFile(p(taken), 'precious');
  fc.move([p('a')], p('b'), { force: true });
  assert.strictEqual(fc.readFile(p('b')), 'new');
  assert.strictEqual(fc.readFile(p(taken)), 'precious');
});

test('mv --force는 되돌리기도 실패하면 치워 둔 위치를 알려 준다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a'), 'new');
  fc.writeFile(p('b'), 'old');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === p('a') || to === p('b')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.throws(() => fc.move([p('a')], p('b'), { force: true }), /이전 대상은 .*\.fctl-old-/);
  t.mock.restoreAll();
  assert.strictEqual(fc.readFile(p('a')), 'new');
  const aside = fs.readdirSync(dir).find((name) => name.startsWith('.fctl-old-'));
  assert.strictEqual(fc.readFile(p(aside)), 'old');
});

test('mv는 여러 항목 중간에 실패하면 이미 처리한 항목을 오류에 알려 준다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a'), 'A');
  fc.writeFile(p('b'), 'B');
  fc.makeDir(p('dest'));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === p('b')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.throws(() => fc.move([p('a'), p('b')], p('dest')), (err) => err instanceof fc.FcError && err.message.includes('locked') && err.message.includes('이미 처리한 항목') && err.message.includes(p('a')));
  assert.strictEqual(fc.readFile(p('dest', 'a')), 'A');
  assert.strictEqual(fc.readFile(p('b')), 'B');
});

test('mv는 하드링크끼리의 이동을 막지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fs.linkSync(p('a.txt'), p('h.txt'));
  fc.move([p('a.txt')], p('h.txt'), { force: true });
  assert.strictEqual(fc.readFile(p('h.txt')), 'A');
  assert.ok(!fs.existsSync(p('a.txt')));
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

test('zip은 압축 파일이 원본 폴더 안에 있어도 원본 내용만 묶고 임시 파일과 기존 압축 파일은 넣지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.writeFile(p('d', 'sub', 'out.zip'), 'keep');
  fc.zip(p('d', 'out.zip'), [p('d')]);
  fc.zip(p('d', 'out.zip'), [p('d')], { force: true });
  assert.deepStrictEqual(fs.readdirSync(p('d')).sort(), ['f.txt', 'out.zip', 'sub']);
  fc.unzip(p('d', 'out.zip'), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'd', 'f.txt')), 'f');
  assert.strictEqual(fc.readFile(p('out', 'd', 'sub', 'out.zip')), 'keep');
  // 기존 out.zip은 빠지지만, 같은 이름의 다른 파일은 빠지지 않아야 한다. out.zip 자신은 새로 만든 뒤에 생긴다.
  assert.deepStrictEqual(fs.readdirSync(p('out', 'd')).sort(), ['f.txt', 'sub']);
});

// tar 실행을 가짜로 바꾼 commands.js를 새로 불러온다.
function loadWithTar(t, fake) {
  // 임시 폴더 경로에 비ASCII 문자가 있으면 코드페이지 확인이 먼저 불린다.
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => (path.basename(file) === 'powershell.exe' ? '' : fake(file, args, options)));
  const id = require.resolve('../src/commands');
  const saved = require.cache[id];
  delete require.cache[id];
  const fresh = require('../src/commands');
  delete require.cache[id];
  require.cache[id] = saved;
  return fresh;
}

const isTarCreate = (args) => args[0] === '-a' && args[1] === '-cf';

test('zip --force는 tar가 실패하면 기존 압축 파일을 그대로 두고 임시 파일을 남기지 않는다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.zip(p('b.zip'), [p('a.txt')]);
  const before = fs.readFileSync(p('b.zip'));
  const mocked = loadWithTar(t, (file, args) => {
    assert.ok(isTarCreate(args));
    fs.writeFileSync(args[2], 'partial');
    throw Object.assign(new Error('tar failed'), { status: 1 });
  });
  assert.throws(() => mocked.zip(p('b.zip'), [p('a.txt')], { force: true }), /tar failed/);
  assert.deepStrictEqual(fs.readFileSync(p('b.zip')), before);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', 'b.zip']);
});

test('zip --force는 압축 파일이 원본 밖이면 tar가 도는 동안 기존 압축 파일을 원래 이름으로 둔다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src', 'a.txt'), 'A');
  fc.writeFile(p('other', 'b.txt'), 'B');
  fc.zip(p('b.zip'), [p('src')]);
  const before = fs.readFileSync(p('b.zip'));
  const seen = [];
  const real = childProcess.execFileSync;
  const mocked = loadWithTar(t, (file, args, options) => {
    seen.push(fs.existsSync(p('b.zip')) && fs.readFileSync(p('b.zip')).equals(before));
    assert.ok(!args.some((arg) => String(arg).startsWith('.fctl-old')), '치운 이름을 뺄 필요가 없다');
    return real(file, args, options);
  });
  // 링크 없는 폴더를 밖의 압축 파일로 묶는 흔한 경우다.
  mocked.zip(p('b.zip'), [p('other')], { force: true });
  assert.deepStrictEqual(seen, [true]);
  t.mock.restoreAll();
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['b.zip', 'other', 'src']);
  fc.unzip(p('b.zip'), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'other', 'b.txt')), 'B');
});

test('zip --force는 압축 파일이 원본 폴더 안일 때 tar가 실패하면 치워 둔 기존 압축 파일을 되돌린다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.zip(p('d', 'in.zip'), [p('d')]);
  const before = fs.readFileSync(p('d', 'in.zip'));
  const mocked = loadWithTar(t, (file, args) => {
    assert.ok(!fs.existsSync(p('d', 'in.zip')), 'tar 전에 치워 둬야 한다');
    fs.writeFileSync(args[2], 'partial');
    throw Object.assign(new Error('tar failed'), { status: 1 });
  });
  assert.throws(() => mocked.zip(p('d', 'in.zip'), [p('d')], { force: true }), /tar failed/);
  assert.deepStrictEqual(fs.readFileSync(p('d', 'in.zip')), before);
  assert.deepStrictEqual(fs.readdirSync(p('d')).sort(), ['f.txt', 'in.zip']);
});

test('zip --force는 tar가 성공한 뒤 기존 압축 파일을 치우지 못하면 기존 압축 파일을 그대로 두고 새 파일을 지운다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p('b.txt'), 'B');
  fc.zip(p('c.zip'), [p('a.txt')]);
  const before = fs.readFileSync(p('c.zip'));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to).startsWith('.fctl-old')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.throws(() => fc.zip(p('c.zip'), [p('b.txt')], { force: true }), /locked/);
  t.mock.restoreAll();
  assert.deepStrictEqual(fs.readFileSync(p('c.zip')), before);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', 'b.txt', 'c.zip']);
});

test('zip --force는 압축 파일이 원본 폴더 안이거나 원본에 링크가 있으면 tar 실행 전에 치우고 빼서 묶는다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.writeFile(p('e', 'g.txt'), 'g');
  linkDir(p('d'), p('e', 'inner'));
  const cases = [[p('d', 'in.zip'), p('d')], [p('d', 'via.zip'), p('e')]];
  for (const [archive, src] of cases) fc.zip(archive, [src]);
  const states = [];
  const real = childProcess.execFileSync;
  const mocked = loadWithTar(t, (file, args, options) => {
    states.push(cases.map(([archive]) => fs.existsSync(archive)));
    assert.ok(args.some((arg) => String(arg).startsWith('.fctl-old')), '치운 기존 압축 파일을 빼야 한다');
    return real(file, args, options);
  });
  mocked.zip(cases[0][0], [cases[0][1]], { force: true });
  mocked.zip(cases[1][0], [cases[1][1]], { force: true });
  assert.deepStrictEqual(states, [[false, true], [true, false]]);
  t.mock.restoreAll();
  assert.deepStrictEqual(fs.readdirSync(p('d')).sort(), ['f.txt', 'in.zip', 'via.zip']);
  fc.unzip(cases[1][0], p('out'));
  assert.deepStrictEqual(fs.readdirSync(p('out', 'e')).sort(), ['g.txt', 'inner']);
});

test('zip은 새 압축 파일을 만들다 tar가 실패해도 빈 압축 파일을 남기지 않는다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  const mocked = loadWithTar(t, (file, args) => {
    fs.writeFileSync(args[2], '');
    throw Object.assign(new Error('tar failed'), { status: 1 });
  });
  assert.throws(() => mocked.zip(p('new.zip'), [p('a.txt')]), /tar failed/);
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.txt']);
});

test('zip은 tar가 비정상 종료하면 FcError로 알린다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  const mocked = loadWithTar(t, () => {
    throw Object.assign(new Error('crash'), { status: 0xc0000005 });
  });
  assert.throws(() => mocked.zip(p('new.zip'), [p('a.txt')]), (err) => err instanceof mocked.FcError && err.message.includes('비정상 종료'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.txt']);
});

test('zip --force는 임시 파일을 제자리로 옮기지 못하면 기존 압축 파일을 되돌린다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.zip(p('b.zip'), [p('a.txt')]);
  const before = fs.readFileSync(p('b.zip'));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from).startsWith('.fctl-new')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.throws(() => fc.zip(p('b.zip'), [p('a.txt')], { force: true }), /locked/);
  assert.deepStrictEqual(fs.readFileSync(p('b.zip')), before);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', 'b.zip']);
});

test('zip --force는 되돌리기도 실패하면 기존 압축 파일의 위치를 알려 준다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.zip(p('b.zip'), [p('a.txt')]);
  const before = fs.readFileSync(p('b.zip'));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === p('b.zip')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.throws(() => fc.zip(p('b.zip'), [p('a.txt')], { force: true }), /기존 압축 파일은 .*\.fctl-old-/);
  t.mock.restoreAll();
  const aside = fs.readdirSync(dir).find((name) => name.startsWith('.fctl-old-'));
  assert.deepStrictEqual(fs.readFileSync(p(aside)), before);
});

test('zip --force는 성공하면 새 내용으로 바꾸고 임시 파일을 남기지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p('b.txt'), 'B');
  fc.zip(p('c.zip'), [p('a.txt')]);
  fc.zip(p('c.zip'), [p('b.txt')], { force: true });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', 'b.txt', 'c.zip']);
  fc.unzip(p('c.zip'), p('out'));
  assert.deepStrictEqual(fs.readdirSync(p('out')), ['b.txt']);
});

test('zip은 임시 파일을 거쳐도 확장자에 맞는 형식으로 묶는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.zip(p('x.zip'), [p('a.txt')]);
  fc.zip(p('y.tar.gz'), [p('a.txt')]);
  assert.strictEqual(fs.readFileSync(p('x.zip')).subarray(0, 2).toString(), 'PK');
  assert.deepStrictEqual([...fs.readFileSync(p('y.tar.gz')).subarray(0, 2)], [0x1f, 0x8b]);
  fc.unzip(p('y.tar.gz'), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'a.txt')), 'A');
});

test('zip은 대문자 확장자도 같은 형식으로 묶고, 대소문자로 갈리는 .Z와 .z는 그대로 둔다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  const head = (name) => [...fs.readFileSync(p(name)).subarray(0, 3)];
  const PK = [0x50, 0x4b, 0x03];
  const GZIP = [0x1f, 0x8b, 0x08];
  const TAR = [0x61, 0x2e, 0x74]; // 압축 없는 tar는 첫 항목 이름(a.txt)으로 시작한다.
  const cases = [
    ['l1.zip', PK], ['U1.ZIP', PK], ['M1.Zip', PK],
    ['l2.tar.gz', GZIP], ['U2.TAR.GZ', GZIP], ['M2.tar.GZ', GZIP], ['U3.TGZ', GZIP],
    ['U4.TAR.BZ2', [0x42, 0x5a, 0x68]], ['U5.TAR.XZ', [0xfd, 0x37, 0x7a]], ['U6.7Z', [0x37, 0x7a, 0xbc]],
    ['l7.tar.Z', [0x1f, 0x9d, 0x90]], ['U7.TAR.Z', [0x1f, 0x9d, 0x90]], ['l10.taZ', [0x1f, 0x9d, 0x90]], ['l11.tZ', [0x1f, 0x9d, 0x90]], ['l12.taz', GZIP], ['l8.tar.z', TAR], ['l9.tar', TAR], ['U9.TAR', TAR],
  ];
  for (const [name, magic] of cases) {
    fc.zip(p(name), [p('a.txt')]);
    assert.deepStrictEqual(head(name), magic, name);
  }
  // 압축 파일 이름은 받은 그대로 남는다.
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', ...cases.map(([name]) => name)].sort());
  fc.unzip(p('U2.TAR.GZ'), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'a.txt')), 'A');
});

test('코드페이지 검사는 ANSI와 OEM 중 어느 한쪽에서라도 바뀌는 문자를 돌려준다 (#136)', { skip: !isWindows }, () => {
  const codes = (chars) => chars.map((char) => char.codePointAt(0).toString(16));
  // 영어 Windows: ANSI 1252에는 ¹이 있지만 OEM 437은 1로 바꾼다. é는 둘 다 있다.
  assert.deepStrictEqual(codes(fc.unsupportedChars('a¹é', [1252])), []);
  assert.deepStrictEqual(codes(fc.unsupportedChars('a¹é', [1252, 437])), ['b9']);
  assert.deepStrictEqual(codes(fc.unsupportedChars('a¹é', [437, 1252])), ['b9']);
  // 한국어 Windows: ANSI·OEM이 모두 949라 ¹과 한글은 있고 é와 이모지는 없다.
  assert.deepStrictEqual(codes(fc.unsupportedChars('¹가é😀', [949, 949])), ['e9', '1f600']);
  assert.deepStrictEqual(fc.unsupportedChars('plain ascii', [437]), []);
  // 코드페이지를 확인하지 못하면 검사 없이 통과하지 않고 실행을 거부한다.
  assert.throws(() => fc.unsupportedChars('é', [99999]), (err) => err instanceof fc.FcError && /코드페이지를 확인하지 못해/.test(err.message));
  assert.throws(() => fc.unsupportedChars('é', [949, 0]), fc.FcError);
});

// 이 PC의 ANSI에는 있고 OEM에는 없는 문자로 실제 zip·unzip을 본다. CI의 영어 Windows(ANSI 1252, OEM 437)에서 실행된다.
// zip·cpio 항목 이름은 OEM으로 적혀 바뀌므로 실행 전에 거부하고(#136), 경로 인자와 pax tar의 항목 이름은 바뀌지 않으므로 받는다(#173).
test('zip·unzip은 OEM 코드페이지에서 바뀌는 문자를 zip·cpio 항목 이름에서만 거부한다 (#136, #173)', { skip: !isWindows }, (t) => {
  const acp = Number(childProcess.execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Text.Encoding]::Default.CodePage'], { encoding: 'utf8' }).trim());
  const candidates = ['¹', '²', '³', '½', '€', 'é', 'ñ'].join('');
  const inAnsi = new Set(fc.unsupportedChars(candidates, [acp]));
  const char = fc.unsupportedChars(candidates).find((c) => !inAnsi.has(c));
  if (char === undefined) return t.skip('ANSI와 OEM 코드페이지의 차이로 바뀌는 문자가 없는 환경이다');
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p(`s${char}.tar.gz`), 'S');
  fc.writeFile(p('tree', `a${char}.txt`), 'T');
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p(`d${char}`, 'b.txt'), 'B');
  const before = fs.readdirSync(dir).sort();
  for (const dryRun of [true, false]) {
    for (const archive of ['o.zip', 'O.ZIP', 'o.cpio']) {
      assert.throws(() => fc.zip(p(archive), [p(`s${char}.tar.gz`)], { dryRun }), /처리할 수 없는 문자/, archive);
      assert.throws(() => fc.zip(p(archive), [p('tree')], { dryRun }), /처리할 수 없는 문자/, archive);
    }
  }
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before);
  // 압축 파일 경로, 원본의 상위 폴더, 풀 폴더에 있는 문자는 그대로 다룬다.
  fc.zip(p(`d${char}`, `o${char}.zip`), [p(`d${char}`, 'b.txt')]);
  fc.unzip(p(`d${char}`, `o${char}.zip`), p(`out${char}`));
  assert.strictEqual(fc.readFile(p(`out${char}`, 'b.txt')), 'B');
  assert.strictEqual(fc.archiveEntries(p(`d${char}`, `o${char}.zip`)).length, 1);
  // pax로 묶는 tar.gz는 항목 이름에 있어도 그대로 풀린다.
  fc.zip(p('o.tar.gz'), [p(`s${char}.tar.gz`), p('tree')]);
  fc.unzip(p('o.tar.gz'), p('pax'));
  assert.deepStrictEqual(fs.readdirSync(p('pax'), { recursive: true }).sort(), [`s${char}.tar.gz`, 'tree', path.join('tree', `a${char}.txt`)].sort());
  assert.strictEqual(fc.readFile(p('pax', 'tree', `a${char}.txt`)), 'T');
});

// 코드페이지 확인(PowerShell)을 흉내 내 ANSI·OEM이 다른 환경에서 어느 이름을 OEM으로도 보는지 이 PC에서도 확인한다(#173).
test('zip은 zip·cpio로 묶을 때만 항목 이름을 OEM으로도 보고, 경로 인자는 ANSI로만 본다 (#173)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('s¹.txt'), 'S');
  fc.writeFile(p('tree', 'a¹.txt'), 'T');
  fc.writeFile(p('d¹', 'b.txt'), 'B');
  // 영어 Windows처럼 ¹은 ANSI 1252에는 있고 OEM 437에서만 바뀐다고 답한다.
  const checks = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (path.basename(file) !== 'powershell.exe') return Buffer.from('');
    checks.push(options.env.FC_WITH_OEM === '1');
    return options.env.FC_WITH_OEM === '1' && options.env.FC_CHARS.includes('¹') ? '185\n' : '';
  });
  const id = require.resolve('../src/commands');
  const saved = require.cache[id];
  delete require.cache[id];
  const mocked = require('../src/commands');
  require.cache[id] = saved;
  for (const archive of ['o.zip', 'o.cpio', 'o¹.zip']) {
    assert.throws(() => mocked.zip(p(archive), [p('s¹.txt')], { dryRun: true }), /U\+00B9/, archive);
    assert.throws(() => mocked.zip(p(archive), [p('tree')], { dryRun: true }), /U\+00B9.*a¹\.txt/, archive);
    // 압축 파일 경로와 원본의 상위 폴더는 ANSI로만 본다.
    mocked.zip(p(archive), [p('d¹', 'b.txt')], { dryRun: true });
  }
  for (const archive of ['o.tar.gz', 'o.7z', 'o.tar', 'o.jar', 'o¹.tar.gz']) {
    mocked.zip(p(archive), [p('s¹.txt'), p('tree')], { dryRun: true });
  }
  fs.writeFileSync(p('in¹.zip'), 'x');
  mocked.unzip(p('in¹.zip'), p('out¹'), { dryRun: true, checkSpace: false });
  assert.ok(checks.includes(true) && checks.includes(false));
});

test('zip·unzip은 코드페이지에 없는 문자가 든 이름을 실행 전에 거부하고 기존 파일을 건드리지 않는다', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  const emoji = '😀';
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p(`${emoji}.txt`), 'E');
  fc.writeFile(p('tree', 'deep', `${emoji}.txt`), 'E');
  fc.zip(p('b.zip'), [p('a.txt')]);
  const before = fs.readFileSync(p('b.zip'));
  const entries = fs.readdirSync(dir).sort();
  for (const dryRun of [true, false]) {
    const options = { force: true, dryRun };
    assert.throws(() => fc.zip(p('b.zip'), [p(`${emoji}.txt`)], options), /처리할 수 없는 문자/);
    assert.throws(() => fc.zip(p('b.zip'), [p('tree')], options), /처리할 수 없는 문자/);
    assert.throws(() => fc.zip(p(`${emoji}.zip`), [p('a.txt')], options), /처리할 수 없는 문자/);
    assert.throws(() => fc.unzip(p('b.zip'), p(`${emoji}-out`), { dryRun }), /처리할 수 없는 문자/);
  }
  assert.deepStrictEqual(fs.readFileSync(p('b.zip')), before);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), entries);
});

test('zip은 원본이 정션이어도 그 안의 이름을 코드페이지로 확인한다', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('real', '😀.txt'), 'E');
  fc.writeFile(p('holder', 'keep.txt'), 'k');
  linkDir(p('real'), p('srcj'));
  linkDir(p('real'), p('holder', 'inner'));
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.zip(p('a.zip'), [p('srcj')], { dryRun }), /U\+1F600\(😀\)/);
    assert.throws(() => fc.zip(p('a.zip'), [`${p('srcj')}${path.sep}`], { dryRun }), /처리할 수 없는 문자/);
    assert.throws(() => fc.zip(p('a.zip'), [p('holder')], { dryRun }), /처리할 수 없는 문자/);
  }
  assert.ok(!fs.existsSync(p('a.zip')));
});

test('zip은 비슷한 글자로 바뀌는 이름 때문에 다른 파일을 묶지 않는다', { skip: !isWindows }, (t) => {
  const cp = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Text.Encoding]::Default.CodePage'], { encoding: 'utf8' }).trim();
  if (cp !== '949') return t.skip('é가 코드페이지에 없는 환경에서만 재현된다');
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('é.txt'), 'ACCENT');
  fc.writeFile(p('e.txt'), 'PLAIN');
  fc.writeFile(p('tree', 'é.txt'), 'ACCENT');
  fc.writeFile(p('tree', 'e.txt'), 'PLAIN');
  fc.writeFile(p('é.zip'), 'old');
  fc.writeFile(p('e.zip'), 'keep');
  assert.throws(() => fc.zip(p('out.zip'), [p('é.txt')]), /U\+00E9/);
  assert.throws(() => fc.zip(p('out.zip'), [p('tree')]), /U\+00E9/);
  assert.throws(() => fc.zip(p('é.zip'), [p('e.txt')], { force: true }), /U\+00E9/);
  assert.strictEqual(fc.readFile(p('e.zip')), 'keep');
});

test('zip·unzip은 끝이 점이나 공백인 이름을 실행 전에 거부하고 비슷한 이름의 파일을 건드리지 않는다', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p('a.txt.'), 'dot');
  fc.writeFile(p('tree', 'n.'), 'dot');
  fc.zip(p('x.zip'), [p('a.txt')]);
  const before = fs.readFileSync(p('x.zip'));
  const entries = fs.readdirSync(dir).sort();
  for (const dryRun of [true, false]) {
    for (const name of ['x.zip.', 'x.zip ', 'n3.zip ', 'n2.zip.']) {
      assert.throws(() => fc.zip(p(name), [p('a.txt')], { dryRun }), /끝이 점이나 공백/, name);
    }
    assert.throws(() => fc.zip(p('new.zip'), [p('a.txt.')], { dryRun }), /끝이 점이나 공백/);
    assert.throws(() => fc.zip(p('new.zip'), [p('tree')], { dryRun }), /끝이 점이나 공백/);
    assert.throws(() => fc.unzip(p('x.zip'), p('out '), { dryRun }), /끝이 점이나 공백/);
  }
  assert.deepStrictEqual(fs.readFileSync(p('x.zip')), before);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), entries);
});

test('zip은 확장자에 패턴 문자가 있어도 임시 파일을 묶지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  for (const name of ['o.[1]', 'o.z[i]p', 'o.a$']) {
    const root = p(`r-${name.length}-${name.charCodeAt(2)}`);
    fc.writeFile(path.join(root, 'f.txt'), 'f');
    fc.zip(path.join(root, name), [root]);
    fc.zip(path.join(root, name), [root], { force: true });
    fc.unzip(path.join(root, name), `${root}-out`);
    assert.deepStrictEqual(fs.readdirSync(path.join(`${root}-out`, path.basename(root))), ['f.txt'], name);
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['f.txt', name].sort(), name);
  }
});

test('zip은 다른 부모 폴더의 대시 이름과 대시 폴더, 일반 이름을 섞어 묶는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('plain.txt'), 'plain');
  fc.writeFile(p('par', '-a.txt'), 'dash');
  fc.writeFile(p('-par', '@b.txt'), 'at');
  fc.writeFile(p('-dir', 'in.txt'), 'in');
  fc.zip(p('m.zip'), [p('plain.txt'), p('par', '-a.txt'), p('-par', '@b.txt'), p('-dir')]);
  fc.unzip(p('m.zip'), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'plain.txt')), 'plain');
  assert.strictEqual(fc.readFile(p('out', '-a.txt')), 'dash');
  assert.strictEqual(fc.readFile(p('out', '@b.txt')), 'at');
  assert.strictEqual(fc.readFile(p('out', '-dir', 'in.txt')), 'in');
});

test('zip --force는 기존 압축 파일을 지우지 못하면 위치를 알려 주고 새 압축 파일은 남긴다', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.writeFile(p('b.txt'), 'B');
  fc.zip(p('c.zip'), [p('a.txt')]);
  const rm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.basename(target).startsWith('.fctl-old')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rm(target, options);
  });
  assert.throws(() => fc.zip(p('c.zip'), [p('b.txt')], { force: true }), /압축했지만 기존 압축 파일을 지우지 못했습니다: .*\.fctl-old-/);
  t.mock.restoreAll();
  fc.unzip(p('c.zip'), p('out'));
  assert.deepStrictEqual(fs.readdirSync(p('out')), ['b.txt']);
});

test('zip은 맨 위 이름이 같은 원본을 미리보기와 실제 모두 거부하고 압축 파일을 만들지 않는다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('p', 'f.txt'), 'P');
  fc.writeFile(p('q', 'f.txt'), 'Q');
  fc.writeFile(p('q', 'F.TXT2'), 'x');
  fc.writeFile(p('r', 'f.txt', 'in.txt'), 'dir');
  const cases = [[p('p', 'f.txt'), p('q', 'f.txt')], [p('p', 'f.txt'), p('r', 'f.txt')]];
  if (isWindows) {
    fc.writeFile(p('s', 'F.TXT'), 'S');
    fc.writeFile(p('g1', 'ΑΣ'), 'UPPER');
    fc.writeFile(p('g2', 'ασ'), 'lower');
    cases.push([p('p', 'f.txt'), p('s', 'F.TXT')], [p('g1', 'ΑΣ'), p('g2', 'ασ')]);
  }
  for (const dryRun of [true, false]) {
    for (const sources of cases) {
      assert.throws(() => fc.zip(p('o.zip'), sources, { dryRun }), /이름이 같은 원본/, sources.join(' '));
    }
  }
  assert.ok(!fs.existsSync(p('o.zip')));
  // 이름이 다르면 지금처럼 묶인다.
  fc.zip(p('o.zip'), [p('p', 'f.txt'), p('q', 'F.TXT2')]);
  fc.unzip(p('o.zip'), p('out'));
  assert.deepStrictEqual(fs.readdirSync(p('out')).sort(), ['F.TXT2', 'f.txt']);
  assert.strictEqual(fc.readFile(p('out', 'f.txt')), 'P');
});

test('zip은 드라이브 루트를 훑기 전에 거부한다', (t) => {
  const dir = tempDir();
  t.mock.method(fs, 'readdirSync', () => {
    throw new Error('드라이브를 훑음');
  });
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.zip(path.join(dir, 'o.zip'), [path.parse(dir).root], { dryRun }), /드라이브 루트/);
  }
});

test('끝 공백 거부 메시지는 이름을 따옴표로 보여 준다', { skip: !isWindows }, () => {
  const dir = tempDir();
  fc.writeFile(path.join(dir, 'a.txt'), 'A');
  assert.throws(() => fc.zip(path.join(dir, 'n3.zip '), [path.join(dir, 'a.txt')]), /"n3\.zip "/);
});

test('zip·unzip은 코드페이지에 있는 비ASCII 이름은 그대로 처리한다', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  // 코드페이지에 있는 문자를 골라 시험한다. 그 밖의 코드페이지에서는 고를 문자를 알 수 없어 건너뛴다.
  const codePage = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Text.Encoding]::Default.CodePage'], { encoding: 'utf8' }).trim();
  const name = { 949: '가', 1252: 'é' }[codePage];
  if (name === undefined) return t.skip(`코드페이지 ${codePage}에서는 시험할 문자를 정하지 않았다`);
  fc.writeFile(p(`${name}.txt`), 'N');
  fc.zip(p(`${name}.zip`), [p(`${name}.txt`)]);
  fc.unzip(p(`${name}.zip`), p('out'));
  assert.strictEqual(fs.readdirSync(p('out')).length, 1);
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

// grant가 좁은 규칙에서 허용하는 장치 이름 비슷한 이름을 tar.exe가 같은 파일로 다루는지 실행 환경에서 확인한다(#53).
const { deviceNamePattern } = require('../src/target');
const narrowDeviceRule = isWindows && deviceNamePattern() === deviceNamePattern('10.0.26200');

test('zip·unzip은 좁은 규칙에서 허용하는 장치 이름 비슷한 이름을 같은 파일로 묶고 푼다 (#53)', { skip: !narrowDeviceRule }, () => {
  const dir = tempDir();
  // 위첨자(COM¹)는 영어 Windows에서 tar.exe가 OEM 코드페이지로 적어 1로 바뀌어 실행 전에 거부되므로(#136) 여기서는 ASCII 이름만 본다.
  const names = ['Con.Air.1997.mkv', 'nul.tar.gz', 'Aux.2018.mp4', 'Nul .mp4', 'NUL..mp4', 'Com0.txt', 'Lpt0.txt', 'CONIN$.txt'];
  names.forEach((name, i) => fc.writeFile(path.join(dir, 'src', name), `content-${i}`));
  const archive = path.join(dir, 'bundle.zip');
  fc.zip(archive, [path.join(dir, 'src')]);
  fc.unzip(archive);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'bundle', 'src')).sort(), [...names].sort());
  names.forEach((name, i) => assert.strictEqual(fc.readFile(path.join(dir, 'bundle', 'src', name)), `content-${i}`, name));
});

test('formatSize는 사람이 읽기 쉬운 단위로 바꾼다', () => {
  assert.strictEqual(fc.formatSize(512), '512B');
  assert.strictEqual(fc.formatSize(1536), '1.5KB');
  assert.strictEqual(fc.formatSize(5 * 1024 ** 3), '5.0GB');
});

// 풀린 크기 확인(#77). mtree 글은 size= 값대로 빈 파일을 만들어, 작은 파일로 디스크를 채울 수 있다.
test('unzip은 목록 크기가 남은 공간보다 크면 미리보기와 실제 모두 풀기 전에 거부한다 (#77)', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.writeFileSync(p('huge.zip'), '#mtree\nbig type=file size=99999999999999\n');
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.unzip(p('huge.zip'), p('out'), { dryRun }), (err) => err instanceof fc.FcError && /풀면 약 90\.9TB가 되어/.test(err.message));
  }
  assert.ok(!fs.existsSync(p('out')));
});

test('unzip은 풀고 나서 1GB보다 적게 남으면 거부하고, 남은 공간을 확인하지 못해도 풀지 않는다 (#77)', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.zip(p('a.zip'), [p('a.txt')]);
  const statfs = fs.statfsSync;
  let free = 1024n ** 3n + 5120n;
  t.mock.method(fs, 'statfsSync', (target, options) => {
    if (free === null) throw Object.assign(new Error('no'), { code: 'ENOSYS' });
    return { ...statfs(target, options), bavail: free / 512n, bsize: 512n };
  });
  // 파일 하나(4KB와 항목 1KB로 셈)와 1GB 여유가 꼭 맞으면 푼다.
  fc.unzip(p('a.zip'), p('ok'));
  assert.strictEqual(fc.readFile(p('ok', 'a.txt')), 'A');
  free -= 512n;
  assert.throws(() => fc.unzip(p('a.zip'), p('no')), /1\.0GB보다 적게 남으므로 풀지 않았습니다/);
  free = null;
  assert.throws(() => fc.unzip(p('a.zip'), p('no')), /남은 디스크 공간을 확인하지 못해 풀지 않았습니다.*ENOSYS/);
  assert.ok(!fs.existsSync(p('no')));
});

test('unzip은 목록에서 크기를 읽지 못하면 풀지 않는다 (#77)', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.writeFileSync(p('a.zip'), 'x');
  const calls = [];
  const mocked = loadWithTar(t, (file, args) => {
    calls.push(args[0]);
    return Buffer.from('-rw-r--r--  0 some user  group 5 Jan  1  2020 a.txt\n');
  });
  assert.throws(() => mocked.unzip(p('a.zip'), p('out')), /크기를 읽지 못해 풀지 않았습니다/);
  assert.deepStrictEqual(calls, ['-tvf']);
  assert.ok(!fs.existsSync(p('out')));
});

test('unzip은 권한 칸 끝에 ACL 표시(+)가 붙은 목록 줄의 크기도 읽는다 (#77)', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.writeFileSync(p('a.tar'), 'x');
  const mocked = loadWithTar(t, () => Buffer.from('-rw-r--r--+ 0 0      0    99999999999999 Jan  1  2020 acl.txt\n'));
  assert.throws(() => mocked.unzip(p('a.tar'), p('out'), { dryRun: true }), /풀면 약 90\.9TB가 되어/);
});

test('unzip은 클러스터가 4KB보다 큰 볼륨에서는 클러스터 단위로 올려 센다 (#77)', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.writeFileSync(p('a.zip'), 'x');
  const mocked = loadWithTar(t, () => Buffer.from('-rw-r--r--  0 0      0           1 Jan  1  2020 a.txt\n-rw-r--r--  0 0      0           1 Jan  1  2020 b.txt\n'));
  const statfs = fs.statfsSync;
  t.mock.method(fs, 'statfsSync', (target, options) => ({ ...statfs(target, options), bavail: 1n << 40n, bsize: 131072n }));
  // 1바이트 파일 2개를 128KB씩 올리고 항목마다 1KB를 더한다.
  assert.match(mocked.unzip(p('a.zip'), p('out'), { dryRun: true }), /풀린 크기 약 258\.0KB/);
});
