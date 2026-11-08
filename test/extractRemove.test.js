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
// 파일 시스템 확인(#184). 기본은 NTFS로 답하고, 테스트마다 바꿔 exFAT 등을 흉내 낸다.
let format = () => 'NTFS\r\n';
let formatProbes = 0;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) {
    formatProbes += 1;
    return format();
  }
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  onRecycle(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET);
  return Buffer.alloc(0);
});
test.beforeEach(() => {
  recycled.length = 0;
  onRecycle = () => {};
  format = () => 'NTFS\r\n';
  formatProbes = 0;
});

const { FcError } = require('../src/commands');
const { fileStamp } = require('../src/target');
const { planExtractions, applyExtractions, extractArchives, formatExtractions } = require('../src/extract');
const { run } = require('../bin/fctl');
const { sevenZipBuffer } = require('./sevenZipBuffer');
const SYSTEM_TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

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
// hide에 든 이름은 로컬 항목만 넣고 중앙 디렉터리에서 뺀다.
function zipBuffer(files, { comment = '', cut = null, unicode = false, disk = 0, prefix = Buffer.alloc(0), hide = [] } = {}) {
  const locals = [prefix];
  const centrals = [];
  let offset = prefix.length;
  for (const [name, data] of Object.entries(files)) {
    const body = Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(unicode ? 0x800 : 0, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(unicode ? 0x800 : 0, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    if (!hide.includes(name)) centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  if (cut === 'entries') return Buffer.concat(locals);
  const directory = Buffer.concat(centrals);
  if (cut === 'directory') return Buffer.concat([...locals, directory.subarray(0, 20)]);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length - hide.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(disk, 4);
  end.writeUInt16LE(disk, 6);
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

test('exFAT 볼륨이면 풀기만 하고 압축 파일은 남긴다 (#184)', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  format = () => 'exFAT\r\n';
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  assert.match(preview.kept[0].reason, /^exFAT 볼륨은 변경 시각을 적지 않아/);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(result.kept.map((item) => item.reason.slice(0, 5)), ['exFAT']);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
  assert.strictEqual(formatProbes, 2);
});

test('압축 파일을 지우지 않으면 파일 시스템을 확인하지 않는다 (#184)', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  extractArchives(dir);
  assert.strictEqual(formatProbes, 0);
});

test('.zip·.7z·.tar.gz·.tgz만 지우고, 다른 형식은 풀기만 하고 남긴다 (#197)', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  const kept = ['k.tar', 'k4.tar.bz2', 'k5.tbz2', 'k6.tar.xz', 'k7.txz'];
  const removed = ['r.7z', 'r2.tar.gz', 'r3.tgz'];
  for (const name of [...kept, ...removed]) run(['zip', path.join(dir, name), path.join(source, 'x.txt')]);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)).sort(), [...removed].sort());
  assert.deepStrictEqual(result.kept.map((item) => path.basename(item.archive)).sort(), kept);
  for (const item of result.kept) assert.match(item.reason, /온전한지 확인할 수 없어/);
  for (const name of kept) assert.ok(fs.existsSync(path.join(dir, name)));
  assert.match(formatExtractions(result), /남김: k\.tar \(/);
});

// 지우면 안 되는 zip. tar.exe는 모두 오류 없이 일부만 풀거나 이름을 바꾸어 푼다.
test('구조가 맞지 않는 zip은 풀려도 지우지 않는다', () => {
  const inner = zipBuffer({ 'inner1.txt': '1', 'inner2.txt': '2' });
  const whole = zipBuffer({ 'a.txt': 'a', 'inner.zip': inner });
  const after = whole.indexOf(inner) + inner.length;
  const first = zipBuffer({ 'A1.txt': '1', 'A2.txt': '2' });
  const second = zipBuffer({ 'B1.txt': 'b' });
  const cases = {
    'cut-inner.zip': [whole.subarray(0, after), /구조가 파일 크기와 맞지 않아/],
    'joined.zip': [Buffer.concat([first, second]), /구조가 파일 크기와 맞지 않아/],
    'in-comment.zip': [zipBuffer({ 'real.txt': 'r' }, { comment: second.toString('latin1') }), /구조가 파일 크기와 맞지 않아/],
    'tail.zip': [Buffer.concat([zipBuffer({ 'x.txt': 'x' }), Buffer.from('trailing')]), /끝 표시 뒤에 다른 데이터/],
    'head.zip': [Buffer.concat([Buffer.from('prefix'), zipBuffer({ 'x.txt': 'x' })]), /zip으로 시작하지 않아/],
    'split.zip': [zipBuffer({ 'x.txt': 'x' }, { disk: 1 }), /분할 압축/],
  };
  const dir = tempDir();
  for (const [name, [data]] of Object.entries(cases)) fs.writeFileSync(path.join(dir, name), data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
  const reasons = Object.fromEntries([...result.kept, ...result.failed].map((item) => [path.basename(item.archive), item.reason]));
  // tar.exe가 풀지 못한 것은 실패로 남아도 된다. 지우지 않는 것이 핵심이다.
  for (const [name, [, reason]] of Object.entries(cases)) {
    assert.ok(reasons[name] !== undefined, name);
    if (result.kept.some((item) => path.basename(item.archive) === name)) assert.match(reasons[name], reason, name);
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  }
});

test('이어 붙인 뒤 오프셋을 고친 zip은 앞쪽 항목이 풀리지 않으므로 지우지 않는다', () => {
  const dir = tempDir();
  const first = zipBuffer({ 'A1.txt': '1', 'A2.txt': '2' });
  fs.writeFileSync(path.join(dir, 'a.zip'), zipBuffer({ 'B1.txt': 'b' }, { prefix: first }));
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.match(result.kept[0].reason, /앞쪽에 목록에 없는 데이터/);
  assert.ok(fs.existsSync(path.join(dir, 'a.zip')));
});

test('뒤에 데이터가 붙거나 이어 붙은 .7z는 지우지 않고, 온전한 .7z는 지운다', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  fs.writeFileSync(path.join(source, 'y.txt'), 'y');
  const first = path.join(source, 'first.7z');
  const second = path.join(source, 'second.7z');
  run(['zip', first, path.join(source, 'x.txt')]);
  run(['zip', second, path.join(source, 'y.txt')]);
  const data = fs.readFileSync(first);
  fs.writeFileSync(path.join(dir, 'whole.7z'), data);
  fs.writeFileSync(path.join(dir, 'tail.7z'), Buffer.concat([data, Buffer.from('z')]));
  fs.writeFileSync(path.join(dir, 'joined.7z'), Buffer.concat([data, fs.readFileSync(second)]));
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)), ['whole.7z']);
  assert.deepStrictEqual(result.kept.map((item) => path.basename(item.archive)).sort(), ['joined.7z', 'tail.7z']);
  for (const item of result.kept) assert.match(item.reason, /7z 끝 뒤에/);
});

