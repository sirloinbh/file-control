'use strict';

// The "Find and delete" screens (#259): /cleanup, with find-broken, find-duplicates, find-low-quality and remove-broken, remove-duplicates, remove-low-quality.
// - find-* change nothing. Their form (GET) posts to <path>/start, which starts a plain job; the result page shows the table (cleanupViews.js). There is no Run button.
// - remove-* are command specs for the shared preview -> run flow (flowPages.js). The preview lists what would be deleted. The Run button starts the job,
//   and the job process (checkedRun.js) adds --yes=<code> from a fresh preview, so the screen never asks the user to type a confirmation code.
//   If the folder changed after the preview, nothing is deleted and a new preview is shown. Deleted files go to the Recycle Bin, and the removal log location is shown in the result.

const path = require('node:path');
const { FcError } = require('../../commands');
const { refuseProtected, trailingDotOrSpacePart } = require('../protectedPath');
const { html } = require('../html');
const { page, table } = require('../layout');
const { pathInput } = require('../pickPage');
const { runButton, startJobResponse } = require('../jobPages');
const { fieldValues } = require('../flowPages');
const { CLEANUP_VIEWS } = require('./cleanupViews');

const AREA = '/cleanup';

const TARGET = { name: 'target', label: 'Target folder', kind: 'path' };
const MIN_HEIGHT = { name: 'minHeight', label: 'Low quality below this short side, in pixels (blank: 360)', kind: 'text' };
const MIN_BITRATE = { name: 'minBitrate', label: 'Low quality below this bitrate, in kbps (blank: not checked)', kind: 'text' };

const COMMANDS = [
  { command: 'find-broken', title: 'Find broken files', detail: 'Lists broken and suspect files. Changes nothing.', fields: [TARGET], find: true },
  { command: 'find-duplicates', title: 'Find duplicate videos', detail: 'Groups videos with the same name, product number or length. Changes nothing.', fields: [TARGET], find: true },
  { command: 'find-low-quality', title: 'Find low-quality videos', detail: 'Lists videos below the resolution or bitrate limit. Changes nothing.', fields: [TARGET, MIN_HEIGHT, MIN_BITRATE], find: true },
  { command: 'remove-broken', title: 'Delete broken files', detail: 'Shows the files to delete first, then sends them to the Recycle Bin and writes a removal log.', fields: [TARGET] },
  { command: 'remove-duplicates', title: 'Delete duplicate videos', detail: 'Shows what is kept and what is deleted first, then sends the extra copies to the Recycle Bin and writes a removal log.', fields: [TARGET] },
  { command: 'remove-low-quality', title: 'Delete low-quality videos', detail: 'Shows the files to delete first, then sends them to the Recycle Bin and writes a removal log.', fields: [TARGET, MIN_HEIGHT, MIN_BITRATE] },
];

// A whole number from the form, or nothing when blank. A bad value is refused here with the reason, before any job starts.
function limitOption(values, field, option) {
  const text = values[field.name].trim();
  if (text === '') return [];
  if (!/^\d{1,9}$/.test(text)) throw new FcError(`Enter a whole number for "${field.label}".`);
  return [`--${option}=${text}`];
}

// The target folder (#329): a full local path that is not in a protected place, with no dash at the start (it would be read as an option).
// The server's own current folder means nothing in a browser, so a relative path such as . is refused, as on the file screens.
function checkedTarget(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new FcError('Enter a target folder.');
  if (/[\0\r\n]/.test(text)) throw new FcError(`The target folder cannot contain a line break: ${JSON.stringify(text)}`);
  if (/^[-–—]/.test(text)) throw new FcError(`The target folder cannot start with a dash: ${text}`);
  if (!path.isAbsolute(text)) throw new FcError(`The target folder must be a full path such as C:\\Users\\you\\Downloads: ${text}`);
  if (process.platform === 'win32' && /^[\\/]{2}/.test(text) && !/^\\\\\?\\[A-Za-z]:/.test(text)) throw new FcError(`Network and device paths are not used: ${text}`);
  const full = path.resolve(text);
  const bad = trailingDotOrSpacePart(full);
  if (bad !== undefined) throw new FcError(`The target folder has a name that ends with a dot or space (${bad}): ${full}`);
  return refuseProtected(full, 'The target folder');
}

function toArgv(command, fields) {
  return (values) => {
    const target = checkedTarget(values.target);
    const argv = [command];
    if (fields.includes(MIN_HEIGHT)) argv.push(...limitOption(values, MIN_HEIGHT, 'min-height'), ...limitOption(values, MIN_BITRATE, 'min-bitrate'));
    // A literal -- keeps the target from ever being read as an option.
    argv.push('--', target);
    return argv;
  };
}

const specs = COMMANDS.filter((entry) => !entry.find).map((entry) => ({
  command: entry.command,
  path: `${AREA}/${entry.command}`,
  title: entry.title,
  fields: entry.fields,
  toArgv: toArgv(entry.command, entry.fields),
  doneLabel: 'Sent to Recycle Bin',
  runLabel: 'Send to the Recycle Bin',
}));

const views = { ...CLEANUP_VIEWS };

function fieldRow(entry, field, value) {
  if (field.kind === 'path') return pathInput({ name: field.name, label: field.label, value, returnTo: `${AREA}/${entry.command}` });
  return html`<p><label>${field.label}<br><input type="text" name="${field.name}" value="${value}" size="12" spellcheck="false" inputmode="numeric"></label></p>`;
}

function findForm(jobs, entry, req, { available, tokenField }) {
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  const values = fieldValues(entry, params);
  return {
    body: page({
      title: entry.title,
      available,
      current: AREA,
      body: html`<p>${entry.detail}</p>
<form method="post" action="${AREA}/${entry.command}/start">
${tokenField}${entry.fields.map((field) => fieldRow(entry, field, values[field.name]))}
${runButton(jobs, 'Find')}
</form>`,
    }),
  };
}

function findStart(jobs, entry) {
  const build = toArgv(entry.command, entry.fields);
  return (req, { available, form }) => {
    let argv;
    try {
      argv = build(fieldValues(entry, form));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      return { status: 400, body: page({ title: entry.title, available, alerts: [{ kind: 'error', message: err.message }], body: html`<p><a href="${AREA}/${entry.command}">Back to the form</a></p>` }) };
    }
    return startJobResponse(jobs, argv, { available });
  };
}

function landing(available) {
  const rows = COMMANDS.map((entry) => [html`<a href="${AREA}/${entry.command}"><code>${entry.command}</code></a>`, entry.title, entry.detail]);
  return {
    body: page({
      title: 'Find and delete',
      available,
      current: AREA,
      body: html`<p>The find screens only list files. The delete screens show a preview first, and deleted files go to the Recycle Bin with a removal log.</p>
${table([{ label: 'Command', width: '25%' }, { label: 'Screen', width: '25%' }, { label: 'What it does' }], rows)}`,
    }),
  };
}

// The routes of this area. The remove-* form, preview and run routes come from flowRoutes(specs) in server.js, so only the landing page and the find-* screens are here.
function routes(jobs) {
  const map = new Map([[AREA, (req, { available }) => landing(available)]]);
  for (const entry of COMMANDS.filter((item) => item.find)) {
    map.set(`${AREA}/${entry.command}`, (req, context) => findForm(jobs, entry, req, context));
    map.set(`${AREA}/${entry.command}/start`, { POST: findStart(jobs, entry) });
  }
  return map;
}

module.exports = { specs, views, routes };
