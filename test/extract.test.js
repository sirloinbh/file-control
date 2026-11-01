'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { FcError } = require('../src/commands');
const { planExtractions, applyExtractions, extractArchives, formatExtractions } = require('../src/extract');
const { run } = require('../bin/fctl');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-extract-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

// 항목 이름과 플래그를 마음대로 넣을 수 있는 무압축 zip. { 이름: 내용 } 또는 { name, data, flags } 목록을 받는다.
function zipBuffer(entries) {
  const list = Array.isArray(entries) ? entries : Object.entries(entries).map(([name, data]) => ({ name, data }));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = '', flags = 0 } of list) {
    const body = Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags | 0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags | 0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function makeZip(dir, name, entries) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, zipBuffer(entries));
  return full;
}

function tree(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'))
    .sort();
}

const noTemp = (dir) => assert.deepStrictEqual(tree(dir).concat(fs.readdirSync(dir)).filter((name) => name.includes('.fctl-')), []);

test('압축 파일마다 이름이 같은 새 폴더에 풀고 압축 파일은 남긴다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { '영상.mp4': 'A', 'sub/b.txt': 'B' });
  makeZip(dir, '하위/c.ZIP', { 'c.txt': 'C' });
  const result = extractArchives(dir);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/sub/b.txt', 'a/영상.mp4', '하위/c.ZIP', '하위/c/c.txt'].sort());
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', '영상.mp4'), 'utf8'), 'A');
  assert.deepStrictEqual(result.extracted.map((item) => [item.name, item.entries]), [['a', 2], ['c', 1]]);
  assert.strictEqual(result.failed.length, 0);
  noTemp(dir);
});

test('tar 계열도 풀고 겹 확장자를 폴더 이름에 남기지 않는다', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  run(['zip', path.join(dir, 'b.tar.gz'), path.join(source, 'x.txt')]);
  run(['zip', path.join(dir, 'c.tar'), path.join(source, 'x.txt')]);
  const result = extractArchives(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(tree(dir), ['b.tar.gz', 'b/x.txt', 'c.tar', 'c/x.txt']);
});

test('압축 파일이 아니면 보고하지 않고, 확장자뿐인 이름은 압축 파일로 보지 않는다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.zip'), 'x');
  const result = extractArchives(dir);
  assert.deepStrictEqual([result.extracted.length, result.skipped.length, result.failed.length], [0, 0, 0]);
});

test('같은 이름이 있으면 합치지 않고 건너뛰어 다시 실행해도 또 풀지 않는다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'new.txt': 'new' });
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'old.txt'), 'old');
  makeZip(dir, 'file.zip', { 'x.txt': 'x' });
  fs.writeFileSync(path.join(dir, 'file'), '파일');
  makeZip(dir, 'once.zip', { 'x.txt': 'x' });
  const first = extractArchives(dir);
  assert.deepStrictEqual(first.extracted.map((item) => item.name), ['once']);
  assert.strictEqual(first.skipped.length, 2);
  assert.match(first.skipped[0].reason, /같은 이름이 이미 있어/);
  assert.deepStrictEqual(tree(path.join(dir, 'a')), ['old.txt']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'file'), 'utf8'), '파일');
  const second = extractArchives(dir);
  assert.strictEqual(second.extracted.length, 0);
  assert.strictEqual(second.skipped.length, 3);
});

test('같은 폴더 이름이 되는 압축 파일 둘은 앞의 것만 푼다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'z.txt': 'z' });
  fs.writeFileSync(path.join(dir, 'A.tar'), 'x');
  const result = extractArchives(dir, { dryRun: true });
  assert.strictEqual(result.extracted.length + result.failed.length, 1);
  assert.strictEqual(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /같은 이름이 이미 있어/);
});

test('풀려 나온 압축 파일은 다시 풀지 않는다', () => {
  const dir = tempDir();
  makeZip(dir, 'outer.zip', { 'inner.zip': zipBuffer({ 'x.txt': 'x' }) });
  extractArchives(dir);
  assert.deepStrictEqual(tree(dir), ['outer.zip', 'outer/inner.zip']);
});

test('깨진 압축 파일은 실패로 보고하고 나머지를 계속하며 폴더를 남기지 않는다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
  makeZip(dir, 'good.zip', { 'x.txt': 'x' });
  const result = extractArchives(dir);
  assert.deepStrictEqual(result.extracted.map((item) => item.name), ['good']);
  assert.match(result.failed[0].reason, /압축을 풀지 못했습니다.*tar 종료 코드/);
  assert.deepStrictEqual(tree(dir), ['bad.zip', 'good.zip', 'good/x.txt']);
  assert.ok(!fs.existsSync(path.join(dir, 'bad')));
  noTemp(dir);
});

