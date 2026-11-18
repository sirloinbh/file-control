'use strict';

// #291: the guard that npm test loads (test/noRealRecycle.js) must stop any call that would use the real Recycle Bin.
// These tests point the guard's log at their own file while they run, so the blocked calls they make on purpose do not fail the whole run.

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { RealRecycleBinError } = require('./noRealRecycle');

const optedOut = process.env.FC_TEST_REAL_RECYCLE === '1' && 'FC_TEST_REAL_RECYCLE=1 turns the guard off';

function ownLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-guard-'));
  const log = path.join(dir, 'blocked.log');
  const saved = process.env.FC_NO_REAL_RECYCLE_LOG;
  process.env.FC_NO_REAL_RECYCLE_LOG = log;
  t.after(() => {
    if (saved === undefined) delete process.env.FC_NO_REAL_RECYCLE_LOG;
    else process.env.FC_NO_REAL_RECYCLE_LOG = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
}

// Scripts are never run: the guard throws before a process starts. The file they name does not exist.
const missing = path.join(os.tmpdir(), 'fc-guard-no-such-file.txt');
const scripts = [
  `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${missing}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
  `(New-Object -ComObject Shell.Application).NameSpace(10).Items().Count`,
];

test('npm test runs with the guard loaded, and child Node processes load it too', () => {
  assert.ok(childProcess[Symbol.for('file-control.noRealRecycle')], 'the guard is installed in this process');
  assert.match(process.env.NODE_OPTIONS ?? '', /noRealRecycle\.js/);
  const child = childProcess.execFileSync(process.execPath, ['-e', "process.stdout.write(String(Boolean(require('node:child_process')[Symbol.for('file-control.noRealRecycle')])))"], { encoding: 'utf8' });
  assert.strictEqual(child, 'true');
});

test('the guard throws for a real Recycle Bin script in every child_process function and records it', { skip: optedOut }, async (t) => {
  const blocked = ownLog(t);
  for (const script of scripts) {
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    assert.throws(() => childProcess.execFileSync('powershell.exe', args, { env: { ...process.env, FC_TARGET: missing } }), RealRecycleBinError);
    assert.throws(() => childProcess.spawnSync('powershell.exe', args), RealRecycleBinError);
    assert.throws(() => childProcess.spawn('powershell.exe', args), RealRecycleBinError);
    assert.throws(() => childProcess.execFile('powershell.exe', args, () => {}), RealRecycleBinError);
    assert.throws(() => childProcess.execSync(`powershell.exe -Command "${script}"`), RealRecycleBinError);
    assert.throws(() => childProcess.exec(`powershell.exe -Command "${script}"`, () => {}), RealRecycleBinError);
    await assert.rejects(() => util.promisify(childProcess.execFile)('powershell.exe', args), RealRecycleBinError);
  }
  // A Recycle Bin script passed on standard input is caught too.
  assert.throws(() => childProcess.execFileSync('powershell.exe', ['-Command', '-'], { input: scripts[0] }), RealRecycleBinError);
  assert.match(blocked(), /noRealRecycle: a test tried to use the real Recycle Bin \(execFileSync, SendToRecycleBin\)/);
});

test('the guard also stops the real script that src/commands.js sends when a test has not faked it', { skip: optedOut }, (t) => {
  const blocked = ownLog(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'keep.txt');
  fs.writeFileSync(file, 'x');
  const { RECYCLE_SCRIPT } = require('../src/commands');
  assert.throws(() => childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], { env: { ...process.env, FC_TARGET: file } }), RealRecycleBinError);
  assert.ok(fs.existsSync(file), 'the file was not sent anywhere');
  assert.match(blocked(), /SendToRecycleBin/);
});

test('ordinary PowerShell calls and the read-only Recycle Bin state check pass through', { skip: process.platform !== 'win32' }, (t) => {
  const blocked = ownLog(t);
  const out = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "'fine'"], { encoding: 'utf8' });
  assert.strictEqual(out.trim(), 'fine');
  const { recycleBinState } = require('../src/commands');
  assert.notStrictEqual(recycleBinState(os.tmpdir()).driveType, null, 'the real state check (FC_VOLUME) ran');
  assert.strictEqual(blocked(), '');
});

test('a run fails with exit 1 when a test swallows the guard error, so a blocked call cannot pass silently', { skip: optedOut }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-guard-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'swallow.test.js');
  // The fixture's call is blocked before PowerShell starts, and the test catches the error and passes anyway.
  fs.writeFileSync(fixture, [
    "const test = require('node:test');",
    "const childProcess = require('node:child_process');",
    "test('swallows', () => {",
    "  try { childProcess.execFileSync('powershell.exe', ['-NoProfile', '-Command', '$x.SendToRecycleBin']); } catch {}",
    '});',
    '',
  ].join('\n'));
  // A fresh run: no log from this run, so the child run owns its own log like npm test does.
  const env = { ...process.env };
  delete env.FC_NO_REAL_RECYCLE_LOG;
  delete env.NODE_TEST_CONTEXT; // otherwise node --test sees a recursive run and skips the file
  const run = childProcess.spawnSync(process.execPath, ['--require', path.join(__dirname, 'noRealRecycle.js'), '--test', fixture], { env, encoding: 'utf8', timeout: 60_000 });
  assert.strictEqual(run.status, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stderr, /calls to the real Recycle Bin were blocked/);
  assert.match(run.stdout, /pass 1/, "the test itself passed");
});
