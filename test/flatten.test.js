'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// 테스트가 사용자 휴지통을 건드리지 않게, commands.js를 불러오기 전에 휴지통 호출을 가짜로 바꿔 둔다.
// 파일이나 링크가 든 폴더를 지우려 하면 테스트가 실패하도록 빈 폴더 트리만 지운다.
const recycled = [];
// 휴지통 호출 때 끼어들 동작. 테스트마다 정한다.
let onRecycle = () => {};
const execFileSync = childProcess.execFileSync;
// 숨김·시스템 속성 읽기(FC_ROOT)에 끼어들 동작. 값을 돌려주면 PowerShell 대신 그 값을 쓴다.
let onAttributes = null;
let volumeState = 'True|Fixed\r\n';
// 일괄 이동 한 번에 넘긴 폴더 수
const batchCalls = [];
// 일괄 이동 호출을 통째로 바꿀 때 쓴다(시간 초과 흉내 등).
let batchOverride = null;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_ROOT !== undefined && onAttributes) {
    const result = onAttributes(options);
    if (result !== undefined) return result;
  }
  // 휴지통 상태 확인은 기다리지 않게 고정 디스크로 답한다. volumeState를 바꿔 다른 드라이브를 흉내 낸다.
  if (options?.env?.FC_VOLUME !== undefined) return volumeState;
  // 빈 폴더 일괄 이동(#67). PowerShell이 지우기 직전에 하는 검사(실제 경로, 폴더 여부, 안의 파일·링크)를 흉내 낸다.
  if (options?.env?.FC_BATCH !== undefined && batchOverride) return batchOverride(options, file, args);
  if (options?.env?.FC_BATCH !== undefined) {
    assert.match(args.at(-1), /UserInteractive/, '비대화형 실행을 막는 검사가 있어야 한다');
    batchCalls.push(options.input.trim().split('\n').length);
    const lines = [];
    for (const line of options.input.split('\n').filter(Boolean)) {
      const folder = Buffer.from(line, 'base64').toString('utf16le');
      let status;
      try {
        onRecycle(folder);
        const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
        if (!stat) status = 'gone';
        else if (!stat.isDirectory() && !stat.isSymbolicLink()) status = 'notdir';
        else if (fs.realpathSync.native(folder) !== folder) status = 'moved';
        else if (fs.readdirSync(folder, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink() || (!entry.isDirectory() && !/^(?:desktop\.ini|thumbs\.db|ehthumbs(?:_vista)?\.db|\.DS_Store)$/i.test(entry.name)))) status = 'filled';
        else {
          recycled.push(folder);
          fs.rmSync(folder, { recursive: true });
          status = 'ok';
        }
      } catch (err) {
        if (err.status === 75) throw err;
        status = 'error';
      }
      lines.push(`${status} ${line}`);
    }
    return lines.join('\r\n') + '\r\n';
  }
  if (options?.env?.FC_TARGET === undefined) {
    if (String(args?.at(-1)).includes('SendToRecycleBin')) throw new Error('휴지통 호출이 가짜를 빠져나감');
    return execFileSync(file, args, options);
  }
  assert.match(args.at(-1), /UserInteractive/, '비대화형 실행을 막는 검사가 있어야 한다');
  recycled.push(options.env.FC_TARGET);
  onRecycle(options.env.FC_TARGET);
  // 폴더 설정·미리보기 파일(desktop.ini 등)만 남은 폴더는 함께 지운다(#65).
  const filled = fs.readdirSync(options.env.FC_TARGET, { recursive: true, withFileTypes: true }).find((entry) => !entry.isDirectory() && !/^(?:desktop\.ini|thumbs\.db|ehthumbs(?:_vista)?\.db|\.DS_Store)$/i.test(entry.name));
  if (filled) throw new Error(`비어 있지 않은 폴더를 휴지통으로 보내려 함: ${filled.name}`);
  fs.rmSync(options.env.FC_TARGET, { recursive: true });
  return undefined;
});

const { FcError, hiddenOrSystemEntries, recycleEmptyFolders, RECYCLE_FOLDERS_SCRIPT } = require('../src/commands');
const { planFlatten, withOuterFolder, detailedName, prefixedName, flatten, formatFlatten, moveWithoutOverwrite, leftoverNote } = require('../src/flatten');
const { deviceNamePattern } = require('../src/target');
const { run } = require('../bin/fctl');
const { spawnSync } = require('node:child_process');

const isWindows = process.platform === 'win32';

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로, 사용자 폴더를 임시 폴더 밖으로 바꿔 둔다.
// withHome으로 테스트 안에서만 다른 사용자 폴더를 쓸 수 있다(#148).
let fakeHome = null;
test.mock.method(os, 'homedir', () => fakeHome ?? path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

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
  // Con.Air.1997.mkv는 Windows 11 24H2 이상에서 장치 이름이 아니라 옮긴다(#53). 그 아래 버전에서는 건너뛴다.
  const windows11 = deviceNamePattern() === deviceNamePattern('10.0.26200');
  assert.deepStrictEqual(moves(plan), windows11 ? [['a/Con.Air.1997.mkv', 'Con.Air.1997.mkv'], ['a/ok.txt', 'ok.txt']] : [['a/ok.txt', 'ok.txt']]);
  const skipped = [path.join('a', 'dot.'), path.join('weird.', 'inner.txt'), ...(windows11 ? [] : [path.join('a', 'Con.Air.1997.mkv')])];
  assert.deepStrictEqual(plan.skipped.map((item) => path.relative(dir, item.path)).sort(), skipped.sort());
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

test('detailedName은 제품번호 규칙을 따라 폴더명을 고른다', () => {
  // 전각 번호도 찾고, 이름은 폴더에 적힌 그대로 쓴다.
  assert.strictEqual(detailedName('video.mp4', ['ＡＢＣ－１２３']), 'ＡＢＣ－１２３.mp4');
  // 제품번호가 아닌 폴더 이름도 정보 없는 파일명 대신 쓴다(#71). 한 글자 이름은 제품번호 폴더일 때만 바꾼다.
  for (const folder of ['abc-123 제목', 'summer-2023', 'PART-01', 'CD-02', 'IMG-1234', 'Vlog-2024', 'summer-TRIP-20', 'ABCDEFG-123', 'ABC-123456', 'ZZZ-2024-05-01']) {
    assert.strictEqual(detailedName('video.mp4', [folder]), `${folder}.mp4`, folder);
    assert.strictEqual(detailedName('x.mp4', [folder]), 'x.mp4', folder);
  }
  assert.strictEqual(detailedName('video.mp4', ['ABC-123-1080p']), 'ABC-123-1080p.mp4');
  // 제품번호가 아닌 가까운 폴더가 바깥 폴더의 번호를 밀어내지 않는다.
  for (const near of ['summer-2023', 'trip-20', 'scan-01', 'CD-02', 'IMG-1234']) {
    assert.strictEqual(detailedName('video.mp4', [near, 'ABC-123 제목']), 'ABC-123 제목.mp4', near);
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
    // 파일이 여럿인 폴더의 이름으로 바꾸지는 않고, 정보 없는 이름이라 앞에 붙인다(#71).
    ['DEF-456 묶음/a/x.mp4', 'DEF-456 묶음 x.mp4'],
    ['DEF-456 묶음/b/y.mp4', 'DEF-456 묶음 y.mp4'],
  ]);
});

test('planFlatten은 링크가 함께 있는 폴더의 파일을 유일한 파일로 보지 않는다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['outside/o.txt', 'target/ABC-123 제목/video.mp4']);
  linkDir(path.join(root, 'outside'), path.join(target, 'ABC-123 제목', 'link'));
  // 유일한 파일이 아니라 폴더 이름으로 바꾸지 않고 앞에 붙인다(#71).
  assert.deepStrictEqual(planFlatten(target).moves.map((move) => move.name), ['ABC-123 제목 video.mp4']);
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
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['ABC-123 제목 x.mp4']);
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
  // 하드링크로 만든 이름에는 8.3 짧은 이름이 생기지 않아(빌드 26200에서 확인) 두 이름이 겹치지 않는다(#73).
  const result = flatten(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.moved.map(({ name, numbered }) => [name, numbered]), [
    ['longfilename.txt', false],
    ['LONGFI~1.TXT', false],
  ]);
  const files = contents(dir);
  assert.strictEqual(files['longfilename.txt'], 'a/longfilename.txt');
  assert.strictEqual(files['LONGFI~1.TXT'], 'b/LONGFI~1.TXT');
});

test('flatten은 하드링크를 못 만드는 드라이브에서도 8.3 짧은 이름 겹침을 실행 때 잡아 덮어쓰지 않는다', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  make(dir, ['probe-long-file-name.txt']);
  const hasShortNames = fs.existsSync(path.join(dir, 'PROBE-~1.TXT'));
  fs.rmSync(path.join(dir, 'probe-long-file-name.txt'));
  if (!hasShortNames) return t.skip('이 볼륨은 8.3 이름이 꺼져 있다');
  make(dir, ['a/longfilename.txt', 'b/LONGFI~1.TXT']);
  noHardLinks(t);
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

// 실행 단계의 첫 이동 직전에 끼어든다. 계획은 이미 끝난 뒤다. 파일은 하드링크로 옮기므로(#73) linkSync 앞이다.
function beforeFirstMove(t, action) {
  const link = fs.linkSync;
  let done = false;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (!done) {
      done = true;
      action();
    }
    return link(from, to);
  });
}

// 하드링크를 만들 수 없는 드라이브(FAT32·exFAT 등)처럼 빈 자리표시를 먼저 만드는 방식으로 옮기게 한다.
function noHardLinks(t) {
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('not supported'), { code: 'EPERM' });
  });
}

// 원본이 잠긴 것처럼 원래 이름을 지우지 못하게 한다. 잠긴 파일도 하드링크는 만들어지고, 원래 이름 지우기만 EBUSY로 실패한다(빌드 26200에서 확인).
function lockSource(t, locked) {
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (p) => {
    if (p === locked) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return unlink(p);
  });
}

// 파일을 옮긴 직후(원래 이름을 지운 뒤)에 끼어든다.
function afterMove(t, action) {
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (p) => {
    unlink(p);
    action(p);
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
  noHardLinks(t);
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

test('flatten은 진행 표시가 던져도 옮긴 파일을 실패로 세지 않고 나머지와 빈 폴더 정리를 이어 간다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt', 'c/z.txt']);
  noHardLinks(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from) === 'y.txt') throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  recycled.length = 0;
  let calls = 0;
  const result = flatten(dir, {
    onProgress: () => {
      calls += 1;
      throw new Error('stderr closed');
    },
  });
  assert.deepStrictEqual(result.moved.map((move) => move.name), ['x.txt', 'z.txt']);
  assert.deepStrictEqual(result.failed.map((item) => path.relative(dir, item.from)), [path.join('b', 'y.txt')]);
  assert.match(result.failed[0].reason, /locked/);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a'), path.join(dir, 'c')]);
  assert.deepStrictEqual(result.keptFolders, []);
  assert.strictEqual(calls, 5);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'z.txt'), 'utf8'), 'c/z.txt');
});