test('타겟 밖을 가리키는 항목이 있으면 전체를 실패시키고 일부만 풀린 폴더를 남기지 않는다', () => {
  const dir = tempDir();
  const parent = path.dirname(dir);
  const evil = `fc-evil-${path.basename(dir)}.txt`;
  makeZip(dir, 'evil.zip', { [`../${evil}`]: 'x', [`a/../../${evil}`]: 'y', 'good.txt': 'g' });
  const result = extractArchives(dir);
  assert.strictEqual(result.extracted.length, 0);
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(tree(dir), ['evil.zip']);
  assert.ok(!fs.existsSync(path.join(parent, evil)));
  assert.ok(!fs.existsSync(path.join(dir, evil)));
});

test('대소문자만 다르거나 같은 이름의 항목이 겹치면 실패로 보고한다', () => {
  const dir = tempDir();
  makeZip(dir, 'case.zip', [{ name: 'same.txt', data: '1' }, { name: 'SAME.txt', data: '2' }]);
  makeZip(dir, 'dup.zip', [{ name: 'same.txt', data: '1' }, { name: 'same.txt', data: '2' }]);
  const result = extractArchives(dir);
  assert.strictEqual(result.extracted.length, 0);
  assert.strictEqual(result.failed.length, 2);
  assert.match(result.failed[0].reason, /목록 2개, 결과 1개/);
  assert.deepStrictEqual(tree(dir), ['case.zip', 'dup.zip']);
});

test('Windows에서 다르게 해석되는 이름이 나오면 결과로 내놓지 않고 지운다', () => {
  const dir = tempDir();
  makeZip(dir, 'device.zip', { 'con.txt': 'x' });
  makeZip(dir, 'dot.zip', { 'dot.txt.': 'x' });
  makeZip(dir, 'space.zip', { 'sub /a.txt': 'x' });
  const result = extractArchives(dir);
  assert.strictEqual(result.extracted.length, 0);
  assert.strictEqual(result.failed.length, 3);
  // 끝이 공백인 폴더는 tar.exe가 먼저 실패한다.
  assert.deepStrictEqual(result.failed.map((failure) => /다르게 해석될 수 있는 이름/.test(failure.reason)), [true, true, false]);
  assert.deepStrictEqual(tree(dir), ['device.zip', 'dot.zip', 'space.zip']);
});

test('암호가 걸린 압축 파일은 묻지 않고 실패로 보고한다', () => {
  const dir = tempDir();
  makeZip(dir, 'secret.zip', [{ name: 'secret.txt', data: 'xxxxxxxxxxxxxxxx', flags: 1 }]);
  const result = extractArchives(dir);
  assert.match(result.failed[0].reason, /암호/);
  assert.deepStrictEqual(tree(dir), ['secret.zip']);
});

test('풀린 결과에 링크가 있으면 결과로 내놓지 않는다', (t) => {
  const dir = tempDir();
  const outside = tempDir();
  fs.writeFileSync(path.join(outside, 'o.txt'), 'o');
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const renameSync = t.mock.method(fs, 'renameSync');
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (String(p).includes('.fctl-new') && options?.recursive && !fs.existsSync(path.join(String(p), 'lnk'))) fs.symlinkSync(outside, path.join(String(p), 'lnk'), 'junction');
    return realReaddir(p, options);
  });
  const result = extractArchives(dir);
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /링크가 들어 있습니다/);
  assert.strictEqual(renameSync.mock.callCount(), 0);
  assert.deepStrictEqual(tree(outside), ['o.txt']);
  assert.deepStrictEqual(tree(dir), ['a.zip']);
});

test('임시 폴더를 지우지 못하면 그 경로를 알린다', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bad.zip'), zipBuffer({ 'a.txt': 'x' }));
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  t.mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EPERM' });
  });
  const result = extractArchives(dir);
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /임시 폴더를 지우지 못했습니다.*EPERM/);
  fs.rmSync(path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('.fctl-new'))), { recursive: true });
});

test('이름 변경이 실패하면 임시 폴더를 지우고 사유를 알린다', (t) => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  makeZip(dir, 'b.zip', { 'y.txt': 'y' });
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(String(to)) === 'a') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return renameSync(from, to);
  });
  const result = extractArchives(dir);
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /EBUSY/);
  assert.deepStrictEqual(result.extracted.map((item) => item.name), ['b']);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'b.zip', 'b/y.txt']);
  noTemp(dir);
});

