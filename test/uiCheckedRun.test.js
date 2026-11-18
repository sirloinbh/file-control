'use strict';

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// Keep test files out of the real Recycle Bin (same approach as removeBroken.test.js). It is swapped before commands.js is imported.
const { fakeRecycleFolders } = require('./fakeRecycleFiles');

const realExecFileSync = childProcess.execFileSync;
const recycled = [];
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) return 'NTFS\r\n';
  if (options?.env?.FC_VOLUME !== undefined) return 'True|Fixed\r\n';
  if (options?.env?.FC_BATCH !== undefined) return fakeRecycleFolders(options);
  if (options?.env?.FC_RECYCLE_FILES !== undefined) {
    const lines = [];
    for (const line of options.input.split('\n').filter(Boolean)) {
      const [encoded] = line.split(' ');
      const target = Buffer.from(encoded, 'base64').toString('utf16le');
      recycled.push(target);
      fs.rmSync(target);
      lines.push(`ok ${encoded} `);
    }
    return lines.join('\r\n') + '\r\n';
  }
  if (options?.env?.FC_TARGET === undefined) return realExecFileSync(file, args, options);
  recycled.push(options.env.FC_TARGET);
  fs.rmSync(options.env.FC_TARGET, { recursive: true, force: true });
  return Buffer.alloc(0);
});

// Files made just now are protected from removal, so the clock is moved forward 1 hour.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
test.mock.method(Date, 'now', () => realNow() + HOUR);

const { execute } = require('../src/execute');
const fc = require('../src/commands');
const { previewFingerprint, runChecked, stripFlow } = require('../src/ui/checkedRun');
const { runOnce } = require('../src/ui/worker');
const { snapshotSource, sourcePaths } = require('../src/ui/sourceSnapshot');

const OLD = new Date(realNow() - HOUR);
const BROKEN = '<html>not found</html>';
const HEX64 = /^[0-9a-f]{64}$/;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-checked-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, OLD, OLD);
  }
}

test.beforeEach(() => {
  recycled.length = 0;
});

const fp = (argv) => runChecked(argv, { mode: 'preview' }, { execute }).fingerprint;

// ---- unit tests with a fake execute ----

function fakeExecute(results) {
  const calls = [];
  const fn = (argv) => {
    calls.push(argv);
    const dry = argv.includes('--dry-run');
    return { command: argv[0], result: dry ? results.shift() ?? results.at(-1) : { changed: true }, report: dry ? 'preview' : 'done' };
  };
  fn.calls = calls;
  return fn;
}

test('preview mode runs argv with --dry-run once and adds a 64-hex fingerprint', () => {
  const exec = fakeExecute([{ code: 'abc', items: [1] }]);
  const outcome = runChecked(['mv', 'a', 'b'], { mode: 'preview' }, { execute: exec });
  assert.deepStrictEqual(exec.calls, [['mv', 'a', 'b', '--dry-run']]);
  assert.match(outcome.fingerprint, HEX64);
  assert.strictEqual(outcome.ran, undefined);
  assert.strictEqual(outcome.repreview, undefined);
});

test('preview mode strips a user-supplied --dry-run and --yes and keeps -- in place', () => {
  const exec = fakeExecute([{}]);
  runChecked(['rm', '--dry-run', '--yes=abc', '--yes', '--', '--odd'], { mode: 'preview' }, { execute: exec });
  assert.deepStrictEqual(exec.calls, [['rm', '--dry-run', '--', '--odd']]);
  assert.deepStrictEqual(stripFlow(['rm', '--yes=1', 'x', '--', '--yes=2']), ['rm', 'x', '--', '--yes=2']);
});

test('the fingerprint depends on the argv and on the preview result but not on --dry-run or --yes', () => {
  const outcome = { command: 'mv', result: ['a'] };
  const base = previewFingerprint(['mv', 'a', 'b'], outcome);
  assert.strictEqual(previewFingerprint(['mv', 'a', 'b', '--dry-run'], outcome), base);
  assert.strictEqual(previewFingerprint(['mv', 'a', 'b', '--yes=1'], outcome), base);
  assert.notStrictEqual(previewFingerprint(['mv', 'a', 'c'], outcome), base);
  assert.notStrictEqual(previewFingerprint(['mv', 'a', 'b'], { ...outcome, result: ['a', 'b'] }), base);
});

