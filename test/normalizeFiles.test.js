'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { planNormalize, applyNormalize, normalizeFiles, formatNormalize } = require('../src/normalizeFiles');
const { run } = require('../bin/fctl');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-norm-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const file of files) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file);
  }
}

// 실제 표기 그대로의 목록. 대소문자가 바뀌었는지 보려고 readdir로 읽는다.
function tree(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'))
    .sort();
}

test('대문자 번호를 앞으로 옮기고 내용과 폴더는 그대로 둔다', () => {
  const dir = tempDir();
  make(dir, ['영상 ABC-123.mp4', 'sub/끝_XYZ-999.mkv', 'sub/그대로.txt']);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123 영상.mp4', 'sub/XYZ-999 끝.mkv', 'sub/그대로.txt']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123 영상.mp4'), 'utf8'), '영상 ABC-123.mp4');
  assert.strictEqual(result.renamed.length, 2);
});

test('소문자 말은 기본으로 바꾸지 않고 보고하며, 옵션을 주면 바꾼다', () => {
  const dir = tempDir();
  make(dir, ['영상 abc-123.mp4', 'trip-2023.mp4']);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['trip-2023.mp4', '영상 abc-123.mp4']);
  assert.deepStrictEqual(result.inferred.map((item) => item.name).sort(), ['ABC-123 영상.mp4', 'TRIP-2023.mp4']);
  assert.match(formatNormalize(result), /소문자 말이라 그대로 둠: trip-2023\.mp4 -> TRIP-2023\.mp4/);
  normalizeFiles(dir, { includeLowercase: true });
  assert.deepStrictEqual(tree(dir), ['ABC-123 영상.mp4', 'TRIP-2023.mp4']);
});

test('대소문자만 바뀌는 이름도 임시 이름을 거쳐 바꾼다', (t) => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4']);
  const renameSync = t.mock.method(fs, 'renameSync');
  const result = normalizeFiles(dir, { includeLowercase: true });
  const steps = renameSync.mock.callCount();
  t.mock.restoreAll();
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(fs.readdirSync(dir), ['ABC-123.mp4']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123.mp4'), 'utf8'), 'abc-123.mp4');
  assert.strictEqual(steps, 2);
});

test('대소문자 변경이 중간에 실패하면 원래 이름으로 되돌린다', (t) => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4']);
  const renameSync = fs.renameSync;
  let count = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    count += 1;
    if (count === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return renameSync(from, to);
  });
  const result = normalizeFiles(dir, { includeLowercase: true });
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /EBUSY/);
  assert.deepStrictEqual(fs.readdirSync(dir), ['abc-123.mp4']);
});

test('되돌리지도 못하면 임시 이름을 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4']);
  const renameSync = fs.renameSync;
  let count = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    count += 1;
    if (count >= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return renameSync(from, to);
  });
  const result = normalizeFiles(dir, { includeLowercase: true });
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /되돌리지도 못했습니다.*\.fctl-new/);
  const left = fs.readdirSync(dir).find((name) => name.startsWith('.fctl-new'));
  assert.strictEqual(fs.readFileSync(path.join(dir, left), 'utf8'), 'abc-123.mp4');
});

test('대소문자 변경 중 원래 이름에 다른 파일이 생기면 덮어쓰지 않고 임시 이름을 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4']);
  const renameSync = fs.renameSync;
  let count = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    renameSync(from, to);
    count += 1;
    if (count === 1) fs.writeFileSync(path.join(dir, 'abc-123.mp4'), '다른 프로그램');
  });
  const result = normalizeFiles(dir, { includeLowercase: true });
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /되돌리지도 못했습니다.*\.fctl-new/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'abc-123.mp4'), 'utf8'), '다른 프로그램');
  const left = fs.readdirSync(dir).find((name) => name.startsWith('.fctl-new'));
  assert.strictEqual(fs.readFileSync(path.join(dir, left), 'utf8'), 'abc-123.mp4');
});

