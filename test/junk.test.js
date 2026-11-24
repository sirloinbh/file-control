'use strict';

// find-junk and remove-junk (#391): the junk rules, the age limit for installers, and the shared confirmed-remove flow.
// The Recycle Bin is faked (same approach as sameContent.test.js), so a real run never touches the real Recycle Bin.

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temp folder is under the user's AppData, a protected path, so the user folder is swapped with a path that does not exist.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const realExecFileSync = childProcess.execFileSync;
const recycled = [];
const inputs = [];
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) return 'NTFS\r\n';
  const state = volumeStateAnswer(options?.env, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  if (options?.env?.FC_RECYCLE_FILES !== undefined) {
    const lines = [];
    inputs.push(options.input);
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

// Files made just now are protected from removal (5 minutes), and unfinished downloads for a day, so the clock is moved forward 2 days.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const realNow = Date.now;
test.mock.method(Date, 'now', () => realNow() + 2 * DAY);

const { findJunk, formatJunk, removeJunk, formatRemoveJunk, copyOriginal } = require('../src/junk');
const { run } = require('../bin/fctl');
const { REMOVAL_LOG } = require('../src/removalLog');
const { logs, readRecord } = require('./removalRecord');

const OLD = new Date(realNow() - HOUR);
// A time one minute before the faked clock: recent enough to be held.
const JUST_NOW = () => new Date(realNow() + 2 * DAY - 60 * 1000);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-junk-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files, when = OLD) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, when, when);
  }
}

const rel = (dir, file) => path.relative(dir, file).split(path.sep).join('/');
const junkOf = (dir, result) => Object.fromEntries(result.junk.map((item) => [rel(dir, item.path), item.reason]));
const names = (dir) => fs.readdirSync(dir, { recursive: true }).map((p) => p.split(path.sep).join('/')).filter((p) => !REMOVAL_LOG.test(path.basename(p))).sort();

test.beforeEach(() => {
  recycled.length = 0;
  inputs.length = 0;
});

test('copyOriginal reads the (N) a browser or Explorer adds before the extension', () => {
  assert.strictEqual(copyOriginal('report (1).pdf'), 'report.pdf');
  assert.strictEqual(copyOriginal('backup (12).tar.gz'), 'backup.tar.gz');
  assert.strictEqual(copyOriginal('my.file (3).pdf'), 'my.file.pdf');
  assert.strictEqual(copyOriginal('noext (2)'), 'noext');
  assert.strictEqual(copyOriginal('report.pdf'), null);
  assert.strictEqual(copyOriginal('report(1).pdf'), null);
  assert.strictEqual(copyOriginal('(1).pdf'), null);
});

