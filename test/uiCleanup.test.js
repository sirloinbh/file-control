'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../src/execute');
const { toPlain } = require('../src/ui/serialize');
const { CLEANUP_VIEWS, findBrokenView, findDuplicatesView, findLowQualityView, removeView } = require('../src/ui/screens/cleanupViews');

// The temp folder is under the user's AppData, a protected path. As in the other tests, the user folder is moved to a path that does not exist.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uicleanup-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the real command and carries the result as JSON, the same as the screen receives it.
const run = (argv) => toPlain(execute(argv));
const rows = (body) => [...String(body).matchAll(/<tr><td>(.*?)<\/td><\/tr>/g)].map((m) => m[1].split('</td><td>'));
const T = path.join('D:\\', 'v');
const p = (...parts) => path.join(T, ...parts);

test('CLEANUP_VIEWS has a screen for all find and remove commands (#259, #393)', () => {
  assert.deepStrictEqual(Object.keys(CLEANUP_VIEWS).sort(), ['find', 'find-broken', 'find-duplicates', 'find-low-quality', 'remove-broken', 'remove-duplicates', 'remove-low-quality']);
});

test('find-broken screen: broken and suspect in a table, undetermined and skipped apart, names escaped (#259)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bad&1.zip'), 'not a zip');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'text');
  const body = String(findBrokenView(run(['find-broken', dir])));
  assert.match(body, /<td>bad&amp;1\.zip<\/td><td><span class="badge badge-warning">Suspect<\/span><\/td><td>9 ?B<\/td><td>[^<]+/);
  assert.match(body, /<div class="value">1<\/div><div class="label">Suspect/);
  assert.doesNotMatch(body, /Files that were not judged/);

  const synthetic = toPlain({ command: 'find-broken', result: { target: T, broken: [{ path: p('a.mp4'), size: 10, reason: 'truncated' }], suspect: [], undetermined: [{ path: p('b.zip'), reason: 'read failed' }], skipped: [{ path: p('l'), reason: 'Links are not checked.' }], checked: 2 } });
  const table = rows(findBrokenView(synthetic));
  assert.deepStrictEqual(table.map((cells) => cells[0]), ['a.mp4', 'b.zip', 'l']);
  assert.match(table[0][1], /badge-error">Broken/);
  assert.match(table[1][1], /Undetermined/);
  assert.match(table[2][1], /Skipped/);
});

test('find-duplicates screen: each group splits the file to keep from the delete candidates and shows the cautions (#259)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'ABC-123 first.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'ABC-123 second.mp4'), 'xx');
  const outcome = run(['find-duplicates', dir]);
  const body = String(findDuplicatesView(outcome));
  assert.match(body, /<h3>Duplicate candidates: number ABC-123 \(2 files\)<\/h3>/);
  const table = rows(body);
  const keeper = outcome.result.groups[0].keep.path;
  // The result reports real paths. On CI the temp folder is an 8.3 short name (RUNNER~1), so compare with its real path.
  const realDir = fs.realpathSync.native(dir);
  for (const cells of table.slice(0, 2)) {
    if (path.join(realDir, cells[0]) === keeper) assert.match(cells[1], /Keep/);
    else assert.match(cells[1], /Delete candidate/);
  }
  assert.strictEqual(table.filter((cells) => /Keep/.test(cells[1])).length, 1);

  const film = (name, extra) => ({ path: p(name), size: 1000, duration: 60, width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, note: null, ...extra });
  const synthetic = toPlain({
    command: 'find-duplicates',
    result: {
      target: T,
      groups: [{ kind: 'name', key: 'img', number: null, part: null, generic: true, differentTitles: false, files: [film('IMG_1.mp4'), film('img_1.mov')], keep: { path: p('IMG_1.mp4'), reason: 'larger resolution', doubt: null } }],
      metadataGroups: [
        { aspect: '16:9', duration: 3725, sameSize: true, alsoNamed: false, files: [film('x.mp4'), film('y.mkv')], keep: { path: p('y.mkv'), reason: 'path order', doubt: 'The lengths differ, so these may not be the same video.' } },
        { aspect: '16:9', duration: 60, sameSize: false, alsoNamed: true, files: [film('IMG_1.mp4'), film('img_1.mov')], keep: { path: p('IMG_1.mp4'), reason: '', doubt: null } },
      ],
      unknownMetadata: 1,
      metadataErrors: [],
      conflicts: [{ path: p('A-1 B-2.mp4'), numbers: ['A-1', 'B-2'] }],
      undetermined: [],
      skipped: [],
      checked: 5,
    },
  });
  const view = String(findDuplicatesView(synthetic));
  assert.match(view, /common name/);
  assert.match(view, /<h3>Same length: 1:02:05, aspect ratio 16:9, same size \(2 files\)<\/h3>/);
  assert.match(view, /alert-warning[^>]*>The lengths differ/);
  // An alsoNamed group repeats a name group, so it is not shown twice.
  assert.strictEqual((view.match(/<h3>/g) ?? []).length, 2);
  assert.match(view, /<td>A-1 B-2\.mp4<\/td><td><span class="badge badge-skip">Several numbers<\/span><\/td><td>Several numbers: A-1, B-2<\/td>/);
});

