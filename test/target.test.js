'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { resolveTarget, isInside, resolveInside, readInside, readRange, fileSizeInside, walk, grant } = require('../src/target');

const isWindows = process.platform === 'win32';

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로,
// 이 파일에서는 사용자 폴더를 임시 폴더 밖의 가짜 경로로 바꿔 둔다. 보호 테스트는 home을 직접 정한다.
const defaultHome = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');
let home = defaultHome;
test.mock.method(os, 'homedir', () => home);

// 테스트 안에서만 사용자 폴더를 바꾸고, 끝나면 되돌린다.
function useHome(t, dir) {
  home = dir;
  t.after(() => {
    home = defaultHome;
  });
}

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

test('walk는 대소문자를 무시하고 정렬하며, 대소문자만 다르면 순서를 고정한다', () => {
  const dir = tempDir();
  for (const name of ['b.txt', 'B2.txt', 'a.txt', 'Z.txt']) fs.writeFileSync(path.join(dir, name), '');
  assert.deepStrictEqual(listing(dir).map(([name]) => name), ['a.txt', 'b.txt', 'B2.txt', 'Z.txt']);
});

test('walk는 하위 폴더 하나라도 읽지 못하면 일부 목록 대신 오류를 낸다', (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'ok'));
  fs.mkdirSync(path.join(dir, 'locked'));
  fs.writeFileSync(path.join(dir, 'ok', 'f.txt'), '');
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, opts) => {
    if (path.basename(p) === 'locked') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return readdir(p, opts);
  });
  assert.throws(() => walk(dir), (err) => err instanceof FcError && err.message.includes('locked') && err.message.includes('EPERM'));
});

test('readInside는 타겟 안 파일의 내용 전체를 Buffer로 읽는다', () => {
  const target = resolveTarget(tempDir());
  fs.mkdirSync(path.join(target, 'sub'));
  fs.writeFileSync(path.join(target, 'sub', 'a.bin'), Buffer.from([0, 1, 2, 255]));
  assert.deepStrictEqual(readInside(target, 'sub/a.bin'), Buffer.from([0, 1, 2, 255]));
  assert.deepStrictEqual(readInside(target, path.join(target, 'sub', 'a.bin')), Buffer.from([0, 1, 2, 255]));
});

test('readRange는 offset부터 length바이트를 읽고, 파일 끝을 넘으면 있는 만큼만 돌려준다', () => {
  const target = resolveTarget(tempDir());
  fs.writeFileSync(path.join(target, 'v.mp4'), Buffer.from('0123456789'));
  assert.strictEqual(readRange(target, 'v.mp4', { length: 4 }).toString(), '0123');
  assert.strictEqual(readRange(target, 'v.mp4', { offset: 6, length: 3 }).toString(), '678');
  assert.strictEqual(readRange(target, 'v.mp4', { offset: 8, length: 10 }).toString(), '89');
  assert.strictEqual(readRange(target, 'v.mp4', { offset: 20, length: 4 }).length, 0);
  assert.strictEqual(readRange(target, 'v.mp4', { length: 0 }).length, 0);
});

test('fileSizeInside는 타겟 안 파일의 크기만 돌려준다', () => {
  const target = tempDir();
  const outside = tempDir();
  fs.writeFileSync(path.join(target, 'v.mp4'), '0123456789');
  fs.writeFileSync(path.join(outside, 'o.mp4'), '0');
  fs.mkdirSync(path.join(target, 'd'));
  assert.strictEqual(fileSizeInside(target, 'v.mp4'), 10);
  assert.throws(() => fileSizeInside(target, path.join(outside, 'o.mp4')), /타겟 폴더 밖/);
  assert.throws(() => fileSizeInside(target, 'd'), /파일이 아닙니다/);
});

test('readRange는 잘못된 offset·length를 거부한다', () => {
  const target = resolveTarget(tempDir());
  fs.writeFileSync(path.join(target, 'f.txt'), 'x');
  for (const bad of [{ length: -1 }, { length: 1.5 }, {}, undefined, { offset: -1, length: 1 }, { offset: '1', length: 1 }, { length: 2 ** 31 }]) {
    assert.throws(() => readRange(target, 'f.txt', bad), FcError, JSON.stringify(bad));
  }
});

