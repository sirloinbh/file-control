'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const { fakeRecycleFiles } = require('./fakeRecycleFiles');

// A fake Recycle Bin, installed before commands.js is imported. It remembers what was sent (a folder with its empty subfolders, or a file with its content)
// so that the fake restore can put it back, the way the real Recycle Bin would.
const bin = new Map();
const realExecFileSync = childProcess.execFileSync;
function folders(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(e.parentPath, e.name));
}
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  const env = options?.env ?? {};
  const state = volumeStateAnswer(env, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  if (env.FC_RESTORE !== undefined) {
    const kept = bin.get(env.FC_RESTORE);
    if (!kept) return 'notfound\r\n';
    if (kept.folders) {
      fs.mkdirSync(env.FC_RESTORE);
      for (const sub of kept.folders) fs.mkdirSync(sub, { recursive: true });
    } else fs.writeFileSync(env.FC_RESTORE, kept.content);
    bin.delete(env.FC_RESTORE);
    return 'ok\r\n';
  }
  if (env.FC_RECYCLE_FILES !== undefined) {
    return fakeRecycleFiles(options, (target) => bin.set(target, { content: fs.readFileSync(target) }));
  }
  if (env.FC_BATCH !== undefined) {
    const lines = options.input.split('\n').filter(Boolean).map((line) => {
      const folder = Buffer.from(line, 'base64').toString('utf16le');
      bin.set(folder, { folders: folders(folder) });
      fs.rmSync(folder, { recursive: true });
      return `ok ${line}`;
    });
    return `${lines.join('\r\n')}\r\n`;
  }
  if (env.FC_TARGET !== undefined) {
    const stat = fs.lstatSync(env.FC_TARGET);
    bin.set(env.FC_TARGET, stat.isDirectory() ? { folders: folders(env.FC_TARGET) } : { content: fs.readFileSync(env.FC_TARGET) });
    fs.rmSync(env.FC_TARGET, { recursive: true });
    return undefined;
  }
  return realExecFileSync(file, args, options);
});

const { execute } = require('../src/execute');
const journal = require('../src/journal');
const { listRuns } = require('../src/undo');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// Each test gets its own folder and its own journal folder.
function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-undo-')));
  const journals = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-undo-journals-'));
  const before = process.env.FCTL_JOURNAL_DIR;
  process.env.FCTL_JOURNAL_DIR = journals;
  bin.clear();
  test.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(journals, { recursive: true, force: true });
    if (before === undefined) delete process.env.FCTL_JOURNAL_DIR;
    else process.env.FCTL_JOURNAL_DIR = before;
  });
  return dir;
}

function make(dir, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f);
  }
}

