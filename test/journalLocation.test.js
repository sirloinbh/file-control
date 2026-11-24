'use strict';

// Where the change journal is written (#415): a hidden .fctl-journal folder inside the folder the command worked on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const { fakeRecycleFiles } = require('./fakeRecycleFiles');

// The helper of npm test and node --test send every journal to one shared folder; these tests are about the real place, so they turn that off.
delete process.env.FCTL_JOURNAL_DIR;
delete process.env.NODE_TEST_CONTEXT;

const realExecFileSync = childProcess.execFileSync;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  const env = options?.env ?? {};
  const state = volumeStateAnswer(env, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  if (env.FC_RECYCLE_FILES !== undefined) return fakeRecycleFiles(options, () => {});
  if (env.FC_TARGET !== undefined) {
    fs.rmSync(env.FC_TARGET, { recursive: true });
    return undefined;
  }
  return realExecFileSync(file, args, options);
});

const { execute } = require('../src/execute');
const journal = require('../src/journal');
const { walk } = require('../src/target');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-jloc-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f);
  }
}

const run = (...argv) => execute(argv);
// The folders that hold a .fctl-journal under the root, as paths relative to it ('.' for the root itself).
function journalFolders(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === '.fctl-journal')
    .map((entry) => path.relative(root, path.dirname(path.join(entry.parentPath, entry.name))) || '.')
    .sort();
}
const runsIn = (folder) => journal.listJournals(path.join(folder, '.fctl-journal')).map((file) => journal.readJournal(file).run.command);

test('a whole-target command keeps its journal in the target folder', () => {
  const dir = tempDir();
  make(dir, ['a.jpg', 'b.jpg']);
  run('rename-pattern', dir, '--number=p{n}');
  assert.deepStrictEqual(journalFolders(dir), ['.']);
  assert.deepStrictEqual(runsIn(dir), ['rename-pattern']);
});

test('rename keeps it in the folder of the item', () => {
  const dir = tempDir();
  make(dir, ['sub/a.txt']);
  run('rename', path.join(dir, 'sub', 'a.txt'), 'b.txt');
  assert.deepStrictEqual(journalFolders(dir), ['sub']);
});

test('mkdir and write keep it in the nearest folder that already existed', () => {
  const dir = tempDir();
  run('mkdir', path.join(dir, 'x', 'y', 'z'));
  run('write', path.join(dir, 'x', 'note.txt'), 'hello');
  assert.deepStrictEqual(journalFolders(dir), ['.', 'x']);
});

test('mv and cp keep it in the destination folder, whatever the sources', () => {
  const dir = tempDir();
  make(dir, ['one/a.txt', 'two/b.txt', 'dest/keep.txt']);
  run('mv', path.join(dir, 'one', 'a.txt'), path.join(dir, 'two', 'b.txt'), path.join(dir, 'dest'));
  assert.deepStrictEqual(journalFolders(dir), ['dest']);
  run('cp', path.join(dir, 'dest', 'a.txt'), path.join(dir, 'copy.txt'));
  assert.deepStrictEqual(journalFolders(dir), ['.', 'dest']);
});

test('rm keeps it in the common folder of the paths, and in the folder of the first path when they share only a drive', () => {
  const dir = tempDir();
  make(dir, ['a/x/1.txt', 'a/y/2.txt', 'b/3.txt']);
  run('rm', path.join(dir, 'a', 'x', '1.txt'), path.join(dir, 'a', 'y', '2.txt'));
  assert.deepStrictEqual(journalFolders(dir), ['a']);
  run('rm', path.join(dir, 'b', '3.txt'));
  assert.deepStrictEqual(journalFolders(dir), ['a', 'b']);
});

test('zip and unzip keep it in the folder that holds the output', () => {
  const dir = tempDir();
  make(dir, ['src/a.txt', 'out/keep.txt']);
  run('zip', path.join(dir, 'out', 'a.zip'), path.join(dir, 'src'));
  assert.deepStrictEqual(journalFolders(dir), ['out']);
  run('unzip', path.join(dir, 'out', 'a.zip'), path.join(dir, 'unpacked'));
  assert.deepStrictEqual(journalFolders(dir), ['.', 'out']);
});

test('a preview or a read-only command writes no journal', () => {
  const dir = tempDir();
  make(dir, ['a.jpg']);
  run('rename-pattern', dir, '--number=p{n}', '--dry-run');
  run('ls', dir);
  run('find-broken', dir);
  assert.deepStrictEqual(journalFolders(dir), []);
});

