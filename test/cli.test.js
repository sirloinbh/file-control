'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fc = require('../src/commands');
const { run } = require('../bin/fctl');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cli-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// It collects all items and file contents under a folder. It is used to compare whether before and after a preview are the same.
function snapshot(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return [path.relative(dir, full), entry.isDirectory() ? null : fs.readFileSync(full, 'utf8')];
    })
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

// After running argv as a preview, it checks that nothing changed and returns the output.
function preview(dir, argv) {
  const before = snapshot(dir);
  const output = run([...argv, '--dry-run']);
  assert.deepStrictEqual(snapshot(dir), before, argv.join(' '));
  return output;
}

function fixture() {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'dest'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
  fs.writeFileSync(path.join(dir, 'dest', 'a.txt'), 'old');
  return dir;
}

test('--dry-run은 모든 변경 명령에서 할 일만 출력하고 아무것도 바꾸지 않는다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fc.zip(p('bundle.zip'), [p('a.txt'), p('b.txt')]);
  const cases = [
    [['mkdir', p('new', 'deep')], 'Create folder'],
    [['write', p('new', 'n.txt'), '내용'], 'Write file'],
    [['append', p('a.txt'), '더'], 'Append to file'],
    [['rename', p('a.txt'), 'c.txt'], 'Rename'],
    [['mv', p('b.txt'), p('dest')], 'Move'],
    [['cp', p('b.txt'), p('dest')], 'Copy'],
    [['rm', p('a.txt')], 'Move to the Recycle Bin'],
    [['rm', p('dest'), '--permanent'], 'Delete permanently'],
    [['unzip', p('bundle.zip')], 'Extract'],
    [['zip', p('new.zip'), p('a.txt')], 'Compress'],
  ];
  for (const [argv, label] of cases) {
    const output = preview(dir, argv);
    assert.ok(output.startsWith(`[Preview] ${label}`), output);
  }
});

test('--dry-run은 여러 항목을 각각 한 줄씩 보여 준다', () => {
  const dir = fixture();
  const lines = preview(dir, ['rm', path.join(dir, 'a.txt'), path.join(dir, 'b.txt')]).split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith('[Preview] Move to the Recycle Bin')));
});

// Commands where both the preview and a real run must fail. So that a real run does not reach the Recycle Bin, rm is used with --permanent.
function failureFixture() {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('other'));
  fs.writeFileSync(p('other', 'b.txt'), 'other');
  fs.mkdirSync(p('tree'));
  fs.writeFileSync(p('tree', 'f.txt'), 'f');
  fc.zip(p('bundle.zip'), [p('a.txt')]);
  fs.writeFileSync(p('broken.zip'), 'not a zip');
  return { dir, p };
}

function failureCases(p) {
  return [
    ['mv', p('nope'), p('dest')],
    ['mv', p('a.txt'), p('dest')],
    ['mv', p('a.txt'), p('missing', 'x.txt')],
    ['mv', p('a.txt'), p('b.txt'), p('not-a-dir')],
    ['mv', p('b.txt'), p('other', 'b.txt'), p('dest')],
    ['mv', p('b.txt'), p('b.txt'), p('dest')],
    ['cp', p('b.txt'), p('other', 'b.txt'), p('dest')],
    ['cp', p('a.txt'), p('dest')],
    ['rm', p('nope'), '--permanent'],
    ['rm', p('a.txt'), p('a.txt'), '--permanent'],
    ['rm', p('tree'), p('tree', 'f.txt'), '--permanent'],
    ['mv', p('tree'), p('tree', 'f.txt'), p('dest')],
    ['mv', p('tree'), p('tree', 'new')],
    ['cp', p('tree'), p('tree', 'new')],
    ['cp', p('a.txt'), p('a.txt'), '--force'],
    ['cp', p('a.txt'), dirOf(p), '--force'],
    ['cp', p('a.txt'), p('b.txt', 'x.txt')],
    ['cp', p('tree'), p('a.txt'), '--force'],
    ['rename', p('a.txt'), 'tree', '--force'],
    ['zip', p('tree'), p('a.txt'), '--force'],
    ['rename', p('a.txt'), 'b.txt'],
    ['rename', p('a.txt'), 'sub/x.txt'],
    ['write', p('a.txt'), 'x'],
    ['write', p('dest'), 'x', '--force'],
    ['write', p('a.txt', 'x.txt'), 'x'],
    ['mkdir', p('a.txt')],
    ['mkdir', p('a.txt', 'sub')],
    ['unzip', p('nope.zip')],
    ['unzip', p('broken.zip')],
    ['unzip', p('bundle.zip'), p('a.txt')],
    ['zip', p('a.txt'), p('b.txt')],
    ['zip', p('new.zip'), p('nope')],
    ['zip', p('missing', 'new.zip'), p('a.txt')],
  ];
}

