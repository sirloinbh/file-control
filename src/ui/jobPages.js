'use strict';

// The job status page and the result page (#253). jobs.js runs the command in a child process, and the screen is built here.
// No client JS is used, so the progress display reopens the same address with <meta http-equiv=refresh>.
// If the status page is opened after the job ended, it redirects to the result page (303).

const { html } = require('./html');
const { page, alertBox, table } = require('./layout');
const { formatSize } = require('../commands');
const { BusyError, formatElapsed, KEPT_HEAD_LINES: KEPT_HEAD } = require('./jobs');
const { dangerConfirmations, dangerOptionsOf, resultSection, isOn } = require('./flow');

const STATUS_PATH = '/job';
const RESULT_PATH = '/job/result';
// The interval (in seconds) at which the status page reopens.
const REFRESH_SECONDS = 1;
// The number of recent progress lines shown on the status page. The result page shows all the collected lines.
const RECENT_LINES = 200;
const STOP_PATH = '/job/stop';
// With no progress line for this long, the status page warns that the job may be stuck (it never stops the job by itself).
const STALL_MS = 60_000;

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
function statusPage(jobs, job, { available, tokenField = '' } = {}) {
  const recent = job.lines.slice(-RECENT_LINES);
  const skipped = job.droppedLines + job.lines.length - recent.length;
  const idle = typeof jobs.idle === 'function' ? jobs.idle(job) : 0;
  return page({
    title: 'Job running',
    available,
    refresh: { seconds: REFRESH_SECONDS },
    alerts: [
      { kind: 'info', message: `Running. Elapsed time ${formatElapsed(jobs.elapsed(job))}. This page refreshes every ${REFRESH_SECONDS} seconds.` },
      ...(job.stopRequested ? [{ kind: 'warning', message: 'Still stopping. The job process has not ended yet. This page keeps refreshing.' }] : []),
      ...(idle >= STALL_MS ? [{ kind: 'warning', message: `No progress for ${formatElapsed(idle)}. The job may be stuck. You can stop it below.` }] : []),
    ],
    body: html`${commandLine(job)}
<form method="post" action="${STOP_PATH}">
${tokenField}<input type="hidden" name="id" value="${job.id}">
<button type="submit">Stop job</button>
<span class="muted">Work already done, such as moved files, is not undone.</span>
</form>
<h2>Progress</h2>
${linesBlock(recent, skipped)}`,
  });
}

// The form values each job was started from (#255). The run form of a preview result carries them as hidden fields.
// It is kept beside the job (not on it), so jobs.js does not need to know about forms.
const jobForms = new WeakMap();

