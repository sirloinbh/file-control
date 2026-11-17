'use strict';

// The archive screens (#258) end to end: the real server, the real job process (worker.js), tar.exe and real files in temp folders.
// zip and unzip run for real. extract-all runs for real without --remove-archives; with --remove-archives it stops at the preview and the stale-run step,
// because a real run would send archives to the user's Recycle Bin (the Recycle Bin paths are covered by test/extractRemove.test.js with fakes).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startUi } = require('./uiClient');
const { createJobs } = require('../src/ui/jobs');
const { jobRoutes } = require('../src/ui/jobPages');
const { flowRoutes } = require('../src/ui/flowPages');
const archiveScreens = require('../src/ui/screens/archive');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uiarchive-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

async function settled(jobs, job, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`The job did not finish: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The temp folder is inside the user folder, which whole-folder commands refuse. The job process gets a home folder that does not exist.
const FAKE_HOME = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');

async function serve(t) {
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: FAKE_HOME } });
  const { specs, views } = archiveScreens;
  const routes = new Map([...jobRoutes(jobs, { specs, views }), ...flowRoutes(jobs, specs), ...archiveScreens.routes(jobs)]);
  const { server, url, get, post } = await startUi({ routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const finish = async (res) => {
    assert.strictEqual(res.status, 303, await res.clone().text());
    const id = new URL(res.headers.get('location'), url).searchParams.get('id');
    const job = jobs.get(id);
    await settled(jobs, job);
    const result = await get(`/job/result?id=${id}`);
    assert.strictEqual(result.status, 200);
    return { job, body: await result.text() };
  };
  return { jobs, get, post, finish };
}

const fingerprintOf = (body) => /name="fingerprint" value="([0-9a-f]{64})"/.exec(body)?.[1];

test('the archive landing page lists the three commands and the forms render (#258)', async (t) => {
  const { get } = await serve(t);
  const landing = await (await get('/archive')).text();
  for (const name of ['zip', 'unzip', 'extract-all']) assert.match(landing, new RegExp(`href="/archive/${name}"`));
  const zipForm = await (await get('/archive/zip')).text();
  assert.match(zipForm, /<textarea name="sources"/);
  assert.match(zipForm, /action="\/archive\/zip\/preview"/);
  const allForm = await (await get('/archive/extract-all')).text();
  assert.match(allForm, /name="removeArchives"/);
  assert.doesNotMatch(allForm, /name="removeArchives"[^>]* checked/);
});

test('zip: form -> preview (names the format, creates nothing) -> run -> result (#258)', async (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'aaa');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'bbb');
  const archive = path.join(dir, 'out.tar.gz');
  const { post, finish } = await serve(t);
  const form = { archive, sources: `${path.join(dir, 'a.txt')}\r\n"${path.join(dir, 'sub')}"\r\n\r\n` };

  const preview = await finish(await post('/archive/zip/preview', form));
  assert.strictEqual(preview.job.mode, 'preview', preview.body);
  assert.deepStrictEqual(preview.job.argv, ['zip', '--', archive, path.join(dir, 'a.txt'), path.join(dir, 'sub')]);
  assert.match(preview.body, /Format by the extension: <strong>tar \+ gzip<\/strong>/);
  assert.match(preview.body, /action="\/archive\/zip\/run"/);
  assert.ok(!fs.existsSync(archive), 'a preview creates nothing');
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint);

  const run = await finish(await post('/archive/zip/run', { ...form, fingerprint }));
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.match(run.body, /Compress:/);
  assert.ok(fs.statSync(archive).size > 0);
  assert.strictEqual(fs.readFileSync(archive).subarray(0, 2).toString('hex'), '1f8b', 'the extension .tar.gz made a gzip file');
});

test('zip: an existing archive needs --force with its extra confirmation; refusals show a reason (#258)', async (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'aaa');
  const archive = path.join(dir, 'out.zip');
  fs.writeFileSync(archive, 'old');
  const { jobs, post, finish } = await serve(t);

  const empty = await post('/archive/zip/preview', { archive: '', sources: path.join(dir, 'a.txt') });
  assert.strictEqual(empty.status, 400);
  assert.match(await empty.text(), /Enter the archive file to create/);
  const noSources = await post('/archive/zip/preview', { archive, sources: ' \r\n' });
  assert.strictEqual(noSources.status, 400);
  assert.match(await noSources.text(), /Enter at least one file or folder/);
  assert.strictEqual(jobs.running(), null);

  // Without the overwrite option the preview fails because the archive exists, and the old file stays.
  const refused = await finish(await post('/archive/zip/preview', { archive, sources: path.join(dir, 'a.txt') }));
  assert.strictEqual(refused.job.status, 'error');
  assert.match(refused.body, /Job failed/);
  assert.strictEqual(fs.readFileSync(archive, 'utf8'), 'old');

  const form = { archive, sources: path.join(dir, 'a.txt'), force: 'on' };
  const preview = await finish(await post('/archive/zip/preview', form));
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint, preview.body);
  assert.match(preview.body, /name="confirm-force" value="yes" required/);
  const unconfirmed = await post('/archive/zip/run', { ...form, fingerprint });
  assert.strictEqual(unconfirmed.status, 400);
  assert.strictEqual(fs.readFileSync(archive, 'utf8'), 'old');
  const run = await finish(await post('/archive/zip/run', { ...form, fingerprint, 'confirm-force': 'yes' }));
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.strictEqual(fs.readFileSync(archive).subarray(0, 2).toString('latin1'), 'PK');
});

test('unzip: form -> preview (item count, size, free space, nothing extracted) -> run -> result (#258)', async (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'world');
  const archive = path.join(dir, 'pack.zip');
  const { post, finish } = await serve(t);
  const made = await finish(await post('/archive/zip/preview', { archive, sources: path.join(dir, 'src') }));
  await finish(await post('/archive/zip/run', { archive, sources: path.join(dir, 'src'), fingerprint: fingerprintOf(made.body) }));
  assert.ok(fs.existsSync(archive));

  const dest = path.join(dir, 'out');
  const form = { archive, dest };
  const preview = await finish(await post('/archive/unzip/preview', form));
  assert.strictEqual(preview.job.mode, 'preview', preview.body);
  assert.match(preview.body, /3 items, extracted size about/);
  assert.match(preview.body, /Free space [\d.]+ ?\w+\. It will not extract if less than/);
  assert.ok(preview.body.includes(`<code>${dest}</code>`));
  assert.ok(!fs.existsSync(dest), 'a preview extracts nothing');
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint);

  const run = await finish(await post('/archive/unzip/run', { ...form, fingerprint }));
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.doesNotMatch(run.body, /Free space/, 'the free-space note belongs to the preview');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'src', 'a.txt'), 'utf8'), 'hello');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'src', 'b.txt'), 'utf8'), 'world');

  const missing = await finish(await post('/archive/unzip/preview', { archive: path.join(dir, 'none.zip'), dest: '' }));
  assert.strictEqual(missing.job.status, 'error');
  const blank = await post('/archive/unzip/preview', { archive: '  ', dest: '' });
  assert.strictEqual(blank.status, 400);
});

function makeZip(dir, name, files) {
  const src = path.join(dir, `${name}-src`);
  fs.mkdirSync(src, { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(src, file), content);
  const archive = path.join(dir, `${name}.zip`);
  require('../src/commands').zip(archive, fs.readdirSync(src).map((file) => path.join(src, file)));
  fs.rmSync(src, { recursive: true });
  return archive;
}

test('extract-all: form -> preview -> run -> result table, originals left alone (#258)', async (t) => {
  const dir = tempDir();
  const a = makeZip(dir, 'one', { 'a.txt': 'a' });
  const b = makeZip(dir, 'two', { 'b.txt': 'b', 'c.txt': 'c' });
  const { post, finish } = await serve(t);
  const form = { target: dir };

  const preview = await finish(await post('/archive/extract-all/preview', form));
  assert.strictEqual(preview.job.mode, 'preview', preview.body);
  assert.match(preview.body, /preview: nothing has been changed yet/);
  assert.match(preview.body, /badge-ok">Will extract</);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['one.zip', 'two.zip']);
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint);

  const run = await finish(await post('/archive/extract-all/run', { ...form, fingerprint }));
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.match(run.body, /badge-ok">Extracted</);
  assert.match(run.body, /Left as it is/);
  assert.match(run.body, /<td>one<\/td><td>1<\/td>/);
  assert.match(run.body, /<td>two<\/td><td>2<\/td>/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'two', 'c.txt'), 'utf8'), 'c');
  assert.ok(fs.existsSync(a) && fs.existsSync(b), 'the originals stay without --remove-archives');
});

test('extract-all --remove-archives: the preview names the originals to be removed, and a stale run removes nothing (#258)', async (t) => {
  const dir = tempDir();
  const a = makeZip(dir, 'one', { 'a.txt': 'a' });
  const { post, finish } = await serve(t);
  const form = { target: dir, removeArchives: 'on' };

  const preview = await finish(await post('/archive/extract-all/preview', form));
  assert.deepStrictEqual(preview.job.argv, ['extract-all', '--remove-archives', '--', dir]);
  assert.match(preview.body, /Will go to the Recycle Bin/);
  assert.match(preview.body, /Originals to send to the Recycle Bin/);
  assert.ok(fs.existsSync(a));
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint);
  assert.match(preview.body, /name="removeArchives" value="on"/, 'the run form carries the option');

  // The folder changes after the preview, so the run is turned into a new preview and nothing is extracted or removed.
  makeZip(dir, 'late', { 'l.txt': 'l' });
  const stale = await finish(await post('/archive/extract-all/run', { ...form, fingerprint }));
  assert.strictEqual(stale.job.outcome.repreview, true, stale.body);
  assert.match(stale.body, /folder changed after the preview/);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['late.zip', 'one.zip']);
});

test('parseLines and the specs build the argv from the named fields only (#258)', () => {
  assert.deepStrictEqual(archiveScreens.parseLines(' a.txt\r\n"b c.txt"\n\n  \n'), ['a.txt', 'b c.txt']);
  const zip = archiveScreens.specs.find((spec) => spec.command === 'zip');
  // A source that looks like an option stays a path because it comes after --.
  assert.deepStrictEqual(zip.toArgv({ archive: 'x.zip', sources: '--force', force: '' }), ['zip', '--', 'x.zip', '--force']);
  const all = archiveScreens.specs.find((spec) => spec.command === 'extract-all');
  assert.deepStrictEqual(all.toArgv({ target: 'D:\\dl', removeArchives: '' }), ['extract-all', '--', 'D:\\dl']);
});

test('unzip preview warns when the extraction folder already has entries; zip strips quotes around the archive (#258)', async (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'new');
  const archive = path.join(dir, 'pack.zip');
  const { post, finish } = await serve(t);
  const quoted = `"${archive}"`;
  const made = await finish(await post('/archive/zip/preview', { archive: quoted, sources: path.join(dir, 'src') }));
  assert.strictEqual(made.job.argv[2], archive, 'the quotes around the zip archive are removed');
  await finish(await post('/archive/zip/run', { archive: quoted, sources: path.join(dir, 'src'), fingerprint: fingerprintOf(made.body) }));

  const fresh = path.join(dir, 'fresh');
  const none = await finish(await post('/archive/unzip/preview', { archive, dest: fresh }));
  assert.doesNotMatch(none.body, /extraction folder already exists/);

  const dest = path.join(dir, 'existing');
  fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'src', 'a.txt'), 'old');
  fs.writeFileSync(path.join(dest, 'other.txt'), 'x');
  const preview = await finish(await post('/archive/unzip/preview', { archive, dest }));
  assert.match(preview.body, /alert-warning[^>]*>The extraction folder already exists and has 2 entries\. Files in the archive with the same name will overwrite them/);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'src', 'a.txt'), 'utf8'), 'old', 'a preview overwrites nothing');
});
