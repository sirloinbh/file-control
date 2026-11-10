'use strict';

// #97: 휴지통 이동이 잠긴 파일에서 멈추지 않고, 사유를 짧게 알리는지 본다.
// 사용자 휴지통을 건드리지 않도록 휴지통 PowerShell 호출(FC_TARGET)은 가짜로 바꾸고, 사용 중인 파일 찾기만 실제 잠금으로 본다.
// 실측(빌드 26200, 대화형 세션): 다른 프로세스가 공유 없이(또는 읽기 공유로) 연 파일과 그런 파일이 든 폴더는
// DeleteFile/DeleteDirectory(OnlyErrorDialogs, SendToRecycleBin)가 대화상자 없이 1~2초 안에 IOException으로 실패했다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const isWindows = process.platform === 'win32';

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-recycle-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

// execFileSync를 바꾼 뒤 그것을 쓰는 commands.js를 새로 읽는다. 다른 테스트가 쓰는 모듈은 그대로 둔다.
function reload() {
  const id = require.resolve('../src/commands');
  const saved = require.cache[id];
  delete require.cache[id];
  const fresh = require('../src/commands');
  require.cache[id] = saved;
  return fresh;
}

// 휴지통 호출만 fail로 바꾸고 나머지(잠금용 PowerShell 등)는 그대로 둔다. 휴지통 호출의 옵션을 calls에 모은다.
// fail이 오류를 돌려주면 그 오류로 실패하고, 아무것도 돌려주지 않으면 대상을 지워 성공한 것처럼 한다.
function fakeRecycle(t, fail) {
  const real = childProcess.execFileSync;
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (options?.env?.FC_TARGET === undefined) return real(file, args, options);
    calls.push({ script: args.at(-1), options });
    const err = fail(options.env.FC_TARGET);
    if (err) throw err;
    fs.rmSync(options.env.FC_TARGET, { recursive: true });
    return '';
  });
  return { fresh: reload(), calls };
}

const encode = (text) => Buffer.from(text, 'utf16le').toString('base64');
const failed = (status, stdout = '') => Object.assign(new Error(`Command failed: powershell secret script\n${'°³'.repeat(5)}`), { status, stdout });

// 다른 프로세스가 공유 없이 파일을 열어 둔다. 열었다고 알릴 때까지 기다리고, 프로세스를 끝내고 끝날 때까지 기다리는 함수를 돌려준다.
async function lockFile(file) {
  const lock = childProcess.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f = [IO.File]::Open($env:F, 'Open', 'Read', 'None'); 'locked'; Start-Sleep 60; $f.Close()"], {
    env: { ...process.env, F: file },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise((resolve) => lock.once('exit', resolve));
  await Promise.race([new Promise((resolve) => lock.stdout.once('data', resolve)), exited.then(() => Promise.reject(new Error('잠금 프로세스가 먼저 끝났습니다')))]);
  return async () => {
    lock.kill();
    await exited;
  };
}

test('휴지통 이동은 시간 제한을 두지 않고, 실패 사유를 UTF-16으로 받으며 stderr를 읽지 않는다 (#97)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { fresh, calls } = fakeRecycle(t, () => failed(77, encode('사유')));
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')]), fresh.FcError);
  assert.strictEqual(calls.length, 1);
  // 도중에 끝내면 폴더 안의 파일 일부가 원래 자리에도 휴지통에도 남지 않으므로 시간 제한을 두지 않는다(1차 리뷰).
  assert.strictEqual(calls[0].options.timeout, undefined);
  assert.deepStrictEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.match(calls[0].script, /catch \{ \$e = \$_\.Exception;.*ToBase64String.*exit 77 \}$/);
  // 대화형 세션 검사는 try 밖에서 먼저 한다. 볼륨 설정과 크기 검사(#81)도 지우기 전에 한다.
  assert.match(calls[0].script, /^if \(-not \[Environment\]::UserInteractive\) \{ exit 75 \}\n/);
  assert.ok(calls[0].script.indexOf("Refuse 'nuke'") < calls[0].script.indexOf('DeleteFile('));
});

test('휴지통 이동이 사용 중인 파일 때문에 실패하면 Windows의 사유와 사용 중인 파일을 알린다 (#97)', { skip: !isWindows && 'Windows 잠금' }, async (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'box', 'sub', 'busy.txt'), 'b');
  fs.writeFileSync(path.join(dir, 'box', 'free.txt'), 'f');
  fs.writeFileSync(path.join(dir, 'one.txt'), 'o');
  const reason = '다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다.';
  const { fresh } = fakeRecycle(t, () => failed(77, `${encode(reason)}\r\n`));
  const unlockBox = await lockFile(path.join(dir, 'box', 'sub', 'busy.txt'));
  const unlockOne = await lockFile(path.join(dir, 'one.txt'));
  try {
    assert.throws(() => fresh.remove([path.join(dir, 'box')]), {
      message: `휴지통으로 보내지 못했습니다: ${path.join(dir, 'box')} (다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다). 안에 다른 프로그램이 사용 중인 파일이 있습니다: ${path.join('sub', 'busy.txt')}. 그 프로그램을 닫은 뒤 다시 지우세요.`,
    });
    assert.throws(() => fresh.remove([path.join(dir, 'one.txt')]), {
      message: `휴지통으로 보내지 못했습니다: ${path.join(dir, 'one.txt')} (다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다). 다른 프로그램이 이 파일을 사용 중입니다. 그 프로그램을 닫은 뒤 다시 지우세요.`,
    });
  } finally {
    await unlockBox();
    await unlockOne();
  }
  // 잠기지 않은 파일이면 Windows의 사유만 알린다. 사유를 못 읽으면 괄호를 붙이지 않는다.
  assert.throws(() => fresh.remove([path.join(dir, 'box', 'free.txt')]), { message: `휴지통으로 보내지 못했습니다: ${path.join(dir, 'box', 'free.txt')} (다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다).` });
});

