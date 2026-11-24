'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');

const realExecFileSync = childProcess.execFileSync;
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  const state = volumeStateAnswer(options?.env ?? {}, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  return realExecFileSync(file, args, options);
});

const { execute } = require('../src/execute');
const { applyRules, parseRules } = require('../src/renamePattern');

// The temporary folder is under AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pattern-'));
  const journals = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pattern-journals-'));
  const before = process.env.FCTL_JOURNAL_DIR;
  process.env.FCTL_JOURNAL_DIR = journals;
  test.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(journals, { recursive: true, force: true });
    if (before === undefined) delete process.env.FCTL_JOURNAL_DIR;
    else process.env.FCTL_JOURNAL_DIR = before;
  });
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f);
  }
}

const names = (dir) => fs.readdirSync(dir).sort();
const run = (...argv) => execute(argv);
// A refused or failed command throws; the text of what it reports is in err.report or err.message.
function outcome(...argv) {
  try {
    return String(run(...argv).report);
  } catch (err) {
    return String(err.report ?? err.message);
  }
}

test('--number zero-pads and follows the name order, numbers inside names compare as numbers', () => {
  const dir = tempDir();
  make(dir, ['b 10.jpg', 'b 2.jpg', 'a 1.jpg', 'notes.txt']);
  run('rename-pattern', dir, '--number=photo_{n:3}');
  assert.deepStrictEqual(names(dir), ['photo_001.jpg', 'photo_002.jpg', 'photo_003.jpg', 'photo_004.txt']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'photo_001.jpg'), 'utf8'), 'a 1.jpg');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'photo_002.jpg'), 'utf8'), 'b 2.jpg');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'photo_003.jpg'), 'utf8'), 'b 10.jpg');
});

test('--number works with a Korean template and braces can be escaped', () => {
  const dir = tempDir();
  make(dir, ['x.jpg', 'y.jpg']);
  run('rename-pattern', dir, '--number=사진_{n:3}{{ok}}');
  assert.deepStrictEqual(names(dir), ['사진_001{ok}.jpg', '사진_002{ok}.jpg']);
});

test('--dry-run changes nothing and lists the renames', () => {
  const dir = tempDir();
  make(dir, ['a.jpg']);
  const out = run('rename-pattern', dir, '--number=p{n}', '--dry-run');
  assert.match(out.report, /\[Preview\] Rename: a\.jpg -> p1\.jpg/);
  assert.deepStrictEqual(names(dir), ['a.jpg']);
});

test('--replace is a regular expression with groups, /i ignores case, and an escaped slash is a slash', () => {
  const dir = tempDir();
  make(dir, ['IMG_001.jpg', 'img_002.jpg', 'a b.txt']);
  run('rename-pattern', dir, '--replace=img_(\\d+)/photo-$1/i');
  assert.deepStrictEqual(names(dir), ['a b.txt', 'photo-001.jpg', 'photo-002.jpg']);
  run('rename-pattern', dir, '--replace=\\s/_');
  assert.ok(names(dir).includes('a_b.txt'));
  assert.strictEqual(applyRules(parseRules({ replace: 'a\\/b/c' }), 'a/b', 1), 'c');
});

test('the rules run in a fixed order: replace, case, number, date prefix', () => {
  const rules = parseRules({ replace: 'x/y', caseMode: 'upper', number: '{name}-{n:2}', datePrefix: true });
  assert.strictEqual(applyRules(rules, 'axb', 7, new Date(2024, 0, 5)), '2024-01-05 AYB-07');
  // The prefix is not added twice.
  assert.strictEqual(applyRules(parseRules({ datePrefix: true }), '2024-01-05 a', 1, new Date(2024, 0, 5)), '2024-01-05 a');
});

test('--case changes the name but keeps the extension, and a case-only rename works on the file itself', () => {
  const dir = tempDir();
  make(dir, ['Photo One.JPG']);
  run('rename-pattern', dir, '--case=lower');
  assert.deepStrictEqual(names(dir), ['photo one.JPG']);
});

test('--date-prefix uses the modified date', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  const when = new Date(2023, 5, 7, 12);
  fs.utimesSync(path.join(dir, 'a.txt'), when, when);
  run('rename-pattern', dir, '--date-prefix');
  assert.deepStrictEqual(names(dir), ['2023-06-07 a.txt']);
});

test('a rule that makes two names collide changes nothing and reports the clash', () => {
  const dir = tempDir();
  make(dir, ['a1.txt', 'a2.txt', 'b.txt']);
  const text = outcome('rename-pattern', dir, '--replace=\\d/');
  assert.deepStrictEqual(names(dir), ['a1.txt', 'a2.txt', 'b.txt']);
  assert.match(text, /Another file would get the same name/);
  assert.match(text, /Nothing was renamed/);
});