test('flatten은 자리표시가 이미 사라졌으면 원래 오류를 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  noHardLinks(t);
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
  noHardLinks(t);
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
  // 자식 프로세스의 휴지통 호출은 가로챌 수 없으므로, 건너뛰는 파일을 두어 폴더가 비지 않게 한다.
  make(root, ['t/a/x.txt', 't/a/keep.', 'wide/sub folder/b/y.txt', 'wide/z/q.txt', 'repo/.git/HEAD', 'repo/a/b.txt']);
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
  const original = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (path.basename(to) === 'v.txt' && !fs.existsSync(path.join(dir, 'v.txt'))) {
      fs.mkdirSync(path.join(dir, 'v.txt'));
      fs.writeFileSync(path.join(dir, 'v.txt', 'inner.txt'), 'inner');
    }
    return original(from, to);
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'v.txt')), ['inner.txt']);
  assert.strictEqual(contents(dir)['v (2).txt'], 'a/v.txt');
});

test('flatten은 한 파일이 실패해도 나머지를 옮기고 만든 이름을 남기지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/locked.txt', 'b/ok.txt']);
  lockSource(t, path.join(dir, 'a', 'locked.txt'));
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
  noHardLinks(t);
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

test('flatten은 비게 된 폴더를 가장 위 폴더 하나로 휴지통에 보낸다', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/x.txt', 'd/y.txt', 'top.txt']);
  recycled.length = 0;
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a'), path.join(dir, 'd')]);
  assert.deepStrictEqual(result.keptFolders, []);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['top.txt', 'x.txt', 'y.txt']);
});

test('flatten은 파일이 남은 폴더와 그 위 폴더를 남기고, 비어 있는 형제만 보낸다', { skip: !isWindows }, () => {
  const dir = tempDir();
  make(dir, ['a/b/keep./x.txt', 'a/c/y.txt', 'a/b/z.txt', 'e/w.txt']);
  const result = flatten(dir);
  // keep. 안의 파일은 건너뛰므로 a, a/b는 남고, a/c와 e는 비어서 보낸다.
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a', 'c'), path.join(dir, 'e')]);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'keep.', 'x.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'a', 'c')));
  assert.ok(!fs.existsSync(path.join(dir, 'e')));
});

test('flatten은 옮긴 파일이 있던 트리의 빈 폴더만 함께 보내고 원래 비어 있던 다른 폴더는 그대로 둔다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'p/keep./f.txt', 'p/m/y.txt']);
  for (const folder of ['a/empty/deep', 'lonely', 'Projects/2026', 'p/other-empty']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a'), path.join(dir, 'p', 'm')]);
  for (const folder of ['lonely', 'Projects/2026', 'p/other-empty']) assert.ok(fs.existsSync(path.join(dir, folder)), folder);
  assert.ok(!fs.existsSync(path.join(dir, 'a')));
});

test('flatten은 옮길 파일이 없으면 빈 폴더를 건드리지 않고, 다시 실행해도 할 일이 없다', () => {
  const dir = tempDir();
  make(dir, ['top.txt']);
  fs.mkdirSync(path.join(dir, 'Inbox'));
  recycled.length = 0;
  const result = flatten(dir);
  assert.deepStrictEqual([result.moved, result.removedFolders, result.keptFolders], [[], [], []]);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'Inbox')));
});

test('flatten은 지우기 직전에 폴더에 파일이 생기면 보내지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt']);
  onRecycle = () => fs.writeFileSync(path.join(dir, 'b', 'new-important.txt'), 'new');
  t.after(() => {
    onRecycle = () => {};
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a')]);
  assert.deepStrictEqual(result.keptFolders.map((item) => item.path), [path.join(dir, 'b')]);
  assert.match(result.keptFolders[0].reason, /파일이 생겨/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b', 'new-important.txt'), 'utf8'), 'new');
});

test('flatten은 지우기 직전에 폴더가 파일로 바뀌면 보내지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt']);
  onRecycle = () => {
    fs.rmSync(path.join(dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'b'), 'important');
  };
  t.after(() => {
    onRecycle = () => {};
  });
  const result = flatten(dir);
  assert.match(result.keptFolders[0].reason, /폴더가 아니게/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b'), 'utf8'), 'important');
});

test('flatten은 지우기 직전에 경로가 안쪽 정션으로 바뀌면 다른 폴더를 지우지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['0first/x.txt', 'a/keep./f.txt', 'a/b/y.txt', 'other/b/keep./z.txt']);
  onRecycle = (folder) => {
    if (path.basename(folder) !== '0first') return;
    fs.rmSync(path.join(dir, 'a'), { recursive: true });
    linkDir(path.join(dir, 'other'), path.join(dir, 'a'));
  };
  t.after(() => {
    onRecycle = () => {};
  });
  recycled.length = 0;
  const result = flatten(dir);
  assert.deepStrictEqual(recycled, [path.join(dir, '0first')]);
  assert.match(result.keptFolders[0].reason, /링크|경로가 바뀌었습니다/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'other', 'b', 'keep.', 'z.txt'), 'utf8'), 'other/b/keep./z.txt');
});

test('flatten은 휴지통 호출이 실패하면 스크립트 없이 짧은 사유를 남기고 CLI는 1로 끝낸다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  onRecycle = () => {
    throw Object.assign(new Error("Command failed: powershell Add-Type secret script"), { status: 1 });
  };
  t.after(() => {
    onRecycle = () => {};
  });
  assert.throws(() => run(['flatten', dir]), (err) => err instanceof FcError && /이동 1개/.test(err.message) && /휴지통으로 보내지 못했습니다/.test(err.message) && !/Add-Type/.test(err.message));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'a/x.txt');
  assert.ok(fs.existsSync(path.join(dir, 'a')));
});

test('flatten은 비대화형 세션의 휴지통 거부 사유를 알린다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  onRecycle = () => {
    throw Object.assign(new Error('Command failed'), { status: 75 });
  };
  t.after(() => {
    onRecycle = () => {};
  });
  const result = flatten(dir);
  assert.match(result.keptFolders[0].reason, /대화형 세션이 아니면/);
  assert.throws(() => run(['rm', path.join(dir, 'x.txt')]), (err) => err instanceof FcError && /대화형 세션이 아니면/.test(err.message));
  assert.ok(fs.existsSync(path.join(dir, 'x.txt')));
});

test('flatten은 이동 뒤 폴더를 읽지 못해도 이동 결과를 유지하고 타겟을 .으로 보여 준다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  const readdir = fs.readdirSync;
  let moved = false;
  afterMove(t, () => {
    moved = true;
  });
  t.mock.method(fs, 'readdirSync', (p, options) => {
    if (moved) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return readdir(p, options);
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.moved.map((move) => move.name), ['x.txt']);
  assert.deepStrictEqual(result.keptFolders.map((item) => item.path), [dir]);
  assert.match(formatFlatten(result), /폴더 남김: \. \(폴더를 읽을 수 없습니다/);
});

test('flatten은 잔여물과 시스템 폴더 안의 빈 폴더를 보내지 않는다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt', '.fctl-old-1-2-0/f.txt', 'q/.fctl-new-1-2-0/g.txt']);
  const inner = ['.fctl-old-1-2-0/sub', 'q/.fctl-new-1-2-0/deep', '$RECYCLE.BIN/S-1-5-21-1', 'r/System Volume Information/tracking'];
  for (const folder of inner) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  recycled.length = 0;
  const preview = flatten(dir, { dryRun: true });
  assert.deepStrictEqual(preview.removedFolders, [path.join(dir, 'a')]);
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a')]);
  assert.deepStrictEqual(recycled, [path.join(dir, 'a')]);
  for (const folder of inner) assert.ok(fs.existsSync(path.join(dir, folder)), folder);
});

test('flatten은 이동에 실패한 파일이 있는 폴더를 남긴다', (t) => {
  const dir = tempDir();
  make(dir, ['a/locked.txt', 'b/ok.txt']);
  lockSource(t, path.join(dir, 'a', 'locked.txt'));
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'b')]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'locked.txt'), 'utf8'), 'a/locked.txt');
});

test('flatten은 링크가 있는 폴더를 남기고 링크가 가리키는 곳을 건드리지 않는다', () => {
  const root = tempDir();
  const target = path.join(root, 'target');
  make(root, ['outside/o.txt', 'target/a/x.txt', 'target/b/y.txt']);
  linkDir(path.join(root, 'outside'), path.join(target, 'a', 'lnk'));
  const result = flatten(target);
  assert.deepStrictEqual(result.removedFolders, [path.join(target, 'b')]);
  assert.ok(fs.lstatSync(path.join(target, 'a', 'lnk')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(root, 'outside', 'o.txt'), 'utf8'), 'outside/o.txt');
});

test('flatten은 잔여물과 시스템 폴더를 비어 있어도 남긴다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  for (const folder of ['.fctl-old-1-2-0', 'q/.fctl-new-1-2-0', '$RECYCLE.BIN', 'r/System Volume Information']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a')]);
  for (const folder of ['.fctl-old-1-2-0', 'q/.fctl-new-1-2-0', '$RECYCLE.BIN', 'r/System Volume Information']) assert.ok(fs.existsSync(path.join(dir, folder)), folder);
});

test('rm은 정션을 거친 현재 폴더도 알아보고 그 상위를 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, ['t/a/b/x.txt']);
  linkDir(path.join(dir, 't', 'a'), path.join(dir, 'j'));
  const cwd = process.cwd();
  process.chdir(path.join(dir, 'j', 'b'));
  try {
    assert.throws(() => run(['rm', path.join(dir, 't', 'a'), '--dry-run']), /현재 폴더/);
    assert.throws(() => run(['rm', path.join(dir, 't', 'a'), '--permanent']), /현재 폴더/);
    // 현재 폴더로 들어온 정션 자체를 지우는 것도 막는다.
    assert.throws(() => run(['rm', path.join(dir, 'j'), '--dry-run']), /현재 폴더/);
  } finally {
    process.chdir(cwd);
  }
  assert.ok(fs.existsSync(path.join(dir, 't', 'a', 'b', 'x.txt')));
});

test('rm은 현재 폴더를 가리키는 링크 자체는 지울 수 있다', () => {
  const dir = tempDir();
  make(dir, ['real/s/x.txt']);
  linkDir(path.join(dir, 'real'), path.join(dir, 'lnk'));
  const cwd = process.cwd();
  process.chdir(path.join(dir, 'real', 's'));
  try {
    assert.match(run(['rm', path.join(dir, 'lnk'), '--dry-run']), /미리보기/);
    assert.throws(() => run(['rm', path.join(dir, 'real'), '--dry-run']), /현재 폴더/);
    run(['rm', path.join(dir, 'lnk'), '--permanent']);
  } finally {
    process.chdir(cwd);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'lnk')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'real', 's', 'x.txt'), 'utf8'), 'real/s/x.txt');
});

test('flatten은 현재 폴더와 그 상위를 지우지 않고 남긴 사유를 알린다', () => {
  const dir = tempDir();
  make(dir, ['a/b/x.txt', 'c/y.txt']);
  const cwd = process.cwd();
  process.chdir(path.join(dir, 'a', 'b'));
  try {
    const result = flatten(dir);
    assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'c')]);
    assert.deepStrictEqual(result.keptFolders.map((item) => item.path), [path.join(dir, 'a')]);
    assert.match(result.keptFolders[0].reason, /현재 폴더/);
  } finally {
    process.chdir(cwd);
  }
});