// 7z 헤더(압축된 헤더 포함)를 읽어 UTF-16 이름과 CRC를 확인한다(#198).
test('ASCII가 아닌 이름의 .7z도 헤더의 이름 그대로 풀렸는지 확인하고 지운다 (#198)', () => {
  const dir = tempDir();
  const source = tempDir();
  // tar.exe는 ANSI에 없는 이름에서 비정상 종료하므로 코드페이지에 있는 글자를 쓴다.
  const name = require('../src/commands').oemCodePage() === 949 ? '한글 이름.txt' : 'café.txt';
  fs.mkdirSync(path.join(source, 'sub'));
  fs.writeFileSync(path.join(source, 'sub', name), 'x');
  realExecFileSync(SYSTEM_TAR, ['-a', '-cf', path.join(dir, 'n.7z'), '-C', source, 'sub']);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)), ['n.7z']);
  assert.deepStrictEqual(tree(dir), [`n/sub/${name}`]);
});

test('extract-all은 임시 폴더 경로가 tar.exe 한도를 넘는 압축 파일을 미리보기에서도 같은 사유로 알린다 (#238)', () => {
  const dir = tempDir();
  // 압축 파일 폴더가 230자: 최종 풀 폴더(…\a)는 258자 안이지만 임시 폴더(…\.fctl-new-<pid>-<시각>-0)는 넘는다.
  let folder = dir;
  while (folder.length < 220) folder = path.join(folder, 'x'.repeat(9));
  folder = path.join(folder, 'y'.repeat(230 - folder.length - 1));
  assert.strictEqual(folder.length, 230);
  makeZip(folder, 'a.zip', { 'x.txt': 'x' });
  const reasons = [];
  for (const dryRun of [true, false]) {
    const result = extractArchives(dir, { removeArchives: true, dryRun });
    assert.deepStrictEqual(recycled, []);
    assert.strictEqual(result.failed.length, 1, String(dryRun));
    reasons.push(result.failed[0].reason);
  }
  assert.strictEqual(reasons[0], reasons[1]);
  assert.match(reasons[0], /임시 폴더\(약 \d+자\)로 tar\.exe가 옮겨 갈 수 없습니다\(258자까지\)/);
  assert.ok(!reasons[0].includes('.fctl-new'), reasons[0]);
  assert.deepStrictEqual(fs.readdirSync(folder), ['a.zip']);
});

test('extract-all은 외부 프로그램이 필요한 압축 내용(lz4)을 풀지 못하면 프로그램 이름을 사유로 알리고 원본을 남긴다 (#241)', (t) => {
  const dir = tempDir();
  // 이름은 .tar.gz지만 내용은 lz4다. tar.exe는 내용으로 판별해 lz4를 실행하려 한다.
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x64, 0x70, 0xb9, 1, 2, 3, 4]));
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  process.env.PATH = path.join(dir, 'nothing');
  for (const dryRun of [true, false]) {
    const result = extractArchives(dir, { removeArchives: true, dryRun });
    assert.deepStrictEqual(recycled, []);
    assert.strictEqual(result.failed.length, 1);
    assert.match(result.failed[0].reason, /외부 프로그램 lz4이 필요한데 실행하지 못했습니다/);
  }
  assert.deepStrictEqual(tree(dir), ['a.tar.gz']);
});

test('헤더가 LZMA2로 압축된 .7z도 헤더를 읽어 확인하고 지운다 (#222)', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.mkdirSync(path.join(source, 'sub'));
  fs.writeFileSync(path.join(source, 'sub', 'a.txt'), 'A'.repeat(1000));
  fs.writeFileSync(path.join(source, 'b.txt'), 'b');
  realExecFileSync(SYSTEM_TAR, ['-a', '-cf', path.join(dir, 'l2.7z'), '--options', '7zip:compression=lzma2', '-C', source, 'sub', 'b.txt']);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)), ['l2.7z']);
  assert.deepStrictEqual(tree(dir), ['l2/b.txt', 'l2/sub/a.txt']);
});

