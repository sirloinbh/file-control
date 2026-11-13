'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// So that the test does not touch the user's Recycle Bin, the Recycle Bin call is swapped for a fake before commands.js is imported.
const realExecFileSync = childProcess.execFileSync;
const recycled = [];
let onRecycle = () => {};
// File system check (#184). By default it answers NTFS, and each test swaps it to imitate exFAT and so on.
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

// An uncompressed zip. If cut is 'entries', it becomes a file cut after the entries, and if 'directory', a file cut in the middle of the central directory.
// For names in hide, only the local entry is put in and it is left out of the central directory.
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
  assert.match(formatExtractions(result), /Extract 2, Recycle Bin 2, kept 0, skipped 0, failed 0/);
});

test('exFAT 볼륨이면 풀기만 하고 압축 파일은 남긴다 (#184)', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  format = () => 'exFAT\r\n';
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  assert.match(preview.kept[0].reason, /^Kept because exFAT volumes do not record change times/);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(result.kept.map((item) => item.reason.slice(0, 18)), ['Kept because exFAT']);
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
  for (const item of result.kept) assert.match(item.reason, /cannot be confirmed that the extracted content of this format is intact/);
  for (const name of kept) assert.ok(fs.existsSync(path.join(dir, name)));
  assert.match(formatExtractions(result), /Kept: k\.tar \(/);
});

// Zips that must not be deleted. tar.exe either extracts only part without an error or extracts with names changed.
test('구조가 맞지 않는 zip은 풀려도 지우지 않는다', () => {
  const inner = zipBuffer({ 'inner1.txt': '1', 'inner2.txt': '2' });
  const whole = zipBuffer({ 'a.txt': 'a', 'inner.zip': inner });
  const after = whole.indexOf(inner) + inner.length;
  const first = zipBuffer({ 'A1.txt': '1', 'A2.txt': '2' });
  const second = zipBuffer({ 'B1.txt': 'b' });
  const cases = {
    'cut-inner.zip': [whole.subarray(0, after), /zip structure does not match the file size/],
    'joined.zip': [Buffer.concat([first, second]), /zip structure does not match the file size/],
    'in-comment.zip': [zipBuffer({ 'real.txt': 'r' }, { comment: second.toString('latin1') }), /zip structure does not match the file size/],
    'tail.zip': [Buffer.concat([zipBuffer({ 'x.txt': 'x' }), Buffer.from('trailing')]), /other data after the zip end marker/],
    'head.zip': [Buffer.concat([Buffer.from('prefix'), zipBuffer({ 'x.txt': 'x' })]), /does not start as a zip/],
    'split.zip': [zipBuffer({ 'x.txt': 'x' }, { disk: 1 }), /split archive/],
  };
  const dir = tempDir();
  for (const [name, [data]] of Object.entries(cases)) fs.writeFileSync(path.join(dir, name), data);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
  const reasons = Object.fromEntries([...result.kept, ...result.failed].map((item) => [path.basename(item.archive), item.reason]));
  // Whatever tar.exe could not extract may stay a failure. Not deleting is the point.
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
  assert.match(result.kept[0].reason, /at the start of the zip that is not in the directory/);
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
  for (const item of result.kept) assert.match(item.reason, /after the end of the 7z/);
});

// It reads the 7z header (including a compressed header) and checks the UTF-16 names and the CRC (#198).
test('ASCII가 아닌 이름의 .7z도 헤더의 이름 그대로 풀렸는지 확인하고 지운다 (#198)', () => {
  const dir = tempDir();
  const source = tempDir();
  // tar.exe ends abnormally on names not in ANSI, so it uses letters in the code page.
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
  // The archive folder is 230 characters: the final extraction folder (...\a) is within 258 characters, but the temporary folder (...\.fctl-new-<pid>-<time>-0) exceeds it.
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
  const limit = 258 - 4 - `.fctl-new-${process.pid}-${Date.now()}-0`.length - 1;
  assert.strictEqual(reasons[0], `The path of the folder holding the archive is 230 characters, so tar.exe cannot change into the temporary folder created inside it when extracting (the -C folder can be up to 258 characters). Move the archive to a folder of ${limit} characters or fewer and run again.`);
  assert.deepStrictEqual(fs.readdirSync(folder), ['a.zip']);
});