function dirOf(p) {
  return path.dirname(p('a.txt'));
}

test('--dry-run은 실제 실행이 실패할 경우에도 오류를 내고 아무것도 바꾸지 않는다', () => {
  const { dir, p } = failureFixture();
  const before = snapshot(dir);
  for (const argv of failureCases(p)) {
    assert.throws(() => run([...argv, '--dry-run']), argv.join(' '));
    assert.deepStrictEqual(snapshot(dir), before, argv.join(' '));
  }
});

test('미리보기가 실패로 알린 명령은 실제 실행에서도 실패한다', () => {
  const count = failureCases(failureFixture().p).length;
  for (let i = 0; i < count; i++) {
    const { p } = failureFixture();
    const argv = failureCases(p)[i];
    assert.throws(() => run(argv), argv.join(' '));
  }
});

test('rm은 미리보기와 실제 모두 현재 폴더와 그 상위를 지우지 않는다', () => {
  const dir = fixture();
  const sub = path.join(dir, 'dest');
  const before = snapshot(dir);
  const cwd = process.cwd();
  process.chdir(sub);
  try {
    for (const flags of [['--dry-run'], ['--permanent']]) {
      assert.throws(() => run(['rm', '.', ...flags]), /current folder/);
      assert.throws(() => run(['rm', '..', ...flags]), /current folder/);
      assert.throws(() => run(['rm', sub, ...flags]), /current folder/);
      assert.throws(() => run(['rm', dir, ...flags]), /current folder/);
    }
    assert.deepStrictEqual(snapshot(dir), before);
    assert.match(run(['rm', 'a.txt', '--dry-run']), /^\[Preview\]/);
    assert.match(run(['rm', '../b.txt', '--dry-run']), /^\[Preview\]/);
  } finally {
    process.chdir(cwd);
  }
});

test('미리보기가 통과시킨 명령은 실제 실행에서도 성공하고 같은 일을 말한다', () => {
  const cases = [
    ['mv', 'a.txt', 'dest/new.txt'],
    ['mv', 'b.txt', 'dest'],
    ['mv', 'tree', 'dest'],
    ['mv', 'tree', 'tree-2'],
    ['mv', 'a.txt', 'dest', '--force'],
    ['mv', './a.txt', 'dest/../new.txt'],
    ['cp', 'tree', 'new/deep/copy'],
    ['cp', 'tree', 'dest'],
    ['cp', 'a.txt', 'dest', '--force'],
    ['cp', 'b.txt', 'new/deep/x.txt'],
    ['rename', 'a.txt', 'c.txt'],
    ['rename', 'tree', 'TREE', '--force'],
    ['rename', 'tree', 'tree', '--force'],
    ['rm', 'a.txt', '--permanent'],
    ['rm', 'tree/f.txt', 'tree', '--permanent'],
    ['mkdir', 'dest'],
    ['mkdir', 'new/deep'],
    ['write', 'new/n.txt', '내용'],
    ['append', 'a.txt', '내용'],
    ['unzip', 'bundle.zip'],
    ['unzip', 'bundle.zip', 'dest'],
    ['zip', 'new.zip', 'a.txt', 'tree'],
    ['zip', 'bundle.zip', 'b.txt', '--force'],
  ];
  const cwd = process.cwd();
  for (const argv of cases) {
    process.chdir(failureFixture().dir);
    try {
      const planned = run([...argv, '--dry-run']);
      assert.strictEqual(planned.replace(/^\[Preview\] /gm, '').replace(/ \([^)]*\)$/gm, ''), run(argv), argv.join(' '));
    } finally {
      process.chdir(cwd);
    }
  }
});

