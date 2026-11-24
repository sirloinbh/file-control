'use strict';

// clean-downloads (#392): one combined plan (junk, photos, documents, the rest), one confirmation value, the real Downloads folder lookup.
// The Recycle Bin and the registry are faked, so a test never touches the real Recycle Bin or the real Downloads folder.

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const samples = require('./exifSamples');

// The temp folder is under the user's AppData, a protected path, so the user folder is swapped with a path that does not exist.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

const realExecFileSync = childProcess.execFileSync;
const recycled = [];
// What the faked "reg query" answers: a function returning the output, or null to fail like a missing key.
let registry = () => null;
const regFiles = [];
// The answer of the faked Recycle Bin state check (interactive|drive type).
let volume = () => 'True|Fixed\r\n';
// File names whose move to the Recycle Bin fails.
const failing = new Set();
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (path.basename(file) === 'reg.exe') {
    regFiles.push(file);
    const answer = registry();
    if (answer === null) throw new Error('key not found');
    return answer;
  }
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) return 'NTFS\r\n';
  const state = volumeStateAnswer(options?.env, () => volume());
  if (state !== undefined) return state;
  if (options?.env?.FC_RECYCLE_FILES !== undefined) {
    const lines = [];
    for (const line of options.input.split('\n').filter(Boolean)) {
      const [encoded] = line.split(' ');
      const target = Buffer.from(encoded, 'base64').toString('utf16le');
      if (failing.has(path.basename(target))) {
        lines.push(`error ${encoded} ${Buffer.from('The file is in use.', 'utf16le').toString('base64')}`);
        continue;
      }
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

const { downloadsFolder, planClean, cleanDownloads, formatClean } = require('../src/cleanDownloads');
const { run } = require('../bin/fctl');
const { REMOVAL_LOG } = require('../src/removalLog');

const OLD = new Date(realNow() - HOUR);
const JUST_NOW = () => new Date(realNow() + 2 * DAY - 60 * 1000);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-clean-'));
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

const names = (dir) => fs.readdirSync(dir, { recursive: true }).map((p) => p.split(path.sep).join('/')).filter((p) => !REMOVAL_LOG.test(path.basename(p))).sort();

// A Downloads folder with something of every kind.
function downloads() {
  const dir = tempDir();
  make(dir, {
    'photo.jpg': samples.jpeg('2023:05:09 08:00:00'),
    'Screenshot_1.png': samples.png('2021:01:01 00:00:00'),
    'empty.jpg': '',
    'doc.pdf': 'real pdf',
    'doc (1).pdf': 'real pdf',
    'report.docx': 'word',
    'movie.mp4': 'video',
    'archive.zip': 'zip',
    'song.mp3': 'audio',
    'weird.xyz': 'unknown',
    'setup.exe': 'MZ',
    'x.crdownload': 'half',
    'sub/inside.txt': 'stays',
  });
  make(dir, { 'new.tmp': 'being written' }, JUST_NOW());
  return dir;
}

test.beforeEach(() => {
  recycled.length = 0;
  failing.clear();
  registry = () => null;
  regFiles.length = 0;
  volume = () => 'True|Fixed\r\n';
});

test('--dry-run shows junk, photos, documents and other files in one list and changes nothing', () => {
  const dir = downloads();
  const before = names(dir);
  const out = run(['clean-downloads', dir, '--older=0d', '--dry-run']);
  assert.deepStrictEqual(names(dir), before);
  assert.deepStrictEqual(recycled, []);
  for (const line of [
    'To delete (junk): empty.jpg (empty file (0 bytes);',
    'To delete (junk): x.crdownload (unfinished download;',
    'To delete (junk): doc (1).pdf (copy of doc.pdf, with exactly the same content;',
    'To delete (junk): setup.exe (installer not touched for',
    `To move (photos): photo.jpg -> ${path.join('2023', '2023-05', 'photo.jpg')}`,
    `To move (photos): Screenshot_1.png -> ${path.join('Screenshots', 'Screenshot_1.png')}`,
    `To move (documents): doc.pdf -> ${path.join('PDF', 'doc.pdf')}`,
    `To move (documents): report.docx -> ${path.join('Word', 'report.docx')}`,
    `To move (other): movie.mp4 -> ${path.join('Videos', 'movie.mp4')}`,
    `To move (other): archive.zip -> ${path.join('Archives', 'archive.zip')}`,
    `To move (other): song.mp3 -> ${path.join('Audio', 'song.mp3')}`,
    `To move (other): weird.xyz -> ${path.join('Other', 'weird.xyz')}`,
    'Kept: new.tmp (',
  ]) assert.ok(out.includes(line), line);
  assert.match(out, /To delete 4 \(.*\), to move: photos 2, documents 2, other 4, kept 1, skipped 0/);
  assert.match(out, /Nothing has been changed yet\. After checking the list, run again without --dry-run and with --yes=[0-9a-f]{12} to send the junk to the Recycle Bin and sort the rest/);
  // A junk file is never planned for sorting as well.
  assert.ok(!out.includes('empty.jpg ->') && !out.includes('doc (1).pdf ->') && !out.includes('setup.exe ->'));
});

test('without --dry-run and without --yes it also only shows the list and the value', () => {
  const dir = downloads();
  const before = names(dir);
  const out = run(['clean-downloads', dir]);
  assert.deepStrictEqual(names(dir), before);
  assert.match(out, /with --yes=[0-9a-f]{12} to send/);
  assert.doesNotMatch(out, /without --dry-run/);
});

test('with the confirmation value, junk is in the Recycle Bin and the rest is in sorted folders', () => {
  const dir = downloads();
  const code = cleanDownloads(dir, { older: '0d' }).code;
  const out = run(['clean-downloads', dir, '--older=0d', `--yes=${code}`]);
  assert.deepStrictEqual(recycled.map((p) => path.basename(p)).sort(), ['doc (1).pdf', 'empty.jpg', 'setup.exe', 'x.crdownload']);
  assert.deepStrictEqual(names(dir), [
    '2023', '2023/2023-05', '2023/2023-05/photo.jpg',
    'Archives', 'Archives/archive.zip',
    'Audio', 'Audio/song.mp3',
    'Other', 'Other/weird.xyz',
    'PDF', 'PDF/doc.pdf',
    'Screenshots', 'Screenshots/Screenshot_1.png',
    'Videos', 'Videos/movie.mp4',
    'Word', 'Word/report.docx',
    'new.tmp', 'sub', 'sub/inside.txt',
  ].sort());
  assert.match(out, /Recycle Bin \(junk\): empty\.jpg/);
  assert.match(out, /Moved \(photos\): photo\.jpg/);
  assert.match(out, /Recycle Bin 4, moved: photos 2, documents 2, other 4, failed 0, kept 1, skipped 0/);
  assert.match(out, /Removal log: /);
  const logs = fs.readdirSync(dir).filter((n) => REMOVAL_LOG.test(n));
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, logs[0]), 'utf8')).items.length, 4);
});