test('extract-all의 임시 폴더 판정 경계: 알려 준 한도의 폴더는 풀고 한 글자 더 길면 거부한다 (#238 1차 리뷰)', () => {
  const dir = tempDir();
  const limit = 258 - 4 - `.fctl-new-${process.pid}-${Date.now()}-0`.length - 1;
  const folderOf = (length) => {
    let folder = dir;
    while (folder.length < length - 20) folder = path.join(folder, 'x'.repeat(9));
    return path.join(folder, 'y'.repeat(length - folder.length - 1));
  };
  const fits = folderOf(limit);
  const over = folderOf(limit + 1);
  assert.strictEqual(fits.length, limit);
  assert.strictEqual(over.length, limit + 1);
  makeZip(fits, 'a.zip', { 'x.txt': 'x' });
  makeZip(over, 'b.zip', { 'y.txt': 'y' });
  const result = extractArchives(dir);
  assert.deepStrictEqual(result.extracted.map((item) => item.name), ['a']);
  assert.deepStrictEqual(result.failed.map((item) => path.basename(item.archive)), ['b.zip']);
  assert.strictEqual(fs.readFileSync(path.join(fits, 'a', 'x.txt'), 'utf8'), 'x');
});

test('extract-all은 외부 프로그램이 필요한 압축 내용(lz4)을 풀지 못하면 프로그램 이름을 사유로 알리고 원본을 남긴다 (#241)', (t) => {
  const dir = tempDir();
  // The name is .tar.gz but the content is lz4. tar.exe identifies it by content and tries to run lz4.
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x64, 0x70, 0xb9, 1, 2, 3, 4]));
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  process.env.PATH = path.join(dir, 'nothing');
  for (const dryRun of [true, false]) {
    const result = extractArchives(dir, { removeArchives: true, dryRun });
    assert.deepStrictEqual(recycled, []);
    assert.strictEqual(result.failed.length, 1);
    assert.match(result.failed[0].reason, /needs the external program lz4, but it could not be run/);
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
  // A 7z with only a folder CRC is not checked by tar.exe and extracts even if the body changed (the case that was being deleted in the first review).
  const folderOnly = sevenZipBuffer([{ name: 'z.txt', data: 'hello' }], { folderCrcOnly: true });
  folderOnly[folderOnly.indexOf('hello')] = 0x6a;
  fs.writeFileSync(path.join(dir, 'folder-crc.7z'), folderOnly);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.removed.map((p) => path.basename(p)), ['with-crc.7z']);
  const kept = Object.fromEntries(result.kept.map((item) => [path.basename(item.archive), item.reason]));
  assert.match(kept['no-crc.7z'], /has no CRC/);
  assert.match(kept['changed.7z'], /has no CRC/);
  assert.match(kept['gap.7z'], /not in the listing/);
  assert.match(kept['folder-crc.7z'], /has no CRC/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'folder-crc', 'z.txt'), 'utf8'), 'jello');
  // tar.exe also extracts a 7z with no CRC and a changed body as a success (the reason it is not deleted).
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
  // It deletes only the real.tar.gz whose content is right (#197).
  assert.deepStrictEqual(recycled, [path.join(dir, 'real.tar.gz')]);
  const reason = (name) => result.kept.find((item) => path.basename(item.archive) === name)?.reason;
  assert.match(reason('fake.7z'), /does not start as a 7z/);
  assert.match(reason('fake2.zip'), /does not start as a zip/);
  assert.match(reason('fake3.tgz'), /does not start as gzip/);
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
  for (const name of ['colon.zip', 'question.zip', 'drive.zip']) assert.match(kept[name], /an item would get a different name when extracted/);
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
  // tar.exe cannot handle characters not in the code page, so this cannot be tested on English Windows.
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
  assert.match(result.failed[0].reason, /the file changed after extracting/);
});

