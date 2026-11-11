'use strict';

// 작업 상태 페이지와 결과 페이지(#253). 명령은 jobs.js가 자식 프로세스로 실행하고, 화면은 여기서 만든다.
// 클라이언트 JS를 쓰지 않으므로 진행 표시는 <meta http-equiv=refresh>로 같은 주소를 다시 연다.
// 작업이 끝난 뒤 상태 페이지를 열면 결과 페이지로 넘긴다(303).

const { html } = require('./html');
const { page, alertBox } = require('./layout');
const { BusyError, formatElapsed, KEPT_HEAD_LINES: KEPT_HEAD } = require('./jobs');

const STATUS_PATH = '/job';
const RESULT_PATH = '/job/result';
// 상태 페이지를 다시 여는 간격(초).
const REFRESH_SECONDS = 1;
// 상태 페이지에 보일 최근 진행 줄 수. 결과 페이지는 모은 줄을 모두 보인다.
const RECENT_LINES = 200;

const statusUrl = (job) => `${STATUS_PATH}?id=${encodeURIComponent(job.id)}`;
const resultUrl = (job) => `${RESULT_PATH}?id=${encodeURIComponent(job.id)}`;

function commandLine(job) {
  return html`<p>Command: <code>fctl ${job.argv.join(' ')}</code></p>`;
}

// 상태 페이지: 최근 줄만 보이므로 앞에서 생략한 줄 수를 알린다.
function linesBlock(lines, skipped) {
  if (lines.length === 0) return html`<p class="muted">No progress lines yet.</p>`;
  return html`${skipped > 0 ? html`<p class="muted">Skipped the first ${skipped} progress lines.</p>` : ''}<pre class="report">${lines.join('\n')}</pre>`;
}

// 결과 페이지: jobs.js는 줄이 많으면 처음 KEPT_HEAD_LINES줄 뒤의 중간 줄을 버린다. 그 자리에 생략 표시를 넣는다.
function allLinesBlock(lines, dropped) {
  if (dropped === 0) return html`<pre class="report">${lines.join('\n')}</pre>`;
  return html`<pre class="report">${lines.slice(0, KEPT_HEAD).join('\n')}</pre>
<p class="muted">Skipped ${dropped} progress lines in the middle.</p>
<pre class="report">${lines.slice(KEPT_HEAD).join('\n')}</pre>`;
}

function jobFromRequest(jobs, req) {
  let id = null;
  try {
    id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id');
  } catch {
    id = null;
  }
  return id ? jobs.get(id) : undefined;
}

function notFound(available) {
  return {
    status: 404,
    body: page({
      title: 'No job',
      available,
      alerts: [{ kind: 'error', message: 'Job not found. Old jobs do not keep their results.' }],
      body: html`<p><a href="/">Back to the start page</a></p>`,
    }),
  };
}

// 실행 중인 작업의 상태 페이지. 진행 줄과 경과 시간을 보이고 REFRESH_SECONDS마다 다시 연다.
function statusPage(jobs, job, { available } = {}) {
  const recent = job.lines.slice(-RECENT_LINES);
  const skipped = job.droppedLines + job.lines.length - recent.length;
  return page({
    title: 'Job running',
    available,
    refresh: { seconds: REFRESH_SECONDS },
    alerts: [{ kind: 'info', message: `Running. Elapsed time ${formatElapsed(jobs.elapsed(job))}. This page refreshes every ${REFRESH_SECONDS} seconds.` }],
    body: html`${commandLine(job)}
<h2>Progress</h2>
${linesBlock(recent, skipped)}`,
  });
}

// 실패 알림 문구. 일부 실패(failure)는 보고 전체가 메시지일 때가 있어, 그때는 보고와 겹치지 않게 짧게 쓴다.
function outcomeAlert(job) {
  if (job.status === 'error') {
    const detail = job.error && job.error.stderr ? `\n${String(job.error.stderr).trim()}` : '';
    return { kind: 'error', message: `Could not run: ${job.error ? job.error.message : 'unknown error'}${detail}` };
  }
  const { failure, report } = job.outcome;
  if (failure) {
    const message = failure.message === report ? 'Some items could not be processed. Check the report below.' : failure.message;
    return { kind: 'warning', message };
  }
  return { kind: 'success', message: 'Done.' };
}

