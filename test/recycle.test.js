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
  // 대화형 세션 검사는 try 밖에서 먼저 한다.
  assert.match(calls[0].script, /^if \(-not \[Environment\]::UserInteractive\) \{ exit 75 \}; try \{/);
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
