'use strict';

// The destination snapshot of mv --force and cp --force (#284): what is already at the destination is replaced or overwritten, so a change there
// after the preview must give a new preview instead of overwriting something the person never saw. Also the cross-volume mv of #284's comment:
// moving to another drive copies with fs.cpSync, which reads through a junction inside the source, so the source snapshot follows links then.
// rename --force and zip --force overwrite one file, which is snapshotted the same way (#297).
// mv and cp never use the Recycle Bin; the fake below (and --require for the job processes) makes sure nothing could reach the real one.
require('./fakeRecyclePreload');

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder, which is a protected path, so the user folder is swapped with a fake path.
const FAKE_HOME = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');
test.mock.method(os, 'homedir', () => FAKE_HOME);

const { execute } = require('../src/execute');
const { FcError } = require('../src/commands');
const { fingerprint } = require('../src/ui/flow');
const { toPlain } = require('../src/ui/serialize');
const { previewFingerprint, runChecked } = require('../src/ui/checkedRun');
const { DESTINATION_COMMANDS, crossesVolumes, destinationPaths, sameItem, snapshotDestinations } = require('../src/ui/sourceSnapshot');
const { startUi } = require('./uiClient');
const { createJobs } = require('../src/ui/jobs');
const { OVERWRITE_HOW, jobRoutes } = require('../src/ui/jobPages');
const { flowRoutes } = require('../src/ui/flowPages');

const OLD = new Date(Date.now() - 60 * 60 * 1000);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dest-snap-'));
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

function junction(target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false; // links cannot be made here
  }
}

const listing = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((name) => {
  const full = path.join(dir, name);
  return fs.lstatSync(full).isFile() ? `${name}=${fs.readFileSync(full, 'utf8')}` : name;
}).join('|');

// ---- in process: runChecked with the real commands ----

// Each case: the files, the argv (built from dir), the destination folder that is replaced or merged into (inside) or the file that is
// overwritten (file), and an existing file at the destination that a change can touch (existing).
const CASES = {
  'mv --force of a folder onto an existing folder': {
    files: { 'src/a.txt': '12345', 'dest/src/old.txt': 'old', 'dest/src/sub/deep.txt': 'd' },
    argv: (dir) => ['mv', '--force', path.join(dir, 'src'), path.join(dir, 'dest')],
    inside: 'dest/src',
    existing: 'dest/src/old.txt',
  },
  'mv --force of a file onto an existing file': {
    files: { 'a.txt': 'new', 'dest/a.txt': 'old' },
    argv: (dir) => ['mv', '--force', path.join(dir, 'a.txt'), path.join(dir, 'dest')],
    file: 'dest/a.txt',
    existing: 'dest/a.txt',
  },
  'cp --force of a folder merged into an existing folder': {
    files: { 'src/a.txt': '12345', 'dest/src/a.txt': 'old', 'dest/src/other.txt': 'o' },
    argv: (dir) => ['cp', '--force', path.join(dir, 'src'), path.join(dir, 'dest')],
    inside: 'dest/src',
    existing: 'dest/src/other.txt',
  },
  'cp --force of a file onto an existing file': {
    files: { 'a.txt': 'new', 'dest/a.txt': 'old' },
    argv: (dir) => ['cp', '--force', path.join(dir, 'a.txt'), path.join(dir, 'dest', 'a.txt')],
    file: 'dest/a.txt',
    existing: 'dest/a.txt',
  },
};

const EARLIER = new Date(OLD.getTime() - 60 * 1000);
const CHANGES = {
  'a file is added inside it': (dir, c) => make(dir, { [`${c.inside}/sub/new.txt`]: 'n' }),
  'a file there changes': (dir, c) => make(dir, { [c.existing]: 'changed!' }),
  'a file there changes only its modified time': (dir, c) => fs.utimesSync(path.join(dir, c.existing), EARLIER, EARLIER),
};

