'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { planFlatten, detailedName, flatten, formatFlatten } = require('../src/flatten');
const { run } = require('../bin/fctl');
const { spawnSync } = require('node:child_process');

const isWindows = process.platform === 'win32';

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로, 사용자 폴더를 임시 폴더 밖으로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-flatten-'));
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

function moves(plan) {
  return plan.moves.map(({ from, to }) => [path.relative(plan.target, from).split(path.sep).join('/'), path.relative(plan.target, to)]);
}

function linkDir(from, to) {
  fs.symlinkSync(from, to, isWindows ? 'junction' : 'dir');
}

test('planFlatten은 하위 폴더의 모든 파일을 타겟 바로 아래로 옮기는 계획을 만든다', () => {
  const dir = tempDir();
  make(dir, ['a/one.mkv', 'a/b/c/two.mp4', 'z/three.txt', 'top.txt']);
  fs.mkdirSync(path.join(dir, 'empty'));
  const plan = planFlatten(dir);
  assert.strictEqual(plan.target, dir);
  assert.deepStrictEqual(moves(plan), [
    ['a/b/c/two.mp4', 'two.mp4'],
    ['a/one.mkv', 'one.mkv'],
    ['z/three.txt', 'three.txt'],
  ]);
  assert.deepStrictEqual(plan.moves[0], { from: path.join(dir, 'a', 'b', 'c', 'two.mp4'), to: path.join(dir, 'two.mp4'), name: 'two.mp4', desired: 'two.mp4', fromFolder: false, numbered: false });
  assert.deepStrictEqual(plan.stay, [path.join(dir, 'top.txt')]);
  assert.deepStrictEqual(plan.skipped, []);
});

test('planFlatten은 아무것도 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, ['a/one.mkv', 'b/one.mkv', 'one.mkv']);
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  planFlatten(dir);
  assert.deepStrictEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'one.mkv'), 'utf8'), 'a/one.mkv');
});

test('planFlatten은 이름이 겹치면 확장자 앞에 번호를 붙인다', () => {
  const dir = tempDir();
  make(dir, ['a/v.mkv', 'b/v.mkv', 'c/v.mkv', 'v.mkv', 'd/.hidden', 'e/.hidden', 'f/x.tar.gz', 'g/x.tar.gz', 'h/noext', 'i/noext']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(
    plan.moves.map(({ name, numbered }) => [name, numbered]),
    [
      ['v (2).mkv', true],
      ['v (3).mkv', true],
      ['v (4).mkv', true],
      ['.hidden', false],
      ['.hidden (2)', true],
      ['x.tar.gz', false],
      ['x.tar (2).gz', true],
      ['noext', false],
      ['noext (2)', true],
    ],
  );
  assert.strictEqual(new Set(plan.moves.map((move) => move.to)).size, plan.moves.length);
});

test('planFlatten은 번호를 붙인 이름도 이미 있으면 피한다', () => {
  const dir = tempDir();
  make(dir, ['v.mkv', 'v (2).mkv', 'a/v.mkv', 'b/v (2).mkv']);
  assert.deepStrictEqual(moves(planFlatten(dir)), [
    ['a/v.mkv', 'v (3).mkv'],
    ['b/v (2).mkv', 'v (2) (2).mkv'],
  ]);
});

test('planFlatten은 타겟 바로 아래의 폴더 이름도 피한다', () => {
  const dir = tempDir();
  make(dir, ['report/report', 'other/x.txt', 'x.txt/inner.txt']);
  assert.deepStrictEqual(moves(planFlatten(dir)), [
    ['other/x.txt', 'x (2).txt'],
    ['report/report', 'report (2)'],
    ['x.txt/inner.txt', 'inner.txt'],
  ]);
});

test('planFlatten은 Windows에서 대소문자만 다른 이름도 겹친 것으로 본다', { skip: !isWindows }, () => {
  const dir = tempDir();
  make(dir, ['A.MKV', 'a/a.mkv', 'b/A.mkv']);
  assert.deepStrictEqual(
    planFlatten(dir).moves.map((move) => move.name),
    ['a (2).mkv', 'A (3).mkv'],
  );
});

// 모든 이동의 대상은 아직 없는 경로이고, 서로 겹치지 않으며, 이름이 경로와 일치해야 한다.
function assertSafeMoves(plan) {
  const seen = new Set();
  for (const { to, name } of plan.moves) {
    assert.strictEqual(path.basename(to), name);
    assert.strictEqual(path.dirname(to), plan.target);
    assert.ok(!fs.lstatSync(to, { throwIfNoEntry: false }), `이미 있는 대상: ${to}`);
    const key = isWindows ? name.toUpperCase() : name;
    assert.ok(!seen.has(key), `겹치는 대상: ${name}`);
    seen.add(key);
  }
}

test('planFlatten은 기존 파일의 8.3 짧은 이름과 겹치는 이름을 피한다', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  make(dir, ['longfilename.txt', 'longfoldername/x.txt']);
  if (!fs.existsSync(path.join(dir, 'LONGFI~1.TXT'))) return t.skip('이 볼륨은 8.3 이름이 꺼져 있다');
  make(dir, ['sub/LONGFI~1.TXT', 'sub/LONGFO~1']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name).sort(), ['LONGFI~1 (2).TXT', 'LONGFO~1 (2)', 'x.txt']);
  assertSafeMoves(plan);
});

test('planFlatten은 Windows에서 그리스어 시그마처럼 문맥을 타는 대소문자도 겹친 것으로 본다', { skip: !isWindows }, () => {
  const dir = tempDir();
  make(dir, ['ΑΣ', 'sub/ασ', 'a/ΒΣ', 'b/βσ']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['ΒΣ', 'βσ (2)', 'ασ (2)']);
  assertSafeMoves(plan);
});

test('planFlatten은 타겟 바로 아래의 링크와 끊어진 링크의 이름도 피한다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['gone/x', 'real/x', 'target/a/lnk', 'target/a/brk']);
  linkDir(path.join(root, 'real'), path.join(target, 'lnk'));
  linkDir(path.join(root, 'gone'), path.join(target, 'brk'));
  fs.rmSync(path.join(root, 'gone'), { recursive: true });
  const plan = planFlatten(target);
  assert.deepStrictEqual(plan.moves.map((move) => move.name).sort(), ['brk (2)', 'lnk (2)']);
  assert.deepStrictEqual(plan.stay.sort(), [path.join(target, 'brk'), path.join(target, 'lnk')]);
  assertSafeMoves(plan);
});