test('rename 미리보기는 자기 자신의 폴더를 덮어쓰기로 보지 않지만 다른 폴더는 거부한다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('empty'));
  assert.match(preview(dir, ['rename', p('dest'), 'dest', '--force']), /^\[Preview\] Rename/);
  assert.throws(() => run(['rename', p('dest'), 'empty', '--force', '--dry-run']), /Cannot overwrite a folder/);
});

test('도움말 옵션은 -- 앞에서만 동작한다', () => {
  assert.match(run(['--help', '--', 'rm', 'x']), /--dry-run/);
  assert.throws(() => run(['cat', '--', '--help']), /Path does not exist/);
  assert.throws(() => run(['cat', '--', '-h']), /Path does not exist/);
});

test('--dry-run --force는 cp의 같은 대상 덮어쓰기를 알려 주고, mv는 거부한다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('empty'));
  const lines = preview(dir, ['cp', p('a.txt'), p('dest', 'a.txt'), p('empty'), '--force']).split('\n');
  assert.doesNotMatch(lines[0], /overwrites/);
  assert.match(lines[1], /\(overwrites: earlier item\)$/);
  assert.throws(() => preview(dir, ['mv', p('a.txt'), p('dest', 'a.txt'), p('empty'), '--force']), /go to the same destination/);
});

test('mv는 현재 폴더 기준 경로로도 현재 폴더와 그 상위를 옮기지 않고 대상도 지우지 않는다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('q', 'r'), { recursive: true });
  fs.writeFileSync(p('q', 'sib.txt'), 'sib');
  fs.mkdirSync(p('o', 'd'), { recursive: true });
  fs.mkdirSync(p('x', 'd'), { recursive: true });
  const before = snapshot(dir);
  const cwd = process.cwd();
  process.chdir(p('o', 'd'));
  try {
    for (const argv of [['mv', '.', '../../q/r'], ['mv', './', '../../q'], ['mv', '..', '../../q/r'], ['mv', '../d', '../../q'], ['mv', '../../x/d', '..']]) {
      assert.throws(() => run([...argv, '--force']), fc.FcError, argv.join(' '));
      assert.deepStrictEqual(snapshot(dir), before, argv.join(' '));
    }
    // Moving into the current folder is not blocked.
    assert.match(run(['mv', '../../a.txt', '.']), /Move/);
  } finally {
    process.chdir(cwd);
  }
});

test('--dry-run은 mv의 폴더 교체와 cp의 폴더 병합을 구분해 알려 준다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('tree'));
  fs.writeFileSync(p('tree', 'f.txt'), 'f');
  fs.mkdirSync(p('dest', 'tree'));
  assert.match(preview(dir, ['mv', p('tree'), p('dest'), '--force']), /\(replaces the whole existing folder\)$/);
  assert.match(preview(dir, ['cp', p('tree'), p('dest'), '--force']), /\(merged into the folder, files with the same name are overwritten\)$/);
});

test('--dry-run은 대소문자만 달라도 같은 경로로 본다', { skip: process.platform !== 'win32' }, () => {
  const dir = fixture();
  assert.throws(() => run(['rm', path.join(dir, 'a.txt'), path.join(dir, 'A.TXT'), '--dry-run']), fc.FcError);
});

