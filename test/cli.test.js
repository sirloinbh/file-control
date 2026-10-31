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

// 폴더 아래 모든 항목과 파일 내용을 모은다. 미리보기 전후가 같은지 비교하는 데 쓴다.
function snapshot(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return [path.relative(dir, full), entry.isDirectory() ? null : fs.readFileSync(full, 'utf8')];
    })
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

// 미리보기로 argv를 실행한 뒤 아무것도 바뀌지 않았는지 확인하고 출력을 돌려준다.
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
    [['mkdir', p('new', 'deep')], '폴더 생성'],
    [['write', p('new', 'n.txt'), '내용'], '파일 작성'],
    [['append', p('a.txt'), '더'], '내용 추가'],
    [['rename', p('a.txt'), 'c.txt'], '이름 변경'],
    [['mv', p('b.txt'), p('dest')], '이동'],
    [['cp', p('b.txt'), p('dest')], '복사'],
    [['rm', p('a.txt')], '휴지통으로 이동'],
    [['rm', p('dest'), '--permanent'], '영구 삭제'],
    [['unzip', p('bundle.zip')], '압축 해제'],
    [['zip', p('new.zip'), p('a.txt')], '압축'],
  ];
  for (const [argv, label] of cases) {
    const output = preview(dir, argv);
    assert.ok(output.startsWith(`[미리보기] ${label}`), output);
  }
});

test('--dry-run은 여러 항목을 각각 한 줄씩 보여 준다', () => {
  const dir = fixture();
  const lines = preview(dir, ['rm', path.join(dir, 'a.txt'), path.join(dir, 'b.txt')]).split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith('[미리보기] 휴지통으로 이동')));
});

// 미리보기와 실제 실행이 모두 실패해야 하는 명령들. 실제 실행이 휴지통에 닿지 않게 rm은 --permanent로 쓴다.
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
      assert.throws(() => run(['rm', '.', ...flags]), /현재 폴더/);
      assert.throws(() => run(['rm', '..', ...flags]), /현재 폴더/);
      assert.throws(() => run(['rm', sub, ...flags]), /현재 폴더/);
      assert.throws(() => run(['rm', dir, ...flags]), /현재 폴더/);
    }
    assert.deepStrictEqual(snapshot(dir), before);
    assert.match(run(['rm', 'a.txt', '--dry-run']), /^\[미리보기\]/);
    assert.match(run(['rm', '../b.txt', '--dry-run']), /^\[미리보기\]/);
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
      assert.strictEqual(planned.replace(/^\[미리보기\] /gm, '').replace(/ \([^)]*\)$/gm, ''), run(argv), argv.join(' '));
    } finally {
      process.chdir(cwd);
    }
  }
});

test('rename 미리보기는 자기 자신의 폴더를 덮어쓰기로 보지 않지만 다른 폴더는 거부한다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('empty'));
  assert.match(preview(dir, ['rename', p('dest'), 'dest', '--force']), /^\[미리보기\] 이름 변경/);
  assert.throws(() => run(['rename', p('dest'), 'empty', '--force', '--dry-run']), /폴더는 덮어쓸 수 없습니다/);
});

test('도움말 옵션은 -- 앞에서만 동작한다', () => {
  assert.match(run(['--help', '--', 'rm', 'x']), /--dry-run/);
  assert.throws(() => run(['cat', '--', '--help']), /경로가 없습니다/);
  assert.throws(() => run(['cat', '--', '-h']), /경로가 없습니다/);
});

test('--dry-run --force는 같은 대상으로 모이는 항목의 덮어쓰기를 알려 준다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('empty'));
  for (const command of ['mv', 'cp']) {
    const lines = preview(dir, [command, p('a.txt'), p('dest', 'a.txt'), p('empty'), '--force']).split('\n');
    assert.doesNotMatch(lines[0], /덮어씀/);
    assert.match(lines[1], /\(덮어씀: 앞 항목\)$/);
  }
});

test('--dry-run은 mv의 폴더 교체와 cp의 폴더 병합을 구분해 알려 준다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('tree'));
  fs.writeFileSync(p('tree', 'f.txt'), 'f');
  fs.mkdirSync(p('dest', 'tree'));
  assert.match(preview(dir, ['mv', p('tree'), p('dest'), '--force']), /\(기존 폴더 전체를 교체함\)$/);
  assert.match(preview(dir, ['cp', p('tree'), p('dest'), '--force']), /\(폴더에 합침, 같은 이름 파일은 덮어씀\)$/);
});

test('--dry-run은 대소문자만 달라도 같은 경로로 본다', { skip: process.platform !== 'win32' }, () => {
  const dir = fixture();
  assert.throws(() => run(['rm', path.join(dir, 'a.txt'), path.join(dir, 'A.TXT'), '--dry-run']), fc.FcError);
});

test('--dry-run은 덮어쓰기와 이미 있는 대상을 알려 준다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fc.zip(p('bundle.zip'), [p('b.txt')]);
  assert.match(preview(dir, ['mv', p('a.txt'), p('dest'), '--force']), /\(덮어씀\)$/);
  assert.match(preview(dir, ['cp', p('a.txt'), p('dest'), '--force']), /\(덮어씀\)$/);
  assert.match(preview(dir, ['write', p('a.txt'), 'x', '--force']), /\(덮어씀\)$/);
  assert.match(preview(dir, ['rename', p('a.txt'), 'b.txt', '--force']), /\(덮어씀\)$/);
  assert.match(preview(dir, ['zip', p('bundle.zip'), p('a.txt'), '--force']), /\(덮어씀\)$/);
  assert.match(preview(dir, ['mkdir', p('dest')]), /\(이미 있음\)$/);
  assert.doesNotMatch(preview(dir, ['mv', p('b.txt'), p('dest')]), /덮어씀/);
  assert.doesNotMatch(preview(dir, ['append', p('a.txt'), 'x']), /덮어씀/);
});