test('planFlatten은 끊어진 하위 링크를 건너뛴다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['gone/x', 'target/a/ok.txt']);
  linkDir(path.join(root, 'gone'), path.join(target, 'a', 'brk'));
  fs.rmSync(path.join(root, 'gone'), { recursive: true });
  const plan = planFlatten(target);
  assert.deepStrictEqual(moves(plan), [['a/ok.txt', 'ok.txt']]);
  assert.deepStrictEqual(plan.skipped.map((item) => item.path), [path.join(target, 'a', 'brk')]);
});

test('planFlatten은 점으로 시작하는 이름에도 번호를 붙인다', () => {
  const dir = tempDir();
  make(dir, ['a/..foo', 'b/..foo', 'c/.x.y', 'd/.x.y']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['..foo', '. (2).foo', '.x.y', '.x (2).y']);
  assertSafeMoves(plan);
});

test('planFlatten은 같은 이름이 많아도 번호를 겹치지 않게 차례로 붙인다', () => {
  const dir = tempDir();
  const files = Array.from({ length: 300 }, (_, i) => `d${String(i).padStart(3, '0')}/readme.txt`);
  make(dir, [...files, 'readme (5).txt']);
  const plan = planFlatten(dir);
  assert.strictEqual(plan.moves.length, 300);
  assert.strictEqual(plan.moves[0].name, 'readme.txt');
  assert.strictEqual(plan.moves[4].name, 'readme (6).txt');
  assertSafeMoves(plan);
});

test('planFlatten은 이름 한도까지는 번호를 붙이고 넘으면 건너뛴다', () => {
  const dir = tempDir();
  // 번호 " (2)"가 4글자이므로 원래 이름이 251자면 딱 255자가 된다.
  const fits = `${'F'.repeat(247)}.txt`;
  const over = `${'L'.repeat(248)}.txt`;
  make(dir, [fits, `a/${fits}`, over, `b/${over}`]);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name.length), [255]);
  assert.strictEqual(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /이름이 너무 깁니다/);
  assertSafeMoves(plan);
});

test('planFlatten은 링크를 따라가지 않고 건너뛴 항목으로 알려 준다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['outside/secret.txt', 'target/a/one.txt']);
  linkDir(path.join(root, 'outside'), path.join(target, 'a', 'escape'));
  linkDir(path.join(root, 'outside'), path.join(target, 'top-link'));
  const plan = planFlatten(target);
  assert.deepStrictEqual(moves(plan), [['a/one.txt', 'one.txt']]);
  assert.deepStrictEqual(plan.skipped.map((item) => item.path), [path.join(target, 'a', 'escape')]);
  assert.match(plan.skipped[0].reason, /링크/);
  assert.deepStrictEqual(plan.stay, [path.join(target, 'top-link')]);
});

test('planFlatten은 Windows에서 해석이 갈리는 이름을 조용히 빼지 않고 사유와 함께 건너뛴다', { skip: !isWindows }, () => {
  const dir = tempDir();
  make(dir, ['a/ok.txt', 'a/dot.', 'a/Con.Air.1997.mkv', 'weird./inner.txt']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['a/ok.txt', 'ok.txt']]);
  assert.deepStrictEqual(plan.skipped.map((item) => path.relative(dir, item.path)).sort(), [path.join('a', 'Con.Air.1997.mkv'), path.join('a', 'dot.'), path.join('weird.', 'inner.txt')].sort());
  for (const item of plan.skipped) assert.match(item.reason, /다르게 해석될 수 있는 이름/);
});

test('planFlatten은 건너뛴 파일의 이름을 다른 파일에 주지 않는다', { skip: !isWindows }, () => {
  const dir = tempDir();
  make(dir, ['a/dot.', 'b/dot']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['b/dot', 'dot']]);
  assert.strictEqual(plan.skipped.length, 1);
});

test('planFlatten은 번호를 붙여 이름 한도를 넘으면 건너뛴다', () => {
  const dir = tempDir();
  const long = `${'L'.repeat(251)}.txt`;
  make(dir, [long, `a/${long}`]);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves, []);
  assert.match(plan.skipped[0].reason, /이름이 너무 깁니다/);
});

test('planFlatten은 타겟 자체가 올바르지 않으면 오류를 낸다', () => {
  const dir = tempDir();
  make(dir, ['f.txt']);
  assert.throws(() => planFlatten(path.join(dir, 'nope')), FcError);
  assert.throws(() => planFlatten(path.join(dir, 'f.txt')), FcError);
  assert.throws(() => planFlatten(undefined), FcError);
});

test('planFlatten은 하위 폴더를 읽지 못하면 일부 계획 대신 오류를 낸다', (t) => {
  const dir = tempDir();
  make(dir, ['ok/a.txt', 'locked/b.txt']);
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (path.basename(p) === 'locked') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return readdir(p, options);
  });
  assert.throws(() => planFlatten(dir), (err) => err instanceof FcError && err.message.includes('EPERM'));
});

test('planFlatten은 대상 이름을 확인하지 못한 파일만 건너뛰고 계획을 이어 간다', (t) => {
  const dir = tempDir();
  make(dir, ['a/bad.txt', 'b/ok.txt']);
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p, options) => {
    if (p === path.join(dir, 'bad.txt')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return lstat(p, options);
  });
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['b/ok.txt', 'ok.txt']]);
  assert.deepStrictEqual(plan.skipped.map((item) => item.path), [path.join(dir, 'a', 'bad.txt')]);
  assert.match(plan.skipped[0].reason, /EPERM/);
});

test('detailedName은 폴더명이 파일명을 포함하고 더 길면 폴더명을 쓰고 확장자를 유지한다', () => {
  assert.strictEqual(detailedName('ABC-123.mp4', ['ABC-123 제목']), 'ABC-123 제목.mp4');
  assert.strictEqual(detailedName('abc_123.mkv', ['[ABC-123] 제목']), '[ABC-123] 제목.mkv');
  assert.strictEqual(detailedName('abc123.MKV', ['ABC 123 긴 제목']), 'ABC 123 긴 제목.MKV');
  assert.strictEqual(detailedName('영상.mp4', ['여름 영상 모음']), '여름 영상 모음.mp4');
});

