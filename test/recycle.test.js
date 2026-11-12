'use strict';

// #97: it checks that the Recycle Bin move does not stall on a locked file and reports the reason briefly.
// So as not to touch the user's Recycle Bin, the Recycle Bin PowerShell call (FC_TARGET) is swapped for a fake, and only the search for files in use is checked with a real lock.
// Measured (build 26200, interactive session): a file that another process opened without sharing (or with read sharing) and a folder that holds such a file
// failed with IOException from DeleteFile/DeleteDirectory (OnlyErrorDialogs, SendToRecycleBin) within 1 to 2 seconds without a dialog.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const isWindows = process.platform === 'win32';

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-recycle-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

// After swapping execFileSync, it reads commands.js, which uses it, anew. Modules other tests use are left as they are.
function reload() {
  const id = require.resolve('../src/commands');
  const saved = require.cache[id];
  delete require.cache[id];
  const fresh = require('../src/commands');
  require.cache[id] = saved;
  return fresh;
}

// It swaps only the Recycle Bin call for fail and leaves the rest (the PowerShell for locking and so on) as they are. It collects the options of the Recycle Bin call in calls.
// If fail returns an error, it fails with that error, and if it returns nothing, it deletes the target as if it succeeded.
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

// Another process holds a file open without sharing. It waits until it reports that it opened it, and returns a function that ends the process and waits until it ends.
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
  // Ending midway leaves some files in the folder in neither the original place nor the Recycle Bin, so there is no time limit (first review).
  assert.strictEqual(calls[0].options.timeout, undefined);
  assert.deepStrictEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.match(calls[0].script, /catch \{ \$e = \$_\.Exception;.*ToBase64String.*exit 77 \}$/);
  // The interactive session check is done first, outside try. The volume setting and size check (#81) is also done before deleting.
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
      message: `Could not send to the Recycle Bin: ${path.join(dir, 'box')} (다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다). A file inside is in use by another program: ${path.join('sub', 'busy.txt')}. Close that program and delete again.`,
    });
    assert.throws(() => fresh.remove([path.join(dir, 'one.txt')]), {
      message: `Could not send to the Recycle Bin: ${path.join(dir, 'one.txt')} (다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다). Another program is using this file. Close that program and delete again.`,
    });
  } finally {
    await unlockBox();
    await unlockOne();
  }
  // If the file is not locked, it reports only Windows' reason. If the reason cannot be read, no parentheses are added.
  assert.throws(() => fresh.remove([path.join(dir, 'box', 'free.txt')]), { message: `Could not send to the Recycle Bin: ${path.join(dir, 'box', 'free.txt')} (다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다).` });
});

test('휴지통 이동이 사유를 내보내지 못하고 77로 끝나면 경로만 알린다 (#97)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { fresh } = fakeRecycle(t, () => failed(77, '깨진 출력'));
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')]), { message: `Could not send to the Recycle Bin: ${path.join(dir, 'a.txt')}.` });
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
    // It does not look for locked files beyond a junction.
    assert.throws(() => fresh.remove([path.join(dir, 'box')]), { message: `Could not send to the Recycle Bin: ${path.join(dir, 'box')} (사유).` });
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
    (err) => !(err instanceof fresh.FcError) && err.status === 1 && err.message === `Could not send to the Recycle Bin: ${path.join(dir, 'a.txt')} (PowerShell exit code 1)`,
  );
});

test('실제 휴지통 스크립트는 실패하면 77로 끝나고 Windows의 사유를 UTF-16 base64로 내보낸다 (#97)', { skip: !isWindows && 'Windows PowerShell' }, (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'gone.txt');
  fs.writeFileSync(file, 'g');
  const real = childProcess.execFileSync;
  let seen;
  // So as not to touch the Recycle Bin, it deletes the file right before calling PowerShell so that DeleteFile fails with "file not found".
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
  assert.throws(() => fresh.remove([file]), (err) => err instanceof fresh.FcError && err.message.startsWith(`Could not send to the Recycle Bin: ${file} (`) && !/Command failed|Add-Type/.test(err.message));
  assert.strictEqual(seen.status, 77);
  assert.match(seen.stdout.trim(), /^[A-Za-z0-9+/=]+$/);
});

