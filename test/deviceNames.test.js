'use strict';

// Device name handling of the basic commands (#135). The measurements were taken on Windows 11 build 26200.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const fc = require('../src/commands');
const { BARE_DEVICE_NAME, deviceNamePart } = require('../src/windowsNames');

const isWindows = process.platform === 'win32';
// A device-name file can be created only with a \\?\ path. Node's ordinary path also uses it literally, but the side that creates it makes sure.
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
  // It is a device name under the rules of any build. A trailing dot and space are removed by Windows, so it is the same device.
  for (const name of ['Nul.mp4', 'con.txt', 'nul', 'AUX/a.txt', 'Com1.zip', 'com1 ', 'nul ', 'Nul.mp4.', 'con.txt .', 'CON .', 'lpt¹/a.txt']) {
    const p = path.join(dir, name);
    const attempts = {
      write: () => fc.writeFile(p, 'x'),
      writeDry: () => fc.writeFile(p, 'x', { dryRun: true }),
      append: () => fc.writeFile(p, 'x', { append: true }),
      mkdir: () => fc.makeDir(p),
      // rename accepts only names within the same folder, so the folder-contained case is looked at with mv.
      rename: () => (name.includes('/') ? fc.move([src], p) : fc.rename(src, name)),
      mv: () => fc.move([src], p),
      cp: () => fc.copy([src], p),
      cpDry: () => fc.copy([src], p, { dryRun: true }),
      zip: () => fc.zip(p, [src]),
      unzip: () => fc.unzip(path.join(dir, 'ok.zip'), p),
    };
    for (const [kind, attempt] of Object.entries(attempts)) {
      assert.throws(attempt, /Not created because Windows opens this name as a device/, `${kind} ${name}`);
    }
  }
  // Even when moving or copying into a folder, if the new name is a device name, it refuses.
  fs.writeFileSync(literal(path.join(dir, 'Nul.mp4')), 'N');
  // If a stream is attached, a file is created with the name before :. mv refuses first by the stream path check.
  for (const name of ['nul:x', 'CON:s', 'aux.txt:x']) {
    const p = path.join(dir, name);
    for (const attempt of [() => fc.writeFile(p, 'x'), () => fc.makeDir(p), () => fc.rename(src, name), () => fc.copy([src], p), () => fc.move([src], p), () => fc.zip(p, [src])]) {
      assert.throws(attempt, /opens this name as a device|streams/, name);
    }
  }
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([path.join(dir, 'Nul.mp4')], path.join(dir, 'box'), { dryRun }), /opens this name as a device/, `cp dryRun=${dryRun}`);
    assert.throws(() => fc.move([path.join(dir, 'Nul.mp4')], path.join(dir, 'box'), { dryRun }), /opens this name as a device/, `mv dryRun=${dryRun}`);
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
  // If a name newly created inside it is a device name, it refuses.
  assert.throws(() => fc.writeFile(path.join(folder, 'nul.txt'), 'x'), /Not created because Windows opens this name as a device: "nul.txt"/);
  assert.throws(() => fc.makeDir(path.join(folder, 'new', 'CON', 'x')), /Not created because Windows opens this name as a device: "CON"/);
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
    assert.throws(() => fc.zip(path.join(dir, 'out.zip'), [path.join(dir, src)]), /would be opened as a device by tar\.exe and cannot be handled/, src);
    assert.throws(() => fc.zip(path.join(dir, 'out.zip'), [path.join(dir, src)], { dryRun: true }), /opened as a device by tar\.exe/, src);
  }
  assert.deepStrictEqual(listing(dir), before);
});

test('압축 목록 읽기는 장치 이름 그대로인 압축 파일 경로를 tar.exe에 넘기지 않는다 (#135)', { skip: !isWindows }, () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  fc.zip(path.join(dir, 'a.zip'), [path.join(dir, 'a.txt')]);
  fs.renameSync(path.join(dir, 'a.zip'), literal(path.join(dir, 'nul')));
  const archive = path.join(dir, 'nul');
  assert.throws(() => fc.archiveEntries(archive), /opened as a device by tar\.exe/);
  assert.throws(() => fc.archiveNames(archive), /opened as a device by tar\.exe/);
  assert.throws(() => fc.probeArchive(archive, { maxBuffer: 1024 * 1024, timeout: 60 * 1000 }), /opened as a device by tar\.exe/);
  assert.throws(() => fc.unzip(archive, path.join(dir, 'out')), /opened as a device by tar\.exe/);
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
  // A file inside a CON, nul, or Com1 folder also fails the Recycle Bin move (build 26200). Inside a Nul.mp4 folder it succeeded.
  fs.writeFileSync(path.join(dir, 'CON', 'a.txt'), 'A');
  const calls = t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('PowerShell을 부르면 안 된다');
  });
  const fresh = reload();
  for (const target of ['nul', 'CON', path.join('CON', 'a.txt')]) {
    assert.throws(() => fresh.remove([path.join(dir, target)]), /A path containing the device name \("(nul|CON)"\) cannot be sent to the Recycle Bin/, target);
    assert.throws(() => fresh.remove([path.join(dir, target)], { dryRun: true }), /cannot be sent to the Recycle Bin/, target);
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
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    // The volume setting check before deleting (#81) answers as a fixed disk.
    if (options?.env?.FC_VOLUME !== undefined) return 'True|Fixed||\r\n';
    const err = new Error('DeleteDirectory failed');
    err.status = 1;
    throw err;
  });
  const fresh = reload();
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), (err) => err instanceof fresh.FcError && err.message.includes(`It may have failed because of an item with a device name inside (${path.join('sub', 'nul')})`));
  // If there is no device name, it raises the original error as it is.
  assert.throws(() => fresh.remove([path.join(dir, 'plain.txt')]), (err) => !(err instanceof fresh.FcError) && err.status === 1);
});

// After swapping execFileSync, it reads commands.js, which uses it, anew. Modules other tests use are left as they are.
function reload() {
  const id = require.resolve('../src/commands');
  const saved = require.cache[id];
  delete require.cache[id];
  const fresh = require('../src/commands');
  require.cache[id] = saved;
  return fresh;
}
