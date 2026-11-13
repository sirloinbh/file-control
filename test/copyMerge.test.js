'use strict';

// When merging folders with cp --force, if the inner kinds mismatch or there is a link in the target, nothing is copied (#140).
// fs.cpSync ends Node without an error when a file is where a folder is, so if this check is missing, the test run itself ends.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('../src/commands');

const isWindows = process.platform === 'win32';

// It makes root/src (with a.txt) and root/dst/src (the folder to merge). cp copies under the same name inside dst, so it merges with dst/src.
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-merge-')));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  const into = path.join(root, 'dst', 'src');
  fs.mkdirSync(src);
  fs.mkdirSync(into, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'A');
  return { root, src, into, dst: path.join(root, 'dst') };
}

const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

test('cp --force는 원본의 폴더 자리에 대상의 파일이 있으면 아무것도 복사하지 않고 거부한다 (#140)', () => {
  const { src, into, dst } = fixture();
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'x.txt'), 'x');
  fs.writeFileSync(path.join(into, 'sub'), 'FILE');
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([src], dst, { force: true, dryRun }), (err) => err instanceof fc.FcError && /A file and a folder do not match/.test(err.message) && err.message.includes(path.join(into, 'sub')), `dryRun=${dryRun}`);
  }
  assert.deepStrictEqual(tree(into), ['sub']);
  assert.strictEqual(fs.readFileSync(path.join(into, 'sub'), 'utf8'), 'FILE');
});

test('cp --force는 원본의 파일 자리에 대상의 폴더가 있으면 아무것도 복사하지 않고 거부한다 (#140)', () => {
  const { src, into, dst } = fixture();
  fs.writeFileSync(path.join(src, 'sub'), 'FILE');
  fs.mkdirSync(path.join(into, 'sub'));
  fs.writeFileSync(path.join(into, 'sub', 'keep.txt'), 'k');
  assert.throws(() => fc.copy([src], dst, { force: true }), /A file and a folder do not match/);
  // Before, it copied a.txt and then failed with EIO.
  assert.deepStrictEqual(tree(into), ['sub', path.join('sub', 'keep.txt')]);
});

test('cp --force는 맨 위 대상이 종류가 다르면 미리보기가 아니어도 거부한다 (#140)', () => {
  const { root, src, dst } = fixture();
  fs.rmSync(path.join(dst, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dst, 'src'), 'FILE');
  assert.throws(() => fc.copy([src], dst, { force: true }), /A file and a folder cannot overwrite each other/);
  fs.mkdirSync(path.join(dst, 'a.txt'));
  assert.throws(() => fc.copy([path.join(src, 'a.txt')], dst, { force: true }), /A file and a folder cannot overwrite each other/);
  assert.deepStrictEqual(tree(dst), ['a.txt', 'src']);
  assert.ok(fs.existsSync(path.join(root, 'src', 'a.txt')));
});

test('cp --force는 합칠 대상 안의 링크를 따라 그 밖에 쓰지 않는다 (#140)', () => {
  const { root, src, into, dst } = fixture();
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'x.txt'), 'x');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(into, 'sub'), isWindows ? 'junction' : 'dir');
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([src], dst, { force: true, dryRun }), /folder to merge into contains a link/, `dryRun=${dryRun}`);
  }
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  assert.ok(!fs.existsSync(path.join(into, 'a.txt')));
});

test('cp --force는 종류가 맞는 폴더는 그대로 합친다 (#140)', () => {
  const { src, into, dst } = fixture();
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'x.txt'), 'new');
  fs.mkdirSync(path.join(into, 'sub'));
  fs.writeFileSync(path.join(into, 'sub', 'x.txt'), 'old');
  fs.writeFileSync(path.join(into, 'keep.txt'), 'k');
  fc.copy([src], dst, { force: true });
  assert.deepStrictEqual(tree(into), ['a.txt', 'keep.txt', 'sub', path.join('sub', 'x.txt')]);
  assert.strictEqual(fs.readFileSync(path.join(into, 'sub', 'x.txt'), 'utf8'), 'new');
});

const junction = (to, at) => fs.symlinkSync(to, at, isWindows ? 'junction' : 'dir');

test('cp --force는 원본의 정션이 대상의 파일이나 폴더 자리에 있으면 거부한다 (1차 리뷰, #140)', () => {
  const { root, src, into, dst } = fixture();
  fs.mkdirSync(path.join(root, 'empty'));
  junction(path.join(root, 'empty'), path.join(src, 'j'));
  // If the target is a file, cpSync ends Node without an error.
  fs.writeFileSync(path.join(into, 'j'), 'FILE');
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([src], dst, { force: true, dryRun }), /A source link sits where an item already exists/, `dryRun=${dryRun}`);
  }
  fs.rmSync(path.join(into, 'j'));
  fs.mkdirSync(path.join(into, 'j'));
  assert.throws(() => fc.copy([src], dst, { force: true }), /A source link sits where an item already exists/);
  assert.deepStrictEqual(tree(into), ['j']);
});

