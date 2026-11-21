'use strict';

// The "Find and delete" screens (#259): the forms, the preview -> run flow, and the result screens.
// - In-process tests fake the Recycle Bin (same approach as uiCheckedRun.test.js), so a real run is covered without touching the real Recycle Bin.
// - HTTP tests use the real server and the real job process, but stop at a preview, a stale run or a refused run, so nothing is ever sent to the Recycle Bin.

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temp folder is under the user's AppData, a protected path, so the user folder is swapped with a path that does not exist.
const FAKE_HOME = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');
test.mock.method(os, 'homedir', () => FAKE_HOME);

// Keep test files out of the real Recycle Bin. It is swapped before commands.js is imported.
const realExecFileSync = childProcess.execFileSync;
const recycled = [];
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) return 'NTFS\r\n';
  if (options?.env?.FC_VOLUME !== undefined) return 'True|Fixed\r\n';
  if (options?.env?.FC_RECYCLE_FILES !== undefined) {
    const lines = [];
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

// Files made just now are protected from removal, so the in-process clock is moved forward 1 hour.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
test.mock.method(Date, 'now', () => realNow() + HOUR);

const { FcError } = require('../src/commands');
const { execute } = require('../src/execute');
const { runOnce } = require('../src/ui/worker');
const { resultPage, jobRoutes } = require('../src/ui/jobPages');
const { flowRoutes } = require('../src/ui/flowPages');
const { createJobs } = require('../src/ui/jobs');
const cleanup = require('../src/ui/screens/cleanup');
const { startUi } = require('./uiClient');

const OLD = new Date(realNow() - HOUR);
const BROKEN = '<html>not found</html>';
const spec = (command) => cleanup.specs.find((candidate) => candidate.command === command);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uicleanup-screens-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, OLD, OLD);
  }
}

test.beforeEach(() => {
  recycled.length = 0;
});

// ---- specs ----

test('the screen module exports the six commands under /cleanup and is registered in the server', () => {
  assert.deepStrictEqual(cleanup.specs.map((s) => s.command), ['remove-broken', 'remove-duplicates', 'remove-low-quality']);
  assert.deepStrictEqual(Object.keys(cleanup.views).sort(), ['find-broken', 'find-duplicates', 'find-low-quality', 'remove-broken', 'remove-duplicates', 'remove-low-quality']);
  for (const s of cleanup.specs) assert.ok(s.path.startsWith('/cleanup/'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'server.js'), 'utf8'), /SCREENS = \[[^\]]*require\('\.\/screens\/cleanup'\)/);
});

test('toArgv builds the argv from the named fields and refuses bad input before any job starts', () => {
  const low = spec('remove-low-quality');
  assert.deepStrictEqual(low.toArgv({ target: ' D:\\v ', minHeight: '480', minBitrate: '1000' }), ['remove-low-quality', '--min-height=480', '--min-bitrate=1000', '--', 'D:\\v']);
  assert.deepStrictEqual(low.toArgv({ target: 'D:\\v', minHeight: '', minBitrate: '' }), ['remove-low-quality', '--', 'D:\\v']);
  assert.deepStrictEqual(spec('remove-broken').toArgv({ target: 'D:\\v' }), ['remove-broken', '--', 'D:\\v']);
  // A relative target, an option-looking target and a protected place are refused (#329).
  for (const target of ['.', 'v', '--yes=abc', '-x', 'C:\\Windows', 'D:\\v.']) assert.throws(() => spec('remove-broken').toArgv({ target }), FcError, target);
  assert.throws(() => low.toArgv({ target: '', minHeight: '', minBitrate: '' }), FcError);
  assert.throws(() => low.toArgv({ target: 'D:\\v', minHeight: '--yes=1', minBitrate: '' }), FcError);
  assert.throws(() => low.toArgv({ target: 'D:\\v', minHeight: '', minBitrate: '12 --force' }), FcError);
});

// ---- in-process: preview -> run with the fake Recycle Bin ----

// Runs a job like the job process does and renders the result page the way the server does.
function runJob(argv, { mode, expect } = {}) {
  const sent = [];
  runOnce(argv, (msg) => sent.push(msg), { mode, expect });
  const last = sent.at(-1);
  assert.strictEqual(last.type, 'done', JSON.stringify(last));
  const job = { id: 'x', argv, mode, status: 'done', lines: [], droppedLines: 0, outcome: last.outcome, error: null };
  const jobs = { elapsed: () => 0, running: () => null };
  const body = String(resultPage(jobs, job, { views: cleanup.views, specs: cleanup.specs, tokenField: '' }));
  return { outcome: last.outcome, body };
}

