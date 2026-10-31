'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('--dry-run은 실제 실행이 실패할 경우에도 오류를 내고 아무것도 바꾸지 않는다', () => {
  const dir = fixture();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('other'));
  fs.writeFileSync(p('other', 'b.txt'), 'other');
  fc.zip(p('bundle.zip'), [p('a.txt')]);
  fs.writeFileSync(p('broken.zip'), 'not a zip');
  const failures = [
    ['mv', p('nope'), p('dest')],
    ['mv', p('a.txt'), p('dest')],
    ['mv', p('a.txt'), p('missing', 'x.txt')],
    ['mv', p('a.txt'), p('b.txt'), p('not-a-dir')],
    ['mv', p('b.txt'), p('other', 'b.txt'), p('dest')],
    ['mv', p('b.txt'), p('b.txt'), p('dest')],
    ['cp', p('b.txt'), p('other', 'b.txt'), p('dest')],
    ['cp', p('a.txt'), p('dest')],
    ['rm', p('nope')],
    ['rm', p('a.txt'), p('a.txt')],
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
  const before = snapshot(dir);
  for (const argv of failures) {
    assert.throws(() => run([...argv, '--dry-run']), argv.join(' '));
    assert.deepStrictEqual(snapshot(dir), before, argv.join(' '));
  }
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
