'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const { fakeRecycleFiles } = require('./fakeRecycleFiles');

// So that the test does not touch the real Recycle Bin, the batch calls are faked before commands.js is imported (the same way test/flatten.test.js does).
const realExecFileSync = childProcess.execFileSync;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  const state = volumeStateAnswer(options?.env, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  if (options?.env?.FC_RECYCLE_FILES !== undefined) return fakeRecycleFiles(options, () => {});
  if (options?.env?.FC_BATCH !== undefined) {
    const lines = options.input.split('\n').filter(Boolean).map((line) => {
      fs.rmSync(Buffer.from(line, 'base64').toString('utf16le'), { recursive: true });
      return `ok ${line}`;
    });
    return `${lines.join('\r\n')}\r\n`;
  }
  return realExecFileSync(file, args, options);
});

const journal = require('../src/journal');
const { recycleFiles } = require('../src/commands');
const { fileStamp } = require('../src/target');
const { execute } = require('../src/execute');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-journal-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

// Each test writes its journals into its own temporary folder.
function withJournalDir() {
  const before = process.env.FCTL_JOURNAL_DIR;
  const journals = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-journals-'));
  test.after(() => fs.rmSync(journals, { recursive: true, force: true }));
  process.env.FCTL_JOURNAL_DIR = journals;
  return { journals, restore: () => (before === undefined ? delete process.env.FCTL_JOURNAL_DIR : (process.env.FCTL_JOURNAL_DIR = before)) };
}

function runJournaled(argv) {
  const { journals, restore } = withJournalDir();
  try {
    let outcome;
    let error;
    try {
      outcome = execute(argv);
    } catch (err) {
      error = err;
    }
    const files = journal.listJournals(journals);
    return { outcome, error, files, read: files.length ? journal.readJournal(files[0]) : undefined };
  } finally {
    restore();
  }
}

function make(dir, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f);
  }
}

test('mv writes one journal with from and to for each item', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt']);
  fs.mkdirSync(path.join(dir, 'out'));
  const { read, files } = runJournaled(['mv', path.join(dir, 'a.txt'), path.join(dir, 'b.txt'), path.join(dir, 'out')]);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(read.run.command, 'mv');
  assert.strictEqual(read.end.status, 'ok');
  assert.deepStrictEqual(read.steps.map((s) => [s.op, s.from, s.to]), [
    ['move', path.join(dir, 'a.txt'), path.join(dir, 'out', 'a.txt')],
    ['move', path.join(dir, 'b.txt'), path.join(dir, 'out', 'b.txt')],
  ]);
});

test('rename writes a journal step', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  const { read } = runJournaled(['rename', path.join(dir, 'a.txt'), 'b.txt']);
  assert.deepStrictEqual(read.steps.map((s) => [s.op, s.from, s.to]), [['move', path.join(dir, 'a.txt'), path.join(dir, 'b.txt')]]);
});

test('normalize journals every renamed file', () => {
  const dir = tempDir();
  make(dir, ['clip ABC-123.mp4', 'sub/tail_XYZ-999.mkv']);
  const { read, outcome } = runJournaled(['normalize', dir]);
  assert.strictEqual(outcome.result.renamed.length, 2);
  assert.strictEqual(read.run.command, 'normalize');
  assert.strictEqual(read.steps.length, 2);
  for (const step of read.steps) {
    assert.strictEqual(step.op, 'move');
    assert.ok(!fs.existsSync(step.from));
    assert.ok(fs.existsSync(step.to));
  }
});

test('flatten journals every moved file and a preview writes none', () => {
  const dir = tempDir();
  make(dir, ['top.txt', 'one/a.txt', 'one/two/b.txt']);
  assert.strictEqual(runJournaled(['flatten', dir, '--dry-run']).read, undefined);
  const { read } = runJournaled(['flatten', dir]);
  const moves = read.steps.filter((s) => s.op === 'move');
  assert.deepStrictEqual(moves.map((s) => path.basename(s.from)).sort(), ['a.txt', 'b.txt']);
  for (const step of moves) assert.ok(fs.existsSync(step.to));
  // The emptied folders were sent to the Recycle Bin.
  assert.deepStrictEqual(read.steps.filter((s) => s.op === 'recycle').map((s) => s.path).sort(), [path.join(dir, 'one')]);
});

test('a run that fails midway records only the steps that happened', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt']);
  fs.mkdirSync(path.join(dir, 'out'));
  const real = fs.renameSync;
  let calls = 0;
  const mock = test.mock.method(fs, 'renameSync', (from, to) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return real(from, to);
  });
  const { read, error } = runJournaled(['mv', path.join(dir, 'a.txt'), path.join(dir, 'b.txt'), path.join(dir, 'out')]);
  mock.mock.restore();
  assert.ok(error);
  assert.strictEqual(read.end.status, 'failed');
  assert.match(read.end.error, /busy/);
  assert.deepStrictEqual(read.steps.map((s) => path.basename(s.from)), ['a.txt']);
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
});