test('CRC가 없는 .7z는 본문이 변해도 풀리므로 지우지 않고, CRC가 있는 같은 구조는 지운다 (#198)', () => {
  const dir = tempDir();
  const files = [{ name: 'dir', folder: true }, { name: 'dir/x.txt', data: 'hello' }, { name: 'y.txt', data: 'world' }];
  fs.writeFileSync(path.join(dir, 'with-crc.7z'), sevenZipBuffer(files));
  fs.writeFileSync(path.join(dir, 'no-crc.7z'), sevenZipBuffer(files, { crc: false }));
  const changed = sevenZipBuffer(files, { crc: false });
  changed[changed.indexOf('hello')] = 0x4a;
  fs.writeFileSync(path.join(dir, 'changed.7z'), changed);
  fs.writeFileSync(path.join(dir, 'gap.7z'), sevenZipBuffer(files, { gap: 3 }));
  // 폴더 CRC만 있는 7z는 tar.exe가 검사하지 않아 본문이 바뀌어도 풀린다(1차 리뷰에서 지워지던 경우).
  const folderOnly = sevenZipBuffer([{ name: 'z.txt', data: 'hello' }], { folderCrcOnly: true });
  folderOnly[folderOnly.indexOf('hello')] = 0x6a;
  fs.writeFileSync(path.join(dir, 'folder-crc.7z'), folderOnly);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)), ['with-crc.7z']);
  const kept = Object.fromEntries(result.kept.map((item) => [path.basename(item.archive), item.reason]));
  assert.match(kept['no-crc.7z'], /CRC가 없어/);
  assert.match(kept['changed.7z'], /CRC가 없어/);
  assert.match(kept['gap.7z'], /목록에 없는 데이터/);
  assert.match(kept['folder-crc.7z'], /CRC가 없어/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'folder-crc', 'z.txt'), 'utf8'), 'jello');
  // 본문이 바뀐 CRC 없는 7z도 tar.exe는 성공으로 푼다(지우지 않는 이유).
  assert.strictEqual(fs.readFileSync(path.join(dir, 'changed', 'dir', 'x.txt'), 'utf8'), 'Jello');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'with-crc', 'y.txt'), 'utf8'), 'world');
});

test('너무 짧은 .7z와 .zip은 지우지 않는다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.7z'), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  fs.writeFileSync(path.join(dir, 'b.zip'), 'PK\x03\x04', 'latin1');
  extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(tree(dir), ['a.7z', 'b.zip']);
});

test('Zip64 표시가 있는 zip은 지우지 않는다', () => {
  const dir = tempDir();
  const data = zipBuffer({ 'x.txt': 'x' });
  data.writeUInt32LE(0xffffffff, data.length - 6);
  fs.writeFileSync(path.join(dir, 'big.zip'), data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
});

test('내용이 확장자와 다르면 풀려도 지우지 않는다', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  run(['zip', path.join(dir, 'real.tar.gz'), path.join(source, 'x.txt')]);
  fs.copyFileSync(path.join(dir, 'real.tar.gz'), path.join(dir, 'fake.7z'));
  fs.copyFileSync(path.join(dir, 'real.tar.gz'), path.join(dir, 'fake2.zip'));
  run(['zip', path.join(source, 'real.zip'), path.join(source, 'x.txt')]);
  fs.copyFileSync(path.join(source, 'real.zip'), path.join(dir, 'fake3.tgz'));
  const result = extractArchives(dir, { removeArchives: true });
  // 내용이 맞는 real.tar.gz만 지운다(#197).
  assert.deepStrictEqual(recycled, [path.join(dir, 'real.tar.gz')]);
  const reason = (name) => result.kept.find((item) => path.basename(item.archive) === name)?.reason;
  assert.match(reason('fake.7z'), /7z로 시작하지 않아/);
  assert.match(reason('fake2.zip'), /zip으로 시작하지 않아/);
  assert.match(reason('fake3.tgz'), /gzip으로 시작하지 않아/);
});

test('이름이 바뀌어 풀리는 항목이 있으면 지우지 않는다', () => {
  const dir = tempDir();
  makeZip(dir, 'colon.zip', { 'a:b.txt': 'x' });
  makeZip(dir, 'question.zip', { 'q?.txt': 'x' });
  makeZip(dir, 'drive.zip', { 'C:/dir/y.txt': 'x' });
  const data = zipBuffer({ 'abc.txt': 'x' });
  data[data.indexOf('abc.txt')] = 0xc0;
  fs.writeFileSync(path.join(dir, 'codepage.zip'), data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(result.removed.length, 0);
  const kept = Object.fromEntries(result.kept.map((item) => [path.basename(item.archive), item.reason]));
  for (const name of ['colon.zip', 'question.zip', 'drive.zip']) assert.match(kept[name], /이름이 바뀌는 항목/);
});

test('폴더 항목에 내용이 있으면 지우지 않는다', () => {
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'sub/': 'data', 'x.txt': 'x' });
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(result.removed.length, 0);
});

