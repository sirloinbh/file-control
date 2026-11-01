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

// tar.exe가 내용으로 형식을 골라, 이 글을 풀면 contents= 경로의 로컬 파일을 복사한다.
function mtree(secret, { signature = true } = {}) {
  const line = `leak.txt type=file mode=0644 contents=${secret.replaceAll('\\', '/')}\n`;
  return Buffer.from(signature ? `#mtree\n${line}` : line);
}

function secretFile() {
  const outside = tempDir();
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, '비밀 내용');
  return secret;
}

const allFiles = (dir) => fs.readdirSync(dir, { recursive: true });

for (const [label, make] of [
  ['서명이 있는 mtree', (secret) => mtree(secret)],
  ['서명이 없는 mtree', (secret) => mtree(secret, { signature: false })],
  ['gzip으로 감싼 mtree', (secret) => zlib.gzipSync(mtree(secret))],
]) {
  test(`${label}는 unzip과 extract-all로 풀지 않아 로컬 파일이 복사되지 않는다`, () => {
    const secret = secretFile();
    for (const name of ['x.7z', 'x.zip', 'x.tar.gz']) {
      const dir = tempDir();
      const archive = path.join(dir, name);
      fs.writeFileSync(archive, make(secret));
      assert.throws(() => fc.unzip(archive, path.join(dir, 'out')), /압축 형식을 확인할 수 없습니다/);
      assert.throws(() => fc.unzip(archive, path.join(dir, 'preview'), { dryRun: true }), /압축 형식을 확인할 수 없습니다/);
      const result = extractArchives(dir);
      assert.strictEqual(result.extracted.length, 0);
      assert.match(result.failed[0].reason, /압축 형식을 확인할 수 없습니다/);
      assert.ok(!allFiles(dir).some((file) => file.endsWith('leak.txt')), name);
    }
  });
}

test('지원하는 형식은 그대로 풀린다', () => {
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  for (const name of ['a.zip', 'a.7z', 'a.tar', 'a.tar.gz', 'a.tgz', 'a.tar.bz2', 'a.tbz2', 'a.tar.xz', 'a.txz']) {
    const dir = tempDir();
    fc.zip(path.join(dir, name), [path.join(source, 'x.txt')]);
    fc.unzip(path.join(dir, name), path.join(dir, 'out'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'out', 'x.txt'), 'utf8'), 'x', name);
  }
});

test('확장자와 상관없이 내용으로 형식을 본다', () => {
  const source = tempDir();
  const dir = tempDir();
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  fc.zip(path.join(dir, 'a.zip'), [path.join(source, 'x.txt')]);
  fs.renameSync(path.join(dir, 'a.zip'), path.join(dir, 'renamed.bin'));
  fc.unzip(path.join(dir, 'renamed.bin'), path.join(dir, 'out'));
  assert.ok(fs.existsSync(path.join(dir, 'out', 'x.txt')));
});

test('빈 파일은 형식 오류로 막지 않고 항목 없음으로 보고한다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.zip'), '');
  assert.match(extractArchives(dir).failed[0].reason, /항목이 없습니다/);
});

test('깨진 gzip은 형식 오류로 거부한다', () => {
  const dir = tempDir();
  const archive = path.join(dir, 'a.tar.gz');
  fs.writeFileSync(archive, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]));
  assert.throws(() => fc.unzip(archive, path.join(dir, 'out')), /압축 형식을 확인할 수 없습니다|tar/);
});
