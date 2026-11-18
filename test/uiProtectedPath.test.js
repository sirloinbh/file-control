'use strict';

// The shared protected-place check of the UI path fields (#290): the typed path and every real path it can lead to (junctions, symbolic links,
// dangling links, short names), and a refusal when the real path cannot be checked.
// The temp folder is under the real user folder (AppData), a protected place, so os.homedir is swapped with a fake home made in a temp folder.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');
let currentHome = FAKE_HOME;
test.mock.method(os, 'homedir', () => currentHome);

const { FcError } = require('../src/commands');
const { protectedPathReason, refuseProtected, plainTarget } = require('../src/ui/protectedPath');

function makeHome(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-protected-path-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(base, 'ok'));
  currentHome = home;
  t.after(() => { currentHome = FAKE_HOME; });
  return { base, home, ssh: path.join(home, '.ssh'), ok: path.join(base, 'ok') };
}

// A file symbolic link needs the symlink privilege (or Developer Mode). Without it the test is skipped.
function fileSymlinkOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    t.skip('creating a file symbolic link needs the symlink privilege');
    return false;
  }
}

test('a plain path, existing or not, is allowed; a hidden settings folder and the user folder are refused', (t) => {
  const { home, ssh, ok } = makeHome(t);
  assert.strictEqual(protectedPathReason(ok), null);
  assert.strictEqual(protectedPathReason(path.join(ok, 'new', 'deeper', 'file.txt')), null);
  assert.match(protectedPathReason(path.join(ssh, 'x')), /user settings folder/);
  assert.match(protectedPathReason(home), /contains user folder/);
  assert.strictEqual(refuseProtected(ok, 'The folder'), ok);
  assert.throws(() => refuseProtected(path.join(ssh, 'x'), 'The folder'), (err) => err instanceof FcError && /The folder is a protected place/.test(err.message));
});

test('a junction into a protected place is refused, also for a path below it that does not exist yet', (t) => {
  const { base, ssh } = makeHome(t);
  const link = path.join(base, 'link');
  fs.symlinkSync(ssh, link, 'junction');
  assert.match(protectedPathReason(link), /user settings folder/);
  assert.match(protectedPathReason(path.join(link, 'new', 'deeper')), /user settings folder/);
});

test('a dangling junction whose target would be created inside a protected place is refused', (t) => {
  const { base, ssh } = makeHome(t);
  const link = path.join(base, 'dang');
  fs.symlinkSync(path.join(ssh, 'newdir'), link, 'junction');
  assert.throws(() => fs.realpathSync.native(link), { code: 'ENOENT' });
  assert.match(protectedPathReason(link), /user settings folder/);
  assert.match(protectedPathReason(path.join(link, 'x.txt')), /user settings folder/);
});

test('a dangling file symbolic link ok\\dang -> <home>\\.ssh\\newfile is refused, with an absolute or a relative target', (t) => {
  const { base, ssh, ok } = makeHome(t);
  const dang = path.join(ok, 'dang');
  if (!fileSymlinkOrSkip(t, path.join(ssh, 'newfile'), dang)) return;
  assert.match(protectedPathReason(dang), /user settings folder/);
  // A relative target is read from the link's own folder.
  const relative = path.join(ok, 'rel');
  fs.symlinkSync(path.join('..', 'home', '.ssh', 'newfile'), relative, 'file');
  assert.match(protectedPathReason(relative), /user settings folder/);
  // A dangling link to a plain place is fine.
  const plain = path.join(ok, 'plain');
  fs.symlinkSync(path.join(base, 'ok', 'later.txt'), plain, 'file');
  assert.strictEqual(protectedPathReason(plain), null);
});

// The volume GUID path (\\?\Volume{...}\) of the drive p is on, or null if mountvol cannot tell.
function volumeGuidOf(p) {
  try {
    const out = require('node:child_process').execFileSync('mountvol', [path.parse(p).root, '/L'], { encoding: 'utf8', windowsHide: true });
    return /\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\/.exec(out)?.[0] ?? null;
  } catch {
    return null;
  }
}