test('run mode with a matching fingerprint runs for real and marks ran', () => {
  const first = runChecked(['mv', 'a', 'b'], { mode: 'preview' }, { execute: fakeExecute([{ n: 1 }]) });
  const exec = fakeExecute([{ n: 1 }]);
  const outcome = runChecked(['mv', 'a', 'b'], { mode: 'run', expect: first.fingerprint }, { execute: exec });
  assert.deepStrictEqual(exec.calls, [['mv', 'a', 'b', '--dry-run'], ['mv', 'a', 'b']]);
  assert.strictEqual(outcome.ran, true);
  assert.deepStrictEqual(outcome.result, { changed: true });
});

test('run mode with a stale fingerprint changes nothing and returns the fresh preview with repreview', () => {
  const first = runChecked(['mv', 'a', 'b'], { mode: 'preview' }, { execute: fakeExecute([{ n: 1 }]) });
  const exec = fakeExecute([{ n: 2 }]);
  const outcome = runChecked(['mv', 'a', 'b'], { mode: 'run', expect: first.fingerprint }, { execute: exec });
  assert.deepStrictEqual(exec.calls, [['mv', 'a', 'b', '--dry-run']]);
  assert.strictEqual(outcome.repreview, true);
  assert.strictEqual(outcome.ran, undefined);
  assert.deepStrictEqual(outcome.result, { n: 2 });
  assert.match(outcome.fingerprint, HEX64);
  assert.notStrictEqual(outcome.fingerprint, first.fingerprint);
});

test('run mode rejects a missing or invalid fingerprint before running anything', () => {
  for (const expect of [undefined, '', 'abc', 'G'.repeat(64), 'a'.repeat(63), 42]) {
    const exec = fakeExecute([{}]);
    assert.throws(() => runChecked(['mv', 'a', 'b'], { mode: 'run', expect }, { execute: exec }), fc.FcError);
    assert.deepStrictEqual(exec.calls, []);
  }
  assert.throws(() => runChecked(['mv', 'a', 'b'], { mode: 'nope' }, { execute: fakeExecute([{}]) }), fc.FcError);
});

test('run mode never passes a user-supplied --dry-run or --yes to the real run, and remove-* get the fresh code', () => {
  const argv = ['remove-broken', 'dir', '--yes=stale', '--dry-run'];
  const preview = runChecked(argv, { mode: 'preview' }, { execute: fakeExecute([{ code: 'fresh1234567' }]) });
  const exec = fakeExecute([{ code: 'fresh1234567' }]);
  runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute: exec });
  assert.deepStrictEqual(exec.calls, [['remove-broken', 'dir', '--dry-run'], ['remove-broken', 'dir', '--yes=fresh1234567']]);
  // other commands do not get --yes
  const mv = runChecked(['mv', 'a', 'b', '--yes=x'], { mode: 'preview' }, { execute: fakeExecute([{}]) });
  const exec2 = fakeExecute([{}]);
  runChecked(['mv', 'a', 'b', '--yes=x'], { mode: 'run', expect: mv.fingerprint }, { execute: exec2 });
  assert.deepStrictEqual(exec2.calls[1], ['mv', 'a', 'b']);
});

test('runOnce without mode runs the command as before, with mode it uses the checked flow', () => {
  const sent = [];
  const calls = [];
  const executeFn = (argv) => {
    calls.push(argv);
    return { command: argv[0], result: ['x'], report: 'r' };
  };
  runOnce(['mv', 'a', 'b'], (msg) => sent.push(msg), { executeFn });
  assert.deepStrictEqual(calls, [['mv', 'a', 'b']]);
  assert.strictEqual(sent.at(-1).type, 'done');
  calls.length = 0;
  runOnce(['mv', 'a', 'b'], (msg) => sent.push(msg), { mode: 'preview', executeFn });
  assert.deepStrictEqual(calls, [['mv', 'a', 'b', '--dry-run']]);
  assert.match(sent.at(-1).outcome.fingerprint, HEX64);
  runOnce(['mv', 'a', 'b'], (msg) => sent.push(msg), { mode: 'run', expect: 'bad', executeFn });
  assert.strictEqual(sent.at(-1).type, 'error');
});

