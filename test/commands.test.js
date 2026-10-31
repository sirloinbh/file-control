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

test('zip --force는 tar가 실패하면 기존 압축 파일을 되돌리고 임시 파일을 남기지 않는다', (t) => {
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

test('formatSize는 사람이 읽기 쉬운 단위로 바꾼다', () => {
  assert.strictEqual(fc.formatSize(512), '512B');
  assert.strictEqual(fc.formatSize(1536), '1.5KB');
  assert.strictEqual(fc.formatSize(5 * 1024 ** 3), '5.0GB');
});