test('detailedName은 파일명이 폴더명을 포함하거나 내용이 같으면 파일명을 유지한다', () => {
  assert.strictEqual(detailedName('ABC-123 제목.mp4', ['ABC-123']), 'ABC-123 제목.mp4');
  assert.strictEqual(detailedName('ABC-123.mp4', ['abc_123']), 'ABC-123.mp4');
  assert.strictEqual(detailedName('report.pdf', ['report']), 'report.pdf');
});

test('detailedName은 포함 관계가 없으면 폴더명에만 제품번호가 있을 때 폴더명을 쓴다', () => {
  assert.strictEqual(detailedName('video.mp4', ['ABC-123 제목']), 'ABC-123 제목.mp4');
  assert.strictEqual(detailedName('ABC-123.mp4', ['여름 휴가 영상']), 'ABC-123.mp4');
  assert.strictEqual(detailedName('XYZ-999.mp4', ['ABC-123']), 'XYZ-999.mp4');
  // 영숫자가 이어지면 제품번호로 보지 않는다.
  assert.strictEqual(detailedName('x.mp4', ['encoded_1080p']), 'x.mp4');
  assert.strictEqual(detailedName('x.mp4', ['1ABC-123']), 'x.mp4');
});

test('detailedName은 판단이 서지 않으면 길이가 길어도 폴더명을 쓰지 않는다', () => {
  assert.strictEqual(detailedName('x.mp4', ['아주 긴 폴더 이름입니다']), 'x.mp4');
  assert.strictEqual(detailedName('video.mp4', ['새 폴더 (2)']), 'video.mp4');
  assert.strictEqual(detailedName('영상.mp4', ['H264', 'BD1080']), '영상.mp4');
});

test('detailedName은 내용이 없는 이름을 비교하지 않고 폴더 이름의 확장자를 겹치지 않게 한다', () => {
  assert.strictEqual(detailedName('---.mp4', ['ABC 제목']), '---.mp4');
  assert.strictEqual(detailedName('ABC-123.mp4', ['---']), 'ABC-123.mp4');
  assert.strictEqual(detailedName('..foo', ['abc']), '..foo');
  assert.strictEqual(detailedName('ABC-123.mp4', ['ABC-123 제목.MP4']), 'ABC-123 제목.mp4');
});

test('detailedName은 짧은 파일명이 폴더명에 글자로만 겹칠 때 폴더명을 쓰지 않는다', () => {
  for (const [file, folder] of [
    ['v.mp4', 'movie'],
    ['o.txt', 'out'],
    ['a.jpg', 'Downloads'],
    ['2.mp4', '2021 사진 1'],
    ['1.mp4', '2021'],
    ['01.mp4', '2001 Space'],
    ['ko.srt', 'Kokoro'],
    ['en.srt', 'Frozen'],
    ['영상.mp4', '여름영상모음'],
  ]) {
    assert.strictEqual(detailedName(file, [folder]), file, `${file} + ${folder}`);
  }
});

test('detailedName은 일반 이름을 제품번호로 보지 않고 파일명의 정보를 지우지 않는다', () => {
  for (const [file, folder] of [
    ['2023년 결산 보고서.pdf', 'Report_2023'],
    ['2024-05-01 회의.mp4', 'Vlog-2024'],
    ['Episode 5.mkv', 'Season_01'],
    ['beach.jpg', 'Photos_2021'],
    ['setup.exe', 'Windows_10'],
    ['Movie.2021.1080p.KOR.mkv', 'New_Folder_01'],
    ['Movie.2021.1080p.KOR.mkv', 'ABC-123'],
    ['video_final_encoded_1080p.mp4', 'ABC-123'],
    ['movie.en.srt', 'ABC-123'],
    ['movie.part1.rar', 'ABC-123'],
    ['ABC123.mp4', 'XYZ-999'],
    ['2.mp4', 'ABC-123'],
    ['계약서.pdf', 'BACKUP-2024'],
    ['보고서.pdf', 'FY-2023'],
    ['최종결산보고서.pdf', 'COVID-19'],
    ['beach.jpg', 'DCIM-01'],
    ['setup.exe', 'NVIDIA-55'],
    ['ko.srt', 'ABC-123'],
  ]) {
    assert.strictEqual(detailedName(file, [folder]), file, `${file} + ${folder}`);
  }
});

test('detailedName은 확장자 없는 파일, 점 파일, tar 겹 확장자에 폴더명을 쓰지 않는다', () => {
  for (const [file, folder] of [
    ['noext', 'noext 제목'],
    ['README', 'ABC-123'],
    ['data', 'data.zip'],
    ['payload', 'payload.exe'],
    ['README', 'ABC-123.exe'],
    ['.env', 'my .env 모음'],
    ['.DS_Store', 'ABC-123'],
    ['.env.local', 'ABC-123'],
    ['.gitignore.bak', 'ABC-123 제목'],
    ['.eslintrc.json', 'eslintrc 설정'],
    ['Dr. Strange', 'ABC-123'],
    ['Dr. Strange', 'Dr 모음'],
    ['Chapter.1', 'ABC-123 제목'],
    ['x.tar.gz', 'ABC-123 제목'],
    ['a.tar.gz', 'a.tar 설명'],
  ]) {
    assert.strictEqual(detailedName(file, [folder]), file, `${file} + ${folder}`);
  }
});

test('detailedName은 폴더명이 다른 확장자로 끝나면 이중 확장자를 만들지 않는다', () => {
  assert.strictEqual(detailedName('x.mp4', ['ABC-123.mkv']), 'x.mp4');
  assert.strictEqual(detailedName('report.pdf', ['report.zip']), 'report.pdf');
  assert.strictEqual(detailedName('ABC-123.mp4', ['ABC-123 제목.zip']), 'ABC-123.mp4');
  assert.strictEqual(detailedName('x.mp4', ['ABC-123.torrent']), 'x.mp4');
  assert.strictEqual(detailedName('x.txt', ['ABC-123.backup']), 'x.txt');
  assert.strictEqual(detailedName('x.mp4', ['ABC-123.7z']), 'x.mp4');
  // 숫자로 시작하는 끝부분은 확장자로 보지 않는다.
  assert.strictEqual(detailedName('Movie.mp4', ['Movie.2021.1080p']), 'Movie.2021.1080p.mp4');
});

test('detailedName은 정보가 없는 파일명만 제품번호 폴더 이름으로 바꾼다', () => {
  for (const name of ['video', 'Movie', 'x', '영상', '파일', 'untitled']) {
    assert.strictEqual(detailedName(`${name}.mp4`, ['ABC-123 제목']), 'ABC-123 제목.mp4', name);
  }
});

