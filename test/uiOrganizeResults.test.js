'use strict';

// The result tables of the folder cleanup screens (#257): summary cards, failed and skipped on top, changed name parts marked.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temp folder is under the real user folder (AppData), which is refused as a protected folder, so the user folder is replaced.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-organize-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
test.mock.method(os, 'homedir', () => path.join(base, 'home'));

const { highlightChange, organizeResultView, ORGANIZE_COMMANDS } = require('../src/ui/organizeResults');
const { flatten } = require('../src/flatten');
const { toPlain } = require('../src/ui/serialize');

// Pass through JSON once, as if it came from the job process (#253).
const overJson = (result) => JSON.parse(JSON.stringify(toPlain(result)));

function make(dir, files) {
  for (const file of files) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), file);
  }
}

// true if a comes before b in the body
const before = (body, a, b) => body.indexOf(a) >= 0 && body.indexOf(b) > body.indexOf(a);

test('highlightChange marks only the added or changed part of the new name and escapes names (#257)', () => {
  assert.strictEqual(highlightChange('video.mp4', 'Show CD1 video.mp4').text, '<mark>Show CD1 </mark>video.mp4');
  assert.strictEqual(highlightChange('abc.mp4', 'ABC-123 abc.mp4').text, '<mark>ABC-123 </mark>abc.mp4');
  assert.strictEqual(highlightChange('video.en.srt', 'Show video.Forced.en.srt').text, '<mark>Show video.Forced</mark>.en.srt');
  assert.strictEqual(highlightChange('ＡＢＣ.mp4', 'ABC.mp4').text, '<mark>ABC</mark>.mp4');
  // Nothing is marked when nothing changed.
  assert.strictEqual(highlightChange('same.mp4', 'same.mp4').text, 'same.mp4');
  // <, & and quotes in names are escaped. Korean and emoji are not split.
  assert.strictEqual(highlightChange('a<b>.mp4', 'X & "Y" a<b>.mp4').text, '<mark>X &amp; &quot;Y&quot; </mark>a&lt;b&gt;.mp4');
  assert.strictEqual(highlightChange('😀.mp4', '😁.mp4').text, '<mark>😁</mark>.mp4');
  assert.strictEqual(highlightChange('영상.mp4', '쇼 영상.mp4').text, '<mark>쇼 </mark>영상.mp4');
});

test('flatten preview result: summary cards, skipped above moved, added prefix marked (#257)', () => {
  const dir = path.join(base, 'flatten');
  make(dir, ['Show/CD1/video.mp4', 'Show/CD1/video.en.srt', 'Show/CD2/<b>.txt'.replace('<b>', 'b&c'), 'old/.fctl-old-1-2-3']);
  const result = overJson(flatten(dir, { dryRun: true }));
  const body = organizeResultView('flatten', result).text;
  assert.match(body, /Preview/);
  assert.match(body, /<div class="value">3<\/div><div class="label">Moved<\/div>/);
  assert.match(body, /<div class="value">1<\/div><div class="label">Skipped<\/div>/);
  assert.ok(body.includes('<mark>Show CD1 </mark>video.mp4'));
  assert.ok(body.includes('<mark>Show CD1 </mark>video.en.srt'));
  assert.ok(body.includes(path.join('Show', 'CD1', 'video.mp4')), 'the original is relative to the target');
  assert.ok(body.includes('b&amp;c'), 'names are escaped');
  assert.ok(before(body, '<h2>Skipped', '<h2>Moved'), 'skipped is above moved');
  assert.match(body, /leftover from an earlier job/);
  // A section with no items (failed) is not made.
  assert.doesNotMatch(body, /<h2>Failed/);
});