test('readInside·readRange는 타겟 밖, 없는 파일, 폴더를 거부한다', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'target', 'dir'), { recursive: true });
  const target = resolveTarget(path.join(root, 'target'));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  for (const read of [(p) => readInside(target, p), (p) => readRange(target, p, { length: 1 })]) {
    assert.throws(() => read('../secret.txt'), FcError);
    assert.throws(() => read(path.join(root, 'secret.txt')), FcError);
    assert.throws(() => read('nope.txt'), FcError);
    assert.throws(() => read('dir'), FcError);
    assert.throws(() => read('.'), FcError);
  }
});

test('readInside는 링크·정션을 거쳐 타겟 밖 파일을 읽지 않고, 안쪽을 가리키는 링크는 읽는다', () => {
  const root = tempDir();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, 'target', 'real'), { recursive: true });
  const target = resolveTarget(path.join(root, 'target'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(target, 'real', 'ok.txt'), 'ok');
  linkDir(outside, path.join(target, 'escape'));
  linkDir(path.join(target, 'real'), path.join(target, 'alias'));
  assert.throws(() => readInside(target, 'escape/secret.txt'), /링크를 거쳐/);
  assert.throws(() => readRange(target, 'escape/secret.txt', { length: 1 }), /링크를 거쳐/);
  assert.strictEqual(readInside(target, 'alias/ok.txt').toString(), 'ok');
});

test('readRange는 손상된 헤더처럼 큰 length를 받아도 파일에 있는 만큼만 읽는다', () => {
  const target = resolveTarget(tempDir());
  fs.writeFileSync(path.join(target, 'tiny.mp4'), 'abcde');
  const result = readRange(target, 'tiny.mp4', { offset: 1, length: 2 ** 31 - 1 });
  assert.strictEqual(result.toString(), 'bcde');
  // subarray는 원래 할당한 메모리를 공유하므로, 할당 자체가 작았는지 확인한다.
  assert.ok(result.buffer.byteLength <= 5, `할당 크기: ${result.buffer.byteLength}`);
});

test('readInside는 한 번에 읽을 수 없는 큰 파일을 FcError로 거부한다', (t) => {
  const target = resolveTarget(tempDir());
  fs.writeFileSync(path.join(target, 'huge.mkv'), '');
  const statSync = fs.statSync;
  t.mock.method(fs, 'statSync', (p, opts) => {
    const stat = statSync(p, opts);
    if (stat && path.basename(p) === 'huge.mkv') stat.size = 2 ** 31;
    return stat;
  });
  assert.throws(() => readInside(target, 'huge.mkv'), (err) => err instanceof FcError && err.message.includes('readRange'));
});