test('detailedName은 점으로 시작하는 폴더 이름을 쓰지 않는다', () => {
  assert.strictEqual(detailedName('x.mp4', ['.ABC-123']), 'x.mp4');
  assert.strictEqual(detailedName('trash.mp4', ['.trash-1000']), 'trash.mp4');
  assert.strictEqual(detailedName('x.mp4', ['ABC-123 제목', '.ABC-999']), 'ABC-123 제목.mp4');
});

test('detailedName은 위 폴더로 올라가며 가장 자세한 이름을 고른다', () => {
  assert.strictEqual(detailedName('x.mp4', ['video', 'ABC-123 제목']), 'ABC-123 제목.mp4');
  assert.strictEqual(detailedName('ABC-123.mp4', ['ABC-123 제목', 'ABC-123 제목 완전판']), 'ABC-123 제목 완전판.mp4');
  assert.strictEqual(detailedName('ABC-123.mp4', ['ABC-123 제목', '여름 영상']), 'ABC-123 제목.mp4');
});

test('detailedName은 NFC와 NFD 한글을 같은 내용으로 본다', () => {
  // 탐색기에서 똑같아 보이는 이름이 생기지 않도록 폴더 이름은 NFC로 맞춘다.
  assert.strictEqual(detailedName('한글.mp4', ['한글 제목'.normalize('NFD')]), '한글 제목.mp4');
});

test('planFlatten은 유일한 파일에만 폴더명을 쓰고 표시를 남긴다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/ABC-123.mp4', 'XYZ-001 시리즈/XYZ-001 ep1.mp4', 'XYZ-001 시리즈/XYZ-001 ep2.mp4']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map(({ name, fromFolder, numbered }) => [name, fromFolder, numbered]), [
    ['ABC-123 제목.mp4', true, false],
    ['XYZ-001 ep1.mp4', false, false],
    ['XYZ-001 ep2.mp4', false, false],
  ]);
  assert.strictEqual(plan.moves[0].to, path.join(dir, 'ABC-123 제목.mp4'));
});

test('planFlatten은 한 갈래로 이어진 폴더까지 거슬러 올라가지만 파일이 여럿인 폴더에서 멈춘다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/video/x.mp4', 'DEF-456 묶음/a/x.mp4', 'DEF-456 묶음/b/y.mp4']);
  assert.deepStrictEqual(moves(planFlatten(dir)), [
    ['ABC-123 제목/video/x.mp4', 'ABC-123 제목.mp4'],
    ['DEF-456 묶음/a/x.mp4', 'x.mp4'],
    ['DEF-456 묶음/b/y.mp4', 'y.mp4'],
  ]);
});

test('planFlatten은 링크가 함께 있는 폴더의 파일을 유일한 파일로 보지 않는다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['outside/o.txt', 'target/ABC-123 제목/video.mp4']);
  linkDir(path.join(root, 'outside'), path.join(target, 'ABC-123 제목', 'link'));
  assert.deepStrictEqual(planFlatten(target).moves.map((move) => move.name), ['video.mp4']);
});

test('planFlatten은 폴더명으로 고른 이름이 겹치면 번호를 붙이고 numbered를 표시한다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목.mp4', 'ABC-123 제목/ABC-123.mp4']);
  const [move] = planFlatten(dir).moves;
  assert.deepStrictEqual([move.name, move.fromFolder, move.numbered], ['ABC-123 제목 (2).mp4', true, true]);
});

test('planFlatten은 폴더 이름으로 만든 이름이 길이 한도를 넘으면 원래 파일 이름으로 옮긴다', () => {
  const dir = tempDir();
  const long = `ABC-123 ${'가'.repeat(247)}`;
  make(dir, [`${long}/ABC-123.mp4`]);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map(({ name, fromFolder }) => [name, fromFolder]), [['ABC-123.mp4', false]]);
  assert.deepStrictEqual(plan.skipped, []);
});

test('planFlatten은 Windows에서 해석이 갈리는 폴더 안의 파일을 건너뛰고 그 폴더 이름을 쓰지 않는다', { skip: !isWindows }, () => {
  const dir = tempDir();
  make(dir, ['AUX/AU.mp4', 'Con.Air/Air.mp4']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves, []);
  assert.strictEqual(plan.skipped.length, 2);
  for (const item of plan.skipped) assert.match(item.reason, /다르게 해석될 수 있는 이름/);
});

test('planFlatten은 폴더명으로 고른 이름에 번호를 붙여 한도를 넘으면 원래 이름으로 돌아간다', () => {
  const dir = tempDir();
  // 폴더 이름에서 .mp4를 뺀 이름에 다시 .mp4를 붙이면 자기 부모 폴더와 겹쳐 번호가 필요하다.
  const folder = `ABC-123 ${'가'.repeat(243)}.mp4`;
  make(dir, [`${folder}/x.mp4`]);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map(({ name, fromFolder, numbered }) => [name, fromFolder, numbered]), [['x.mp4', false, false]]);
  assert.deepStrictEqual(plan.skipped, []);
});

test('planFlatten은 비워질 자기 부모 폴더와 같은 이름도 피해 번호를 붙인다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목.mp4/x.mp4']);
  const [move] = planFlatten(dir).moves;
  assert.deepStrictEqual([move.name, move.fromFolder, move.numbered], ['ABC-123 제목 (2).mp4', true, true]);
});

test('planFlatten은 두 폴더가 같은 이름으로 모이면 번호로 구분한다', () => {
  const dir = tempDir();
  make(dir, ['a/ABC-123 제목/x.mp4', 'b/ABC-123 제목/y.mp4']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['ABC-123 제목.mp4', 'ABC-123 제목 (2).mp4']);
  assertSafeMoves(plan);
});

test('planFlatten은 NFC 파일이 있으면 NFD 폴더명에서 만든 이름에도 번호를 붙인다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목.mp4', `${'ABC-123 제목'.normalize('NFD')}/x.mp4`]);
  assert.deepStrictEqual(planFlatten(dir).moves.map((move) => move.name), ['ABC-123 제목 (2).mp4']);
});

test('planFlatten은 건너뛰는 파일이 같이 있으면 유일한 파일로 보지 않는다', { skip: !isWindows }, () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/CON.mp4', 'ABC-123 제목/x.mp4']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['x.mp4']);
  assert.strictEqual(plan.skipped.length, 1);
});