test('flatten run result: failed and kept folders on top, with number added and folder name used badges (#257)', () => {
  const t = 'D:\\t';
  const result = {
    target: t, dryRun: false, stay: [], removedFolders: ['D:\\t\\Show'],
    moved: [{ from: 'D:\\t\\ABC-123\\video.mp4', name: 'ABC-123.mp4', fromFolder: true, numbered: false }, { from: 'D:\\t\\x\\a.txt', name: 'a (2).txt', fromFolder: false, numbered: true }],
    skipped: [], failed: [{ from: 'D:\\t\\y\\locked.mp4', reason: 'locked' }], keptFolders: [{ path: 'D:\\t\\y', reason: 'Files remain.' }],
  };
  const body = organizeResultView('flatten', overJson(result)).text;
  assert.doesNotMatch(body, /Preview/);
  assert.ok(before(body, '<h2>Failed', '<h2>Folders kept') && before(body, '<h2>Folders kept', '<h2>Moved'));
  assert.ok(body.includes(path.join('y', 'locked.mp4')) && body.includes('locked'));
  assert.match(body, /Folder name used/);
  assert.match(body, /Number added/);
  assert.ok(body.includes('a<mark> (2)</mark>.txt'));
  assert.match(body, /<h2>Empty folders to the Recycle Bin/);
});

test('collapse, normalize and product-number results also put failed and skipped on top and mark changed parts (#257)', () => {
  const t = 'D:\\t';
  const collapse = organizeResultView('collapse', overJson({
    target: t, dryRun: true,
    collapsed: [{ leaf: 'D:\\t\\A\\A\\A', dest: 'D:\\t\\A' }],
    skipped: [{ path: 'D:\\t\\B', reason: 'The names differ.' }], failed: [],
  })).text;
  assert.ok(before(collapse, '<h2>Skipped', '<h2>Collapsed'));
  assert.ok(collapse.includes(path.join('A', 'A', 'A')));

  const normalize = organizeResultView('normalize', overJson({
    target: t, dryRun: false,
    renamed: [{ from: 'D:\\t\\ＡＢＣ　영상.mp4', name: 'ABC 영상.mp4' }],
    inferred: [{ path: 'D:\\t\\iphone.txt', name: 'IPHONE.txt' }],
    conflicts: [{ path: 'D:\\t\\ｘ.txt', name: 'x.txt', reason: 'The same name exists.' }],
    skipped: [], failed: [{ from: 'D:\\t\\z.txt', reason: 'locked' }],
  })).text;
  assert.ok(before(normalize, '<h2>Failed', '<h2>Name clashes') && before(normalize, '<h2>Name clashes', '<h2>Renamed'));
  assert.ok(normalize.includes('<mark>ABC </mark>영상.mp4'));
  assert.match(normalize, /Left alone as lowercase words/);

  const product = organizeResultView('product-number', overJson({
    target: t, dryRun: true,
    renamed: [{ from: 'D:\\t\\movie.mp4', name: 'ABC-123 movie.mp4', source: 'title', note: null }],
    already: [{ path: 'D:\\t\\XYZ-001.mp4', number: 'XYZ-001' }],
    notFound: [{ path: 'D:\\t\\clip.mp4', note: null }],
    conflicts: [{ path: 'D:\\t\\two.mp4', numbers: ['AAA-001', 'BBB-002'], note: 'read failed' }],
    skipped: [], failed: [],
  })).text;
  assert.ok(product.includes('<mark>ABC-123 </mark>movie.mp4'));
  assert.match(product, /Found in the title/);
  assert.ok(before(product, '<h2>Numbers disagree', '<h2>Renamed'));
  assert.match(product, /AAA-001, BBB-002/);
  assert.match(product, /<h2>Already named/);
  assert.match(product, /<h2>Not found/);
});

test('organizeResultView accepts only folder cleanup commands (#257)', () => {
  assert.deepStrictEqual(ORGANIZE_COMMANDS, ['flatten', 'collapse', 'normalize', 'product-number']);
  assert.throws(() => organizeResultView('rm', {}), /Not a folder cleanup command/);
});