// 끝난 작업의 결과 페이지. views[command](outcome, job)가 있으면 그 화면(표 등)을, 없으면 CLI와 같은 보고 글을 보인다.
function resultPage(jobs, job, { available, views = {} } = {}) {
  const alert = outcomeAlert(job);
  let content = '';
  if (job.status === 'done') {
    const { outcome } = job;
    const view = outcome.command ? views[outcome.command] : undefined;
    if (view) content = view(outcome, job);
    else if (outcome.help) content = html`<p class="muted">See the help in a terminal with fctl --help.</p>`;
    else if (outcome.report) content = html`<pre class="report">${outcome.report}</pre>`;
    else content = html`<p class="muted">Nothing to report.</p>`;
  }
  const lines = job.lines.length > 0 || job.droppedLines > 0
    ? html`<details><summary>${job.lines.length + job.droppedLines} progress lines</summary>${allLinesBlock(job.lines, job.droppedLines)}</details>`
    : '';
  return page({
    title: job.status === 'error' ? 'Job failed' : 'Job result',
    available,
    alerts: [alert],
    body: html`${commandLine(job)}
<p class="muted">Elapsed ${formatElapsed(jobs.elapsed(job))}</p>
${content}
${lines}`,
  });
}

// 작업 페이지 주소들. views는 명령별 결과 화면(#256~#259)이다.
function jobRoutes(jobs, { views = {} } = {}) {
  return new Map([
    [STATUS_PATH, (req, { available }) => {
      const job = jobFromRequest(jobs, req);
      if (!job) return notFound(available);
      // 끝났으면 결과 페이지로 넘긴다. 다시 열어도 같은 결과를 본다.
      if (job.status !== 'running') return { status: 303, headers: { Location: resultUrl(job) }, body: '' };
      return { body: statusPage(jobs, job, { available }) };
    }],
    [RESULT_PATH, (req, { available }) => {
      const job = jobFromRequest(jobs, req);
      if (!job) return notFound(available);
      // 아직 실행 중이면 상태 페이지로 돌려보낸다.
      if (job.status === 'running') return { status: 303, headers: { Location: statusUrl(job) }, body: '' };
      return { body: resultPage(jobs, job, { available, views }) };
    }],
  ]);
}

// 실행 요청(POST 처리기, #255~)이 부르는 응답. 작업을 시작하고 상태 페이지로 넘긴다.
// 이미 실행 중인 작업이 있으면 시작하지 않고 409와 함께 그 작업으로 가는 링크를 보인다.
function startJobResponse(jobs, argv, { available } = {}) {
  try {
    const job = jobs.start(argv);
    return { status: 303, headers: { Location: statusUrl(job) }, body: '' };
  } catch (err) {
    if (!(err instanceof BusyError)) throw err;
    return {
      status: 409,
      body: page({
        title: 'A job is running',
        available,
        alerts: [{ kind: 'error', message: `${err.message} Run it again after it finishes.` }],
        body: html`<p><a href="${statusUrl(err.job)}">View the running job</a></p>`,
      }),
    };
  }
}

// 폼의 실행 버튼. 실행 중인 작업이 있으면 버튼을 막고 그 작업으로 가는 링크를 보인다.
function runButton(jobs, label = 'Run') {
  const active = jobs.running();
  if (!active) return html`<button type="submit">${label}</button>`;
  return html`<button type="submit" disabled>${label}</button>
${alertBox('info', 'Another job is running, so this cannot run until it finishes.')}<p><a href="${statusUrl(active)}">View the running job</a></p>`;
}

module.exports = { jobRoutes, startJobResponse, runButton, statusPage, resultPage, STATUS_PATH, RESULT_PATH };