test('find-junk lists unfinished downloads, empty files and temp files with their reasons, and changes nothing', () => {
  const dir = tempDir();
  make(dir, { 'a.crdownload': 'half', 'b.part': 'half', 'empty.txt': '', 'c.tmp': 'x', '~$doc.docx': 'lock', 'keep.pdf': 'real', 'sub/d.TEMP': 'x' });
  const before = names(dir);
  const output = run(['find-junk', dir]);
  const junk = junkOf(dir, findJunk(dir));
  assert.deepStrictEqual(Object.keys(junk), ['a.crdownload', 'b.part', 'c.tmp', 'empty.txt', 'sub/d.TEMP', '~$doc.docx']);
  assert.strictEqual(junk['a.crdownload'], 'unfinished download');
  assert.strictEqual(junk['empty.txt'], 'empty file (0 bytes)');
  assert.strictEqual(junk['c.tmp'], 'temporary file');
  assert.match(output, /Junk: a\.crdownload \(unfinished download; 4 B\)/);
  assert.match(output, /Junk 6 \(/);
  assert.deepStrictEqual(names(dir), before);
  assert.deepStrictEqual(recycled, []);
});

test('a "name (1).ext" copy is junk only when its bytes equal the original beside it', () => {
  const dir = tempDir();
  make(dir, { 'a.pdf': 'same bytes', 'a (1).pdf': 'same bytes', 'a (2).pdf': 'other bytes', 'b.txt': 'abc', 'b (1).txt': 'abd', 'lonely (1).txt': 'no original' });
  const result = findJunk(dir);
  assert.deepStrictEqual(junkOf(dir, result), { 'a (1).pdf': 'copy of a.pdf, with exactly the same content' });
  assert.strictEqual(rel(dir, result.junk[0].keep), 'a.pdf');
});

test('a copy whose original is also junk is not listed as a copy, so the original is never the only thing that goes', () => {
  const dir = tempDir();
  make(dir, { 'x.tmp': 'same', 'x (1).tmp': 'same' });
  const reasons = junkOf(dir, findJunk(dir));
  assert.deepStrictEqual(reasons, { 'x (1).tmp': 'temporary file', 'x.tmp': 'temporary file' });
});

test('installers are listed only past the age limit, measured from the later of the modified and creation times', () => {
  const dir = tempDir();
  make(dir, { 'setup.exe': 'MZ', 'tool.msi': 'MSI', 'readme.txt': 'text' });
  const at = (days) => realNow() + days * DAY;
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir, { now: at(29) }))), []);
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir, { now: at(31) }))), ['setup.exe', 'tool.msi']);
  assert.match(junkOf(dir, findJunk(dir, { now: at(31) }))['setup.exe'], /installer not touched for 3[01] days \(limit 30 days\)/);
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir, { now: at(31), older: '60d' }))), []);
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir, { now: at(8), older: '1w' }))), ['setup.exe', 'tool.msi']);
  assert.throws(() => findJunk(dir, { older: 'soon' }), /--older needs an age/);
  // An old modified time alone does not make a freshly copied installer junk.
  const fresh = path.join(dir, 'fresh.exe');
  fs.writeFileSync(fresh, 'MZ');
  fs.utimesSync(fresh, new Date(2015, 0, 1), new Date(2015, 0, 1));
  assert.ok(!('fresh.exe' in junkOf(dir, findJunk(dir, { now: realNow() + 1 * DAY }))));
});

test('an installer next to a DLL is a program, not an installer, and is not listed', () => {
  const dir = tempDir();
  make(dir, { 'app/app.exe': 'MZ', 'app/lib.dll': 'DLL', 'setup.exe': 'MZ' });
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir, { older: '0d' }))), ['setup.exe']);
  const withDll = tempDir();
  make(withDll, { 'game.exe': 'MZ', 'lib.dll': 'DLL' });
  assert.deepStrictEqual(Object.keys(junkOf(withDll, findJunk(withDll, { older: '0d' }))), []);
});

test('project folders, program folders, removal logs and files changed a moment ago are left alone', () => {
  const dir = tempDir();
  make(dir, { 'proj/package.json': '{}', 'proj/x.tmp': 'x', 'node_modules/y/z.tmp': 'x', 'fctl-removed-2026-01-01-000000.json': '', 'ok.tmp': 'x' });
  make(dir, { 'new.tmp': 'x' }, JUST_NOW());
  const result = findJunk(dir);
  assert.deepStrictEqual(Object.keys(junkOf(dir, result)), ['ok.tmp']);
  assert.deepStrictEqual(result.kept.map((item) => rel(dir, item.path)), ['new.tmp']);
});

test('remove-junk without --yes shows the list and a value and deletes nothing; --dry-run too', () => {
  const dir = tempDir();
  make(dir, { 'a.crdownload': 'half', 'keep.pdf': 'real' });
  const output = run(['remove-junk', dir]);
  assert.match(output, /To delete: a\.crdownload \(unfinished download; 4 B\)/);
  assert.match(output, /Nothing has been deleted yet\. After checking the list, run again with --yes=[0-9a-f]{12}/);
  const code = removeJunk(dir).code;
  assert.match(run(['remove-junk', dir, '--yes=' + code, '--dry-run']), /without --dry-run and with --yes=/);
  assert.deepStrictEqual(names(dir), ['a.crdownload', 'keep.pdf']);
  assert.deepStrictEqual(recycled, []);
});