// ---- empirical volatility: two dry-runs of an unchanged folder give the same fingerprint, a changed folder does not ----

function scene() {
  const dir = tempDir();
  make(dir, {
    'a/b/one.txt': '1',
    'a/two.txt': '2',
    'src.txt': 's',
    'dup/a.txt': 'a',
    'dup/b/a.txt': 'b',
    'page.html': '<html>x</html>',
    'arch/x.txt': 'x',
    'broken/bad.mp4': BROKEN,
  });
  return dir;
}

test('every file-changing command has a stable fingerprint on an unchanged folder', () => {
  const dir = scene();
  const p = (...parts) => path.join(dir, ...parts);
  const cases = [
    ['mkdir', p('newdir')],
    ['write', p('w.txt'), 'hi'],
    ['append', p('src.txt'), 'hi'],
    ['rename', p('src.txt'), 'r.txt'],
    ['mv', p('a', 'two.txt'), p('dup')],
    ['cp', p('src.txt'), p('cp.txt')],
    ['rm', p('src.txt')],
    ['zip', p('z.zip'), p('a')],
    ['flatten', p('a')],
    ['product-number', dir],
    ['normalize', dir],
    ['collapse', dir],
    ['extract-all', p('arch')],
    ['remove-broken', dir],
    ['remove-duplicates', dir],
    ['remove-low-quality', dir],
  ];
  for (const argv of cases) assert.strictEqual(fp(argv), fp(argv), argv[0]);
  assert.deepStrictEqual(recycled, []);
});

test('flatten and remove-broken fingerprints change when the folder changes; mv and rm follow their sources', () => {
  const dir = scene();
  const p = (...parts) => path.join(dir, ...parts);
  const cases = {
    mv: ['mv', p('dup', 'a.txt'), p('a')],
    rm: ['rm', p('dup')],
    flatten: ['flatten', p('a')],
    'remove-broken': ['remove-broken', dir],
  };
  const before = Object.fromEntries(Object.entries(cases).map(([name, argv]) => [name, fp(argv)]));
  // flatten and remove-broken scan their folders.
  make(dir, { 'dup/new.txt': 'n', 'a/b/deep/three.txt': '3', 'more/bad2.mp4': BROKEN + ' too' });
  for (const name of ['flatten', 'remove-broken']) assert.notStrictEqual(fp(cases[name]), before[name], name);
  // mv names a file source, so an unrelated change leaves it alone; rm names a folder, and its snapshot (#280) follows what the folder holds. A missing source is an error.
  assert.strictEqual(fp(cases.mv), before.mv);
  assert.notStrictEqual(fp(cases.rm), before.rm);
  fs.rmSync(p('dup'), { recursive: true });
  assert.throws(() => fp(cases.mv), fc.FcError);
  assert.throws(() => fp(cases.rm), fc.FcError);
});

// ---- real files ----