function tree(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${path.relative(dir, path.join(e.parentPath, e.name)).replaceAll(path.sep, '/')}`)
    .sort();
}

// Journal ids sort by time, and runs made in the same second differ only by a random id, so a run is picked by what it is, not by order.
const run = (...argv) => execute(argv);

test('undo after flatten gives back the same folder tree', () => {
  const dir = setup();
  make(dir, ['top.txt', 'one/a.txt', 'one/two/b.txt']);
  const before = tree(dir);
  run('flatten', dir);
  assert.notDeepStrictEqual(tree(dir), before);
  const outcome = run('undo');
  assert.deepStrictEqual(tree(dir), before);
  assert.match(outcome.report, /reversed/);
  assert.strictEqual(outcome.failure, undefined);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'one', 'two', 'b.txt'), 'utf8'), 'one/two/b.txt');
});

test('a file changed after the run is not touched by undo and is reported', () => {
  const dir = setup();
  make(dir, ['a.txt', 'b.txt']);
  fs.mkdirSync(path.join(dir, 'out'));
  run('mv', path.join(dir, 'a.txt'), path.join(dir, 'b.txt'), path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'a.txt'), 'edited after the run, longer');
  const outcome = run('undo');
  // The unchanged file went back, the changed one stayed and is reported.
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'out', 'a.txt'), 'utf8'), 'edited after the run, longer');
  assert.ok(!fs.existsSync(path.join(dir, 'a.txt')));
  assert.match(outcome.report, /\[mismatch\].*changed after the run/);
  assert.ok(outcome.failure, 'the command ends as a failure');
  assert.match(outcome.failure.output, /\[mismatch\]/);
});

test('undo never overwrites a file that took the old name', () => {
  const dir = setup();
  make(dir, ['a.txt']);
  run('rename', path.join(dir, 'a.txt'), 'b.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'new file with the old name');
  const outcome = run('undo');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'new file with the old name');
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  assert.match(outcome.report, /never overwrites/);
});

test('--dry-run shows the plan and changes nothing, and a done undo is not repeated', () => {
  const dir = setup();
  make(dir, ['a.txt']);
  run('rename', path.join(dir, 'a.txt'), 'b.txt');
  const preview = run('undo', '--dry-run');
  assert.match(preview.report, /\[Preview\] Move back/);
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  run('undo');
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
  // The rename run is marked undone; the newest run that is left to undo is the undo itself, which is skipped by default.
  const [undoRun, renameRun] = listRuns();
  assert.strictEqual(undoRun.command, 'undo');
  assert.strictEqual(renameRun.undone, true);
  assert.throws(() => run('undo'), /no run to undo/);
  assert.throws(() => run('undo', `--run=${renameRun.id}`), /already undone/);
});

test('undo --list shows the runs and their state', () => {
  const dir = setup();
  make(dir, ['a.txt']);
  run('rename', path.join(dir, 'a.txt'), 'b.txt');
  run('undo');
  const { report } = run('undo', '--list');
  assert.match(report, /rename\s+1 steps\s+ok\s+\(undone\)/);
  assert.match(report, /undo\s+1 steps\s+ok/);
});

test('cp, write and mkdir are undone, the created files go to the Recycle Bin', () => {
  const dir = setup();
  make(dir, ['a.txt']);
  const before = tree(dir);
  run('cp', path.join(dir, 'a.txt'), path.join(dir, 'c.txt'));
  run('undo');
  run('write', path.join(dir, 'w.txt'), 'hi');
  run('undo');
  run('mkdir', path.join(dir, 'x', 'y'));
  run('undo');
  assert.deepStrictEqual(tree(dir), before);
  assert.ok(bin.has(path.join(dir, 'c.txt')) && bin.has(path.join(dir, 'w.txt')));
});

test('a file removed with rm comes back from the Recycle Bin, unless the path is taken or it is gone', () => {
  const dir = setup();
  make(dir, ['a.txt', 'b.txt']);
  run('rm', path.join(dir, 'a.txt'));
  run('rm', path.join(dir, 'b.txt'));
  const [second, first] = listRuns();
  // The second run (b.txt) is undone first. Its path is free, so it comes back.
  run('undo');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b.txt');
  // For the first run the path is taken by a new file, so nothing is restored over it.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'taken');
  const outcome = run('undo', `--run=${first.id}`);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'taken');
  assert.match(outcome.report, /exists again/);
  assert.ok(second.id !== first.id);
});

test('a permanent delete is reported as irreversible and does not stop the other steps', () => {
  const dir = setup();
  make(dir, ['a.txt']);
  run('rm', '--permanent', path.join(dir, 'a.txt'));
  const outcome = run('undo');
  assert.match(outcome.report, /\[irreversible\].*deleted permanently/);
  assert.strictEqual(outcome.failure, undefined);
  assert.strictEqual(listRuns().find((r) => r.command === 'rm').undone, true);
});

test('a second undo continues with the steps the first one could not do', () => {
  const dir = setup();
  make(dir, ['a.txt', 'b.txt']);
  fs.mkdirSync(path.join(dir, 'out'));
  run('mv', path.join(dir, 'a.txt'), path.join(dir, 'b.txt'), path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'a.txt'), 'changed, so it stays');
  assert.ok(run('undo').failure);
  // The user puts the original content back; the first step stays reversed, the second one now goes.
  fs.writeFileSync(path.join(dir, 'out', 'a.txt'), 'a.txt');
  const mtime = journal.readJournal(listRuns().find((r) => r.command === 'mv').file).steps.find((s) => s.to.endsWith('a.txt')).stamp.mtimeMs;
  fs.utimesSync(path.join(dir, 'out', 'a.txt'), new Date(mtime), new Date(mtime));
  const outcome = run('undo');
  assert.match(outcome.report, /already reversed earlier/);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')) && fs.existsSync(path.join(dir, 'b.txt')));
  assert.strictEqual(outcome.failure, undefined);
});

test('undo refuses a path argument, --force and --permanent, and --list belongs to undo only', () => {
  const dir = setup();
  assert.throws(() => run('undo', dir), /takes no path/);
  assert.throws(() => run('undo', '--force'), /never overwrites/);
  assert.throws(() => run('ls', dir, '--list'), /--list can be used only with undo/);
  assert.throws(() => run('undo', '--run=zzzz'), /No run with the id zzzz/);
});