for (const [label, c] of Object.entries(CASES)) {
  for (const [change, mutate] of Object.entries(CHANGES)) {
    if (change === 'a file is added inside it' && !c.inside) continue;
    test(`${label}: if ${change} after the preview, the run shows a new preview and changes nothing (#284)`, () => {
      const dir = tempDir();
      make(dir, c.files);
      const argv = c.argv(dir);
      const preview = runChecked(argv, { mode: 'preview' }, { execute });
      assert.ok(Array.isArray(preview.destinations), 'a --force preview carries the destination snapshot');
      mutate(dir, c);
      const before = listing(dir);
      const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
      assert.strictEqual(outcome.repreview, true);
      assert.strictEqual(outcome.ran, undefined);
      assert.notStrictEqual(outcome.fingerprint, preview.fingerprint);
      assert.strictEqual(listing(dir), before, 'nothing was moved, copied, or overwritten');
    });
  }

  test(`${label}: an unchanged destination runs and overwrites (#284)`, () => {
    const dir = tempDir();
    make(dir, c.files);
    const argv = c.argv(dir);
    const preview = runChecked(argv, { mode: 'preview' }, { execute });
    assert.strictEqual(runChecked(argv, { mode: 'preview' }, { execute }).fingerprint, preview.fingerprint, 'the fingerprint is stable');
    const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
    assert.strictEqual(outcome.ran, true);
    if (c.file) assert.strictEqual(fs.readFileSync(path.join(dir, c.file), 'utf8'), 'new');
    else assert.strictEqual(fs.readFileSync(path.join(dir, c.inside, 'a.txt'), 'utf8'), '12345');
  });
}

test('the destination snapshot counts what is there: type, items inside and total size (#284)', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'dest/src/old.txt': 'old', 'dest/src/sub/deep.txt': 'dd', 'b.txt': 'b' });
  const preview = runChecked(['mv', '--force', path.join(dir, 'src'), path.join(dir, 'b.txt'), path.join(dir, 'dest')], { mode: 'preview' }, { execute });
  assert.deepStrictEqual(preview.destinations.map(({ path: p, type, count, size }) => ({ p, type, count, size })), [
    { p: path.join(dir, 'dest', 'src'), type: 'dir', count: 3, size: 5 },
    { p: path.join(dir, 'dest', 'b.txt'), type: 'missing', count: 0, size: 0 },
  ]);
});

test('without --force there is no destination snapshot; only the followed flag on a source that reads through links changes the fingerprint (#284)', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'dest/keep.txt': 'k' });
  // The fingerprint as #280 computed it: the snapshot had no followed flag and the preview no destinations.
  const before280 = (command, argv, preview) => fingerprint({
    command,
    args: argv,
    options: {},
    preview: { result: toPlain(preview.result), sources: preview.sources.map(({ followed, ...rest }) => rest) },
  });
  for (const command of ['mv', 'cp']) {
    const argv = [command, path.join(dir, 'src'), path.join(dir, 'dest')];
    const preview = runChecked(argv, { mode: 'preview' }, { execute });
    assert.strictEqual(preview.destinations, undefined, `${command}: no destination snapshot without --force`);
    assert.strictEqual(previewFingerprint(argv, preview), preview.fingerprint);
    if (command === 'mv') {
      // mv on one volume renames, so it does not follow links: the value is exactly the one before #284.
      assert.strictEqual(preview.sources[0].followed, undefined);
      assert.strictEqual(preview.fingerprint, before280(command, argv, preview), 'mv: the same value as before #284');
    } else {
      // cp reads through links, and its snapshot now says so; that flag is the only difference.
      assert.strictEqual(preview.sources[0].followed, true);
      assert.notStrictEqual(preview.fingerprint, before280(command, argv, preview), 'cp: the followed flag is part of the value');
      const withFlag = fingerprint({ command, args: argv, options: {}, preview: { result: toPlain(preview.result), sources: preview.sources } });
      assert.strictEqual(preview.fingerprint, withFlag, 'cp: nothing else changed');
    }
  }
});