test('remove-junk --yes=VALUE sends only the listed files to the Recycle Bin and writes a removal log', () => {
  const dir = tempDir();
  make(dir, { 'a.crdownload': 'half', 'empty.txt': '', 'doc.pdf': 'real', 'doc (1).pdf': 'real', 'other.pdf': 'real2' });
  const code = removeJunk(dir).code;
  const output = run(['remove-junk', dir, `--yes=${code}`]);
  assert.match(output, /Recycle Bin 3, failed 0/);
  assert.deepStrictEqual(names(dir), ['doc.pdf', 'other.pdf']);
  assert.deepStrictEqual(recycled.map((p) => path.basename(p)).sort(), ['a.crdownload', 'doc (1).pdf', 'empty.txt']);
  assert.strictEqual(logs(dir).length, 1);
  assert.deepStrictEqual(names(dir), ['doc.pdf', 'other.pdf']);
  const log = readRecord(logs(dir)[0]);
  assert.strictEqual(log.items.length, 3);
  assert.ok(log.items.every((item) => item.outcome === 'removed'));
  assert.ok(log.items.some((item) => /copy of doc\.pdf/.test(item.reason)));
});

test('a changed list rejects the value and nothing is deleted', () => {
  const dir = tempDir();
  make(dir, { 'a.crdownload': 'half' });
  const code = removeJunk(dir).code;
  make(dir, { 'b.part': 'half' });
  assert.throws(() => run(['remove-junk', dir, `--yes=${code}`]), /The list differs/);
  assert.deepStrictEqual(names(dir), ['a.crdownload', 'b.part']);
  assert.deepStrictEqual(recycled, []);
  const result = removeJunk(dir, { confirm: code });
  assert.strictEqual(result.mismatch, true);
  assert.match(formatRemoveJunk(result), /The list changed after the confirmation value was made/);
});

test('the age limit changes the list, so a value made with another limit is rejected', () => {
  const dir = tempDir();
  make(dir, { 'setup.exe': 'MZ' });
  const code = removeJunk(dir, { older: '0d' }).code;
  assert.strictEqual(removeJunk(dir, { older: '0d' }).removals.length, 1);
  assert.strictEqual(removeJunk(dir, { older: '60d' }).removals.length, 0);
  assert.strictEqual(removeJunk(dir, { older: '60d', confirm: code }).mismatch, true);
  assert.deepStrictEqual(names(dir), ['setup.exe']);
  run(['remove-junk', dir, '--older=0d', `--yes=${code}`]);
  assert.deepStrictEqual(names(dir), []);
});

test('a copy whose original changed after the list was made is not deleted (the value covers the original too)', () => {
  const dir = tempDir();
  make(dir, { 'doc.pdf': 'real', 'doc (1).pdf': 'real' });
  const code = removeJunk(dir).code;
  // The original of the copy is rewritten after the list was made.
  fs.writeFileSync(path.join(dir, 'doc.pdf'), 'changed after');
  fs.utimesSync(path.join(dir, 'doc.pdf'), OLD, OLD);
  assert.throws(() => run(['remove-junk', dir, `--yes=${code}`]), /The list differs/);
  assert.deepStrictEqual(names(dir), ['doc (1).pdf', 'doc.pdf']);
  assert.deepStrictEqual(recycled, []);
});

test('a junk file that changed after the list was made makes the value stale, so nothing is deleted', () => {
  const dir = tempDir();
  make(dir, { 'a.tmp': 'x' });
  const code = removeJunk(dir).code;
  fs.writeFileSync(path.join(dir, 'a.tmp'), 'now it has more content');
  fs.utimesSync(path.join(dir, 'a.tmp'), OLD, OLD);
  assert.strictEqual(removeJunk(dir, { confirm: code }).mismatch, true);
  assert.deepStrictEqual(recycled, []);
});

test('--yes without a value is refused and --older is refused on other commands', () => {
  const dir = tempDir();
  assert.throws(() => run(['remove-junk', dir, '--yes']), /--yes=VALUE/);
  assert.throws(() => run(['flatten', dir, '--older=30d']), /--older can be used only with find, find-junk and remove-junk\./);
  assert.throws(() => run(['find-junk', dir, '--larger=1MB']), /--larger can be used only with find/);
  assert.throws(() => run(['find-junk', dir, '--yes=abc']), /--yes can be used only with/);
});

