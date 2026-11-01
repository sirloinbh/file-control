'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// 테스트가 사용자 휴지통을 건드리지 않게, commands.js를 불러오기 전에 휴지통 호출을 가짜로 바꿔 둔다.
const realExecFileSync = childProcess.execFileSync;
const recycled = [];
let onRecycle = () => {};
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  onRecycle(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET);
  return Buffer.alloc(0);
});
test.beforeEach(() => {
  recycled.length = 0;
  onRecycle = () => {};
});

const { FcError } = require('../src/commands');
const { planExtractions, applyExtractions, extractArchives, formatExtractions } = require('../src/extract');
const { run } = require('../bin/fctl');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-extract-rm-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function tree(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'))
    .sort();
}

// 무압축 zip. cut을 'entries'로 주면 항목 뒤에서, 'directory'로 주면 중앙 디렉터리 중간에서 잘린 파일이 된다.
function zipBuffer(files, { comment = '', cut = null } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  if (cut === 'entries') return Buffer.concat(locals);
  const directory = Buffer.concat(centrals);
  if (cut === 'directory') return Buffer.concat([...locals, directory.subarray(0, 20)]);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)]);
}

function makeZip(dir, name, files, options) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, zipBuffer(files, options));
  return full;
}

test('옵션을 주지 않으면 원본을 지우지 않는다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const result = extractArchives(dir);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});

test('정상으로 풀린 압축 파일을 휴지통으로 보낸다', () => {
  const dir = tempDir();
  const a = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const b = makeZip(dir, 'sub/b.zip', { 'y.txt': 'y' }, { comment: 'c'.repeat(1000) });
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled.sort(), [a, b].sort());
  assert.deepStrictEqual(result.removed.sort(), [a, b].sort());
  assert.deepStrictEqual(tree(dir), ['a/x.txt', 'sub/b/y.txt']);
  assert.match(formatExtractions(result), /압축 해제 2개, 휴지통 2개, 남김 0개, 건너뜀 0개, 실패 0개/);
});

test('본문 손상을 잡는 형식은 지우고, 잡지 못하거나 확인하지 못한 형식은 풀기만 하고 남긴다', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  const kept = ['k.tar', 'k2.tar.gz', 'k3.tgz'];
  const removed = ['r.7z', 'r2.tar.bz2', 'r3.tbz2', 'r4.tar.xz', 'r5.txz'];
  for (const name of [...kept, ...removed]) run(['zip', path.join(dir, name), path.join(source, 'x.txt')]);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)).sort(), removed);
  assert.deepStrictEqual(result.kept.map((item) => path.basename(item.archive)).sort(), kept);
  for (const item of result.kept) assert.match(item.reason, /온전한지 확인할 수 없어/);
  for (const name of kept) assert.ok(fs.existsSync(path.join(dir, name)));
  assert.match(formatExtractions(result), /남김: k\.tar \(/);
});

test('확장자가 대문자여도 같게 판단한다', () => {
  const dir = tempDir();
  makeZip(dir, 'A.ZIP', { 'x.txt': 'x' });
  assert.strictEqual(extractArchives(dir, { removeArchives: true }).removed.length, 1);
});

test('끝 표시 없이 잘린 zip은 풀려도 지우지 않는다', () => {
  const dir = tempDir();
  const cut = makeZip(dir, 'cut.zip', { 'x.txt': 'x', 'y.txt': 'y' }, { cut: 'directory' });
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(cut));
  assert.deepStrictEqual(result.extracted.map((item) => item.entries), [2]);
  assert.match(result.kept[0].reason, /zip 끝 표시가 없어/);
});

test('항목 뒤에서 잘린 zip은 실패로 보고하고 지우지 않는다', () => {
  const dir = tempDir();
  const cut = makeZip(dir, 'cut.zip', { 'x.txt': 'x', 'y.txt': 'y' }, { cut: 'entries' });
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(cut));
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(tree(dir), ['cut.zip']);
});