test('planFlatten은 빈 형제 폴더를 세지 않고 깊은 경로까지 올라간다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/a/b/c/d/x.mp4']);
  fs.mkdirSync(path.join(dir, 'ABC-123 제목', 'a', 'empty'));
  assert.deepStrictEqual(planFlatten(dir).moves.map((move) => move.name), ['ABC-123 제목.mp4']);
});

test('planFlatten은 타겟 바로 아래의 파일 이름을 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123.mp4']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves, []);
  assert.deepStrictEqual(plan.stay, [path.join(dir, 'ABC-123.mp4')]);
});

// 파일 경로와 내용을 모은다. make는 내용으로 원래 경로를 쓰므로 어느 파일이 어디로 갔는지 알 수 있다.
function contents(dir) {
  return Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return [path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')];
      }),
  );
}

test('flatten은 파일을 타겟 바로 아래로 옮기고 내용을 그대로 둔다', () => {
  const dir = tempDir();
  make(dir, ['a/one.mkv', 'a/b/c/two.mp4', 'top.txt']);
  const result = flatten(dir);
  assert.deepStrictEqual(contents(dir), { 'one.mkv': 'a/one.mkv', 'top.txt': 'top.txt', 'two.mp4': 'a/b/c/two.mp4' });
  assert.deepStrictEqual(result.moved.map((move) => move.name).sort(), ['one.mkv', 'two.mp4']);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.stay, [path.join(dir, 'top.txt')]);
});

test('flatten은 이름이 겹쳐도 덮어쓰지 않고 번호를 붙인다', () => {
  const dir = tempDir();
  make(dir, ['v.mkv', 'a/v.mkv', 'b/v.mkv', 'V (2).MKV/inner.txt']);
  flatten(dir);
  const files = contents(dir);
  assert.deepStrictEqual(Object.values(files).sort(), ['V (2).MKV/inner.txt', 'a/v.mkv', 'b/v.mkv', 'v.mkv']);
  assert.strictEqual(files['v.mkv'], 'v.mkv');
  assert.strictEqual(files['v (3).mkv'], 'a/v.mkv');
  assert.strictEqual(files['v (4).mkv'], 'b/v.mkv');
});

test('flatten은 폴더명으로 고른 이름으로 옮기고 확장자를 유지한다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/abc_123.mp4', 'XYZ-001 시리즈/ep1.mp4', 'XYZ-001 시리즈/ep2.mp4']);
  flatten(dir);
  assert.deepStrictEqual(contents(dir), {
    'ABC-123 제목.mp4': 'ABC-123 제목/abc_123.mp4',
    'ep1.mp4': 'XYZ-001 시리즈/ep1.mp4',
    'ep2.mp4': 'XYZ-001 시리즈/ep2.mp4',
  });
});

test('flatten은 계획끼리의 8.3 짧은 이름 겹침을 실행 때 잡아 덮어쓰지 않는다', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  make(dir, ['probe-long-file-name.txt']);
  const hasShortNames = fs.existsSync(path.join(dir, 'PROBE-~1.TXT'));
  fs.rmSync(path.join(dir, 'probe-long-file-name.txt'));
  if (!hasShortNames) return t.skip('이 볼륨은 8.3 이름이 꺼져 있다');
  make(dir, ['a/longfilename.txt', 'b/LONGFI~1.TXT']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['longfilename.txt', 'LONGFI~1.TXT']);
  const result = flatten(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.moved.map(({ name, numbered }) => [name, numbered]), [
    ['longfilename.txt', false],
    ['LONGFI~1 (2).TXT', true],
  ]);
  const files = contents(dir);
  assert.strictEqual(files['longfilename.txt'], 'a/longfilename.txt');
  assert.strictEqual(files['LONGFI~1 (2).TXT'], 'b/LONGFI~1.TXT');
});

// 실행 단계의 첫 이동 직전에 끼어든다. 계획은 이미 끝난 뒤다.
function beforeFirstMove(t, action) {
  const open = fs.openSync;
  let done = false;
  t.mock.method(fs, 'openSync', (p, flags, ...rest) => {
    if (!done && flags === 'wx') {
      done = true;
      action();
    }
    return open(p, flags, ...rest);
  });
}

test('flatten은 계획 뒤에 대상 이름이 차면 번호를 다시 고르고 다른 계획의 이름을 뺏지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/v.txt', 'b/v.txt', 'c/w.txt']);
  beforeFirstMove(t, () => fs.writeFileSync(path.join(dir, 'v.txt'), 'someone else'));
  const result = flatten(dir);
  assert.deepStrictEqual(result.failed, []);
  // v (2).txt는 b/v.txt 몫으로 계획됐으므로 a/v.txt는 v (3).txt로 간다.
  assert.deepStrictEqual(result.moved.map(({ name, numbered }) => [name, numbered]), [
    ['v (3).txt', true],
    ['v (2).txt', true],
    ['w.txt', false],
  ]);
  assert.deepStrictEqual(contents(dir), { 'v.txt': 'someone else', 'v (3).txt': 'a/v.txt', 'v (2).txt': 'b/v.txt', 'w.txt': 'c/w.txt' });
});

test('flatten은 계획 뒤에 대상이 끊어진 정션이 되면 정션을 지우지 않고 타겟 밖에 폴더를 만들지 않는다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['out/keep.txt', 'out/gone/x', 'target/a/x.txt']);
  const plan = planFlatten(target);
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['x.txt']);
  linkDir(path.join(root, 'out', 'gone'), path.join(target, 'x.txt'));
  fs.rmSync(path.join(root, 'out', 'gone'), { recursive: true });
  // 계획을 다시 세우면 이름을 피하므로, 실행 단계만 시험하도록 첫 lstat을 숨긴다.
  const lstat = fs.lstatSync;
  const hide = test.mock.method(fs, 'lstatSync', (p, options) => {
    if (p === path.join(target, 'x.txt') && hide.mock.calls.filter((call) => call.arguments[0] === p).length <= 1) return undefined;
    return lstat(p, options);
  });
  try {
    const result = flatten(target);
    assert.deepStrictEqual(result.failed, []);
    assert.deepStrictEqual(result.moved.map((move) => move.name), ['x (2).txt']);
  } finally {
    hide.mock.restore();
  }
  assert.ok(fs.lstatSync(path.join(target, 'x.txt')).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(root, 'out', 'gone')));
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'out')), ['keep.txt']);
});

