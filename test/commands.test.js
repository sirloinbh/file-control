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

test('ls는 정보를 읽을 수 없는 잠긴 항목이 있어도 목록을 보여주고 그 항목의 크기만 비운다 (#254)', (t) => {
  const dir = tempDir();
  fc.writeFile(path.join(dir, 'locked.tmp'), '123');
  fc.writeFile(path.join(dir, 'ok.txt'), '1');
  const statSync = fs.statSync;
  // It imitates a file such as C:\DumpStack.log.tmp for which stat fails with EPERM.
  t.mock.method(fs, 'statSync', (p, ...rest) => {
    if (path.basename(String(p)) === 'locked.tmp') throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return statSync(p, ...rest);
  });
  assert.deepStrictEqual(
    fc.list(dir).map((e) => [e.name, e.type, e.size, e.modified === null]),
    [['locked.tmp', 'file', null, true], ['ok.txt', 'file', 1, false]],
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
  assert.throws(() => fc.move([file], path.join(dir, 'LONG-FILE-NAME.TXT'), { force: true }), /source and destination are the same/);
  const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in (long-file-name.txt) do @echo %~sI'], { cwd: dir, encoding: 'utf8' }).trim();
  // On a drive with 8.3 names turned off, the long name comes out as it is, but it is still the same file, so it must be refused.
  assert.throws(() => fc.move([file], short, { force: true }), /source and destination are the same/);
  assert.strictEqual(fc.readFile(file), 'keep');
});

test('mv --force는 정션을 거쳐 같은 항목을 가리켜도 거부하고, 링크 자체를 옮기는 것은 허용한다', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('real', 'x.txt'), 'x');
  fc.writeFile(p('real', 'y', 'z.txt'), 'z');
  fs.symlinkSync(p('real'), p('alias'), isWindows ? 'junction' : 'dir');
  assert.throws(() => fc.move([p('real', 'x.txt')], p('alias', 'x.txt'), { force: true }), /source and destination are the same/);
  assert.throws(() => fc.move([p('real')], p('alias', 'y'), { force: true }), /into itself/);
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
    assert.throws(() => fc.move([p('other', 'real')], dir, { force: true, dryRun }), /source and destination are the same/);
    assert.throws(() => fc.move([p('other', 'parent')], dir, { force: true, dryRun }), /where the link points/);
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
  // The order of moving the inner items first and then the folder does not fail.
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
  assert.throws(() => fc.move([p('src.txt')], p('target.txt'), { force: true }), /previous destination is/);
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
  assert.throws(() => fc.move([p('a.txt')], p('b.txt'), { force: true }), /Cannot check the real path/);
  assert.throws(() => fc.zip(p('b.txt'), [p('a.txt')], { force: true }), /Cannot check the real path/);
  assert.strictEqual(fc.readFile(p('a.txt')), 'A');
  assert.strictEqual(fc.readFile(p('b.txt')), 'B');
});

test('mv·zip은 대체 데이터 스트림 경로를 거부한다', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('bb'), 'body');
  fs.writeFileSync(`${p('bb')}:st`, 'stream');
  assert.throws(() => fc.move([`${p('bb')}:st`], p('bb'), { force: true }), /Alternate data streams/);
  assert.throws(() => fc.zip(`${p('bb')}:st`, [p('bb')], { force: true }), /Alternate data streams/);
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
  assert.throws(() => fc.zip(unc(p('b.zip')), [p('b.zip')], { force: true }), /archive into itself/);
  assert.strictEqual(fs.statSync(p('b.zip')).size, size);
});

test('mv·cp는 UNC 별칭으로 폴더를 자기 안으로 옮기거나 복사하지 않는다', { skip: !isWindows }, (t) => {
  const dir = fs.realpathSync.native(tempDir());
  const unc = (p) => `\\\\localhost\\${p[0]}$${p.slice(2)}`;
  if (!fs.existsSync(unc(dir))) return t.skip('이 환경에는 관리 공유가 없다');
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('d', 'f.txt'), 'f');
  fc.writeFile(p('d', 'sub', 'g.txt'), 'g');
  // If the check is bypassed, the copy never ends, so the copy is blocked so that the test does not hang.
  t.mock.method(fs, 'cpSync', () => {
    throw new Error('복사가 시작됨');
  });
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.move([p('d')], unc(p('d', 'sub', 'x')), { force: true, dryRun }), /into itself/);
    assert.throws(() => fc.move([p('d')], unc(p('d', 'sub')), { force: true, dryRun }), /into itself/);
    assert.throws(() => fc.move([unc(p('d'))], p('d', 'sub', 'x'), { force: true, dryRun }), /into itself/);
    assert.throws(() => fc.move([p('d', 'sub')], unc(p('d')), { force: true, dryRun }), fc.FcError);
    assert.throws(() => fc.copy([p('d')], unc(p('d', 'sub', 'x')), { force: true, dryRun }), /into itself/);
    assert.throws(() => fc.copy([unc(p('d'))], p('d', 'sub', 'x'), { force: true, dryRun }), /into itself/);
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
  assert.match(fc.move([p('alias')], p('real', 'k'), { dryRun: true })[0], /Preview/);
  assert.match(fc.copy([p('alias')], p('real', 'k'), { dryRun: true })[0], /Preview/);
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
  assert.throws(() => fc.move([p('a')], p('b'), { force: true }), /previous destination is .*\.fctl-old-/);
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
  assert.throws(() => fc.move([p('a'), p('b')], p('dest')), (err) => err instanceof fc.FcError && err.message.includes('locked') && err.message.includes('Items already handled') && err.message.includes(p('a')));
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
    assert.throws(() => fc.zip(archive, [archive], { force: true, dryRun }), /archive into itself/);
    assert.throws(() => fc.zip(archive, [p('a.txt'), archive], { force: true, dryRun }), /archive into itself/);
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
  // The existing out.zip is left out, but another file of the same name must not be left out. out.zip itself appears after it is newly made.
  assert.deepStrictEqual(fs.readdirSync(p('out', 'd')).sort(), ['f.txt', 'sub']);
});

// It freshly imports commands.js with the tar run swapped for a fake.
function loadWithTar(t, fake) {
  // If the temporary folder path has a non-ASCII character, the code page check is called first.
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
  // This is the common case of bundling a folder with no links into an archive outside it.
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
  assert.throws(() => mocked.zip(p('new.zip'), [p('a.txt')]), (err) => err instanceof mocked.FcError && err.message.includes('exited abnormally'));
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
  assert.throws(() => fc.zip(p('b.zip'), [p('a.txt')], { force: true }), /existing archive is at .*\.fctl-old-/);
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
  const TAR = [0x61, 0x2e, 0x74]; // An uncompressed tar starts with the first entry name (a.txt).
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
  // The archive name stays as received.
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', ...cases.map(([name]) => name)].sort());
  fc.unzip(p('U2.TAR.GZ'), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'a.txt')), 'A');
});