test('대소문자 변경 중 자리표시에 내용이 생기면 그 내용을 지우지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4']);
  const renameSync = fs.renameSync;
  let count = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    count += 1;
    if (count === 2) {
      fs.writeFileSync(to, '다른 프로그램');
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }
    return renameSync(from, to);
  });
  const result = normalizeFiles(dir, { includeLowercase: true });
  t.mock.restoreAll();
  assert.doesNotMatch(result.failed[0].reason, /undefined/);
  assert.match(result.failed[0].reason, /되돌리지도 못했습니다/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123.mp4'), 'utf8'), '다른 프로그램');
});

test('대소문자 변경 중 끊어진 정션이 생겨도 타겟 밖에 만들지 않는다', (t) => {
  const dir = tempDir();
  const outside = tempDir();
  make(dir, ['abc-123.mp4']);
  const gone = path.join(outside, 'gone');
  const renameSync = fs.renameSync;
  let count = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    renameSync(from, to);
    count += 1;
    if (count === 1) {
      fs.mkdirSync(gone);
      fs.symlinkSync(gone, path.join(dir, 'ABC-123.mp4'), 'junction');
      fs.rmdirSync(gone);
    }
  });
  const result = normalizeFiles(dir, { includeLowercase: true });
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /되돌리지도 못했습니다/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
  const left = fs.readdirSync(dir).find((name) => name.startsWith('.fctl-new'));
  assert.ok(left);
});

test('그리스 문자처럼 대소문자 변환이 문맥을 타는 이름의 겹침도 잡는다', () => {
  const dir = tempDir();
  make(dir, ['[ABC-123] ΑΣ 제목.mp4', '_ABC-123_ ασ 제목.mp4']);
  const result = normalizeFiles(dir);
  assert.strictEqual(result.renamed.length, 0);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.conflicts.length, 2);
});

test('저장소가 들어 있거나 타겟이 저장소 폴더 안이면 전체를 거부한다', () => {
  const rejected = /저장소.*다루지 않습니다/;
  const dir = tempDir();
  make(dir, ['repo/.git/refs/heads/ABC-123-fix', '영상 ABC-123.mp4']);
  assert.throws(() => normalizeFiles(dir), rejected);
  assert.throws(() => normalizeFiles(path.join(dir, 'repo', '.git')), rejected);
  const bare = tempDir();
  make(bare, ['backup.git/HEAD', 'backup.git/refs/heads/ABC-123-fix', '영상 ABC-123.mp4']);
  fs.mkdirSync(path.join(bare, 'backup.git', 'objects'));
  assert.throws(() => normalizeFiles(bare), rejected);
  assert.throws(() => normalizeFiles(path.join(bare, 'backup.git')), rejected);
  assert.ok(fs.existsSync(path.join(bare, '영상 ABC-123.mp4')));
});

test('저장소 작업 트리의 일반 하위 폴더는 바꾼다', () => {
  const dir = tempDir();
  make(dir, ['work/.git/HEAD', 'work/.git/refs/heads/main', 'work/src/영상 ABC-123.mp4']);
  fs.mkdirSync(path.join(dir, 'work', '.git', 'objects'));
  normalizeFiles(path.join(dir, 'work', 'src'));
  assert.deepStrictEqual(tree(path.join(dir, 'work', 'src')), ['ABC-123 영상.mp4']);
});

test('HEAD 표기가 소문자인 베어 저장소도 거부한다', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir();
  make(dir, ['backup.git/head', 'backup.git/refs/heads/ABC-123-fix', '영상 ABC-123.mp4']);
  fs.mkdirSync(path.join(dir, 'backup.git', 'objects'));
  assert.throws(() => normalizeFiles(dir), /저장소.*다루지 않습니다/);
  assert.ok(fs.existsSync(path.join(dir, '영상 ABC-123.mp4')));
});