test('푸는 동안 같은 크기와 수정 시각으로 제자리에서 다시 써도 지우지 않는다', (t) => {
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  // utimesSync cannot restore the digits below ms exactly, so it sets the modification time to a ms-unit value and restores it to that value.
  // That way the file ID, size, and modification time are all the same as before extracting.
  const old = new Date(Date.now() - 3600 * 1000 - 123);
  fs.utimesSync(file, old, old);
  // Another zip whose structure is intact and whose names and sizes are also the same, so it passes the content check.
  const other = zipBuffer({ 'x.txt': 'y' });
  const original = fs.lstatSync(file, { bigint: true });
  const before = fileStamp(original);
  const readdirSync = fs.readdirSync;
  let rewritten = false;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (String(p).includes('.fctl-new') && options?.recursive) {
      // The change time is written in clock ticks and cannot be told apart within the same tick, so it rewrites until the identification value differs (#116).
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
  // The swap shows up only in the change time.
  const after = fs.lstatSync(file, { bigint: true });
  assert.deepStrictEqual([after.ino, after.size, after.mtimeNs], [original.ino, original.size, original.mtimeNs]);
  assert.notStrictEqual(after.ctimeNs, original.ctimeNs);
  assert.ok(fs.readFileSync(file).equals(other));
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(result.removed, []);
  assert.match(result.failed[0].reason, /the file changed after extracting/);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});

test('파일 번호가 2^53을 넘어도 하나만 달라진 것을 알아챈다', (t) => {
  // ReFS file IDs exceed 2^53. Comparing as numbers would make the two values below equal.
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
  assert.match(result.failed[0].reason, /the file changed after extracting/);
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
  assert.match(result.kept[0].reason, /zip end marker is missing/);
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

// One tar header (512 bytes). It fills in the checksum too.
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

// A tar made of file entries and an end marker (two zero blocks). If end is false, no end marker is put.
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
  // tar.exe on English Windows (CI) ends abnormally (0xC0000005) on Hangul names not in ANSI, so they are included only when it is 949.
  // pax UTF-8 names are looked at separately in test/tarGzScan.test.js.
  const hangul = require('../src/commands').oemCodePage() === 949;
  const named = hangul ? '한글 이름.txt' : 'space name.txt';
  fs.writeFileSync(path.join(source, 'sub', named), '한');
  fs.writeFileSync(path.join(source, 'sub', 'deep', `${'n'.repeat(120)}.txt`), 'long');
  // Bundling with -C source . makes a ./ entry, and tar.exe reads the name as Unicode and writes it in pax as UTF-8.
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
    // Truncated at the end: the gzip end (CRC and length) is missing.
    'cut.tar.gz': good.subarray(0, good.length - 6),
    // Concatenated gzip: tar.exe stops at the end marker of the first tar and does not extract y.txt.
    'concat.tar.gz': Buffer.concat([good, other]),
    // Other data after the gzip
    'junk.tgz': Buffer.concat([good, Buffer.from('garbage')]),
    // If what follows a member starts with 0x00, both Node and tar.exe discard the rest without an error (the case that was being deleted in the first review).
    'zero-gap.tar.gz': Buffer.concat([good, Buffer.alloc(1), other]),
    // An entry after the end marker
    'after-end.tar.gz': zlib.gzipSync(tarBuffer({ 'x.txt': 'ok' }, { after: tarBuffer({ 'z.txt': 'hidden' }) })),
    // There is no end marker (a tar cut at an entry boundary and wrapped in gzip again)
    'no-end.tar.gz': zlib.gzipSync(tarBuffer({ 'x.txt': 'ok' }, { end: false })),
    // The name is .tar.gz but it is not gzip.
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
  // What tar.exe extracted as a success stays as the reason of the check step.
  const kept = Object.fromEntries(result.kept.map((item) => [path.basename(item.archive), item.reason]));
  const expect = {
    'cut.tar.gz': /gzip is damaged, truncated/,
    'concat.tar.gz': /other data after the tar end marker/,
    'junk.tgz': /gzip is damaged, truncated, or has other data after it/,
    'zero-gap.tar.gz': /other data after the end of the gzip/,
    'after-end.tar.gz': /other data after the tar end marker/,
    'no-end.tar.gz': /tar end marker is missing/,
    'plain.tar.gz': /does not start as gzip/,
  };
  for (const [name, reason] of Object.entries(expect)) if (kept[name] !== undefined) assert.match(kept[name], reason, name);
  // A concatenated gzip and an entry after the end marker are extracted as a success by tar.exe, so they must be caught in the check step.
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
  // tar.exe extracts it as a success but the gzip CRC does not match (#197).
  assert.match(result.kept[0].reason, /gzip is damaged/);
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
  assert.match(result.failed[0].reason, /the file changed after extracting/);
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
  assert.match(result.failed[0].reason, /Extracted, but could not check the original or send it to the Recycle Bin/);
  assert.strictEqual(result.extracted.length, 2);
  assert.strictEqual(result.removed.length, 1);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt', 'b/y.txt']);
});

// Even if the Recycle Bin move fails with an FcError that states a reason, the context that it is after extraction is added (#185).
test('원본이 사용 중이라 휴지통으로 보내지 못하면 풀었다는 맥락과 Windows 사유를 함께 보고한다 (#185)', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const reason = Buffer.from('The process cannot access the file because it is being used by another process.', 'utf16le').toString('base64');
  onRecycle = () => {
    throw Object.assign(new Error('recycle'), { status: 77, stdout: `${reason}\r\n` });
  };
  const result = extractArchives(dir, { removeArchives: true });
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /^Extracted, but could not delete the original\. Could not send to the Recycle Bin: .*a\.zip \(The process cannot access the file/);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});