test('코드페이지 검사는 ANSI와 OEM 중 어느 한쪽에서라도 바뀌는 문자를 돌려준다 (#136)', { skip: !isWindows }, () => {
  const codes = (chars) => chars.map((char) => char.codePointAt(0).toString(16));
  // English Windows: ANSI 1252 has ¹ but OEM 437 changes it to 1. é is in both.
  assert.deepStrictEqual(codes(fc.unsupportedChars('a¹é', [1252])), []);
  assert.deepStrictEqual(codes(fc.unsupportedChars('a¹é', [1252, 437])), ['b9']);
  assert.deepStrictEqual(codes(fc.unsupportedChars('a¹é', [437, 1252])), ['b9']);
  // Korean Windows: ANSI and OEM are both 949, so ¹ and Hangul exist and é and emoji do not.
  assert.deepStrictEqual(codes(fc.unsupportedChars('¹가é😀', [949, 949])), ['e9', '1f600']);
  assert.deepStrictEqual(fc.unsupportedChars('plain ascii', [437]), []);
  // If the code page cannot be confirmed, it does not pass without the check and refuses to run.
  assert.throws(() => fc.unsupportedChars('é', [99999]), (err) => err instanceof fc.FcError && /Could not check the system code page/.test(err.message));
  assert.throws(() => fc.unsupportedChars('é', [949, 0]), fc.FcError);
});

// It looks at a real zip and unzip with characters that this PC's ANSI has and OEM does not. It runs on the English Windows of CI (ANSI 1252, OEM 437).
// zip and cpio entry names are written in OEM and change, so it refuses before running (#136), and path arguments and pax tar entry names do not change, so it accepts them (#173).
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
      assert.throws(() => fc.zip(p(archive), [p(`s${char}.tar.gz`)], { dryRun }), /characters tar\.exe cannot handle/, archive);
      assert.throws(() => fc.zip(p(archive), [p('tree')], { dryRun }), /characters tar\.exe cannot handle/, archive);
    }
  }
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before);
  // Characters in the archive path, the parent folder of the source, and the extraction folder are handled as they are.
  fc.zip(p(`d${char}`, `o${char}.zip`), [p(`d${char}`, 'b.txt')]);
  fc.unzip(p(`d${char}`, `o${char}.zip`), p(`out${char}`));
  assert.strictEqual(fc.readFile(p(`out${char}`, 'b.txt')), 'B');
  assert.strictEqual(fc.archiveEntries(p(`d${char}`, `o${char}.zip`)).length, 1);
  // A tar.gz bundled with pax extracts as is even if it is in an entry name.
  fc.zip(p('o.tar.gz'), [p(`s${char}.tar.gz`), p('tree')]);
  fc.unzip(p('o.tar.gz'), p('pax'));
  assert.deepStrictEqual(fs.readdirSync(p('pax'), { recursive: true }).sort(), [`s${char}.tar.gz`, 'tree', path.join('tree', `a${char}.txt`)].sort());
  assert.strictEqual(fc.readFile(p('pax', 'tree', `a${char}.txt`)), 'T');
});

// Multi-layer compression (#212): in an environment where ANSI and OEM differ (the English Windows of CI), it bundles with the real tar.exe and checks that if the inside is tar, even a character not in OEM
// is written and extracted as is, and that if the inside is zip or cpio, it refuses. In an environment where ANSI and OEM are the same (Korean Windows), it skips.
test('zip은 여러 겹 압축 이름의 항목 이름을 가장 안쪽 형식으로 판정해 tar 안쪽은 OEM 검사를 건너뛴다 (#212)', { skip: !isWindows }, (t) => {
  const acp = Number(childProcess.execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Text.Encoding]::Default.CodePage'], { encoding: 'utf8' }).trim());
  const candidates = ['¹', '²', '³', '½', '€', 'é', 'ñ'].join('');
  const inAnsi = new Set(fc.unsupportedChars(candidates, [acp]));
  const char = fc.unsupportedChars(candidates).find((c) => !inAnsi.has(c));
  if (char === undefined) return t.skip('ANSI와 OEM 코드페이지의 차이로 바뀌는 문자가 없는 환경이다');
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('tree', `a${char}.txt`), 'T');
  for (const archive of ['o.tar.gz.gz', 'o.gz.xz', 'o.tgz.gz', 'o.tar.bz2.gz']) {
    fc.zip(p(archive), [p('tree')]);
    fc.unzip(p(archive), p(`out-${archive}`));
    assert.strictEqual(fc.readFile(p(`out-${archive}`, 'tree', `a${char}.txt`)), 'T', archive);
  }
  for (const archive of ['o.cpio.gz.xz', 'o.zip.gz.gz']) {
    assert.throws(() => fc.zip(p(archive), [p('tree')]), /characters tar\.exe cannot handle/, archive);
    assert.ok(!fs.existsSync(p(archive)), archive);
  }
});

