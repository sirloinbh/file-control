'use strict';

// 기본 명령의 장치 이름 처리(#135). 측정은 Windows 11 빌드 26200에서 했다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const fc = require('../src/commands');
const { BARE_DEVICE_NAME, deviceNamePart } = require('../src/windowsNames');

const isWindows = process.platform === 'win32';
// 장치 이름 파일은 \\?\ 경로로만 만들 수 있다. Node의 일반 경로도 글자 그대로 쓰지만 만드는 쪽은 확실하게 한다.
const literal = (p) => (isWindows ? `\\\\?\\${p}` : p);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dev-'));
  test.after(() => fs.rmSync(literal(dir), { recursive: true, force: true }));
  return dir;
}

const listing = (dir) => fs.readdirSync(literal(dir), { recursive: true }).sort();

test('장치 이름 그대로인 이름은 끝의 점·공백까지 맞추고, COM0·LPT0과 확장자가 붙은 이름은 맞추지 않는다 (#135)', () => {
  for (const name of ['nul', 'NUL', 'CON', 'Prn', 'aux', 'Com1', 'LPT9', 'lpt¹', 'COM²', 'conin$', 'CONOUT$', 'nul.', 'com1 ', 'CON. ']) {
    assert.ok(BARE_DEVICE_NAME.test(name), name);
  }
  for (const name of ['COM0', 'LPT0', 'nul.txt', 'Con.Air', 'console', 'com10', 'nul-1', 'xnul', 'conin$.txt']) {
    assert.ok(!BARE_DEVICE_NAME.test(name), name);
  }
});

test('deviceNamePart는 드라이브 뿌리를 빼고 경로의 모든 이름을 본다 (#135)', { skip: !isWindows }, () => {
  assert.strictEqual(deviceNamePart('C:\\a\\nul\\b.txt', BARE_DEVICE_NAME), 'nul');
  assert.strictEqual(deviceNamePart('C:\\a\\b\\Nul.mp4'), 'Nul.mp4');
  assert.strictEqual(deviceNamePart('C:\\a\\Con.Air.1997.mkv', BARE_DEVICE_NAME), undefined);
  assert.strictEqual(deviceNamePart('\\\\server\\share\\x.txt', BARE_DEVICE_NAME), undefined);
});

test('write·mkdir·rename·mv·cp·zip·unzip은 장치로 열리는 이름을 새로 만들지 않고 아무것도 바꾸지 않는다 (#135)', { skip: !isWindows }, () => {
  const dir = tempDir();
  const src = path.join(dir, 'src.txt');
  fs.writeFileSync(src, 'S');
  fs.mkdirSync(path.join(dir, 'box'));
  fc.zip(path.join(dir, 'ok.zip'), [src]);
  const before = listing(dir);
  // 어느 빌드의 규칙에서나 장치 이름이다. 끝의 점·공백은 Windows가 지우므로 같은 장치다.
  for (const name of ['Nul.mp4', 'con.txt', 'nul', 'AUX/a.txt', 'Com1.zip', 'com1 ', 'nul ', 'Nul.mp4.', 'con.txt .', 'CON .', 'lpt¹/a.txt']) {
    const p = path.join(dir, name);
    const attempts = {
      write: () => fc.writeFile(p, 'x'),
      writeDry: () => fc.writeFile(p, 'x', { dryRun: true }),
      append: () => fc.writeFile(p, 'x', { append: true }),
      mkdir: () => fc.makeDir(p),
      // rename은 같은 폴더 안의 이름만 받으므로 폴더가 든 경우는 mv로 본다.
      rename: () => (name.includes('/') ? fc.move([src], p) : fc.rename(src, name)),
      mv: () => fc.move([src], p),
      cp: () => fc.copy([src], p),
      cpDry: () => fc.copy([src], p, { dryRun: true }),
      zip: () => fc.zip(p, [src]),
      unzip: () => fc.unzip(path.join(dir, 'ok.zip'), p),
    };
    for (const [kind, attempt] of Object.entries(attempts)) {
      assert.throws(attempt, /Windows가 장치로 여는 이름이라 만들지 않습니다/, `${kind} ${name}`);
    }
  }
  // 폴더 안으로 옮기거나 복사해도 새 이름이 장치 이름이면 거부한다.
  fs.writeFileSync(literal(path.join(dir, 'Nul.mp4')), 'N');
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([path.join(dir, 'Nul.mp4')], path.join(dir, 'box'), { dryRun }), /장치로 여는 이름/, `cp dryRun=${dryRun}`);
    assert.throws(() => fc.move([path.join(dir, 'Nul.mp4')], path.join(dir, 'box'), { dryRun }), /장치로 여는 이름/, `mv dryRun=${dryRun}`);
  }
  assert.deepStrictEqual(listing(dir), [...before, 'Nul.mp4'].sort());
});