test('휴지통 이동이 사유를 내보내지 못하고 77로 끝나면 경로만 알린다 (#97)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { fresh } = fakeRecycle(t, () => failed(77, '깨진 출력'));
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')]), { message: `휴지통으로 보내지 못했습니다: ${path.join(dir, 'a.txt')}.` });
});

test('decodeReason은 마지막 줄의 UTF-16 base64만 풀고, 아니면 빈 문자열을 돌려준다 (#97 1차 리뷰)', () => {
  const { decodeReason } = require('../src/commands');
  assert.strictEqual(decodeReason(`경고 문구\r\n${encode('첫 줄\r\n둘째 줄.')}\r\n`), '첫 줄 둘째 줄');
  assert.strictEqual(decodeReason(`${encode('앞 사유')}\r\n깨진 마지막 줄`), '');
  assert.strictEqual(decodeReason(''), '');
  assert.strictEqual(decodeReason(undefined), '');
  assert.strictEqual(decodeReason(Buffer.from(encode('버퍼 사유'))), '버퍼 사유');
});

test('사용 중인 파일 찾기는 정션을 따라가 폴더 밖의 잠긴 파일을 알리지 않는다 (#97 1차 리뷰)', { skip: !isWindows && 'Windows 잠금' }, async (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'busy.txt'), 'x');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'box', 'link'), 'junction');
  fs.writeFileSync(path.join(dir, 'box', 'deep', 'free.txt'), 'f');
  const { fresh } = fakeRecycle(t, () => failed(77, encode('사유')));
  const unlock = await lockFile(path.join(dir, 'outside', 'busy.txt'));
  try {
    // 정션 너머의 잠긴 파일은 찾지 않는다.
    assert.throws(() => fresh.remove([path.join(dir, 'box')]), { message: `휴지통으로 보내지 못했습니다: ${path.join(dir, 'box')} (사유).` });
  } finally {
    await unlock();
  }
});

test('휴지통 이동이 다른 이유로 실패하면 원래 오류를 던지되 명령 전문과 깨진 글자를 보여 주지 않는다 (#97)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { fresh } = fakeRecycle(t, () => failed(1));
  assert.throws(
    () => fresh.remove([path.join(dir, 'a.txt')]),
    (err) => !(err instanceof fresh.FcError) && err.status === 1 && err.message === `휴지통으로 보내지 못했습니다: ${path.join(dir, 'a.txt')} (PowerShell 종료 코드 1)`,
  );
});

test('실제 휴지통 스크립트는 실패하면 77로 끝나고 Windows의 사유를 UTF-16 base64로 내보낸다 (#97)', { skip: !isWindows && 'Windows PowerShell' }, (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'gone.txt');
  fs.writeFileSync(file, 'g');
  const real = childProcess.execFileSync;
  let seen;
  // 휴지통을 건드리지 않도록 PowerShell을 부르기 직전에 파일을 지워 DeleteFile이 "파일 없음"으로 실패하게 한다.
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    if (options?.env?.FC_TARGET === undefined) return real(cmd, args, options);
    fs.rmSync(options.env.FC_TARGET);
    try {
      return real(cmd, args, options);
    } catch (err) {
      seen = err;
      throw err;
    }
  });
  const fresh = reload();
  assert.throws(() => fresh.remove([file]), (err) => err instanceof fresh.FcError && err.message.startsWith(`휴지통으로 보내지 못했습니다: ${file} (`) && !/Command failed|Add-Type/.test(err.message));
  assert.strictEqual(seen.status, 77);
  assert.match(seen.stdout.trim(), /^[A-Za-z0-9+/=]+$/);
});

test('사용 중인 파일 찾기는 파일과 폴더를 합쳐 limit개를 보면 멈춘다 (#97 2차 리뷰)', { skip: !isWindows && 'Windows 잠금' }, async () => {
  const { busyInside } = require('../src/commands');
  const dir = tempDir();
  // 폴더만 여럿 있고 잠긴 파일은 맨 뒤에 있다. 폴더도 세므로 limit이 작으면 잠긴 파일까지 가지 않는다.
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(dir, `d${i}`));
  fs.mkdirSync(path.join(dir, 'z'));
  fs.writeFileSync(path.join(dir, 'z', 'busy.txt'), 'b');
  const unlock = await lockFile(path.join(dir, 'z', 'busy.txt'));
  try {
    assert.strictEqual(busyInside(dir, 3), undefined);
    assert.strictEqual(busyInside(dir), path.join('z', 'busy.txt'));
  } finally {
    await unlock();
  }
});

// #129: 휴지통으로 보낼 수 없는 경로를 미리보기와 여러 대상 실행 전에 알린다.
const LONG_PREFIX = '\\\\?\\';
const LONG =(prefix) => path.join(prefix, 'x'.repeat(120), 'y'.repeat(120), 'long-file-name.txt');
function makeLong(dir) {
  const file = LONG(dir);
  fs.mkdirSync(`${LONG_PREFIX}${path.dirname(file)}`, { recursive: true });
  fs.writeFileSync(`${LONG_PREFIX}${file}`, 'l');
  return file;
}