test('사용 중인 파일 찾기는 파일과 폴더를 합쳐 limit개를 보면 멈춘다 (#97 2차 리뷰)', { skip: !isWindows && 'Windows 잠금' }, async () => {
  const { busyInside } = require('../src/commands');
  const dir = tempDir();
  // There are only several folders and the locked file is last. Folders are also counted, so if limit is small, it does not get to the locked file.
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

// #129: it reports paths that cannot be sent to the Recycle Bin in the preview and before running on several targets.
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
  const reason = `The path is ${long.length} characters, so it cannot be sent to the Recycle Bin (up to 259): ${long}`;
  assert.throws(() => fresh.remove([long], { dryRun: true }), { message: reason });
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt'), path.join(dir, 'b.txt'), long]), { message: reason });
  assert.strictEqual(calls.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt')));
  // Permanent deletion deletes with Node, so it does not run the length check.
  assert.deepStrictEqual(fresh.remove([long], { permanent: true }), [`Delete permanently: ${long}`]);
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
  assert.deepStrictEqual(fresh.remove([prefixed], { dryRun: true }), [`[Preview] Move to the Recycle Bin: ${prefixed}`]);
  assert.deepStrictEqual(fresh.remove([prefixed]), [`Move to the Recycle Bin: ${prefixed}`]);
  assert.deepStrictEqual(calls.map((call) => call.options.env.FC_TARGET), [path.join(dir, 'a.txt')]);
  // A name ending in a dot or a space points to another item if the prefix is stripped. The folder name above is the same anyway.
  for (const name of ['dot.', path.join('box ', 'in.txt')]) {
    assert.throws(() => fresh.remove([`${LONG_PREFIX}${path.join(dir, name)}`], { dryRun: true }), { message: /^It cannot be sent to the Recycle Bin because of a name ending with a dot or space \((dot\.|box )\)\. .*fctl rename.*--permanent/ });
  }
  // A form that is not a drive letter is refused.
  // The \\.\ form is refused even if the target exists, and the \\?\UNC\ form is refused (as a nonexistent path if there is no administrative share).
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'k');
  assert.throws(() => fresh.remove([`\\\\.\\${path.join(dir, 'keep.txt')}`], { dryRun: true }), { message: /^A path of this form cannot be sent to the Recycle Bin: .*drive-letter path/ });
  assert.throws(() => fresh.remove([`\\\\?\\UNC\\localhost\\c$\\${path.join(dir, 'dot.').slice(3)}`], { dryRun: true }), { message: /^(A path of this form cannot be sent to the Recycle Bin|Path does not exist)/ });
  assert.strictEqual(calls.length, 1);
  // Permanent deletion deletes with the prefix as it is.
  assert.deepStrictEqual(fresh.remove([`${LONG_PREFIX}${path.join(dir, 'dot.')}`], { permanent: true }), [`Delete permanently: ${LONG_PREFIX}${path.join(dir, 'dot.')}`]);
});

