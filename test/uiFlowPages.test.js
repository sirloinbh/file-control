'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../src/ui/server');
const { BusyError } = require('../src/ui/jobs');
const { jobRoutes, resultPage } = require('../src/ui/jobPages');
const { flowRoutes } = require('../src/ui/flowPages');
const { FcError } = require('../src/commands');

const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);

const spec = {
  command: 'rm',
  path: '/files/rm',
  title: 'Delete',
  fields: [
    { name: 'target', label: 'Target', kind: 'path' },
    { name: 'force', label: 'Force', kind: 'checkbox' },
    { name: 'permanent', label: 'Permanent', kind: 'checkbox' },
  ],
  toArgv(values) {
    if (!values.target) throw new FcError('Enter a target.');
    return ['rm', values.target, ...(values.force ? ['--force'] : []), ...(values.permanent ? ['--permanent'] : [])];
  },
  doneLabel: 'Sent to Recycle Bin',
  toItems: (outcome) => outcome.result.items,
};

// A fake jobs object that records start() calls and serves canned jobs.
function fakeJobs() {
  const store = new Map();
  const jobs = {
    starts: [],
    busy: false,
    start(argv, options) {
      if (jobs.busy) throw new BusyError({ id: 'live', argv: ['x'] });
      jobs.starts.push({ argv, options });
      const job = { id: `j${jobs.starts.length}`, argv, mode: options && options.mode, status: 'running', startedAt: 0, endedAt: null, lines: [], droppedLines: 0, outcome: null, error: null };
      store.set(job.id, job);
      return job;
    },
    get: (id) => store.get(id),
    running: () => (jobs.busy ? { id: 'live', argv: ['x'] } : null),
    elapsed: (job) => (job.endedAt ?? 0) - job.startedAt,
    finish(job, outcome) {
      Object.assign(job, { status: 'done', endedAt: 1000, outcome });
    },
  };
  return jobs;
}

async function serve(t, jobs) {
  const routes = new Map([...jobRoutes(jobs, { specs: [spec] }), ...flowRoutes(jobs, [spec])]);
  routes.set('/token', (req, { tokenField }) => ({ body: tokenField }));
  const { server, url } = await startServer({ port: 0, routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (p, init = {}) => fetch(new URL(p, url), { redirect: 'manual', ...init });
  const token = /value="([^"]+)"/.exec(await (await get('/token')).text())[1];
  const post = (p, fields) => get(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, ...fields }).toString() });
  return { get, post, token };
}

test('the form has only a Preview button and danger options start unchecked', async (t) => {
  const { get } = await serve(t, fakeJobs());
  const body = await (await get('/files/rm?target=D%3A%5Ca%22%3Cb%3E&force=on&permanent=on')).text();
  assert.match(body, /<form method="post" action="\/files\/rm\/preview">/);
  assert.match(body, /<button type="submit">Preview<\/button>/);
  assert.doesNotMatch(body, />Run</);
  assert.doesNotMatch(body, /checked/);
  assert.match(body, /value="D:\\a&quot;&lt;b&gt;"/);
});

test('preview POST starts a preview job and redirects to its status page', async (t) => {
  const jobs = fakeJobs();
  const { post } = await serve(t, jobs);
  const res = await post('/files/rm/preview', { target: 'D:\\x', evil: '--yes=1' });
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), '/job?id=j1');
  assert.deepStrictEqual(jobs.starts[0], { argv: ['rm', 'D:\\x'], options: { mode: 'preview' } });
  const bad = await post('/files/rm/preview', { target: '' });
  assert.strictEqual(bad.status, 400);
  assert.match(await bad.text(), /Enter a target\./);
  assert.strictEqual(jobs.starts.length, 1);
});

test('run without a valid fingerprint is rejected and starts no job', async (t) => {
  const jobs = fakeJobs();
  const { post } = await serve(t, jobs);
  for (const fingerprint of [undefined, '', 'nope', FP.toUpperCase()]) {
    const res = await post('/files/rm/run', { target: 'D:\\x', ...(fingerprint === undefined ? {} : { fingerprint }) });
    assert.strictEqual(res.status, 400);
    assert.match(await res.text(), /did not come from a preview/);
  }
  assert.strictEqual(jobs.starts.length, 0);
});

test('run with a danger option on but not confirmed is rejected and starts no job', async (t) => {
  const jobs = fakeJobs();
  const { post } = await serve(t, jobs);
  const res = await post('/files/rm/run', { target: 'D:\\x', permanent: 'on', fingerprint: FP });
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /not confirmed again/);
  const forced = await post('/files/rm/run', { target: 'D:\\x', force: 'on', 'confirm-force': 'no', fingerprint: FP });
  assert.strictEqual(forced.status, 400);
  assert.strictEqual(jobs.starts.length, 0);
});

test('a valid run starts a run job with expect and an argv rebuilt from the fields only', async (t) => {
  const jobs = fakeJobs();
  const { post } = await serve(t, jobs);
  const res = await post('/files/rm/run', { target: 'D:\\x', permanent: 'on', 'confirm-permanent': 'yes', fingerprint: FP, argv: '--yes=1', extra: '--force' });
  assert.strictEqual(res.status, 303);
  assert.deepStrictEqual(jobs.starts, [{ argv: ['rm', 'D:\\x', '--permanent'], options: { mode: 'run', expect: FP } }]);
});

test('run while another job runs answers 409 with a link', async (t) => {
  const jobs = fakeJobs();
  jobs.busy = true;
  const { post } = await serve(t, jobs);
  const res = await post('/files/rm/run', { target: 'D:\\x', fingerprint: FP });
  assert.strictEqual(res.status, 409);
  assert.match(await res.text(), /href="\/job\?id=live"/);
});