test('rm은 259자를 넘는 경로를 미리보기에서도 거부하고, 여러 대상이면 아무것도 지우기 전에 거부한다 (#129)', { skip: !isWindows && 'Windows 휴지통' }, (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const long = makeLong(dir);
  assert.ok(long.length > 259);
  const { fresh, calls } = fakeRecycle(t, () => undefined);
  const reason = `경로가 ${long.length}자라 휴지통으로 보낼 수 없습니다(259자까지): ${long}`;
  assert.throws(() => fresh.remove([long], { dryRun: true }), { message: reason });
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt'), path.join(dir, 'b.txt'), long]), { message: reason });
  assert.strictEqual(calls.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt')));
  // 영구 삭제는 Node로 지우므로 길이 검사를 하지 않는다.
  assert.deepStrictEqual(fresh.remove([long], { permanent: true }), [`영구 삭제: ${long}`]);
  assert.ok(!fs.existsSync(`${LONG_PREFIX}${long}`));
});

test('rm은 \\\\?\\ 접두어를 떼도 같은 항목이면 떼고 보내고, 아니면 사유를 밝혀 거부한다 (#129)', { skip: !isWindows && 'Windows 휴지통' }, (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.mkdirSync(`${LONG_PREFIX}${path.join(dir, 'box ')}`);
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'box ', 'in.txt')}`, 'i');
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'dot.')}`, 'd');
  const { fresh, calls } = fakeRecycle(t, () => undefined);
  const prefixed = `${LONG_PREFIX}${path.join(dir, 'a.txt')}`;
  assert.deepStrictEqual(fresh.remove([prefixed], { dryRun: true }), [`[미리보기] 휴지통으로 이동: ${prefixed}`]);
  assert.deepStrictEqual(fresh.remove([prefixed]), [`휴지통으로 이동: ${prefixed}`]);
  assert.deepStrictEqual(calls.map((call) => call.options.env.FC_TARGET), [path.join(dir, 'a.txt')]);
  // 끝이 점·공백인 이름은 접두어를 떼면 다른 항목을 가리킨다. 위 폴더 이름이 그래도 같다.
  for (const name of ['dot.', path.join('box ', 'in.txt')]) {
    assert.throws(() => fresh.remove([`${LONG_PREFIX}${path.join(dir, name)}`], { dryRun: true }), { message: /^끝이 점이나 공백인 이름\((dot\.|box )\)이 있어 휴지통으로 보낼 수 없습니다\. .*fctl rename.*--permanent/ });
  }
  // 드라이브 문자가 아닌 꼴은 거부한다.
  // \\.\ 꼴은 대상이 있어도 거부하고, \\?\UNC\ 꼴은 (관리 공유가 없으면 없는 경로로) 거부한다.
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
  assert.throws(() => fresh.remove([`\\\\.\\${path.join(dir, 'keep.txt')}`], { dryRun: true }), { message: /^이 꼴의 경로는 휴지통으로 보낼 수 없습니다: .*드라이브 문자 경로/ });
  assert.throws(() => fresh.remove([`\\\\?\\UNC\\localhost\\c$\\${path.join(dir, 'dot.').slice(3)}`], { dryRun: true }), { message: /^(이 꼴의 경로는 휴지통으로 보낼 수 없습니다|경로가 없습니다)/ });
  assert.strictEqual(calls.length, 1);
  // 영구 삭제는 접두어 그대로 지운다.
  assert.deepStrictEqual(fresh.remove([`${LONG_PREFIX}${path.join(dir, 'dot.')}`], { permanent: true }), [`영구 삭제: ${LONG_PREFIX}${path.join(dir, 'dot.')}`]);
});

test('rm은 접두어 없이도 끝이 점인 이름을 거부해, 점을 지운 같은 이름의 다른 파일을 휴지통으로 보내지 않는다 (#129 1차 리뷰)', { skip: !isWindows && 'Windows 이름' }, (t) => {
  const dir = tempDir();
  // dot.과 dot이 함께 있으면 휴지통 이동(PowerShell 5.1)은 dot.을 받아 dot을 지웠다(실측).
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'dot.')}`, 'DOTTED');
  fs.writeFileSync(path.join(dir, 'dot'), 'PLAIN');
  const { fresh, calls } = fakeRecycle(t, () => undefined);
  for (const dryRun of [true, false]) {
    assert.throws(() => fresh.remove([path.join(dir, 'dot.')], { dryRun }), {
      message: new RegExp(`^끝이 점이나 공백인 이름\\(dot\\.\\)이 있어 휴지통으로 보낼 수 없습니다\\. .*fctl rename에 .*--permanent`),
    });
  }
  assert.strictEqual(calls.length, 0);
  // 안내하는 접두어 경로는 드라이브 경로면 \\?\D:\…, UNC 경로면 \\?\UNC\server\share\… 꼴이다(2차 리뷰).
  assert.throws(() => fresh.recycleTarget(path.join(dir, 'dot.')), { message: new RegExp(`\\(${`${LONG_PREFIX}${path.join(dir, 'dot.')}`.replace(/[\\.?$]/g, '\\$&')}\\)를 주세요`) });
  assert.throws(() => fresh.recycleTarget('\\\\server\\share.\\x'), { message: /\(\\\\\?\\UNC\\server\\share\.\\x\)를 주세요/ });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'dot'), 'utf8'), 'PLAIN');
  assert.strictEqual(fs.readFileSync(`${LONG_PREFIX}${path.join(dir, 'dot.')}`, 'utf8'), 'DOTTED');
});

test('rm은 접두어 경로를 Node가 정리한 결과와 뗀 경로가 같을 때만 떼고, 다르면 거부한다 (#129 1차 리뷰)', { skip: !isWindows && 'Windows 경로' }, (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const { fresh, calls } = fakeRecycle(t, () => undefined);
  // .과 ..이 같은 곳을 가리키면 정리한 경로로 보낸다. 슬래시 꼴(//?/)도 같다.
  fresh.remove([`${LONG_PREFIX}${path.join(dir, 'sub')}\\.\\..\\a.txt`]);
  fresh.remove([`//?/${path.join(dir, 'b.txt').replaceAll('\\', '/')}`]);
  assert.deepStrictEqual(calls.map((call) => call.options.env.FC_TARGET), [path.join(dir, 'a.txt'), path.join(dir, 'b.txt')]);
  // ..이 드라이브 성분까지 빠져나가면 Node는 \\?\y로, 뗀 경로는 C:\y로 풀려 서로 다르다.
  const depth = dir.split(path.sep).length;
  const escape = `${LONG_PREFIX}${dir}${'\\..'.repeat(depth)}\\y`;
  // 그런 경로는 대개 없어서 rm이 먼저 "경로가 없습니다"로 막으므로, 검사 함수를 직접 본다.
  assert.throws(() => fresh.recycleTarget(escape), { message: /^\\\\\?\\ 접두어를 떼면 다른 곳을 가리켜 휴지통으로 보낼 수 없습니다: / });
  assert.strictEqual(fresh.recycleTarget(`${LONG_PREFIX}${path.join(dir, 'sub')}\\..\\a.txt`), path.join(dir, 'a.txt'));
  assert.strictEqual(calls.length, 2);
});