test('flatten은 계획 뒤에 원본이 폴더로 바뀌면 옮기지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/ok.txt']);
  const realpath = fs.realpathSync.native;
  let calls = 0;
  t.mock.method(fs.realpathSync, 'native', (p) => {
    if (p === path.join(dir, 'a', 'x.txt') && ++calls === 2) {
      fs.rmSync(p);
      fs.mkdirSync(p);
      fs.writeFileSync(path.join(p, 'inner.txt'), 'inner');
    }
    return realpath(p);
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.moved.map((move) => move.name), ['ok.txt']);
  assert.match(result.failed[0].reason, /파일이 아니게/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'x.txt', 'inner.txt'), 'utf8'), 'inner');
});

test('flatten은 계획 뒤에 부모가 안쪽을 가리키는 정션으로 바뀌면 다른 파일을 옮기지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/x.txt', 'c/ok.txt']);
  const realpath = fs.realpathSync.native;
  let calls = 0;
  t.mock.method(fs.realpathSync, 'native', (p) => {
    if (p === path.join(dir, 'a', 'x.txt') && ++calls === 2) {
      fs.rmSync(path.join(dir, 'a'), { recursive: true });
      linkDir(path.join(dir, 'b'), path.join(dir, 'a'));
    }
    return realpath(p);
  });
  const result = flatten(dir);
  assert.match(result.failed[0].reason, /경로가 바뀌었습니다/);
  // b/x.txt는 a의 몫이 아니라 자기 몫으로 옮겨진다.
  assert.strictEqual(contents(dir)['x (2).txt'], 'b/x.txt');
  assert.ok(!Object.keys(contents(dir)).includes('x.txt'));
});

test('flatten은 자리표시에 다른 내용이 생기면 지우지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  t.mock.method(fs, 'renameSync', () => {
    fs.writeFileSync(path.join(dir, 'x.txt'), 'someone else');
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  const result = flatten(dir);
  assert.match(result.failed[0].reason, /다른 내용이 생겨/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'someone else');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'x.txt'), 'utf8'), 'a/x.txt');
});

test('flatten은 Git 저장소가 들어 있으면 아무것도 옮기지 않는다', () => {
  for (const files of [['.git/HEAD', 'a/x.txt'], ['sub/.git/HEAD', 'sub/src/x.js', 'y/z.txt'], ['sub/.git', 'sub/x.js'], ['sub/.GIT/HEAD', 'q/x.txt']]) {
    const dir = tempDir();
    make(dir, files);
    const before = contents(dir);
    assert.throws(() => flatten(dir), /저장소/, files.join(' '));
    assert.throws(() => flatten(dir, { dryRun: true }), /저장소/);
    assert.throws(() => planFlatten(dir), /저장소/);
    assert.deepStrictEqual(contents(dir), before);
  }
});

const GIT_FILES = ['HEAD', 'objects/ab/cdef', 'refs/heads/main'];

test('flatten은 베어 저장소가 들어 있거나 타겟이 저장소 폴더 안이면 아무것도 옮기지 않는다', () => {
  const dir = tempDir();
  make(dir, [...GIT_FILES.map((f) => `T/backup.git/${f}`), 'T/a/y.txt', ...GIT_FILES.map((f) => `r/.git/${f}`), 'r/src/deep/x.js']);
  const before = contents(dir);
  for (const target of ['T', 'T/backup.git', 'T/backup.git/objects', 'r/.git', 'r/.git/objects', 'r']) {
    assert.throws(() => flatten(path.join(dir, target)), /저장소/, target);
    assert.throws(() => planFlatten(path.join(dir, target)), /저장소/, target);
  }
  assert.deepStrictEqual(contents(dir), before);
});

test('flatten은 저장소의 일반 하위 폴더와 HEAD 파일만 있는 폴더를 거부하지 않는다', () => {
  const dir = tempDir();
  make(dir, [...GIT_FILES.map((f) => `r/.git/${f}`), 'r/src/deep/x.js', 'plain/h/HEAD', 'plain/h/x.txt']);
  assert.deepStrictEqual(flatten(path.join(dir, 'r', 'src')).moved.map((move) => move.name), ['x.js']);
  assert.deepStrictEqual(flatten(path.join(dir, 'plain')).moved.map((move) => move.name).sort(), ['HEAD', 'x.txt']);
  assert.ok(fs.existsSync(path.join(dir, 'r', '.git', 'objects', 'ab', 'cdef')));
});

test('fctl flatten은 드라이브 문자만 쓴 타겟을 거부하고 절대경로는 받는다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  for (const target of ['C:', 'c:', 'D:sub']) {
    assert.throws(() => run(['flatten', target, '--dry-run']), /드라이브 문자/, target);
  }
  assert.match(run(['flatten', dir, '--dry-run']), /이동 1개/);
});

test('flatten은 자리표시가 이미 사라졌으면 원래 오류를 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  t.mock.method(fs, 'renameSync', () => {
    fs.rmSync(path.join(dir, 'x.txt'));
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  const result = flatten(dir);
  assert.match(result.failed[0].reason, /locked/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'x.txt'), 'utf8'), 'a/x.txt');
});

