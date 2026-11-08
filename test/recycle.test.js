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
function fakeRecycle(t, fail) {
  const real = childProcess.execFileSync;
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (options?.env?.FC_TARGET === undefined) return real(file, args, options);
    calls.push({ script: args.at(-1), options });
    throw fail(options.env.FC_TARGET);
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

test('휴지통 이동은 시간 제한을 두고, 실패 사유를 UTF-16으로 받으며 stderr를 읽지 않는다 (#97)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { fresh, calls } = fakeRecycle(t, () => failed(77, encode('사유')));
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')]), fresh.FcError);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.timeout, 120 * 1000);
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

test('휴지통 이동이 시간 제한에 걸리면 멈췄다고 알리고 남은 상태를 적는다 (#97)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  let gone = false;
  const { fresh } = fakeRecycle(t, (target) => {
    if (gone) fs.rmSync(target);
    return Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });
  });
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')]), {
    message: `휴지통 이동이 120초 안에 끝나지 않아 멈췄습니다(오류 대화상자 등). 아직 그 자리에 있습니다: ${path.join(dir, 'a.txt')}`,
  });
  gone = true;
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')]), { message: /그 자리에 없으니 휴지통을 확인하세요: / });
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