test('rm은 앞 대상이 뒤 대상을 품어 이미 지웠으면 예전처럼 없다고 알린다 (#129)', (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'b.txt'), 'b');
  const { fresh } = fakeRecycle(t, () => undefined);
  assert.throws(() => fresh.remove([path.join(dir, 'a'), path.join(dir, 'a', 'b.txt')]), { message: `경로가 없습니다: ${path.join(dir, 'a', 'b.txt')}` });
  assert.ok(!fs.existsSync(path.join(dir, 'a')));
  // 미리보기는 겹친다고 알린다.
  fs.mkdirSync(path.join(dir, 'c'));
  fs.writeFileSync(path.join(dir, 'c', 'd.txt'), 'd');
  assert.throws(() => fresh.remove([path.join(dir, 'c'), path.join(dir, 'c', 'd.txt')], { dryRun: true }), { message: /앞 항목과 겹칩니다/ });
});

test('rm은 폴더 안의 끝이 점·공백인 이름 때문에 휴지통 이동이 실패하면 바꿀 항목과 접두어 경로를 알린다 (#190)', { skip: !isWindows && 'Windows 이름' }, (t) => {
  const dir = tempDir();
  // 끝이 점인 폴더 아래 파일: 바꿀 것은 폴더(dot.)다.
  fs.mkdirSync(path.join(dir, 'box', 'sub'), { recursive: true });
  fs.mkdirSync(`${LONG_PREFIX}${path.join(dir, 'box', 'sub', 'dot.')}`);
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'box', 'sub', 'dot.', 'a.txt')}`, 'a');
  // 끝이 공백인 파일
  fs.mkdirSync(path.join(dir, 'box2'));
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'box2', 'sp ')}`, 's');
  // 실측 사유 문구와 같은 꼴로 77을 낸다.
  const { fresh } = fakeRecycle(t, () => failed(77, encode('지정한 파일을 찾을 수 없습니다.')));
  const odd = path.join('sub', 'dot.');
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), {
    message: `휴지통으로 보내지 못했습니다. 안에 끝이 점이나 공백인 이름(${odd})이 있어 휴지통 이동이 폴더째 실패했습니다: ${path.join(dir, 'box')}. fctl rename에 \\\\?\\ 접두어 경로(${LONG_PREFIX}${path.join(dir, 'box', odd)})를 주어 이름을 바꾼 뒤 다시 지우세요.`,
  });
  assert.throws(() => fresh.remove([path.join(dir, 'box2')]), { message: /안에 끝이 점이나 공백인 이름\(sp \)이 있어/ });
  // 그런 이름이 없으면 예전처럼 Windows의 사유를 알린다.
  fs.mkdirSync(path.join(dir, 'plain'));
  fs.writeFileSync(path.join(dir, 'plain', 'a.txt'), 'a');
  assert.throws(() => fresh.remove([path.join(dir, 'plain')]), { message: `휴지통으로 보내지 못했습니다: ${path.join(dir, 'plain')} (지정한 파일을 찾을 수 없습니다).` });
});

test('rm은 폴더 안의 259자를 넘는 경로는 미리 거부하지 않는다 (#190)', { skip: !isWindows && 'Windows 경로' }, (t) => {
  // 실측(빌드 26200): 안쪽 경로가 274~377자인 폴더도 휴지통으로 갔고, 긴 경로 파일도 휴지통 안에 그대로 남았다.
  const dir = tempDir();
  let deep = path.join(dir, 'box');
  while (deep.length < 270) deep = path.join(deep, 'd'.repeat(20));
  fs.mkdirSync(`${LONG_PREFIX}${deep}`, { recursive: true });
  fs.writeFileSync(`${LONG_PREFIX}${path.join(deep, 'f.txt')}`, 'f');
  const { fresh, calls } = fakeRecycle(t, () => undefined);
  fresh.remove([path.join(dir, 'box')]);
  assert.strictEqual(calls.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'box')));
});

