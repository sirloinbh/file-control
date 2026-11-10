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
  return html`<p>명령: <code>fctl ${job.argv.join(' ')}</code></p>`;
}

// 상태 페이지: 최근 줄만 보이므로 앞에서 생략한 줄 수를 알린다.
function linesBlock(lines, skipped) {
  if (lines.length === 0) return html`<p class="muted">아직 진행 줄이 없습니다.</p>`;
  return html`${skipped > 0 ? html`<p class="muted">앞의 진행 줄 ${skipped}개는 생략했습니다.</p>` : ''}<pre class="report">${lines.join('\n')}</pre>`;
}

// 결과 페이지: jobs.js는 줄이 많으면 처음 KEPT_HEAD_LINES줄 뒤의 중간 줄을 버린다. 그 자리에 생략 표시를 넣는다.
function allLinesBlock(lines, dropped) {
  if (dropped === 0) return html`<pre class="report">${lines.join('\n')}</pre>`;
  return html`<pre class="report">${lines.slice(0, KEPT_HEAD).join('\n')}</pre>
<p class="muted">중간의 진행 줄 ${dropped}개는 생략했습니다.</p>
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
      title: '작업 없음',
      available,
      alerts: [{ kind: 'error', message: '작업을 찾을 수 없습니다. 오래된 작업은 결과를 남기지 않습니다.' }],
      body: html`<p><a href="/">처음 화면으로</a></p>`,
    }),
  };
}

// 실행 중인 작업의 상태 페이지. 진행 줄과 경과 시간을 보이고 REFRESH_SECONDS마다 다시 연다.
function statusPage(jobs, job, { available } = {}) {
  const recent = job.lines.slice(-RECENT_LINES);
  const skipped = job.droppedLines + job.lines.length - recent.length;
  return page({
    title: '작업 실행 중',
    available,
    refresh: { seconds: REFRESH_SECONDS },
    alerts: [{ kind: 'info', message: `실행 중입니다. 경과 시간 ${formatElapsed(jobs.elapsed(job))}. 이 화면은 ${REFRESH_SECONDS}초마다 새로 고칩니다.` }],
    body: html`${commandLine(job)}
<h2>진행</h2>
${linesBlock(recent, skipped)}`,
  });
}

// 실패 알림 문구. 일부 실패(failure)는 보고 전체가 메시지일 때가 있어, 그때는 보고와 겹치지 않게 짧게 쓴다.
function outcomeAlert(job) {
  if (job.status === 'error') {
    const detail = job.error && job.error.stderr ? `\n${String(job.error.stderr).trim()}` : '';
    return { kind: 'error', message: `실행하지 못했습니다: ${job.error ? job.error.message : '알 수 없는 오류'}${detail}` };
  }
  const { failure, report } = job.outcome;
  if (failure) {
    const message = failure.message === report ? '일부 항목을 처리하지 못했습니다. 아래 보고를 확인하세요.' : failure.message;
    return { kind: 'warning', message };
  }
  return { kind: 'success', message: '끝났습니다.' };
}

// 끝난 작업의 결과 페이지. views[command](outcome, job)가 있으면 그 화면(표 등)을, 없으면 CLI와 같은 보고 글을 보인다.
function resultPage(jobs, job, { available, views = {} } = {}) {
  const alert = outcomeAlert(job);
  let content = '';
  if (job.status === 'done') {
    const { outcome } = job;
    const view = outcome.command ? views[outcome.command] : undefined;
    if (view) content = view(outcome, job);
    else if (outcome.help) content = html`<p class="muted">도움말은 터미널에서 fctl --help로 보세요.</p>`;
    else if (outcome.report) content = html`<pre class="report">${outcome.report}</pre>`;
    else content = html`<p class="muted">보고할 내용이 없습니다.</p>`;
  }
  const lines = job.lines.length > 0 || job.droppedLines > 0
    ? html`<details><summary>진행 줄 ${job.lines.length + job.droppedLines}개</summary>${allLinesBlock(job.lines, job.droppedLines)}</details>`
    : '';
  return page({
    title: job.status === 'error' ? '작업 실패' : '작업 결과',
    available,
    alerts: [alert],
    body: html`${commandLine(job)}
<p class="muted">걸린 시간 ${formatElapsed(jobs.elapsed(job))}</p>
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
        title: '실행 중인 작업이 있음',
        available,
        alerts: [{ kind: 'error', message: `${err.message} 끝난 뒤에 다시 실행하세요.` }],
        body: html`<p><a href="${statusUrl(err.job)}">실행 중인 작업 보기</a></p>`,
      }),
    };
  }
}

// 폼의 실행 버튼. 실행 중인 작업이 있으면 버튼을 막고 그 작업으로 가는 링크를 보인다.
function runButton(jobs, label = '실행') {
  const active = jobs.running();
  if (!active) return html`<button type="submit">${label}</button>`;
  return html`<button type="submit" disabled>${label}</button>
${alertBox('info', '다른 작업이 실행 중이라 끝날 때까지 실행할 수 없습니다.')}<p><a href="${statusUrl(active)}">실행 중인 작업 보기</a></p>`;
}

module.exports = { jobRoutes, startJobResponse, runButton, statusPage, resultPage, STATUS_PATH, RESULT_PATH };