test('a second run has nothing to clean', () => {
  const dir = downloads();
  cleanDownloads(dir, { older: '0d', confirm: cleanDownloads(dir, { older: '0d' }).code });
  const out = run(['clean-downloads', dir, '--older=0d']);
  assert.match(out, /Nothing to clean\./);
  assert.match(out, /To delete 0 .*, to move: photos 0, documents 0, other 0, kept 1, skipped 0/);
  assert.strictEqual(fs.readdirSync(dir).filter((n) => REMOVAL_LOG.test(n)).length, 1, 'the removal log stays in the folder and is not sorted');
});

test('removals are never permanent: --permanent and --force are refused', () => {
  const dir = downloads();
  assert.throws(() => run(['clean-downloads', dir, '--permanent']), /never overwrites or permanently deletes/);
  assert.throws(() => run(['clean-downloads', dir, '--force']), /never overwrites or permanently deletes/);
  assert.deepStrictEqual(recycled, []);
});

test('a bare --yes is refused, and a wrong value changes nothing', () => {
  const dir = downloads();
  const before = names(dir);
  assert.throws(() => run(['clean-downloads', dir, '--yes']), /--yes=VALUE/);
  assert.throws(() => run(['clean-downloads', dir, '--yes=000000000000']), /The list differs/);
  assert.deepStrictEqual(names(dir), before);
  assert.deepStrictEqual(recycled, []);
});