test('폴더 항목과 주석이 있는 정상 zip은 지운다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'sub/': '', 'sub/x.txt': 'x', 'b\\c.txt': 'c', './d.txt': 'd' }, { comment: 'memo' });
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.removed.length, 1);
});

test('UTF-8 표시가 있는 한글 이름은 그대로 풀렸는지 확인하고 지운다', (t) => {
  // tar.exe는 코드페이지에 없는 문자를 처리하지 못해 영문 Windows에서는 시험할 수 없다.
  const codePage = realExecFileSync('powershell.exe', ['-NoProfile', '-Command', '[Text.Encoding]::Default.CodePage'], { encoding: 'utf8' }).trim();
  if (codePage !== '949') return t.skip(`코드페이지 ${codePage}에서는 한글을 처리하지 못한다`);
  const dir = tempDir();
  makeZip(dir, 'a.zip', { '영상.txt': 'x' }, { unicode: true });
  const result = extractArchives(dir, { removeArchives: true });
  assert.strictEqual(result.removed.length, 1);
  assert.deepStrictEqual(tree(dir), ['a/영상.txt']);
});

test('푸는 동안 같은 크기와 수정 시각의 다른 파일로 바뀌어도 지우지 않는다', (t) => {
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const readdirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (String(p).includes('.fctl-new') && options?.recursive) {
      const { atime, mtime } = fs.statSync(file);
      const data = fs.readFileSync(file);
      fs.rmSync(file);
      fs.writeFileSync(file, data);
      fs.utimesSync(file, atime, mtime);
    }
    return readdirSync(p, options);
  });
  const result = extractArchives(dir, { removeArchives: true });
  t.mock.restoreAll();
  assert.deepStrictEqual(recycled, []);
  assert.match(result.failed[0].reason, /풀고 난 뒤 파일이 바뀌어/);
});

test('푸는 동안 같은 크기와 수정 시각으로 제자리에서 다시 써도 지우지 않는다', (t) => {
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  // utimesSync는 ms 아래 자리를 정확히 되돌리지 못하므로, 수정 시각을 ms 단위 값으로 맞춰 두고 그 값으로 되돌린다.
  // 그래야 파일 번호, 크기, 수정 시각이 모두 풀기 전과 같아진다.
  const old = new Date(Date.now() - 3600 * 1000 - 123);
  fs.utimesSync(file, old, old);
  // 구조가 온전하고 이름과 크기도 같아 내용 확인은 통과하는 다른 zip이다.
  const other = zipBuffer({ 'x.txt': 'y' });
  const original = fs.lstatSync(file, { bigint: true });
  const before = fileStamp(original);
  const readdirSync = fs.readdirSync;
  let rewritten = false;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (String(p).includes('.fctl-new') && options?.recursive) {
      // 변경 시각이 시계 단위로 적혀 같은 단위 안이면 구분할 수 없으므로, 식별값이 달라질 때까지 다시 쓴다(#116).
      for (let tries = 0; tries < 100 && !rewritten; tries += 1) {
        const fd = fs.openSync(file, 'r+');
        fs.writeSync(fd, other, 0, other.length, 0);
        fs.closeSync(fd);
        fs.utimesSync(file, old, old);
        rewritten = fileStamp(fs.lstatSync(file, { bigint: true })) !== before;
        if (!rewritten) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
    return readdirSync(p, options);
  });
  const result = extractArchives(dir, { removeArchives: true });
  t.mock.restoreAll();
  assert.ok(rewritten);
  // 바꿔치기는 변경 시각으로만 드러난다.
  const after = fs.lstatSync(file, { bigint: true });
  assert.deepStrictEqual([after.ino, after.size, after.mtimeNs], [original.ino, original.size, original.mtimeNs]);
  assert.notStrictEqual(after.ctimeNs, original.ctimeNs);
  assert.ok(fs.readFileSync(file).equals(other));
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
  assert.match(result.failed[0].reason, /풀고 난 뒤 파일이 바뀌어/);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});

test('파일 번호가 2^53을 넘어도 하나만 달라진 것을 알아챈다', (t) => {
  // ReFS의 파일 번호는 2^53을 넘는다. 숫자로 비교하면 아래 두 값이 같아진다.
  const base = 2n ** 62n;
  assert.strictEqual(Number(base), Number(base + 1n));
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const { lstatSync, readdirSync } = fs;
  let extracted = false;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (String(p).includes('.fctl-new') && options?.recursive) extracted = true;
    return readdirSync(p, options);
  });
  t.mock.method(fs, 'lstatSync', (p, options) => {
    const stat = lstatSync(p, options);
    if (path.resolve(String(p)) === file && options?.bigint) stat.ino = base + (extracted ? 1n : 0n);
    return stat;
  });
  const result = extractArchives(dir, { removeArchives: true });
  t.mock.restoreAll();
  assert.ok(extracted);
  assert.deepStrictEqual(recycled, []);
  assert.match(result.failed[0].reason, /풀고 난 뒤 파일이 바뀌어/);
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

// tar 헤더 하나(512바이트). 체크섬까지 채운다.
function tarHeader(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'latin1');
  block.write('0000644\0' + '0000000\0' + '0000000\0' + size.toString(8).padStart(11, '0') + '\0' + '00000000000\0', 100, 'latin1');
  block.fill(' ', 148, 156);
  block.write(type, 156, 'latin1');
  block.write('ustar\0' + '00', 257, 'latin1');
  block.write(block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return block;
}