test('real run (mv): a stale fingerprint changes nothing, a matching one moves the file', () => {
  const dir = tempDir();
  make(dir, { 'one.txt': '1', 'dest/keep.txt': 'k' });
  const argv = ['mv', path.join(dir, 'one.txt'), path.join(dir, 'dest')];
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.ok(fs.existsSync(path.join(dir, 'one.txt')), 'a preview does not move');
  const stale = runChecked(argv, { mode: 'run', expect: 'f'.repeat(64) }, { execute });
  assert.strictEqual(stale.repreview, true);
  assert.ok(fs.existsSync(path.join(dir, 'one.txt')), 'a stale run does not move');
  assert.strictEqual(stale.fingerprint, preview.fingerprint);
  const ran = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
  assert.strictEqual(ran.ran, true);
  assert.ok(!fs.existsSync(path.join(dir, 'one.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'dest', 'one.txt')));
});

test('real run (flatten): a folder that changed after the preview is not flattened', () => {
  const dir = tempDir();
  make(dir, { 'a/b/one.txt': '1' });
  const argv = ['flatten', path.join(dir, 'a')];
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  make(dir, { 'a/c/two.txt': '2' });
  const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
  assert.strictEqual(outcome.repreview, true);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'one.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'a', 'c', 'two.txt')));
  const again = runChecked(argv, { mode: 'run', expect: outcome.fingerprint }, { execute });
  assert.strictEqual(again.ran, true);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'one.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'a', 'two.txt')));
});

test('real run (remove-broken): files go to the Recycle Bin only with a matching fingerprint', () => {
  const dir = tempDir();
  make(dir, { 'bad.mp4': BROKEN, 'good.txt': 'fine text' });
  const argv = ['remove-broken', dir];
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(preview.result.removals.length, 1);

  // a new broken file appears after the preview
  make(dir, { 'bad2.mp4': BROKEN + ' again' });
  const stale = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
  assert.strictEqual(stale.repreview, true);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'bad.mp4')));
  assert.ok(fs.existsSync(path.join(dir, 'bad2.mp4')));
  assert.strictEqual(stale.result.removals.length, 2);

  // a run without a valid fingerprint is refused outright
  assert.throws(() => runChecked(argv, { mode: 'run' }, { execute }), fc.FcError);
  assert.deepStrictEqual(recycled, []);

  const ran = runChecked(argv, { mode: 'run', expect: stale.fingerprint }, { execute });
  assert.strictEqual(ran.ran, true);
  assert.deepStrictEqual(recycled.sort(), [path.join(dir, 'bad.mp4'), path.join(dir, 'bad2.mp4')].sort());
  assert.ok(fs.existsSync(path.join(dir, 'good.txt')));
});

// ---- changes inside a source folder (#280) ----

test('the fingerprint of an unchanged source folder is stable and the preview carries a count and size per source', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '12345', 'src/sub/b.txt': '123', 'dest/keep.txt': 'k', 'single.txt': 'xy' });
  const src = path.join(dir, 'src');
  for (const argv of [['mv', src, path.join(dir, 'dest')], ['cp', src, path.join(dir, 'dest')], ['rm', src], ['rm', '--permanent', src]]) {
    const one = runChecked(argv, { mode: 'preview' }, { execute });
    const two = runChecked(argv, { mode: 'preview' }, { execute });
    assert.strictEqual(one.fingerprint, two.fingerprint, argv.join(' '));
    assert.deepStrictEqual(one.sources.map(({ path: p, type, count, size }) => ({ p, type, count, size })), [{ p: src, type: 'dir', count: 3, size: 8 }]);
  }
  const file = runChecked(['rm', path.join(dir, 'single.txt')], { mode: 'preview' }, { execute });
  assert.deepStrictEqual([file.sources[0].type, file.sources[0].count, file.sources[0].size], ['file', 0, 2]);
  assert.deepStrictEqual(recycled, []);
});

const CHANGES = {
  'a file is added': (dir) => make(dir, { 'src/sub/new.txt': 'n' }),
  'a file is removed': (dir) => fs.rmSync(path.join(dir, 'src', 'a.txt')),
  'a file changes size': (dir) => make(dir, { 'src/a.txt': '1234567890' }),
  'a file changes only its modified time': (dir) => fs.utimesSync(path.join(dir, 'src', 'a.txt'), new Date(realNow() - 2 * HOUR), new Date(realNow() - 2 * HOUR)),
  'an empty folder is added': (dir) => fs.mkdirSync(path.join(dir, 'src', 'empty')),
};

