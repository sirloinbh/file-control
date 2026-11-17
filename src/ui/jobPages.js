'use strict';

// The job status page and the result page (#253). jobs.js runs the command in a child process, and the screen is built here.
// No client JS is used, so the progress display reopens the same address with <meta http-equiv=refresh>.
// If the status page is opened after the job ended, it redirects to the result page (303).

const { html } = require('./html');
const { page, alertBox } = require('./layout');
const { BusyError, formatElapsed, KEPT_HEAD_LINES: KEPT_HEAD } = require('./jobs');

const STATUS_PATH = '/job';
const RESULT_PATH = '/job/result';
// The interval (in seconds) at which the status page reopens.
const REFRESH_SECONDS = 1;
// The number of recent progress lines shown on the status page. The result page shows all the collected lines.
const RECENT_LINES = 200;

const statusUrl = (job) => `${STATUS_PATH}?id=${encodeURIComponent(job.id)}`;
const resultUrl = (job) => `${RESULT_PATH}?id=${encodeURIComponent(job.id)}`;

function commandLine(job) {
  return html`<p>Command: <code>fctl ${job.argv.join(' ')}</code></p>`;
}

// Status page: only the recent lines are shown, so it reports the number of lines omitted at the front.
function linesBlock(lines, skipped) {
  if (lines.length === 0) return html`<p class="muted">No progress lines yet.</p>`;
  return html`${skipped > 0 ? html`<p class="muted">Skipped the first ${skipped} progress lines.</p>` : ''}<pre class="report">${lines.join('\n')}</pre>`;
}

// Result page: if there are many lines, jobs.js drops the middle lines after the first KEPT_HEAD_LINES lines. It puts an omission mark in that place.
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

// The status page of a running job. It shows the progress lines and the elapsed time and reopens every REFRESH_SECONDS.
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

// The failure notice text. For a partial failure (failure), the whole report is sometimes the message, so then it is written short so as not to overlap the report.
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

// The result page of a finished job. If views[command](outcome, job) exists, it shows that screen (a table and so on); otherwise it shows the same report text as the CLI.
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

// The job page addresses. views are the per-command result screens (#256 to #259).
function jobRoutes(jobs, { views = {} } = {}) {
  return new Map([
    [STATUS_PATH, (req, { available }) => {
      const job = jobFromRequest(jobs, req);
      if (!job) return notFound(available);
      // If finished, it redirects to the result page. Opening it again shows the same result.
      if (job.status !== 'running') return { status: 303, headers: { Location: resultUrl(job) }, body: '' };
      return { body: statusPage(jobs, job, { available }) };
    }],
    [RESULT_PATH, (req, { available }) => {
      const job = jobFromRequest(jobs, req);
      if (!job) return notFound(available);
      // If it is still running, it sends back to the status page.
      if (job.status === 'running') return { status: 303, headers: { Location: statusUrl(job) }, body: '' };
      return { body: resultPage(jobs, job, { available, views }) };
    }],
  ]);
}

// The response that run requests (POST handlers, #255 onward) call. It starts the job and redirects to the status page.
// If a job is already running, it does not start and shows 409 with a link to that job.
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

// The run button of a form. If a job is running, it disables the button and shows a link to that job.
function runButton(jobs, label = 'Run') {
  const active = jobs.running();
  if (!active) return html`<button type="submit">${label}</button>`;
  return html`<button type="submit" disabled>${label}</button>
${alertBox('info', 'Another job is running, so this cannot run until it finishes.')}<p><a href="${statusUrl(active)}">View the running job</a></p>`;
}

module.exports = { jobRoutes, startJobResponse, runButton, statusPage, resultPage, STATUS_PATH, RESULT_PATH };