test('destinationPaths: only mv and cp with --force, each target once, resolved into an existing folder (#284)', () => {
  const dir = tempDir();
  make(dir, { 'dest/x.txt': 'x' });
  const dest = path.join(dir, 'dest');
  assert.deepStrictEqual(destinationPaths('mv', ['mv', 'a', 'b', dest]), []);
  assert.deepStrictEqual(destinationPaths('rm', ['rm', '--force', 'a']), []);
  assert.deepStrictEqual(destinationPaths('mv', ['mv', '--force', 'a', path.join('sub', 'b'), dest]), [path.join(dest, 'a'), path.join(dest, 'b')]);
  assert.deepStrictEqual(destinationPaths('cp', ['cp', '--force', 'one/a', 'two/a', dest]), [path.join(dest, 'a')]);
  assert.deepStrictEqual(destinationPaths('cp', ['cp', 'a', '--', '--force', dest]), [], '--force after -- is a name, not the option');
  assert.deepStrictEqual(destinationPaths('cp', ['cp', '--force', 'a', path.join(dir, 'new.txt')]), [path.join(dir, 'new.txt')]);
});

test('a link at the destination is recorded as a link and not followed (#284)', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'elsewhere/big.txt': 'xxxxxxxx', 'dest/keep.txt': 'k' });
  if (!junction(path.join(dir, 'elsewhere'), path.join(dir, 'dest', 'src'))) return;
  const argv = ['mv', '--force', path.join(dir, 'src'), path.join(dir, 'dest')];
  const [snap] = snapshotDestinations('mv', argv);
  assert.deepStrictEqual([snap.type, snap.count, snap.size, snap.followed], ['link', 0, 0, undefined]);
  const before = snap.digest;
  make(dir, { 'elsewhere/more.txt': 'm' });
  assert.strictEqual(snapshotDestinations('mv', argv)[0].digest, before, 'mv --force deletes the link itself, not what it leads to');
});

test('a destination with more entries than the cap fails the preview instead of fingerprinting a part (#284)', () => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'dest/src/1.txt': '1', 'dest/src/2.txt': '2', 'dest/src/3.txt': '3' });
  const argv = ['cp', '--force', path.join(dir, 'src'), path.join(dir, 'dest')];
  assert.throws(() => snapshotDestinations('cp', argv, { maxEntries: 2 }), (err) => err instanceof FcError && /too many/.test(err.message));
  assert.strictEqual(snapshotDestinations('cp', argv, { maxEntries: 3 })[0].count, 3);
});

// ---- mv to another volume (#284 comment) ----

test('mv on one volume does not follow a junction in the source; mv to another volume does (#284)', (t) => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'outside/big.txt': 'xxxxxxxx', 'dest/keep.txt': 'k', 'far/keep.txt': 'k' });
  if (!junction(path.join(dir, 'outside'), path.join(dir, 'src', 'lnk'))) return;
  const near = ['mv', path.join(dir, 'src'), path.join(dir, 'dest')];
  const nearPreview = runChecked(near, { mode: 'preview' }, { execute });
  assert.strictEqual(nearPreview.sources[0].followed, undefined);
  assert.strictEqual(crossesVolumes(path.join(dir, 'src'), path.join(dir, 'dest', 'src')), false);

  // "far" stands for another drive: its volume number differs. fs.renameSync is left alone, so the real run below stays on one drive.
  const far = path.join(dir, 'far');
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', function statSync(p, ...rest) {
    const stat = realStat.call(this, p, ...rest);
    if (!stat || !String(p).toLowerCase().startsWith(far.toLowerCase())) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: typeof stat.dev === 'bigint' ? stat.dev + 1n : stat.dev + 1 });
  });
  assert.strictEqual(crossesVolumes(path.join(dir, 'src'), path.join(far, 'src')), true);
  const argv = ['mv', path.join(dir, 'src'), far];
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.strictEqual(preview.sources[0].followed, true);
  assert.strictEqual(preview.sources[0].size, 9, 'what the junction holds is counted, because a copy reads it');
  make(dir, { 'outside/NEW.txt': 'n' });
  const before = listing(dir);
  const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
  assert.strictEqual(outcome.repreview, true);
  assert.strictEqual(listing(dir), before, 'nothing was moved');
  assert.strictEqual(runChecked(argv, { mode: 'run', expect: outcome.fingerprint }, { execute }).ran, true);
});