test('remove-broken: the preview shows the list and a Run form without a code field; a stale run deletes nothing; the run sends files to the Recycle Bin and shows the log', () => {
  const dir = tempDir();
  make(dir, { 'bad.mp4': BROKEN, 'good.txt': 'fine text' });
  const argv = spec('remove-broken').toArgv({ target: dir });

  const preview = runJob(argv, { mode: 'preview' });
  assert.match(preview.body, /Nothing is deleted yet/);
  assert.match(preview.body, /<td>bad\.mp4<\/td>/);
  assert.match(preview.body, /action="\/cleanup\/remove-broken\/run"/);
  assert.match(preview.body, /name="fingerprint" value="[0-9a-f]{64}"/);
  assert.doesNotMatch(preview.body, /name="yes"|name="code"|confirm/i, 'the user is never asked to type a confirmation code');
  assert.deepStrictEqual(recycled, []);

  make(dir, { 'bad2.mp4': BROKEN + ' again' });
  const stale = runJob(argv, { mode: 'run', expect: preview.outcome.fingerprint });
  assert.strictEqual(stale.outcome.repreview, true);
  assert.match(stale.body, /folder changed after the preview/);
  assert.match(stale.body, /<td>bad2\.mp4<\/td>/);
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'bad.mp4')));

  const done = runJob(argv, { mode: 'run', expect: stale.outcome.fingerprint });
  assert.strictEqual(done.outcome.ran, true);
  assert.deepStrictEqual(recycled.sort(), [path.join(dir, 'bad.mp4'), path.join(dir, 'bad2.mp4')].sort());
  assert.ok(fs.existsSync(path.join(dir, 'good.txt')));
  assert.match(done.body, /Sent 2 files to the Recycle Bin\./);
  assert.match(done.body, /Removal log: <code>[^<]*fctl-removed-[^<]*<\/code>/);
  assert.ok(fs.existsSync(done.outcome.result.log), 'the log file exists');
  assert.doesNotMatch(done.body, /action="\/cleanup\/remove-broken\/run"/, 'a finished run has no Run form');
});

test('a run without a valid fingerprint is refused and deletes nothing', () => {
  const dir = tempDir();
  make(dir, { 'bad.mp4': BROKEN });
  const sent = [];
  runOnce(['remove-broken', dir], (msg) => sent.push(msg), { mode: 'run' });
  assert.strictEqual(sent.at(-1).type, 'error');
  assert.deepStrictEqual(recycled, []);
  assert.ok(fs.existsSync(path.join(dir, 'bad.mp4')));
});

test('remove-low-quality: the preview of an empty folder says there is nothing to delete', () => {
  const dir = tempDir();
  make(dir, { 'note.txt': 'text' });
  const preview = runJob(spec('remove-low-quality').toArgv({ target: dir, minHeight: '480', minBitrate: '' }), { mode: 'preview' });
  assert.match(preview.body, /There is nothing to delete\./);
  assert.match(preview.body, /Criteria: below short side 480 px/);
});

test('find-broken and find-duplicates results render from the real commands', () => {
  const dir = tempDir();
  make(dir, { 'bad&1.zip': 'not a zip', 'ok.txt': 'text' });
  const found = execute(['find-broken', dir]);
  assert.strictEqual(found.command, 'find-broken');
  const sent = [];
  runOnce(['find-duplicates', dir], (msg) => sent.push(msg));
  assert.match(String(cleanup.views['find-duplicates'](sent.at(-1).outcome)), /No duplicate candidates\./);
});

// ---- HTTP: the real server and the real job process, stopping before any deletion ----

