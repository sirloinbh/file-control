'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { planFlatten, detailedName } = require('../src/flatten');

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
  assert.deepStrictEqual(plan.moves[0], { from: path.join(dir, 'a', 'b', 'c', 'two.mp4'), to: path.join(dir, 'two.mp4'), name: 'two.mp4', fromFolder: false, numbered: false });
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
  // 숫자로 시작하는 끝부분은 확장자로 보지 않는다.
  assert.strictEqual(detailedName('Movie.mp4', ['Movie.2021.1080p']), 'Movie.2021.1080p.mp4');
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

test('planFlatten은 파일이 없는 타겟에서 빈 계획을 돌려준다', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  assert.deepStrictEqual(planFlatten(dir), { target: dir, moves: [], stay: [], skipped: [] });
});