test('--dry-run은 덮어쓰기와 이미 있는 대상을 알려 준다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fc.zip(p('bundle.zip'), [p('b.txt')]);
  assert.match(preview(dir, ['mv', p('a.txt'), p('dest'), '--force']), /\(overwrites\)$/);
  assert.match(preview(dir, ['cp', p('a.txt'), p('dest'), '--force']), /\(overwrites\)$/);
  assert.match(preview(dir, ['write', p('a.txt'), 'x', '--force']), /\(overwrites\)$/);
  assert.match(preview(dir, ['rename', p('a.txt'), 'b.txt', '--force']), /\(overwrites\)$/);
  assert.match(preview(dir, ['zip', p('bundle.zip'), p('a.txt'), '--force']), /\(overwrites\)$/);
  assert.match(preview(dir, ['mkdir', p('dest')]), /\(already exists\)$/);
  assert.doesNotMatch(preview(dir, ['mv', p('b.txt'), p('dest')]), /overwrites/);
  assert.doesNotMatch(preview(dir, ['append', p('a.txt'), 'x']), /overwrites/);
});

test('--dry-run은 압축 해제 항목 수와 이미 있는 대상 폴더의 덮어쓰기를 알려 준다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fc.zip(p('bundle.zip'), [p('a.txt'), p('b.txt')]);
  const fresh = preview(dir, ['unzip', p('bundle.zip')]);
  // Two small files are rounded up in 4KB units and counted as 10KB with 1KB added per entry.
  assert.match(fresh, /2 items, extracted size about 10\.0KB\)$/);
  assert.match(preview(dir, ['unzip', p('bundle.zip'), p('dest')]), /2 items, extracted size about 10\.0KB, the destination folder already exists, so files with the same name are overwritten\)$/);
});

test('--dry-run 뒤 같은 명령을 실제로 실행하면 미리보기가 말한 대로 바뀐다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  const argv = ['mv', p('a.txt'), p('b.txt'), p('dest'), '--force'];
  const planned = preview(dir, argv);
  const done = run(argv);
  assert.strictEqual(planned.replaceAll('[Preview] ', '').replaceAll(' (overwrites)', ''), done);
  assert.strictEqual(fs.readFileSync(p('dest', 'a.txt'), 'utf8'), 'A');
  assert.ok(!fs.existsSync(p('a.txt')));
});

test('write --dry-run은 내용이 없어도 표준 입력을 기다리지 않는다', (t) => {
  const dir = fixture();
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file === 0) throw new Error('표준 입력을 읽음');
    return read(file, ...rest);
  });
  assert.match(run(['write', path.join(dir, 'new.txt'), '--dry-run']), /^\[Preview\] Write file/);
});

test('--dry-run 없이는 전처럼 실제로 실행하고 미리보기 표시를 붙이지 않는다', () => {
  const dir = fixture();
  const output = run(['write', path.join(dir, 'new.txt'), '내용']);
  assert.doesNotMatch(output, /Preview/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), '내용');
});

test('모르는 옵션은 아무것도 실행하지 않고 거부한다', () => {
  const dir = fixture();
  const a = path.join(dir, 'a.txt');
  const before = snapshot(dir);
  for (const typo of ['--dryrun', '--dry_run', '--Dry-Run', '-n', '-dry-run']) {
    assert.throws(() => run(['rm', a, typo, '--permanent']), /Unknown option/, typo);
    assert.throws(() => run(['mv', a, path.join(dir, 'x.txt'), typo]), /Unknown option/, typo);
  }
  assert.deepStrictEqual(snapshot(dir), before);
});