test('the report formats list junk, kept and totals', () => {
  const dir = tempDir();
  make(dir, { 'a.part': 'x'.repeat(2048) });
  assert.match(formatJunk(findJunk(dir)), /Junk: a\.part \(unfinished download; 2\.0 KB\)\nJunk 1 \(2\.0 KB\), kept 0, skipped 0/);
});

test('installers are listed only directly in the target, not in subfolders', () => {
  const dir = tempDir();
  make(dir, { 'setup.exe': 'MZ', 'tools/bin/helper.exe': 'MZ', 'Game/Setup.exe': 'MZ', 'Game/redist/vcredist.msi': 'MSI' });
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir, { older: '0d' }))), ['setup.exe']);
});

test('empty files that programs need are not junk: dotfiles, __init__.py, lock and pid files', () => {
  const dir = tempDir();
  make(dir, { '.gitkeep': '', '.nomedia': '', '.npmrc': '', 'pkg/__init__.py': '', 'py.typed': '', 'db.lock': '', 'app.pid': '', 'empty.txt': '', 'notes.docx': '' });
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir))), ['empty.txt', 'notes.docx']);
});

test('an unfinished download changed less than a day ago is kept, because it may be resumed', () => {
  const dir = tempDir();
  make(dir, { 'a.crdownload': 'half' });
  const young = findJunk(dir, { now: realNow() + HOUR });
  assert.deepStrictEqual(young.junk, []);
  assert.match(young.kept[0].reason, /less than a day ago, so it may be resumed/);
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir, { now: realNow() + 2 * DAY }))), ['a.crdownload']);
});

test('a copy is kept while the file it copies changed a moment ago (it may still be written)', () => {
  const dir = tempDir();
  make(dir, { 'a (1).pdf': 'same' });
  make(dir, { 'a.pdf': 'same' }, JUST_NOW());
  const result = findJunk(dir);
  assert.deepStrictEqual(result.junk, []);
  assert.match(result.kept[0].reason, /the file it may copy \(a\.pdf\) is recent/);
});

test('a copy of a copy is not listed, so a chain never loses its middle', () => {
  const dir = tempDir();
  make(dir, { 'a.pdf': 'same', 'a (1).pdf': 'same', 'a (1) (1).pdf': 'same' });
  assert.deepStrictEqual(Object.keys(junkOf(dir, findJunk(dir))), ['a (1).pdf']);
});

test('the file a copy duplicates goes along to the last-moment check and into the removal log', () => {
  const dir = tempDir();
  make(dir, { 'doc.pdf': 'real', 'doc (1).pdf': 'real' });
  const code = removeJunk(dir).code;
  const result = removeJunk(dir, { confirm: code });
  assert.strictEqual(result.removed.length, 1);
  assert.strictEqual(inputs.length, 1);
  const fields = inputs[0].trim().split(' ');
  assert.strictEqual(fields.length, 4, 'path, stamp, keeper path and keeper stamp');
  assert.strictEqual(Buffer.from(fields[2], 'base64').toString('utf16le'), path.join(dir, 'doc.pdf'));
  const log = readRecord(result.log);
  assert.strictEqual(log.items[0].details.keep, path.join(dir, 'doc.pdf'));
});

test('a keeper that changed a moment ago stops the copy from being sent', () => {
  const dir = tempDir();
  make(dir, { 'doc.pdf': 'real', 'doc (1).pdf': 'real' });
  const code = removeJunk(dir).code;
  const result = removeJunk(dir, {
    confirm: code,
    onProgress: (line) => {
      // After the log is written and before the copy is checked: the keeper is touched without changing its stamp.
      if (/^Sending to the Recycle Bin/.test(line)) fs.utimesSync(path.join(dir, 'doc.pdf'), JUST_NOW(), JUST_NOW());
    },
  });
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0].reason, /the file it copies (changed|changed just now)/);
  assert.deepStrictEqual(names(dir), ['doc (1).pdf', 'doc.pdf']);
});
