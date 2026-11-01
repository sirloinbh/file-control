'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  const filled = fs.readdirSync(options.env.FC_TARGET, { recursive: true, withFileTypes: true }).find((entry) => !entry.isDirectory());
  if (filled) throw new Error(`비어 있지 않은 폴더를 휴지통으로 보내려 함: ${filled.name}`);
  fs.rmSync(options.env.FC_TARGET, { recursive: true });
  return Buffer.alloc(0);
});
test.beforeEach(() => {
  recycled.length = 0;
  onRecycle = () => {};
});

const { FcError } = require('../src/commands');
const { planCollapse, applyCollapse, collapse, formatCollapse } = require('../src/collapse');
const { run } = require('../bin/fctl');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-collapse-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const file of files) {
    const full = path.join(dir, file);
    if (file.endsWith('/')) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, file);
    }
  }
}

// 파일과 빈 폴더 목록
function tree(dir) {
  const all = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return all
    .filter((entry) => !entry.isDirectory() || fs.readdirSync(path.join(entry.parentPath, entry.name)).length === 0)
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/') + (entry.isDirectory() ? '/' : ''))
    .sort();
}

test('폴더 하나만 이어지는 구간을 맨 위 폴더 이름으로 접는다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/f.mp4', 'a/b/c/g.mp4']);
  const result = collapse(dir);
  assert.deepStrictEqual(tree(dir), ['a/f.mp4', 'a/g.mp4']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'f.mp4'), 'utf8'), 'a/b/c/f.mp4');
  assert.deepStrictEqual(result.collapsed[0].dropped, ['b', 'c']);
  assert.strictEqual(recycled.length, 1);
  assert.deepStrictEqual(result.failed, []);
});

test('한 단계에 항목이 여럿이면 그 구조를 유지하고 그 아래만 접는다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'a/b/c/y.txt', 'p/q/1/f1.txt', 'p/q/1/z/w/f3.txt', 'p/q/2/r/f2.txt']);
  collapse(dir);
  assert.deepStrictEqual(tree(dir), ['a/b/y.txt', 'a/x.txt', 'p/1/f1.txt', 'p/1/z/f3.txt', 'p/2/f2.txt']);
});

test('접을 것이 없으면 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  const files = ['a/f.txt', 'b/g.txt', 'b/c/h.txt', 'top.txt'];
  make(dir, files);
  const result = collapse(dir);
  assert.deepStrictEqual(tree(dir), [...files].sort());
  assert.deepStrictEqual(result.collapsed, []);
  assert.deepStrictEqual(recycled, []);
});

test('타겟 자신은 접지 않는다', () => {
  const dir = tempDir();
  make(dir, ['only/f.txt']);
  collapse(dir);
  assert.deepStrictEqual(tree(dir), ['only/f.txt']);
});

test('숨김 파일이 있는 단계도 항목이 여럿이므로 유지한다', () => {
  const dir = tempDir();
  make(dir, ['a/Thumbs.db', 'a/b/f.txt']);
  collapse(dir);
  assert.deepStrictEqual(tree(dir), ['a/Thumbs.db', 'a/b/f.txt']);
});

test('안쪽 이름이 가운데 폴더 이름이나 맨 위 이름과 같아도 충돌하지 않는다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/b', 'a/b/c/a/x.txt', 'a/b/c/c.txt']);
  const result = collapse(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(tree(dir), ['a/a/x.txt', 'a/b', 'a/c.txt']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'b'), 'utf8'), 'a/b/c/b');
});

test('끝이 빈 폴더인 구간은 빈 맨 위 폴더 하나로 접는다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/', 'k.txt']);
  collapse(dir);
  assert.deepStrictEqual(tree(dir), ['a/', 'k.txt']);
});

test('사라지는 폴더 이름에 제품번호가 있으면 접지 않고, 맨 위에도 있으면 접는다', () => {
  const dir = tempDir();
  make(dir, ['새 폴더/ABC-123/f.mp4', 'XYZ-999/XYZ-999 제목/g.mp4']);
  const result = collapse(dir);
  assert.deepStrictEqual(tree(dir), ['XYZ-999/g.mp4', '새 폴더/ABC-123/f.mp4']);
  assert.match(result.skipped[0].reason, /제품번호가 사라집니다: ABC-123/);
});

test('잔여물과 시스템 폴더, 링크가 든 구간은 접지 않고 보고한다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(outside, ['o.txt']);
  make(dir, ['.fctl-old-1-2-3/b/c/f.txt', '$RECYCLE.BIN/b/f.txt', 'l/m/']);
  fs.symlinkSync(outside, path.join(dir, 'l', 'm', 'lnk'), 'junction');
  const result = collapse(dir);
  assert.deepStrictEqual(result.collapsed, []);
  assert.strictEqual(result.skipped.length, 3);
  assert.ok(result.skipped.some((item) => /링크가 든 폴더/.test(item.reason)));
  assert.deepStrictEqual(fs.readdirSync(outside), ['o.txt']);
  assert.deepStrictEqual(recycled, []);
});

test('저장소가 들어 있으면 전체를 거부한다', () => {
  const dir = tempDir();
  make(dir, ['a/b/.git/config']);
  assert.throws(() => collapse(dir), /저장소가 들어 있어/);
  assert.deepStrictEqual(tree(dir), ['a/b/.git/config']);
});