test('rm은 접두어 없이도 끝이 점인 이름을 거부해, 점을 지운 같은 이름의 다른 파일을 휴지통으로 보내지 않는다 (#129 1차 리뷰)', { skip: !isWindows && 'Windows 이름' }, (t) => {
  const dir = tempDir();
  // If dot. and dot exist together, the Recycle Bin move (PowerShell 5.1) received dot. and deleted dot (measured).
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'dot.')}`, 'DOTTED');
  fs.writeFileSync(path.join(dir, 'dot'), 'PLAIN');
  const { fresh, calls } = fakeRecycle(t, () => undefined);
  for (const dryRun of [true, false]) {
    assert.throws(() => fresh.remove([path.join(dir, 'dot.')], { dryRun }), {
      message: new RegExp(`^It cannot be sent to the Recycle Bin because of a name ending with a dot or space \\(dot\\.\\)\\. .*fctl rename.*--permanent`),
    });
  }
  assert.strictEqual(calls.length, 0);
  // The prefixed path it points to is of the form \\?\D:\... for a drive path and \\?\UNC\server\share\... for a UNC path (second review).
  assert.throws(() => fresh.recycleTarget(path.join(dir, 'dot.')), { message: new RegExp(`\\(${`${LONG_PREFIX}${path.join(dir, 'dot.')}`.replace(/[\\.?$]/g, '\\$&')}\\)\\.`) });
  assert.throws(() => fresh.recycleTarget('\\\\server\\share.\\x'), { message: /\(\\\\\?\\UNC\\server\\share\.\\x\)\./ });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'dot'), 'utf8'), 'PLAIN');
  assert.strictEqual(fs.readFileSync(`${LONG_PREFIX}${path.join(dir, 'dot.')}`, 'utf8'), 'DOTTED');
});

test('rm은 접두어 경로를 Node가 정리한 결과와 뗀 경로가 같을 때만 떼고, 다르면 거부한다 (#129 1차 리뷰)', { skip: !isWindows && 'Windows 경로' }, (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const { fresh, calls } = fakeRecycle(t, () => undefined);
  // If . and .. point to the same place, it sends the normalized path. The slash form (//?/) is the same.
  fresh.remove([`${LONG_PREFIX}${path.join(dir, 'sub')}\\.\\..\\a.txt`]);
  fresh.remove([`//?/${path.join(dir, 'b.txt').replaceAll('\\', '/')}`]);
  assert.deepStrictEqual(calls.map((call) => call.options.env.FC_TARGET), [path.join(dir, 'a.txt'), path.join(dir, 'b.txt')]);
  // If .. escapes up to the drive component, Node resolves to \\?\y and the stripped path to C:\y, so they differ.
  const depth = dir.split(path.sep).length;
  const escape = `${LONG_PREFIX}${dir}${'\\..'.repeat(depth)}\\y`;
  // Such a path usually does not exist, so rm first blocks it with "Path does not exist", so it looks at the check function directly.
  assert.throws(() => fresh.recycleTarget(escape), { message: /^Removing the \\\\\?\\ prefix would point somewhere else, so it cannot be sent to the Recycle Bin: / });
  assert.strictEqual(fresh.recycleTarget(`${LONG_PREFIX}${path.join(dir, 'sub')}\\..\\a.txt`), path.join(dir, 'a.txt'));
  assert.strictEqual(calls.length, 2);
});

test('rm은 앞 대상이 뒤 대상을 품어 이미 지웠으면 예전처럼 없다고 알린다 (#129)', (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'b.txt'), 'b');
  const { fresh } = fakeRecycle(t, () => undefined);
  assert.throws(() => fresh.remove([path.join(dir, 'a'), path.join(dir, 'a', 'b.txt')]), { message: `Path does not exist: ${path.join(dir, 'a', 'b.txt')}` });
  assert.ok(!fs.existsSync(path.join(dir, 'a')));
  // The preview reports that they overlap.
  fs.mkdirSync(path.join(dir, 'c'));
  fs.writeFileSync(path.join(dir, 'c', 'd.txt'), 'd');
  assert.throws(() => fresh.remove([path.join(dir, 'c'), path.join(dir, 'c', 'd.txt')], { dryRun: true }), { message: /Overlaps an earlier item/ });
});