// The hidden fields and the Run form of a preview result. Only the fields named by the spec are carried, so no other value can ride along.
function runForm(spec, job, outcome, { tokenField, jobs }) {
  const form = jobForms.get(job) ?? {};
  const hidden = spec.fields
    .filter((field) => (field.kind === 'checkbox' ? isOn(form[field.name]) : form[field.name] !== undefined))
    .map((field) => html`<input type="hidden" name="${field.name}" value="${field.kind === 'checkbox' ? 'on' : form[field.name]}">`);
  // The confirmation boxes follow the argv the preview ran, the same as the run request's check (flowPages.js).
  const options = dangerOptionsOf(job.argv);
  return html`<h2>Run</h2>
<form method="post" action="${spec.path}/run">
${tokenField}${hidden}<input type="hidden" name="fingerprint" value="${outcome.fingerprint}">
${dangerConfirmations(options)}
${runButton(jobs, spec.runLabel ?? 'Run')}
</form>`;
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

// What the sources of a mv, cp or rm preview hold (#280): the run happens only if this still matches, so the person sees what is confirmed.
function sourcesTable(outcome) {
  if (!Array.isArray(outcome.sources) || outcome.sources.length === 0) return '';
  const rows = outcome.sources.map((source) => {
    const isLink = source.type === 'link';
    // cp, and mv to another drive, copy what a link leads to (sourceSnapshot.js marks those snapshots followed).
    const follows = source.followed === true;
    // A link's contents are counted only when the command reads through it (cp).
    const counted = source.type === 'dir' || (isLink && follows);
    const note = !isLink ? '' : html`<br><span class="muted">Link to ${source.target ?? ''}. ${follows ? 'The contents it leads to are included.' : 'The contents it leads to are not touched.'}</span>`;
    return [
      html`${source.path}${note}`,
      source.type === 'dir' ? 'Folder' : source.type === 'missing' ? 'Missing' : isLink ? 'Link' : 'File',
      counted ? `${source.count} item${source.count === 1 ? '' : 's'}` : '',
      source.type === 'missing' || (isLink && !follows) ? '' : formatSize(source.size),
    ];
  });
  return html`<h2>What will be touched</h2>${table([{ label: 'Source' }, { label: 'Type', width: '14%' }, { label: 'Items inside', width: '18%' }, { label: 'Total size', width: '16%' }], rows)}`;
}

// What mv --force replaces and cp --force overwrites at the destination (#284), and what rename --force and zip --force overwrite (#297).
// The run happens only if this still matches too.
// Links there are not followed (mv, rename and zip replace the link itself, cp refuses one), so a link shows no count or size.
const OVERWRITE_HOW = {
  mv: 'Each item below is replaced as a whole by the item moved there.',
  cp: 'Files below are overwritten by files of the same name; a folder is merged, so its other files stay.',
  rename: 'The item below is replaced by the renamed item.',
  zip: 'The file below is replaced by the new archive.',
};
function destinationsTable(outcome) {
  if (!Array.isArray(outcome.destinations)) return '';
  const present = outcome.destinations.filter((item) => item.type !== 'missing');
  const heading = html`<h2>Will be overwritten</h2>`;
  if (present.length === 0) return html`${heading}<p class="muted">Nothing exists at the destination yet, so nothing is overwritten.</p>`;
  // Every command with a destination snapshot has its own sentence (a test checks it); this neutral one is only a safety net.
  const how = OVERWRITE_HOW[outcome.command] ?? 'The items below are overwritten.';
  const size = present.reduce((sum, item) => sum + (item.type === 'link' ? 0 : item.size), 0);
  const rows = present.map((item) => {
    const isLink = item.type === 'link';
    const note = isLink ? html`<br><span class="muted">Link to ${item.target ?? ''}. Only the link is replaced; the contents it leads to are not touched.</span>` : '';
    return [
      html`${item.path}${note}`,
      item.type === 'dir' ? 'Folder' : isLink ? 'Link' : 'File',
      item.type === 'dir' ? `${item.count} item${item.count === 1 ? '' : 's'}` : '',
      isLink ? '' : formatSize(item.size),
    ];
  });
  return html`${heading}<p>${how} ${present.length} existing item${present.length === 1 ? '' : 's'} at the destination, ${formatSize(size)} in all. Overwritten files cannot be restored.</p>
${table([{ label: 'Destination' }, { label: 'Type', width: '14%' }, { label: 'Items inside', width: '18%' }, { label: 'Total size', width: '16%' }], rows)}`;
}

// The result page of a finished job. If views[command](outcome, job) exists, it shows that screen (a table and so on); otherwise it shows the same report text as the CLI.
function resultPage(jobs, job, { available, views = {}, specs = [], tokenField = '' } = {}) {
  const alert = job.status === 'stopped'
    ? { kind: 'warning', message: 'Stopped. The job was stopped before it finished. Work already done (such as moved files) is not undone. Check the folder before running again.' }
    : outcomeAlert(job);
  let content = '';
  let before = '';
  let after = '';
  const spec = job.status === 'done' ? specs.find((candidate) => candidate.command === (job.outcome.command || job.argv[0])) : undefined;
  if (job.status === 'done') {
    const { outcome } = job;
    if (spec && outcome.repreview) before = alertBox('warning', 'The folder changed after the preview, so nothing was changed. Check the new preview below, then run again.');
    if (spec && (job.mode === 'preview' || outcome.repreview) && typeof outcome.fingerprint === 'string') after = runForm(spec, job, outcome, { tokenField, jobs });
    const view = outcome.command ? views[outcome.command] : undefined;
    if (view) {
      // A bug in a result view must not hide the preview and its Run form (built above): fall back to the plain report and say why (#318).
      try {
        content = view(outcome, job);
      } catch (err) {
        console.error(`UI error: the result view of ${outcome.command} failed: ${err && err.stack ? err.stack : err}`);
        content = html`${alertBox('warning', `Could not build the result view: ${err && err.message}`)}${outcome.report ? html`<pre class="report">${outcome.report}</pre>` : ''}`;
      }
    } else if (outcome.help) content = html`<p class="muted">See the help in a terminal with fctl --help.</p>`;
    else if (outcome.report) content = html`<pre class="report">${outcome.report}</pre>`;
    else content = html`<p class="muted">Nothing to report.</p>`;
    if (spec && job.mode === 'run' && !outcome.repreview && typeof spec.toItems === 'function') {
      // The run already happened, so a broken result table falls back to the report instead of failing the page.
      try {
        content = resultSection(spec.toItems(outcome), { doneLabel: spec.doneLabel });
      } catch (err) {
        content = html`${alertBox('warning', `Could not build the result table: ${err.message}`)}${content}`;
      }
    }
  }
  const lines = job.lines.length > 0 || job.droppedLines > 0
    ? html`<details><summary>${job.lines.length + job.droppedLines} progress lines</summary>${allLinesBlock(job.lines, job.droppedLines)}</details>`
    : '';
  return page({
    title: job.status === 'error' ? 'Job failed' : job.status === 'stopped' ? 'Job stopped' : 'Job result',
    available,
    alerts: [alert],
    body: html`${commandLine(job)}
<p class="muted">Elapsed ${formatElapsed(jobs.elapsed(job))}</p>
${before}${content}
${after ? html`${sourcesTable(job.outcome)}${destinationsTable(job.outcome)}` : ''}${after}
${lines}`,
  });
}

// The job page addresses. views are the per-command result screens (#256 to #259).
function jobRoutes(jobs, { views = {}, specs = [] } = {}) {
  return new Map([
    [STATUS_PATH, (req, { available, tokenField }) => {
      const job = jobFromRequest(jobs, req);
      if (!job) return notFound(available);
      // If finished, it redirects to the result page. Opening it again shows the same result.
      if (job.status !== 'running') return { status: 303, headers: { Location: resultUrl(job) }, body: '' };
      return { body: statusPage(jobs, job, { available, tokenField }) };
    }],
    [STOP_PATH, {
      POST: async (req, { available, form }) => {
        const job = form && form.get('id') ? jobs.get(form.get('id')) : undefined;
        if (!job) return notFound(available);
        // A finished job is not touched: it just goes to its result.
        await jobs.stop(job);
        return { status: 303, headers: { Location: resultUrl(job) }, body: '' };
      },
    }],
    [RESULT_PATH, (req, { available, tokenField }) => {
      const job = jobFromRequest(jobs, req);
      if (!job) return notFound(available);
      // If it is still running, it sends back to the status page.
      if (job.status === 'running') return { status: 303, headers: { Location: statusUrl(job) }, body: '' };
      return { body: resultPage(jobs, job, { available, views, specs, tokenField }) };
    }],
  ]);
}

// The response that run requests (POST handlers, #255 onward) call. It starts the job and redirects to the status page.
// If a job is already running, it does not start and shows 409 with a link to that job.
// start is passed to jobs.start as its second argument ({ mode, expect }), and form is remembered for the result page's run form.
function startJobResponse(jobs, argv, { available, start, form } = {}) {
  try {
    const job = start ? jobs.start(argv, start) : jobs.start(argv);
    if (form) jobForms.set(job, form);
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

module.exports = { OVERWRITE_HOW, jobRoutes, startJobResponse, runButton, statusPage, resultPage, STATUS_PATH, RESULT_PATH, STOP_PATH };
