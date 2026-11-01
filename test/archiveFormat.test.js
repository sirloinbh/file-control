'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const fc = require('../src/commands');
const { extractArchives } = require('../src/extract');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-format-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

const SECRET = 'FAKE-SECRET-XYZ';

// tar.exe는 확장자가 아니라 내용으로 형식을 고르므로 이 글을 mtree로 읽는다.
// contents= 경로의 파일은 mtree:checkfs를 켰을 때만 읽는다. fctl은 이 옵션을 넘기지 않는다.
function mtree(secret, { signature = true } = {}) {
  const line = `leak.txt type=file mode=0644 size=${SECRET.length} contents=${secret.replaceAll('\\', '/')}\n`;
  return Buffer.from(signature ? `#mtree\n${line}` : line);
}

const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

// 이 tar.exe가 글을 mtree로 읽고 checkfs를 켜면 정말 복사하는지 본다. 그렇지 않으면 아래 시험은 아무것도 증명하지 못한다.
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