test('계획 뒤에 압축 파일이나 대상이 바뀌면 그 파일만 실패한다', () => {
  const dir = tempDir();
  const outside = tempDir();
  makeZip(outside, 'o.zip', { 'evil.txt': 'x' });
  for (const name of ['gone', 'folder', 'link', 'taken', 'ok']) makeZip(dir, `${name}.zip`, { 'x.txt': 'x' });
  makeZip(dir, 'sub/p.zip', { 'x.txt': 'x' });
  makeZip(dir, 'other/p.zip', { 'y.txt': 'y' });
  const plan = planExtractions(dir);
  fs.rmSync(path.join(dir, 'gone.zip'));
  fs.rmSync(path.join(dir, 'folder.zip'));
  fs.mkdirSync(path.join(dir, 'folder.zip'));
  fs.rmSync(path.join(dir, 'link.zip'));
  fs.symlinkSync(outside, path.join(dir, 'link.zip'), 'junction');
  fs.mkdirSync(path.join(dir, 'taken'));
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'other'), path.join(dir, 'sub'), 'junction');
  const result = applyExtractions(plan);
  assert.deepStrictEqual(result.extracted.map((item) => path.relative(dir, item.dest)).sort(), ['ok', path.join('other', 'p')]);
  assert.strictEqual(result.failed.length, 5);
  assert.ok(result.failed.some((item) => /계획 뒤에 경로가 바뀌었습니다/.test(item.reason)));
  assert.ok(result.failed.some((item) => /계획 뒤에 파일이 아니게/.test(item.reason)));
  assert.ok(result.failed.some((item) => /같은 이름이 이미 있어/.test(item.reason)));
  assert.deepStrictEqual(tree(outside), ['o.zip']);
  assert.deepStrictEqual(tree(path.join(dir, 'taken')), []);
});

test('잔여물, 시스템 폴더, 저장소 안의 압축 파일과 링크는 풀지 않고 보고한다', () => {
  const dir = tempDir();
  const outside = tempDir();
  makeZip(outside, 'o.zip', { 'x.txt': 'x' });
  const files = ['.fctl-old-1-2-0/a.zip', '$RECYCLE.BIN/b.zip', '.git/c.zip'];
  for (const file of files) makeZip(dir, file, { 'x.txt': 'x' });
  fs.symlinkSync(outside, path.join(dir, 'link.zip'), 'junction');
  fs.symlinkSync(outside, path.join(dir, 'folder'), 'junction');
  const result = extractArchives(dir);
  assert.strictEqual(result.extracted.length, 0);
  assert.strictEqual(result.skipped.length, 5);
  assert.deepStrictEqual(tree(outside), ['o.zip']);
  assert.deepStrictEqual(tree(path.join(dir, '.git')), ['c.zip']);
});

test('끝이 점이 되는 폴더 이름은 건너뛴다', () => {
  const dir = tempDir();
  makeZip(dir, 'a..zip', { 'x.txt': 'x' });
  const result = extractArchives(dir);
  assert.strictEqual(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /다르게 해석될 수 있는 이름/);
  assert.deepStrictEqual(tree(dir), ['a..zip']);
});

test('미리보기는 아무것도 만들지 않고 항목 수와 깨진 파일을 보여 준다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x', 'y.txt': 'y' });
  fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
  const result = extractArchives(dir, { dryRun: true });
  assert.deepStrictEqual(tree(dir), ['a.zip', 'bad.zip']);
  assert.ok(!fs.existsSync(path.join(dir, 'a')));
  assert.strictEqual(result.failed.length, 1);
  assert.match(formatExtractions(result), /\[미리보기\] 압축 해제: a\.zip -> a \(항목 2개\)/);
  assert.match(formatExtractions(result), /\[미리보기\] 압축 해제 1개, 건너뜀 0개, 실패 1개/);
});

test('보호 경로는 거부한다', () => {
  assert.throws(() => extractArchives(process.env.SystemRoot ?? 'C:\\Windows'), FcError);
});

test('extract-all 명령은 결과를 보여 주고 실패가 있으면 오류로 끝낸다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  assert.match(run(['extract-all', dir, '--dry-run']), /\[미리보기\] 압축 해제 1개/);
  assert.match(run(['extract-all', dir]), /압축 해제: a\.zip -> a \(항목 1개\)\n압축 해제 1개, 건너뜀 0개, 실패 0개/);
  fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
  assert.throws(() => run(['extract-all', dir]), (err) => err instanceof FcError && /실패: bad\.zip/.test(err.message));
});

test('extract-all 명령은 잘못된 인자를 거부한다', () => {
  const dir = tempDir();
  assert.throws(() => run(['extract-all']), /사용법/);
  assert.throws(() => run(['extract-all', dir, 'more']), /타겟은 하나만/);
  assert.throws(() => run(['extract-all', 'C:']), /드라이브 문자/);
  assert.throws(() => run(['extract-all', dir, '--force']), /--force/);
  assert.throws(() => run(['extract-all', dir, '--permanent']), /--permanent/);
});