test('실제 휴지통 이동은 안에 끝이 점인 이름이 든 폴더를 옮기지 않고 실패한다 (#190)', { skip: (!isWindows || process.env.CI) && '대화형 Windows에서만' }, (t) => {
  // 이 PC에서 확인한 전제를 지킨다. 실패가 바뀌어 폴더가 휴지통으로 가도 임시 폴더라 사용자 파일은 잃지 않는다.
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box'));
  fs.writeFileSync(path.join(dir, 'box', 'ok.txt'), 'ok');
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'box', 'dot.')}`, 'x');
  const fresh = reload();
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), { message: /안에 끝이 점이나 공백인 이름\(dot\.\)이 있어/ });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'box', 'ok.txt'), 'utf8'), 'ok');
  assert.ok(fs.existsSync(`${LONG_PREFIX}${path.join(dir, 'box', 'dot.')}`));
});

// #194: 묶음 휴지통 이동 스크립트를 실제 PowerShell로 돌린다. 사용자 휴지통을 건드리지 않도록 휴지통 이동만 영구 삭제(임시 폴더 안)로 바꾼다.
test('recycleFiles의 PowerShell 스크립트는 파일마다 지우기 직전에 실제 경로·파일 여부·fileStamp를 다시 본다 (#194)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const p = (...xs) => path.join(dir, ...xs);
  fs.mkdirSync(p('real'));
  for (const name of ['ok.mp4', '한글 이모지😀.mp4', 'changed.mp4', 'gone.mp4', 'real/x.mp4']) fs.writeFileSync(p(name), name);
  fs.mkdirSync(p('dir.mp4'));
  fs.symlinkSync(p('real'), p('junction'), 'junction');
  const stamp = (file) => fileStamp(fs.lstatSync(file, { bigint: true }));
  const items = ['ok.mp4', '한글 이모지😀.mp4', 'changed.mp4', 'gone.mp4', path.join('junction', 'x.mp4')].map((name) => ({ path: p(name), stamp: stamp(name.startsWith('junction') ? p('real', 'x.mp4') : p(name)) }));
  items.push({ path: p('dir.mp4'), stamp: '1:2:3:4' });
  fs.appendFileSync(p('changed.mp4'), '+');
  fs.rmSync(p('gone.mp4'));
  const script = reload().RECYCLE_FILES_SCRIPT;
  const swapped = script.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  assert.notStrictEqual(swapped, script, '휴지통 이동 호출을 찾아 바꿔야 한다');
  const results = reload().recycleFiles(items, { script: swapped });
  assert.deepStrictEqual(results.map((item) => [path.relative(dir, item.path), item.status]), [
    ['ok.mp4', 'ok'],
    ['한글 이모지😀.mp4', 'ok'],
    ['changed.mp4', 'changed'],
    ['gone.mp4', 'gone'],
    [path.join('junction', 'x.mp4'), 'moved'],
    ['dir.mp4', 'notfile'],
  ]);
  assert.ok(!fs.existsSync(p('ok.mp4')) && !fs.existsSync(p('한글 이모지😀.mp4')));
  assert.ok(fs.existsSync(p('changed.mp4')) && fs.existsSync(p('real', 'x.mp4')) && fs.existsSync(p('dir.mp4')));
});

test('recycleFiles의 PowerShell 스크립트는 심볼릭 링크 파일을 지우지 않는다 (#194 1차 리뷰)', { skip: !isWindows && 'PowerShell' }, (t) => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const real = path.join(dir, 'real.mp4');
  const link = path.join(dir, 'link.mp4');
  fs.writeFileSync(real, 'r');
  try {
    fs.symlinkSync(real, link, 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('심볼릭 링크를 만들 권한이 없음');
    throw err;
  }
  const script = reload().RECYCLE_FILES_SCRIPT;
  const swapped = script.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  // 링크 자신의 stamp를 주어도, 대상 파일의 stamp를 주어도 지우지 않는다.
  for (const stamp of [fileStamp(fs.lstatSync(link, { bigint: true })), fileStamp(fs.lstatSync(real, { bigint: true }))]) {
    const [result] = reload().recycleFiles([{ path: link, stamp }], { script: swapped });
    assert.notStrictEqual(result.status, 'ok');
  }
  assert.ok(fs.lstatSync(link).isSymbolicLink() && fs.existsSync(real));
});

test('recycleFiles의 PowerShell 스크립트는 남길 파일(keep)이 바뀌었거나 없어지면 사본을 지우지 않는다 (#216)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const p = (name) => path.join(dir, name);
  for (const name of ['keep1.mp4', 'keep2.mp4', 'keep3.mp4', 'copy1.mp4', 'copy2.mp4', 'copy3.mp4', 'plain.mp4']) fs.writeFileSync(p(name), name);
  const stamp = (name) => fileStamp(fs.lstatSync(p(name), { bigint: true }));
  const keep = (name) => ({ path: p(name), stamp: stamp(name) });
  const items = [
    { path: p('copy1.mp4'), stamp: stamp('copy1.mp4'), keep: keep('keep1.mp4') },
    { path: p('copy2.mp4'), stamp: stamp('copy2.mp4'), keep: keep('keep2.mp4') },
    { path: p('copy3.mp4'), stamp: stamp('copy3.mp4'), keep: keep('keep3.mp4') },
    { path: p('plain.mp4'), stamp: stamp('plain.mp4') },
  ];
  fs.appendFileSync(p('keep2.mp4'), '+');
  fs.rmSync(p('keep3.mp4'));
  const script = reload().RECYCLE_FILES_SCRIPT;
  const swapped = script.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  assert.notStrictEqual(swapped, script);
  const results = reload().recycleFiles(items, { script: swapped });
  assert.deepStrictEqual(results.map((item) => [path.basename(item.path), item.status]), [
    ['copy1.mp4', 'ok'],
    ['copy2.mp4', 'keepchanged'],
    ['copy3.mp4', 'keepchanged'],
    ['plain.mp4', 'ok'],
  ]);
  assert.ok(!fs.existsSync(p('copy1.mp4')) && fs.existsSync(p('copy2.mp4')) && fs.existsSync(p('copy3.mp4')) && fs.existsSync(p('keep1.mp4')));
});

test('recycleFiles의 PowerShell 스크립트는 경로가 긴 남길 파일도 확인하고, 칸 수가 맞지 않는 줄은 지우지 않는다 (#216 1차 리뷰)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const keep = path.join(dir, 'k'.repeat(120), 'l'.repeat(120), 'keep.mp4');
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(keep, 'k');
  assert.ok(keep.length > 259);
  const copy = path.join(dir, 'copy.mp4');
  const odd = path.join(dir, 'odd.mp4');
  fs.writeFileSync(copy, 'c');
  fs.writeFileSync(odd, 'o');
  const stamp = (file) => fileStamp(fs.lstatSync(file, { bigint: true }));
  const swapped = reload().RECYCLE_FILES_SCRIPT.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  const [result] = reload().recycleFiles([{ path: copy, stamp: stamp(copy), keep: { path: keep, stamp: stamp(keep) } }], { script: swapped });
  assert.strictEqual(result.status, 'ok');
  assert.ok(!fs.existsSync(copy) && fs.existsSync(keep));
  // 남길 파일 경로만 있고 stamp가 없는 줄(칸 3개)은 남길 파일 검사를 건너뛰지 않도록 지우지 않는다.
  const b64 = (p) => Buffer.from(p, 'utf16le').toString('base64');
  const output = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', swapped], { input: `${b64(odd)} ${stamp(odd)} ${b64(keep)}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  assert.match(output.trim(), /^error /);
  assert.ok(fs.existsSync(odd));
});