// It imitates the code page check (PowerShell) and checks on this PC too which names are also looked at as OEM in an environment where ANSI and OEM differ (#173).
test('zip은 OEM을 거치지 않는다고 확인한 형식이 아니면(zip·cpio·.tar.zip 등) 항목 이름을 OEM으로도 보고, 경로 인자는 ANSI로만 본다 (#173)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('s¹.txt'), 'S');
  fc.writeFile(p('tree', 'a¹.txt'), 'T');
  fc.writeFile(p('d¹', 'b.txt'), 'B');
  // Like English Windows, it answers that ¹ is in ANSI 1252 and changes only in OEM 437.
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
  // Multi-layer names are judged by the innermost format (#212). If the inside is zip or cpio, it is also looked at as OEM regardless of the outer layers.
  for (const archive of ['o.zip', 'o.cpio', 'o¹.zip', 'o.tar.zip', 'O.TAR.ZIP', 'o.tar.cpio', 'o.unknownext', 'o.cpio.gz', 'o.ZIP.XZ', 'o.cpio.Z', 'o.cpio.gz.xz', 'o.zip.gz.gz', 'o.tar.zip.gz']) {
    assert.throws(() => mocked.zip(p(archive), [p('s¹.txt')], { dryRun: true }), /U\+00B9/, archive);
    assert.throws(() => mocked.zip(p(archive), [p('tree')], { dryRun: true }), /U\+00B9.*a¹\.txt/, archive);
    // The archive path and the parent folder of the source are looked at only as ANSI.
    mocked.zip(p(archive), [p('d¹', 'b.txt')], { dryRun: true });
  }
  for (const archive of ['o.tar.gz', 'o.7z', 'o.tar', 'o.jar', 'o¹.tar.gz', 'o.tar.gz.gz', 'O.TAR.GZ.XZ', 'o.gz.xz', 'o.tgz.gz', 'o.tar.bz2.gz', 'o.taZ.gz']) {
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
    assert.throws(() => fc.zip(p('b.zip'), [p(`${emoji}.txt`)], options), /characters tar\.exe cannot handle/);
    assert.throws(() => fc.zip(p('b.zip'), [p('tree')], options), /characters tar\.exe cannot handle/);
    assert.throws(() => fc.zip(p(`${emoji}.zip`), [p('a.txt')], options), /characters tar\.exe cannot handle/);
    assert.throws(() => fc.unzip(p('b.zip'), p(`${emoji}-out`), { dryRun }), /characters tar\.exe cannot handle/);
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
    assert.throws(() => fc.zip(p('a.zip'), [`${p('srcj')}${path.sep}`], { dryRun }), /characters tar\.exe cannot handle/);
    assert.throws(() => fc.zip(p('a.zip'), [p('holder')], { dryRun }), /characters tar\.exe cannot handle/);
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
      assert.throws(() => fc.zip(p(name), [p('a.txt')], { dryRun }), /ending with a dot or space/, name);
    }
    assert.throws(() => fc.zip(p('new.zip'), [p('a.txt.')], { dryRun }), /ending with a dot or space/);
    assert.throws(() => fc.zip(p('new.zip'), [p('tree')], { dryRun }), /ending with a dot or space/);
    assert.throws(() => fc.unzip(p('x.zip'), p('out '), { dryRun }), /ending with a dot or space/);
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
  assert.throws(() => fc.zip(p('c.zip'), [p('b.txt')], { force: true }), /Compressed, but could not delete the existing archive: .*\.fctl-old-/);
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
      assert.throws(() => fc.zip(p('o.zip'), sources, { dryRun }), /Sources with the same name/, sources.join(' '));
    }
  }
  assert.ok(!fs.existsSync(p('o.zip')));
  // If the names differ, it bundles as it does now.
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
    assert.throws(() => fc.zip(path.join(dir, 'o.zip'), [path.parse(dir).root], { dryRun }), /drive root/);
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
  // It tests with a character that is in the code page. In other code pages it cannot know which character to pick, so it skips.
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

// It checks in the run environment whether tar.exe handles as the same file the device-name-like names that grant allows under the narrow rule (#53).
const { deviceNamePattern } = require('../src/target');
const narrowDeviceRule = isWindows && deviceNamePattern() === deviceNamePattern('10.0.26200');

test('zip·unzip은 좁은 규칙에서 허용하는 장치 이름 비슷한 이름을 같은 파일로 묶고 푼다 (#53)', { skip: !narrowDeviceRule }, () => {
  const dir = tempDir();
  // A superscript (COM¹) is written by tar.exe in the OEM code page on English Windows and changes to 1, so it is refused before running (#136); so here it looks only at ASCII names.
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

// The extracted size check (#77). mtree text makes empty files as large as the size= value, so a small file could fill the disk.
test('unzip은 목록 크기가 남은 공간보다 크면 미리보기와 실제 모두 풀기 전에 거부한다 (#77)', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.writeFileSync(p('huge.zip'), '#mtree\nbig type=file size=99999999999999\n');
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.unzip(p('huge.zip'), p('out'), { dryRun }), (err) => err instanceof fc.FcError && /Extracting would take about 90\.9TB/.test(err.message));
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
  // If one file (counted as 4KB and 1KB per entry) and the 1GB reserve fit exactly, it extracts.
  fc.unzip(p('a.zip'), p('ok'));
  assert.strictEqual(fc.readFile(p('ok', 'a.txt')), 'A');
  free -= 512n;
  assert.throws(() => fc.unzip(p('a.zip'), p('no')), /leave less than 1\.0GB free on the disk, so it was not extracted/);
  free = null;
  assert.throws(() => fc.unzip(p('a.zip'), p('no')), /Could not check the free disk space, so it was not extracted.*ENOSYS/);
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
  assert.throws(() => mocked.unzip(p('a.zip'), p('out')), /Could not read the size from the archive listing, so it was not extracted/);
  assert.deepStrictEqual(calls, ['-tvf']);
  assert.ok(!fs.existsSync(p('out')));
});

test('unzip은 권한 칸 끝에 ACL 표시(+)가 붙은 목록 줄의 크기도 읽는다 (#77)', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.writeFileSync(p('a.tar'), 'x');
  const mocked = loadWithTar(t, () => Buffer.from('-rw-r--r--+ 0 0      0    99999999999999 Jan  1  2020 acl.txt\n'));
  assert.throws(() => mocked.unzip(p('a.tar'), p('out'), { dryRun: true }), /Extracting would take about 90\.9TB/);
});

test('unzip은 클러스터가 4KB보다 큰 볼륨에서는 클러스터 단위로 올려 센다 (#77)', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.writeFileSync(p('a.zip'), 'x');
  const mocked = loadWithTar(t, () => Buffer.from('-rw-r--r--  0 0      0           1 Jan  1  2020 a.txt\n-rw-r--r--  0 0      0           1 Jan  1  2020 b.txt\n'));
  const statfs = fs.statfsSync;
  t.mock.method(fs, 'statfsSync', (target, options) => ({ ...statfs(target, options), bavail: 1n << 40n, bsize: 131072n }));
  // It rounds two 1-byte files up by 128KB each and adds 1KB per entry.
  assert.match(mocked.unzip(p('a.zip'), p('out'), { dryRun: true }), /extracted size about 258\.0KB/);
});