test('a dangling link to a UNC, \\\\?\\UNC\\, volume GUID or device path is refused, even when it leads into a protected place (#290)', (t) => {
  const { ssh, ok } = makeHome(t);
  const drive = ssh.slice(0, 1);
  const tail = ssh.slice(3);
  const targets = [
    `\\\\localhost\\${drive}$\\${tail}\\x`,
    `\\\\?\\UNC\\localhost\\${drive}$\\${tail}\\x`,
  ];
  // fs.symlinkSync rewrites \\.\C:\x to C:\x and resolves a drive-relative C:x against the current folder, so those forms are tested on
  // plainTarget directly below. Node stores a \??\Volume{...} target as <current drive>:\??\Volume{...}, which is refused for its ?.
  const guid = volumeGuidOf(ssh);
  if (guid) targets.push(`${guid}${tail}\\x`, `\\??\\${guid.slice(4)}${tail}\\x`);
  let made = 0;
  for (const [i, target] of targets.entries()) {
    const link = path.join(ok, `l${i}`);
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('creating a file symbolic link needs the symlink privilege');
        return;
      }
      throw err;
    }
    made += 1;
    assert.match(protectedPathReason(link) ?? 'allowed', /could not be checked|user settings folder/, target);
    assert.match(protectedPathReason(path.join(link, 'below')) ?? 'allowed', /could not be checked|user settings folder/, target);
  }
  assert.ok(made >= 2);
});

test('plainTarget accepts only a relative target or a plain drive path (#290)', () => {
  const guid = '\\??\\Volume{0377c98a-9bae-450c-8c95-55ab3c756868}';
  for (const target of ['C:x', '\\x', '/x', '\\\\.\\C:\\x', '\\\\?\\UNC\\h\\s\\x', '\\\\h\\s\\x', `${guid}\\x`, `\\\\?\\${guid.slice(4)}\\x`, `C:${guid}\\x`, 'C:\\a:stream', 'a*b']) {
    assert.throws(() => plainTarget(target), /a link points to a path that cannot be checked/, target);
  }
  assert.strictEqual(plainTarget('..\\a'), '..\\a');
  assert.strictEqual(plainTarget('C:\\a'), 'C:\\a');
  assert.strictEqual(plainTarget('c:/a'), 'c:/a');
  assert.strictEqual(plainTarget('\\\\?\\C:\\a'), 'C:\\a');
  assert.strictEqual(plainTarget('\\??\\D:\\a'), 'D:\\a');
});

test('a very long path is refused without walking it (#290)', (t) => {
  const { ok } = makeHome(t);
  const deep = path.join(ok, ...Array.from({ length: 1500 }, () => 'a'));
  const started = Date.now();
  assert.match(protectedPathReason(deep), /too long/);
  assert.match(protectedPathReason(path.join(ok, 'x'.repeat(33000))), /too long/);
  assert.ok(Date.now() - started < 2000);
  assert.strictEqual(protectedPathReason(path.join(ok, ...Array.from({ length: 200 }, () => 'a'))), null);
});

test('a chain of dangling links is followed to its end, and a link loop is refused', (t) => {
  const { base, ssh } = makeHome(t);
  // first -> second (a junction to a folder that does not exist) -> .ssh\newdir.
  const second = path.join(base, 'second');
  fs.symlinkSync(path.join(ssh, 'newdir'), second, 'junction');
  const first = path.join(base, 'first');
  fs.symlinkSync(path.join(second, 'sub'), first, 'junction');
  assert.match(protectedPathReason(path.join(first, 'x')), /user settings folder/);
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  fs.symlinkSync(b, a, 'junction');
  fs.symlinkSync(a, b, 'junction');
  assert.match(protectedPathReason(path.join(a, 'x')), /could not be checked/);
});

test('the check fails closed: an error other than ENOENT or ENOTDIR refuses the path', (t) => {
  const { ok } = makeHome(t);
  const denied = (code) => () => { throw Object.assign(new Error(`${code}: denied`), { code }); };
  const realpath = t.mock.method(fs.realpathSync, 'native', denied('EACCES'));
  assert.match(protectedPathReason(path.join(ok, 'x')), /could not be checked: EACCES/);
  assert.throws(() => refuseProtected(path.join(ok, 'x'), 'The archive'), /The archive is a protected place or cannot be checked/);
  realpath.mock.restore();

  // realpath stops at ok\missing, and lstat of it fails with EPERM.
  const lstat = t.mock.method(fs, 'lstatSync', denied('EPERM'));
  assert.match(protectedPathReason(path.join(ok, 'missing', 'x')), /could not be checked: EPERM/);
  lstat.mock.restore();
  assert.strictEqual(protectedPathReason(path.join(ok, 'missing', 'x')), null);
});

test('an 8.3 short name of a protected folder is refused', { skip: !fs.existsSync('C:\\PROGRA~1') }, () => {
  assert.match(protectedPathReason('C:\\PROGRA~1'), /system folder/);
  assert.match(protectedPathReason('C:\\PROGRA~1\\new\\x.zip'), /system folder/);
});
