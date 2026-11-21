'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { describeArchiveFormat, extractAllView, unzipDest, unzipSpace } = require('../src/ui/archive');
const { toPlain } = require('../src/ui/serialize');

test('describeArchiveFormat describes the format tar.exe -a will pick from the extension (#258)', () => {
  // Matched to the real tar.exe (build 26200) output by its first bytes: .tlz is lzma, .taZ and .tZ are compress, .tz, .z and .jar are an uncompressed tar.
  const cases = {
    'a.zip': 'ZIP',
    'A.ZIP': 'ZIP',
    'x.tar.zip': 'ZIP',
    'x.7z': '7z',
    'x.iso': 'ISO 9660',
    'x.tar': 'tar (no compression)',
    'x.tar.gz': 'tar + gzip',
    'x.TGZ': 'tar + gzip',
    'x.gz': 'tar + gzip',
    'x.taz': 'tar + gzip',
    'x.tlz': 'tar + lzma',
    'x.taZ': 'tar + compress',
    'x.tZ': 'tar + compress',
    'x.Z': 'tar + compress',
    'x.tar.gz.gz': 'tar + gzip + gzip',
    'x.cpio.xz': 'cpio + xz',
    [path.join('D:\\', 'p.q', 'x.tar.bz2')]: 'tar + bzip2',
    'x.tz': 'tar (no compression) - .tz is not read as a format',
    'x.z': 'tar (no compression) - .z is not read as a format',
    'x.jar': 'tar (no compression) - .jar is not read as a format',
    x: 'tar (no compression) - the name has no extension',
  };
  for (const [name, label] of Object.entries(cases)) assert.strictEqual(describeArchiveFormat(name).label, label, name);
  assert.deepStrictEqual(describeArchiveFormat('x.tar.gz.xz'), { ext: '.tar.gz.xz', format: 'tar', layers: ['gzip', 'xz'], label: 'tar + gzip + xz' });
});

// The shape of the extractArchives result (carried as JSON).
function outcome(fields) {
  const target = path.join('D:\\', 'dl');
  const p = (...parts) => path.join(target, ...parts);
  return toPlain({
    command: 'extract-all',
    result: {
      target,
      dryRun: false,
      removeArchives: true,
      extracted: [
        { archive: p('a.zip'), dest: p('a'), entries: 3 },
        { archive: p('b.7z'), dest: p('b (2)'), entries: 1 },
        { archive: p('c.zip'), dest: p('c'), entries: 2 },
      ],
      skipped: [{ path: p('d.zip'), reason: 'A folder with the same name exists <x>' }],
      removed: [p('a.zip')],
      kept: [{ archive: p('b.7z'), reason: 'The extracted file count differs' }],
      failed: [{ archive: p('c.zip'), reason: 'Could not send to the Recycle Bin' }, { archive: p('e.zip'), reason: 'Damaged archive' }],
      ...fields,
    },
    report: '',
  });
}

const rows = (body) => [...String(body).matchAll(/<tr><td>(.*?)<\/td><\/tr>/g)].map((m) => m[1].split('</td><td>'));