test('read-only commands, previews and failed checks write no journal', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  assert.strictEqual(runJournaled(['ls', dir]).files.length, 0);
  assert.strictEqual(runJournaled(['rename', path.join(dir, 'a.txt'), 'b.txt', '--dry-run']).files.length, 0);
  assert.strictEqual(runJournaled(['rename', path.join(dir, 'missing.txt'), 'b.txt']).files.length, 0);
});

test('mkdir, write, cp and rm --permanent are journaled', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  assert.deepStrictEqual(runJournaled(['mkdir', path.join(dir, 'x', 'y')]).read.steps.map((s) => [s.op, s.path]), [['create-dir', path.join(dir, 'x')]]);
  const written = runJournaled(['write', path.join(dir, 'x', 'w.txt'), 'hi']).read.steps;
  assert.deepStrictEqual(written.map((s) => [s.op, s.path, s.existed]), [['write', path.join(dir, 'x', 'w.txt'), false]]);
  assert.deepStrictEqual(runJournaled(['cp', path.join(dir, 'a.txt'), path.join(dir, 'c.txt')]).read.steps.map((s) => [s.op, s.from, s.to]), [['copy', path.join(dir, 'a.txt'), path.join(dir, 'c.txt')]]);
  assert.deepStrictEqual(runJournaled(['rm', '--permanent', path.join(dir, 'c.txt')]).read.steps.map((s) => [s.op, s.path]), [['delete', path.join(dir, 'c.txt')]]);
});

test('a journal cut off by a crash still reads back the steps before the cut', () => {
  const dir = tempDir();
  const file = path.join(dir, 'cut.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'run', version: 1 })}\n${JSON.stringify({ type: 'step', seq: 1, op: 'move', from: 'a', to: 'b' })}\n{"type":"step","se`);
  const read = journal.readJournal(file);
  assert.strictEqual(read.steps.length, 1);
  assert.strictEqual(read.end, undefined);
});

test('a journal that cannot be written is reported but does not fail the command', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  const before = process.env.FCTL_JOURNAL_DIR;
  // A file where the journal folder should be makes the folder creation fail.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  process.env.FCTL_JOURNAL_DIR = path.join(blocker, 'journal');
  try {
    const outcome = execute(['rename', path.join(dir, 'a.txt'), 'b.txt']);
    assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
    assert.match(outcome.report, /Warning: could not write the change journal/);
    assert.strictEqual(outcome.failure, undefined);
  } finally {
    if (before === undefined) delete process.env.FCTL_JOURNAL_DIR;
    else process.env.FCTL_JOURNAL_DIR = before;
  }
});

test('files sent to the Recycle Bin in a batch are journaled', () => {
  const dir = tempDir();
  make(dir, ['gone.txt', 'stays.txt']);
  const { journals, restore } = withJournalDir();
  try {
    const run = journal.begin('test', []);
    const file = path.join(dir, 'gone.txt');
    const stamp = fileStamp(fs.lstatSync(file, { bigint: true }));
    const results = recycleFiles([{ path: file, stamp }, { path: path.join(dir, 'stays.txt'), stamp: 'wrong' }]);
    journal.finish(run);
    assert.deepStrictEqual(results.map((r) => r.status), ['ok', 'changed']);
    assert.deepStrictEqual(journal.readJournal(journal.listJournals(journals)[0]).steps.map((s) => [s.op, s.path]), [['recycle', file]]);
  } finally {
    restore();
  }
});

test('rename --force marks the move as a replacement', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt']);
  const forced = runJournaled(['rename', path.join(dir, 'a.txt'), 'b.txt', '--force']).read.steps;
  assert.strictEqual(forced[0].replaced, true);
});

test('write and append keep the content out of the journal header', () => {
  const dir = tempDir();
  const { run } = runJournaled(['write', path.join(dir, 'secret.txt'), 'top secret text']).read;
  assert.deepStrictEqual(run.args, [path.join(dir, 'secret.txt')]);
});

test('zip and unzip journal the output, and extracting into an existing folder says existed', () => {
  const dir = tempDir();
  make(dir, ['src/a.txt']);
  const archive = path.join(dir, 'x.zip');
  const zipped = runJournaled(['zip', archive, path.join(dir, 'src')]).read.steps;
  assert.deepStrictEqual(zipped.map((s) => [s.op, s.path, s.existed]), [['create', archive, false]]);
  const fresh = runJournaled(['unzip', archive, path.join(dir, 'out')]).read.steps;
  assert.deepStrictEqual(fresh.map((s) => [s.op, s.path, s.existed]), [['create', path.join(dir, 'out'), false]]);
  const again = runJournaled(['unzip', archive, path.join(dir, 'out'), '--force']).read.steps;
  assert.strictEqual(again[0].existed, true);
});

test('an unzip that fails after creating the folder still records it', () => {
  const dir = tempDir();
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, 'not a zip');
  const { read, error } = runJournaled(['unzip', bad, path.join(dir, 'out')]);
  assert.ok(error);
  if (fs.existsSync(path.join(dir, 'out'))) assert.deepStrictEqual(read.steps.map((s) => [s.op, s.partial]), [['create', true]]);
  else assert.strictEqual(read, undefined);
});