test('flatten은 자리표시를 확인하지 못해도 원래 오류 코드를 남긴다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  const lstat = fs.lstatSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', () => {
    failed = true;
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  t.mock.method(fs, 'lstatSync', (p, options) => {
    if (failed && p === path.join(dir, 'x.txt')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return lstat(p, options);
  });
  const result = flatten(dir);
  assert.match(result.failed[0].reason, /EBUSY, EPERM/);
});

test('flatten은 다른 버전 관리 폴더가 들어 있거나 타겟이 그 안이어도 아무것도 옮기지 않는다', () => {
  for (const name of ['.hg', '.svn', '.jj', '.SVN']) {
    const dir = tempDir();
    make(dir, [`p/${name}/store/data`, 'p/src/x.txt']);
    const before = contents(dir);
    assert.throws(() => flatten(dir), /저장소/, name);
    assert.throws(() => flatten(path.join(dir, 'p', name)), /저장소/, name);
    assert.deepStrictEqual(contents(dir), before);
  }
});

test('flatten은 이름만 비슷한 .gitignore, .github를 저장소로 보지 않는다', () => {
  const dir = tempDir();
  make(dir, ['p/.gitignore', '.github/ci.yml', 'q/git/x.txt']);
  assert.deepStrictEqual(flatten(dir).moved.map((move) => move.name).sort(), ['.gitignore', 'ci.yml', 'x.txt']);
});

test('flatten은 Windows 시스템 폴더 안의 파일을 옮기지 않고 사유를 남긴다', () => {
  const dir = tempDir();
  make(dir, ['$RECYCLE.BIN/S-1-5/$Rabc.txt', 'sub/System Volume Information/t.dat', 'q/$recycle.bin/y.txt', 'a/ok.txt']);
  const result = flatten(dir);
  assert.deepStrictEqual(result.moved.map((move) => move.name), ['ok.txt']);
  assert.strictEqual(result.skipped.filter((item) => /시스템 폴더/.test(item.reason)).length, 3);
  assert.ok(fs.existsSync(path.join(dir, '$RECYCLE.BIN', 'S-1-5', '$Rabc.txt')));
});

test('flatten은 잔여물과 이름만 비슷한 정상 파일을 구분한다', () => {
  const dir = tempDir();
  make(dir, ['a/.fctl-old-2024-01-보고서.txt', 'b/.fctl-new-2-3메모.md', 'c/.fctl-old-1.txt', 'd/.fctl-old-1-2-0.bak', 'e/.fctl-new-1-2-0.tar.gz']);
  const result = flatten(dir);
  assert.deepStrictEqual(result.moved.map((move) => move.name).sort(), ['.fctl-new-2-3메모.md', '.fctl-old-1.txt', '.fctl-old-2024-01-보고서.txt'].sort());
  assert.strictEqual(result.skipped.length, 2);
});

test('flatten은 정션을 거친 타겟에서 실제 폴더에 적용하고 정션을 그대로 둔다', () => {
  const root = tempDir();
  make(root, ['real/a/x.txt']);
  linkDir(path.join(root, 'real'), path.join(root, 'alias'));
  const result = flatten(path.join(root, 'alias'));
  assert.strictEqual(result.target, path.join(root, 'real'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'real', 'x.txt'), 'utf8'), 'real/a/x.txt');
  assert.ok(fs.lstatSync(path.join(root, 'alias')).isSymbolicLink());
});

test('fctl flatten을 프로세스로 실행하면 성공은 0, 인자 오류와 저장소는 1로 끝난다', () => {
  const root = tempDir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  make(root, ['t/a/x.txt', 'wide/sub folder/b/y.txt', 'wide/z/q.txt', 'repo/.git/HEAD', 'repo/a/b.txt']);
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const bin = path.join(__dirname, '..', 'bin', 'fctl.js');
  const fctl = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });
  const ok = fctl('flatten', path.join(root, 't'));
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /이동 1개/);
  assert.ok(fs.existsSync(path.join(root, 't', 'x.txt')));
  // 따옴표 없는 공백 경로: 앞부분인 wide를 평탄화하면 안 된다.
  const split = fctl('flatten', path.join(root, 'wide'), 'sub', 'folder');
  assert.strictEqual(split.status, 1);
  assert.match(split.stderr, /타겟은 하나만/);
  // -- 뒤의 --dry-run은 옵션이 아니므로 실제로 옮기면 안 된다.
  const hidden = fctl('flatten', '--', path.join(root, 'wide'), '--dry-run');
  assert.strictEqual(hidden.status, 1);
  assert.ok(fs.existsSync(path.join(root, 'wide', 'z', 'q.txt')));
  const permanent = fctl('flatten', path.join(root, 'wide'), '--permanent');
  assert.strictEqual(permanent.status, 1);
  const repo = fctl('flatten', path.join(root, 'repo'));
  assert.strictEqual(repo.status, 1);
  assert.match(repo.stderr, /저장소/);
  assert.ok(fs.existsSync(path.join(root, 'repo', 'a', 'b.txt')));
});

test('flatten은 비어 있는 다음 번호 없이 이름 한도를 넘으면 실패로 알린다', (t) => {
  const dir = tempDir();
  const fits = `${'F'.repeat(251)}.txt`;
  make(dir, [`a/${fits}`]);
  beforeFirstMove(t, () => fs.writeFileSync(path.join(dir, fits), 'someone else'));
  const result = flatten(dir);
  assert.match(result.failed[0].reason, /이름이 너무 깁니다/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', fits), 'utf8'), `a/${fits}`);
});

test('flatten은 대상이 그사이 폴더가 돼도 그 안으로 넣거나 덮어쓰지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/v.txt', 'b/z.txt']);
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (p, flags, ...rest) => {
    if (flags === 'wx' && path.basename(p) === 'v.txt' && !fs.existsSync(path.join(dir, 'v.txt'))) fs.mkdirSync(path.join(dir, 'v.txt'));
    return original(p, flags, ...rest);
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'v.txt')), []);
  assert.strictEqual(contents(dir)['v (2).txt'], 'a/v.txt');
});

test('flatten은 한 파일이 실패해도 나머지를 옮기고 자리표시 파일을 남기지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/locked.txt', 'b/ok.txt']);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from) === 'locked.txt') throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.moved.map((move) => move.name), ['ok.txt']);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].from, path.join(dir, 'a', 'locked.txt'));
  assert.match(result.failed[0].reason, /locked/);
  assert.deepStrictEqual(contents(dir), { 'a/locked.txt': 'a/locked.txt', 'ok.txt': 'b/ok.txt' });
});

test('flatten은 자리표시 파일을 지우지 못하면 그 위치를 실패 사유에 남긴다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  const rm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p, options) => {
    if (p === path.join(dir, 'x.txt')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return rm(p, options);
  });
  const result = flatten(dir);
  assert.match(result.failed[0].reason, /자리표시 파일/);
  assert.ok(result.failed[0].reason.includes(path.join(dir, 'x.txt')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'x.txt'), 'utf8'), 'a/x.txt');
});

test('flatten은 계획 뒤에 원본이 사라지면 그 항목만 실패로 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['a/gone.txt', 'b/ok.txt']);
  const write = fs.lstatSync;
  let removed = false;
  t.mock.method(fs, 'lstatSync', (p, options) => {
    // 실행 단계의 첫 원본 검사 직전에 지운다.
    if (!removed && p === path.join(dir, 'a', 'gone.txt')) {
      removed = true;
      fs.rmSync(p);
    }
    return write(p, options);
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.moved.map((move) => move.name), ['ok.txt']);
  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(Object.keys(contents(dir)), ['ok.txt']);
});