for (const [label, args] of Object.entries({ mv: ['mv'], cp: ['cp'], rm: ['rm'], 'rm --permanent': ['rm', '--permanent'] })) {
  for (const [change, mutate] of Object.entries(CHANGES)) {
    test(`${label}: if ${change} inside the source folder after the preview, the run shows a new preview and changes nothing`, () => {
      const dir = tempDir();
      make(dir, { 'src/a.txt': '12345', 'src/sub/b.txt': '123', 'dest/keep.txt': 'k' });
      const src = path.join(dir, 'src');
      const argv = args[0] === 'rm' ? [...args, src] : [...args, src, path.join(dir, 'dest')];
      const preview = runChecked(argv, { mode: 'preview' }, { execute });
      mutate(dir);
      const listing = () => fs.readdirSync(dir, { recursive: true }).sort().join('|');
      const before = listing();
      const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
      assert.strictEqual(outcome.repreview, true);
      assert.strictEqual(outcome.ran, undefined);
      assert.notStrictEqual(outcome.fingerprint, preview.fingerprint);
      assert.strictEqual(listing(), before, 'nothing moved, copied, or deleted');
      assert.deepStrictEqual(recycled, []);
    });
  }
}

test('mv and cp of a folder run when it is unchanged since the preview', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '12345', 'cpsrc/c.txt': 'c', 'dest/keep.txt': 'k' });
  const moveArgv = ['mv', path.join(dir, 'src'), path.join(dir, 'dest')];
  const moved = runChecked(moveArgv, { mode: 'run', expect: runChecked(moveArgv, { mode: 'preview' }, { execute }).fingerprint }, { execute });
  assert.strictEqual(moved.ran, true);
  assert.ok(fs.existsSync(path.join(dir, 'dest', 'src', 'a.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'src')));
  const copyArgv = ['cp', path.join(dir, 'cpsrc'), path.join(dir, 'dest')];
  const copied = runChecked(copyArgv, { mode: 'run', expect: runChecked(copyArgv, { mode: 'preview' }, { execute }).fingerprint }, { execute });
  assert.strictEqual(copied.ran, true);
  assert.ok(fs.existsSync(path.join(dir, 'dest', 'cpsrc', 'c.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'cpsrc', 'c.txt')));
});

test('a link inside a source folder is recorded as a link and is not followed', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'outside/big.txt': 'xxxxxxxx' });
  try {
    fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'src', 'lnk'), 'junction');
  } catch {
    return; // links cannot be made here
  }
  const argv = ['rm', path.join(dir, 'src')];
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.strictEqual(preview.sources[0].count, 2);
  assert.strictEqual(preview.sources[0].size, 1, 'the linked folder is not counted');
  make(dir, { 'outside/more.txt': 'm' });
  assert.strictEqual(runChecked(argv, { mode: 'preview' }, { execute }).fingerprint, preview.fingerprint);
  fs.rmSync(path.join(dir, 'src', 'lnk'));
  assert.notStrictEqual(runChecked(argv, { mode: 'preview' }, { execute }).fingerprint, preview.fingerprint);
});

test('a source folder with more entries than the cap fails the preview instead of fingerprinting a part', () => {
  const dir = tempDir();
  make(dir, { 'src/1.txt': '1', 'src/2.txt': '2', 'src/3.txt': '3' });
  assert.throws(() => snapshotSource(path.join(dir, 'src'), { maxEntries: 2 }), (err) => err instanceof fc.FcError && /too many/.test(err.message));
  assert.strictEqual(snapshotSource(path.join(dir, 'src'), { maxEntries: 3 }).count, 3);
});