test('경로가 길어 휴지통으로 보낼 수 없으면 풀었다는 맥락을 붙이고, 미리보기에서는 풀어도 지울 수 없다고 보고한다 (#185)', () => {
  const dir = tempDir();
  // Only the archive path exceeds 259 characters, and the temporary folder (.fctl-new-*, about 32 characters) and the extracted items are made to fit within 260 characters (first review).
  let folder = dir;
  while (folder.length < 200) folder = path.join(folder, 'x'.repeat(9));
  fs.mkdirSync(folder, { recursive: true });
  const archive = makeZip(folder, `${'y'.repeat(262 - folder.length - 5)}.zip`, { 'x.txt': 'x' });
  assert.ok(archive.length > 259 && folder.length + 40 < 260, `${archive.length} ${folder.length}`);
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  assert.match(preview.failed[0].reason, /^Even if extracted, the original cannot be deleted\. The path is \d+ characters, so it cannot be sent to the Recycle Bin/);
  const result = extractArchives(dir, { removeArchives: true });
  assert.deepStrictEqual(recycled, []);
  assert.match(result.failed[0].reason, /^Extracted, but could not delete the original\. The path is \d+ characters, so it cannot be sent to the Recycle Bin/);
  assert.ok(fs.existsSync(archive));
  assert.ok(fs.existsSync(path.join(archive.slice(0, -'.zip'.length), 'x.txt')));
});

test('미리보기에서 원본을 확인하지 못하면 풀었다고 하지 않는다 (#185 1차 리뷰)', (t) => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  const lstatSync = fs.lstatSync;
  let calls = 0;
  t.mock.method(fs, 'lstatSync', (p, options) => {
    // After taking the identification value before extracting, it makes the check right before deleting fail.
    if (path.basename(String(p)) === 'a.zip' && options?.bigint && ++calls === 2) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return lstatSync(p, options);
  });
  const preview = extractArchives(dir, { removeArchives: true, dryRun: true });
  t.mock.restoreAll();
  assert.match(preview.failed[0].reason, /^Even if extracted, the original cannot be checked or sent to the Recycle Bin\. \(EPERM\)/);
});

test('대화형 세션이 아니라는 거부를 그대로 보고하고 영구 삭제하지 않는다', () => {
  const dir = tempDir();
  const file = makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  onRecycle = () => {
    throw Object.assign(new Error('non-interactive'), { status: 75 });
  };
  const result = extractArchives(dir, { removeArchives: true });
  assert.match(result.failed[0].reason, /outside an interactive session/);
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
  assert.match(report, /\[Preview\] Move to the Recycle Bin: a\.zip/);
  assert.match(report, /\[Preview\] Kept: cut\.zip/);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(tree(dir), ['a.zip', 'cut.zip']);
});

test('--remove-archives 옵션은 extract-all에서만 받고 지우지 못하면 오류로 끝낸다', () => {
  const dir = tempDir();
  makeZip(dir, 'a.zip', { 'x.txt': 'x' });
  for (const command of [['flatten', dir], ['product-number', dir], ['unzip', path.join(dir, 'a.zip')], ['rm', path.join(dir, 'a.zip')]]) {
    assert.throws(() => run([...command, '--remove-archives']), /used only with extract-all/);
  }
  assert.ok(fs.existsSync(path.join(dir, 'a.zip')));
  onRecycle = () => {
    throw Object.assign(new Error('recycle'), { status: 1 });
  };
  assert.throws(() => run(['extract-all', dir, '--remove-archives']), (err) => err instanceof FcError && /Failed: a\.zip/.test(err.message));
  onRecycle = () => {};
  assert.deepStrictEqual(tree(dir), ['a.zip', 'a/x.txt']);
});