test('rm은 폴더 안의 끝이 점·공백인 이름 때문에 휴지통 이동이 실패하면 바꿀 항목과 접두어 경로를 알린다 (#190)', { skip: !isWindows && 'Windows 이름' }, (t) => {
  const dir = tempDir();
  // A file under a folder ending in a dot: what to change is the folder (dot.).
  fs.mkdirSync(path.join(dir, 'box', 'sub'), { recursive: true });
  fs.mkdirSync(`${LONG_PREFIX}${path.join(dir, 'box', 'sub', 'dot.')}`);
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'box', 'sub', 'dot.', 'a.txt')}`, 'a');
  // A file ending in a space
  fs.mkdirSync(path.join(dir, 'box2'));
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'box2', 'sp ')}`, 's');
  // It emits 77 in the same form as the measured reason text.
  const { fresh } = fakeRecycle(t, () => failed(77, encode('지정한 파일을 찾을 수 없습니다.')));
  const odd = path.join('sub', 'dot.');
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), {
    message: `Could not send to the Recycle Bin. A name ending with a dot or space inside (${odd}) made the whole folder fail: ${path.join(dir, 'box')}. Give fctl rename the \\\\?\\ prefixed path (${LONG_PREFIX}${path.join(dir, 'box', odd)}), rename it, and delete again.`,
  });
  assert.throws(() => fresh.remove([path.join(dir, 'box2')]), { message: /A name ending with a dot or space inside \(sp \)/ });
  // If there is no such name, it reports Windows' reason as before.
  fs.mkdirSync(path.join(dir, 'plain'));
  fs.writeFileSync(path.join(dir, 'plain', 'a.txt'), 'a');
  assert.throws(() => fresh.remove([path.join(dir, 'plain')]), { message: `Could not send to the Recycle Bin: ${path.join(dir, 'plain')} (지정한 파일을 찾을 수 없습니다).` });
});

test('rm은 폴더 안의 259자를 넘는 경로는 미리 거부하지 않는다 (#190)', { skip: !isWindows && 'Windows 경로' }, (t) => {
  // Measured (build 26200): a folder with inner paths of 274 to 377 characters also went to the Recycle Bin, and the long-path files stayed intact inside the Recycle Bin.
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
  // It keeps the premise confirmed on this PC. Even if the failure changes and the folder goes to the Recycle Bin, it is a temporary folder, so no user files are lost.
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box'));
  fs.writeFileSync(path.join(dir, 'box', 'ok.txt'), 'ok');
  fs.writeFileSync(`${LONG_PREFIX}${path.join(dir, 'box', 'dot.')}`, 'x');
  const fresh = reload();
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), { message: /A name ending with a dot or space inside \(dot\.\)/ });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'box', 'ok.txt'), 'utf8'), 'ok');
  assert.ok(fs.existsSync(`${LONG_PREFIX}${path.join(dir, 'box', 'dot.')}`));
});

// #194: it runs the batch Recycle Bin move script with real PowerShell. So as not to touch the user's Recycle Bin, only the Recycle Bin move is changed to permanent deletion (inside a temporary folder).
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
  // Even if it is given the link's own stamp or the target file's stamp, it does not delete.
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
  // A line with only the path of the file to keep and no stamp (3 fields) is not deleted, so that the check of the file to keep is not skipped.
  const b64 = (p) => Buffer.from(p, 'utf16le').toString('base64');
  const output = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', swapped], { input: `${b64(odd)} ${stamp(odd)} ${b64(keep)}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  assert.match(output.trim(), /^error /);
  assert.ok(fs.existsSync(odd));
});

