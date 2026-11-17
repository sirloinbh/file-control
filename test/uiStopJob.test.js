'use strict';

// The stop button of the job status page (#264).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startUi } = require('./uiClient');
const { createJobs } = require('../src/ui/jobs');
const { jobRoutes, statusPage } = require('../src/ui/jobPages');

const FAKE_WORKER = path.join(__dirname, 'fakeUiWorker.js');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uistop-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function settled(jobs, job, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`job did not finish: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function serve(t, jobs) {
  const { server, get, post } = await startUi({ routes: jobRoutes(jobs) });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { get, post };
}

test('stops a running job, clears the running state, and the next job can start', async (t) => {
  const dir = tempDir();
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const { get, post } = await serve(t, jobs);
  const job = jobs.start(['wait', path.join(dir, 'never')]);

  const statusHtml = await (await get(`/job?id=${job.id}`)).text();
  assert.match(statusHtml, /<form method="post" action="\/job\/stop">/);
  assert.match(statusHtml, /name="token"/);
  assert.match(statusHtml, /Stop job/);

  const stopped = await post('/job/stop', { id: job.id });
  assert.strictEqual(stopped.status, 303);
  assert.strictEqual(stopped.headers.get('location'), `/job/result?id=${job.id}`);
  assert.strictEqual(job.status, 'stopped');
  assert.ok(!jobs.running());

  const result = await get(`/job/result?id=${job.id}`);
  assert.strictEqual(result.status, 200);
  const resultHtml = await result.text();
  assert.match(resultHtml, /Stopped\./);
  assert.match(resultHtml, /not undone/);

  const next = jobs.start(['progress', '1']);
  await settled(jobs, next);
  assert.strictEqual(next.status, 'done');
});

test('a stop request without a token is rejected and the job keeps running', async (t) => {
  const dir = tempDir();
  const flag = path.join(dir, 'go');
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const { get } = await serve(t, jobs);
  const job = jobs.start(['wait', flag]);
  const res = await get('/job/stop', {
    method: 'POST',
    body: new URLSearchParams({ id: job.id }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.ok(res.status >= 400);
  assert.strictEqual(job.status, 'running');
  fs.writeFileSync(flag, '');
  await settled(jobs, job);
  assert.strictEqual(job.status, 'done');
});

test('stopping a finished or unknown job is handled', async (t) => {
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const { post } = await serve(t, jobs);
  const job = jobs.start(['progress', '1']);
  await settled(jobs, job);
  const done = await post('/job/stop', { id: job.id });
  assert.strictEqual(done.status, 303);
  assert.strictEqual(job.status, 'done');
  assert.strictEqual((await post('/job/stop', { id: 'nope' })).status, 404);
  assert.strictEqual((await post('/job/stop')).status, 404);
});

test('the status page warns when there has been no progress for a long time', () => {
  const job = { id: 'a', argv: ['wait'], lines: [], droppedLines: 0 };
  const quiet = statusPage({ elapsed: () => 90_000, idle: () => 90_000 }, job).toString();
  assert.match(quiet, /No progress for 1m 30s/);
  const fresh = statusPage({ elapsed: () => 90_000, idle: () => 1_000 }, job).toString();
  assert.doesNotMatch(fresh, /No progress for/);
});
