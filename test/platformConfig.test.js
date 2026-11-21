'use strict';

// The platform values are read through config at call time, so a test sets them without reloading modules (#362).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const base = require('../src/base');
const fc = require('../src/commands');
const { withConfig } = require('./withConfig');

test('withConfig sets the values for one test and restores them after it', async (t) => {
  const before = { ...base.config };
  await t.test('inside', (inner) => {
    withConfig(inner, { isWindows: !before.isWindows, tar: 'fake-tar' });
    assert.strictEqual(base.config.isWindows, !before.isWindows);
    assert.strictEqual(base.config.tar, 'fake-tar');
  });
  assert.deepStrictEqual({ ...base.config }, before);
});

test('rm on a non-Windows platform refuses the Recycle Bin and says to use --permanent', (t) => {
  withConfig(t, { isWindows: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-plat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => fc.remove([file]), /works only on Windows.*--permanent/);
  assert.ok(fs.existsSync(file));
});

test('paths compare case-sensitively when the platform is not Windows, and case-insensitively when it is', (t) => {
  withConfig(t, { isWindows: false });
  assert.notStrictEqual(base.pathKey(path.resolve('/Tmp/A')), base.pathKey(path.resolve('/tmp/a')));
  withConfig(t, { isWindows: true });
  assert.strictEqual(base.pathKey(path.resolve('/Tmp/A')), base.pathKey(path.resolve('/tmp/a')));
});

test('the tar program comes from config.tar, and unzip runs it from its own folder on Windows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-plat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'a.tar');
  fs.writeFileSync(archive, '');
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (path.basename(file) === 'powershell.exe') return '';
    calls.push({ file, args, cwd: options.cwd });
    return '';
  });
  withConfig(t, { isWindows: true, tar: path.join('X:', 'tools', 'faketar.exe') });
  try {
    fc.archiveEntries(archive);
  } catch {
    // the fake prints nothing; only the call matters
  }
  assert.ok(calls.length > 0);
  assert.strictEqual(calls[0].file, path.join('X:', 'tools', 'faketar.exe'));
  assert.strictEqual(calls[0].cwd, path.join('X:', 'tools'));
  assert.ok(calls[0].args.includes('--passphrase'));
});
