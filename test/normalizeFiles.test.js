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
  const linkSync = t.mock.method(fs, 'linkSync');
  const result = normalizeFiles(dir, { includeLowercase: true });
  const steps = [renameSync.mock.callCount(), linkSync.mock.callCount()];
  t.mock.restoreAll();
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(fs.readdirSync(dir), ['ABC-123.mp4']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123.mp4'), 'utf8'), 'abc-123.mp4');
  // 임시 이름으로는 rename, 새 이름으로는 덮어쓰지 않는 하드링크 이동(#73)을 한 번씩 쓴다.
  assert.deepStrictEqual(steps, [1, 1]);
});

// 임시 이름(.fctl-new)의 원래 이름 지우기를 실패시킨다. 잠긴 파일처럼 하드링크는 만들어지고 지우기만 실패한다.
function lockMiddle(t, times) {
  const unlinkSync = fs.unlinkSync;
  let count = 0;
  t.mock.method(fs, 'unlinkSync', (p) => {
    if (path.basename(p).startsWith('.fctl-new') && count++ < times) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return unlinkSync(p);
  });
}

test('대소문자 변경이 중간에 실패하면 원래 이름으로 되돌린다', (t) => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4']);
  lockMiddle(t, 1);
  const result = normalizeFiles(dir, { includeLowercase: true });
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /EBUSY/);
  assert.deepStrictEqual(fs.readdirSync(dir), ['abc-123.mp4']);
});

test('되돌리지도 못하면 임시 이름을 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['abc-123.mp4']);
  lockMiddle(t, Infinity);
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
  // 하드링크를 못 만드는 드라이브(FAT32·exFAT 등)에서는 빈 자리표시를 먼저 만드는 방식으로 옮긴다.
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('not supported'), { code: 'EPERM' });
  });
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
  // 잠긴 파일처럼 원래 이름을 지우지 못하게 한다. 만든 새 이름은 지워 되돌린다.
  const unlinkSync = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', (p) => {
    if (path.basename(p) === '[ABC-123].mp4') throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return unlinkSync(p);
  });
  assert.throws(() => run(['normalize', dir]), (err) => err instanceof FcError && /실패: .*EBUSY/.test(err.message));
  assert.deepStrictEqual(tree(dir), ['[ABC-123].mp4', 'abc-456.mp4']);
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

test('normalize는 이전 실행이 남긴 같은 파일의 다른 이름을 겹침 사유에 알린다 (1차 리뷰, #73)', () => {
  const dir = tempDir();
  make(dir, ['[ABC-123].mp4']);
  fs.linkSync(path.join(dir, '[ABC-123].mp4'), path.join(dir, 'ABC-123.mp4'));
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(result.renamed, []);
  assert.match(result.conflicts[0].reason, /같은 이름이 이미 있습니다\. \(원본과 같은 파일의 다른 이름/);
});

test('받는 중인 파일과 그 표시 파일이 옆에 있는 파일은 바꾸지 않고 알린다 (#94)', () => {
  const dir = tempDir();
  make(dir, [
    '영상 ABC-123.mp4.crdownload',
    '영상 BCD-234.mp4.part',
    '영상 CDE-345.mp4',
    '영상 CDE-345.mp4.aria2',
    'x.mp4.download/영상 DEF-456.mp4',
    '받음 EFG-567.mp4',
  ]);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['EFG-567 받음.mp4', 'x.mp4.download/DEF-456 영상.mp4', '영상 ABC-123.mp4.crdownload', '영상 BCD-234.mp4.part', '영상 CDE-345.mp4', '영상 CDE-345.mp4.aria2'].sort());
  const reasons = Object.fromEntries(result.skipped.map((item) => [path.relative(dir, item.path).replaceAll(path.sep, '/'), item.reason]));
  assert.match(reasons['영상 ABC-123.mp4.crdownload'], /받는 중인 파일의 이름\(\.crdownload\)/);
  assert.match(reasons['영상 BCD-234.mp4.part'], /받는 중인 파일의 이름/);
  assert.match(reasons['영상 CDE-345.mp4'], /표시 파일\(영상 CDE-345\.mp4\.aria2\)/);
  assert.match(reasons['영상 CDE-345.mp4.aria2'], /받는 중인 파일의 이름/);
  // Safari 표시 폴더 안이라도 폴더 이름(x.mp4.download)과 파일 이름이 다르면 표시로 보지 않는다. 안의 x.mp4만 받는 중이다.
  assert.strictEqual(result.renamed.length, 2);
});