// #236: 지우기 직전에 볼륨 휴지통 설정을 다시 본다. 사용자 설정은 바꾸지 않고, 스크립트 사본 안에서 폴더마다 읽은 설정값만 바꾼다.
test('recycleFiles의 PowerShell 스크립트는 지우기 직전에 볼륨 설정이 바로 제거·최대 크기 초과·고정 디스크 아님이면 지우지 않는다 (#236)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const p = (...xs) => path.join(dir, ...xs);
  const names = [['ok', 'a.mp4'], ['ok', 'b.mp4'], ['nuke', 'a.mp4'], ['cap', 'big.mp4'], ['cap', 'small.mp4'], ['removable', 'a.mp4']];
  for (const [folder, name] of names) {
    fs.mkdirSync(p(folder), { recursive: true });
    fs.writeFileSync(p(folder, name), name === 'big.mp4' ? Buffer.alloc(1024 * 1024 + 1) : name);
  }
  const items = names.map((parts) => ({ path: p(...parts), stamp: fileStamp(fs.lstatSync(p(...parts), { bigint: true })) }));
  const script = reload().RECYCLE_FILES_SCRIPT;
  // 폴더 이름에 따라 설정을 바꾸고, 폴더마다 설정을 몇 번 읽었는지 stderr 대신 파일에 남긴다.
  const reads = p('reads.txt');
  const override = `[IO.File]::AppendAllText('${reads}', $p + "\`n")
  if ($p.EndsWith('nuke')) { $nuke = '1' }
  if ($p.EndsWith('cap')) { $nuke = '0'; $cap = '1' }
  if ($p.EndsWith('removable')) { $type = 'Removable' }
  return @($type, $nuke, $cap)`;
  const swapped = script
    .replace('  return @($type, $nuke, $cap)', override)
    .replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  assert.ok(swapped.includes('AppendAllText') && swapped.includes('[IO.File]::Delete($long)'), '설정 읽기와 휴지통 이동 호출을 찾아 바꿔야 한다');
  const results = reload().recycleFiles(items, { script: swapped });
  assert.deepStrictEqual(results.map((item) => [path.relative(dir, item.path), item.status, item.reason]), [
    [path.join('ok', 'a.mp4'), 'ok', ''],
    [path.join('ok', 'b.mp4'), 'ok', ''],
    [path.join('nuke', 'a.mp4'), 'permanent', '이 볼륨은 휴지통 설정이 "바로 제거"라 휴지통을 거치지 않고 영구 삭제되므로'],
    [path.join('cap', 'big.mp4'), 'permanent', '휴지통 최대 크기(1MB)보다 커서 Windows가 묻지 않고 영구 삭제하므로'],
    [path.join('cap', 'small.mp4'), 'ok', ''],
    [path.join('removable', 'a.mp4'), 'permanent', '휴지통이 없을 수 있는 드라이브(Removable)라 영구 삭제될 수 있으므로'],
  ]);
  assert.ok(!fs.existsSync(p('ok', 'a.mp4')) && !fs.existsSync(p('cap', 'small.mp4')));
  assert.ok(fs.existsSync(p('nuke', 'a.mp4')) && fs.existsSync(p('cap', 'big.mp4')) && fs.existsSync(p('removable', 'a.mp4')));
  // 설정은 폴더마다 한 번만 읽는다.
  assert.deepStrictEqual(fs.readFileSync(reads, 'utf8').trim().split('\n').map((line) => path.relative(dir, line)), ['ok', 'nuke', 'cap', 'removable']);
});

test('recycleFiles의 PowerShell 스크립트는 휴지통 최대 크기를 모르면 1GB 이상 파일을 지우지 않는다 (#236)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const file = path.join(dir, 'a.mp4');
  fs.writeFileSync(file, 'a');
  // 크기를 바꾸는 대신 기준(1GB - 1)을 0으로 낮춘 사본으로 같은 판정 줄을 탄다.
  const script = reload().RECYCLE_FILES_SCRIPT;
  const swapped = script
    .replace('  return @($type, $nuke, $cap)', "  return @($type, $nuke, '')")
    .replace('{ 1GB - 1 }', '{ 0 }')
    .replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  assert.ok(swapped.includes("@($type, $nuke, '')") && swapped.includes('{ 0 }'));
  const [result] = reload().recycleFiles([{ path: file, stamp: fileStamp(fs.lstatSync(file, { bigint: true })) }], { script: swapped });
  assert.deepStrictEqual([result.status, result.reason], ['permanent', '1GB 이상이고 휴지통 최대 크기를 확인하지 못해 영구 삭제될 수 있으므로']);
  assert.ok(fs.existsSync(file));
});

test('recycleFiles의 PowerShell 스크립트는 지우다 실패한 파일의 Windows 사유를 UTF-16으로 알리고 다음 파일을 계속한다 (#194)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const a = path.join(dir, 'a.mp4');
  const b = path.join(dir, 'b.mp4');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const items = [a, b].map((file) => ({ path: file, stamp: fileStamp(fs.lstatSync(file, { bigint: true })) }));
  const script = reload().RECYCLE_FILES_SCRIPT;
  // a.mp4만 한글 사유로 실패하게 한다.
  const swapped = script.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", "if ($p.EndsWith('a.mp4')) { throw [IO.IOException]::new('사용 중입니다.') }; [IO.File]::Delete($long)");
  assert.notStrictEqual(swapped, script);
  const results = reload().recycleFiles(items, { script: swapped });
  assert.deepStrictEqual(results.map((item) => [path.basename(item.path), item.status, item.reason]), [
    ['a.mp4', 'error', '사용 중입니다'],
    ['b.mp4', 'ok', ''],
  ]);
  assert.ok(fs.existsSync(a) && !fs.existsSync(b));
});