test('flatten은 이동 중에 생긴 파일이 있는 폴더를 지우지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt']);
  afterMove(t, (from) => {
    if (from === path.join(dir, 'a', 'x.txt')) fs.writeFileSync(path.join(dir, 'a', 'new.txt'), 'new');
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'b')]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'new.txt'), 'utf8'), 'new');
});

test('flatten 미리보기는 지울 폴더를 알려 주되 아무것도 지우지 않고 실제 실행과 일치한다', () => {
  const dir = tempDir();
  make(dir, ['a/b/x.txt', 'c/y.txt', 'd/lock./z.txt']);
  fs.mkdirSync(path.join(dir, 'empty'));
  recycled.length = 0;
  const preview = flatten(dir, { dryRun: true });
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'x.txt')));
  const result = flatten(dir);
  assert.ok(fs.existsSync(path.join(dir, 'empty')));
  assert.deepStrictEqual(preview.removedFolders, [path.join(dir, 'a'), path.join(dir, 'c')]);
  assert.deepStrictEqual(result.removedFolders, preview.removedFolders);
  assert.ok(fs.existsSync(path.join(dir, 'd', 'lock.', 'z.txt')));
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
    removedFolders: [path.join(dir, 'e')],
    keptFolders: [{ path: path.join(dir, 'k'), reason: 'cwd' }],
  });
  assert.deepStrictEqual(text.split('\n'), [
    `이동: ${path.join('a', 'x.mp4')} -> ABC-1 (2).mp4 (폴더명 사용, 번호 붙임)`,
    '건너뜀: l (링크)',
    '실패: b (locked)',
    '빈 폴더를 휴지통으로: e',
    '폴더 남김: k (cwd)',
    '이동 1개, 그대로 1개, 건너뜀 1개, 실패 1개, 빈 폴더 제거 1개',
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
  lockSource(t, path.join(dir, 'a', 'locked.txt'));
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
  assert.deepStrictEqual(planFlatten(dir), { target: dir, moves: [], stay: [], skipped: [], guarded: new Set() });
});

// #73: 파일은 빈 자리표시 없이 하드링크를 만든 뒤 원래 이름을 지워 옮긴다.
test('moveWithoutOverwrite는 파일을 빈 자리표시 없이 옮기고 이미 있는 이름은 건드리지 않는다 (#73)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'a/y.txt', 'taken.txt', 'folder/inner.txt']);
  const open = t.mock.method(fs, 'openSync');
  assert.strictEqual(moveWithoutOverwrite(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt')), true);
  assert.strictEqual(open.mock.calls.filter((call) => call.arguments[1] === 'wx').length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'a', 'x.txt')));
  assert.strictEqual(fs.statSync(path.join(dir, 'x.txt')).nlink, 1);
  for (const taken of ['taken.txt', 'folder', 'TAKEN.TXT']) {
    if (taken === 'TAKEN.TXT' && !isWindows) continue;
    assert.strictEqual(moveWithoutOverwrite(path.join(dir, 'a', 'y.txt'), path.join(dir, taken)), false, taken);
  }
  assert.deepStrictEqual(contents(dir), { 'a/y.txt': 'a/y.txt', 'folder/inner.txt': 'folder/inner.txt', 'taken.txt': 'taken.txt', 'x.txt': 'a/x.txt' });
});

test('moveWithoutOverwrite는 원래 이름을 지우지 못하면 만든 이름을 지워 되돌린다 (#73)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  lockSource(t, path.join(dir, 'a', 'x.txt'));
  assert.throws(() => moveWithoutOverwrite(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt')), { code: 'EBUSY' });
  assert.deepStrictEqual(contents(dir), { 'a/x.txt': 'a/x.txt' });
  assert.strictEqual(fs.statSync(path.join(dir, 'a', 'x.txt')).nlink, 1);
});

test('moveWithoutOverwrite는 되돌릴 때 새 이름이 다른 파일로 바뀌었으면 지우지 않는다 (#73)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  const from = path.join(dir, 'a', 'x.txt');
  const to = path.join(dir, 'x.txt');
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (p) => {
    if (p === from) {
      unlink(to);
      fs.writeFileSync(to, 'someone else');
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    }
    return unlink(p);
  });
  assert.throws(() => moveWithoutOverwrite(from, to), (err) => err instanceof FcError && /다른 파일로 바뀌어 지우지 않았습니다/.test(err.message));
  assert.deepStrictEqual(contents(dir), { 'a/x.txt': 'a/x.txt', 'x.txt': 'someone else' });
});

test('moveWithoutOverwrite는 새 이름도 지우지 못하면 두 이름으로 남았다고 알린다 (#73)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  const unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', () => {
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  assert.throws(
    () => moveWithoutOverwrite(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt')),
    (err) => err instanceof FcError && /두 이름으로 남았습니다/.test(err.message) && /EBUSY, EBUSY/.test(err.message),
  );
  mock.mock.restore();
  assert.deepStrictEqual(contents(dir), { 'a/x.txt': 'a/x.txt', 'x.txt': 'a/x.txt' });
  unlink(path.join(dir, 'x.txt'));
});

test('moveWithoutOverwrite는 하드링크를 못 만들면 빈 자리표시 방식으로 옮긴다 (#73)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  noHardLinks(t);
  const rename = t.mock.method(fs, 'renameSync');
  assert.strictEqual(moveWithoutOverwrite(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt')), true);
  assert.strictEqual(rename.mock.callCount(), 1);
  assert.deepStrictEqual(contents(dir), { 'x.txt': 'a/x.txt' });
});

test('leftoverNote는 같은 파일의 다른 이름과 빈 파일을 이전 실행의 흔적으로 알린다 (#73)', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'a/y.txt', 'other.txt']);
  fs.linkSync(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt'));
  fs.writeFileSync(path.join(dir, 'y.txt'), '');
  assert.match(leftoverNote(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt')), /같은 파일의 다른 이름/);
  assert.match(leftoverNote(path.join(dir, 'a', 'y.txt'), path.join(dir, 'y.txt')), /빈 파일/);
  assert.strictEqual(leftoverNote(path.join(dir, 'a', 'y.txt'), path.join(dir, 'other.txt')), '');
  assert.strictEqual(leftoverNote(path.join(dir, 'a', 'y.txt'), path.join(dir, 'missing.txt')), '');
});

test('flatten은 이전 실행이 남긴 같은 파일의 다른 이름이 있으면 번호를 붙여 세 번째 이름을 만들지 않는다 (1차 리뷰, #73)', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt', 'c/z.txt', 'd/w.txt', 'w.txt']);
  fs.linkSync(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt'));
  // 이전 실행 때 이미 w.txt가 있어 번호를 붙인 이름으로 하드링크한 뒤 멈춘 흔적(2차 리뷰)
  fs.linkSync(path.join(dir, 'd', 'w.txt'), path.join(dir, 'w (2).txt'));
  // 빈 파일은 정상적인 빈 파일일 수 있어 지금처럼 번호를 붙여 피한다.
  fs.writeFileSync(path.join(dir, 'y.txt'), '');
  for (const dryRun of [true, false]) {
    const result = flatten(dir, { dryRun });
    const reason = (p) => result.skipped.find((item) => item.path === p)?.reason ?? '';
    assert.match(reason(path.join(dir, 'a', 'x.txt')), /이미 있는 이름이라 옮기지 않습니다: x\.txt \(원본과 같은 파일의 다른 이름/, `dryRun=${dryRun}`);
    assert.match(reason(path.join(dir, 'd', 'w.txt')), /이미 있는 이름이라 옮기지 않습니다: w \(2\)\.txt \(원본과 같은 파일의 다른 이름/, `dryRun=${dryRun}`);
    assert.deepStrictEqual(result.moved.map((move) => move.name).sort(), ['y (2).txt', 'z.txt'], `dryRun=${dryRun}`);
  }
  assert.strictEqual(fs.statSync(path.join(dir, 'x.txt')).nlink, 2);
  assert.strictEqual(fs.statSync(path.join(dir, 'w (2).txt')).nlink, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'x (2).txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'w (3).txt')));
});

test('moveWithoutOverwrite는 linkSync가 실패를 알렸어도 링크가 만들어졌으면 이어서 옮긴다 (1차 리뷰, #73)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    link(from, to);
    throw Object.assign(new Error('lost reply'), { code: 'EIO' });
  });
  assert.strictEqual(moveWithoutOverwrite(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt')), true);
  assert.deepStrictEqual(contents(dir), { 'x.txt': 'a/x.txt' });
  assert.strictEqual(fs.statSync(path.join(dir, 'x.txt')).nlink, 1);
});

test('leftoverNote는 파일 번호를 0으로 알리는 파일 시스템에서 다른 파일을 같은 파일로 보지 않는다 (1차 리뷰, #73)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'x.txt']);
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p, options) => {
    const stat = lstat(p, options);
    if (stat && options?.bigint) stat.ino = 0n;
    return stat;
  });
  assert.strictEqual(leftoverNote(path.join(dir, 'a', 'x.txt'), path.join(dir, 'x.txt')), '');
});

test('flatten은 읽을 수 없는 하위 폴더가 하나라도 있으면 아무것도 옮기지 않고 실패한다 (#74)', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'locked/y.txt']);
  const readdirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, ...rest) => {
    if (p === path.join(dir, 'locked')) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return readdirSync(p, ...rest);
  });
  for (const dryRun of [true, false]) {
    assert.throws(() => flatten(dir, { dryRun }), /폴더를 읽을 수 없습니다: .*locked \(EPERM\)/, `dryRun=${dryRun}`);
  }
  t.mock.restoreAll();
  assert.deepStrictEqual(contents(dir), { 'a/x.txt': 'a/x.txt', 'locked/y.txt': 'locked/y.txt' });
});

// #65: 폴더 설정·미리보기 파일, 프로그램·프로젝트 폴더, 숨김·시스템 속성 항목
test('flatten은 desktop.ini·Thumbs.db를 옮기지 않고 파일 수에서 빼며, 그것만 남은 폴더는 함께 휴지통으로 보낸다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/abc_123.mp4', 'ABC-123 제목/desktop.ini', 'docs/Thumbs.db', 'docs/memo.txt', 'pics/.DS_Store', 'pics/sub/ehthumbs.db']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['ABC-123 제목/abc_123.mp4', 'ABC-123 제목.mp4'], ['docs/memo.txt', 'memo.txt']]);
  assert.deepStrictEqual(plan.skipped.map((item) => path.relative(dir, item.path)).sort(), [path.join('ABC-123 제목', 'desktop.ini'), path.join('docs', 'Thumbs.db'), path.join('pics', '.DS_Store'), path.join('pics', 'sub', 'ehthumbs.db')].sort());
  assert.ok(plan.skipped.every((item) => /폴더 설정·미리보기 파일/.test(item.reason)));
  recycled.length = 0;
  const preview = flatten(dir, { dryRun: true });
  assert.deepStrictEqual(preview.removedFolders, [path.join(dir, 'ABC-123 제목'), path.join(dir, 'docs')]);
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'ABC-123 제목'), path.join(dir, 'docs')]);
  assert.deepStrictEqual(recycled, [path.join(dir, 'ABC-123 제목'), path.join(dir, 'docs')]);
  // 옮긴 파일이 없던 폴더는 설정 파일만 있어도 건드리지 않는다.
  assert.deepStrictEqual(contents(dir), { 'ABC-123 제목.mp4': 'ABC-123 제목/abc_123.mp4', 'memo.txt': 'docs/memo.txt', 'pics/.DS_Store': 'pics/.DS_Store', 'pics/sub/ehthumbs.db': 'pics/sub/ehthumbs.db' });
});

