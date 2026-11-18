'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startUi } = require('./uiClient');
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
  const { server, url, token, get, post } = await startUi({ routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
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
  const { server, url, token, get, post } = await startUi({ routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));

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

test('the preview page shows what each source holds, escaped, with link notes', () => {
  const jobs = fakeJobs();
  const sources = [
    { path: 'D:\\a<b>', type: 'dir', count: 1, size: 2048, digest: 'x' },
    { path: 'D:\\empty', type: 'dir', count: 2, size: 0, digest: 'x' },
    { path: 'D:\\f.txt', type: 'file', count: 0, size: 5, digest: 'x' },
    { path: 'D:\\lnk', type: 'link', count: 3, size: 10, digest: 'x', target: 'D:\\t<arget>' },
    { path: 'D:\\gone', type: 'missing', count: 0, size: 0, digest: '' },
  ];
  // The snapshot marks a link it read through as followed (cp, and mv to another volume, #284).
  const render = (command) => String(resultPage(jobs, {
    id: 'p', argv: [command, 'D:\\a'], mode: 'preview', status: 'done', startedAt: 0, endedAt: 1, lines: [], droppedLines: 0, error: null,
    outcome: { command, report: 'r', result: {}, fingerprint: FP, sources: sources.map((s) => (command === 'cp' && s.type === 'link' ? { ...s, followed: true } : s)) },
  }, { specs: [{ ...spec, command }], tokenField: '' }));
  const rm = render('rm');
  for (const label of ['Source', 'Type', 'Items inside', 'Total size', 'Folder', 'File', 'Link', 'Missing']) assert.ok(rm.includes(label), label);
  assert.ok(rm.includes('D:\\a&lt;b&gt;'));
  assert.ok(!rm.includes('<b>'));
  assert.ok(rm.includes('1 item<') && rm.includes('2 items<'));
  assert.ok(rm.includes('D:\\t&lt;arget&gt;') && rm.includes('are not touched'));
  assert.ok(!rm.includes('3 items'), 'rm does not count what a link leads to');
  const cp = render('cp');
  assert.ok(cp.includes('3 items') && cp.includes('are included'));
  assert.ok(!cp.includes('Will be overwritten'), 'no destination snapshot, no overwrite table');
});

test('the preview page of a --force run lists what will be overwritten, escaped (#284)', () => {
  const jobs = fakeJobs();
  const destinations = [
    { path: 'D:\\to\\a<b>', type: 'dir', count: 2, size: 1024, digest: 'x' },
    { path: 'D:\\to\\f.txt', type: 'file', count: 0, size: 5, digest: 'x' },
    { path: 'D:\\to\\lnk', type: 'link', count: 0, size: 0, digest: 'x', target: 'D:\\t<arget>' },
    { path: 'D:\\to\\new', type: 'missing', count: 0, size: 0, digest: '' },
  ];
  const render = (command, list) => String(resultPage(jobs, {
    id: 'p', argv: [command, '--force', 'D:\\a', 'D:\\to'], mode: 'preview', status: 'done', startedAt: 0, endedAt: 1, lines: [], droppedLines: 0, error: null,
    outcome: { command, report: 'r', result: {}, fingerprint: FP, sources: [], destinations: list },
  }, { specs: [{ ...spec, command }], tokenField: '' }));
  const mv = render('mv', destinations);
  assert.ok(mv.includes('<h2>Will be overwritten</h2>'));
  assert.ok(mv.includes('replaced as a whole') && mv.includes('3 existing items at the destination, 1.0KB in all'), mv);
  assert.ok(mv.includes('D:\\to\\a&lt;b&gt;') && !mv.includes('<b>'));
  assert.ok(mv.includes('2 items<'));
  assert.ok(mv.includes('D:\\t&lt;arget&gt;') && mv.includes('Only the link is replaced'));
  assert.ok(!mv.includes('D:\\to\\new'), 'a destination that does not exist yet is not listed');
  assert.ok(render('cp', destinations).includes('a folder is merged'));
  assert.ok(render('cp', [destinations[3]]).includes('nothing is overwritten'));
});