// 8.3 short names (#159). If the extraction volume makes short names, LONGNA~1.TXT and longname.txt become the same file depending on the extraction order.
test('couldBeShortNameOf는 긴 이름의 짧은 이름이 될 수 있는 이름을 고른다 (#159)', () => {
  const yes = [['LONGNA~1.TXT', 'longnames.txt'], ['LONGER~2.TXT', 'longerXYZ.txt'], ['LO1A2B~1.TXT', 'lots of names.txt'], ['LONGFO~1', 'longfolder'], ['FILETA~1.GZ', 'file.tar.gz'], ['A_B~1.TXT', 'a+b c.txt'], ['repo~1.htm', 'report.html'],
    // If the name is short, it becomes the hash form from the start, Hangul is cut in OEM byte units, and a letter not in OEM is dropped (measured in the first review).
    ['XAD1C~1.VER', 'x.verylongext'], ['가9BAB~1.TXT', '가나다라마바사5.txt'], ['한글~1.한', '한글.한글파일'], ['ABC~1.TXT', '€abc.txt'], ['GITIGN~1', '.gitignore'],
    // A name that contains ~ (Office lock files and so on) and a name with only leading dots (measured in the second review).
    ['~$LONG~1.DOC', '~$longdocument.docx'], ['~$AB~1.DOC', '~$ab.docx'], ['FOO~BA~1.TXT', 'foo~bar~baz.txt'], ['FOO~1', '..foo'], ['BAR~1', '...bar'],
    ['LENAME~1.TXT', 'ﬁlename.txt']];
  const no = [['LONGNA~1.TXT', 'longname.md'], ['LONGNA~1.TXT', 'longna~1.txt'], ['foo~1.txt', 'bar.txt'], ['plain.txt', 'plainname.txt'], ['LONGFO~1', 'longfolder.txt'], ['LONGNAME~1.TXT', 'longname.txt'],
    // An ASCII name that is originally in 8.3 form gets no short name regardless of case (#205).
    ['LONGNA~1.TXT', 'longname.txt'], ['photo~1.jpg', 'photo.jpg'], ['PHOTO~1.JPG', 'Photo.Jpg'], ['NOEXT~1', 'noext'], ['A-@^_~1.TXT', 'a-@^_`{}.txt']];
  for (const [name, other] of yes) assert.strictEqual(fc.couldBeShortNameOf(name, other), true, `${name} ${other}`);
  for (const [name, other] of no) assert.strictEqual(fc.couldBeShortNameOf(name, other), false, `${name} ${other}`);
});

test('원래 8.3 형식인 이름은 ~N 이름과 함께 묶고 풀어도 겹치지 않는다 (#205)', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src', 'photo~1.jpg'), 'tilde');
  fc.writeFile(p('src', 'Photo.Jpg'), 'plain');
  fc.writeFile(p('src', 'NOEXT~1'), 'tilde2');
  fc.writeFile(p('src', 'noext'), 'plain2');
  // Windows does not make a short name for a name that is originally in 8.3 form (even on a volume with 8.3 on, there is no short name in dir /x).
  const listing = childProcess.execFileSync('cmd.exe', ['/c', 'dir', '/x', p('src')], { encoding: 'latin1' });
  assert.ok(!/~\d\S*\s+Photo\.Jpg/i.test(listing), listing);
  fc.zip(p('a.zip'), [p('src')]);
  // Even if the same names exist in the existing folder, it extracts by overwriting as is (it does not point to another file through a short name).
  fc.writeFile(p('out', 'src', 'photo.jpg'), 'old');
  fc.unzip(p('a.zip'), p('out'));
  // tar.exe deletes the existing file and recreates it with the case inside the archive.
  assert.deepStrictEqual(fs.readdirSync(p('out', 'src')).map((n) => n.toLowerCase()).sort(), ['noext', 'noext~1', 'photo.jpg', 'photo~1.jpg']);
  assert.strictEqual(fc.readFile(p('out', 'src', 'photo.jpg')), 'plain');
  assert.strictEqual(fc.readFile(p('out', 'src', 'photo~1.jpg')), 'tilde');
  assert.strictEqual(fc.readFile(p('out', 'src', 'noext')), 'plain2');
  assert.strictEqual(fc.readFile(p('out', 'src', 'NOEXT~1')), 'tilde2');
  // It still does not bundle it with a long name that receives the short name.
  fc.writeFile(p('src', 'photograph.jpg'), 'long');
  assert.throws(() => fc.zip(p('b.zip'), [p('src')]), /could collide through 8\.3 short names/);
});

test('zip은 같은 폴더에 8.3 짧은 이름으로 겹칠 수 있는 이름이 있으면 묶지 않는다 (#159)', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  // If a file literally named LONGER~1.TXT is created first, longername.txt receives a different short name.
  fc.writeFile(p('tree', 'deep', 'LONGER~1.TXT'), '1');
  fc.writeFile(p('tree', 'deep', 'longername.txt'), '2');
  fc.writeFile(p('top', 'LONGER~1.TXT'), '3');
  fc.writeFile(p('longername.txt'), '4');
  fc.writeFile(p('ok', 'foo~1.txt'), '5');
  fc.writeFile(p('ok', 'bar.txt'), '6');
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.zip(p('a.zip'), [p('tree')], { dryRun }), /Names that could collide through 8\.3 short names.*LONGER~1\.TXT.*longername\.txt/);
    // When they overlap at the top, it reports by the source path.
    assert.throws(() => fc.zip(p('a.tar.gz'), [p('top', 'LONGER~1.TXT'), p('longername.txt')], { dryRun }), (err) => err.message.includes(`${p('top', 'LONGER~1.TXT')}, ${p('longername.txt')}`));
  }
  assert.ok(!fs.existsSync(p('a.zip')) && !fs.existsSync(p('a.tar.gz')));
  // A name that looks like a short name but cannot overlap is bundled as is.
  fc.zip(p('ok.zip'), [p('ok')]);
  fc.unzip(p('ok.zip'), p('out'));
  assert.deepStrictEqual(fs.readdirSync(p('out', 'ok')).sort(), ['bar.txt', 'foo~1.txt']);
});

test('zip은 원본을 8.3 짧은 이름으로 주면 그 이름과 겹칠 수 있는 다른 원본을 함께 묶지 않는다 (#159)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('p', 'longername.txt'), 'P');
  fc.writeFile(p('q', 'longername.txt'), 'Q');
  if (!fs.existsSync(p('p', 'LONGER~1.TXT'))) return t.skip('이 볼륨은 8.3 짧은 이름을 만들지 않는다');
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.zip(p('a.zip'), [p('q', 'longername.txt'), p('p', 'LONGER~1.TXT')], { dryRun }), /could collide through 8\.3 short names/);
  }
  assert.ok(!fs.existsSync(p('a.zip')));
  // It also catches a short name that is a hash form from the start because the name is short (such as XAD1C~1.VER).
  fc.writeFile(p('p', 'x.verylongext'), 'P');
  fc.writeFile(p('q', 'x.verylongext'), 'Q');
  const listing = childProcess.execFileSync('cmd.exe', ['/c', 'dir', '/x', p('p')], { encoding: 'latin1' });
  const hashed = /\s(\S+~\d+\.VER)\s+x\.verylongext/i.exec(listing);
  assert.ok(hashed, listing);
  assert.throws(() => fc.zip(p('c.zip'), [p('q', 'x.verylongext'), p('p', hashed[1])]), /could collide through 8\.3 short names/);
  assert.ok(!fs.existsSync(p('c.zip')));
  // If only one is given as a short name, tar.exe writes it as that short name.
  fc.zip(p('b.zip'), [p('p', 'LONGER~1.TXT')]);
  assert.deepStrictEqual(fc.archiveNames(p('b.zip')), ['LONGER~1.TXT']);
});