// #81: 영구 삭제될 대상은 지우기 전에 거부한다. 볼륨 설정 확인(FC_VOLUME)과 휴지통 이동(FC_TARGET)을 가짜로 바꾼다.
function fakeVolume(t, answer) {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (options?.env?.FC_VOLUME !== undefined) return typeof answer === 'function' ? answer(options.env.FC_VOLUME) : answer;
    if (options?.env?.FC_TARGET !== undefined) {
      calls.push(options.env.FC_TARGET);
      fs.rmSync(options.env.FC_TARGET, { recursive: true });
      return '';
    }
    throw new Error('예상하지 못한 호출');
  });
  return { fresh: reload(), calls };
}

for (const [name, answer, pattern] of [
  ['바로 제거', 'True|Fixed|1|26427\r\n', /이 볼륨은 휴지통 설정이 "바로 제거"라 휴지통을 거치지 않고 영구 삭제되므로 지우지 않았습니다\./],
  ['최대 크기 초과', 'True|Fixed|0|0\r\n', /휴지통 최대 크기\(0MB\)보다 커서 Windows가 묻지 않고 영구 삭제하므로 지우지 않았습니다\./],
  ['이동식 드라이브', 'True|Removable|0|26427\r\n', /휴지통이 없을 수 있는 드라이브\(Removable\)라 영구 삭제될 수 있으므로/],
  ['네트워크 드라이브', 'True|Network||\r\n', /휴지통이 없을 수 있는 드라이브\(Network\)라/],
  ['종류를 모름', 'True|Unknown||\r\n', /드라이브 종류를 확인하지 못해 휴지통이 있는지 알 수 없으므로/],
  ['확인 실패', '뜻밖의 출력', /드라이브 종류를 확인하지 못해/],
]) {
  test(`rm은 휴지통을 거치지 않고 영구 삭제될 대상이면 미리보기에서도, 여러 대상이면 아무것도 지우기 전에 거부한다 (#81): ${name}`, { skip: !isWindows && 'Windows 휴지통' }, (t) => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    const { fresh, calls } = fakeVolume(t, (volume) => (volume.endsWith('b.txt') ? answer : 'True|Fixed|0|26427\r\n'));
    for (const dryRun of [true, false]) {
      assert.throws(() => fresh.remove([path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], { dryRun, permanentHint: true }), (err) => {
        assert.ok(err instanceof fresh.FcError);
        assert.ok(err.message.startsWith(`휴지통으로 보내지 않았습니다: ${path.join(dir, 'b.txt')}. `), err.message);
        assert.match(err.message, pattern);
        assert.match(err.message, /지우지 않았습니다\. 휴지통을 거치지 않고 지우려면 --permanent를 쓰세요\.$/);
        return true;
      });
    }
    // --permanent를 받지 않는 명령(extract-all, collapse)이 부르면 그 안내를 붙이지 않는다(1차 리뷰).
    assert.throws(() => fresh.remove([path.join(dir, 'b.txt')]), (err) => /지우지 않았습니다\.$/.test(err.message) && !err.message.includes('--permanent'));
    assert.deepStrictEqual(calls, []);
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt')));
    // --permanent는 휴지통을 거치지 않으므로 이 검사를 하지 않는다.
    fresh.remove([path.join(dir, 'b.txt')], { permanent: true });
    assert.ok(!fs.existsSync(path.join(dir, 'b.txt')));
  });
}

test('rm은 폴더면 안의 파일 합계로 최대 크기를 보고, 크기 안이면 그대로 보낸다 (#81)', { skip: !isWindows && 'Windows 휴지통' }, (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'box', 'a.bin'), Buffer.alloc(700 * 1024));
  fs.writeFileSync(path.join(dir, 'box', 'sub', 'b.bin'), Buffer.alloc(700 * 1024));
  // 최대 크기 1MB: 파일 하나(700KB)는 되고 합계(1400KB)는 넘는다.
  const { fresh, calls } = fakeVolume(t, 'True|Fixed|0|1\r\n');
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), /휴지통 최대 크기\(1MB\)보다 커서/);
  fresh.remove([path.join(dir, 'box', 'a.bin')]);
  assert.deepStrictEqual(calls, [path.join(dir, 'box', 'a.bin')]);
  // a.bin을 보낸 뒤 남은 합계(700KB)는 최대 크기 안이다.
  assert.strictEqual(fresh.previewRefusal(path.join(dir, 'box')), null);
});

test('rm은 대상 자체가 정션이면 그 너머를 세지 않는다 (#81 1차 리뷰)', { skip: !isWindows && 'Windows 정션' }, (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'big'));
  fs.writeFileSync(path.join(dir, 'big', 'x.bin'), Buffer.alloc(2 * 1024 * 1024));
  fs.symlinkSync(path.join(dir, 'big'), path.join(dir, 'jn'), 'junction');
  const { fresh } = fakeVolume(t, 'True|Fixed|0|1\r\n');
  assert.strictEqual(fresh.sizeUpTo(path.join(dir, 'jn'), 1e9), 0);
  assert.strictEqual(fresh.previewRefusal(path.join(dir, 'jn')), null);
  assert.match(fresh.previewRefusal(path.join(dir, 'big')), /휴지통 최대 크기\(1MB\)보다 커서/);
});