test('flatten은 node_modules 같은 프로그램 폴더를 통째로 남기고 폴더 하나로 알린다', () => {
  const dir = tempDir();
  make(dir, ['p/node_modules/x/index.js', 'p/node_modules/y/index.js', 'p/node_modules/y/lib/a.js', 'q/__pycache__/m.pyc', 'other/v.mp4']);
  fs.mkdirSync(path.join(dir, 'p', 'node_modules', 'empty'));
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['other/v.mp4', 'v.mp4']]);
  assert.deepStrictEqual(plan.skipped, [
    { path: path.join(dir, 'p', 'node_modules'), reason: '프로그램 폴더(node_modules)라 안의 항목 3개를 옮기지 않고 폴더째 남깁니다.' },
    { path: path.join(dir, 'q', '__pycache__'), reason: '프로그램 폴더(__pycache__)라 안의 항목 1개를 옮기지 않고 폴더째 남깁니다.' },
  ]);
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'other')]);
  assert.ok(fs.existsSync(path.join(dir, 'p', 'node_modules', 'empty')));
  assert.ok(formatFlatten(result).includes(`건너뜀: ${path.join('p', 'node_modules')} (프로그램 폴더(node_modules)라 안의 항목 3개를`));
});

test('flatten은 프로젝트 표시 파일이 있는 하위 폴더를 통째로 남긴다', () => {
  const dir = tempDir();
  make(dir, ['lib-1.0/package.json', 'lib-1.0/src/a.js', 'tool/pyvenv.cfg', 'tool/Scripts/python.exe', 'cs/App.sln', 'cs/App/Program.cs', 'cs2/sub/App.CSPROJ', 'cs2/sub/x.cs', 'cs2/readme.txt', 'packages/package.json.bak']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['cs2/readme.txt', 'readme.txt'], ['packages/package.json.bak', 'package.json.bak']]);
  assert.deepStrictEqual(plan.skipped.map((item) => [path.relative(dir, item.path), item.reason]), [
    ['cs', '프로젝트 폴더(App.sln 있음)라 안의 항목 2개를 옮기지 않고 폴더째 남깁니다.'],
    [path.join('cs2', 'sub'), '프로젝트 폴더(App.CSPROJ 있음)라 안의 항목 2개를 옮기지 않고 폴더째 남깁니다.'],
    ['lib-1.0', '프로젝트 폴더(package.json 있음)라 안의 항목 2개를 옮기지 않고 폴더째 남깁니다.'],
    ['tool', '프로젝트 폴더(pyvenv.cfg 있음)라 안의 항목 2개를 옮기지 않고 폴더째 남깁니다.'],
  ]);
});

test('flatten은 실행 파일과 DLL이 함께 든 폴더를 프로그램 폴더로 남기고, 실행 파일만 있으면 옮긴다', () => {
  const dir = tempDir();
  make(dir, ['app/App.EXE', 'app/core.dll', 'app/res/icon.png', 'setup/setup.exe', 'libs/only.dll']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['libs/only.dll', 'only.dll'], ['setup/setup.exe', 'setup.exe']]);
  assert.deepStrictEqual(plan.skipped, [{ path: path.join(dir, 'app'), reason: '실행 파일과 DLL이 함께 든 프로그램 폴더라 안의 항목 3개를 옮기지 않고 폴더째 남깁니다.' }]);
});

test('flatten은 타겟이 프로젝트·프로그램 폴더이거나 프로그램 폴더 안이면 아무것도 옮기지 않고 거부한다', () => {
  const project = tempDir();
  make(project, ['package.json', 'src/a.js']);
  assert.throws(() => flatten(project), /타겟이 프로젝트 폴더로 보여\(package\.json 있음\) 다루지 않습니다/);
  const program = tempDir();
  make(program, ['app.exe', 'core.dll', 'res/icon.png']);
  assert.throws(() => flatten(program, { dryRun: true }), /타겟에 실행 파일과 DLL이 함께 있어/);
  const inside = tempDir();
  make(inside, ['node_modules/pkg/lib/a.js']);
  assert.throws(() => flatten(path.join(inside, 'node_modules', 'pkg')), /프로그램 폴더 안이라 다루지 않습니다: .*node_modules$/);
  assert.throws(() => flatten(path.join(inside, 'node_modules')), /프로그램 폴더 안이라/);
  assert.deepStrictEqual(contents(project), { 'package.json': 'package.json', 'src/a.js': 'src/a.js' });
  assert.deepStrictEqual(contents(program), { 'app.exe': 'app.exe', 'core.dll': 'core.dll', 'res/icon.png': 'res/icon.png' });
  assert.deepStrictEqual(contents(inside), { 'node_modules/pkg/lib/a.js': 'node_modules/pkg/lib/a.js' });
});

// 사용자 폴더를 home으로 바꿔 fn을 실행한다.
function withHome(home, fn) {
  fakeHome = home;
  try {
    return fn();
  } finally {
    fakeHome = null;
  }
}

test('planFlatten은 원래 이름을 쓰는 파일에 먼저 이름을 배정하고, 옮기는 순서는 항목 순서를 유지한다 (#63)', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/x.mp4', 'z/ABC-123 제목.mp4', 'z/other.mp4']);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['ABC-123 제목/x.mp4', 'ABC-123 제목 (2).mp4'], ['z/ABC-123 제목.mp4', 'ABC-123 제목.mp4'], ['z/other.mp4', 'other.mp4']]);
  assert.deepStrictEqual(plan.moves.map((move) => [move.fromFolder, move.numbered]), [[true, true], [false, false], [false, false]]);
  const result = flatten(dir);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(contents(dir), { 'ABC-123 제목 (2).mp4': 'ABC-123 제목/x.mp4', 'ABC-123 제목.mp4': 'z/ABC-123 제목.mp4', 'other.mp4': 'z/other.mp4' });
});

test('planFlatten은 이름 배정에 실패한 파일도 건너뜀 목록의 원래 자리에 둔다 (#63)', () => {
  const dir = tempDir();
  const long = `${'긴'.repeat(251)}.txt`;
  make(dir, ['a/a.txt', `b/${long}`, 'c/c.txt']);
  fs.writeFileSync(path.join(dir, long), 'top');
  fs.mkdirSync(path.join(dir, 'd'));
  fs.writeFileSync(path.join(dir, 'd', 'Thumbs.db'), '');
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['a/a.txt', 'a.txt'], ['c/c.txt', 'c.txt']]);
  assert.deepStrictEqual(plan.skipped.map((item) => [path.relative(dir, item.path), item.reason]), [
    [path.join('b', long), `번호를 붙이면 이름이 너무 깁니다: ${'긴'.repeat(251)} (2).txt`],
    [path.join('d', 'Thumbs.db'), '폴더 설정·미리보기 파일이라 옮기지 않습니다. 폴더가 비면 폴더와 함께 휴지통으로 갑니다.'],
  ]);
});

test('planFlatten은 같은 접두어를 받는 자막 짝을 원래 이름 파일보다 먼저 배정해 짝을 유지한다 (#63 1차 리뷰)', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/video.mp4', 'ABC-123/video.en.srt', 'z/ABC-123 video.mp4']);
  assert.deepStrictEqual(moves(planFlatten(dir)), [['ABC-123/video.en.srt', 'ABC-123 video.en.srt'], ['ABC-123/video.mp4', 'ABC-123 video.mp4'], ['z/ABC-123 video.mp4', 'ABC-123 video (2).mp4']]);
  const subs = tempDir();
  make(subs, ['ABC-123/video.mp4', 'ABC-123/video.en.srt', 'z/ABC-123 video.en.srt']);
  assert.deepStrictEqual(moves(planFlatten(subs)), [['ABC-123/video.en.srt', 'ABC-123 video.en.srt'], ['ABC-123/video.mp4', 'ABC-123 video.mp4'], ['z/ABC-123 video.en.srt', 'ABC-123 video.en (2).srt']]);
});

test('planFlatten은 점이 든 접두어 폴더를 짝으로 잘못 묶지 않고, 하위 폴더에 나뉜 자막 짝은 묶는다 (#63 2차 리뷰)', () => {
  const dotted = tempDir();
  make(dotted, ['ABC-123 v1.5/video.mp4', 'ABC-123 v1.5/sample.mp4', 'z/ABC-123 v1.5 sample.mp4']);
  assert.deepStrictEqual(moves(planFlatten(dotted)), [['ABC-123 v1.5/sample.mp4', 'ABC-123 v1.5 sample (2).mp4'], ['ABC-123 v1.5/video.mp4', 'ABC-123 v1.5 video.mp4'], ['z/ABC-123 v1.5 sample.mp4', 'ABC-123 v1.5 sample.mp4']]);
  const split = tempDir();
  make(split, ['ABC-123/video.mp4', 'ABC-123/Subs/video.en.srt', 'z/ABC-123 video.mp4']);
  assert.deepStrictEqual(moves(planFlatten(split)), [['ABC-123/Subs/video.en.srt', 'ABC-123 video.en.srt'], ['ABC-123/video.mp4', 'ABC-123 video.mp4'], ['z/ABC-123 video.mp4', 'ABC-123 video (2).mp4']]);
});

test('planFlatten은 폴더명에 번호를 붙여 한도를 넘으면 원래 이름으로 돌아가고, 그 이름이 이미 배정됐으면 번호를 붙인다 (#63 1차 리뷰)', () => {
  const dir = tempDir();
  const folder = `ABC-123 ${'T'.repeat(243)}`;
  make(dir, [`${folder}/abc_123.mp4`, 'z/abc_123.mp4', 'z/other.mp4']);
  fs.writeFileSync(path.join(dir, `${folder}.mp4`), 'top');
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [[`${folder}/abc_123.mp4`, 'abc_123 (2).mp4'], ['z/abc_123.mp4', 'abc_123.mp4'], ['z/other.mp4', 'other.mp4']]);
  assert.deepStrictEqual(plan.moves.map((move) => [move.desired, move.fromFolder, move.numbered]), [['abc_123.mp4', false, true], ['abc_123.mp4', false, false], ['other.mp4', false, false]]);
});

test('planFlatten은 자기 바깥 폴더와 같은 이름에는 번호를 붙인다(풀지 않음, #63)', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목.mp4/x.mp4']);
  assert.deepStrictEqual(moves(planFlatten(dir)), [['ABC-123 제목.mp4/x.mp4', 'ABC-123 제목 (2).mp4']]);
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'ABC-123 제목.mp4')]);
  assert.deepStrictEqual(contents(dir), { 'ABC-123 제목 (2).mp4': 'ABC-123 제목.mp4/x.mp4' });
});