// 파일 항목들과 끝 표시(0 블록 두 개)로 된 tar. end를 false로 주면 끝 표시를 넣지 않는다.
function tarBuffer(files, { end = true, after = Buffer.alloc(0) } = {}) {
  const parts = [];
  for (const [name, data] of Object.entries(files)) {
    const body = Buffer.from(data);
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  parts.push(after);
  return Buffer.concat(parts);
}


test('tar.exe로 만든 .tar.gz·.tgz는 gzip CRC와 tar 구조, 풀린 이름을 확인하고 지운다 (#197)', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'a.txt'), 'A'.repeat(5000));
  fs.writeFileSync(path.join(source, 'empty.txt'), '');
  fs.mkdirSync(path.join(source, 'sub', 'deep'), { recursive: true });
  // 영어 Windows(CI)의 tar.exe는 ANSI에 없는 한글 이름에서 비정상 종료(0xC0000005)하므로 949일 때만 넣는다.
  // pax UTF-8 이름은 test/tarGzScan.test.js에서 따로 본다.
  const hangul = require('../src/commands').oemCodePage() === 949;
  const named = hangul ? '한글 이름.txt' : 'space name.txt';
  fs.writeFileSync(path.join(source, 'sub', named), '한');
  fs.writeFileSync(path.join(source, 'sub', 'deep', `${'n'.repeat(120)}.txt`), 'long');
  // -C source .로 묶으면 ./ 항목이 생기고 이름은 tar.exe가 유니코드로 읽어 pax에 UTF-8로 적는다.
  realExecFileSync(SYSTEM_TAR, ['-czf', path.join(dir, 'a.tar.gz'), '-C', source, '.']);
  realExecFileSync(SYSTEM_TAR, ['-czf', path.join(dir, 'b.tgz'), '-C', source, 'a.txt', 'sub']);
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  assert.deepStrictEqual(preview.kept, []);
  assert.strictEqual(preview.removed.length, 2);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)).sort(), ['a.tar.gz', 'b.tgz']);
  const long = `sub/deep/${'n'.repeat(120)}.txt`;
  assert.deepStrictEqual(tree(dir), ['a/a.txt', 'a/empty.txt', `a/${long}`, `a/sub/${named}`, 'b/a.txt', `b/${long}`, `b/sub/${named}`].sort());
});

test('GNU 긴 이름(L) 항목도 그 이름으로 풀렸는지 확인하고 지운다 (#197)', () => {
  const dir = tempDir();
  const name = `${'g'.repeat(150)}.txt`;
  const longName = Buffer.from(`${name}\0`, 'latin1');
  const header = tarHeader('././@LongLink', longName.length, 'L');
  const body = Buffer.concat([header, longName, Buffer.alloc(512 - longName.length), tarBuffer({ [name.slice(0, 99)]: 'gnu' })]);
  fs.writeFileSync(path.join(dir, 'gnu.tar.gz'), zlib.gzipSync(body));
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.strictEqual(result.removed.length, 1);
  assert.deepStrictEqual(tree(dir), [`gnu/${name}`]);
});