test('extractAllView shows the extracted folder, the original handling and the skip and failure reasons per archive (#258)', () => {
  const body = String(extractAllView(outcome()));
  const table = rows(body);
  assert.deepStrictEqual(table.map((cells) => cells[0]), ['a.zip', 'b.7z', 'c.zip', 'e.zip', 'd.zip']);
  assert.deepStrictEqual(table[0].slice(2, 4), ['a', '3']);
  assert.match(table[0][1], /badge-ok">Extracted</);
  assert.match(table[0][4], /Sent to the Recycle Bin/);
  assert.match(table[1][4], /badge-skip">Kept<\/span> The extracted file count differs/);
  // An archive that was extracted but whose original could not be removed stays on its extracted row; one that was not extracted is a failed row.
  assert.match(table[2][1], /badge-ok">Extracted</);
  assert.strictEqual(table[2][4], '<span class="badge badge-error">Original not removed</span> Could not send to the Recycle Bin');
  assert.match(table[3][1], /badge-error">Failed</);
  assert.strictEqual(table[3][4], 'Damaged archive');
  assert.match(table[4][1], /badge-skip">Skipped</);
  assert.strictEqual(table[4][4], 'A folder with the same name exists &lt;x&gt;');
  assert.match(body, /<div class="value">3<\/div><div class="label">Archives extracted</);
  assert.match(body, /Originals sent to the Recycle Bin/);
  assert.match(body, /card-error"><div class="value">2<\/div><div class="label">Failed/);
});

test('extractAllView preview says "Will extract", leaves out the original cards without --remove-archives and explains an empty result (#258)', () => {
  const preview = String(extractAllView(outcome({ dryRun: true })));
  assert.match(preview, /preview: nothing has been changed yet/);
  assert.match(preview, /badge-ok">Will extract</);
  assert.match(preview, /Will go to the Recycle Bin/);

  const plain = String(extractAllView(outcome({ removeArchives: false, removed: [], kept: [], failed: [], skipped: [] })));
  assert.doesNotMatch(plain, /Originals kept/);
  const empty = String(extractAllView(outcome({ extracted: [], removed: [], kept: [], failed: [], skipped: [] })));
  assert.match(empty, /No archives found\./);
});

test('extractAllView shows originals as "Left as it is" without --remove-archives (#258)', () => {
  const body = String(extractAllView(outcome({ removeArchives: false, removed: [], kept: [], failed: [] })));
  assert.deepStrictEqual(rows(body).slice(0, 3).map((cells) => cells[4]), ['Left as it is', 'Left as it is', 'Left as it is']);
});

test('unzipDest and unzipSpace give the extraction folder and the free space of its volume, and the reason if it cannot be checked (#258)', () => {
  const archive = path.join('D:\\', 'dl', 'movie.tar.gz');
  assert.strictEqual(unzipDest(archive), path.join('D:\\', 'dl', 'movie.tar'));
  assert.strictEqual(unzipDest(archive, 'E:\\out'), 'E:\\out');

  const seen = [];
  const ok = unzipSpace(archive, undefined, { freeSpace: (dir) => (seen.push(dir), { free: 5n * 1024n ** 3n, block: 4096n }) });
  assert.deepStrictEqual(seen, [path.join('D:\\', 'dl', 'movie.tar')]);
  assert.strictEqual(ok.free, 5 * 1024 ** 3);
  assert.match(ok.text, /^Free space 5(\.0)? ?GB\. It will not extract if less than 1(\.0)? ?GB would be left afterwards\.$/);

  const failed = unzipSpace(archive, 'Q:\\none', { freeSpace: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.strictEqual(failed.free, null);
  assert.match(failed.text, /Could not check the free space \(ENOENT\)/);

  // It also returns a number on a real volume.
  const real = unzipSpace(path.join(__dirname, 'none.zip'));
  assert.ok(real.free > 0, real.text);
});

test('a new extension added to the archive tables of src/archive.js shows in the UI preview (#362)', () => {
  const archive = require('../src/archive');
  const commands = require('../src/commands');
  // The UI uses the very tables of src/archive.js, not copies.
  assert.strictEqual(commands.FORMAT_LABELS, archive.FORMAT_LABELS);
  assert.strictEqual(commands.COMPRESS_LABELS, archive.COMPRESS_LABELS);
  assert.strictEqual(commands.TAR_COMPRESS, archive.TAR_COMPRESS);
  // Every table extension is described without the "is not read as a format" note, and its first label shows up.
  for (const [ext, label] of Object.entries(archive.FORMAT_LABELS)) assert.strictEqual(describeArchiveFormat(`x.${ext}`).format, label, ext);
  for (const [ext, label] of Object.entries(archive.TAR_COMPRESS)) assert.deepStrictEqual(describeArchiveFormat(`x.${ext}`).layers, [label], ext);
  // A scratch extension added to the table (and removed again) appears in the preview of a name that uses it. (FORMAT_EXT and the regexes of src/archive.js are built once at load, so a runtime addition changes only the preview.)
  archive.FORMAT_LABELS.fctltest = 'Scratch';
  try {
    assert.strictEqual(describeArchiveFormat('x.fctltest').format, 'Scratch');
  } finally {
    delete archive.FORMAT_LABELS.fctltest;
  }
});