test('flatten은 타겟의 위 폴더가 프로젝트·프로그램 폴더면 아무것도 옮기지 않고 거부한다 (#148)', () => {
  const project = tempDir();
  make(project, ['myproj/package.json', 'myproj/src/lib/a.js', 'myproj/src/b.js']);
  assert.throws(() => flatten(path.join(project, 'myproj', 'src')), /위 폴더가 프로젝트 폴더로 보여\(package\.json 있음\) 다루지 않습니다: .*myproj$/);
  // 몇 단계 위든 막는다.
  assert.throws(() => flatten(path.join(project, 'myproj', 'src', 'lib'), { dryRun: true }), /위 폴더가 프로젝트 폴더로 보여/);
  assert.deepStrictEqual(contents(project), { 'myproj/package.json': 'myproj/package.json', 'myproj/src/b.js': 'myproj/src/b.js', 'myproj/src/lib/a.js': 'myproj/src/lib/a.js' });
  const program = tempDir();
  make(program, ['app/App.exe', 'app/core.DLL', 'app/data/maps/m1.bin', 'app/data/m2.bin']);
  assert.throws(() => flatten(path.join(program, 'app', 'data')), /위 폴더에 실행 파일과 DLL이 함께 있어 프로그램 폴더로 보고 다루지 않습니다: .*app$/);
  assert.deepStrictEqual(Object.keys(contents(program)).sort(), ['app/App.exe', 'app/core.DLL', 'app/data/m2.bin', 'app/data/maps/m1.bin']);
});

test('flatten은 표시 파일이 우연히 놓이는 사용자 폴더·다운로드·OneDrive 바탕화면과 옆 폴더의 표시 파일로는 막지 않는다 (#148)', () => {
  const home = tempDir();
  make(home, [
    'package.json',
    'Downloads/package.json', 'Downloads/setup.exe', 'Downloads/helper.dll', 'Downloads/videos/a/x.mp4',
    'OneDrive/Desktop/Gemfile', 'OneDrive/Desktop/pics/b/y.jpg',
    'OneDrive - 회사/문서/go.mod', 'OneDrive - 회사/문서/work/c/z.txt',
    'Downloads/proj/package.json', 'Downloads/proj/src/d/w.js',
    'data/lib/package.json', 'data/other/e/v.mp4',
    'myproj/package.json', 'myproj/src/f/u.js',
    'OneDrive/app/package.json', 'OneDrive/app/src/g/t.js',
  ]);
  withHome(home, () => {
    assert.deepStrictEqual(moves(planFlatten(path.join(home, 'Downloads', 'videos'))), [['a/x.mp4', 'x.mp4']]);
    assert.deepStrictEqual(moves(planFlatten(path.join(home, 'OneDrive', 'Desktop', 'pics'))), [['b/y.jpg', 'y.jpg']]);
    assert.deepStrictEqual(moves(planFlatten(path.join(home, 'OneDrive - 회사', '문서', 'work'))), [['c/z.txt', 'z.txt']]);
    // 옆 폴더(data/lib)의 표시 파일은 위 폴더가 아니다.
    assert.deepStrictEqual(moves(planFlatten(path.join(home, 'data', 'other'))), [['e/v.mp4', 'v.mp4']]);
    // 다운로드 아래의 프로젝트 폴더부터는 막는다.
    assert.throws(() => planFlatten(path.join(home, 'Downloads', 'proj', 'src')), /위 폴더가 프로젝트 폴더로 보여\(package\.json 있음\)/);
    // 사용자 폴더나 OneDrive 바로 아래라도 기본 폴더가 아닌 곳(직접 만든 프로젝트)은 본다(1차 리뷰).
    assert.throws(() => planFlatten(path.join(home, 'myproj', 'src')), /위 폴더가 프로젝트 폴더로 보여\(package\.json 있음\) 다루지 않습니다: .*myproj$/);
    assert.throws(() => planFlatten(path.join(home, 'OneDrive', 'app', 'src')), /위 폴더가 프로젝트 폴더로 보여\(package\.json 있음\) 다루지 않습니다: .*app$/);
  });
});

test('flatten은 숨김·시스템 속성 파일을 옮기지 않고, 그런 폴더는 빈 폴더라도 통째로 남긴다', { skip: !isWindows && 'Windows 파일 속성' }, () => {
  const dir = tempDir();
  make(dir, ['a/secret.txt', 'a/plain.txt', 'b/.cache/c.bin', 'b/s.sys', 'b/v.mp4', '숨김😀/x.txt', 'c/f.txt']);
  fs.mkdirSync(path.join(dir, 'c', '.empty'));
  for (const [flag, name] of [['+h', 'a/secret.txt'], ['+h', 'b/.cache'], ['+s', 'b/s.sys'], ['+h', '숨김😀'], ['+h', 'c/.empty']]) {
    execFileSync('attrib', [flag, path.join(dir, name)]);
  }
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['a/plain.txt', 'plain.txt'], ['b/v.mp4', 'v.mp4'], ['c/f.txt', 'f.txt']]);
  assert.deepStrictEqual(plan.skipped.map((item) => [path.relative(dir, item.path), item.reason]), [
    [path.join('a', 'secret.txt'), '숨김·시스템 속성 파일이라 옮기지 않습니다.'],
    [path.join('b', '.cache'), '숨김 속성 폴더라 안의 항목 1개를 옮기지 않고 폴더째 남깁니다.'],
    [path.join('b', 's.sys'), '숨김·시스템 속성 파일이라 옮기지 않습니다.'],
    ['숨김😀', '숨김 속성 폴더라 안의 항목 1개를 옮기지 않고 폴더째 남깁니다.'],
    [path.join('c', '.empty'), '숨김 속성 폴더라 폴더째 남깁니다.'],
  ]);
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, []);
  assert.ok(fs.existsSync(path.join(dir, 'c', '.empty')));
  assert.ok(fs.existsSync(path.join(dir, 'a', 'secret.txt')));
});

test('flatten은 경로가 260자를 넘는 숨김 파일도 알아본다', { skip: !isWindows && 'Windows 파일 속성' }, () => {
  const dir = tempDir();
  const deep = path.join('a', 'x'.repeat(120), 'y'.repeat(120));
  make(dir, [path.join(deep, 'long.txt'), path.join(deep, 'plain.txt')]);
  // attrib는 긴 경로의 속성을 바꾸지 못하고 성공으로 끝나므로 PowerShell로 바꾼다.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:FC_FILE -Force).Attributes = "Hidden"'], {
    env: { ...process.env, FC_FILE: `\\\\?\\${path.join(dir, deep, 'long.txt')}` },
  });
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name), ['plain.txt']);
  assert.deepStrictEqual(plan.skipped.map((item) => path.relative(dir, item.path)), [path.join(deep, 'long.txt')]);
});

test('flatten은 시스템 속성만 있는 폴더(아이콘을 꾸민 폴더)를 일반 폴더로 다룬다', { skip: !isWindows && 'Windows 파일 속성' }, () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/abc_123.mp4', 'ABC-123 제목/desktop.ini']);
  execFileSync('attrib', ['+s', path.join(dir, 'ABC-123 제목')]);
  execFileSync('attrib', ['+h', '+s', path.join(dir, 'ABC-123 제목', 'desktop.ini')]);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(moves(plan), [['ABC-123 제목/abc_123.mp4', 'ABC-123 제목.mp4']]);
  assert.deepStrictEqual(plan.skipped.map((item) => path.relative(dir, item.path)), [path.join('ABC-123 제목', 'desktop.ini')]);
  assert.match(plan.skipped[0].reason, /폴더 설정·미리보기 파일/);
});

// 1차 리뷰: OneDrive 폴더는 ReparsePoint 속성이 있어도 walk가 폴더로 본다. 속성 읽기가 따로 재귀하지 않고 walk가 본 폴더를 모두 받는지 확인한다.
test('flatten은 walk가 폴더로 본 곳을 모두 속성 읽기에 넘기고, 프로그램 폴더 안은 넘기지 않는다', { skip: !isWindows && 'Windows 파일 속성' }, (t) => {
  const dir = tempDir();
  make(dir, ['a/b/c/x.txt', 'd/y.txt', 'p/node_modules/m/i.js']);
  let asked;
  onAttributes = (options) => {
    asked = options.input.trim().split('\n').map((line) => Buffer.from(line, 'base64').toString('utf16le'));
    return '2 ' + Buffer.from(path.join('a', 'b', 'c', 'x.txt'), 'utf16le').toString('base64') + '\r\n';
  };
  t.after(() => {
    onAttributes = null;
  });
  const plan = planFlatten(dir);
  assert.deepStrictEqual(asked, ['.', 'a', path.join('a', 'b'), path.join('a', 'b', 'c'), 'd', 'p']);
  assert.deepStrictEqual(moves(plan), [['d/y.txt', 'y.txt']]);
  assert.match(plan.skipped.find((item) => item.path.endsWith('x.txt')).reason, /숨김·시스템 속성 파일/);
});

test('flatten은 숨김·시스템 속성을 읽지 못하면 아무것도 옮기지 않고 오류를 낸다', { skip: !isWindows && 'Windows 파일 속성' }, (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt']);
  onAttributes = () => {
    throw Object.assign(new Error('실패'), { status: 3 });
  };
  t.after(() => {
    onAttributes = null;
  });
  for (const dryRun of [true, false]) assert.throws(() => flatten(dir, { dryRun }), /숨김·시스템 속성을 확인할 수 없습니다: .* \(3\)/);
  assert.deepStrictEqual(contents(dir), { 'a/x.txt': 'a/x.txt', 'b/y.txt': 'b/y.txt' });
});

test('flatten은 파일이 없는 프로그램 폴더도 남긴다고 알린다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  fs.mkdirSync(path.join(dir, 'a', 'node_modules', 'empty'), { recursive: true });
  const result = flatten(dir);
  assert.deepStrictEqual(result.skipped, [{ path: path.join(dir, 'a', 'node_modules'), reason: '프로그램 폴더(node_modules)라 폴더째 남깁니다.' }]);
  assert.deepStrictEqual(result.removedFolders, []);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'node_modules', 'empty')));
});

// 2차 리뷰: 드라이브 루트(Q:\)처럼 끝에 구분자가 붙은 경로도 상대경로가 잘리지 않는다.
test('hiddenOrSystemEntries는 끝에 구분자가 붙은 경로에서도 같은 상대경로를 돌려준다', { skip: !isWindows && 'Windows 파일 속성' }, () => {
  const dir = tempDir();
  make(dir, ['sub/a.txt']);
  execFileSync('attrib', ['+h', path.join(dir, 'sub', 'a.txt')]);
  const expected = new Map([[path.join('sub', 'a.txt'), 2]]);
  assert.deepStrictEqual(hiddenOrSystemEntries(dir, ['', 'sub']), expected);
  assert.deepStrictEqual(hiddenOrSystemEntries(dir + path.sep, ['', 'sub']), expected);
});

// #71: 정보 없는 파일명(video.mp4)은 폴더 이름을 잃지 않는다.
test('detailedName은 정보 없는 파일명에 제품번호로 인정되지 않는 폴더 이름도 쓴다', () => {
  for (const folder of ['PART-01', 'BD-123', 'Studio-ABC-123', 'ABC-123-01', '1080p-ABC-123', '4K-ABC-123', '여름영상모음', '2021']) {
    assert.strictEqual(detailedName('video.mp4', [folder]), `${folder}.mp4`, folder);
  }
  assert.strictEqual(detailedName('영상.mp4', ['여름영상모음']), '여름영상모음.mp4');
  // 흔한 폴더 이름, 새 폴더, 화질·코덱만 있는 이름은 정보가 없어 쓰지 않는다.
  for (const folder of ['새 폴더', '새 폴더 (2)', 'New folder (3)', 'Videos', 'Downloads', 'H264', '1080p', 'BD1080', 'WEB-DL', '4K HDR', 'Movie']) {
    assert.strictEqual(detailedName('video.mp4', [folder]), 'video.mp4', folder);
  }
  // 정보가 있는 파일명과 한 글자 이름은 그대로다.
  assert.strictEqual(detailedName('trailer.mp4', ['PART-01']), 'trailer.mp4');
  assert.strictEqual(detailedName('o.txt', ['out']), 'o.txt');
});