test('a volume that cannot be told counts as another volume (#284)', (t) => {
  const dir = tempDir();
  make(dir, { 'src/a.txt': '1', 'dest/keep.txt': 'k' });
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', function statSync(p, ...rest) {
    if (String(p).toLowerCase() === path.join(dir, 'dest').toLowerCase()) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return realStat.call(this, p, ...rest);
  });
  assert.strictEqual(crossesVolumes(path.join(dir, 'src'), path.join(dir, 'dest', 'src')), true);
});

// ---- end to end: the real server and the real job process ----

const PRELOAD = path.join(__dirname, 'fakeRecyclePreload.js');
const forkWithFake = (workerPath, args, options) => childProcess.fork(workerPath, args, { ...options, execArgv: [...process.execArgv, '--require', PRELOAD] });

const spec = (command, title, doneLabel) => ({
  command,
  path: `/files/${command}`,
  title,
  fields: [
    { name: 'source', label: 'Source', kind: 'text' },
    { name: 'dest', label: 'Destination', kind: 'text' },
    { name: 'force', label: 'Overwrite', kind: 'checkbox' },
  ],
  toArgv(values) {
    if (!values.source || !values.dest) throw new FcError('Enter a source and a destination.');
    return [command, values.source, values.dest, ...(values.force ? ['--force'] : [])];
  },
  doneLabel,
});

async function settled(jobs, job, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`The job did not finish: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function serve(t) {
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: FAKE_HOME }, fork: forkWithFake });
  const specs = [spec('mv', 'Move', 'Moved'), spec('cp', 'Copy', 'Copied')];
  const routes = new Map([...jobRoutes(jobs, { specs }), ...flowRoutes(jobs, specs)]);
  const { server, url, get, post } = await startUi({ routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const finish = async (res) => {
    assert.strictEqual(res.status, 303, await res.clone().text());
    const id = new URL(res.headers.get('location'), url).searchParams.get('id');
    const job = jobs.get(id);
    await settled(jobs, job);
    const page = await get(`/job/result?id=${id}`);
    assert.strictEqual(page.status, 200);
    return { job, body: await page.text() };
  };
  return { post, finish };
}

const fingerprintOf = (body) => /name="fingerprint" value="([0-9a-f]{64})"/.exec(body)?.[1];

for (const command of ['mv', 'cp']) {
  test(`${command} --force in the UI: a destination file changed after the preview gives a new preview, an unchanged one is overwritten (#284)`, async (t) => {
    const dir = tempDir();
    make(dir, { 'a.txt': 'new', 'dest/a.txt': 'old' });
    const form = { source: path.join(dir, 'a.txt'), dest: path.join(dir, 'dest'), force: 'on', 'confirm-force': 'yes' };
    const { post, finish } = await serve(t);

    const preview = await finish(await post(`/files/${command}/preview`, form));
    assert.strictEqual(preview.job.status, 'done', preview.body);
    assert.match(preview.body, /<h2>Will be overwritten<\/h2>/);
    assert.match(preview.body, /1 existing item at the destination, 3B in all/);
    assert.ok(preview.body.includes(path.join(dir, 'dest', 'a.txt')), 'the overwritten file is named');
    const first = fingerprintOf(preview.body);
    assert.ok(first);

    make(dir, { 'dest/a.txt': 'changed by someone else' });
    const stale = await finish(await post(`/files/${command}/run`, { ...form, fingerprint: first }));
    assert.strictEqual(stale.job.outcome.repreview, true, stale.body);
    assert.match(stale.body, /folder changed after the preview/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dest', 'a.txt'), 'utf8'), 'changed by someone else', 'nothing was overwritten');
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
    const second = fingerprintOf(stale.body);
    assert.ok(second && second !== first);

    const run = await finish(await post(`/files/${command}/run`, { ...form, fingerprint: second }));
    assert.strictEqual(run.job.outcome.ran, true, run.body);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'dest', 'a.txt'), 'utf8'), 'new');
    assert.strictEqual(fs.existsSync(path.join(dir, 'a.txt')), command === 'cp');
  });
}