test('resolveTarget은 사용자 폴더 바로 아래 숨김 설정 폴더와 그 안을 거부한다', (t) => {
  useHome(t, path.join(tempDir(), 'kim'));
  for (const dir of ['.ssh', '.config/gh', 'AppData/Local/Temp', 'Downloads/.hidden', 'Downloads']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  assert.throws(() => resolveTarget(path.join(home, '.ssh')), /보호된 경로/);
  assert.throws(() => resolveTarget(path.join(home, '.config', 'gh')), /보호된 경로/);
  assert.throws(() => resolveTarget(path.join(home, 'AppData', 'Local', 'Temp')), /보호된 경로/);
  assert.strictEqual(resolveTarget(path.join(home, 'Downloads')), path.join(home, 'Downloads'));
  assert.strictEqual(resolveTarget(path.join(home, 'Downloads', '.hidden')), path.join(home, 'Downloads', '.hidden'));
});

test('resolveTarget은 Windows에서 대소문자가 다른 AppData도 거부한다', { skip: !isWindows }, (t) => {
  useHome(t, path.join(tempDir(), 'kim'));
  fs.mkdirSync(path.join(home, 'AppData'), { recursive: true });
  assert.throws(() => resolveTarget(path.join(home, 'APPDATA')), /보호된 경로/);
});

test('resolveTarget은 사용자 폴더 자신과 그것을 품은 상위 폴더를 거부한다', (t) => {
  const root = tempDir();
  useHome(t, path.join(root, 'users', 'kim'));
  fs.mkdirSync(home, { recursive: true });
  assert.throws(() => resolveTarget(home), /사용자 폴더/);
  assert.throws(() => resolveTarget(path.join(root, 'users')), /사용자 폴더/);
  assert.throws(() => resolveTarget(root), /사용자 폴더/);
  fs.mkdirSync(path.join(root, 'users', 'kim2'));
  assert.strictEqual(resolveTarget(path.join(root, 'users', 'kim2')), path.join(root, 'users', 'kim2'));
});

test('resolveTarget은 정션을 거쳐 보호 폴더를 가리켜도 거부한다', (t) => {
  const root = tempDir();
  useHome(t, path.join(root, 'kim'));
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  linkDir(path.join(home, '.ssh'), path.join(root, 'keys'));
  assert.throws(() => resolveTarget(path.join(root, 'keys')), /보호된 경로/);
});

test('resolveTarget은 Windows 시스템 폴더와 그 안, 그것을 품은 드라이브 루트를 거부한다', { skip: !isWindows }, () => {
  const windows = process.env.SystemRoot;
  const programFiles = process.env.ProgramFiles;
  for (const dir of [windows, windows.toLowerCase(), path.join(windows, 'System32'), programFiles, path.parse(windows).root]) {
    assert.throws(() => resolveTarget(dir), /보호된 경로/, dir);
  }
  const x86 = process.env['ProgramFiles(x86)'];
  if (x86 && fs.existsSync(x86)) assert.throws(() => resolveTarget(x86), /보호된 경로/);
});

test('resolveTarget은 UNC·네트워크 경로를 존재 여부와 상관없이 거부한다', { skip: !isWindows }, () => {
  for (const dir of ['\\\\localhost\\C$\\Windows', '\\\\?\\UNC\\localhost\\C$\\Windows', '\\\\127.0.0.1\\C$\\Users', '\\\\server\\share', '\\\\.\\C:\\Windows']) {
    assert.throws(() => resolveTarget(dir), /네트워크 경로/, dir);
  }
});

test('resolveTarget은 링크로 된 환경 변수 경로도 실제 경로로 맞춰 비교한다', { skip: !isWindows }, (t) => {
  const programFiles = process.env.ProgramFiles;
  t.after(() => {
    process.env.ProgramFiles = programFiles;
  });
  const alias = path.join(tempDir(), 'pf');
  linkDir(programFiles, alias);
  process.env.ProgramFiles = alias;
  assert.throws(() => resolveTarget(programFiles), /보호된 경로/);
});

test('resolveTarget은 절대경로가 아닌 환경 변수 대신 기본 위치를 보호한다', { skip: !isWindows }, (t) => {
  const systemRoot = process.env.SystemRoot;
  t.after(() => {
    process.env.SystemRoot = systemRoot;
  });
  process.env.SystemRoot = 'relative\\windows';
  // 상대경로를 그대로 쓰면 현재 폴더 아래를 보호 대상으로 잡아 현재 폴더까지 거부된다.
  assert.strictEqual(resolveTarget('.'), fs.realpathSync.native('.'));
  assert.throws(() => resolveTarget('C:\\Windows'), /보호된 경로/);
});

test('resolveTarget은 사용자 폴더를 알 수 없으면 FcError를 낸다', (t) => {
  useHome(t, '');
  assert.throws(() => resolveTarget(tempDir()), (err) => err instanceof FcError && err.message.includes('사용자 폴더'));
});

const ALL_ACCESS = ['read', 'write', 'delete'];

// 타겟 안에 일반 폴더·파일을, 타겟 밖에 비밀 파일을 만든다.
function accessFixture() {
  const root = tempDir();
  const outside = path.join(root, 'outside');
  const target = path.join(root, 'target');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(target, 'sub', 'a.txt'), 'a');
  return { root, outside, target };
}

