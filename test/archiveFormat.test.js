'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const fc = require('../src/commands');
const { extractArchives } = require('../src/extract');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-format-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

const SECRET = 'FAKE-SECRET-XYZ';

// tar.exe picks the format by content, not by extension, so it reads this text as mtree.
// The file at the contents= path is read only when mtree:checkfs is turned on. fctl does not pass this option.
function mtree(secret, { signature = true } = {}) {
  const line = `leak.txt type=file mode=0644 size=${SECRET.length} contents=${secret.replaceAll('\\', '/')}\n`;
  return Buffer.from(signature ? `#mtree\n${line}` : line);
}

const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

// It checks whether this tar.exe really copies when it reads the text as mtree and checkfs is turned on. Otherwise the test below proves nothing.
function fixtureCopiesWithCheckfs(archive) {
  const out = tempDir();
  spawnSync(TAR, ['-xf', archive, '-C', out, '--options', 'mtree:checkfs'], { stdio: 'ignore' });
  const leak = path.join(out, 'leak.txt');
  return fs.existsSync(leak) && fs.readFileSync(leak, 'utf8') === SECRET;
}

function assertLeakHasNoSecret(file) {
  assert.ok(fs.existsSync(file), `풀리지 않았습니다: ${file}`);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), file);
}

for (const [label, make] of [
  ['서명이 있는 mtree', (secret) => mtree(secret)],
  ['서명이 없는 mtree', (secret) => mtree(secret, { signature: false })],
  ['gzip으로 감싼 mtree', (secret) => zlib.gzipSync(mtree(secret))],
]) {
  test(`${label}를 풀어도 contents= 파일의 내용이 복사되지 않는다`, (t) => {
    const outside = tempDir();
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, SECRET);
    for (const name of ['x.7z', 'x.zip', 'x.tar.gz']) {
      const dir = tempDir();
      const archive = path.join(dir, name);
      fs.writeFileSync(archive, make(secret));
      if (!fixtureCopiesWithCheckfs(archive)) return t.skip(`이 tar.exe는 ${name}을 mtree로 읽어 복사하지 않아 시험할 수 없다`);
      fc.unzip(archive, path.join(dir, 'out'));
      assertLeakHasNoSecret(path.join(dir, 'out', 'leak.txt'));
      fs.rmSync(path.join(dir, 'out'), { recursive: true });
      const result = extractArchives(dir);
      assert.deepStrictEqual(result.failed, []);
      assertLeakHasNoSecret(path.join(result.extracted[0].dest, 'leak.txt'));
      assert.strictEqual(fs.readFileSync(secret, 'utf8'), SECRET);
    }
  });
}

// tar.exe options can be turned on with environment variables. fctl does not pass these variables on to tar.exe (#87).
function withEnv(t, name, value) {
  const saved = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

test('TAR_READER_OPTIONS=mtree:checkfs가 설정돼도 contents= 파일의 내용이 복사되지 않는다', (t) => {
  const outside = tempDir();
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, SECRET);
  const dir = tempDir();
  const archive = path.join(dir, 'x.zip');
  fs.writeFileSync(archive, mtree(secret));
  // A lowercase name is also the same variable on Windows.
  withEnv(t, process.platform === 'win32' ? 'tar_reader_options' : 'TAR_READER_OPTIONS', 'mtree:checkfs');
  // It first checks whether this tar.exe really reads the variable. If it does not, the test below proves nothing.
  const probe = tempDir();
  spawnSync(TAR, ['-xf', archive, '-C', probe], { stdio: 'ignore' });
  const probed = path.join(probe, 'leak.txt');
  if (!(fs.existsSync(probed) && fs.readFileSync(probed, 'utf8') === SECRET)) return t.skip('이 tar.exe는 TAR_READER_OPTIONS로 복사하지 않아 시험할 수 없다');
  fc.unzip(archive, path.join(dir, 'out'));
  assertLeakHasNoSecret(path.join(dir, 'out', 'leak.txt'));
  fs.rmSync(path.join(dir, 'out'), { recursive: true });
  const result = extractArchives(dir);
  assert.deepStrictEqual(result.failed, []);
  assertLeakHasNoSecret(path.join(result.extracted[0].dest, 'leak.txt'));
});

test('TAR_WRITER_OPTIONS가 설정돼도 zip은 기본 옵션으로 묶는다', (t) => {
  const dir = tempDir();
  const src = path.join(dir, 'a.txt');
  fs.writeFileSync(src, 'A'.repeat(100000));
  withEnv(t, 'TAR_WRITER_OPTIONS', 'zip:compression=store');
  const probe = path.join(dir, 'probe.zip');
  spawnSync(TAR, ['-a', '-cf', probe, '-C', dir, 'a.txt'], { stdio: 'ignore' });
  if (!(fs.existsSync(probe) && fs.statSync(probe).size > 100000)) return t.skip('이 tar.exe는 TAR_WRITER_OPTIONS를 읽지 않아 시험할 수 없다');
  fc.zip(path.join(dir, 'o.zip'), [src]);
  assert.ok(fs.statSync(path.join(dir, 'o.zip')).size < 10000, '기본 압축(deflate)으로 묶여야 한다');
});