// #236: it looks at the volume's Recycle Bin setting again right before deleting. It does not change the user's settings; it changes only the setting values read for each folder inside a copy of the script.
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
  // It changes the setting by folder name and records, in a file instead of stderr, how many times the setting was read for each folder.
  const reads = p('reads.txt');
  const override = `[IO.File]::AppendAllText('${reads}', $p + "\`n")
  if ($p.EndsWith('nuke')) { $nuke = '1' }
  if ($p.EndsWith('cap')) { $nuke = '0'; $cap = '1' }
  if ($p.EndsWith('removable')) { $type = 'Removable' }
  $root = $p
  return @($type, $nuke, $cap, $root)`;
  const swapped = script
    .replace('  return @($type, $nuke, $cap, $root)', override)
    .replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  assert.ok(swapped.includes('AppendAllText') && swapped.includes('[IO.File]::Delete($long)'), '설정 읽기와 휴지통 이동 호출을 찾아 바꿔야 한다');
  const results = reload().recycleFiles(items, { script: swapped });
  assert.deepStrictEqual(results.map((item) => [path.relative(dir, item.path), item.status, item.reason]), [
    [path.join('ok', 'a.mp4'), 'ok', ''],
    [path.join('ok', 'b.mp4'), 'ok', ''],
    [path.join('nuke', 'a.mp4'), 'permanent', 'because this volume is set to remove files immediately instead of using the Recycle Bin, so it would be permanently deleted'],
    [path.join('cap', 'big.mp4'), 'permanent', 'because it is larger than the Recycle Bin maximum size (1MB), so Windows would permanently delete it without asking'],
    [path.join('cap', 'small.mp4'), 'ok', ''],
    [path.join('removable', 'a.mp4'), 'permanent', 'because the drive (Removable) may have no Recycle Bin and the file could be permanently deleted'],
  ]);
  assert.ok(!fs.existsSync(p('ok', 'a.mp4')) && !fs.existsSync(p('cap', 'small.mp4')));
  assert.ok(fs.existsSync(p('nuke', 'a.mp4')) && fs.existsSync(p('cap', 'big.mp4')) && fs.existsSync(p('removable', 'a.mp4')));
  // The setting is read only once per folder.
  assert.deepStrictEqual(fs.readFileSync(reads, 'utf8').trim().split('\n').map((line) => path.relative(dir, line)), ['ok', 'nuke', 'cap', 'removable']);
});

test('recycleFiles의 PowerShell 스크립트는 같은 볼륨의 다른 폴더에서는 휴지통 설정을 다시 읽지 않는다 (#236 1차 리뷰)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const files = ['a', 'b', 'c'].map((folder) => path.join(dir, folder, 'x.mp4'));
  for (const file of files) {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'x');
  }
  const reads = path.join(dir, 'reads.txt');
  const swapped = reload().RECYCLE_FILES_SCRIPT
    .replace('  return @($type, $nuke, $cap, $root)', `[IO.File]::AppendAllText('${reads}', $p + "\`n")\n  return @($type, $nuke, $cap, $root)`)
    .replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  assert.ok(swapped.includes('AppendAllText') && swapped.includes('[IO.File]::Delete($long)'));
  const results = reload().recycleFiles(files.map((file) => ({ path: file, stamp: fileStamp(fs.lstatSync(file, { bigint: true })) })), { script: swapped });
  assert.deepStrictEqual(results.map((item) => item.status), ['ok', 'ok', 'ok']);
  assert.deepStrictEqual(fs.readFileSync(reads, 'utf8').trim().split('\n').map((line) => path.relative(dir, line)), ['a']);
});

test('recycleFiles의 PowerShell 스크립트는 휴지통 최대 크기를 모르면 1GB 이상 파일을 지우지 않는다 (#236)', { skip: !isWindows && 'PowerShell' }, () => {
  const { fileStamp } = require('../src/target');
  const dir = tempDir();
  const file = path.join(dir, 'a.mp4');
  fs.writeFileSync(file, 'a');
  // Instead of changing the size, it takes the same judgment line with a copy that lowered the standard (1GB - 1) to 0.
  const script = reload().RECYCLE_FILES_SCRIPT;
  const swapped = script
    .replace('  return @($type, $nuke, $cap, $root)', "  return @($type, $nuke, '', $root)")
    .replace('{ 1GB - 1 }', '{ 0 }')
    .replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", '[IO.File]::Delete($long)');
  assert.ok(swapped.includes("@($type, $nuke, '', $root)") && swapped.includes('{ 0 }'));
  const [result] = reload().recycleFiles([{ path: file, stamp: fileStamp(fs.lstatSync(file, { bigint: true })) }], { script: swapped });
  assert.deepStrictEqual([result.status, result.reason], ['permanent', 'because it is 1GB or larger and the Recycle Bin maximum size could not be checked, so it could be permanently deleted']);
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
  // It makes only a.mp4 fail with a Windows-style reason (a localized Korean message).
  const swapped = script.replace("[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')", "if ($p.EndsWith('a.mp4')) { throw [IO.IOException]::new('사용 중입니다.') }; [IO.File]::Delete($long)");
  assert.notStrictEqual(swapped, script);
  const results = reload().recycleFiles(items, { script: swapped });
  assert.deepStrictEqual(results.map((item) => [path.basename(item.path), item.status, item.reason]), [
    ['a.mp4', 'error', '사용 중입니다'],
    ['b.mp4', 'ok', ''],
  ]);
  assert.ok(fs.existsSync(a) && !fs.existsSync(b));
});