// unzip does not extract if a ~N name in the archive would overwrite an existing file through a short name or overlap with another item (#188).
test('unzip은 압축 안의 8.3 짧은 이름이 풀 폴더의 기존 항목을 가리키면 풀지 않는다 (#188)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src', 'LONGER~1.TXT'), 'new');
  fc.writeFile(p('src', 'LONGDI~1', 'x.txt'), 'x');
  fc.zip(p('file.zip'), [p('src', 'LONGER~1.TXT')]);
  fc.zip(p('dir.zip'), [p('src', 'LONGDI~1')]);
  fc.writeFile(p('out', 'longername.txt'), 'old');
  fc.makeDir(p('out', 'longdirectory'));
  if (!fs.existsSync(p('out', 'LONGER~1.TXT'))) return t.skip('이 볼륨은 8.3 짧은 이름을 만들지 않는다');
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.unzip(p('file.zip'), p('out'), { dryRun }), (err) => err instanceof fc.FcError && err.message.includes('LONGER~1.TXT') && err.message.includes(p('out', 'longername.txt')));
    assert.throws(() => fc.unzip(p('dir.zip'), p('out'), { dryRun }), (err) => err instanceof fc.FcError && err.message.includes(p('out', 'longdirectory')));
  }
  assert.strictEqual(fs.readFileSync(p('out', 'longername.txt'), 'utf8'), 'old');
  assert.deepStrictEqual(fs.readdirSync(p('out', 'longdirectory')), []);
  // An existing file with exactly the same name is overwritten as now, and in a new folder with no overlapping name it extracts as is.
  fc.writeFile(p('same', 'LONGER~1.TXT'), 'old');
  fc.unzip(p('file.zip'), p('same'));
  assert.strictEqual(fs.readFileSync(p('same', 'LONGER~1.TXT'), 'utf8'), 'new');
  fc.unzip(p('file.zip'), p('fresh'));
  assert.deepStrictEqual(fs.readdirSync(p('fresh')), ['LONGER~1.TXT']);
});

test('unzip은 압축 안에 8.3 짧은 이름으로 겹칠 수 있는 항목이 함께 있으면 풀지 않는다 (#188)', { skip: !isWindows }, () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  // zip does not make such archives (#159), so it is bundled directly with tar.exe.
  fc.writeFile(p('src', 'deep', 'LONGER~1.TXT'), '1');
  fc.writeFile(p('src', 'deep', 'longername.txt'), '2');
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-cf', p('a.zip'), '-C', p('src'), 'deep']);
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.unzip(p('a.zip'), p('out'), { dryRun }), /The archive contains items that could collide through 8\.3 short names.*deep\/LONGER~1\.TXT, deep\/longername\.txt/);
  }
  assert.ok(!fs.existsSync(p('out', 'deep')));
});

test('rejectExtractShortNameClash 어림: 깨진 글자는 무엇이든 될 수 있다고 보고, 겹칠 수 없는 이름은 통과한다 (#188)', () => {
  const dir = tempDir();
  assert.throws(() => fc.rejectExtractShortNameClash(['ABC~1.TXT', '???.txt'], path.join(dir, 'none')), /could collide through 8\.3 short names/);
  assert.throws(() => fc.rejectExtractShortNameClash(['a/LONGER~1.TXT', 'a/longername.txt'], path.join(dir, 'none')), /a\/LONGER~1\.TXT/);
  // Windows is case-insensitive, so a/ and A/ are the same folder (first review).
  assert.throws(() => fc.rejectExtractShortNameClash(['a/longername.txt', 'A/LONGER~1.TXT'], path.join(dir, 'none')), /a\/LONGER~1\.TXT, a\/longername\.txt/);
  fc.rejectExtractShortNameClash(['foo~1.txt', 'bar.txt', 'a/LONGER~1.TXT', 'longername.txt'], path.join(dir, 'none'));
  fc.rejectExtractShortNameClash(['foo~1.txt'], dir);
  assert.throws(() => fc.rejectExtractShortNameClash(['b\\LONGER~1.TXT', 'b/longername.txt'], path.join(dir, 'none')), /b\/LONGER~1\.TXT/);
  // A single ~N entry with garbled letters does not overlap with itself (first review).
  for (const name of ['����~1.jpg', '??~1.jpg', '사진~1.jpg']) fc.rejectExtractShortNameClash([name, 'ok.txt'], path.join(dir, 'none'));
  // A garbled ~N name cannot be checked by path, so it is compared with the existing folder names by estimate. A garbled folder name counts as every existing non-ASCII folder.
  fc.writeFile(path.join(dir, 'out', '한글긴파일이름입니다.txt'), 'old');
  fc.writeFile(path.join(dir, 'out', '사진', 'longername.txt'), 'old');
  fc.writeFile(path.join(dir, 'out', 'plain', 'other.txt'), 'old');
  assert.throws(() => fc.rejectExtractShortNameClash(['���~1.TXT'], path.join(dir, 'out')), (err) => err.message.includes(path.join(dir, 'out', '한글긴파일이름입니다.txt')));
  assert.throws(() => fc.rejectExtractShortNameClash(['��/LONGER~1.TXT'], path.join(dir, 'out')), (err) => err.message.includes(path.join(dir, 'out', '사진', 'longername.txt')));
  fc.rejectExtractShortNameClash(['��~1.md', 'plain/��~1.TXT', 'new/��~1.TXT'], path.join(dir, 'out'));
});

