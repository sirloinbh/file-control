'use strict';

// The stop button of the job status page (#264).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { startUi } = require('./uiClient');
const { createJobs } = require('../src/ui/jobs');
const { jobRoutes, statusPage } = require('../src/ui/jobPages');

const FAKE_WORKER = path.join(__dirname, 'fakeUiWorker.js');
// Tests that expect a real worker to end as stopped wait longer than the 5 s default (#436).
// In a loaded full run, taskkill and close can take over 5 s, and stop() would then give up and settle the job as error.
// The give-up path itself is tested with a short stopWaitMs below (#330).
const TEST_STOP_WAIT_MS = 60000;

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
  const jobs = createJobs({ workerPath: FAKE_WORKER, stopWaitMs: TEST_STOP_WAIT_MS });
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
  assert.strictEqual(res.status, 403);
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

test('a double stop is harmless', async (t) => {
  const dir = tempDir();
  const jobs = createJobs({ workerPath: FAKE_WORKER, stopWaitMs: TEST_STOP_WAIT_MS });
  const { post } = await serve(t, jobs);
  const job = jobs.start(['wait', path.join(dir, 'never')]);
  const [first, second] = await Promise.all([post('/job/stop', { id: job.id }), post('/job/stop', { id: job.id })]);
  assert.strictEqual(first.status, 303);
  assert.strictEqual(second.status, 303);
  assert.strictEqual(job.status, 'stopped');
  assert.ok(!jobs.running());
  assert.strictEqual((await post('/job/stop', { id: job.id })).status, 303);
});

test('stop does not kill a child that already exited (its pid may be reused), but still lets close fire', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 4242, exitCode: 0, signalCode: null, send() {}, killed: 0, kill() { this.killed += 1; } });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() { this.destroyed = true; setImmediate(() => child.emit('close', 0, null)); } });
  const jobs = createJobs({ fork: () => child });
  const job = jobs.start(['wait', 'x']);
  await jobs.stop(job);
  assert.strictEqual(child.killed, 0);
  assert.strictEqual(child.stderr.destroyed, true);
  assert.strictEqual(job.status, 'stopped');
  assert.ok(!jobs.running());
});

test('the status page shows Still stopping while a stop request is waiting for close', () => {
  const job = { id: 'a', argv: ['wait'], lines: [], droppedLines: 0, stopRequested: true };
  assert.match(statusPage({ elapsed: () => 1_000, idle: () => 0 }, job).toString(), /Still stopping/);
});

test('jobs.idle counts from the last progress line, or from the start, with an injected clock', () => {
  let time = 1000;
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, exitCode: null, signalCode: null, send() {}, kill() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
  const jobs = createJobs({ fork: () => child, now: () => time });
  const job = jobs.start(['wait', 'x']);
  time = 1000 + 90_000;
  assert.strictEqual(jobs.idle(job), 90_000);
  assert.match(statusPage(jobs, job).toString(), /No progress for 1m 30s/);
  child.emit('message', { type: 'progress', line: 'x' });
  assert.strictEqual(jobs.idle(job), 0);
  assert.doesNotMatch(statusPage(jobs, job).toString(), /No progress for/);
});

test('the status page warns when there has been no progress for a long time', () => {
  const job = { id: 'a', argv: ['wait'], lines: [], droppedLines: 0 };
  const quiet = statusPage({ elapsed: () => 90_000, idle: () => 90_000 }, job).toString();
  assert.match(quiet, /No progress for 1m 30s/);
  const fresh = statusPage({ elapsed: () => 90_000, idle: () => 1_000 }, job).toString();
  assert.doesNotMatch(fresh, /No progress for/);
});

// ---- shutdown and a process that ignores the kill (#330) ----

function stubbornFork() {
  // A child that never closes, whatever it is told.
  const child = new EventEmitter();
  Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, stderr: null, send() {}, kill() {} });
  return child;
}

test('a process that ignores the kill is given up after the wait, and the UI can start a new job (#330)', async () => {
  const dir = tempDir();
  let first = true;
  const fork = (...args) => {
    if (!first) return require('node:child_process').fork(...args);
    first = false;
    return stubbornFork();
  };
  const jobs = createJobs({ workerPath: FAKE_WORKER, fork, stopWaitMs: 50 });
  const job = jobs.start(['wait', path.join(dir, 'never')]);
  await jobs.stop(job);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error.message, /did not end/);
  assert.ok(!jobs.running());
  const next = jobs.start(['progress', '1']);
  await settled(jobs, next);
  assert.strictEqual(next.status, 'done');
});

test('stopAll stops the running job and does nothing when there is none (#330)', async () => {
  const dir = tempDir();
  const jobs = createJobs({ workerPath: FAKE_WORKER, stopWaitMs: TEST_STOP_WAIT_MS });
  await jobs.stopAll();
  const job = jobs.start(['wait', path.join(dir, 'never')]);
  await jobs.stopAll();
  assert.strictEqual(job.status, 'stopped');
  assert.ok(!jobs.running());
});

test('SIGINT in runUi stops the running job before it reports the server stopped (#330)', async () => {
  const { runUi } = require('../src/ui/server');
  const dir = tempDir();
  const jobs = createJobs({ workerPath: FAKE_WORKER, stopWaitMs: TEST_STOP_WAIT_MS });
  const routes = new Map([...jobRoutes(jobs)]);
  routes.jobs = jobs;
  const lines = [];
  const before = process.listeners('SIGINT');
  const server = await runUi(['--no-open', '--port=0'], { out: (line) => lines.push(line), routes });
  const job = jobs.start(['wait', path.join(dir, 'never')]);
  const handler = process.listeners('SIGINT').find((fn) => !before.includes(fn));
  handler();
  const until = Date.now() + TEST_STOP_WAIT_MS + 10000;
  while (!lines.includes('UI server stopped.') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(lines.includes('UI server stopped.'));
  assert.strictEqual(job.status, 'stopped');
  process.removeListener('SIGINT', handler);
  server.close();
});