test('손상되거나 tar.exe가 일부만 푸는 .tar.gz는 지우지 않는다 (#197)', () => {
  const dir = tempDir();
  const good = zlib.gzipSync(tarBuffer({ 'x.txt': 'ok' }));
  const other = zlib.gzipSync(tarBuffer({ 'y.txt': 'more' }));
  const cases = {
    // 끝이 잘림: gzip 끝(CRC·길이)이 없다.
    'cut.tar.gz': good.subarray(0, good.length - 6),
    // 이어 붙인 gzip: tar.exe는 첫 tar의 끝 표시에서 멈춰 y.txt를 풀지 않는다.
    'concat.tar.gz': Buffer.concat([good, other]),
    // gzip 뒤에 다른 데이터
    'junk.tgz': Buffer.concat([good, Buffer.from('garbage')]),
    // 멤버 뒤가 0x00으로 시작하면 Node도 tar.exe도 오류 없이 뒤를 버린다(1차 리뷰에서 지워지던 경우).
    'zero-gap.tar.gz': Buffer.concat([good, Buffer.alloc(1), other]),
    // 끝 표시 뒤의 항목
    'after-end.tar.gz': zlib.gzipSync(tarBuffer({ 'x.txt': 'ok' }, { after: tarBuffer({ 'z.txt': 'hidden' }) })),
    // 끝 표시가 없다(항목 경계에서 잘린 tar를 다시 gzip으로 싼 것)
    'no-end.tar.gz': zlib.gzipSync(tarBuffer({ 'x.txt': 'ok' }, { end: false })),
    // 이름은 .tar.gz인데 gzip이 아니다.
    'plain.tar.gz': tarBuffer({ 'x.txt': 'ok' }),
  };
  for (const [name, data] of Object.entries(cases)) fs.writeFileSync(path.join(dir, name), data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
  const reasons = Object.fromEntries([...result.kept, ...result.failed].map((item) => [path.basename(item.archive), item.reason]));
  for (const name of Object.keys(cases)) {
    assert.ok(reasons[name] !== undefined, name);
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  }
  // tar.exe가 성공으로 푼 것은 확인 단계의 사유로 남는다.
  const kept = Object.fromEntries(result.kept.map((item) => [path.basename(item.archive), item.reason]));
  const expect = {
    'cut.tar.gz': /gzip이 손상됐거나 잘렸거나/,
    'concat.tar.gz': /tar 끝 표시 뒤에 다른 데이터/,
    'junk.tgz': /gzip이 손상됐거나 잘렸거나 뒤에 다른 데이터/,
    'zero-gap.tar.gz': /gzip 끝 뒤에 다른 데이터/,
    'after-end.tar.gz': /tar 끝 표시 뒤에 다른 데이터/,
    'no-end.tar.gz': /tar 끝 표시가 없어/,
    'plain.tar.gz': /gzip으로 시작하지 않아/,
  };
  for (const [name, reason] of Object.entries(expect)) if (kept[name] !== undefined) assert.match(kept[name], reason, name);
  // 이어 붙인 gzip과 끝 표시 뒤의 항목은 tar.exe가 성공으로 풀므로 반드시 확인 단계에서 걸려야 한다.
  for (const name of ['concat.tar.gz', 'after-end.tar.gz', 'junk.tgz', 'zero-gap.tar.gz']) assert.ok(kept[name] !== undefined, `${name}: ${reasons[name]}`);
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
  // tar.exe는 성공으로 풀지만 gzip CRC가 맞지 않는다(#197).
  assert.match(result.kept[0].reason, /gzip이 손상됐거나/);
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
    if (String(p).includes('.fctl-new') && options?.recursive) fs.utimesSync(file, new Date(1000), new Date(1000));
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
  assert.match(result.failed[0].reason, /풀었지만 원본을 확인하거나 휴지통으로 보내지 못했습니다/);
  assert.strictEqual(result.extracted.length, 2);
  assert.strictEqual(result.removed.length, 1);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt', 'b/y.txt']);
});

// 휴지통 이동이 사유를 밝힌 FcError로 실패해도 풀린 뒤라는 맥락을 붙인다(#185).
test('원본이 사용 중이라 휴지통으로 보내지 못하면 풀었다는 맥락과 Windows 사유를 함께 보고한다 (#185)', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const reason = Buffer.from('The process cannot access the file because it is being used by another process.', 'utf16le').toString('base64');
  onRecycle = () => {
    throw Object.assign(new Error('recycle'), { status: 77, stdout: `${reason}\r\n` });
  };
  const result = extractArchives(dir, { removeArchives: true });
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /^풀었지만 원본을 지우지 못했습니다\. 휴지통으로 보내지 못했습니다: .*a\.zip \(The process cannot access the file/);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});

test('경로가 길어 휴지통으로 보낼 수 없으면 풀었다는 맥락을 붙이고, 미리보기에서는 풀어도 지울 수 없다고 보고한다 (#185)', () => {
  const dir = tempDir();
  // 압축 파일 경로만 259자를 넘기고, 임시 폴더(.fctl-new-*, 약 32자)와 풀린 항목은 260자 안에 들어오게 한다(1차 리뷰).
  let folder = dir;
  while (folder.length < 200) folder = path.join(folder, 'x'.repeat(9));
  fs.mkdirSync(folder, { recursive: true });
  const archive = makeZip(folder, `${'y'.repeat(262 - folder.length - 5)}.zip`, { 'x.txt': 'x' });
  assert.ok(archive.length > 259 && folder.length + 40 < 260, `${archive.length} ${folder.length}`);
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  assert.match(preview.failed[0].reason, /^풀어도 원본을 지울 수 없습니다\. 경로가 \d+자라 휴지통으로 보낼 수 없습니다/);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.match(result.failed[0].reason, /^풀었지만 원본을 지우지 못했습니다\. 경로가 \d+자라 휴지통으로 보낼 수 없습니다/);
  assert.ok(fs.existsSync(archive));
  assert.ok(fs.existsSync(path.join(archive.slice(0, -'.zip'.length), 'x.txt')));
});

