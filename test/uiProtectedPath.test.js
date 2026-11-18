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
const { protectedPathReason, refuseProtected } = require('../src/ui/protectedPath');

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