test('a preview without --force shows no overwrite table (#284)', async (t) => {
  const dir = tempDir();
  make(dir, { 'a.txt': 'new', 'dest/keep.txt': 'k' });
  const { post, finish } = await serve(t);
  const preview = await finish(await post('/files/cp/preview', { source: path.join(dir, 'a.txt'), dest: path.join(dir, 'dest') }));
  assert.strictEqual(preview.job.status, 'done', preview.body);
  assert.ok(fingerprintOf(preview.body));
  assert.doesNotMatch(preview.body, /Will be overwritten/);
});

// ---- rename --force and zip --force (#297) ----

// Each case: the files, the argv (built from dir), the file that is overwritten, and a check of it after an unchanged run.
const OVERWRITE_CASES = {
  rename: {
    files: { 'a.txt': 'new', 'b.txt': 'old' },
    argv: (dir, force) => ['rename', path.join(dir, 'a.txt'), 'b.txt', ...(force ? ['--force'] : [])],
    overwritten: 'b.txt',
    after: (dir) => assert.strictEqual(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'new'),
  },
  zip: {
    files: { 'src/a.txt': 'new', 'out.zip': 'old' },
    argv: (dir, force) => ['zip', ...(force ? ['--force'] : []), '--', path.join(dir, 'out.zip'), path.join(dir, 'src')],
    overwritten: 'out.zip',
    // A real zip archive starts with PK.
    after: (dir) => assert.strictEqual(fs.readFileSync(path.join(dir, 'out.zip')).subarray(0, 2).toString('latin1'), 'PK'),
  },
};

const OVERWRITE_CHANGES = {
  'the overwritten file changes': (dir, c) => make(dir, { [c.overwritten]: 'changed!' }),
  'the overwritten file changes only its modified time': (dir, c) => fs.utimesSync(path.join(dir, c.overwritten), EARLIER, EARLIER),
  'the overwritten file is removed': (dir, c) => fs.rmSync(path.join(dir, c.overwritten)),
};

for (const [command, c] of Object.entries(OVERWRITE_CASES)) {
  for (const [change, mutate] of Object.entries(OVERWRITE_CHANGES)) {
    test(`${command} --force: if ${change} after the preview, the run shows a new preview and changes nothing (#297)`, () => {
      const dir = tempDir();
      make(dir, c.files);
      const argv = c.argv(dir, true);
      const preview = runChecked(argv, { mode: 'preview' }, { execute });
      assert.deepStrictEqual(preview.destinations.map(({ path: p, type }) => [p, type]), [[path.join(dir, c.overwritten), 'file']]);
      mutate(dir, c);
      const before = listing(dir);
      const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
      assert.strictEqual(outcome.repreview, true);
      assert.strictEqual(outcome.ran, undefined);
      assert.notStrictEqual(outcome.fingerprint, preview.fingerprint);
      assert.strictEqual(listing(dir), before, 'nothing was renamed, written, or overwritten');
    });
  }

  test(`${command} --force: an unchanged overwritten file runs and is overwritten (#297)`, () => {
    const dir = tempDir();
    make(dir, c.files);
    const argv = c.argv(dir, true);
    const preview = runChecked(argv, { mode: 'preview' }, { execute });
    assert.strictEqual(runChecked(argv, { mode: 'preview' }, { execute }).fingerprint, preview.fingerprint, 'the fingerprint is stable');
    const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
    assert.strictEqual(outcome.ran, true);
    c.after(dir);
  });

  test(`${command} without --force: no destination snapshot and the same fingerprint as before #297`, () => {
    const dir = tempDir();
    make(dir, c.files);
    fs.rmSync(path.join(dir, c.overwritten)); // without --force an existing target is an error
    const argv = c.argv(dir, false);
    const preview = runChecked(argv, { mode: 'preview' }, { execute });
    assert.strictEqual(preview.destinations, undefined);
    assert.strictEqual(preview.sources, undefined);
    const before297 = fingerprint({ command, args: argv, options: {}, preview: { result: toPlain(preview.result), sources: null } });
    assert.strictEqual(preview.fingerprint, before297);
  });
}