test('미리보기에서 원본을 확인하지 못하면 풀었다고 하지 않는다 (#185 1차 리뷰)', (t) => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const lstatSync = fs.lstatSync;
  let calls = 0;
  t.mock.method(fs, 'lstatSync', (p, options) => {
    // 풀기 전 식별값을 잡은 뒤, 지우기 직전 확인에서 실패하게 한다.
    if (path.basename(String(p)) === 'a.zip' && options?.bigint && ++calls === 2) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return lstatSync(p, options);
  });
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  t.mock.restoreAll();
  assert.match(preview.failed[0].reason, /^풀어도 원본을 확인하거나 휴지통으로 보낼 수 없습니다\. \(EPERM\)/);
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

// 무압축 Zip64 zip(#83). 중앙 디렉터리의 크기와 위치 칸을 모두 1로 두고 Zip64 extra 필드와 Zip64 끝 레코드에 적는다.
// change로 Zip64 끝 레코드의 값을 바꿀 수 있다.
function zip64Buffer(files, { change = {} } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(body);
    const localExtra = Buffer.alloc(20);
    localExtra.writeUInt16LE(1, 0);
    localExtra.writeUInt16LE(16, 2);
    localExtra.writeBigUInt64LE(BigInt(body.length), 4);
    localExtra.writeBigUInt64LE(BigInt(body.length), 12);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const centralExtra = Buffer.alloc(28);
    centralExtra.writeUInt16LE(1, 0);
    centralExtra.writeUInt16LE(24, 2);
    centralExtra.writeBigUInt64LE(BigInt(body.length), 4);
    centralExtra.writeBigUInt64LE(BigInt(body.length), 12);
    centralExtra.writeBigUInt64LE(BigInt(offset), 20);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(45, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(0xffffffff, 42);
    locals.push(local, nameBytes, localExtra, body);
    centrals.push(central, nameBytes, centralExtra);
    offset += local.length + nameBytes.length + localExtra.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const count = Object.keys(files).length;
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(change.onDisk ?? count), 24);
  record.writeBigUInt64LE(BigInt(change.total ?? count), 32);
  record.writeBigUInt64LE(BigInt(change.directorySize ?? directory.length), 40);
  record.writeBigUInt64LE(BigInt(change.directoryOffset ?? offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([...locals, directory, record, locator, end]);
}

test('Zip64 zip은 Zip64 끝 레코드와 extra 필드로 구조를 확인하고 지운다 (#83)', () => {
  const dir = tempDir();
  const good = path.join(dir, 'good.zip');
  fs.writeFileSync(good, zip64Buffer({ 'sub/': '', 'sub/x.txt': 'x', 'y.txt': 'yy' }));
  // 끝 레코드의 항목 수나 중앙 디렉터리 위치가 어긋나면 남긴다.
  fs.writeFileSync(path.join(dir, 'count.zip'), zip64Buffer({ 'x.txt': 'x' }, { change: { total: 2, onDisk: 2 } }));
  fs.writeFileSync(path.join(dir, 'offset.zip'), zip64Buffer({ 'x.txt': 'x' }, { change: { directoryOffset: 1 } }));
  fs.writeFileSync(path.join(dir, 'split.zip'), zip64Buffer({ 'x.txt': 'x' }, { change: { onDisk: 0 } }));
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.removed, [good]);
  assert.deepStrictEqual(recycled, [good]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'good', 'y.txt'), 'utf8'), 'yy');
  const reasons = Object.fromEntries([...result.kept, ...result.failed].map((item) => [path.basename(item.archive), item.reason]));
  for (const name of ['count.zip', 'offset.zip', 'split.zip']) {
    assert.ok(reasons[name] !== undefined, name);
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  }
  if (result.kept.some((item) => path.basename(item.archive) === 'split.zip')) assert.match(reasons['split.zip'], /분할 압축/);
});

test('tar.exe가 Zip64로 묶은 zip과 데이터 설명자를 쓴 보통 zip은 지운다 (#83)', () => {
  const dir = tempDir();
  const source = tempDir();
  fs.writeFileSync(path.join(source, 'a.txt'), 'A'.repeat(5000));
  fs.mkdirSync(path.join(source, 'sub'));
  fs.writeFileSync(path.join(source, 'sub', 'b.txt'), 'B');
  const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  realExecFileSync(tar, ['-a', '-cf', path.join(dir, 'z64.zip'), '--options', 'zip:zip64', '-C', source, 'a.txt', 'sub']);
  run(['zip', path.join(dir, 'plain.zip'), path.join(source, 'a.txt'), path.join(source, 'sub')]);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)).sort(), ['plain.zip', 'z64.zip']);
  assert.deepStrictEqual(tree(dir), ['plain/a.txt', 'plain/sub/b.txt', 'z64/a.txt', 'z64/sub/b.txt']);
});

test('중앙 디렉터리에 없는 항목이 사이에 끼면 풀리지 않으므로 지우지 않는다 (#83)', () => {
  const dir = tempDir();
  makeZip(dir, 'hidden.zip', { 'a.txt': 'a', 'secret.txt': 'hidden data', 'c.txt': 'c' }, { hide: ['secret.txt'] });
  makeZip(dir, 'last.zip', { 'a.txt': 'a', 'secret.txt': 'hidden data' }, { hide: ['secret.txt'] });
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  const reasons = Object.fromEntries(result.kept.map((item) => [path.basename(item.archive), item.reason]));
  assert.match(reasons['hidden.zip'], /항목 사이에 목록에 없는 데이터/);
  assert.match(reasons['last.zip'], /항목 사이에 목록에 없는 데이터/);
});

test('UTF-8 표시가 없는 한글 이름은 OEM 코드페이지로 읽어 그대로 풀렸는지 확인하고 지운다 (#83)', (t) => {
  const { oemCodePage } = require('../src/commands');
  if (oemCodePage() !== 949) return t.skip(`OEM 코드페이지 ${oemCodePage()}에서는 CP949 이름을 시험하지 않는다`);
  const dir = tempDir();
  // 한글.txt를 CP949로 적는다. 자리 표시 ABCD를 같은 길이의 바이트로 바꾼다.
  const hangul = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
  const data = zipBuffer({ 'ABCD.txt': 'x', 'ok.txt': 'o' });
  for (let at = data.indexOf('ABCD'); at !== -1; at = data.indexOf('ABCD', at + 4)) hangul.copy(data, at);
  fs.writeFileSync(path.join(dir, 'cp949.zip'), data);
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  assert.strictEqual(preview.removed.length, 1);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.strictEqual(result.removed.length, 1);
  assert.deepStrictEqual(tree(dir), ['cp949/ok.txt', 'cp949/한글.txt']);
});