test('본문이 손상된 zip은 실패로 보고하고 지우지 않는다', () => {
  const dir = tempDir();
  const file = makeZip(dir, 'bad.zip', { 'x.txt': 'original content' });
  const data = fs.readFileSync(file);
  data[data.indexOf('original')] = 0x58;
  fs.writeFileSync(file, data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(tree(dir), ['bad.zip']);
});

test('tar.gz 본문이 변해 성공으로 풀려도 지우지 않는다', () => {
  const dir = tempDir();
  const body = Buffer.alloc(1536);
  body.write('x.txt', 0);
  body.write('0000644\0' + '0000000\0' + '0000000\0' + '00000000002\0' + '00000000000\0', 100, 'latin1');
  body.fill(' ', 148, 156);
  body.write('0', 156);
  body.write('ustar\0' + '00', 257, 'latin1');
  body.write(body.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  body.write('ok', 512);
  const file = path.join(dir, 'a.tar.gz');
  const data = zlib.gzipSync(body, { level: 0 });
  data[data.indexOf('ok')] = 0x4e;
  fs.writeFileSync(file, data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(result.removed.length, 0);
});

test('건너뛰거나 항목이 없는 압축 파일은 지우지 않는다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'empty.zip'), zipBuffer({}));
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'empty.zip']);
});

test('푸는 동안 압축 파일이 바뀌면 풀린 결과는 두고 원본을 지우지 않는다', (t) => {
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const readdirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (String(p).includes('.fctl-new') && options?.recursive) fs.appendFileSync(file, 'more');
    return readdirSync(p, options);
  });
  const result = extractArchives(dir, { removeArchives: true });
  t.mock.restoreAll();
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.extracted.map((item) => item.name), ['a']);
  assert.match(result.failed[0].reason, /풀고 난 뒤 파일이 바뀌어/);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});

test('휴지통으로 보내지 못하면 풀린 결과와 원본을 두고 실패로 보고한다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  makeZip(dir, 'b.zip', { 'y.txt': 'y' });
  onRecycle = (target) => {
    if (path.basename(target) === 'a.zip') throw Object.assign(new Error('recycle'), { status: 1 });
  };
  const result = extractArchives(dir, { removeArchives: true });
  assert.match(result.failed[0].reason, /풀었지만 휴지통으로 보내지 못했습니다/);
  assert.strictEqual(result.extracted.length, 2);
  assert.strictEqual(result.removed.length, 1);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt', 'b/y.txt']);
});

test('대화형 세션이 아니라는 거부를 그대로 보고하고 영구 삭제하지 않는다', () => {
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  onRecycle = () => {
    throw Object.assign(new Error('non-interactive'), { status: 75 });
  };
  const result = extractArchives(dir, { removeArchives: true });
  assert.match(result.failed[0].reason, /대화형 세션이 아니면/);
  assert.ok(fs.existsSync(file));
});

test('계획 뒤에 압축 파일이 링크 너머로 바뀌면 지우지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  makeZip(dir, 'sub/a.zip', { 'x.txt': 'x' });
  makeZip(outside, 'a.zip', { 'x.txt': 'x' });
  const plan = planExtractions(dir);
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'sub'), 'junction');
  const result = applyExtractions(plan, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(tree(outside), ['a.zip']);
});

test('미리보기는 지울 대상과 남길 대상을 보여 주고 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  makeZip(dir, 'cut.zip', { 'x.txt': 'x' }, { cut: 'directory' });
  const report = run(['extract-all', dir, '--dry-run', '--remove-archives']);
  assert.match(report, /\[미리보기\] 휴지통으로 이동: a\.zip/);
  assert.match(report, /\[미리보기\] 남김: cut\.zip/);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'cut.zip']);
});

test('--remove-archives 옵션은 extract-all에서만 받고 지우지 못하면 오류로 끝낸다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  for (const command of [['flatten', dir], ['product-number', dir], ['unzip', path.join(dir, 'a.zip')], ['rm', path.join(dir, 'a.zip')]]) {
    assert.throws(() => run([...command, '--remove-archives']), /extract-all에서만/);
  }
  assert.ok(fs.existsSync(path.join(dir, 'a.zip')));
  onRecycle = () => {
    throw Object.assign(new Error('recycle'), { status: 1 });
  };
  assert.throws(() => run(['extract-all', dir, '--remove-archives']), (err) => err instanceof FcError && /실패: a\.zip/.test(err.message));
  onRecycle = () => {};
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});
