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

// 실제 복사는 하지 않는다. 위 폴더를 가리키는 정션이 든 폴더는 cpSync가 새 경로로 복사할 때도 Node를 끝낸다(#142).
test('cp --force의 합치기 검사는 원본 안의 정션 안으로 들어가지 않아 위 폴더를 가리키는 정션에서도 끝난다 (1차 리뷰, #140)', () => {
  const { src, dst } = fixture();
  junction(src, path.join(src, 'loop'));
  assert.match(fc.copy([src], dst, { force: true, dryRun: true })[0], /^\[미리보기\] 복사: /);
});