test('prefixedName은 유일한 파일이 아닌 정보 없는 파일명 앞에 가까운 폴더 이름을 붙인다', () => {
  assert.strictEqual(prefixedName('video.mp4', 'ABC-123'), 'ABC-123 video.mp4');
  assert.strictEqual(prefixedName('sample.mp4', 'ABC-123'), 'ABC-123 sample.mp4');
  assert.strictEqual(prefixedName('a.mp4', 'ABC-123'), 'ABC-123 a.mp4');
  assert.strictEqual(prefixedName('video.srt', 'PART-01'), 'PART-01 video.srt');
  assert.strictEqual(prefixedName('video.mp4', 'ABC-123.mp4'), 'ABC-123 video.mp4');
  for (const [file, folder] of [
    ['a.mp4', 'PART-01'],
    ['trailer.mp4', 'ABC-123'],
    ['video.mp4', '새 폴더 (2)'],
    ['video.mp4', 'H264'],
    ['video.mp4', '.hidden'],
    ['video.mp4', 'ABC-123.mkv'],
    ['video', 'ABC-123'],
    ['x.tar.gz', 'ABC-123'],
    ['video.mp4', undefined],
  ]) {
    assert.strictEqual(prefixedName(file, folder), file, `${file} + ${folder}`);
  }
});

test('flatten은 정보 없는 파일명의 폴더 이름을 결과 이름에 남긴다', () => {
  const dir = tempDir();
  make(dir, ['PART-01/video.mp4', 'BD-123/video.mp4', 'ABC-123/video.mp4', 'ABC-123/sample.mp4', 'Show/video.mp4', 'Show/video.srt', '새 폴더 (2)/video.mp4']);
  const result = flatten(dir);
  assert.deepStrictEqual(contents(dir), {
    'ABC-123 sample.mp4': 'ABC-123/sample.mp4',
    'ABC-123 video.mp4': 'ABC-123/video.mp4',
    'BD-123.mp4': 'BD-123/video.mp4',
    'PART-01.mp4': 'PART-01/video.mp4',
    'Show video.mp4': 'Show/video.mp4',
    'Show video.srt': 'Show/video.srt',
    'video.mp4': '새 폴더 (2)/video.mp4',
  });
  assert.ok(result.moved.filter((move) => move.fromFolder).length === 6);
  assert.ok(formatFlatten(result).includes(`이동: ${path.join('PART-01', 'video.mp4')} -> PART-01.mp4 (폴더명 사용)`));
});

// #71 1차 리뷰: 자막 짝, 바깥 폴더로 올라가기, 번호·복사본·전각·한 글자 폴더 이름, 긴 이름
test('prefixedName은 video.en.srt 같은 자막에도 같은 접두어를 붙이고, 정보 없는 가까운 폴더를 건너 위로 올라간다', () => {
  assert.strictEqual(prefixedName('video.en.srt', ['ABC-123']), 'ABC-123 video.en.srt');
  assert.strictEqual(prefixedName('video.ko.srt', ['PART-01']), 'PART-01 video.ko.srt');
  assert.strictEqual(prefixedName('video.mp4', ['1080p', 'Show']), 'Show 1080p video.mp4');
  assert.strictEqual(prefixedName('video.mp4', ['x', '새 폴더', 'ABC-123']), 'ABC-123 video.mp4');
  assert.strictEqual(prefixedName('video.mp4', ['1080p', 'Videos']), 'video.mp4');
  assert.strictEqual(prefixedName('trailer.en.srt', ['ABC-123']), 'trailer.en.srt');
});

test('detailedName은 번호·복사본이 붙은 흔한 폴더, 전각 흔한 이름, 한 글자 폴더를 정보 없는 폴더로 본다', () => {
  for (const folder of ['Downloads (2)', 'Videos (2)', '새 폴더 (2) - 복사본', 'New folder - Copy', 'Ｖｉｄｅｏ', 'a']) {
    assert.strictEqual(detailedName('video.mp4', [folder]), 'video.mp4', folder);
    assert.strictEqual(prefixedName('video.mp4', [folder]), 'video.mp4', folder);
  }
  assert.strictEqual(detailedName('video.mp4', ['Summer Trip (2)']), 'Summer Trip (2).mp4');
});

test('flatten은 자막 짝을 유지하고 화질 폴더 위의 폴더 이름과 화질 폴더 이름을 함께 붙인다 (#150)', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/video.mp4', 'ABC-123/video.en.srt', 'Show/1080p/video.mp4', 'Show/720p/video.mp4']);
  flatten(dir);
  assert.deepStrictEqual(Object.keys(contents(dir)).sort(), ['ABC-123 video.en.srt', 'ABC-123 video.mp4', 'Show 1080p video.mp4', 'Show 720p video.mp4']);
});

test('flatten은 바깥 폴더의 제품번호·제목과 가까운 폴더 이름을 함께 남긴다 (#150)', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/CD1/video.mp4', 'ABC-123/CD2/video.mp4', 'Show/CD1/movie.mkv', 'Show/CD2/movie.mkv', 'Show/1080p/Subs/video.en.srt', 'Show/1080p/video.mp4', 'Show/720p/video.mp4']);
  flatten(dir);
  assert.deepStrictEqual(Object.keys(contents(dir)).sort(), [
    'ABC-123 CD1.mp4', 'ABC-123 CD2.mp4', 'Show 1080p video.en.srt', 'Show 1080p video.mp4', 'Show 720p video.mp4', 'Show CD1.mkv', 'Show CD2.mkv',
  ]);
});

test('withOuterFolder·prefixedName은 이미 든 이름, 제품번호가 든 이름, 담는 폴더 이름, 길이 한도를 지킨다 (#150)', () => {
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['ABC-123']), 'ABC-123 CD1.mp4');
  // 바깥 제품번호 폴더를 먼저 고르고, 그 사이 폴더도 붙인다(1차 리뷰).
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['Extras', 'ABC-123']), 'ABC-123 Extras CD1.mp4');
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['Subs', 'ABC-123']), 'ABC-123 CD1.mp4');
  // 파일과 같은 확장자가 붙은 바깥 폴더는 확장자를 떼고 쓴다(1차 리뷰).
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['ABC-123.mp4']), 'ABC-123 CD1.mp4');
  // 받은 이름에 이미 제품번호가 있거나 바깥 이름이 들어 있으면 붙이지 않는다.
  assert.strictEqual(withOuterFolder('video.mp4', 'XYZ-999.mp4', ['ABC-123']), 'XYZ-999.mp4');
  assert.strictEqual(withOuterFolder('video.mp4', 'Show CD1.mp4', ['Show']), 'Show CD1.mp4');
  // 정보 있는 파일명, 쓸 만한 바깥 폴더가 없을 때
  assert.strictEqual(withOuterFolder('trailer.mp4', 'CD1.mp4', ['ABC-123']), 'CD1.mp4');
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['Videos', '새 폴더']), 'CD1.mp4');
  const long = 'T'.repeat(240);
  assert.strictEqual(withOuterFolder('video.mp4', `${long}.mp4`, ['ABC-123 제목입니다']), `${long}.mp4`);
  // 사이 폴더: 같은 이름은 한 번만, Subs·Videos는 빼고, 길면 고른 폴더만
  assert.strictEqual(prefixedName('video.mp4', ['1080p', 'Show 1080p']), 'Show 1080p video.mp4');
  assert.strictEqual(prefixedName('video.en.srt', ['Subs', '1080p', 'Show']), 'Show 1080p video.en.srt');
  assert.strictEqual(prefixedName('video.mp4', ['Videos', 'WEB-DL', 'ABC-123']), 'ABC-123 WEB-DL video.mp4');
  assert.strictEqual(prefixedName('video.mp4', [long, 'ABC-123']), 'ABC-123 video.mp4');
  // 자막 폴더와 그 아래 폴더, 자막 말이 든 폴더는 붙이지 않는다(1차 리뷰).
  assert.strictEqual(prefixedName('video.en.srt', ['English', 'Subs', 'ABC-123']), 'ABC-123 video.en.srt');
  assert.strictEqual(prefixedName('video.en.srt', ['English Subs', 'ABC-123']), 'ABC-123 video.en.srt');
  // 언어 이름만 있는 폴더도 자막 폴더처럼 붙이지 않는다(2차 리뷰).
  for (const folder of ['English', '한국어', 'KOR']) assert.strictEqual(prefixedName('video.ko.srt', [folder, 'ABC-123']), 'ABC-123 video.ko.srt', folder);
  // 사이 폴더까지 붙이면 길이 한도를 넘을 때는 고른 바깥 폴더만 붙인다(2차 리뷰).
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['T'.repeat(240), 'ABC-123']), 'ABC-123 CD1.mp4');
  assert.strictEqual(prefixedName('video.ko.srt', ['한국어', '자막', '1080p', 'ABC-123']), 'ABC-123 1080p video.ko.srt');
});

test('자막·언어 폴더는 접두어로 고르지 않아 영상과 자막이 같은 접두어를 받는다 (#211)', () => {
  // 이슈의 사례: English가 아니라 CD1을 고르고 바깥 Show도 붙여 영상과 같다.
  assert.strictEqual(prefixedName('video.en.srt', ['English', 'CD1', 'Show']), 'Show CD1 video.en.srt');
  assert.strictEqual(prefixedName('video.mp4', ['CD1', 'Show']), 'Show CD1 video.mp4');
  // 자막 말이 든 폴더, 한국어 언어 폴더, 전각 글자도 같다.
  for (const folder of ['English Subs', '한국어', 'ＥＮＧＬＩＳＨ', 'Subs']) {
    assert.strictEqual(prefixedName('video.ko.srt', [folder, 'CD1', 'Show']), 'Show CD1 video.ko.srt', folder);
  }
  // 자막 폴더 아래의 폴더(Subs/Forced/)도 고르지 않는다.
  assert.strictEqual(prefixedName('video.en.srt', ['Forced', 'Subs', 'Show']), 'Show video.en.srt');
  // 바깥 제목은 언어 폴더가 아닌 것을 먼저 고르고, 없으면 언어 폴더도 쓴다(1차 리뷰). 강의 폴더의 제목을 잃지 않는다.
  assert.strictEqual(prefixedName('video.mp4', ['CD1', 'English']), 'English CD1 video.mp4');
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['English', 'Show']), 'Show CD1.mp4');
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['English']), 'English CD1.mp4');
  // 언어 폴더 아래의 폴더(CD1)는 사이 폴더로 붙인다. 언어 폴더만 건너뛴다(1차 리뷰).
  assert.strictEqual(prefixedName('video.mp4', ['CD1', 'English', 'Show']), 'Show CD1 video.mp4');
  // 파일 하나뿐인 언어 폴더의 이름으로 바꾸지 않는다(detailedName의 정보 없는 파일명 경로).
  assert.strictEqual(detailedName('video.srt', ['English']), 'video.srt');
  assert.strictEqual(detailedName('video.srt', ['English', 'Show']), 'Show.srt');
  // 언어 말이 아닌 단어가 함께 있으면 예전처럼 쓴다.
  assert.strictEqual(prefixedName('video.mp4', ['English Lesson']), 'English Lesson video.mp4');
});