test('계획 뒤에 구간에 파일이 생기면 그 구간을 접지 않고 파일을 지키며 나머지를 계속한다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/f.txt', 'p/q/g.txt']);
  const plan = planCollapse(dir);
  fs.writeFileSync(path.join(dir, 'a', 'new.txt'), '새 파일');
  const result = applyCollapse(plan);
  assert.match(result.failed[0].reason, /폴더 내용이 바뀌었습니다/);
  assert.deepStrictEqual(tree(dir), ['a/b/c/f.txt', 'a/new.txt', 'p/g.txt']);
});

test('계획 뒤에 구간이 정션으로 바뀌면 타겟 밖을 건드리지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(outside, ['q/g.txt']);
  make(dir, ['p/q/g.txt']);
  const plan = planCollapse(dir);
  fs.rmSync(path.join(dir, 'p'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'p'), 'junction');
  const result = applyCollapse(plan);
  assert.strictEqual(result.collapsed.length, 0);
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(tree(outside), ['q/g.txt']);
  assert.deepStrictEqual(recycled, []);
});

test('각 이름 변경이 실패하면 원래 구조로 되돌린다', (t) => {
  for (const failAt of [1, 2, 3]) {
    const dir = tempDir();
    make(dir, ['a/b/c/f.txt']);
    const renameSync = fs.renameSync;
    let count = 0;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      count += 1;
      if (count === failAt) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return renameSync(from, to);
    });
    const result = collapse(dir);
    mock.mock.restore();
    assert.match(result.failed[0].reason, /EBUSY/, `${failAt}번째`);
    assert.deepStrictEqual(tree(dir), ['a/b/c/f.txt'], `${failAt}번째`);
    assert.deepStrictEqual(result.collapsed, []);
  }
  assert.deepStrictEqual(recycled, []);
});

test('되돌리지도 못하면 위치를 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['a/b/c/f.txt']);
  const renameSync = fs.renameSync;
  let count = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    count += 1;
    if (count >= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return renameSync(from, to);
  });
  const result = collapse(dir);
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /되돌리지도 못했습니다.*\.fctl-new/);
  const lifted = fs.readdirSync(dir).find((name) => name.startsWith('.fctl-new'));
  assert.strictEqual(fs.readFileSync(path.join(dir, lifted, 'f.txt'), 'utf8'), 'a/b/c/f.txt');
});

test('빈 폴더를 휴지통으로 보내지 못하면 접은 결과를 두고 잔여 폴더를 알린다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/f.txt']);
  onRecycle = () => {
    throw Object.assign(new Error('non-interactive'), { status: 75 });
  };
  const result = collapse(dir);
  assert.strictEqual(result.collapsed.length, 1);
  assert.match(result.failed[0].reason, /빈 폴더를 휴지통으로 보내지 못했습니다.*\.fctl-old.*대화형 세션/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'f.txt'), 'utf8'), 'a/b/c/f.txt');
  // 잔여 폴더는 다시 실행해도 접지 않는다.
  assert.strictEqual(collapse(dir).collapsed.length, 0);
});

test('다시 실행해도 더 접지 않는다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/f.txt']);
  collapse(dir);
  const again = collapse(dir);
  assert.deepStrictEqual(again.collapsed, []);
  assert.deepStrictEqual(tree(dir), ['a/f.txt']);
});

test('미리보기는 아무것도 바꾸지 않고 같은 계획을 보여 준다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/f.txt']);
  const result = collapse(dir, { dryRun: true });
  assert.deepStrictEqual(tree(dir), ['a/b/c/f.txt']);
  assert.deepStrictEqual(recycled, []);
  assert.match(formatCollapse(result), /\[미리보기\] 접기: a[\\/]b[\\/]c -> a\n\[미리보기\] 접기 1개, 건너뜀 0개, 실패 0개/);
});

test('보호 경로는 거부한다', () => {
  assert.throws(() => collapse(process.env.SystemRoot ?? 'C:\\Windows'), FcError);
});

test('collapse 명령은 결과를 보여 주고 실패가 있으면 오류로 끝낸다', (t) => {
  const dir = tempDir();
  make(dir, ['a/b/f.txt']);
  assert.match(run(['collapse', dir, '--dry-run']), /\[미리보기\] 접기 1개/);
  const mock = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  assert.throws(() => run(['collapse', dir]), (err) => err instanceof FcError && /실패: a /.test(err.message));
  mock.mock.restore();
  assert.match(run(['collapse', dir]), /접기: a[\\/]b -> a\n접기 1개, 건너뜀 0개, 실패 0개/);
  assert.deepStrictEqual(tree(dir), ['a/f.txt']);
});

test('collapse 명령은 잘못된 인자를 거부한다', () => {
  const dir = tempDir();
  assert.throws(() => run(['collapse']), /사용법/);
  assert.throws(() => run(['collapse', dir, 'more']), /타겟은 하나만/);
  assert.throws(() => run(['collapse', 'C:']), /드라이브 문자/);
  assert.throws(() => run(['collapse', dir, '--force']), /--force/);
  assert.throws(() => run(['collapse', dir, '--permanent']), /--permanent/);
  assert.throws(() => run(['collapse', dir, '--remove-archives']), /extract-all에서만/);
});