test('이미 있는 장치 이름 폴더 안에는 평범한 이름을 만들 수 있다 (#135)', { skip: !isWindows }, () => {
  const dir = tempDir();
  const folder = path.join(dir, 'Con.Air');
  fs.mkdirSync(literal(folder));
  fs.writeFileSync(path.join(dir, 'src.txt'), 'S');
  fc.zip(path.join(dir, 'ok.zip'), [path.join(dir, 'src.txt')]);
  fc.writeFile(path.join(folder, 'notes.txt'), 'N');
  fc.makeDir(path.join(folder, 'sub', 'deeper'));
  fc.copy([path.join(dir, 'src.txt')], path.join(folder, 'copy.txt'));
  fc.unzip(path.join(dir, 'ok.zip'), path.join(folder, 'out'));
  assert.strictEqual(fc.readFile(path.join(folder, 'out', 'src.txt')), 'S');
  // 그 안에 새로 만드는 이름이 장치 이름이면 거부한다.
  assert.throws(() => fc.writeFile(path.join(folder, 'nul.txt'), 'x'), /장치로 여는 이름이라 만들지 않습니다: "nul.txt"/);
  assert.throws(() => fc.makeDir(path.join(folder, 'new', 'CON', 'x')), /장치로 여는 이름이라 만들지 않습니다: "CON"/);
});

test('이미 있는 장치 이름 파일은 읽고, 덮어쓰고, 평범한 이름으로 바꾸거나 옮길 수 있다 (#135)', { skip: !isWindows }, () => {
  const dir = tempDir();
  fs.writeFileSync(literal(path.join(dir, 'Nul.mp4')), 'N');
  fs.writeFileSync(literal(path.join(dir, 'con.txt')), 'C');
  assert.strictEqual(fc.readFile(path.join(dir, 'Nul.mp4')), 'N');
  fc.writeFile(path.join(dir, 'Nul.mp4'), 'N2', { force: true });
  fc.writeFile(path.join(dir, 'Nul.mp4'), '+', { append: true });
  fc.rename(path.join(dir, 'Nul.mp4'), 'Null.mp4');
  fc.move([path.join(dir, 'con.txt')], path.join(dir, 'console.txt'));
  assert.deepStrictEqual(listing(dir), ['Null.mp4', 'console.txt']);
  assert.strictEqual(fc.readFile(path.join(dir, 'Null.mp4')), 'N2+');
});

test('zip은 장치 이름 그대로인 원본을 tar.exe에 넘기기 전에 거부하고 압축 파일을 남기지 않는다 (#135)', { skip: !isWindows }, () => {
  const dir = tempDir();
  for (const name of ['nul', 'CON']) fs.writeFileSync(literal(path.join(dir, name)), name);
  fs.mkdirSync(literal(path.join(dir, 'aux')));
  fs.writeFileSync(path.join(dir, 'aux', 'a.txt'), 'A');
  const before = listing(dir);
  for (const src of ['nul', 'CON', path.join('aux', 'a.txt')]) {
    assert.throws(() => fc.zip(path.join(dir, 'out.zip'), [path.join(dir, src)]), /tar\.exe가 장치로 열어 다룰 수 없습니다/, src);
    assert.throws(() => fc.zip(path.join(dir, 'out.zip'), [path.join(dir, src)], { dryRun: true }), /tar\.exe가 장치로 열어/, src);
  }
  assert.deepStrictEqual(listing(dir), before);
});