test('grant는 부여한 작업만 허용한다', () => {
  const { target } = accessFixture();
  const readOnly = grant(target, ['read']);
  assert.strictEqual(readOnly.target, target);
  assert.strictEqual(readOnly.read('sub/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.throws(() => readOnly.write('sub/a.txt'), /쓰기 권한이 없습니다/);
  assert.throws(() => readOnly.delete('sub/a.txt'), /삭제 권한이 없습니다/);
  const deleteOnly = grant(target, ['delete']);
  assert.strictEqual(deleteOnly.delete('sub/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.throws(() => deleteOnly.read('sub/a.txt'), /읽기 권한이 없습니다/);
});

test('grant는 잘못된 권한 목록을 거부한다', () => {
  const { target } = accessFixture();
  for (const bad of [undefined, 'read', [], ['execute'], ['constructor'], ['read', 'nope'], [undefined], [,], new Array(2), [['read']], [Symbol('read')]]) {
    assert.throws(() => grant(target, bad), FcError);
  }
});

test('grant는 부여 뒤에 권한 목록을 고쳐도 늘어나지 않고, 함수도 바꿀 수 없다', () => {
  const { target } = accessFixture();
  const kinds = ['read'];
  const access = grant(target, kinds);
  kinds.push('delete');
  assert.throws(() => access.delete('sub/a.txt'), /삭제 권한이 없습니다/);
  assert.ok(Object.isFrozen(access));
});

test('grant는 보호 경로와 없는 타겟을 거부한다', (t) => {
  const root = tempDir();
  useHome(t, path.join(root, 'kim'));
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  assert.throws(() => grant(path.join(home, '.ssh'), ALL_ACCESS), /보호된 경로/);
  assert.throws(() => grant(home, ALL_ACCESS), /사용자 폴더/);
  assert.throws(() => grant(path.join(root, 'nope'), ALL_ACCESS), FcError);
});

test('grant는 세 작업 모두 타겟 밖 경로를 거부하고 아무것도 바꾸지 않는다', () => {
  const { root, outside, target } = accessFixture();
  const access = grant(target, ALL_ACCESS);
  const before = listing(root);
  for (const kind of ALL_ACCESS) {
    for (const p of ['..', '../outside/secret.txt', 'sub/../../outside/secret.txt', path.join(outside, 'secret.txt'), root]) {
      assert.throws(() => access[kind](p), /타겟 폴더 밖/, `${kind} ${p}`);
    }
  }
  assert.deepStrictEqual(listing(root), before);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
});

test('grant는 Windows에서 다른 드라이브 경로를 거부한다', { skip: !isWindows }, () => {
  const { target } = accessFixture();
  const other = path.parse(target).root.toUpperCase().startsWith('Z') ? 'Y:\\a.txt' : 'Z:\\a.txt';
  const access = grant(target, ALL_ACCESS);
  for (const kind of ALL_ACCESS) assert.throws(() => access[kind](other), /타겟 폴더 밖/, kind);
});

test('grant는 세 작업 모두 정션을 거쳐 타겟 밖으로 나가는 경로를 거부한다', () => {
  const { outside, target } = accessFixture();
  linkDir(outside, path.join(target, 'escape'));
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.read('escape'), /링크를 거쳐/);
  assert.throws(() => access.read('escape/secret.txt'), /링크를 거쳐/);
  assert.throws(() => access.write('escape'), /링크를 거쳐/);
  assert.throws(() => access.write('escape/secret.txt'), /링크를 거쳐/);
  assert.throws(() => access.write('escape/new/deep.txt'), /링크를 거쳐/);
  assert.throws(() => access.delete('escape/secret.txt'), /링크를 거쳐/);
  assert.ok(!fs.existsSync(path.join(outside, 'new')));
});

test('grant는 Windows에서 대소문자가 다른 정션 이름도 같은 링크로 본다', { skip: !isWindows }, () => {
  const { outside, target } = accessFixture();
  linkDir(outside, path.join(target, 'escape'));
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.write('ESCAPE/secret.txt'), /링크를 거쳐/);
  assert.throws(() => access.delete('ESCAPE'), /링크는 삭제할 수 없습니다/);
});

test('grant는 Windows에서 해석이 갈리는 이름을 세 작업 모두 거부하고 아무것도 바꾸지 않는다', { skip: !isWindows }, () => {
  const { root, outside, target } = accessFixture();
  linkDir(outside, path.join(target, 'escape'));
  const access = grant(target, ALL_ACCESS);
  const before = listing(root);
  const names = [
    // PowerShell·tar.exe는 끝의 점과 공백을 지워 정션이나 타겟 밖으로 풀어낸다.
    'escape.', 'escape ', 'escape./new.txt', 'escape /new.txt', '. ', '.. ', '.. /outside', 'sub/.. ', 'sub./a.txt',
    // 스트림과 장치 이름
    'sub/a.txt:hidden', 'sub/a.txt::$DATA', 'NUL', 'nul.txt', 'sub/COM1', 'LPT9.log', 'CONIN$',
  ];
  for (const kind of ALL_ACCESS) {
    for (const p of names) assert.throws(() => access[kind](p), /다르게 해석될 수 있는 이름/, `${kind} ${p}`);
  }
  assert.deepStrictEqual(listing(root), before);
});

test('grant는 점이 들어간 평범한 이름과 장치 이름으로 시작할 뿐인 이름을 허용한다', { skip: !isWindows }, () => {
  const { target } = accessFixture();
  const access = grant(target, ['write']);
  for (const name of ['.hidden', 'a.b.c.txt', '..foo', 'console.txt', 'nullable', 'com10.txt', 'printer', 'a b.txt']) {
    assert.strictEqual(access.write(name), path.join(target, name));
  }
});

test('grant는 타겟 경로 자체의 이름은 Windows 이름 규칙으로 따지지 않는다', { skip: !isWindows }, () => {
  const { root } = accessFixture();
  fs.mkdirSync(path.join(root, 'aux.d'));
  const access = grant(path.join(root, 'aux.d'), ['write']);
  assert.strictEqual(access.write('a.txt'), path.join(root, 'aux.d', 'a.txt'));
});

test('grant는 끊어진 링크로 쓰지 않는다', () => {
  const { root, target } = accessFixture();
  const gone = path.join(root, 'gone');
  fs.mkdirSync(gone);
  linkDir(gone, path.join(target, 'dangling'));
  fs.rmdirSync(gone);
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.write('dangling'), /끊어진 링크/);
  assert.throws(() => access.write('dangling/new.txt'), /끊어진 링크/);
  assert.throws(() => access.read('dangling'), /끊어진 링크/);
  assert.throws(() => access.delete('dangling'), /링크는 삭제할 수 없습니다/);
  assert.ok(!fs.existsSync(gone));
});

test('grant.read와 write는 타겟 안을 가리키는 링크를 풀어낸 실제 경로를 돌려준다', () => {
  const { target } = accessFixture();
  linkDir(path.join(target, 'sub'), path.join(target, 'alias'));
  const access = grant(target, ALL_ACCESS);
  assert.strictEqual(access.read('alias/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.strictEqual(access.write('alias/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.strictEqual(access.write('alias/new/deep.txt'), path.join(target, 'sub', 'new', 'deep.txt'));
  assert.strictEqual(access.delete('alias/a.txt'), path.join(target, 'sub', 'a.txt'));
});

test('grant.read는 폴더와 타겟 자신을 허용하고, 없는 경로는 거부한다', () => {
  const { target } = accessFixture();
  const access = grant(target, ALL_ACCESS);
  assert.strictEqual(access.read('sub'), path.join(target, 'sub'));
  assert.strictEqual(access.read('.'), target);
  assert.throws(() => access.read('nope.txt'), /경로가 없거나/);
});

test('grant.write는 아직 없는 경로를 허용하되 폴더를 미리 만들지 않는다', () => {
  const { target } = accessFixture();
  const access = grant(target, ALL_ACCESS);
  assert.strictEqual(access.write('new.txt'), path.join(target, 'new.txt'));
  assert.strictEqual(access.write('a/b/c.txt'), path.join(target, 'a', 'b', 'c.txt'));
  assert.strictEqual(access.write('sub/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.ok(!fs.existsSync(path.join(target, 'a')));
  assert.ok(!fs.existsSync(path.join(target, 'new.txt')));
});

test('grant.write는 타겟 자신과 파일 아래 경로를 거부한다', () => {
  const { target } = accessFixture();
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.write('.'), /타겟 폴더 자체/);
  assert.throws(() => access.write('sub/..'), /타겟 폴더 자체/);
  assert.throws(() => access.write('sub/a.txt/x.txt'), /파일 아래/);
  assert.throws(() => access.write('sub/a.txt/x/y.txt'), /파일 아래/);
});

test('grant.write는 Windows에서 대소문자가 다른 타겟 경로도 안으로 본다', { skip: !isWindows }, () => {
  const { target } = accessFixture();
  const access = grant(target, ['write']);
  assert.strictEqual(access.write(path.join(target.toUpperCase(), 'new.txt')), path.join(target, 'new.txt'));
});

test('grant.delete는 타겟 자신과 없는 경로를 거부한다', () => {
  const { target } = accessFixture();
  const access = grant(target, ['delete']);
  assert.throws(() => access.delete('.'), /타겟 폴더 자체/);
  assert.throws(() => access.delete(''), /타겟 폴더 자체/);
  assert.throws(() => access.delete('sub/..'), /타겟 폴더 자체/);
  assert.throws(() => access.delete('nope.txt'), /경로가 없거나/);
});

test('grant.delete는 일반 파일·폴더를 허용하고 링크와 링크가 든 폴더는 거부한다', () => {
  const { outside, target } = accessFixture();
  fs.mkdirSync(path.join(target, 'plain', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(target, 'holder', 'deep'), { recursive: true });
  linkDir(outside, path.join(target, 'holder', 'deep', 'escape'));
  linkDir(path.join(target, 'sub'), path.join(target, 'alias'));
  const access = grant(target, ['delete']);
  assert.strictEqual(access.delete('sub/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.strictEqual(access.delete('plain'), path.join(target, 'plain'));
  assert.throws(() => access.delete('alias'), /링크는 삭제할 수 없습니다/);
  assert.throws(() => access.delete('holder'), /링크가 든 폴더/);
  assert.throws(() => access.delete('holder/deep'), /링크가 든 폴더/);
});

test('grant.delete는 폴더 안을 다 읽지 못하면 거부한다', (t) => {
  const { target } = accessFixture();
  const access = grant(target, ['delete']);
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  assert.throws(() => access.delete('sub'), (err) => err instanceof FcError && err.message.includes('EPERM'));
});

test('grant는 예상 못 한 파일 시스템 오류와 잘못된 경로 값도 FcError로 낸다', (t) => {
  const { target } = accessFixture();
  const access = grant(target, ALL_ACCESS);
  for (const kind of ALL_ACCESS) {
    assert.throws(() => access[kind](undefined), FcError, `${kind} undefined`);
    assert.throws(() => access[kind](Symbol('x')), FcError, `${kind} Symbol`);
    assert.throws(() => access[kind]('bad\0name'), FcError, `${kind} NUL`);
  }
  t.mock.method(fs.realpathSync, 'native', () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  assert.throws(() => access.read('sub/a.txt'), (err) => err instanceof FcError && err.message.includes('EACCES'));
});

test('grant와 readInside는 대소문자 무시로만 같아 보이는 타겟 밖 형제 폴더를 정션으로 읽지 못하게 한다', () => {
  const root = tempDir();
  const target = path.join(root, 'work');
  // U+212A(켈빈 기호)는 toLowerCase하면 k지만 NTFS에서는 다른 이름이다.
  const sibling = path.join(root, 'wor\u212A');
  fs.mkdirSync(target);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SECRET');
  linkDir(sibling, path.join(target, 'esc'));
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.read('esc/secret.txt'), /링크를 거쳐/);
  assert.throws(() => access.write('esc/new.txt'), /링크를 거쳐/);
  assert.throws(() => access.delete('esc/secret.txt'), /링크를 거쳐/);
  assert.throws(() => readInside(target, 'esc/secret.txt'), /링크를 거쳐/);
  assert.throws(() => readRange(target, 'esc/secret.txt', { length: 1 }), /링크를 거쳐/);
});

test('grant는 대소문자 무시로만 같아 보이는 형제 폴더의 절대경로를 타겟 안 파일로 바꾸지 않는다', () => {
  const root = tempDir();
  const target = path.join(root, 'work');
  const sibling = path.join(root, 'worK');
  fs.mkdirSync(target);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(target, 'a.txt'), 'target');
  fs.writeFileSync(path.join(sibling, 'a.txt'), 'sibling');
  const access = grant(target, ALL_ACCESS);
  for (const kind of ALL_ACCESS) {
    assert.throws(() => access[kind](path.join(sibling, 'a.txt')), /타겟 폴더 밖/, kind);
    assert.throws(() => access[kind](sibling), /타겟 폴더 밖/, kind);
  }
});

test('resolveTarget·grant·walk는 타겟 경로의 NUL 문자를 FcError로 거부한다', () => {
  for (const check of [resolveTarget, walk, (dir) => grant(dir, ['read'])]) {
    assert.throws(() => check('a\0b'), FcError);
  }
});

test('resolveTarget은 Windows에서 끝이 U+00A0·U+0085인 폴더도 거부한다', { skip: !isWindows }, (t) => {
  useHome(t, path.join(tempDir(), 'kim'));
  for (const end of [' ', '\u0085']) {
    fs.mkdirSync(path.join(home, `AppData${end}`), { recursive: true });
    assert.throws(() => resolveTarget(path.join(home, `AppData${end}`)), /끝이 점이나 공백/);
  }
});

test('grant.read·write는 두 단계 아래에 링크가 든 폴더도 거부한다', () => {
  const { outside, target } = accessFixture();
  fs.mkdirSync(path.join(target, 'deep', 'er'), { recursive: true });
  linkDir(outside, path.join(target, 'deep', 'er', 'escape'));
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.read('deep'), /링크가 든 폴더/);
  assert.throws(() => access.write('deep'), /링크가 든 폴더/);
});

test('grant는 Windows에서 드라이브 문자 표기가 달라도 타겟 안을 밖으로 잘못 보지 않는다', { skip: !isWindows }, () => {
  const { target } = accessFixture();
  const lower = target[0].toLowerCase() + target.slice(1);
  const upper = target[0].toUpperCase() + target.slice(1);
  for (const dir of [lower, upper]) {
    const access = grant(dir, ALL_ACCESS);
    assert.strictEqual(access.read('sub/a.txt'), path.join(target, 'sub', 'a.txt'));
    assert.strictEqual(access.read(path.join(lower, 'sub', 'a.txt')), path.join(target, 'sub', 'a.txt'));
    assert.strictEqual(access.write(path.join(upper, 'new.txt')), path.join(target, 'new.txt'));
  }
});

test('grant.read·write는 링크가 든 폴더를 거부하고, 링크 옆의 파일과 새 경로는 허용한다', () => {
  const { outside, target } = accessFixture();
  linkDir(outside, path.join(target, 'sub', 'escape'));
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.read('sub'), /링크가 든 폴더/);
  assert.throws(() => access.read('.'), /링크가 든 폴더/);
  assert.throws(() => access.write('sub'), /링크가 든 폴더/);
  assert.strictEqual(access.read('sub/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.strictEqual(access.write('sub/a.txt'), path.join(target, 'sub', 'a.txt'));
  assert.strictEqual(access.write('sub/new.txt'), path.join(target, 'sub', 'new.txt'));
});

test('grant는 정션을 풀어낸 실제 경로에 해석이 갈리는 이름이 있으면 거부한다', { skip: !isWindows }, () => {
  const { outside, target } = accessFixture();
  // Node는 끝의 점을 그대로 만들지만, 돌려준 경로를 PowerShell·tar.exe에 넘기면 타겟 밖 정션 weird로 풀린다.
  fs.mkdirSync(path.join(target, 'weird.'));
  fs.writeFileSync(path.join(target, 'weird.', 'decoy.txt'), 'decoy');
  linkDir(outside, path.join(target, 'weird'));
  linkDir(path.join(target, 'weird.'), path.join(target, 'alias'));
  const access = grant(target, ALL_ACCESS);
  for (const kind of ALL_ACCESS) {
    assert.throws(() => access[kind]('alias/decoy.txt'), /다르게 해석될 수 있는 이름/, kind);
  }
  assert.throws(() => access.write('alias/new.txt'), /다르게 해석될 수 있는 이름/);
});

test('resolveTarget은 Windows에서 끝이 점·공백인 폴더를 타겟으로 받지 않아 보호 경로 우회를 막는다', { skip: !isWindows }, (t) => {
  const root = tempDir();
  useHome(t, path.join(root, 'kim'));
  for (const dir of ['AppData', 'AppData.', 'Downloads/proj./inner', 'plain']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  assert.throws(() => grant(path.join(home, 'AppData.'), ALL_ACCESS), /끝이 점이나 공백/);
  assert.throws(() => resolveTarget(path.join(home, 'AppData.')), /끝이 점이나 공백/);
  assert.throws(() => walk(path.join(home, 'Downloads', 'proj.')), /끝이 점이나 공백/);
  assert.throws(() => resolveTarget(path.join(home, 'Downloads', 'proj.', 'inner')), /끝이 점이나 공백/);
  // 정션으로 감싸도 실제 경로 기준으로 거부한다.
  linkDir(path.join(home, 'AppData.'), path.join(home, 'plain', 'wrapped'));
  assert.throws(() => resolveTarget(path.join(home, 'plain', 'wrapped')), /끝이 점이나 공백/);
  fs.mkdirSync(path.join(home, 'clean'));
  assert.strictEqual(resolveTarget(path.join(home, 'clean')), path.join(home, 'clean'));
});

test('grant는 Windows 도구가 지우는 다른 공백 문자로 끝나는 이름도 거부한다', { skip: !isWindows }, () => {
  const { target } = accessFixture();
  fs.writeFileSync(path.join(target, 'keep.txt'), 'KEEP');
  for (const end of ['\u00a0', '\u0085']) {
    fs.writeFileSync(path.join(target, `keep.txt${end}`), 'other');
  }
  const access = grant(target, ALL_ACCESS);
  for (const kind of ALL_ACCESS) {
    assert.throws(() => access[kind]('keep.txt\u00a0'), /다르게 해석될 수 있는 이름/, kind);
    assert.throws(() => access[kind]('keep.txt\u0085'), /다르게 해석될 수 있는 이름/, kind);
  }
});

test('grant는 Windows에서 쓸 수 없는 문자와 변형 장치 이름을 거부한다', { skip: !isWindows }, () => {
  const { target } = accessFixture();
  const access = grant(target, ['write']);
  for (const p of ['es*/new.txt', 'es?ape/new.txt', 'a*.zip', 'a|b', 'a<b', 'a>b', 'a"b', 'a\x01b', 'NUL .txt', 'CON .log', 'COM¹', 'LPT³', 'com¹.txt', 'aux .x']) {
    assert.throws(() => access.write(p), /다르게 해석될 수 있는 이름/, p);
  }
});

test('grant는 파일 심볼릭 링크도 타겟 밖이면 거부하고 링크 자체는 지우지 않는다', (t) => {
  const { outside, target } = accessFixture();
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(target, 'file-link'), 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('심볼릭 링크를 만들 권한이 없다');
    throw err;
  }
  const access = grant(target, ALL_ACCESS);
  assert.throws(() => access.read('file-link'), /링크를 거쳐/);
  assert.throws(() => access.write('file-link'), /링크를 거쳐/);
  assert.throws(() => access.delete('file-link'), /링크는 삭제할 수 없습니다/);
});