test('destinationPaths: the new name of rename --force and the archive of zip --force (#297)', () => {
  const dir = tempDir();
  const a = path.join(dir, 'a.txt');
  assert.deepStrictEqual(destinationPaths('rename', ['rename', a, 'b.txt', '--force']), [path.join(dir, 'b.txt')]);
  assert.deepStrictEqual(destinationPaths('rename', ['rename', a, 'b.txt']), []);
  assert.deepStrictEqual(destinationPaths('rename', ['rename', a, '--', '--force']), [], '--force after -- is a name, not the option');
  const archive = path.join(dir, 'out.zip');
  assert.deepStrictEqual(destinationPaths('zip', ['zip', '--force', '--', archive, a]), [archive]);
  assert.deepStrictEqual(destinationPaths('zip', ['zip', '--', archive, a]), []);
  assert.deepStrictEqual(destinationPaths('unzip', ['unzip', '--force', '--', archive]), []);
});

test('rename --force that only changes the case of the name overwrites nothing, so it has no destination (#297)', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir();
  make(dir, { 'a.txt': 'a' });
  const argv = ['rename', path.join(dir, 'a.txt'), 'A.txt', '--force'];
  assert.deepStrictEqual(destinationPaths('rename', argv), []);
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.strictEqual(preview.destinations, undefined);
});

test('rename --force onto a name that only toLowerCase folds to the same is a real overwrite and is snapshotted (#297)', (t) => {
  const dir = tempDir();
  // KELVIN SIGN lowercases to k, but NTFS keeps K.txt and k.txt as two files.
  make(dir, { 'K.txt': 'kelvin', 'k.txt': 'old' });
  if (fs.readdirSync(dir).length !== 2) {
    t.skip('this file system does not keep both names');
    return;
  }
  const argv = ['rename', path.join(dir, 'K.txt'), 'k.txt', '--force'];
  assert.deepStrictEqual(destinationPaths('rename', argv), [path.join(dir, 'k.txt')]);
  const preview = runChecked(argv, { mode: 'preview' }, { execute });
  assert.deepStrictEqual(preview.destinations.map(({ path: p, type }) => [p, type]), [[path.join(dir, 'k.txt'), 'file']]);
  make(dir, { 'k.txt': 'changed by someone else' });
  const outcome = runChecked(argv, { mode: 'run', expect: preview.fingerprint }, { execute });
  assert.strictEqual(outcome.repreview, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'k.txt'), 'utf8'), 'changed by someone else', 'nothing was overwritten');
});

test('sameItem: the same file number is the same item; different files, or a path that cannot be read, are not (#297)', (t) => {
  const dir = tempDir();
  make(dir, { 'a.txt': 'a', 'b.txt': 'b' });
  const a = path.join(dir, 'a.txt');
  assert.strictEqual(sameItem(a, a), true);
  assert.strictEqual(sameItem(a, path.join(dir, 'b.txt')), false);
  assert.strictEqual(sameItem(a, path.join(dir, 'missing.txt')), false);
  // Names that differ only in case but are two files (a case-sensitive folder): told apart by the file number, not the name.
  const realLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function lstatSync(p, ...rest) {
    const stat = realLstat.call(this, String(p) === path.join(dir, 'A.TXT') ? path.join(dir, 'b.txt') : p, ...rest);
    return stat;
  });
  assert.strictEqual(sameItem(a, path.join(dir, 'A.TXT')), false);
  assert.deepStrictEqual(destinationPaths('rename', ['rename', a, 'A.TXT', '--force']), [path.join(dir, 'A.TXT')]);
});

test('every command with a destination snapshot has its own sentence in the overwrite table (#297)', () => {
  for (const command of DESTINATION_COMMANDS) assert.strictEqual(typeof OVERWRITE_HOW[command], 'string', command);
  assert.deepStrictEqual(Object.keys(OVERWRITE_HOW).sort(), [...DESTINATION_COMMANDS].sort());
});