test('planFlatten은 언어 폴더 안의 자막도 영상과 같은 접두어로 옮긴다 (#211)', () => {
  const dir = tempDir();
  make(dir, ['Show/CD1/video.mp4', 'Show/CD1/English/video.en.srt']);
  assert.deepStrictEqual(planFlatten(dir).moves.map((move) => move.name).sort(), ['Show CD1 video.en.srt', 'Show CD1 video.mp4']);
});

test('planFlatten은 자막 폴더 안의 폴더 이름을 정보 없는 자막의 새 이름으로 쓰지 않고, 언어 폴더 아래 폴더 이름은 지킨다 (#211, 1차 리뷰)', () => {
  const names = (files) => {
    const dir = tempDir();
    make(dir, files);
    return planFlatten(dir).moves.map((move) => move.name).sort();
  };
  // 파일 하나뿐인 Forced/를 자막의 새 이름으로 고르지 않는다.
  assert.deepStrictEqual(names(['Show/video.mp4', 'Show/Subs/Forced/video.srt']), ['Show video.mp4', 'Show video.srt']);
  assert.deepStrictEqual(names(['Show/CD1/video.mp4', 'Show/CD1/Subs/Forced/video.srt']), ['Show CD1 video.mp4', 'Show CD1 video.srt']);
  // 언어 폴더 아래의 CD 폴더 이름은 남아 서로 구분된다.
  assert.deepStrictEqual(names(['Show/English/CD1/video.mp4', 'Show/English/CD1/sample.mp4', 'Show/English/CD2/video.mp4', 'Show/English/CD2/sample.mp4']), [
    'Show CD1 sample.mp4', 'Show CD1 video.mp4', 'Show CD2 sample.mp4', 'Show CD2 video.mp4',
  ]);
  // 바깥에 언어 폴더뿐이면 그 이름을 쓴다.
  assert.deepStrictEqual(names(['Korean/Lesson 1/video.mp4', 'Korean/Lesson 2/video.mp4']), ['Korean Lesson 1.mp4', 'Korean Lesson 2.mp4']);
  // 자막 말과 다른 말이 함께 든 제목 폴더(하드섭 영상)는 예전처럼 이름으로 쓴다(2차 리뷰).
  assert.deepStrictEqual(names(['Movie [Eng Sub]/video.mp4']), ['Movie [Eng Sub].mp4']);
  assert.deepStrictEqual(names(['Movie [Eng Sub]/video.mp4', 'Movie [Eng Sub]/sample.mp4']), ['Movie [Eng Sub] sample.mp4', 'Movie [Eng Sub] video.mp4']);
  assert.deepStrictEqual(names(['Movie (Eng Subs)/CD1/video.mp4', 'Movie (Eng Subs)/CD2/video.mp4']), ['Movie (Eng Subs) CD1.mp4', 'Movie (Eng Subs) CD2.mp4']);
  // 자막·언어 말로만 된 Eng Sub/ 안의 폴더는 여전히 고르지 않는다.
  assert.deepStrictEqual(names(['Show/video.mp4', 'Show/Eng Sub/Forced/video.srt']), ['Show video.mp4', 'Show video.srt']);
});

test('planFlatten은 파일 하나만 담은 바깥 폴더의 제목도 가까운 폴더 이름과 함께 남긴다 (#168)', () => {
  const names = (files) => {
    const dir = tempDir();
    make(dir, files);
    return planFlatten(dir).moves.map((move) => move.name).sort();
  };
  // 혼자 있을 때와 CD2가 함께 있을 때 이름이 같은 꼴이다.
  assert.deepStrictEqual(names(['Show/CD1/video.mp4']), ['Show CD1.mp4']);
  assert.deepStrictEqual(names(['Show/CD1/video.mp4', 'Show/CD2/video.mp4']), ['Show CD1.mp4', 'Show CD2.mp4']);
  // 사이의 화질 폴더, 같은 확장자가 붙은 폴더 이름도 #150과 같은 규칙을 쓴다.
  assert.deepStrictEqual(names(['Show/1080p/CD1/video.mp4']), ['Show 1080p CD1.mp4']);
  assert.deepStrictEqual(names(['Show/CD1.mp4/video.mp4']), ['Show CD1.mp4']);
  // 고른 폴더를 찾는 비교가 detailedName과 같아야 한다: NFD 폴더 이름, 대소문자가 다른 확장자(1차 리뷰).
  assert.deepStrictEqual(names([`Show/${'씨디'.normalize('NFD')}/video.mp4`]), ['Show 씨디.mp4']);
  assert.deepStrictEqual(names(['Show/CD1.MP4/video.mp4']), ['Show CD1.mp4']);
  // 바깥이 흔한 폴더 이름이면 붙이지 않고, 제품번호 폴더가 있으면 예전처럼 그 이름을 쓴다.
  assert.deepStrictEqual(names(['Downloads/CD1/video.mp4']), ['CD1.mp4']);
  assert.deepStrictEqual(names(['ABC-123/CD1/video.mp4']), ['ABC-123.mp4']);
  // 이미 들어 있는 이름은 다시 붙이지 않는다.
  assert.deepStrictEqual(names(['Show/Show CD1/video.mp4']), ['Show CD1.mp4']);
});

test('prefixedName은 고른 폴더가 제품번호 폴더가 아니면 바깥 제목 폴더도 앞에 붙이고 자막 짝을 유지한다 (#178)', () => {
  const names = (files) => {
    const dir = tempDir();
    make(dir, files);
    return planFlatten(dir).moves.map((move) => move.name).sort();
  };
  // 자막이 있든 없든 Show와 CD1이 함께 남는다.
  assert.deepStrictEqual(names(['Show/CD1/video.mp4', 'Show/CD1/video.en.srt']), ['Show CD1 video.en.srt', 'Show CD1 video.mp4']);
  assert.deepStrictEqual(names(['Show/CD1/video.mp4', 'Show/CD1/Subs/video.en.srt']), ['Show CD1 video.en.srt', 'Show CD1 video.mp4']);
  assert.deepStrictEqual(names(['Show/CD1/video.mp4', 'Show/CD1/sample.mp4', 'Show/CD2/video.mp4']), ['Show CD1 sample.mp4', 'Show CD1 video.mp4', 'Show CD2.mp4']);
  // 사이 화질 폴더는 #150처럼 바깥부터 붙이고, 흔한 바깥 폴더와 제품번호 폴더는 예전 규칙을 따른다.
  assert.strictEqual(prefixedName('video.mp4', ['CD1', '1080p', 'Show']), 'Show 1080p CD1 video.mp4');
  assert.strictEqual(prefixedName('video.mp4', ['CD1', 'Downloads']), 'CD1 video.mp4');
  assert.strictEqual(prefixedName('video.mp4', ['CD1', 'ABC-123']), 'ABC-123 CD1 video.mp4');
  assert.strictEqual(prefixedName('video.mp4', ['CD1', 'Show', 'Movies']), 'Show CD1 video.mp4');
  // 이미 든 이름은 겹치지 않는다. withOuterFolder도 같다.
  assert.strictEqual(prefixedName('video.mp4', ['CD1', 'Show CD1']), 'Show CD1 video.mp4');
  assert.strictEqual(prefixedName('video.mp4', ['Show CD1', 'Show']), 'Show CD1 video.mp4');
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['Show CD1']), 'Show CD1.mp4');
  // 고른 이름 사이에 화질 폴더가 있어도 겹치지 않는다(1차 리뷰).
  assert.strictEqual(prefixedName('video.mp4', ['1080p', 'CD1', 'Show CD1']), 'Show CD1 1080p video.mp4');
  assert.deepStrictEqual(names(['Show CD1/CD1/1080p/video.mp4', 'Show CD1/CD1/1080p/sample.mp4']), ['Show CD1 1080p sample.mp4', 'Show CD1 1080p video.mp4']);
  assert.strictEqual(withOuterFolder('video.mp4', 'CD1.mp4', ['1080p', 'Show CD1']), 'Show CD1 1080p.mp4');
  // 길이 한도를 넘으면 바깥 이름을 빼고 예전 이름으로 돌아간다.
  const long = 'L'.repeat(250);
  assert.strictEqual(prefixedName('video.mp4', ['CD1', long]), 'CD1 video.mp4');
  // 한도 근처에서도 영상과 자막이 같은 접두어를 받는다(1차 리뷰). 길이는 첫 점 앞부분으로 판단한다.
  for (let size = 200; size <= 250; size++) {
    const outer = 'L'.repeat(size);
    const video = prefixedName('video.mp4', ['CD1', outer]);
    const subtitle = prefixedName('video.en.forced.srt', ['CD1', outer]);
    assert.strictEqual(subtitle.slice(0, -'en.forced.srt'.length), video.slice(0, -'mp4'.length), String(size));
    assert.ok(subtitle.length <= 255, String(size));
  }
});

test('flatten은 바깥 폴더와 받은 폴더 이름 사이의 화질 폴더도 남긴다 (#150 1차 리뷰)', () => {
  const dir = tempDir();
  make(dir, ['Show/1080p/CD1/video.mp4', 'Show/1080p/CD2/video.mp4', 'Show/720p/CD1/video.mp4', 'Show/720p/CD2/video.mp4', 'ABC-123.mp4/CD1/video.mp4', 'ABC-123.mp4/CD2/video.mp4']);
  assert.deepStrictEqual(planFlatten(dir).moves.map((move) => move.name).sort(), [
    'ABC-123 CD1.mp4', 'ABC-123 CD2.mp4', 'Show 1080p CD1.mp4', 'Show 1080p CD2.mp4', 'Show 720p CD1.mp4', 'Show 720p CD2.mp4',
  ]);
});

test('planFlatten은 접두어를 붙인 이름이 너무 길면 원래 이름으로 옮긴다', () => {
  const dir = tempDir();
  const folder = `ABC-123 ${'가'.repeat(240)}`;
  make(dir, [path.join(folder, 'video.mp4'), path.join(folder, 'sample.mp4')]);
  const plan = planFlatten(dir);
  assert.deepStrictEqual(plan.moves.map((move) => move.name).sort(), ['sample.mp4', 'video.mp4']);
  assert.ok(plan.moves.every((move) => !move.fromFolder));
});

// #71 2차 리뷰: 자막 폴더, 접두어도 제품번호 폴더 먼저
test('flatten은 자막 폴더 이름을 붙이지 않고, 접두어도 바깥 제품번호 폴더를 먼저 쓴다', () => {
  assert.strictEqual(prefixedName('video.en.srt', ['Subs', 'Show']), 'Show video.en.srt');
  for (const folder of ['Sub', 'Subtitles', '자막']) assert.strictEqual(prefixedName('video.en.srt', [folder, 'Show']), 'Show video.en.srt', folder);
  assert.strictEqual(prefixedName('video.mp4', ['Extras', 'ABC-123']), 'ABC-123 Extras video.mp4');
  // 고른 폴더(Extras)가 제품번호 폴더가 아니면 바깥 제목 폴더도 붙인다(#178).
  assert.strictEqual(prefixedName('video.mp4', ['Extras', 'Show']), 'Show Extras video.mp4');
  const dir = tempDir();
  make(dir, ['Show/video.mp4', 'Show/Subs/video.en.srt', 'ABC-123/Extras/video.mp4', 'ABC-123/Extras/sample.mp4']);
  assert.deepStrictEqual(planFlatten(dir).moves.map((move) => move.name).sort(), ['ABC-123 Extras sample.mp4', 'ABC-123 Extras video.mp4', 'Show video.en.srt', 'Show video.mp4']);
});