test('a changed list makes the value stale: a new file, a changed file and another --older all reject it', () => {
  const dir = downloads();
  const code = cleanDownloads(dir, { older: '0d' }).code;
  assert.strictEqual(cleanDownloads(dir, { older: '0d' }).code, code, 'the same folder gives the same value');
  make(dir, { 'fresh.mp4': 'new video' });
  assert.strictEqual(cleanDownloads(dir, { older: '0d', confirm: code }).mismatch, true);
  fs.rmSync(path.join(dir, 'fresh.mp4'));
  assert.strictEqual(cleanDownloads(dir, { older: '0d' }).code, code, 'the value is back when the folder is back');
  fs.writeFileSync(path.join(dir, 'movie.mp4'), 'a longer video than before');
  fs.utimesSync(path.join(dir, 'movie.mp4'), OLD, OLD);
  assert.strictEqual(cleanDownloads(dir, { older: '0d', confirm: code }).mismatch, true);
  assert.notStrictEqual(cleanDownloads(dir).code, code, 'a different --older changes the junk list');
  assert.throws(() => run(['clean-downloads', dir, '--older=0d', `--yes=${code}`]), /The list differs/);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'movie.mp4')) && fs.existsSync(path.join(dir, 'doc (1).pdf')));
});

test('a name taken in a destination folder keeps that file in place, and the rest still runs', () => {
  const dir = downloads();
  make(dir, { 'PDF/doc.pdf': 'older and different' });
  const code = cleanDownloads(dir, { older: '0d' }).code;
  const out = run(['clean-downloads', dir, '--older=0d', `--yes=${code}`]);
  assert.match(out, /Skipped: doc\.pdf \(Left in place because PDF[\\/]doc\.pdf already exists\.\)/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'PDF', 'doc.pdf'), 'utf8'), 'older and different');
  assert.ok(fs.existsSync(path.join(dir, 'doc.pdf')));
  assert.ok(fs.existsSync(path.join(dir, 'Videos', 'movie.mp4')));
});