test('결과 이름이 다른 파일의 8.3 짧은 이름과 겹치면 바꾸지 않고 보고한다', (t) => {
  const dir = tempDir();
  make(dir, ['[ABC-123].mp4', 'ABC-123 긴 이름.mp4']);
  // 8.3 이름은 드라이브 설정에 따라 꺼져 있을 수 있어, 짧은 이름이 긴 이름으로 풀리는 동작을 흉내 낸다.
  const long = (p) => (path.basename(p) === 'ABC-123.mp4' ? path.join(dir, 'ABC-123 긴 이름.mp4') : p);
  const { lstatSync } = fs;
  const native = fs.realpathSync.native;
  t.mock.method(fs, 'lstatSync', (p, ...rest) => lstatSync(long(p), ...rest));
  t.mock.method(fs.realpathSync, 'native', (p, ...rest) => native(long(p), ...rest));
  const result = normalizeFiles(dir);
  t.mock.restoreAll();
  assert.deepStrictEqual(result.renamed, []);
  assert.deepStrictEqual(result.conflicts.map((item) => item.reason), ['같은 이름이 이미 있습니다.']);
  assert.ok(fs.existsSync(path.join(dir, '[ABC-123].mp4')));
});

test('결과가 다른 결과와 겹치면 어느 쪽도 바꾸지 않고 보고한다', () => {
  const dir = tempDir();
  const files = ['[ABC-123].mp4', '_ABC-123_.mp4', 'sub/[ABC-123].mp4', '영상 XYZ-999.mp4'];
  make(dir, files);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['XYZ-999 영상.mp4', '[ABC-123].mp4', '_ABC-123_.mp4', 'sub/ABC-123.mp4'].sort());
  assert.strictEqual(result.conflicts.length, 2);
  assert.match(result.conflicts[0].reason, /다른 파일도 같은 이름/);
});

test('결과가 기존 파일이나 폴더와 겹치면 덮어쓰지 않고 보고한다', () => {
  const dir = tempDir();
  make(dir, ['[ABC-123].mp4', 'ABC-123.mp4', '[XYZ-999].mkv', 'xyz-999.MKV', '[DEF-456]']);
  fs.mkdirSync(path.join(dir, 'DEF-456'));
  const result = normalizeFiles(dir);
  assert.strictEqual(result.renamed.length, 0);
  assert.strictEqual(result.conflicts.length, 3);
  for (const item of result.conflicts) assert.match(item.reason, /같은 이름이 이미 있습니다/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123.mp4'), 'utf8'), 'ABC-123.mp4');
  assert.strictEqual(fs.readFileSync(path.join(dir, '[ABC-123].mp4'), 'utf8'), '[ABC-123].mp4');
});

test('계획 뒤에 이름이 차면 덮어쓰지 않고 실패로 보고하고 나머지를 계속한다', () => {
  const dir = tempDir();
  make(dir, ['[ABC-123].mp4', '[XYZ-999].mp4']);
  const plan = planNormalize(dir);
  fs.writeFileSync(path.join(dir, 'ABC-123.mp4'), '새 내용');
  const result = applyNormalize(plan);
  assert.match(result.failed[0].reason, /같은 이름이 이미 있어/);
  assert.strictEqual(result.renamed.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123.mp4'), 'utf8'), '새 내용');
  assert.ok(fs.existsSync(path.join(dir, '[ABC-123].mp4')));
});

test('계획 뒤에 원본이나 부모가 바뀌면 그 파일만 실패하고 타겟 밖을 바꾸지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(outside, ['[ABC-123].mp4']);
  make(dir, ['sub/[ABC-123].mp4', '[GONE-111].mp4', '[DIR-222].mp4', '[OK-333].mp4']);
  const plan = planNormalize(dir);
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'sub'), 'junction');
  fs.rmSync(path.join(dir, '[GONE-111].mp4'));
  fs.rmSync(path.join(dir, '[DIR-222].mp4'));
  fs.mkdirSync(path.join(dir, '[DIR-222].mp4'));
  const result = applyNormalize(plan);
  assert.deepStrictEqual(result.renamed.map((item) => item.name), ['OK-333.mp4']);
  assert.strictEqual(result.failed.length, 3);
  assert.deepStrictEqual(fs.readdirSync(outside), ['[ABC-123].mp4']);
});