// #67: 빈 폴더를 묶어서 휴지통으로, 진행 보고, 휴지통 없는 드라이브, 시간 제한
test('flatten은 빈 폴더를 100개씩 묶어 PowerShell 한 번에 휴지통으로 보낸다', () => {
  const dir = tempDir();
  make(dir, Array.from({ length: 250 }, (_, i) => `d${String(i).padStart(3, '0')}/f${i}.txt`));
  batchCalls.length = 0;
  recycled.length = 0;
  const result = flatten(dir);
  assert.deepStrictEqual(batchCalls, [100, 100, 50]);
  assert.strictEqual(result.removedFolders.length, 250);
  assert.strictEqual(recycled.length, 250);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory()), []);
});

test('flatten은 고정 디스크가 아니거나 종류를 모르는 드라이브에서는 빈 폴더를 지우지 않는다', (t) => {
  t.after(() => {
    volumeState = 'True|Fixed\r\n';
  });
  for (const [state, pattern] of [
    ['True|Removable\r\n', /드라이브\(Removable\)/],
    ['', /종류를 알 수 없음/],
    ['False|Fixed\r\n', /대화형 세션이 아니면/],
    // 휴지통 설정이 "바로 제거"면 빈 폴더도 영구 삭제된다(#81).
    ['True|Fixed|1|26427\r\n', /휴지통 설정이 "바로 제거"라 빈 폴더도/],
  ]) {
    const dir = tempDir();
    make(dir, ['a/x.txt', 'b/y.txt']);
    volumeState = state;
    batchCalls.length = 0;
    const result = flatten(dir);
    assert.deepStrictEqual(batchCalls, []);
    assert.deepStrictEqual(result.removedFolders, []);
    assert.ok(result.keptFolders.length > 0 && result.keptFolders.every((item) => pattern.test(item.reason)), state);
    assert.ok(fs.existsSync(path.join(dir, 'a')));
  }
});

// 묶음 호출을 흉내 낸다. hang에 든 이름의 폴더에서 멈춘 것처럼 시간 제한 오류를 낸다. 그 앞 폴더는 지우고 보고한다.
function fakeBatch(hang) {
  return (options) => {
    const lines = [];
    for (const line of options.input.split('\n').filter(Boolean)) {
      const folder = Buffer.from(line, 'base64').toString('utf16le');
      if (hang.includes(path.basename(folder))) throw Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout: lines.join('\r\n') + '\r\n' });
      fs.rmSync(folder, { recursive: true });
      lines.push('ok ' + line);
    }
    return lines.join('\r\n') + '\r\n';
  };
}

test('flatten은 일괄 이동이 시간 제한에 걸리면 처리 중이던 폴더만 남기고 뒤의 폴더는 다시 보낸다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt', 'c/z.txt', 'd/w.txt']);
  batchOverride = fakeBatch(['b']);
  t.after(() => {
    batchOverride = null;
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, ['a', 'c', 'd'].map((name) => path.join(dir, name)));
  assert.deepStrictEqual(result.keptFolders.map((item) => path.basename(item.path)), ['b']);
  assert.match(result.keptFolders[0].reason, /시간 제한에 걸려/);
  assert.ok(fs.existsSync(path.join(dir, 'b')));
});

test('flatten은 멈추는 폴더가 여럿이어도 순서대로 다시 보내고 진행 줄을 한 번씩만 낸다', (t) => {
  const dir = tempDir();
  make(dir, ['a/1.txt', 'b/2.txt', 'c/3.txt', 'd/4.txt', 'e/5.txt']);
  batchOverride = fakeBatch(['b', 'd']);
  t.after(() => {
    batchOverride = null;
  });
  const lines = [];
  const result = flatten(dir, { onProgress: (line) => lines.push(line) });
  assert.deepStrictEqual(result.removedFolders, ['a', 'c', 'e'].map((name) => path.join(dir, name)));
  assert.deepStrictEqual(result.keptFolders.map((item) => path.basename(item.path)), ['b', 'd']);
  const folderLines = lines.filter((line) => !line.startsWith('이동: '));
  assert.deepStrictEqual(folderLines.map((line) => line.split(' (')[0]), ['빈 폴더를 휴지통으로: a', '폴더 남김: b', '빈 폴더를 휴지통으로: c', '폴더 남김: d', '빈 폴더를 휴지통으로: e']);
});

test('flatten은 묶음의 첫 폴더에서 시간 제한이 연속되면 나머지를 보내지 않는다', (t) => {
  const dir = tempDir();
  const names = Array.from({ length: 6 }, (_, i) => `d${i}`);
  make(dir, names.map((name) => `${name}/f.txt`));
  let calls = 0;
  const hang = fakeBatch(names);
  batchOverride = (options) => {
    calls += 1;
    return hang(options);
  };
  t.after(() => {
    batchOverride = null;
  });
  const result = flatten(dir);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(result.removedFolders, []);
  assert.strictEqual(result.keptFolders.length, 6);
  assert.match(result.keptFolders.at(-1).reason, /2번 연속 걸려/);
});

test('flatten은 시간 제한이 아닌 실패로 일부만 보고되면 나머지를 실패로 남기고 장치 이름 항목을 알린다', { skip: !isWindows }, (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'b/y.txt', 'c/z.txt']);
  batchOverride = (options) => {
    const [first] = options.input.split('\n');
    fs.rmSync(Buffer.from(first, 'base64').toString('utf16le'), { recursive: true });
    // 휴지통 이동이 실패한 폴더 안에 장치 이름 그대로인 빈 폴더가 생긴 것처럼 만든다.
    fs.mkdirSync('\\\\?\\' + path.join(dir, 'b', 'NUL'));
    throw Object.assign(new Error('Command failed'), { status: 1, stdout: 'ok ' + first + '\r\n' });
  };
  t.after(() => {
    batchOverride = null;
    fs.rmSync('\\\\?\\' + path.join(dir, 'b', 'NUL'), { recursive: true, force: true });
  });
  const result = flatten(dir);
  assert.deepStrictEqual(result.removedFolders, [path.join(dir, 'a')]);
  assert.deepStrictEqual(result.keptFolders.map((item) => [path.basename(item.path), /장치 이름 항목\(NUL\)/.test(item.reason)]), [['b', true], ['c', false]]);
  assert.ok(result.keptFolders.every((item) => /휴지통으로 보내지 못했습니다/.test(item.reason)));
});

test('flatten은 묶음 호출이 비대화형·잠금 환경으로 실패하면 뒤의 묶음도 보내지 않는다', (t) => {
  for (const [status, pattern] of [[75, /대화형 세션이 아니면/], [76, /경로 확인용 형식을 만들 수 없어/]]) {
    const dir = tempDir();
    make(dir, Array.from({ length: 150 }, (_, i) => 'd' + String(i).padStart(3, '0') + '/f.txt'));
    let calls = 0;
    batchOverride = () => {
      calls += 1;
      throw Object.assign(new Error('Command failed'), { status, stdout: '' });
    };
    const result = flatten(dir);
    batchOverride = null;
    assert.strictEqual(calls, 1, String(status));
    assert.strictEqual(result.keptFolders.length, 150);
    assert.ok(result.keptFolders.every((item) => pattern.test(item.reason)), String(status));
  }
  t.after(() => {
    batchOverride = null;
  });
});

test('flatten은 미리보기에서도 고정 디스크가 아닌 드라이브면 빈 폴더를 남긴다고 보여 준다', (t) => {
  const dir = tempDir();
  make(dir, ['a/x.txt']);
  volumeState = 'True|Network\r\n';
  t.after(() => {
    volumeState = 'True|Fixed\r\n';
  });
  const preview = flatten(dir, { dryRun: true });
  assert.deepStrictEqual(preview.removedFolders, []);
  assert.match(preview.keptFolders[0].reason, /드라이브\(Network\)/);
});

test('flatten은 휴지통으로 보낼 수 없는 긴 경로의 폴더를 묶음에 넣지 않는다', () => {
  const dir = tempDir();
  const long = 'x'.repeat(Math.max(1, 262 - dir.length));
  make(dir, [path.join(long, 'f.txt')]);
  batchCalls.length = 0;
  const result = flatten(dir);
  assert.deepStrictEqual(batchCalls, []);
  assert.match(result.keptFolders[0].reason, /휴지통으로 보낼 수 없습니다\(259자까지\)/);
});

// 1차 리뷰: 테스트가 묶음 호출을 흉내만 내면 스크립트의 오타나 판정 오류를 놓친다. 휴지통 이동만 출력으로 바꿔 실제 PowerShell로 돌린다.
test('recycleEmptyFolders의 PowerShell 스크립트는 지우기 직전 검사를 실제로 한다', { skip: !isWindows && 'PowerShell' }, (t) => {
  const dir = tempDir();
  const p = (...xs) => path.join(dir, ...xs);
  fs.mkdirSync(p('empty', 'deep'), { recursive: true });
  make(dir, ['meta/desktop.ini', 'filled/keep.txt', 'notdir', 'other/b/z.txt']);
  fs.mkdirSync(p('hasjunction'));
  linkDir(p('other'), p('hasjunction', 'j'));
  linkDir(p('other'), p('swapped'));
  fs.mkdirSync(p('한글 이모지😀'));
  const script = RECYCLE_FOLDERS_SCRIPT.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '$null = $p');
  assert.notStrictEqual(script, RECYCLE_FOLDERS_SCRIPT, '휴지통 이동 호출을 찾아 바꿔야 한다');
  batchOverride = (options, file, args) => execFileSync(file, args, options);
  t.after(() => {
    batchOverride = null;
  });
  const folders = ['empty', 'meta', 'filled', 'notdir', 'gone', 'hasjunction', path.join('swapped', 'b'), '한글 이모지😀'].map((name) => p(name));
  const result = recycleEmptyFolders(folders, { allowedNames: ['desktop.ini'], script });
  assert.deepStrictEqual(result.map((item) => item.status), ['ok', 'ok', 'filled', 'notdir', 'gone', 'filled', 'moved', 'ok']);
  // 휴지통 이동을 바꿨으므로 아무것도 지워지지 않았다.
  assert.ok(fs.existsSync(p('empty', 'deep')) && fs.existsSync(p('other', 'b', 'z.txt')));
});

test('flatten은 실제 실행에서 파일과 폴더가 끝날 때마다 진행 줄을 넘기고, 미리보기에서는 넘기지 않는다', () => {
  const dir = tempDir();
  make(dir, ['a/x.txt', 'c/y.txt']);
  const lines = [];
  run(['flatten', dir, '--dry-run'], { progress: (line) => lines.push(line) });
  assert.deepStrictEqual(lines, []);
  run(['flatten', dir], { progress: (line) => lines.push(line) });
  assert.deepStrictEqual(lines, [`이동: ${path.join('a', 'x.txt')} -> x.txt`, `이동: ${path.join('c', 'y.txt')} -> y.txt`, '빈 폴더를 휴지통으로: a', '빈 폴더를 휴지통으로: c']);
});
