'use strict';

// The shared preview -> run flow end to end (#255): the real server, the real job process (worker.js) and real files.
// It covers the done criteria of #255: a run request without a preview, a fingerprint mismatch (the folder changed after
// the preview) and permanent deletion without the extra confirmation all do not run.
// mv is used because it does not touch the Recycle Bin. The rm spec only checks a rejection, so it never runs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { startServer } = require('../src/ui/server');
const { createJobs } = require('../src/ui/jobs');
const { jobRoutes } = require('../src/ui/jobPages');
const { flowRoutes } = require('../src/ui/flowPages');

const mvSpec = {
  command: 'mv',
  path: '/files/mv',
  title: 'Move',
  fields: [
    { name: 'source', label: 'Source', kind: 'text' },
    { name: 'dest', label: 'Destination', kind: 'text' },
    { name: 'force', label: 'Overwrite', kind: 'checkbox' },
  ],
  toArgv(values) {
    if (!values.source || !values.dest) throw new FcError('Enter a source and a destination.');
    return ['mv', values.source, values.dest, ...(values.force ? ['--force'] : [])];
  },
  doneLabel: 'Moved',
};

// normalize only renames files (no Recycle Bin), and adding a file changes its preview.
const normalizeSpec = {
  command: 'normalize',
  path: '/organize/normalize',
  title: 'Normalize names',
  fields: [{ name: 'target', label: 'Target folder', kind: 'text' }],
  toArgv(values) {
    if (!values.target) throw new FcError('Enter a target folder.');
    return ['normalize', values.target];
  },
  doneLabel: 'Renamed',
};

const rmSpec = {
  command: 'rm',
  path: '/files/rm',
  title: 'Delete',
  fields: [
    { name: 'target', label: 'Target', kind: 'text' },
    { name: 'permanent', label: 'Permanent delete', kind: 'checkbox' },
  ],
  toArgv(values) {
    if (!values.target) throw new FcError('Enter a target.');
    return ['rm', values.target, ...(values.permanent ? ['--permanent'] : [])];
  },
  doneLabel: 'Deleted',
};

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uiflow-e2e-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function settled(jobs, job, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`The job did not finish: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The temp folder is inside the user folder (AppData), which whole-folder commands refuse as a protected path.
// The job process gets a home folder that does not exist, the same way test/uiCheckedRun.test.js mocks os.homedir.
const FAKE_HOME = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');

async function serve(t) {
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: FAKE_HOME } });
  const specs = [mvSpec, normalizeSpec, rmSpec];
  const routes = new Map([...jobRoutes(jobs, { specs }), ...flowRoutes(jobs, specs)]);
  routes.set('/token', (req, { tokenField }) => ({ body: tokenField }));
  const { server, url } = await startServer({ port: 0, routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (p, init = {}) => fetch(new URL(p, url), { redirect: 'manual', ...init });
  const token = /value="([^"]+)"/.exec(await (await get('/token')).text())[1];
  const post = (p, fields) => get(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, ...fields }).toString() });
  // Follows a 303 to the job, waits for it to end and returns the result page.
  const finish = async (res) => {
    assert.strictEqual(res.status, 303, await res.clone().text());
    const id = new URL(res.headers.get('location'), url).searchParams.get('id');
    const job = jobs.get(id);
    await settled(jobs, job);
    const page = await get(`/job/result?id=${id}`);
    assert.strictEqual(page.status, 200);
    return { job, body: await page.text() };
  };
  return { jobs, post, finish };
}

const fingerprintOf = (body) => /name="fingerprint" value="([0-9a-f]{64})"/.exec(body)?.[1];

test('a run request without a preview is refused and changes nothing (#255)', async (t) => {
  const dir = tempDir();
  const source = path.join(dir, 'a.txt');
  fs.writeFileSync(source, 'a');
  const { jobs, post } = await serve(t);
  const res = await post('/files/mv/run', { source, dest: path.join(dir, 'b.txt') });
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /did not come from a preview/);
  assert.strictEqual(jobs.running(), null);
  assert.ok(fs.existsSync(source));
});

test('preview -> folder changes -> run shows a new preview and changes nothing; running the new preview renames (#255)', async (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'movie ABC-123.mp4'), 'a');
  const { post, finish } = await serve(t);

  const preview = await finish(await post('/organize/normalize/preview', { target: dir }));
  assert.strictEqual(preview.job.mode, 'preview', preview.body);
  const first = fingerprintOf(preview.body);
  assert.ok(first, 'the preview page carries a Run form with the fingerprint');
  assert.deepStrictEqual(fs.readdirSync(dir), ['movie ABC-123.mp4'], 'a preview renames nothing');

  // The folder changes after the preview: another file appears.
  fs.writeFileSync(path.join(dir, 'clip XYZ-777.mp4'), 'b');
  const stale = await finish(await post('/organize/normalize/run', { target: dir, fingerprint: first }));
  assert.strictEqual(stale.job.outcome.repreview, true, stale.body);
  assert.match(stale.body, /folder changed after the preview/);
  assert.match(stale.body, /XYZ-777/, 'the new preview shows the new file');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['clip XYZ-777.mp4', 'movie ABC-123.mp4'], 'a stale run renames nothing');
  const second = fingerprintOf(stale.body);
  assert.ok(second && second !== first, 'the new preview carries a new fingerprint');

  const run = await finish(await post('/organize/normalize/run', { target: dir, fingerprint: second }));
  assert.strictEqual(run.job.mode, 'run');
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['ABC-123 movie.mp4', 'XYZ-777 clip.mp4']);
});

test('a run whose fresh preview fails (the destination appeared after the preview) moves nothing and shows the reason (#255)', async (t) => {
  const dir = tempDir();
  const source = path.join(dir, 'a.txt');
  const destDir = path.join(dir, 'to');
  fs.writeFileSync(source, 'a');
  fs.mkdirSync(destDir);
  const { post, finish } = await serve(t);

  const preview = await finish(await post('/files/mv/preview', { source, dest: destDir }));
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint);
  fs.writeFileSync(path.join(destDir, 'a.txt'), 'other');
  const run = await finish(await post('/files/mv/run', { source, dest: destDir, fingerprint }));
  assert.strictEqual(run.job.status, 'error');
  assert.match(run.body, /Already exists/);
  assert.ok(fs.existsSync(source));
  assert.strictEqual(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8'), 'other');
});

test('overwrite and permanent delete without the extra confirmation are refused and change nothing (#255)', async (t) => {
  const dir = tempDir();
  const target = path.join(dir, 'keep.txt');
  fs.writeFileSync(target, 'keep');
  const { jobs, post, finish } = await serve(t);

  const preview = await finish(await post('/files/rm/preview', { target, permanent: 'on' }));
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint);
  assert.match(preview.body, /name="confirm-permanent" value="yes" required/);
  for (const confirm of [{}, { 'confirm-permanent': 'no' }]) {
    const res = await post('/files/rm/run', { target, permanent: 'on', fingerprint, ...confirm });
    assert.strictEqual(res.status, 400);
    assert.match(await res.text(), /not confirmed again/);
    assert.strictEqual(jobs.running(), null);
    assert.ok(fs.existsSync(target));
  }

  const destDir = path.join(dir, 'to');
  fs.mkdirSync(destDir);
  fs.writeFileSync(path.join(destDir, 'keep.txt'), 'old');
  const res = await post('/files/mv/run', { source: target, dest: destDir, force: 'on', fingerprint: 'c'.repeat(64) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(fs.readFileSync(path.join(destDir, 'keep.txt'), 'utf8'), 'old');
});