test('a new name that already exists stops the whole run (no overwriting)', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  // a -> c clashes with c; d -> e would be fine, but nothing is renamed.
  const text = outcome('rename-pattern', dir, '--replace=^[ad]/c');
  assert.match(text, /The name already exists|Another file would get the same name/);
  assert.deepStrictEqual(names(dir), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
});

test('a name Windows cannot use stops the run', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b']);
  const bad = outcome('rename-pattern', dir, '--replace=^[ab]/x:');
  assert.match(bad, /character Windows does not allow/);
  const dot = outcome('rename-pattern', dir, '--replace=^b$/b.');
  assert.match(dot, /ends with a dot or a space/);
  assert.deepStrictEqual(names(dir), ['a.txt', 'b']);
});

test('subfolders are left alone unless --recursive, and each folder is numbered on its own', () => {
  const dir = tempDir();
  make(dir, ['a.jpg', 'sub/b.jpg', 'sub/c.jpg']);
  run('rename-pattern', dir, '--number=n{n}');
  assert.deepStrictEqual(names(dir), ['n1.jpg', 'sub']);
  assert.deepStrictEqual(names(path.join(dir, 'sub')), ['b.jpg', 'c.jpg']);
  run('rename-pattern', dir, '--number=m{n}', '--recursive');
  assert.deepStrictEqual(names(path.join(dir, 'sub')), ['m1.jpg', 'm2.jpg']);
});

test('a video takes its subtitle along and the subtitle is not numbered on its own', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'b.mp4']);
  run('rename-pattern', dir, '--number=v{n}');
  assert.deepStrictEqual(names(dir), ['v1.mp4', 'v1.srt', 'v2.mp4']);
});

test('the change is in the journal, so undo puts the names back', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt']);
  run('rename-pattern', dir, '--number=f{n}');
  run('undo');
  assert.deepStrictEqual(names(dir), ['a.txt', 'b.txt']);
});

test('bad options are refused before anything changes', () => {
  const dir = tempDir();
  make(dir, ['a.txt']);
  assert.throws(() => run('rename-pattern', dir), /at least one rule/);
  assert.throws(() => run('rename-pattern', dir, '--case=title'), /upper or lower/);
  assert.throws(() => run('rename-pattern', dir, '--replace=abc'), /--replace needs the form/);
  assert.throws(() => run('rename-pattern', dir, '--replace=(/x'), /invalid regular expression/);
  assert.throws(() => run('rename-pattern', dir, '--number=abc'), /needs \{n\}/);
  assert.throws(() => run('rename-pattern', dir, '--number={n}{x}'), /not a placeholder/);
  assert.throws(() => run('rename', path.join(dir, 'a.txt'), 'b.txt', '--date-prefix'), /--date-prefix can be used only with rename-pattern/);
  assert.throws(() => run('ls', dir, '--number=x{n}'), /--number can be used only with rename-pattern/);
  assert.deepStrictEqual(names(dir), ['a.txt']);
});

test('a name taken for a subtitle refuses the whole run, and a device name is refused', () => {
  const dir = tempDir();
  make(dir, ['a.mp4', 'a.srt', 'b.srt', 'c.txt']);
  const text = outcome('rename-pattern', dir, '--replace=^[ac]/b');
  assert.match(text, /Nothing was renamed/);
  assert.deepStrictEqual(names(dir), ['a.mp4', 'a.srt', 'b.srt', 'c.txt']);
  const device = outcome('rename-pattern', dir, '--replace=^c$/nul');
  assert.match(device, /opens this name as a device/);
  assert.match(device, /Nothing was renamed/);
  assert.deepStrictEqual(names(dir), ['a.mp4', 'a.srt', 'b.srt', 'c.txt']);
});

test('numbers have no gap for a file that is left alone (a download in progress)', () => {
  const dir = tempDir();
  make(dir, ['a.txt', 'b.txt.crdownload', 'c.txt']);
  run('rename-pattern', dir, '--number=p{n}');
  assert.deepStrictEqual(names(dir), ['b.txt.crdownload', 'p1.txt', 'p2.txt']);
});

test('a target name that another file is about to leave is still refused (no shifting)', () => {
  const dir = tempDir();
  make(dir, ['1.txt', '2.txt', '00.txt']);
  const text = outcome('rename-pattern', dir, '--number={n}');
  assert.match(text, /The name already exists/);
  assert.deepStrictEqual(names(dir), ['00.txt', '1.txt', '2.txt']);
});