test('--dry-run은 압축 해제 항목 수와 이미 있는 대상 폴더의 덮어쓰기를 알려 준다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fc.zip(p('bundle.zip'), [p('a.txt'), p('b.txt')]);
  const fresh = preview(dir, ['unzip', p('bundle.zip')]);
  assert.match(fresh, /항목 2개\)$/);
  assert.match(preview(dir, ['unzip', p('bundle.zip'), p('dest')]), /항목 2개, 대상 폴더가 이미 있어 같은 이름 파일은 덮어씀\)$/);
});

test('--dry-run 뒤 같은 명령을 실제로 실행하면 미리보기가 말한 대로 바뀐다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  const argv = ['mv', p('a.txt'), p('b.txt'), p('dest'), '--force'];
  const planned = preview(dir, argv);
  const done = run(argv);
  assert.strictEqual(planned.replaceAll('[미리보기] ', '').replaceAll(' (덮어씀)', ''), done);
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
  assert.match(run(['write', path.join(dir, 'new.txt'), '--dry-run']), /^\[미리보기\] 파일 작성/);
});

test('--dry-run 없이는 전처럼 실제로 실행하고 미리보기 표시를 붙이지 않는다', () => {
  const dir = fixture();
  const output = run(['write', path.join(dir, 'new.txt'), '내용']);
  assert.doesNotMatch(output, /미리보기/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), '내용');
});

test('모르는 옵션은 아무것도 실행하지 않고 거부한다', () => {
  const dir = fixture();
  const a = path.join(dir, 'a.txt');
  const before = snapshot(dir);
  for (const typo of ['--dryrun', '--dry_run', '--Dry-Run', '-n', '-dry-run']) {
    assert.throws(() => run(['rm', a, typo, '--permanent']), /알 수 없는 옵션/, typo);
    assert.throws(() => run(['mv', a, path.join(dir, 'x.txt'), typo]), /알 수 없는 옵션/, typo);
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
      assert.throws(() => run(argv), /알 수 없는 옵션/, argv.join(' '));
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
    assert.match(run(['rename', 'a.txt', '--', '-z.txt']), /이름 변경/);
    assert.ok(fs.existsSync('-z.txt'));
    assert.strictEqual(run(['cat', '--', '-z.txt']), 'A');
    assert.strictEqual(run(['cat', './-z.txt']), 'A');
    assert.match(run(['mv', '--', '-z.txt', './y.txt']), /이동/);
    run(['write', 'c.txt', '--', '--- 제목']);
    assert.strictEqual(fs.readFileSync('c.txt', 'utf8'), '--- 제목');
    // -- 뒤의 --permanent는 옵션이 아니라 이름이므로 없는 경로 오류가 나고, -- 앞의 --dry-run은 그대로 옵션이다.
    assert.throws(() => run(['rm', '--dry-run', '--', 'y.txt', '--permanent']), /경로가 없습니다/);
    assert.ok(fs.existsSync('y.txt'));
    assert.match(run(['rm', '--dry-run', '--', 'y.txt']), /^\[미리보기\]/);
    assert.match(run(['--', 'cat', 'y.txt']), /A/);
  } finally {
    process.chdir(cwd);
  }
});

test('zip은 -나 @로 시작하는 이름을 미리보기와 실제 모두 거부하고 기존 압축 파일을 지우지 않는다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fc.zip(p('bundle.zip'), [p('a.txt')]);
  const size = fs.statSync(p('bundle.zip')).size;
  for (const name of ['-dash.txt', '@evil.tar']) {
    fs.writeFileSync(p(name), 'x');
    for (const flags of [['--force'], ['--force', '--dry-run']]) {
      assert.throws(() => run(['zip', p('bundle.zip'), p(name), ...flags]), /아직 압축할 수 없습니다/, name);
    }
  }
  assert.strictEqual(fs.statSync(p('bundle.zip')).size, size);
});

test('fctl을 프로세스로 실행하면 미리보기는 종료 코드 0, 오류는 1이다', () => {
  const dir = fixture();
  const bin = path.join(__dirname, '..', 'bin', 'fctl.js');
  const a = path.join(dir, 'a.txt');
  const ok = spawnSync(process.execPath, [bin, 'rm', a, '--dry-run'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /^\[미리보기\] 휴지통으로 이동/);
  const typo = spawnSync(process.execPath, [bin, 'rm', a, '--dryrun', '--permanent'], { encoding: 'utf8' });
  assert.strictEqual(typo.status, 1);
  assert.match(typo.stderr, /알 수 없는 옵션/);
  assert.ok(fs.existsSync(a));
});

test('write·append의 내용은 대시로 시작해도 되지만 긴 옵션 오타는 거부한다', () => {
  const dir = fixture();
  const a = path.join(dir, 'a.txt');
  run(['append', a, '-', '항목']);
  run(['append', a, '-항목']);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'A- 항목-항목');
  assert.throws(() => run(['append', a, '내용', '--dryrun']), /알 수 없는 옵션/);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'A- 항목-항목');
});

test('도움말은 --dry-run을 설명한다', () => {
  assert.match(run(['--help']), /--dry-run/);
  assert.match(run([]), /--dry-run/);
});