test('압축 목록 읽기는 장치 이름 그대로인 압축 파일 경로를 tar.exe에 넘기지 않는다 (#135)', { skip: !isWindows }, () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  fc.zip(path.join(dir, 'a.zip'), [path.join(dir, 'a.txt')]);
  fs.renameSync(path.join(dir, 'a.zip'), literal(path.join(dir, 'nul')));
  const archive = path.join(dir, 'nul');
  assert.throws(() => fc.archiveEntries(archive), /tar\.exe가 장치로 열어/);
  assert.throws(() => fc.archiveNames(archive), /tar\.exe가 장치로 열어/);
  assert.throws(() => fc.probeArchive(archive, { maxBuffer: 1024 * 1024, timeout: 60 * 1000 }), /tar\.exe가 장치로 열어/);
  assert.throws(() => fc.unzip(archive, path.join(dir, 'out')), /tar\.exe가 장치로 열어/);
  assert.deepStrictEqual(listing(dir), ['a.txt', 'nul']);
});

test('zip·unzip은 폴더 안의 장치 이름 파일을 같은 내용으로 묶고 푼다 (#135)', { skip: !isWindows }, () => {
  const dir = tempDir();
  const names = ['nul', 'CON', 'Nul.mp4', 'con.txt', 'ok.txt'];
  fs.mkdirSync(path.join(dir, 'pack'));
  names.forEach((name) => fs.writeFileSync(literal(path.join(dir, 'pack', name)), `data-${name}`));
  fc.zip(path.join(dir, 'pack.zip'), [path.join(dir, 'pack')]);
  fc.unzip(path.join(dir, 'pack.zip'), path.join(dir, 'out'));
  assert.deepStrictEqual(fs.readdirSync(literal(path.join(dir, 'out', 'pack'))).sort(), [...names].sort());
  for (const name of names) assert.strictEqual(fs.readFileSync(literal(path.join(dir, 'out', 'pack', name)), 'utf8'), `data-${name}`, name);
});

test('rm은 장치 이름 그대로인 경로를 PowerShell을 부르기 전에 거부하고, --permanent는 지운다 (#135)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  fs.writeFileSync(literal(path.join(dir, 'nul')), 'x');
  fs.mkdirSync(literal(path.join(dir, 'CON')));
  // CON·nul·Com1 폴더 안의 파일도 휴지통 이동이 실패한다(빌드 26200). Nul.mp4 폴더 안은 성공했다.
  fs.writeFileSync(path.join(dir, 'CON', 'a.txt'), 'A');
  const calls = t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('PowerShell을 부르면 안 된다');
  });
  const fresh = reload();
  for (const target of ['nul', 'CON', path.join('CON', 'a.txt')]) {
    assert.throws(() => fresh.remove([path.join(dir, target)]), /장치 이름\("(nul|CON)"\)이 든 경로는 휴지통으로 보낼 수 없습니다/, target);
    assert.throws(() => fresh.remove([path.join(dir, target)], { dryRun: true }), /휴지통으로 보낼 수 없습니다/, target);
  }
  assert.strictEqual(calls.mock.callCount(), 0);
  fresh.remove([path.join(dir, 'nul')], { permanent: true });
  assert.deepStrictEqual(listing(dir), ['CON', path.join('CON', 'a.txt')]);
});

test('rm은 폴더 안의 장치 이름 항목 때문에 휴지통 이동이 실패하면 그 항목을 알린다 (#135)', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box', 'sub'), { recursive: true });
  fs.writeFileSync(literal(path.join(dir, 'box', 'sub', 'nul')), 'x');
  fs.writeFileSync(path.join(dir, 'plain.txt'), 'p');
  t.mock.method(childProcess, 'execFileSync', () => {
    const err = new Error('DeleteDirectory failed');
    err.status = 1;
    throw err;
  });
  const fresh = reload();
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), (err) => err instanceof fresh.FcError && err.message.includes(`안에 장치 이름 항목(${path.join('sub', 'nul')})이 있어 실패했을 수 있습니다`));
  // 장치 이름이 없으면 원래 오류를 그대로 낸다.
  assert.throws(() => fresh.remove([path.join(dir, 'plain.txt')]), (err) => !(err instanceof fresh.FcError) && err.status === 1);
});

// execFileSync를 바꾼 뒤 그것을 쓰는 commands.js를 새로 읽는다. 다른 테스트가 쓰는 모듈은 그대로 둔다.
function reload() {
  const id = require.resolve('../src/commands');
  const saved = require.cache[id];
  delete require.cache[id];
  const fresh = require('../src/commands');
  require.cache[id] = saved;
  return fresh;
}