test('sourcePaths picks the sources of mv, cp and rm only', () => {
  assert.deepStrictEqual(sourcePaths('mv', ['mv', 'a', 'b', '--force', 'dest']), ['a', 'b']);
  assert.deepStrictEqual(sourcePaths('cp', ['cp', 'a', '--', '--odd', 'dest']), ['a', '--odd']);
  assert.deepStrictEqual(sourcePaths('rm', ['rm', '--permanent', 'a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(sourcePaths('flatten', ['flatten', 'a']), []);
});

// ---- links, unreadable entries, several sources (#280 review) ----

function junction(target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false; // links cannot be made here
  }
}

test('cp reads through a junction inside the source, so a file added behind it gives a new preview and nothing is copied', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'outside/big.txt': 'xxxxxxxx', 'dest/keep.txt': 'k' });
  if (!junction(path.join(dir, 'outside'), path.join(dir, 'src', 'lnk'))) return;
  const argv = ['cp', path.join(dir, 'src'), path.join(dir, 'dest')];
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.strictEqual(preview.sources[0].count, 3);
  assert.strictEqual(preview.sources[0].size, 9, 'what the junction holds is counted');
  make(dir, { 'outside/NEW.txt': 'n' });
  const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
  assert.strictEqual(outcome.repreview, true);
  assert.ok(!fs.existsSync(path.join(dir, 'dest', 'src')), 'nothing was copied');
});

test('a junction that loops back into the source does not make the snapshot walk forever', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1' });
  if (!junction(path.join(dir, 'src'), path.join(dir, 'src', 'loop'))) return;
  const snap = snapshotSource(path.join(dir, 'src'), { followLinks: true });
  assert.strictEqual(snap.count, 2);
});

test('a source that is itself a junction: rm records the link, cp reads through it', () => {
  const dir = tempDir();
  make(dir, { 'real/a.txt': '123', 'dest/keep.txt': 'k' });
  const link = path.join(dir, 'lnk');
  if (!junction(path.join(dir, 'real'), link)) return;
  const asLink = snapshotSource(link);
  assert.deepStrictEqual([asLink.type, asLink.count, asLink.size], ['link', 0, 0]);
  assert.strictEqual(typeof asLink.target, 'string');
  const through = snapshotSource(link, { followLinks: true });
  assert.deepStrictEqual([through.type, through.count, through.size], ['link', 1, 3]);
  const rmPreview = runChecked(['rm', link], { mode: 'preview' }, { execute });
  make(dir, { 'real/new.txt': 'n' });
  assert.strictEqual(runChecked(['rm', link], { mode: 'preview' }, { execute }).fingerprint, rmPreview.fingerprint, 'rm removes only the link');
  const cpArgv = ['cp', link, path.join(dir, 'dest')];
  const cpPreview = runChecked(cpArgv, { mode: 'preview' }, { execute });
  make(dir, { 'real/newer.txt': 'n' });
  assert.strictEqual(runChecked(cpArgv, { mode: 'run', expect: cpPreview.fingerprint }, { execute }).repreview, true);
});

test('an unreadable or vanished entry becomes an FcError naming the path', (t) => {
  const dir = tempDir();
  make(dir, { 'src/sub/a.txt': '1' });
  const realReaddir = fs.readdirSync;
  const readdir = t.mock.method(fs, 'readdirSync', (target, ...rest) => {
    if (String(target).endsWith('sub')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return realReaddir(target, ...rest);
  });
  assert.throws(() => snapshotSource(path.join(dir, 'src')), (err) => err instanceof fc.FcError && /sub could not be read \(EPERM\).*command line/.test(err.message));
  readdir.mock.restore();
  const realLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) => {
    if (String(target).endsWith('a.txt')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return realLstat(target, ...rest);
  });
  assert.throws(() => snapshotSource(path.join(dir, 'src')), (err) => err instanceof fc.FcError && /a\.txt could not be read \(ENOENT\)/.test(err.message));
});

test('rm with several sources: a change inside any of them gives a new preview and deletes nothing', () => {
  const dir = tempDir();
  make(dir, { 'one/a.txt': '1', 'two/b.txt': '2', 'three.txt': '3' });
  const argv = ['rm', path.join(dir, 'one'), path.join(dir, 'two'), path.join(dir, 'three.txt')];
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.deepStrictEqual(preview.sources.map((s) => s.type), ['dir', 'dir', 'file']);
  make(dir, { 'two/new.txt': 'n' });
  const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
  assert.strictEqual(outcome.repreview, true);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'one', 'a.txt')) && fs.existsSync(path.join(dir, 'two', 'b.txt')) && fs.existsSync(path.join(dir, 'three.txt')));
});