test('휴지통 이동 스크립트의 78 표시가 비었거나 알 수 없으면 크기를 확인하지 못한 것으로 거부한다 (#81)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { fresh } = fakeRecycle(t, () => failed(78, ''));
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')], { checkVolume: false }), /크기를 확인하지 못해 휴지통 최대 크기를 넘는지 알 수 없으므로 지우지 않았습니다\.$/);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
});

test('sizeUpTo는 링크·정션을 따라가지 않고, 한도를 넘으면 그만 센다 (#81)', { skip: !isWindows && 'Windows 정션' }, () => {
  const { sizeUpTo } = reload();
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box'));
  fs.mkdirSync(path.join(dir, 'big'));
  fs.writeFileSync(path.join(dir, 'big', 'x.bin'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(dir, 'box', 'a.bin'), Buffer.alloc(10));
  fs.symlinkSync(path.join(dir, 'big'), path.join(dir, 'box', 'j'), 'junction');
  assert.strictEqual(sizeUpTo(path.join(dir, 'box'), 1e9), 10);
  assert.strictEqual(sizeUpTo(path.join(dir, 'big'), 1e9), 5000);
  assert.ok(sizeUpTo(path.join(dir, 'big'), 100) > 100);
  assert.strictEqual(sizeUpTo(path.join(dir, 'box', 'a.bin'), 1e9), 10);
});

test('휴지통 이동 스크립트가 영구 삭제될 대상이라고 알리면(78) 사유를 밝혀 거부한다 (#81)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  // 같은 함수를 여러 번 가짜로 바꾸면 테스트 뒤에 원래대로 돌아오지 않으므로 한 번만 바꾸고 알릴 표시만 바꾼다.
  let mark;
  const { fresh } = fakeRecycle(t, () => failed(78, encode(mark)));
  for (const [next, pattern] of [
    ['nuke', /"바로 제거"라/],
    ['cap|7164', /휴지통 최대 크기\(7164MB\)보다 커서/],
    ['unknown', /1GB 이상이고 휴지통 최대 크기를 확인하지 못해/],
    ['type|Removable', /드라이브\(Removable\)라/],
    ['type|Unknown', /드라이브 종류를 확인하지 못해/],
    ['size', /크기를 확인하지 못해 휴지통 최대 크기를 넘는지 알 수 없으므로/],
  ]) {
    mark = next;
    assert.throws(() => fresh.remove([path.join(dir, 'a.txt')], { checkVolume: false }), (err) => err instanceof fresh.FcError && pattern.test(err.message) && err.message.startsWith('휴지통으로 보내지 않았습니다: '), mark);
  }
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
});

// 실제 PowerShell로 지우기 직전 검사를 돌린다. 사용자 설정은 바꾸지 않고 스크립트 사본 안에서만 설정값을 바꾸며, 휴지통 이동은 하지 않게 한다.
test('실제 휴지통 이동 스크립트는 지우기 직전에 설정과 크기(폴더 합계, 정션 제외)를 보고 78로 거부한다 (#81)', { skip: !isWindows && 'PowerShell' }, () => {
  const { RECYCLE_SCRIPT } = reload();
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box'));
  fs.mkdirSync(path.join(dir, 'big'));
  fs.writeFileSync(path.join(dir, 'big', 'x.bin'), Buffer.alloc(2 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'box', 'a.bin'), Buffer.alloc(10));
  fs.symlinkSync(path.join(dir, 'big'), path.join(dir, 'box', 'j'), 'junction');
  const noDelete = RECYCLE_SCRIPT.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", "'deleted-dir'").replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", "'deleted-file'");
  assert.ok(noDelete.includes("'deleted-dir'") && noDelete.includes("'deleted-file'"), '휴지통 이동 호출을 찾아 바꿔야 한다');
  const run = (target, setup) => {
    const script = noDelete.replace("$u = [Text.Encoding]::Unicode", `${setup}\n$u = [Text.Encoding]::Unicode`);
    assert.notStrictEqual(script, noDelete);
    try {
      return { status: 0, out: childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FC_TARGET: target }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() };
    } catch (err) {
      return { status: err.status, out: reload().decodeReason(err.stdout) };
    }
  };
  // 정션 너머(2MB)는 세지 않아 최대 크기 1MB 안이다.
  assert.deepStrictEqual(run(path.join(dir, 'box'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 0, out: 'deleted-dir' });
  assert.deepStrictEqual(run(path.join(dir, 'big'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 78, out: 'cap|1' });
  assert.deepStrictEqual(run(path.join(dir, 'big', 'x.bin'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 78, out: 'cap|1' });
  assert.deepStrictEqual(run(path.join(dir, 'box', 'a.bin'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 0, out: 'deleted-file' });
  assert.deepStrictEqual(run(path.join(dir, 'box', 'a.bin'), "$type = 'Fixed'; $nuke = '1'; $cap = '26427'"), { status: 78, out: 'nuke' });
  assert.deepStrictEqual(run(path.join(dir, 'box', 'a.bin'), "$type = 'Removable'"), { status: 78, out: 'type|Removable' });
  assert.deepStrictEqual(run(path.join(dir, 'big'), "$type = 'Fixed'; $nuke = ''; $cap = ''"), { status: 0, out: 'deleted-dir' });
  // 대상 자체가 정션이어도 그 너머를 세지 않는다(1차 리뷰). Node의 sizeUpTo와 같다.
  assert.deepStrictEqual(run(path.join(dir, 'box', 'j'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 0, out: 'deleted-dir' });
  // 볼륨 설정 부분은 실제 값을 읽는다(사본 안에서 바꾸지 않으면).
  const state = run(path.join(dir, 'box', 'a.bin'), '');
  assert.ok(state.status === 0 || state.status === 78, JSON.stringify(state));
  assert.ok(fs.existsSync(path.join(dir, 'box', 'a.bin')) && fs.existsSync(path.join(dir, 'big', 'x.bin')));
});