async function serveSpecs(t, specs, views = {}) {
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: FAKE_HOME }, fork: forkWithFake });
  const routes = new Map([...jobRoutes(jobs, { specs, views }), ...flowRoutes(jobs, specs)]);
  const { server, url, get, post } = await startUi({ routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const finish = async (res) => {
    assert.strictEqual(res.status, 303, await res.clone().text());
    const id = new URL(res.headers.get('location'), url).searchParams.get('id');
    const job = jobs.get(id);
    await settled(jobs, job);
    const page = await get(`/job/result?id=${id}`);
    assert.strictEqual(page.status, 200);
    return { job, body: await page.text() };
  };
  return { post, finish };
}

// The real screens' specs (and result views), so the argv is exactly what the UI builds.
const UI_CASES = {
  rename: {
    screen: () => require('../src/ui/screens/files'),
    path: '/files/rename',
    files: OVERWRITE_CASES.rename.files,
    form: (dir) => ({ target: path.join(dir, 'a.txt'), name: 'b.txt' }),
    overwritten: 'b.txt',
    how: /The item below is replaced by the renamed item\./,
    after: OVERWRITE_CASES.rename.after,
  },
  zip: {
    screen: () => require('../src/ui/screens/archive'),
    path: '/archive/zip',
    files: OVERWRITE_CASES.zip.files,
    form: (dir) => ({ archive: path.join(dir, 'out.zip'), sources: path.join(dir, 'src') }),
    overwritten: 'out.zip',
    how: /The file below is replaced by the new archive\./,
    after: OVERWRITE_CASES.zip.after,
  },
};

for (const [command, c] of Object.entries(UI_CASES)) {
  test(`${command} --force in the UI: an overwritten file changed after the preview gives a new preview, an unchanged one is overwritten (#297)`, async (t) => {
    const dir = tempDir();
    make(dir, c.files);
    const { specs, views } = c.screen();
    const { post, finish } = await serveSpecs(t, specs.filter((s) => s.command === command), views);
    const form = { ...c.form(dir), force: 'on', 'confirm-force': 'yes' };

    const preview = await finish(await post(`${c.path}/preview`, form));
    assert.strictEqual(preview.job.status, 'done', preview.body);
    assert.match(preview.body, /<h2>Will be overwritten<\/h2>/);
    assert.match(preview.body, c.how);
    assert.match(preview.body, /1 existing item at the destination, 3B in all/);
    assert.ok(preview.body.includes(path.join(dir, c.overwritten)), 'the overwritten file is named');
    const first = fingerprintOf(preview.body);
    assert.ok(first);

    make(dir, { [c.overwritten]: 'changed by someone else' });
    const stale = await finish(await post(`${c.path}/run`, { ...form, fingerprint: first }));
    assert.strictEqual(stale.job.outcome.repreview, true, stale.body);
    assert.match(stale.body, /folder changed after the preview/);
    assert.strictEqual(fs.readFileSync(path.join(dir, c.overwritten), 'utf8'), 'changed by someone else', 'nothing was overwritten');
    const second = fingerprintOf(stale.body);
    assert.ok(second && second !== first);

    const run = await finish(await post(`${c.path}/run`, { ...form, fingerprint: second }));
    assert.strictEqual(run.job.outcome.ran, true, run.body);
    c.after(dir);
  });

  test(`${command} in the UI without Overwrite shows no overwrite table (#297)`, async (t) => {
    const dir = tempDir();
    make(dir, c.files);
    fs.rmSync(path.join(dir, c.overwritten));
    const { specs, views } = c.screen();
    const { post, finish } = await serveSpecs(t, specs.filter((s) => s.command === command), views);
    const preview = await finish(await post(`${c.path}/preview`, c.form(dir)));
    assert.strictEqual(preview.job.status, 'done', preview.body);
    assert.ok(fingerprintOf(preview.body));
    assert.doesNotMatch(preview.body, /Will be overwritten/);
  });
}