// An uncompressed Zip64 zip (#83). It sets the size and position fields of the central directory all to 1 and writes them in the Zip64 extra field and the Zip64 end record.
// change can alter a value of the Zip64 end record.
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
  // If the entry count or the central directory position of the end record is off, it keeps it.
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
  if (result.kept.some((item) => path.basename(item.archive) === 'split.zip')) assert.match(reasons['split.zip'], /split archive/);
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
  assert.match(reasons['hidden.zip'], /data between zip entries that is not in the directory/);
  assert.match(reasons['last.zip'], /data between zip entries that is not in the directory/);
});

test('UTF-8 표시가 없는 한글 이름은 OEM 코드페이지로 읽어 그대로 풀렸는지 확인하고 지운다 (#83)', (t) => {
  const { oemCodePage } = require('../src/commands');
  if (oemCodePage() !== 949) return t.skip(`OEM 코드페이지 ${oemCodePage()}에서는 CP949 이름을 시험하지 않는다`);
  const dir = tempDir();
  // It writes 한글.txt (a Hangul file name) in CP949. It replaces the placeholder ABCD with bytes of the same length.
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

// Damaged samples (#83 first review). None of them may be deleted. It is fine if tar.exe cannot extract them and it ends in failure.
test('구조가 어긋난 Zip64·데이터 설명자·겹친 항목 zip은 지우지 않는다 (#83)', () => {
  const dir = tempDir();
  const source = tempDir();
  const endOf = (buf) => buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  // It finds the position of the nth entry of the central directory (32-bit zip).
  const centralAt = (buf, n) => {
    let pos = buf.readUInt32LE(endOf(buf) + 16);
    for (let i = 0; i < n; i += 1) pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    return pos;
  };
  const cases = {};
  // Two entries point to the same local header.
  const same = zipBuffer({ 'a.txt': 'a', 'b.txt': 'b' });
  same.writeUInt32LE(0, centralAt(same, 1) + 42);
  cases['same-offset.zip'] = same;
  // The CRC of the data descriptor differs from the central directory.
  fs.writeFileSync(path.join(source, 'x.txt'), 'x'.repeat(100));
  run(['zip', path.join(source, 'desc.zip'), path.join(source, 'x.txt')]);
  const desc = fs.readFileSync(path.join(source, 'desc.zip'));
  const signature = desc.indexOf(Buffer.from('PK\x07\x08', 'latin1'));
  assert.notStrictEqual(signature, -1);
  desc[signature + 4] ^= 0xff;
  cases['descriptor-crc.zip'] = desc;
  // The Zip64 extra field is short of fields (the local header position is missing).
  const shortExtra = zip64Buffer({ 'x.txt': 'x' });
  const extraAt = shortExtra.indexOf(Buffer.from('PK\x01\x02', 'latin1')) + 46 + 'x.txt'.length;
  shortExtra.writeUInt16LE(16, extraAt + 2);
  cases['zip64-short-extra.zip'] = shortExtra;
  // The Zip64 locator points to a place that is not the end record.
  const noRecord = zip64Buffer({ 'x.txt': 'x' });
  noRecord.writeBigUInt64LE(0n, endOf(noRecord) - 20 + 8);
  cases['zip64-no-record.zip'] = noRecord;
  // The central directory size of the 32-bit end record is neither the marker value nor the same as the Zip64 value.
  const mismatch = zip64Buffer({ 'x.txt': 'x' });
  mismatch.writeUInt32LE(5, endOf(mismatch) + 12);
  cases['zip64-mismatch.zip'] = mismatch;
  // The entry count of this disk differs from the total entry count.
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
    'same-offset.zip': /overlap|number of zip entries differs from the extracted list/,
    'descriptor-crc.zip': /data descriptor differs from the central directory/,
    'zip64-short-extra.zip': /Zip64 structure could not be read/,
    'zip64-no-record.zip': /Zip64 structure could not be read/,
    'zip64-mismatch.zip': /zip structure does not match the file size/,
    'disk-count.zip': /split archive/,
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
  assert.match(result.kept.find((item) => path.basename(item.archive) === 'hidden.zip').reason, /data between zip entries that is not in the directory/);
});