test('Safari 표시 폴더 안에서 받는 중인 파일은 바꾸지 않는다 (#94)', () => {
  const dir = tempDir();
  make(dir, ['영상 ABC-123.mp4.download/영상 ABC-123.mp4']);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['영상 ABC-123.mp4.download/영상 ABC-123.mp4']);
  assert.match(result.skipped[0].reason, /표시 폴더\(영상 ABC-123\.mp4\.download\)/);
});

test('~로 시작하는 임시 파일은 알리지 않고 그대로 둔다 (#94)', () => {
  const dir = tempDir();
  make(dir, ['~abc-123.mp4', '~BCD-234 영상.mp4', '~$문서 ABC-123.docx']);
  const result = normalizeFiles(dir, { includeLowercase: true });
  assert.deepStrictEqual(tree(dir), ['~$문서 ABC-123.docx', '~BCD-234 영상.mp4', '~abc-123.mp4'].sort());
  assert.strictEqual(result.renamed.length + result.skipped.length + result.inferred.length, 0);
});

test('프로그램·프로젝트·실행 파일 폴더 안의 파일은 바꾸지 않고 폴더마다 한 번 알린다 (#94)', () => {
  const dir = tempDir();
  make(dir, [
    'node_modules/pkg/README ABC-123.md',
    'node_modules/pkg/lib/foo-12.js',
    'proj/package.json',
    'proj/src/python-39.js',
    'App/setup ABC-123.exe',
    'App/core.dll',
    'App/sub/note BCD-234.txt',
    'tools/run CDE-345.exe',
    '그냥 DEF-456.txt',
  ]);
  const result = normalizeFiles(dir, { includeLowercase: true });
  assert.deepStrictEqual(tree(dir), [
    'App/core.dll',
    'App/setup ABC-123.exe',
    'App/sub/note BCD-234.txt',
    'tools/CDE-345 run.exe',
    'DEF-456 그냥.txt',
    'node_modules/pkg/README ABC-123.md',
    'node_modules/pkg/lib/foo-12.js',
    'proj/package.json',
    'proj/src/python-39.js',
  ].sort());
  const skipped = result.skipped.map((item) => [path.relative(dir, item.path), item.reason]).sort();
  assert.deepStrictEqual(skipped.map(([relative]) => relative), ['App', 'node_modules', 'proj']);
  assert.match(skipped[0][1], /실행 파일과 DLL이 함께 든 프로그램 폴더라 안의 파일 이름을 바꾸지 않습니다/);
  assert.match(skipped[1][1], /프로그램 폴더\(node_modules\)라/);
  assert.match(skipped[2][1], /프로젝트 폴더\(package\.json 있음\)라/);
});

test('타겟이 프로그램 폴더 안이거나 프로젝트 폴더면 거부한다 (#94)', () => {
  const dir = tempDir();
  make(dir, ['node_modules/pkg/README ABC-123.md', 'proj/package.json', 'proj/영상 ABC-123.mp4']);
  assert.throws(() => normalizeFiles(path.join(dir, 'node_modules', 'pkg')), (err) => err instanceof FcError && /프로그램 폴더 안이라/.test(err.message));
  assert.throws(() => normalizeFiles(path.join(dir, 'proj')), (err) => err instanceof FcError && /프로젝트 폴더로 보여/.test(err.message));
  assert.deepStrictEqual(tree(dir), ['node_modules/pkg/README ABC-123.md', 'proj/package.json', 'proj/영상 ABC-123.mp4']);
});

