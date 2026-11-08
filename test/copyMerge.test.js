'use strict';

// cp --force로 폴더를 합칠 때 안쪽 종류가 어긋나거나 대상 안에 링크가 있으면 아무것도 복사하지 않는다(#140).
// fs.cpSync는 폴더 자리에 파일이 있으면 Node를 오류 없이 끝내므로, 이 검사가 빠지면 테스트 실행 자체가 끝난다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('../src/commands');

const isWindows = process.platform === 'win32';

// root/src(a.txt 포함)와 root/dst/src(합칠 폴더)를 만든다. cp는 dst 안에 같은 이름으로 복사하므로 dst/src와 합친다.
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
    assert.throws(() => fc.copy([src], dst, { force: true, dryRun }), (err) => err instanceof fc.FcError && /파일과 폴더가 어긋나/.test(err.message) && err.message.includes(path.join(into, 'sub')), `dryRun=${dryRun}`);
  }
  assert.deepStrictEqual(tree(into), ['sub']);
  assert.strictEqual(fs.readFileSync(path.join(into, 'sub'), 'utf8'), 'FILE');
});

test('cp --force는 원본의 파일 자리에 대상의 폴더가 있으면 아무것도 복사하지 않고 거부한다 (#140)', () => {
  const { src, into, dst } = fixture();
  fs.writeFileSync(path.join(src, 'sub'), 'FILE');
  fs.mkdirSync(path.join(into, 'sub'));
  fs.writeFileSync(path.join(into, 'sub', 'keep.txt'), 'k');
  assert.throws(() => fc.copy([src], dst, { force: true }), /파일과 폴더가 어긋나/);
  // 예전에는 a.txt를 복사한 뒤 EIO로 실패했다.
  assert.deepStrictEqual(tree(into), ['sub', path.join('sub', 'keep.txt')]);
});

test('cp --force는 맨 위 대상이 종류가 다르면 미리보기가 아니어도 거부한다 (#140)', () => {
  const { root, src, dst } = fixture();
  fs.rmSync(path.join(dst, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dst, 'src'), 'FILE');
  assert.throws(() => fc.copy([src], dst, { force: true }), /파일과 폴더는 서로 덮어쓸 수 없습니다/);
  fs.mkdirSync(path.join(dst, 'a.txt'));
  assert.throws(() => fc.copy([path.join(src, 'a.txt')], dst, { force: true }), /파일과 폴더는 서로 덮어쓸 수 없습니다/);
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
    assert.throws(() => fc.copy([src], dst, { force: true, dryRun }), /합칠 대상 안에 링크가 있어/, `dryRun=${dryRun}`);
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
  // 대상이 파일이면 cpSync가 Node를 오류 없이 끝낸다.
  fs.writeFileSync(path.join(into, 'j'), 'FILE');
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([src], dst, { force: true, dryRun }), /원본의 링크가 이미 있는 항목 자리에/, `dryRun=${dryRun}`);
  }
  fs.rmSync(path.join(into, 'j'));
  fs.mkdirSync(path.join(into, 'j'));
  assert.throws(() => fc.copy([src], dst, { force: true }), /원본의 링크가 이미 있는 항목 자리에/);
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
  // dst/x는 아직 없다. b/x가 먼저 sub를 파일로 만들면 a/x를 합칠 때 cpSync가 Node를 끝낸다.
  for (const dryRun of [false, true]) {
    assert.throws(() => fc.copy([path.join(root, 'b', 'x'), path.join(root, 'a', 'x')], dst, { force: true, dryRun }), /파일과 폴더가 어긋나/, `dryRun=${dryRun}`);
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
  assert.throws(() => fc.copy([src], dst, { force: true }), /파일과 폴더가 어긋나/);
  assert.deepStrictEqual(tree(into), ['a', path.join('a', isWindows ? 'B' : 'b')]);
  // 맨 위 대상이 정션이면 cpSync의 날것 오류 대신 FcError로 알린다.
  fs.rmSync(into, { recursive: true });
  fs.mkdirSync(path.join(root, 'elsewhere'));
  junction(path.join(root, 'elsewhere'), into);
  assert.throws(() => fc.copy([src], dst, { force: true }), (err) => err instanceof fc.FcError && /덮어쓸 대상이 링크라/.test(err.message));
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'elsewhere')), []);
});

// 합치기 검사는 원본 안의 정션 안으로 들어가지 않아 끝나고, 위 폴더를 가리키는 정션은 #142의 검사가 거부한다.
// 이 검사가 빠지면 cpSync가 정션을 따라 끝없이 복사하다 Node를 끝내므로 테스트 실행 자체가 끝난다.
test('cp --force의 합치기 검사는 원본 안의 정션 안으로 들어가지 않아 위 폴더를 가리키는 정션에서도 끝난다 (1차 리뷰, #140)', () => {
  const { src, dst } = fixture();
  junction(src, path.join(src, 'loop'));
  assert.throws(() => fc.copy([src], dst, { force: true, dryRun: true }), /원본 안의 링크가 원본이나 대상/);
});

const LOOP = /원본 안의 링크가 원본이나 대상, 또는 그 위 폴더를 가리켜 복사가 끝나지 않을 수 있습니다\. 아무것도 복사하지 않았습니다: /;

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
  // cp는 dst 안의 dst/src로 복사하므로 out, dst, dst/src는 대상이나 그 위 폴더이고 dst/src/inner는 대상 안이다.
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
  // 두 번째 원본에 위 폴더를 가리키는 정션이 있으면 첫 번째 원본도 복사하지 않는다.
  const looped = path.join(root, 'looped');
  fs.mkdirSync(looped);
  junction(root, path.join(looped, 'up'));
  fs.mkdirSync(path.join(root, 'many'));
  assert.throws(() => fc.copy([path.join(root, 'elsewhere'), looped], path.join(root, 'many')), LOOP);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'many')), []);
});

// 이 검사가 빠지면 cpSync가 Node를 끝내 테스트 실행 자체가 끝난다(1차 리뷰).
test('cp는 원본 안의 자기 위 폴더나 정션 너머의 고리를 가리키는 링크도 찾아 거부한다 (1차 리뷰, #142)', () => {
  const { root, src } = fixture();
  fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
  const x = path.join(root, 'x');
  fs.mkdirSync(path.join(x, 'sub'), { recursive: true });
  const cases = [
    // 원본 안의 링크가 자기 위 폴더(원본 안)를 가리킨다.
    [[path.join(src, 'a'), path.join(src, 'a', 'b', 'up')]],
    // 원본 밖 폴더 안에 그 폴더 자신을 가리키는 정션이 있다.
    [[x, path.join(src, 'out')], [x, path.join(x, 'sub', 'self')]],
    // 정션 두 개를 거쳐 원본으로 돌아온다.
    [[x, path.join(src, 'out')], [src, path.join(x, 'back')]],
    // 정션 너머 폴더의 실제 위 폴더를 가리킨다.
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
  // 같은 폴더를 가리키는 정션이 둘이어도 고리가 아니면 복사한다.
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
    assert.throws(() => fc.copy([src], path.join(root, 'fresh'), { dryRun }), (err) => err instanceof fc.FcError && /원본 안의 폴더를 읽을 수 없어 .*locked \(EPERM\)$/.test(err.message));
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