test('a junk file that cannot be sent is reported as a failure and the sorting still happens', () => {
  const dir = downloads();
  failing.add('empty.jpg');
  const code = cleanDownloads(dir, { older: '0d' }).code;
  assert.throws(() => run(['clean-downloads', dir, '--older=0d', `--yes=${code}`]), (err) => {
    assert.match(err.message, /1 file could not be sent to the Recycle Bin or moved/);
    assert.match(err.output, /Failed \(junk\): empty\.jpg \(.*in use/);
    return true;
  });
  assert.ok(fs.existsSync(path.join(dir, 'empty.jpg')), 'the failed junk file is still there, and it was not sorted either');
  assert.ok(fs.existsSync(path.join(dir, 'Videos', 'movie.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, 'x.crdownload')));
});

test('a folder with a project marker is refused, as in the sort commands', () => {
  const dir = tempDir();
  make(dir, { 'package.json': '{}', 'a.mp4': 'v' });
  assert.throws(() => run(['clean-downloads', dir]), /project folder/);
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});

test('without a folder, the real Downloads folder is found in the registry, with environment variables expanded', () => {
  const home = tempDir();
  const dl = path.join(home, 'Downloads');
  make(dl, { 'movie.mp4': 'v' });
  process.env.FCTL_TEST_HOME = home;
  test.after(() => delete process.env.FCTL_TEST_HOME);
  registry = () => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %FCTL_TEST_HOME%\\Downloads\r\n\r\n`;
  if (process.platform === 'win32') {
    assert.strictEqual(downloadsFolder(), fs.realpathSync.native(dl));
    const out = run(['clean-downloads', '--dry-run']);
    assert.ok(out.startsWith(`Target: ${fs.realpathSync.native(dl)}\n`));
    assert.match(out, /To move \(other\): movie\.mp4/);
    assert.deepStrictEqual(names(dl), ['movie.mp4']);
  }
});

test('the Downloads lookup falls back to the user folder and refuses when there is no such folder', () => {
  registry = () => null;
  assert.throws(() => downloadsFolder(), /Cannot find the Downloads folder\. Give the folder: clean-downloads <folder>/);
  assert.throws(() => run(['clean-downloads', '--dry-run']), /Cannot find the Downloads folder/);
  registry = () => 'garbage output without a value';
  assert.throws(() => downloadsFolder(), /Cannot find the Downloads folder/);
  registry = () => 'X    REG_SZ    relative\\path\r\n';
  assert.throws(() => downloadsFolder(), /Cannot find the Downloads folder/);
});

test('planClean and formatClean: the plan does not touch files, and junk kept for now is not sorted', () => {
  const dir = downloads();
  const before = names(dir);
  const plan = planClean(dir, { older: '0d' });
  assert.strictEqual(plan.junk.removals.length, 4);
  assert.strictEqual(plan.sort.moves.length, 8);
  assert.ok(!plan.sort.moves.some((move) => path.basename(move.from) === 'new.tmp'));
  assert.ok(plan.junk.kept.some((item) => path.basename(item.path) === 'new.tmp'));
  assert.deepStrictEqual(names(dir), before);
  assert.match(formatClean(cleanDownloads(dir, { older: '0d' })), /^Target: /);
});

test('the registry is read with the full path of reg.exe, never the bare name', () => {
  registry = () => null;
  assert.throws(() => downloadsFolder());
  if (process.platform === 'win32') {
    assert.ok(regFiles.length > 0 && regFiles.every((file) => path.isAbsolute(file) && /System32[\\/]reg\.exe$/i.test(file)), regFiles.join());
  }
});

test('a Downloads folder redirected to a folder not named Downloads (user folder, drive root, Documents) is refused', () => {
  if (process.platform !== 'win32') return;
  const home = tempDir();
  for (const redirected of [home, path.join(home, 'Documents'), path.parse(home).root]) {
    if (!fs.existsSync(redirected)) fs.mkdirSync(redirected, { recursive: true });
    registry = () => `X    REG_SZ    ${redirected}\r\n`;
    assert.throws(() => run(['clean-downloads', '--dry-run']), /is not named Downloads, so it is not cleaned without being asked\. Give the folder/);
  }
  const named = path.join(home, '다운로드');
  fs.mkdirSync(named);
  registry = () => `X    REG_SZ    ${named}\r\n`;
  assert.strictEqual(downloadsFolder(), fs.realpathSync.native(named));
});

test('a file that changes while the junk is being sent stays where it is', () => {
  const dir = downloads();
  const code = cleanDownloads(dir, { older: '0d' }).code;
  const result = cleanDownloads(dir, {
    older: '0d',
    confirm: code,
    onProgress: (line) => {
      // After the removal log is written and before the moves: a browser is still writing movie.mp4.
      if (/^Sending to the Recycle Bin/.test(line)) make(dir, { 'movie.mp4': 'a longer video than before' }, new Date(OLD.getTime() + 1000));
    },
  });
  assert.strictEqual(result.mismatch, false);
  assert.ok(fs.existsSync(path.join(dir, 'movie.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, 'Videos', 'movie.mp4')));
  assert.ok(result.sorted.skipped.some((item) => /movie\.mp4/.test(item.path) && /changed after the list was made/.test(item.reason)));
  assert.ok(fs.existsSync(path.join(dir, 'Audio', 'song.mp3')), 'the other files are still sorted');
  assert.strictEqual(recycled.length, 4);
});

test('in a session that is not interactive nothing is deleted, moved or logged', () => {
  const dir = downloads();
  const code = cleanDownloads(dir, { older: '0d' }).code;
  volume = () => 'False|Fixed\r\n';
  const before = names(dir);
  assert.throws(() => cleanDownloads(dir, { older: '0d', confirm: code }), /interactive session/);
  assert.deepStrictEqual(names(dir), before);
  assert.deepStrictEqual(recycled, []);
  assert.strictEqual(fs.readdirSync(dir).filter((n) => REMOVAL_LOG.test(n)).length, 0);
});

test('junk in a subfolder is removed too, while the sorting only touches the files directly in the folder', () => {
  const dir = tempDir();
  make(dir, { 'movie.mp4': 'v', 'sub/old.crdownload': 'half', 'sub/keep.mp4': 'stays', 'sub/doc.pdf': 'doc', 'sub/doc (1).pdf': 'doc' });
  const code = cleanDownloads(dir).code;
  run(['clean-downloads', dir, `--yes=${code}`]);
  assert.deepStrictEqual(names(dir), ['Videos', 'Videos/movie.mp4', 'sub', 'sub/doc.pdf', 'sub/keep.mp4']);
  assert.deepStrictEqual(recycled.map((p) => path.basename(p)).sort(), ['doc (1).pdf', 'old.crdownload']);
});

test('a stale value through the command line exits with an error and the new list on standard output', () => {
  const dir = downloads();
  assert.throws(() => run(['clean-downloads', dir, '--yes=000000000000']), (err) => {
    assert.match(err.message, /The list differs from when the confirmation value was made/);
    assert.match(err.output, /The list changed after the confirmation value was made, so nothing was deleted or moved\./);
    return true;
  });
});