test('긴 대시로 시작하는 오타와 write·append 경로 자리의 대시도 거부한다', () => {
  const dir = fixture();
  const a = path.join(dir, 'a.txt');
  const before = snapshot(dir);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const argv of [['rm', a, '—dry-run', '--permanent'], ['mkdir', '–dry-run'], ['write', '-n', a], ['append', '-dry-run', a]]) {
      assert.throws(() => run(argv), /Unknown option/, argv.join(' '));
    }
  } finally {
    process.chdir(cwd);
  }
  assert.deepStrictEqual(snapshot(dir), before);
});

test('-- 뒤의 인자는 옵션이 아닌 이름·내용으로 본다', () => {
  const dir = fixture();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.match(run(['rename', 'a.txt', '--', '-z.txt']), /Rename/);
    assert.ok(fs.existsSync('-z.txt'));
    assert.strictEqual(run(['cat', '--', '-z.txt']), 'A');
    assert.strictEqual(run(['cat', './-z.txt']), 'A');
    assert.match(run(['mv', '--', '-z.txt', './y.txt']), /Move/);
    run(['write', 'c.txt', '--', '--- 제목']);
    assert.strictEqual(fs.readFileSync('c.txt', 'utf8'), '--- 제목');
    // --permanent after -- is a name, not an option, so a nonexistent-path error comes, and --dry-run before -- is still an option.
    assert.throws(() => run(['rm', '--dry-run', '--', 'y.txt', '--permanent']), /Path does not exist/);
    assert.ok(fs.existsSync('y.txt'));
    assert.match(run(['rm', '--dry-run', '--', 'y.txt']), /^\[Preview\]/);
    assert.match(run(['--', 'cat', 'y.txt']), /A/);
  } finally {
    process.chdir(cwd);
  }
});

test('zip은 -나 @로 시작하는 이름을 옵션이 아닌 파일로 묶는다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  // If interpreted as an option, the content of @evil.tar or the files listed in list.txt would be bundled instead.
  fs.writeFileSync(p('list.txt'), p('a.txt'));
  fs.writeFileSync(p('-Tlist.txt'), 'dash');
  fs.writeFileSync(p('-x'), 'x');
  fc.zip(p('evil.zip'), [p('b.txt')]);
  fs.copyFileSync(p('evil.zip'), p('@evil.zip'));
  run(['zip', p('out.zip'), p('-Tlist.txt'), p('-x'), p('@evil.zip')]);
  run(['unzip', p('out.zip'), p('out')]);
  assert.deepStrictEqual(fs.readdirSync(p('out')).sort(), ['-Tlist.txt', '-x', '@evil.zip']);
  assert.strictEqual(fs.readFileSync(p('out', '-Tlist.txt'), 'utf8'), 'dash');
  assert.deepStrictEqual(fs.readFileSync(p('out', '@evil.zip')), fs.readFileSync(p('evil.zip')));
});

test('fctl을 프로세스로 실행하면 미리보기는 종료 코드 0, 오류는 1이다', () => {
  const dir = fixture();
  const bin = path.join(__dirname, '..', 'bin', 'fctl.js');
  const a = path.join(dir, 'a.txt');
  const ok = spawnSync(process.execPath, [bin, 'rm', a, '--dry-run'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /^\[Preview\] Move to the Recycle Bin/);
  const typo = spawnSync(process.execPath, [bin, 'rm', a, '--dryrun', '--permanent'], { encoding: 'utf8' });
  assert.strictEqual(typo.status, 1);
  assert.match(typo.stderr, /Unknown option/);
  assert.ok(fs.existsSync(a));
});

test('write·append의 내용은 대시로 시작해도 되지만 긴 옵션 오타는 거부한다', () => {
  const dir = fixture();
  const a = path.join(dir, 'a.txt');
  run(['append', a, '-', '항목']);
  run(['append', a, '-항목']);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'A- 항목-항목');
  assert.throws(() => run(['append', a, '내용', '--dryrun']), /Unknown option/);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'A- 항목-항목');
});

test('도움말은 --dry-run을 설명한다', () => {
  assert.match(run(['--help']), /--dry-run/);
  assert.match(run([]), /--dry-run/);
});