async function settled(jobs, job, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (realNow() > until) throw new Error(`The job did not finish: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function serve(t) {
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: FAKE_HOME } });
  const routes = new Map([...jobRoutes(jobs, { specs: cleanup.specs, views: cleanup.views }), ...flowRoutes(jobs, cleanup.specs), ...cleanup.routes(jobs)]);
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

test('HTTP: the landing page lists the six commands and every screen has a form', async (t) => {
  const { get } = await serve(t);
  const landing = await (await get('/cleanup')).text();
  for (const command of ['find-broken', 'find-duplicates', 'find-low-quality', 'remove-broken', 'remove-duplicates', 'remove-low-quality']) {
    assert.ok(landing.includes(`href="/cleanup/${command}"`), command);
    const form = await get(`/cleanup/${command}`);
    assert.strictEqual(form.status, 200, command);
    const body = await form.text();
    assert.match(body, /name="target"/, command);
    assert.match(body, /name="token"/, command);
    assert.match(body, new RegExp(`action="/cleanup/${command}(/start|/preview)"`), command);
  }
  const low = await (await get('/cleanup/find-low-quality?target=D%3A%5Cv')).text();
  assert.match(low, /name="minHeight"/);
  assert.match(low, /name="minBitrate"/);
  assert.match(low, /value="D:\\v"/);
});

test('HTTP: find-broken shows a result table and changes nothing; there is no Run button', async (t) => {
  const dir = tempDir();
  make(dir, { 'bad&1.zip': 'not a zip', 'ok.txt': 'text' });
  const { post, finish } = await serve(t);
  const result = await finish(await post('/cleanup/find-broken/start', { target: dir }));
  assert.strictEqual(result.job.mode, undefined);
  assert.match(result.body, /<td>bad&amp;1\.zip<\/td>/);
  assert.match(result.body, /Suspect/);
  assert.doesNotMatch(result.body, /name="fingerprint"/);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['bad&1.zip', 'ok.txt']);
});

test('HTTP: find-low-quality passes the limits and find-duplicates reports nothing for an empty folder', async (t) => {
  const dir = tempDir();
  make(dir, { 'note.txt': 'text' });
  const { post, finish } = await serve(t);
  const low = await finish(await post('/cleanup/find-low-quality/start', { target: dir, minHeight: '480', minBitrate: '900' }));
  assert.deepStrictEqual(low.job.argv, ['find-low-quality', '--min-height=480', '--min-bitrate=900', '--', dir]);
  assert.match(low.body, /Criteria: below short side 480 px or bitrate 900 kbps/);
  const dup = await finish(await post('/cleanup/find-duplicates/start', { target: dir }));
  assert.match(dup.body, /No duplicate candidates\./);
});

test('HTTP: a bad limit or a missing folder is refused with a reason and starts no job', async (t) => {
  const { jobs, post } = await serve(t);
  for (const [route, fields] of [
    ['/cleanup/find-low-quality/start', { target: 'D:\\v', minHeight: 'abc' }],
    ['/cleanup/find-broken/start', { target: '' }],
    ['/cleanup/remove-low-quality/preview', { target: 'D:\\v', minBitrate: '1;2' }],
    ['/cleanup/remove-broken/preview', { target: '  ' }],
  ]) {
    const res = await post(route, fields);
    assert.strictEqual(res.status, 400, route);
    assert.match(await res.text(), /Enter a/);
    assert.strictEqual(jobs.running(), null);
  }
});

test('HTTP: remove-broken preview, then a folder change makes the run show a new preview and delete nothing', async (t) => {
  const dir = tempDir();
  make(dir, { 'bad.mp4': BROKEN, 'good.txt': 'fine text' });
  const { jobs, post, finish } = await serve(t);

  const preview = await finish(await post('/cleanup/remove-broken/preview', { target: dir }));
  assert.strictEqual(preview.job.mode, 'preview', preview.body);
  const first = fingerprintOf(preview.body);
  assert.ok(first, preview.body);
  assert.match(preview.body, /<td>bad\.mp4<\/td>/);
  assert.match(preview.body, /Send to the Recycle Bin/);
  assert.doesNotMatch(preview.body, /name="(yes|code)"/);

  make(dir, { 'bad2.mp4': BROKEN + ' again' });
  const stale = await finish(await post('/cleanup/remove-broken/run', { target: dir, fingerprint: first }));
  assert.strictEqual(stale.job.outcome.repreview, true, stale.body);
  assert.match(stale.body, /folder changed after the preview/);
  assert.match(stale.body, /<td>bad2\.mp4<\/td>/);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['bad.mp4', 'bad2.mp4', 'good.txt'], 'a stale run deletes nothing');
  assert.notStrictEqual(fingerprintOf(stale.body), first);

  // A run request that did not come from a preview is refused outright.
  const none = await post('/cleanup/remove-broken/run', { target: dir });
  assert.strictEqual(none.status, 400);
  assert.match(await none.text(), /did not come from a preview/);
  assert.strictEqual(jobs.running(), null);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['bad.mp4', 'bad2.mp4', 'good.txt']);
});

test('HTTP: remove-duplicates and remove-low-quality previews of a folder with nothing to delete carry no deletion', async (t) => {
  const dir = tempDir();
  make(dir, { 'note.txt': 'text' });
  const { post, finish } = await serve(t);
  for (const [command, fields] of [['remove-duplicates', { target: dir }], ['remove-low-quality', { target: dir, minHeight: '720' }]]) {
    const preview = await finish(await post(`/cleanup/${command}/preview`, fields));
    assert.strictEqual(preview.job.mode, 'preview', preview.body);
    assert.match(preview.body, /There is nothing to delete\./, command);
    assert.deepStrictEqual(fs.readdirSync(dir), ['note.txt']);
  }
});