test('fctl zip으로 묶은 한글 이름의 zip도 OEM 코드페이지로 확인하고 지운다 (#83)', (t) => {
  const { oemCodePage } = require('../src/commands');
  if (oemCodePage() !== 949) return t.skip(`OEM 코드페이지 ${oemCodePage()}에서는 한글 이름을 시험하지 않는다`);
  const dir = tempDir();
  const source = tempDir();
  fs.mkdirSync(path.join(source, '사진'));
  fs.writeFileSync(path.join(source, '사진', '여름.txt'), 'summer');
  run(['zip', path.join(dir, 'a.zip'), path.join(source, '사진')]);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.kept, []);
  assert.strictEqual(result.removed.length, 1);
  assert.deepStrictEqual(tree(dir), ['a/사진/여름.txt']);
});

// 손상 샘플(#83 1차 리뷰). 모두 지우지 않아야 한다. tar.exe가 풀지 못해 실패로 끝나도 된다.
test('구조가 어긋난 Zip64·데이터 설명자·겹친 항목 zip은 지우지 않는다 (#83)', () => {
  const dir = tempDir();
  const source = tempDir();
  const endOf = (buf) => buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  // 중앙 디렉터리의 n번째 항목 위치를 찾는다(32비트 zip).
  const centralAt = (buf, n) => {
    let pos = buf.readUInt32LE(endOf(buf) + 16);
    for (let i = 0; i < n; i += 1) pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    return pos;
  };
  const cases = {};
  // 두 항목이 같은 로컬 헤더를 가리킨다.
  const same = zipBuffer({ 'a.txt': 'a', 'b.txt': 'b' });
  same.writeUInt32LE(0, centralAt(same, 1) + 42);
  cases['same-offset.zip'] = same;
  // 데이터 설명자의 CRC가 중앙 디렉터리와 다르다.
  fs.writeFileSync(path.join(source, 'x.txt'), 'x'.repeat(100));
  run(['zip', path.join(source, 'desc.zip'), path.join(source, 'x.txt')]);
  const desc = fs.readFileSync(path.join(source, 'desc.zip'));
  const signature = desc.indexOf(Buffer.from('PK\x07\x08', 'latin1'));
  assert.notStrictEqual(signature, -1);
  desc[signature + 4] ^= 0xff;
  cases['descriptor-crc.zip'] = desc;
  // Zip64 extra 필드의 칸이 모자란다(로컬 헤더 위치가 빠짐).
  const shortExtra = zip64Buffer({ 'x.txt': 'x' });
  const extraAt = shortExtra.indexOf(Buffer.from('PK\x01\x02', 'latin1')) + 46 + 'x.txt'.length;
  shortExtra.writeUInt16LE(16, extraAt + 2);
  cases['zip64-short-extra.zip'] = shortExtra;
  // Zip64 위치 표시가 끝 레코드가 아닌 곳을 가리킨다.
  const noRecord = zip64Buffer({ 'x.txt': 'x' });
  noRecord.writeBigUInt64LE(0n, endOf(noRecord) - 20 + 8);
  cases['zip64-no-record.zip'] = noRecord;
  // 32비트 끝 레코드의 중앙 디렉터리 크기가 표시값도 아니고 Zip64 값과도 다르다.
  const mismatch = zip64Buffer({ 'x.txt': 'x' });
  mismatch.writeUInt32LE(5, endOf(mismatch) + 12);
  cases['zip64-mismatch.zip'] = mismatch;
  // 이 디스크의 항목 수와 전체 항목 수가 다르다.
  const counts = zipBuffer({ 'a.txt': 'a', 'b.txt': 'b' });
  counts.writeUInt16LE(1, endOf(counts) + 8);
  cases['disk-count.zip'] = counts;
  for (const [name, data] of Object.entries(cases)) fs.writeFileSync(path.join(dir, name), data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
  const reasons = Object.fromEntries([...result.kept, ...result.failed].map((item) => [path.basename(item.archive), item.reason]));
  for (const name of Object.keys(cases)) {
    assert.ok(reasons[name] !== undefined, name);
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  }
  const kept = Object.fromEntries(result.kept.map((item) => [path.basename(item.archive), item.reason]));
  const expect = {
    'same-offset.zip': /겹쳐|항목 수가 풀린 목록과 달라/,
    'descriptor-crc.zip': /데이터 설명자가 중앙 디렉터리와 달라/,
    'zip64-short-extra.zip': /Zip64 구조를 읽지 못해/,
    'zip64-no-record.zip': /Zip64 구조를 읽지 못해/,
    'zip64-mismatch.zip': /구조가 파일 크기와 맞지 않아/,
    'disk-count.zip': /분할 압축/,
  };
  for (const [name, reason] of Object.entries(expect)) if (kept[name] !== undefined) assert.match(kept[name], reason, name);
});

test('1MB를 넘는 항목 뒤의 숨은 데이터도 잡고, 정상이면 지운다 (#83)', () => {
  const dir = tempDir();
  const big = 'b'.repeat(1.5 * 1024 * 1024);
  const good = makeZip(dir, 'good.zip', { 'big.bin': big, 'small.txt': 's', 'big2.bin': big });
  makeZip(dir, 'hidden.zip', { 'big.bin': big, 'secret.txt': 'hidden', 'small.txt': 's' }, { hide: ['secret.txt'] });
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, [good]);
  assert.match(result.kept.find((item) => path.basename(item.archive) === 'hidden.zip').reason, /항목 사이에 목록에 없는 데이터/);
});