test('cp --force는 같은 이름의 원본 여럿이 서로 어긋나면 아무것도 복사하지 않고, 맞으면 합친다 (1차 리뷰, #140)', () => {
  const { root, dst } = fixture();
  for (const [dir, files] of [['a', { 'x/sub/in.txt': 'a' }], ['b', { 'x/sub': 'FILE' }], ['c', { 'x/sub/more.txt': 'c' }]]) {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, dir, rel), text);
    }
  }
  // dst/x does not exist yet. If b/x first makes sub a file, cpSync ends Node when merging a/x.
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([path.join(root, 'b', 'x'), path.join(root, 'a', 'x')], dst, { force: true, dryRun }), /A file and a folder do not match/, `dryRun=${dryRun}`);
  }
  assert.ok(!fs.existsSync(path.join(dst, 'x')));
  fc.copy([path.join(root, 'a', 'x'), path.join(root, 'c', 'x')], dst, { force: true });
  assert.deepStrictEqual(tree(path.join(dst, 'x')), ['sub', path.join('sub', 'in.txt'), path.join('sub', 'more.txt')]);
});

test('cp --force는 깊은 곳의 어긋남, 대소문자만 다른 이름, 맨 위 대상의 정션도 거부한다 (1차 리뷰, #140)', () => {
  const { root, src, into, dst } = fixture();
  fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a', 'b', 'c.txt'), 'c');
  fs.mkdirSync(path.join(into, 'a'));
  fs.writeFileSync(path.join(into, 'a', isWindows ? 'B' : 'b'), 'FILE');
  assert.throws(() => fc.copy([src], dst, { force: true }), /A file and a folder do not match/);
  assert.deepStrictEqual(tree(into), ['a', path.join('a', isWindows ? 'B' : 'b')]);
  // If the top-level target is a junction, it reports with an FcError instead of cpSync's raw error.
  fs.rmSync(into, { recursive: true });
  fs.mkdirSync(path.join(root, 'elsewhere'));
  junction(path.join(root, 'elsewhere'), into);
  assert.throws(() => fc.copy([src], dst, { force: true }), (err) => err instanceof fc.FcError && /destination to overwrite is a link/.test(err.message));
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'elsewhere')), []);
});

// The merge check does not go into junctions inside the source and so it ends, and a junction that points to a folder above is refused by the check of #142.
// If this check is missing, cpSync follows the junction and copies endlessly and ends Node, so the test run itself ends.
test('cp --force의 합치기 검사는 원본 안의 정션 안으로 들어가지 않아 위 폴더를 가리키는 정션에서도 끝난다 (1차 리뷰, #140)', () => {
  const { src, dst } = fixture();
  junction(src, path.join(src, 'loop'));
  assert.throws(() => fc.copy([src], dst, { force: true, dryRun: true }), /A link inside the source points to the source, the destination/);
});

const LOOP = /A link inside the source points to the source, the destination, or a folder above them, so the copy might never finish\. Nothing was copied: /;

test('cp는 원본 자신이나 그 위 폴더를 가리키는 정션이 든 폴더를 새 경로로도, 합치기로도 복사하지 않는다 (#142)', () => {
  const { root, src, into, dst } = fixture();
  fs.mkdirSync(path.join(src, 'deep', 'er'), { recursive: true });
  for (const [at, to] of [[path.join(src, 'loop'), src], [path.join(src, 'deep', 'er', 'up'), root]]) {
    junction(to, at);
    for (const dryRun of [false, true]) {
      assert.throws(() => fc.copy([src], path.join(root, 'fresh'), { dryRun }), (err) => err instanceof fc.FcError && LOOP.test(err.message) && err.message.includes(at), `${at} dryRun=${dryRun}`);
      assert.throws(() => fc.copy([src], dst, { force: true, dryRun }), LOOP, `merge ${at} dryRun=${dryRun}`);
    }
    fs.rmSync(at);
  }
  assert.ok(!fs.existsSync(path.join(root, 'fresh')));
  assert.deepStrictEqual(tree(into), []);
});

test('cp는 대상이나 그 위 폴더, 대상 안을 가리키는 정션이 든 폴더를 복사하지 않는다 (#142)', () => {
  const { root, src } = fixture();
  const out = path.join(root, 'out');
  // cp copies to dst/src inside dst, so out, dst, and dst/src are the target or folders above it, and dst/src/inner is inside the target.
  fs.mkdirSync(path.join(out, 'dst', 'src', 'inner'), { recursive: true });
  for (const to of [out, path.join(out, 'dst'), path.join(out, 'dst', 'src'), path.join(out, 'dst', 'src', 'inner')]) {
    junction(to, path.join(src, 'j'));
    assert.throws(() => fc.copy([src], path.join(out, 'dst'), { force: true }), LOOP, to);
    fs.rmSync(path.join(src, 'j'));
  }
  assert.deepStrictEqual(tree(path.join(out, 'dst')), ['src', path.join('src', 'inner')]);
});