test('listings never show the journal folder, so a later command does not touch it', () => {
  const dir = tempDir();
  make(dir, ['a.jpg', 'b.jpg']);
  run('rename-pattern', dir, '--number=p{n}');
  assert.ok(fs.existsSync(path.join(dir, '.fctl-journal')));
  assert.deepStrictEqual(walk(dir).map((entry) => entry.relative).sort(), ['p1.jpg', 'p2.jpg']);
  // A second run numbers only the two files and does not move the journal.
  run('rename-pattern', dir, '--case=upper');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['.fctl-journal', 'P1.jpg', 'P2.jpg']);
});

test('undo looks in the current folder or --target, and --list shows that folder only', () => {
  const dir = tempDir();
  const other = tempDir();
  make(dir, ['a.txt']);
  make(other, ['z.txt']);
  run('rename', path.join(dir, 'a.txt'), 'b.txt');
  run('rename', path.join(other, 'z.txt'), 'y.txt');
  const here = run('undo', '--list', `--target=${dir}`).result;
  assert.deepStrictEqual(here.map((item) => item.command), ['rename']);
  run('undo', `--target=${dir}`);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name !== '.fctl-journal'), ['a.txt']);
  assert.ok(fs.existsSync(path.join(other, 'y.txt')), 'the other folder was not touched');
  // From a folder that has no journal there is nothing to undo.
  const before = process.cwd();
  process.chdir(other);
  try {
    assert.deepStrictEqual(run('undo', '--list').result.length, 1);
  } finally {
    process.chdir(before);
  }
  assert.throws(() => run('undo', `--target=${tempDir()}`), /no run to undo/);
});

test('--target belongs to undo only', () => {
  assert.throws(() => run('ls', tempDir(), '--target=x'), /--target can be used only with undo/);
});

test('collapse treats a folder that only holds its own journal as emptied', () => {
  const dir = tempDir();
  make(dir, ['a/b/c/f.txt']);
  run('rename', path.join(dir, 'a', 'b', 'c', 'f.txt'), 'g.txt');
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'c', '.fctl-journal')));
  const out = run('collapse', dir);
  assert.deepStrictEqual(out.result.failed, [], out.report);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'g.txt')) || fs.existsSync(path.join(dir, 'g.txt')), out.report);
});

test('undo does not follow a journal that was copied from another folder', () => {
  const dir = tempDir();
  const copy = tempDir();
  make(dir, ['a.txt']);
  run('rename', path.join(dir, 'a.txt'), 'b.txt');
  fs.cpSync(path.join(dir, '.fctl-journal'), path.join(copy, '.fctl-journal'), { recursive: true });
  assert.throws(() => run('undo', `--target=${copy}`), /was written for .* but sits in/);
  // --list only shows, so it still works.
  assert.strictEqual(run('undo', '--list', `--target=${copy}`).result.length, 1);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name !== '.fctl-journal'), ['b.txt']);
});

test('undo does not follow a journal without a recorded folder', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.fctl-journal'));
  const line = (object) => `${JSON.stringify(object)}\n`;
  fs.writeFileSync(path.join(dir, '.fctl-journal', 'fctl-journal-2026-01-01-000000-000-deadbeef.jsonl'), line({ type: 'run', version: 1, runId: 'deadbeef', command: 'rename', args: [], startedAt: 'x' }) + line({ type: 'step', seq: 1, op: 'move', from: path.join(dir, 'x'), to: path.join(dir, 'y') }));
  assert.throws(() => run('undo', `--target=${dir}`), /does not say which folder/);
});

test('a journal step that points into a protected place is not touched', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  run('rename', path.join(dir, 'a.txt'), 'b.txt');
  const file = journal.listJournals(path.join(dir, '.fctl-journal'))[0];
  const protectedTarget = path.join(process.env.SystemRoot ?? String.fromCharCode(67, 58, 92) + 'Windows', 'fctl-should-not-exist.txt');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(JSON.stringify(path.join(dir, 'a.txt'))).join(JSON.stringify(protectedTarget)));
  const outcome = (() => {
    try {
      return run('undo', `--target=${dir}`);
    } catch (err) {
      return err;
    }
  })();
  assert.match(String(outcome.report ?? outcome.message), /protected path/);
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  assert.ok(!fs.existsSync(protectedTarget));
});

test('a journal folder that is a link is not written through', (t) => {
  const dir = tempDir();
  const elsewhere = tempDir();
  make(dir, ['a.txt']);
  try {
    fs.symlinkSync(elsewhere, path.join(dir, '.fctl-journal'), 'junction');
  } catch {
    t.skip('links are not available');
    return;
  }
  const out = run('rename', path.join(dir, 'a.txt'), 'b.txt');
  assert.match(out.report, /could not write the change journal/);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
});
