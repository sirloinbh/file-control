'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

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

function assertNotCopied(dir) {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'leak.txt') assert.ok(!fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8').includes(SECRET));
  }
}

for (const [label, make] of [
  ['서명이 있는 mtree', (secret) => mtree(secret)],
  ['서명이 없는 mtree', (secret) => mtree(secret, { signature: false })],
  ['gzip으로 감싼 mtree', (secret) => zlib.gzipSync(mtree(secret))],
]) {
  test(`${label}를 풀어도 contents= 파일의 내용이 복사되지 않는다`, () => {
    const outside = tempDir();
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, SECRET);
    for (const name of ['x.7z', 'x.zip', 'x.tar.gz']) {
      const dir = tempDir();
      const archive = path.join(dir, name);
      fs.writeFileSync(archive, make(secret));
      try {
        fc.unzip(archive, path.join(dir, 'out'));
      } catch {
        // tar.exe 버전에 따라 거부할 수 있다. 내용이 복사되지 않으면 된다.
      }
      extractArchives(dir);
      assertNotCopied(dir);
      assert.strictEqual(fs.readFileSync(secret, 'utf8'), SECRET);
    }
  });
}