// #81: a target that would be deleted permanently is refused before deleting. It swaps the volume setting check (FC_VOLUME) and the Recycle Bin move (FC_TARGET) for fakes.
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
  ['remove immediately', 'True|Fixed|1|26427\r\n', /It was not deleted because this volume is set to remove files immediately instead of using the Recycle Bin, so it would be permanently deleted\./],
  ['over max size', 'True|Fixed|0|0\r\n', /It was not deleted because it is larger than the Recycle Bin maximum size \(0MB\), so Windows would permanently delete it without asking\./],
  ['removable drive', 'True|Removable|0|26427\r\n', /because the drive \(Removable\) may have no Recycle Bin and the file could be permanently deleted/],
  ['network drive', 'True|Network||\r\n', /because the drive \(Network\) may have no Recycle Bin/],
  ['unknown type', 'True|Unknown||\r\n', /because the drive type could not be checked, so it is unknown whether a Recycle Bin exists/],
  ['check failed', '뜻밖의 출력', /drive type could not be checked/],
]) {
  test(`rm은 휴지통을 거치지 않고 영구 삭제될 대상이면 미리보기에서도, 여러 대상이면 아무것도 지우기 전에 거부한다 (#81): ${name}`, { skip: !isWindows && 'Windows 휴지통' }, (t) => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    const { fresh, calls } = fakeVolume(t, (volume) => (volume.endsWith('b.txt') ? answer : 'True|Fixed|0|26427\r\n'));
    for (const dryRun of [true, false]) {
      assert.throws(() => fresh.remove([path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], { dryRun, permanentHint: true }), (err) => {
        assert.ok(err instanceof fresh.FcError);
        assert.ok(err.message.startsWith(`Not sent to the Recycle Bin: ${path.join(dir, 'b.txt')}. `), err.message);
        assert.match(err.message, pattern);
        assert.match(err.message, / To delete without the Recycle Bin, use --permanent\.$/);
        return true;
      });
    }
    // If a command that does not accept --permanent (extract-all, collapse) calls it, that hint is not attached (first review).
    assert.throws(() => fresh.remove([path.join(dir, 'b.txt')]), (err) => /It was not deleted .*\.$/.test(err.message) && !err.message.includes('--permanent'));
    assert.deepStrictEqual(calls, []);
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt')));
    // --permanent does not go through the Recycle Bin, so it does not run this check.
    fresh.remove([path.join(dir, 'b.txt')], { permanent: true });
    assert.ok(!fs.existsSync(path.join(dir, 'b.txt')));
  });
}