test('unzip은 한글 ~N 항목 하나만 든 압축을 새 폴더에 풀고, 한글 긴 이름이 있는 기존 폴더에는 풀지 않는다 (#188 1차 리뷰)', { skip: !isWindows }, (t) => {
  // A Hangul name can be bundled with tar.exe only when the ANSI and OEM code pages are 949 (the English Windows of CI is 1252 and 437).
  if (fc.oemCodePage() !== 949) return t.skip(`OEM 코드페이지 ${fc.oemCodePage()}에서는 한글 이름을 묶을 수 없다`);
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('src', '한글긴~1.TXT'), 'new');
  fc.zip(p('a.zip'), [p('src', '한글긴~1.TXT')]);
  fc.unzip(p('a.zip'), p('fresh'));
  assert.deepStrictEqual(fs.readdirSync(p('fresh')), ['한글긴~1.TXT']);
  fc.writeFile(p('out', '한글긴파일이름입니다.txt'), 'old');
  assert.throws(() => fc.unzip(p('a.zip'), p('out')), /may point to an item that already exists through an 8\.3 short name.*cannot be confirmed.*may look garbled/);
  assert.strictEqual(fs.readFileSync(p('out', '한글긴파일이름입니다.txt'), 'utf8'), 'old');
  // Even extracting the same archive again into the same folder is refused because the name cannot be confirmed (a limit written in the README, second review).
  assert.throws(() => fc.unzip(p('a.zip'), p('fresh')), /might be an item with exactly the same name/);
});

// tar.exe makes x.cpio.gz a cpio inside gzip. The temporary file also gets both extensions so the name and the content are the same (#164).
test('zip은 형식+압축 겹 확장자(.cpio.gz 등)를 그 형식과 압축으로 묶는다 (#164)', () => {
  const zlib = require('node:zlib');
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  const head = (name, n = 3) => [...fs.readFileSync(p(name)).subarray(0, n)];
  const inner = (name, n) => zlib.gunzipSync(fs.readFileSync(p(name))).subarray(0, n).toString('latin1');
  const GZIP = [0x1f, 0x8b, 0x08];
  const cases = [
    ['c.cpio.gz', GZIP, '070707'], ['U.CPIO.GZ', GZIP, '070707'], ['z.zip.gz', GZIP, 'PK'], ['r.ar.gz', GZIP, '!<arch>'], ['x.xar.gz', GZIP, 'xar!'],
    // .jar is not read as a format by tar.exe, so it becomes a tar inside gzip, the same as just adding .gz.
    ['j.jar.gz', GZIP, 'a.txt'],
    ['k.cpio.Z', [0x1f, 0x9d, 0x90]], ['i.iso.bz2', [0x42, 0x5a, 0x68]], ['w.warc.zst', [0x28, 0xb5, 0x2f]],
    ['m.cpio.lzma', [0x5d, 0x00, 0x00]], ['l.cpio.lz', [0x4c, 0x5a, 0x49]], ['u.zip.uu', [0x62, 0x65, 0x67]], ['t.mtree.gz', GZIP, '#mtree'],
    // A lowercase .z is not compression, so it is not seen as two layers and becomes an uncompressed tar (the same as .tar.z).
    ['n.cpio.z', [0x61, 0x2e, 0x74]],
  ];
  for (const [name, magic, content] of cases) {
    fc.zip(p(name), [p('a.txt')]);
    assert.deepStrictEqual(head(name), magic, name);
    if (content) assert.strictEqual(inner(name, content.length), content, name);
  }
  // The archive name stays as received, and extracting gives the original content.
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', ...cases.map(([name]) => name)].sort());
  for (const name of ['c.cpio.gz', 'z.zip.gz', 'k.cpio.Z', 'i.iso.bz2', 'x.xar.gz', 'w.warc.zst', 'm.cpio.lzma', 'u.zip.uu', 'n.cpio.z']) {
    fc.unzip(p(name), p(`out-${name}`));
    assert.strictEqual(fc.readFile(p(`out-${name}`, 'a.txt')), 'A', name);
  }
});

// tar.exe peels the compression extensions at the end layer by layer, so the temporary file also gets all the continuing compression extensions (#193).
test('archiveExt는 끝에서 이어지는 압축 확장자를 모두 돌려준다 (#193)', () => {
  const cases = {
    'x.tar.gz.gz': '.tar.gz.gz', 'x.cpio.gz.xz': '.cpio.gz.xz', 'X.CPIO.GZ.XZ': '.cpio.gz.xz', 'x.gz.gz.gz': '.gz.gz.gz', 'y.tgz.gz': '.tgz.gz',
    'y.Z.gz': '.Z.gz', 'x.cpio.Z.gz': '.cpio.Z.gz', 'y.tz2.gz': '.tz2.gz', 'y.tzo.gz': '.tzo.gz', 'x.jar.gz.xz': '.gz.xz', 'x.7z.gz.xz': '.7z.gz.xz', 'x.zip.gz.gz': '.zip.gz.gz',
    // A name that is not layered is the same as before.
    'x.tar.gz': '.tar.gz', 'x.cpio.gz': '.cpio.gz', 'x.tar.zip': '.tar.zip', 'x.tar.tgz': '.tar.tgz', 'x.jar.gz': '.gz', 'x.zip': '.zip', 'x.cpio.z': '.z',
    'x.taZ': '.taZ', 'x.TGZ': '.tgz', 'gz.xz': '.xz', 'tar.gz': '.gz', '.gz': '.gz', 'x.my-file.gz': '.gz', 'x.gz.my-file': '', noext: '',
  };
  for (const [name, ext] of Object.entries(cases)) assert.strictEqual(fc.archiveExt(name), ext, name);
});

test('zip·unzip은 255자를 넘는 이름이나 tar.exe가 옮겨 갈 수 없는 259자 이상의 -C 폴더를 미리보기에서도 FcError로 거부한다 (#228)', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  fc.zip(p('ok.zip'), [p('a.txt')]);
  const long = 'a'.repeat(256);
  const tooLong = (err) => err instanceof fc.FcError && /name of 256 characters, so it cannot be created \(one name can be up to 255 characters\)/.test(err.message);
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.zip(p(`${long}.zip`), [p('a.txt')], { dryRun }), (err) => err instanceof fc.FcError && /name of 260 characters/.test(err.message));
    assert.throws(() => fc.zip(p(long, 'x.zip'), [p('a.txt')], { dryRun }), tooLong);
    assert.throws(() => fc.unzip(p('ok.zip'), p(long), { dryRun }), tooLong);
    assert.throws(() => fc.unzip(p('ok.zip'), p(long, 'in'), { dryRun }), tooLong);
  }
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', 'ok.zip']);
  // A 255-character name is bundled and extracted as is.
  const fits = `${'b'.repeat(251)}.zip`;
  fc.zip(p(fits), [p('a.txt')]);
  fc.unzip(p(fits), p('c'));
  assert.strictEqual(fc.readFile(p('c', 'a.txt')), 'A');
  // tar.exe moves into a -C folder path only up to 258 characters. The extraction folder extracts up to 258 characters and is refused from 259.
  const destOf = (length) => p('d'.repeat(length - dir.length - 1));
  fc.unzip(p('ok.zip'), destOf(258));
  assert.strictEqual(fc.readFile(path.join(destOf(258), 'a.txt')), 'A');
  const deepParent = path.join(destOf(258), 'e');
  fc.writeFile(path.join(deepParent, 'x.txt'), 'X');
  // Even on CI with long paths turned on, tar.exe could not move into a 259-character -C folder, so it refuses regardless of the setting (second review).
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.unzip(p('ok.zip'), destOf(259), { dryRun }), (err) => err instanceof fc.FcError && /extraction folder path is 259 characters, so tar\.exe cannot change into that folder \(up to 258\)/.test(err.message));
  }
  assert.ok(!fs.existsSync(destOf(259)));
  // The parent folder of the source is also passed with -C, so it refuses from 259 characters.
  for (const dryRun of [true, false]) {
    assert.throws(() => fc.zip(p('deep.zip'), [path.join(deepParent, 'x.txt')], { dryRun }), (err) => err instanceof fc.FcError && /source's parent folder path is 260 characters/.test(err.message));
  }
  assert.ok(!fs.existsSync(p('deep.zip')));
  // If the parent folder is given as the source (-C is a 258-character folder), it is bundled as is.
  fc.zip(p('deep.zip'), [deepParent]);
  assert.strictEqual(fc.archiveEntries(p('deep.zip')).length, 2);
});