test('flatten은 계획 뒤에 원본이 타겟 밖 링크로 바뀌면 옮기지 않는다', (t) => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['outside/secret.txt', 'target/a/x.txt', 'target/b/ok.txt']);
  const realpath = fs.realpathSync.native;
  let calls = 0;
  t.mock.method(fs.realpathSync, 'native', (p) => {
    // 첫 호출은 계획 단계의 읽기 검사다. 실행 단계에서 검사하기 직전에 부모 폴더를 타겟 밖 정션으로 바꾼다.
    if (p === path.join(target, 'a', 'x.txt') && ++calls === 2) {
      fs.rmSync(path.join(target, 'a'), { recursive: true });
      linkDir(path.join(root, 'outside'), path.join(target, 'a'));
      fs.writeFileSync(path.join(root, 'outside', 'x.txt'), 'outside x');
    }
    return realpath(p);
  });
  const result = flatten(target);
  assert.strictEqual(calls, 2, '실행 단계에서 다시 검사해야 한다');
  assert.deepStrictEqual(result.moved.map((move) => move.name), ['ok.txt']);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /링크를 거쳐/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'outside', 'x.txt'), 'utf8'), 'outside x');
  assert.strictEqual(fs.readFileSync(path.join(root, 'outside', 'secret.txt'), 'utf8'), 'outside/secret.txt');
});

test('flatten --dry-run은 아무것도 바꾸지 않고 실제 실행과 같은 계획을 보여 준다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/abc_123.mp4', 'a/v.txt', 'b/v.txt', 'v.txt']);
  const before = contents(dir);
  const preview = flatten(dir, { dryRun: true });
  assert.deepStrictEqual(contents(dir), before);
  assert.strictEqual(preview.dryRun, true);
  const result = flatten(dir);
  assert.deepStrictEqual(result.moved, preview.moved);
});

test('flatten은 잔여물과 링크를 옮기지 않고 사유를 남긴다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['outside/o.txt', 'target/sub/.fctl-old-1-2-0', 'target/sub2/.fctl-new-1-2-0.zip', 'target/sub3/.fctl-old-9-9-0/inner.txt', 'target/sub4/.fctl-notes.txt', 'target/sub5/ok.txt']);
  linkDir(path.join(root, 'outside'), path.join(target, 'sub5', 'lnk'));
  const result = flatten(target);
  assert.deepStrictEqual(result.moved.map((move) => move.name).sort(), ['.fctl-notes.txt', 'ok.txt']);
  assert.strictEqual(result.skipped.filter((item) => /잔여물/.test(item.reason)).length, 3);
  assert.strictEqual(result.skipped.filter((item) => /링크/.test(item.reason)).length, 1);
  assert.ok(fs.existsSync(path.join(target, 'sub', '.fctl-old-1-2-0')));
  assert.ok(fs.existsSync(path.join(target, 'sub3', '.fctl-old-9-9-0', 'inner.txt')));
  assert.strictEqual(fs.readFileSync(path.join(root, 'outside', 'o.txt'), 'utf8'), 'outside/o.txt');
});

test('flatten은 읽기 전용 파일도 옮기고 수정 시각을 유지한다', () => {
  const dir = tempDir();
  make(dir, ['a/ro.txt']);
  fs.chmodSync(path.join(dir, 'a', 'ro.txt'), 0o444);
  const { mtimeMs } = fs.statSync(path.join(dir, 'a', 'ro.txt'));
  flatten(dir);
  assert.strictEqual(fs.statSync(path.join(dir, 'ro.txt')).mtimeMs, mtimeMs);
  fs.chmodSync(path.join(dir, 'ro.txt'), 0o666);
});

test('flatten은 비게 된 폴더를 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, ['a/b/x.txt']);
  flatten(dir);
  assert.ok(fs.statSync(path.join(dir, 'a', 'b')).isDirectory());
});

test('formatFlatten은 이동, 건너뜀, 실패와 합계를 보여 준다', () => {
  const dir = path.resolve('/data/t');
  const text = formatFlatten({
    target: dir,
    dryRun: false,
    moved: [{ from: path.join(dir, 'a', 'x.mp4'), name: 'ABC-1 (2).mp4', fromFolder: true, numbered: true }],
    stay: [path.join(dir, 'top')],
    skipped: [{ path: path.join(dir, 'l'), reason: '링크' }],
    failed: [{ from: path.join(dir, 'b'), reason: 'locked' }],
  });
  assert.deepStrictEqual(text.split('\n'), [
    `이동: ${path.join('a', 'x.mp4')} -> ABC-1 (2).mp4 (폴더명 사용, 번호 붙임)`,
    '건너뜀: l (링크)',
    '실패: b (locked)',
    '이동 1개, 그대로 1개, 건너뜀 1개, 실패 1개',
  ]);
});

test('fctl flatten은 미리보기와 실제 실행을 처리하고 인자가 없으면 오류를 낸다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  const preview = run(['flatten', dir, '--dry-run']);
  assert.match(preview, /^\[미리보기\] 이동: /m);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'x.txt')));
  const done = run(['flatten', dir]);
  assert.doesNotMatch(done, /미리보기/);
  assert.match(done, /이동 1개/);
  assert.strictEqual(contents(dir)['x.txt'], 'a/x.txt');
  assert.throws(() => run(['flatten']), /사용법/);
  assert.throws(() => run(['flatten', dir, '--force']), /--force, --permanent를 쓸 수 없습니다/);
});

test('fctl flatten은 일부가 실패하면 옮긴 내용까지 담아 오류로 끝낸다', (t) => {
  const dir = tempDir();
  make(dir, ['a/locked.txt', 'b/ok.txt']);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from) === 'locked.txt') throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  assert.throws(() => run(['flatten', dir]), (err) => err instanceof FcError && /실패 1개/.test(err.message) && /ok\.txt/.test(err.message));
});

test('flatten은 보호 경로를 타겟으로 받지 않는다', (t) => {
  const root = tempDir();
  const home = path.join(root, 'kim');
  fs.mkdirSync(path.join(home, 'AppData'), { recursive: true });
  t.mock.method(os, 'homedir', () => home);
  assert.throws(() => flatten(home), /사용자 폴더/);
  assert.throws(() => flatten(path.join(home, 'AppData')), /보호된 경로/);
  assert.throws(() => run(['flatten', home, '--dry-run']), /사용자 폴더/);
});

test('planFlatten은 파일이 없는 타겟에서 빈 계획을 돌려준다', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  assert.deepStrictEqual(planFlatten(dir), { target: dir, moves: [], stay: [], skipped: [] });
});