test('cp는 원본 안이나 관계없는 곳을 가리키는 정션은 그 내용을 복사하고, 여러 원본 중 하나라도 걸리면 아무것도 복사하지 않는다 (#142)', () => {
  const { root, src } = fixture();
  fs.mkdirSync(path.join(src, 'inner'));
  fs.writeFileSync(path.join(src, 'inner', 'i.txt'), 'I');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'elsewhere', 'e.txt'), 'E');
  junction(path.join(src, 'inner'), path.join(src, 'in'));
  junction(path.join(root, 'elsewhere'), path.join(src, 'out'));
  fc.copy([src], path.join(root, 'copy'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'copy', 'in', 'i.txt'), 'utf8'), 'I');
  assert.strictEqual(fs.readFileSync(path.join(root, 'copy', 'out', 'e.txt'), 'utf8'), 'E');
  // If the second source has a junction that points to a folder above, the first source is not copied either.
  const looped = path.join(root, 'looped');
  fs.mkdirSync(looped);
  junction(root, path.join(looped, 'up'));
  fs.mkdirSync(path.join(root, 'many'));
  assert.throws(() => fc.copy([path.join(root, 'elsewhere'), looped], path.join(root, 'many')), LOOP);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'many')), []);
});

// If this check is missing, cpSync ends Node and the test run itself ends (first review).
test('cp는 원본 안의 자기 위 폴더나 정션 너머의 고리를 가리키는 링크도 찾아 거부한다 (1차 리뷰, #142)', () => {
  const { root, src } = fixture();
  fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
  const x = path.join(root, 'x');
  fs.mkdirSync(path.join(x, 'sub'), { recursive: true });
  const cases = [
    // A link inside the source points to a folder above itself (inside the source).
    [[path.join(src, 'a'), path.join(src, 'a', 'b', 'up')]],
    // Inside a folder outside the source, there is a junction that points to that folder itself.
    [[x, path.join(src, 'out')], [x, path.join(x, 'sub', 'self')]],
    // It comes back to the source through two junctions.
    [[x, path.join(src, 'out')], [src, path.join(x, 'back')]],
    // It points to the real parent folder of a folder beyond a junction.
    [[path.join(x, 'sub'), path.join(src, 'out')], [x, path.join(x, 'sub', 'parent')]],
  ];
  for (const links of cases) {
    for (const [to, at] of links) junction(to, at);
    for (const dryRun of [false, true]) {
      assert.throws(() => fc.copy([src], path.join(root, 'fresh'), { dryRun }), LOOP, `${links.map(([, at]) => path.relative(root, at)).join(', ')} dryRun=${dryRun}`);
    }
    for (const [, at] of links) fs.rmSync(at);
  }
  assert.ok(!fs.existsSync(path.join(root, 'fresh')));
  // Even if two junctions point to the same folder, it copies if there is no loop.
  junction(x, path.join(src, 'one'));
  junction(x, path.join(src, 'a', 'two'));
  fc.copy([src], path.join(root, 'twice'));
  assert.ok(fs.existsSync(path.join(root, 'twice', 'one', 'sub')) && fs.existsSync(path.join(root, 'twice', 'a', 'two', 'sub')));
});

test('cp는 원본 안의 폴더를 읽지 못하면 미리보기에서도 FcError로 알리고 아무것도 복사하지 않는다 (1차 리뷰, #142)', (t) => {
  const { root, src } = fixture();
  fs.mkdirSync(path.join(src, 'locked'));
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (path.basename(p) === 'locked') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return readdir(p, options);
  });
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([src], path.join(root, 'fresh'), { dryRun }), (err) => err instanceof fc.FcError && /Cannot read a folder inside the source.*locked \(EPERM\)$/.test(err.message));
  }
  assert.ok(!fs.existsSync(path.join(root, 'fresh')));
});

test('mv가 다른 드라이브로 옮길 때도 위 폴더를 가리키는 정션이 든 폴더는 복사하지 않고 그대로 둔다 (#142)', (t) => {
  const { root, src } = fixture();
  junction(src, path.join(src, 'loop'));
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  });
  assert.throws(() => fc.move([src], path.join(root, 'moved')), LOOP);
  assert.ok(!fs.existsSync(path.join(root, 'moved')));
  assert.deepStrictEqual(fs.readdirSync(src).sort(), ['a.txt', 'loop']);
});

test('cp --force는 같은 원본을 두 번 줘도 자기 자신과 비교해 거부하지 않는다 (2차 리뷰, #140)', () => {
  const { root, src, dst } = fixture();
  fs.mkdirSync(path.join(root, 'elsewhere'));
  junction(path.join(root, 'elsewhere'), path.join(src, 'j'));
  fs.rmSync(path.join(dst, 'src'), { recursive: true });
  fc.copy([src, src], dst, { force: true });
  assert.ok(fs.existsSync(path.join(dst, 'src', 'j')));
  assert.strictEqual(fs.readFileSync(path.join(dst, 'src', 'a.txt'), 'utf8'), 'A');
});