test('unzip은 외부 프로그램이 필요한 압축(lz4·lzop)을 그 프로그램이 없어 풀지 못하면 프로그램 이름을 밝힌 FcError로 알린다 (#241)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  // It is identified by content (the magic and the frame header), not by name, so the extension does not matter.
  const samples = {
    'a.tar.lz4': [Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x64, 0x70, 0xb9, 1, 2, 3, 4]), 'lz4'],
    'b.tar.lzo': [Buffer.concat([Buffer.from([0x89, 0x4c, 0x5a, 0x4f, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]), 'lzop'],
    'c.zip': [Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x64, 0x70, 0xb9, 1, 2, 3, 4]), 'lz4'],
  };
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  process.env.PATH = p('nothing');
  for (const [name, [data, program]] of Object.entries(samples)) {
    fs.writeFileSync(p(name), data);
    const missing = (err) => err instanceof fc.FcError && err.message.includes(`needs the external program ${program}, but it could not be run`);
    assert.throws(() => fc.unzip(p(name), p(`out-${name}`)), missing, name);
    assert.throws(() => fc.unzip(p(name), p(`out-${name}`), { dryRun: true }), missing, name);
    assert.throws(() => fc.archiveEntries(p(name)), missing, name);
  }
  // Other tar.exe failures are left as a raw error, as now (the format was not recognized).
  fs.writeFileSync(p('junk.tar'), 'not an archive at all');
  assert.throws(() => fc.archiveEntries(p('junk.tar')), (err) => !(err instanceof fc.FcError));
  // Even if an entry name imitates that message (a `<name>: Path contains '..'` line), it is not reported as the external program missing (first review).
  const header = (name) => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, 'latin1');
    block.write('0000644\0' + '0000000\0' + '0000000\0' + '00000000001\0' + '00000000000\0', 100, 'latin1');
    block.fill(' ', 148, 156);
    block.write('0', 156, 'latin1');
    block.write('ustar\0' + '00', 257, 'latin1');
    block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    return block;
  };
  const fake = Buffer.concat([header('../unable to run program "lz4 x"'), Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]);
  fs.writeFileSync(p('fake.tar'), fake);
  assert.throws(() => fc.unzip(p('fake.tar'), p('out-fake')), (err) => !String(err.message).includes('external program'));
});

// tar.exe looks for external compression programs with SearchPath and runs the one in the current folder before the PATH. fctl runs tar.exe from System32 (#242).
test('tar.exe가 현재 폴더에 심어 둔 외부 압축 프로그램(lz4.exe)을 실행하지 않는다 (#242)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  // The fake lz4.exe is a copy of cmd.exe. When tar.exe runs it, it receives the content of the lz4 archive on standard input and makes a marker file with the command inside.
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), p('lz4.exe'));
  const marker = p('hijacked.txt');
  // It needs the lz4 magic and the frame header (version 01, 4MB block, header checksum) for tar.exe to recognize it as lz4 and start the external program.
  fs.writeFileSync(p('x.lz4'), Buffer.concat([Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x64, 0x70, 0xb9]), Buffer.from(`\r\necho hijacked> "${marker}"\r\nexit\r\n`)]));
  // It first checks that it is an environment where it gets executed: with the current folder set to that folder and tar.exe called directly, the fake lz4.exe runs.
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  childProcess.spawnSync(tar, ['-tf', p('x.lz4')], { cwd: dir, stdio: 'ignore', timeout: 20000 });
  if (!fs.existsSync(marker)) return t.skip('이 환경의 tar.exe는 현재 폴더의 프로그램을 실행하지 않는다');
  fs.rmSync(marker);
  // Even if fctl is run from that folder (current folder = dir), the fake lz4.exe is not run.
  const saved = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(saved));
  assert.throws(() => fc.archiveNames(p('x.lz4')));
  const probe = fc.probeArchive(p('x.lz4'), { maxBuffer: 1 << 20, timeout: 20000 });
  assert.notStrictEqual(probe.status, 0);
  process.chdir(saved);
  assert.ok(!fs.existsSync(marker), '현재 폴더의 가짜 lz4.exe가 실행됐다');
});