test('rm은 폴더면 안의 파일 합계로 최대 크기를 보고, 크기 안이면 그대로 보낸다 (#81)', { skip: !isWindows && 'Windows 휴지통' }, (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'box', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'box', 'a.bin'), Buffer.alloc(700 * 1024));
  fs.writeFileSync(path.join(dir, 'box', 'sub', 'b.bin'), Buffer.alloc(700 * 1024));
  // Maximum size 1MB: one file (700KB) is fine and the total (1400KB) exceeds it.
  const { fresh, calls } = fakeVolume(t, 'True|Fixed|0|1\r\n');
  assert.throws(() => fresh.remove([path.join(dir, 'box')]), /larger than the Recycle Bin maximum size \(1MB\)/);
  fresh.remove([path.join(dir, 'box', 'a.bin')]);
  assert.deepStrictEqual(calls, [path.join(dir, 'box', 'a.bin')]);
  // After sending a.bin, the remaining total (700KB) is within the maximum size.
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
  assert.match(fresh.previewRefusal(path.join(dir, 'big')), /larger than the Recycle Bin maximum size \(1MB\)/);
});

test('휴지통 이동 스크립트의 78 표시가 비었거나 알 수 없으면 크기를 확인하지 못한 것으로 거부한다 (#81)', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { fresh } = fakeRecycle(t, () => failed(78, ''));
  assert.throws(() => fresh.remove([path.join(dir, 'a.txt')], { checkVolume: false }), /because the size could not be checked, so it is unknown whether it exceeds the Recycle Bin maximum size\.$/);
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
  // Swapping the same function several times to fakes would not restore it after the test, so it swaps only once and changes only the marker to report.
  let mark;
  const { fresh } = fakeRecycle(t, () => failed(78, encode(mark)));
  for (const [next, pattern] of [
    ['nuke', /set to remove files immediately/],
    ['cap|7164', /larger than the Recycle Bin maximum size \(7164MB\)/],
    ['unknown', /1GB or larger and the Recycle Bin maximum size could not be checked/],
    ['type|Removable', /drive \(Removable\)/],
    ['type|Unknown', /drive type could not be checked/],
    ['size', /size could not be checked, so it is unknown whether it exceeds the Recycle Bin maximum size/],
  ]) {
    mark = next;
    assert.throws(() => fresh.remove([path.join(dir, 'a.txt')], { checkVolume: false }), (err) => err instanceof fresh.FcError && pattern.test(err.message) && err.message.startsWith('Not sent to the Recycle Bin: '), mark);
  }
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
});

// It runs the check right before deleting with real PowerShell. It does not change the user's settings and changes setting values only inside a copy of the script, and it makes the Recycle Bin move not happen.
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
  // What is beyond a junction (2MB) is not counted, so it is within the maximum size of 1MB.
  assert.deepStrictEqual(run(path.join(dir, 'box'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 0, out: 'deleted-dir' });
  assert.deepStrictEqual(run(path.join(dir, 'big'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 78, out: 'cap|1' });
  assert.deepStrictEqual(run(path.join(dir, 'big', 'x.bin'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 78, out: 'cap|1' });
  assert.deepStrictEqual(run(path.join(dir, 'box', 'a.bin'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 0, out: 'deleted-file' });
  assert.deepStrictEqual(run(path.join(dir, 'box', 'a.bin'), "$type = 'Fixed'; $nuke = '1'; $cap = '26427'"), { status: 78, out: 'nuke' });
  assert.deepStrictEqual(run(path.join(dir, 'box', 'a.bin'), "$type = 'Removable'"), { status: 78, out: 'type|Removable' });
  assert.deepStrictEqual(run(path.join(dir, 'big'), "$type = 'Fixed'; $nuke = ''; $cap = ''"), { status: 0, out: 'deleted-dir' });
  // Even if the target itself is a junction, what is beyond it is not counted (first review). The same as sizeUpTo of Node.
  assert.deepStrictEqual(run(path.join(dir, 'box', 'j'), "$type = 'Fixed'; $nuke = '0'; $cap = '1'"), { status: 0, out: 'deleted-dir' });
  // The volume setting part reads the real values (unless changed inside the copy).
  const state = run(path.join(dir, 'box', 'a.bin'), '');
  assert.ok(state.status === 0 || state.status === 78, JSON.stringify(state));
  assert.ok(fs.existsSync(path.join(dir, 'box', 'a.bin')) && fs.existsSync(path.join(dir, 'big', 'x.bin')));
});
