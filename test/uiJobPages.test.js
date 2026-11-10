'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/ui/server');
const { createJobs } = require('../src/ui/jobs');
const { jobRoutes, startJobResponse, runButton, resultPage, statusPage } = require('../src/ui/jobPages');
const { page } = require('../src/ui/layout');
const { html } = require('../src/ui/html');

const FAKE_WORKER = path.join(__dirname, 'fakeUiWorker.js');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uijobpages-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function settled(jobs, job, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`작업이 끝나지 않음: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 테스트용 서버: 작업 페이지에 POST /start(본문 없이 argv를 정해 둠)를 더한다.
async function serve(t, jobs, argvForStart) {
  const routes = jobRoutes(jobs);
  routes.set('/start', { POST: (req, { available }) => startJobResponse(jobs, argvForStart(), { available }) });
  const { server, url } = await startServer({ port: 0, routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (p, init = {}) => fetch(new URL(p, url), { redirect: 'manual', ...init });
  return { get };
}

// 끝난 작업 객체(서버 없이 화면만 볼 때 쓴다).
function finished(fields) {
  return { id: 'abc', argv: ['flatten', 'D:\\a<b>'], status: 'done', startedAt: 0, endedAt: 65_000, lines: [], droppedLines: 0, outcome: null, error: null, ...fields };
}
const clock = { elapsed: (job) => job.endedAt - job.startedAt };

test('page는 refresh를 주면 meta refresh를 넣고, 주지 않으면 넣지 않는다 (#253)', () => {
  assert.match(page({ title: 't', refresh: { seconds: 1 } }), /<meta http-equiv="refresh" content="1">/);
  assert.match(page({ title: 't', refresh: { seconds: 0, url: '/job/result?id=a&b' } }), /<meta http-equiv="refresh" content="0; url=\/job\/result\?id=a&amp;b">/);
  assert.doesNotMatch(page({ title: 't' }), /http-equiv/);
});

test('작업 시작 → 상태 페이지(진행·경과·새로 고침) → 동시 실행 거부 → 끝나면 결과 페이지 (#253)', async (t) => {
  const dir = tempDir();
  const flag = path.join(dir, 'go');
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const { get } = await serve(t, jobs, () => ['wait', flag]);

  const started = await get('/start', { method: 'POST' });
  assert.strictEqual(started.status, 303);
  const location = started.headers.get('location');
  assert.match(location, /^\/job\?id=[0-9a-f]{24}$/);
  const job = jobs.running();
  assert.ok(job);

  const status = await get(location);
  assert.strictEqual(status.status, 200);
  const statusHtml = await status.text();
  assert.match(statusHtml, /<meta http-equiv="refresh" content="1">/);
  assert.match(statusHtml, /실행 중입니다\. 경과 시간 \d+초/);
  assert.ok(statusHtml.includes(`fctl wait ${flag.replace(/\\/g, '\\')}`));

  // 실행 중에는 결과 페이지를 열어도 상태 페이지로 돌아가고, 새 실행은 409로 거부한다.
  const early = await get(`/job/result?id=${job.id}`);
  assert.strictEqual(early.status, 303);
  assert.strictEqual(early.headers.get('location'), location);
  const busy = await get('/start', { method: 'POST' });
  assert.strictEqual(busy.status, 409);
  const busyHtml = await busy.text();
  assert.match(busyHtml, /이미 실행 중인 작업이 있습니다/);
  assert.ok(busyHtml.includes(`href="/job?id=${job.id}"`));
  assert.match(String(runButton(jobs)), /<button type="submit" disabled>실행<\/button>/);

  fs.writeFileSync(flag, '');
  await settled(jobs, job);
  assert.match(String(runButton(jobs, '미리보기')), /^<button type="submit">미리보기<\/button>$/);

  const done = await get(location);
  assert.strictEqual(done.status, 303);
  assert.strictEqual(done.headers.get('location'), `/job/result?id=${job.id}`);
  const result = await get(done.headers.get('location'));
  assert.strictEqual(result.status, 200);
  const resultHtml = await result.text();
  assert.match(resultHtml, /alert-success[^>]*>끝났습니다\./);
  assert.match(resultHtml, /<pre class="report">기다림 끝<\/pre>/);
  assert.doesNotMatch(resultHtml, /http-equiv/);
});

test('결과 페이지는 진행 줄을 접어 보이고, 없는 작업은 404로 답한다 (#253)', async (t) => {
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const { get } = await serve(t, jobs, () => ['progress', '3']);
  const started = await get('/start', { method: 'POST' });
  const job = jobs.get(new URL(started.headers.get('location'), 'http://x').searchParams.get('id'));
  await settled(jobs, job);
  const resultHtml = await (await get(`/job/result?id=${job.id}`)).text();
  assert.match(resultHtml, /<details><summary>진행 줄 3개<\/summary>/);
  assert.match(resultHtml, /줄 1\n줄 2\n줄 3/);

  for (const p of ['/job?id=nope', '/job/result', '/job?id=']) {
    const missing = await get(p);
    assert.strictEqual(missing.status, 404, p);
    assert.match(await missing.text(), /작업을 찾을 수 없습니다/);
  }
});

test('결과 페이지: 일부 실패는 경고, 실행 오류는 오류로 보이고, 명령별 화면과 이스케이프를 지킨다 (#253)', () => {
  const partial = resultPage(clock, finished({ outcome: { command: 'flatten', report: '실패: <x>', failure: { name: 'FcError', message: '실패: <x>' } } }));
  assert.match(partial, /alert-warning[^>]*>일부 항목을 처리하지 못했습니다/);
  assert.match(partial, /<pre class="report">실패: &lt;x&gt;<\/pre>/);
  assert.match(partial, /fctl flatten D:\\a&lt;b&gt;/);
  assert.match(partial, /걸린 시간 1분 5초/);

  const mismatch = resultPage(clock, finished({ outcome: { command: 'remove-broken', report: '보고', failure: { name: 'FcError', message: '목록이 확인값을 만든 때와 달라', output: '보고' } } }));
  assert.match(mismatch, /alert-warning[^>]*>목록이 확인값을 만든 때와 달라/);

  const crashed = resultPage(clock, finished({ status: 'error', error: { name: 'FcError', message: '사용법: <x>', stderr: '자세히' } }));
  assert.match(crashed, /<title>작업 실패 - fctl<\/title>/);
  assert.match(crashed, /alert-error[^>]*>실행하지 못했습니다: 사용법: &lt;x&gt;\n자세히/);

  const viewed = resultPage(clock, finished({ outcome: { command: 'find-broken', result: { n: 2 }, report: '글' } }), {
    views: { 'find-broken': (outcome) => html`<p class="view">${outcome.result.n}개</p>` },
  });
  assert.match(viewed, /<p class="view">2개<\/p>/);
  assert.doesNotMatch(viewed, /<pre class="report">글/);
});

test('상태 페이지는 최근 진행 줄만 보이고 생략한 줄 수를 알린다 (#253)', () => {
  const lines = Array.from({ length: 250 }, (_, i) => `줄 ${i + 1}`);
  const job = finished({ status: 'running', endedAt: null, lines, droppedLines: 10 });
  const body = statusPage({ elapsed: () => 3_000 }, job);
  assert.match(body, /앞의 진행 줄 60개는 생략했습니다/);
  assert.match(body, /경과 시간 3초/);
  assert.doesNotMatch(body, /줄 50\n/);
  assert.match(body, /줄 51\n/);
});

test('결과 페이지는 버린 중간 진행 줄 자리에 생략 표시를 넣는다 (#253 1차 리뷰)', () => {
  // jobs.js는 처음 100줄을 남기고 그 뒤의 오래된 줄부터 버린다.
  const lines = [...Array.from({ length: 100 }, (_, i) => `줄 ${i + 1}`), '줄 201', '줄 202'];
  const body = resultPage(clock, finished({ lines, droppedLines: 100, outcome: { command: 'flatten', report: '끝' } }));
  assert.match(body, /<summary>진행 줄 202개<\/summary>/);
  assert.match(body, /줄 100<\/pre>\n<p class="muted">중간의 진행 줄 100개는 생략했습니다\.<\/p>\n<pre class="report">줄 201\n줄 202<\/pre>/);
  assert.doesNotMatch(body, /앞의 진행 줄/);
});