test('잔여물, 시스템 폴더, 링크는 바꾸지 않고 보고한다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(outside, ['[ABC-123].mp4']);
  const files = ['.fctl-old-1-2-0/[ABC-123].mp4', '$RECYCLE.BIN/[ABC-123].mp4'];
  make(dir, files);
  fs.symlinkSync(outside, path.join(dir, '[ABC-123]'), 'junction');
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir).filter((name) => !name.startsWith('[ABC-123]')), [...files].sort());
  assert.strictEqual(result.skipped.length, 3);
  assert.deepStrictEqual(fs.readdirSync(outside), ['[ABC-123].mp4']);
});

test('번호가 여럿인 이름은 보고하고, 바꿀 것이 없는 숨김 파일은 보고하지 않는다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 XYZ-999.mp4', '.hidden', 'desktop.ini']);
  const result = normalizeFiles(dir);
  assert.strictEqual(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /번호가 여럿/);
  assert.strictEqual(result.renamed.length, 0);
});

test('다시 실행해도 바뀌지 않는다', () => {
  const dir = tempDir();
  make(dir, ['영상 ABC-123.mp4']);
  normalizeFiles(dir);
  const again = normalizeFiles(dir);
  assert.strictEqual(again.renamed.length, 0);
  assert.deepStrictEqual(tree(dir), ['ABC-123 영상.mp4']);
});

test('미리보기는 아무것도 바꾸지 않고 같은 계획을 보여 준다', () => {
  const dir = tempDir();
  make(dir, ['영상 ABC-123.mp4']);
  const result = normalizeFiles(dir, { dryRun: true });
  assert.deepStrictEqual(tree(dir), ['영상 ABC-123.mp4']);
  assert.match(formatNormalize(result), /\[미리보기\] 이름 변경: 영상 ABC-123\.mp4 -> ABC-123 영상\.mp4/);
});

test('보호 경로는 거부한다', () => {
  assert.throws(() => normalizeFiles(process.env.SystemRoot ?? 'C:\\Windows'), FcError);
});

test('normalize 명령은 결과를 보여 주고 실패가 있으면 오류로 끝낸다', (t) => {
  const dir = tempDir();
  make(dir, ['[ABC-123].mp4', 'abc-456.mp4']);
  assert.match(run(['normalize', dir, '--dry-run']), /\[미리보기\] 이름 변경 1개, 소문자 말 1개/);
  const mock = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  assert.throws(() => run(['normalize', dir]), (err) => err instanceof FcError && /실패: .*EBUSY/.test(err.message));
  mock.mock.restore();
  assert.match(run(['normalize', dir, '--include-lowercase']), /이름 변경 2개, 소문자 말 0개, 겹침 0개, 건너뜀 0개, 실패 0개/);
  assert.deepStrictEqual(tree(dir), ['ABC-123.mp4', 'ABC-456.mp4']);
});

test('normalize 명령은 잘못된 인자를 거부한다', () => {
  const dir = tempDir();
  assert.throws(() => run(['normalize']), /사용법/);
  assert.throws(() => run(['normalize', dir, 'more']), /타겟은 하나만/);
  assert.throws(() => run(['normalize', 'C:']), /드라이브 문자/);
  assert.throws(() => run(['normalize', dir, '--force']), /--force/);
  assert.throws(() => run(['normalize', dir, '--permanent']), /--permanent/);
  assert.throws(() => run(['normalize', dir, '--remove-archives']), /extract-all에서만/);
  assert.throws(() => run(['flatten', dir, '--include-lowercase']), /normalize에서만/);
});