test('zip은 외부 프로그램이 필요한 압축(.lz4·.lzo·.lrz·.grz)을 그 프로그램이 PATH에 없으면 미리보기에서도 FcError로 거부한다 (#230)', (t) => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  // It changes PATH to one empty folder to make an environment where the program does not exist.
  fs.mkdirSync(p('bin'));
  const savedPath = process.env.PATH;
  process.env.PATH = p('bin');
  t.after(() => { process.env.PATH = savedPath; });
  // tar.exe runs only .exe, so even if a .cmd exists, it is seen as absent (first review).
  fs.writeFileSync(p('bin', 'lz4.cmd'), '@echo off');
  const cases = { 'x.tar.lz4': 'lz4', 'x.lz4': 'lz4', 'x.tar.lzo': 'lzop', 'x.tar.lrz': 'lrzip', 'x.tar.grz': 'grzip', 'x.cpio.lz4': 'lz4', 'x.tar.gz.lz4': 'lz4', 'X.TAR.LZ4': 'lz4', 'x.tzo': 'lzop', 'X.TZO': 'lzop', 'x.tzo.gz': 'lzop' };
  for (const [name, program] of Object.entries(cases)) {
    for (const dryRun of [true, false]) {
      assert.throws(() => fc.zip(p(name), [p('a.txt')], { dryRun }), (err) => err instanceof fc.FcError && err.message.includes(`needs the external program ${program}, but it was not found on PATH`), name);
    }
  }
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', 'bin']);
  // Built-in compression (.lz, .lzma, .zst) and a last extension that is not compression (.lz4.txt) are bundled as they are.
  process.env.PATH = savedPath;
  for (const name of ['x.tar.lz', 'x.tar.lzma', 'x.tar.zst', 'x.lz4.txt']) fc.zip(p(name), [p('a.txt')]);
  // If the program is on the PATH, it does not refuse and leaves it to tar.exe (it looks at only this check with the preview).
  fs.writeFileSync(p('bin', 'lz4.exe'), '');
  process.env.PATH = p('bin');
  assert.match(fc.zip(p('y.tar.lz4'), [p('a.txt')], { dryRun: true }), /\[Preview\] Compress/);
  // Relative PATH entries are resolved by tar.exe relative to System32, so they are not looked at (#242 first review).
  const saved = process.cwd();
  process.chdir(p('bin'));
  t.after(() => process.chdir(saved));
  process.env.PATH = '.';
  assert.throws(() => fc.zip(p('z.tar.lz4'), [p('a.txt')], { dryRun: true }), /needs the external program lz4/);
  process.chdir(saved);
});

test('zip은 임시 이름이 255자를 넘거나 tar.exe가 풀 수 없는 겹 수(25겹 이상)면 FcError로 거부하고 아무것도 남기지 않는다 (#213)', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  for (const dryRun of [true, false]) {
    // If the last extension alone is very long, the temporary name exceeds 255 characters.
    assert.throws(() => fc.zip(p(`x.${'a'.repeat(240)}`), [p('a.txt')], { dryRun }), (err) => err instanceof fc.FcError && /extension is too long \(241 characters\).*exceeds 255 characters/.test(err.message));
    // From 25 layers, tar.exe cannot extract it again (80 layers is the example in the issue).
    for (const layers of [25, 80]) {
      assert.throws(() => fc.zip(p(`x${'.gz'.repeat(layers)}`), [p('a.txt')], { dryRun }), (err) => err instanceof fc.FcError && err.message.includes(`${layers} layers, so tar.exe cannot extract it again (up to 24 layers)`));
    }
    assert.throws(() => fc.zip(p(`x.${'tbz2.'.repeat(24)}tzst`), [p('a.txt')], { dryRun }), /has 25 layers/);
  }
  // Boundary: temporary name length = fixed part + 4 characters of room for the number + the extension. An extension that fits the limit exactly is bundled, and one character longer is refused (first review).
  const fixed = `.fctl-new-${process.pid}-${Date.now()}-0`.length + 4;
  const edge = `e.${'b'.repeat(255 - fixed - 1)}`;
  fc.zip(p(edge), [p('a.txt')]);
  fs.rmSync(p(edge));
  assert.throws(() => fc.zip(p(`e.${'b'.repeat(255 - fixed)}`), [p('a.txt')], { dryRun: true }), /extension is too long/);
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.txt']);
  // 24 layers can be bundled and extracted again.
  const fits = `y${'.gz'.repeat(24)}`;
  fc.zip(p(fits), [p('a.txt')]);
  fc.unzip(p(fits), p('out'));
  assert.strictEqual(fc.readFile(p('out', 'a.txt')), 'A');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.txt', 'out', fits].sort());
});

test('zip은 압축 확장자가 여러 겹인 이름을 tar.exe가 그 이름으로 만들 때와 같은 겹으로 묶는다 (#193)', () => {
  const zlib = require('node:zlib');
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  const peel = (name, layers) => {
    let data = fs.readFileSync(p(name));
    for (let i = 0; i < layers; i += 1) data = zlib.gunzipSync(data);
    return data;
  };
  // [name, number of gzip layers to peel, inner start]. An uncompressed tar starts with the first entry name (a.txt).
  const cases = [['t.tar.gz.gz', 2, 'a.txt'], ['g.gz.gz.gz', 3, 'a.txt'], ['c.cpio.gz.gz', 2, '070707'], ['k.tgz.gz', 2, 'a.txt'], ['z.zip.gz.gz', 2, 'PK']];
  for (const [name, layers, inner] of cases) {
    fc.zip(p(name), [p('a.txt')]);
    assert.strictEqual(peel(name, layers).subarray(0, inner.length).toString('latin1'), inner, name);
    fc.unzip(p(name), p(`out-${name}`));
    assert.strictEqual(fc.readFile(p(`out-${name}`, 'a.txt')), 'A', name);
  }
  // xz layers cannot be peeled with Node, so it checks only that the outside is xz and that it extracts again.
  fc.zip(p('c.cpio.gz.xz'), [p('a.txt')]);
  assert.deepStrictEqual([...fs.readFileSync(p('c.cpio.gz.xz')).subarray(0, 6)], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  fc.unzip(p('c.cpio.gz.xz'), p('out-xz'));
  assert.strictEqual(fc.readFile(p('out-xz', 'a.txt')), 'A');
  // It checks whether what is inside one gzip layer is compress (.Z) or bzip2 (.tz2 is an alias of .tar.bz2) (first review).
  for (const [name, magic] of [['q.cpio.Z.gz', [0x1f, 0x9d, 0x90]], ['b.tz2.gz', [0x42, 0x5a, 0x68]]]) {
    fc.zip(p(name), [p('a.txt')]);
    assert.deepStrictEqual([...peel(name, 1).subarray(0, 3)], magic, name);
    fc.unzip(p(name), p(`out-${name}`));
    assert.strictEqual(fc.readFile(p(`out-${name}`, 'a.txt')), 'A', name);
  }
});

test('zip은 7z를 다른 압축으로 한 번 더 싸는 이름(.7z.gz 등)을 tar.exe가 풀 수 없으므로 거부한다 (#164)', () => {
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fc.writeFile(p('a.txt'), 'A');
  for (const name of ['s.7z.gz', 'S.7Z.XZ', 's.7z.Z', 's.7z.gz.xz', 'S.7Z.GZ.GZ']) {
    for (const dryRun of [true, false]) {
      assert.throws(() => fc.zip(p(name), [p('a.txt')], { dryRun }), /A 7z archive cannot be wrapped in another archive/, name);
    }
  }
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.txt']);
  // If a non-compression extension comes after, it is decided by that extension.
  fc.zip(p('s.7z.zip'), [p('a.txt')]);
  assert.strictEqual(fs.readFileSync(p('s.7z.zip')).subarray(0, 2).toString(), 'PK');
});