test('find-low-quality screen: shows the criteria and the resolution and bitrate columns (#259)', () => {
  const outcome = toPlain({
    command: 'find-low-quality',
    result: {
      target: T,
      criteria: { minHeight: 480, minBitrate: 1000 },
      low: [{ path: p('s.mp4'), size: 2048, width: 640, height: 352, displayWidth: 626, displayHeight: 352, duration: 61.4, bitrate: 812_345, reasons: ['short side 352 px', 'bitrate 812kbps'], byResolution: true }],
      undetermined: [{ path: p('a.avi'), reason: 'Cannot read the resolution of .avi.' }],
      skipped: [],
      checked: 2,
    },
  });
  const body = String(findLowQualityView(outcome));
  assert.match(body, /Criteria: below short side 480 px or bitrate 1000 kbps/);
  const [first] = rows(body);
  assert.deepStrictEqual(first.slice(0, 4), ['s.mp4', '640x352 (shown as 626x352)', '812kbps', '1:01']);
  assert.match(first[4], /^2(\.0)? ?KB$/);
  assert.strictEqual(first[5], 'short side 352 px, bitrate 812kbps');
  assert.match(body, /<td>a\.avi<\/td><td><span class="badge badge-warning">Undetermined/);
});

test('remove-broken screen: the preview lists what to delete, a changed list is an error, and a finished run shows the Recycle Bin result and the log location (#259)', () => {
  const base = { target: T, broken: [], suspect: [{ path: p('s.zip'), size: 1, reason: 'suspect' }], undetermined: [], skipped: [], checked: 3, interactive: null, code: 'abc123', confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  const removal = { path: p('b.zip'), size: 4096, reason: 'truncated', stamp: '1' };
  const kept = { path: p('new.zip'), reason: 'Changed just now, so it may still be downloading; kept.' };

  const preview = String(removeView(toPlain({ command: 'remove-broken', result: { ...base, dryRun: true, removals: [removal], kept: [kept] } })));
  assert.match(preview, /alert-info[^>]*>Nothing is deleted yet\. Check the 1 file below, then run to send them to the Recycle Bin\./);
  const table = rows(preview);
  assert.deepStrictEqual(table[0].slice(0, 1), ['b.zip']);
  assert.match(table[0][1], /To delete/);
  assert.strictEqual(table[0][3], 'truncated');
  assert.match(table[1][1], /Kept/);
  assert.strictEqual(table[1][3], kept.reason);
  assert.match(preview, /<td>s\.zip<\/td><td><span class="badge badge-warning">Suspect \(not deleted\)/);
  assert.doesNotMatch(preview, /Removal log/);

  const mismatch = String(removeView(toPlain({ command: 'remove-broken', result: { ...base, removals: [removal], kept: [], mismatch: true } })));
  assert.match(mismatch, /alert-error[^>]*>The list differs from the one/);

  const logPath = p('fctl-removed-1.json');
  const done = String(removeView(toPlain({ command: 'remove-broken', result: { ...base, removals: [removal, { ...removal, path: p('c.zip') }], kept: [], confirmed: true, removed: [removal], failed: [{ path: p('c.zip'), reason: 'in use' }], log: logPath } })));
  assert.match(done, /alert-warning[^>]*>Sent 1 file to the Recycle Bin\. 1 failed\./);
  assert.deepStrictEqual(rows(done).map((cells) => cells[0]), ['b.zip', 'c.zip', 's.zip']);
  assert.match(rows(done)[0][1], /Sent to Recycle Bin/);
  assert.match(rows(done)[1][1], /badge-error">Failed/);
  assert.ok(done.includes(`Removal log: <code>${logPath}</code>`));
});

test('remove-duplicates and remove-low-quality screens: group column, kept files and criteria (#259)', () => {
  const film = (name) => ({ path: p(name), size: 1000, duration: 60, width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080 });
  const dup = String(removeView(toPlain({
    command: 'remove-duplicates',
    result: {
      target: T, groups: [], metadataGroups: [], conflicts: [], undetermined: [], skipped: [], checked: 3, lengthOnly: 2, interactive: null, code: 'c', dryRun: true, confirmed: false, mismatch: false, removed: [], failed: [], log: null,
      sets: [{ label: 'number ABC-123', keep: { ...film('ABC-123.mp4'), reason: 'larger resolution' }, doubt: 'The lengths differ, so these may not be the same video.' }],
      removals: [{ ...film('ABC-123 (2).mp4'), set: 0, keep: p('ABC-123.mp4'), reason: '' }],
      kept: [{ path: p('ABC-123 hard.mp4'), set: 0, reason: 'Same file as the kept one (hard link); kept.', file: film('ABC-123 hard.mp4') }],
    },
  })));
  const table = rows(dup);
  assert.strictEqual(table[0].length, 5);
  assert.strictEqual(table[0][4], 'number ABC-123 (keeping ABC-123.mp4)');
  assert.match(table[1][3], /hard link/);
  assert.match(dup, /number ABC-123: The lengths differ/);
  assert.match(dup, /2 same-length groups have different names/);

  const low = String(removeView(toPlain({
    command: 'remove-low-quality',
    result: {
      target: T, criteria: { minHeight: 360, minBitrate: null }, low: [], undetermined: [], skipped: [], checked: 1, interactive: null, code: 'c', dryRun: false, confirmed: false, mismatch: false, removed: [], failed: [], log: null, kept: [],
      removals: [{ ...film('tiny.mp4'), width: 320, height: 240, displayWidth: 320, displayHeight: 240, bitrate: 300_000, reasons: ['short side 240 px'] }],
    },
  })));
  assert.match(low, /Criteria: below short side 360 px/);
  assert.match(rows(low)[0][2], /^320x240, 300kbps, 1:00, /);
  assert.strictEqual(rows(low)[0][3], 'short side 240 px');
  assert.strictEqual(rows(low)[0].length, 4);
});

test('an empty removal shows a notice (#259)', () => {
  const dir = tempDir();
  const body = String(removeView(run(['remove-broken', dir])));
  assert.match(body, /alert-info[^>]*>There is nothing to delete\./);
  assert.match(body, /No files to delete or keep\./);
});

test('remove screen: a planned file that is neither removed nor failed stays in the table as not attempted (#309)', () => {
  const base = { target: T, broken: [], suspect: [], undetermined: [], skipped: [], checked: 3, interactive: true, code: 'abc123', dryRun: false, confirmed: true, mismatch: false, log: p('fctl-removed-1.json') };
  const removal = (name) => ({ path: p(name), size: 4096, reason: 'truncated', stamp: '1' });
  const result = { ...base, removals: [removal('a.zip'), removal('b.zip'), removal('c.zip')], kept: [], removed: [removal('a.zip')], failed: [{ path: p('b.zip'), reason: 'in use' }] };
  const body = String(removeView(toPlain({ command: 'remove-broken', result })));
  assert.deepStrictEqual(rows(body).map((cells) => cells[0]), ['a.zip', 'b.zip', 'c.zip']);
  assert.match(rows(body)[2][1], /Not attempted/);
  const mismatch = String(removeView(toPlain({ command: 'remove-broken', result: { ...base, confirmed: false, mismatch: true, removed: [], failed: [], removals: [], kept: [], mismatchHints: [{ path: p('a.zip'), reason: 'x' }] } })));
  assert.match(mismatch, /1 file is now held back because they changed within the last 5 minutes/);
});

test('plural writes the singular for 1 and the plural otherwise (#332)', () => {
  const { plural } = require('../src/plural');
  assert.strictEqual(plural(1, 'file'), '1 file');
  assert.strictEqual(plural(0, 'file'), '0 files');
  assert.strictEqual(plural(2, 'file'), '2 files');
  assert.strictEqual(plural(2, 'entry', 'entries'), '2 entries');
});