test('the preview result page carries the run form with escaped values, the fingerprint and the token', async (t) => {
  const jobs = fakeJobs();
  const { post, get, token } = await serve(t, jobs);
  await post('/files/rm/preview', { target: 'D:\\a"><script>', permanent: 'on' });
  jobs.finish(jobs.get('j1'), { command: 'rm', report: 'would delete <x>', result: {}, fingerprint: FP });
  const body = await (await get('/job/result?id=j1')).text();
  assert.match(body, /<pre class="report">would delete &lt;x&gt;<\/pre>/);
  assert.match(body, /<form method="post" action="\/files\/rm\/run">/);
  assert.ok(body.includes(`name="token" value="${token}"`));
  assert.ok(body.includes(`name="fingerprint" value="${FP}"`));
  assert.ok(body.includes('name="target" value="D:\\a&quot;&gt;&lt;script&gt;"'));
  assert.doesNotMatch(body, /<script/i);
  assert.match(body, /name="permanent" value="on"/);
  assert.match(body, /name="confirm-permanent" value="yes" required/);
  assert.doesNotMatch(body, /name="force"/);
  assert.match(body, /<button type="submit">Run<\/button>/);
});

test('a repreview outcome shows the warning and a fresh run form', async (t) => {
  const jobs = fakeJobs();
  const { post, get } = await serve(t, jobs);
  await post('/files/rm/run', { target: 'D:\\x', fingerprint: FP });
  jobs.finish(jobs.get('j1'), { command: 'rm', report: 'new preview', result: {}, fingerprint: FP2, repreview: true });
  const body = await (await get('/job/result?id=j1')).text();
  assert.match(body, /alert-warning[^>]*>The folder changed after the preview/);
  assert.ok(body.includes(`name="fingerprint" value="${FP2}"`));
  assert.ok(!body.includes(FP));
  assert.match(body, /action="\/files\/rm\/run"/);
});

test('a run result shows summary cards and no run form', () => {
  const jobs = fakeJobs();
  const job = {
    id: 'r', argv: ['rm', 'D:\\x'], mode: 'run', status: 'done', startedAt: 0, endedAt: 1, lines: [], droppedLines: 0, error: null,
    outcome: { command: 'rm', ran: true, report: 'r', result: { items: [{ status: 'done', path: 'D:\\x\\a<b>' }, { status: 'failed', path: 'D:\\x\\c', reason: 'locked' }] } },
  };
  const body = resultPage(jobs, job, { specs: [spec], tokenField: '' });
  assert.match(body, /<div class="label">Sent to Recycle Bin<\/div>/);
  assert.match(body, /D:\\x\\a&lt;b&gt;/);
  assert.match(body, /locked/);
  assert.doesNotMatch(body, /\/files\/rm\/run/);
});

// A spec whose toArgv always turns on --permanent, with no checkbox named permanent (first review of #279).
const alwaysPermanent = {
  command: 'rm',
  path: '/files/purge',
  title: 'Purge',
  fields: [{ name: 'target', label: 'Target', kind: 'path' }, { name: 'wipe', label: 'Wipe', kind: 'checkbox' }],
  toArgv(values) {
    if (!values.target) throw new FcError('Enter a target.');
    return ['rm', values.target, '--permanent'];
  },
};

test('the confirmation follows the argv that will run, not the form field names', async (t) => {
  const jobs = fakeJobs();
  const routes = new Map([...jobRoutes(jobs, { specs: [alwaysPermanent] }), ...flowRoutes(jobs, [alwaysPermanent])]);
  routes.set('/token', (req, { tokenField }) => ({ body: tokenField }));
  const { server, url } = await startServer({ port: 0, routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (p, init = {}) => fetch(new URL(p, url), { redirect: 'manual', ...init });
  const token = /value="([^"]+)"/.exec(await (await get('/token')).text())[1];
  const post = (p, fields) => get(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, ...fields }).toString() });

  for (const extra of [{}, { wipe: 'on' }, { permanent: '' }]) {
    const res = await post('/files/purge/run', { target: 'D:/x', fingerprint: FP, ...extra });
    assert.strictEqual(res.status, 400, JSON.stringify(extra));
    assert.match(await res.text(), /not confirmed again/);
  }
  assert.strictEqual(jobs.starts.length, 0);

  // The preview page asks for the permanent-delete confirmation because the argv has --permanent.
  await post('/files/purge/preview', { target: 'D:/x' });
  jobs.finish(jobs.get('j1'), { command: 'rm', report: 'p', result: {}, fingerprint: FP });
  assert.match(await (await get('/job/result?id=j1')).text(), /name="confirm-permanent" value="yes" required/);

  const ok = await post('/files/purge/run', { target: 'D:/x', fingerprint: FP, 'confirm-permanent': 'yes' });
  assert.strictEqual(ok.status, 303);
  assert.deepStrictEqual(jobs.starts[1], { argv: ['rm', 'D:/x', '--permanent'], options: { mode: 'run', expect: FP } });
});

test('a toItems that throws falls back to the report with a warning', () => {
  const jobs = fakeJobs();
  const job = {
    id: 'r', argv: ['rm', 'D:/x'], mode: 'run', status: 'done', startedAt: 0, endedAt: 1, lines: [], droppedLines: 0, error: null,
    outcome: { command: 'rm', ran: true, report: 'Recycled D:/x', result: {} },
  };
  const broken = { ...spec, toItems: () => { throw new Error('no items'); } };
  const body = String(resultPage(jobs, job, { specs: [broken], tokenField: '' }));
  assert.match(body, /Could not build the result table: no items/);
  assert.ok(body.includes('Recycled D:/x'));
});