test('저장한 웹 페이지와 그 _files 폴더는 바꾸지 않는다 (#94)', () => {
  const dir = tempDir();
  make(dir, ['페이지 ABC-123.html', '페이지 ABC-123_files/그림 BCD-234.png', '다른 CDE-345.html']);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['CDE-345 다른.html', '페이지 ABC-123.html', '페이지 ABC-123_files/그림 BCD-234.png'].sort());
  const reasons = result.skipped.map((item) => `${path.relative(dir, item.path)}: ${item.reason}`).sort();
  assert.strictEqual(reasons.length, 2);
  assert.match(reasons[0], /^페이지 ABC-123\.html: 자료 폴더\(페이지 ABC-123_files\)와 이름으로 이어진 웹 페이지라/);
  assert.match(reasons[1], /^페이지 ABC-123_files: 웹 페이지\(페이지 ABC-123\.html\)의 자료 폴더라/);
});

test('숨김 속성 폴더 안의 파일은 바꾸지 않는다 (#94)', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('node:child_process');
  const dir = tempDir();
  make(dir, ['숨김/영상 ABC-123.mp4', '보임/영상 BCD-234.mp4']);
  execFileSync('attrib', ['+h', path.join(dir, '숨김')]);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['보임/BCD-234 영상.mp4', '숨김/영상 ABC-123.mp4']);
  assert.match(result.skipped[0].reason, /숨김 속성 폴더라/);
});

test('웹 페이지와 _files 폴더는 대소문자가 달라도 짝으로 보고, .htm도 같다 (1차 리뷰, #94)', () => {
  const dir = tempDir();
  make(dir, ['Page ABC-123.HTML', 'page ABC-123_files/a.png', '옛 BCD-234.htm', '옛 BCD-234_files/b.png']);
  const result = normalizeFiles(dir);
  assert.deepStrictEqual(tree(dir), ['Page ABC-123.HTML', 'page ABC-123_files/a.png', '옛 BCD-234.htm', '옛 BCD-234_files/b.png'].sort());
  const reasons = result.skipped.map((item) => `${path.basename(item.path)}: ${item.reason}`).sort();
  assert.deepStrictEqual(reasons, [
    'Page ABC-123.HTML: 자료 폴더(page ABC-123_files)와 이름으로 이어진 웹 페이지라 바꾸지 않습니다.',
    '옛 BCD-234.htm: 자료 폴더(옛 BCD-234_files)와 이름으로 이어진 웹 페이지라 바꾸지 않습니다.',
  ]);
});

test('바뀔 파일이 없으면 숨김 속성을 확인하려고 PowerShell을 부르지 않는다 (1차 리뷰, #94)', (t) => {
  const commands = require('../src/commands');
  const dir = tempDir();
  make(dir, ['ABC-123 영상.mp4', 'sub/그냥.txt']);
  const hidden = t.mock.method(commands, 'hiddenOrSystemEntries');
  assert.strictEqual(normalizeFiles(dir).renamed.length, 0);
  assert.strictEqual(hidden.mock.callCount(), 0);
  make(dir, ['sub/영상 BCD-234.mp4']);
  assert.strictEqual(normalizeFiles(dir).renamed.length, 1);
  assert.strictEqual(hidden.mock.callCount(), 1);
});

test('숨김 속성 폴더 안의 보고할 파일은 다른 파일의 순서와 관계없이 폴더로만 알린다 (2차 리뷰, #94)', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('node:child_process');
  for (const other of ['a/영상 CDE-345.mp4', 'z/영상 CDE-345.mp4', null]) {
    const dir = tempDir();
    make(dir, ['h/영상 ABC-123 BCD-234.mp4', ...(other ? [other] : [])]);
    execFileSync('attrib', ['+h', path.join(dir, 'h')]);
    const result = normalizeFiles(dir, { dryRun: true });
    assert.deepStrictEqual(result.skipped.map((item) => path.relative(dir, item.path)), [], String(other));
  }
});
