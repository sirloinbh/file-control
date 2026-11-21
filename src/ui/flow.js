'use strict';

// Decision part of the shared preview -> run flow (#255). Only pure functions live here, independent of pages and command execution (#253).
// - A command that changes files is previewed with a dry run first, and the fingerprint of that preview is sent along with the run request.
// - Right before running, the preview is made again; if the fingerprint differs, nothing runs and the new preview is shown (the folder changed in between).
// - Overwrite (force) and permanent delete (permanent) are off by default; turning one on asks for one more confirmation on the preview page.

const crypto = require('node:crypto');
const { html } = require('./html');
const { summaryCards, table, badge } = require('./layout');

// Dangerous options and their confirmation boxes. A run request with one turned on must also carry the confirmation (confirm-<name>=yes).
const DANGEROUS_OPTIONS = {
  force: { label: 'Overwrite', warning: 'Existing files are overwritten. Overwritten files cannot be restored.' },
  permanent: { label: 'Permanent delete', warning: 'Files are deleted permanently without going to the Recycle Bin (for Move: the items it replaces are deleted for good). This cannot be undone.' },
};

// Converts values JSON cannot carry (Set, Map, Error, bigint, undefined) and sorts object keys so the text is always the same.
function canonical(value) {
  if (value instanceof Set) return [...value].map(canonical).sort(compareJson);
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (value instanceof Error) return { error: value.message };
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined && typeof value[key] !== 'function') out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

function compareJson(a, b) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// Fingerprint of a preview. It changes if the command, args, options, or preview result differ in any way.
// Values in the preview result that change every time regardless of the folder (timings and so on) go into volatile by key name and are left out.
function fingerprint({ command, args = [], options = {}, preview }, { volatile = [] } = {}) {
  const drop = new Set(volatile);
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !drop.has(key)).map(([key, v]) => [key, strip(v)]));
    return value;
  };
  const text = JSON.stringify(canonical({ command, args, options, preview: strip(canonical(preview)) }));
  return crypto.createHash('sha256').update(text).digest('hex');
}

// The checks that need no fresh preview: a run request must carry a valid fingerprint, and a dangerous option turned on must be confirmed.
// form is a plain object of the submitted values; values that are not strings (arrays and so on) never count as valid or as confirmed.
// Returns { action: 'ok' } | { action: 'reject', reason }.
function checkRunRequest(form) {
  const submitted = typeof form.fingerprint === 'string' ? form.fingerprint : '';
  if (!/^[0-9a-f]{64}$/.test(submitted)) return { action: 'reject', reason: 'This run request did not come from a preview, so nothing was run. Preview it first.' };
  for (const [name, { label }] of Object.entries(DANGEROUS_OPTIONS)) {
    if (isOn(form[name]) && form[`confirm-${name}`] !== 'yes') {
      return { action: 'reject', reason: `${label} was turned on but not confirmed again, so nothing was run. Tick the confirmation box on the preview page.` };
    }
  }
  return { action: 'ok' };
}

// Decides whether to accept a run request. form holds the values from the run form, fresh is the fingerprint of the preview made again right before running.
// Returns { action: 'execute' } | { action: 'reject', reason } | { action: 'repreview', reason }
// - reject: a request that did not come from a preview, or a dangerous option without its confirmation (see checkRunRequest). Nothing is done and the reason is shown.
// - repreview: the fingerprint differs, so nothing runs and the new preview is shown.
function decideExecution(form, fresh) {
  const checked = checkRunRequest(form);
  if (checked.action === 'reject') return checked;
  if (!crypto.timingSafeEqual(Buffer.from(form.fingerprint), Buffer.from(fresh))) {
    return { action: 'repreview', reason: 'The folder changed after the preview, so nothing was run. Check the new preview and run it again.' };
  }
  return { action: 'execute' };
}

function isOn(value) {
  return value === 'on' || value === 'yes' || value === 'true' || value === '1';
}

// Warning and confirmation box for each dangerous option that is on (placed inside the run form on the preview page).
function dangerConfirmations(options) {
  return Object.entries(DANGEROUS_OPTIONS)
    .filter(([name]) => isOn(options[name]))
    .map(([name, { label, warning }]) => html`<div class="alert alert-warning" role="alert"><strong>${label}</strong>: ${warning}
<label><input type="checkbox" name="confirm-${name}" value="yes" required> I understand the ${label.toLowerCase()} and want to run it</label></div>`);
}

// Run result item: { status: 'moved' | 'done' | 'skipped' | 'kept' | 'failed', path, detail?, reason? }
// Failed, skipped, and kept items go first; the rest keep their original order.
const STATUS_ORDER = { failed: 0, skipped: 1, kept: 1, warning: 1 };
function orderResults(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (STATUS_ORDER[a.item.status] ?? 2) - (STATUS_ORDER[b.item.status] ?? 2) || a.index - b.index)
    .map(({ item }) => item);
}

function countResults(items) {
  const count = (statuses) => items.filter((item) => statuses.includes(item.status)).length;
  return { done: count(['moved', 'done']), skipped: count(['skipped', 'kept']), failed: count(['failed']) };
}

// Summary cards (moved, skipped, failed counts) and a table with reasons. doneLabel is the name that fits the command (Moved, Copied, Sent to Recycle Bin, and so on).
function resultSection(items, { doneLabel = 'Moved' } = {}) {
  const counts = countResults(items);
  const cards = summaryCards([
    { label: doneLabel, value: counts.done, tone: 'ok' },
    { label: 'Skipped', value: counts.skipped, tone: counts.skipped ? 'warning' : undefined },
    { label: 'Failed', value: counts.failed, tone: counts.failed ? 'error' : undefined },
  ]);
  const rows = orderResults(items).map((item) => [badge(item.status, item.status === 'moved' || item.status === 'done' ? doneLabel : undefined), item.path, item.reason ?? item.detail ?? '']);
  return html`${cards}${table([{ label: 'Status', width: '7.5em' }, { label: 'Path', width: '55%' }, { label: 'Reason / details' }], rows)}`;
}

// The dangerous options the argv really turns on, as form-style values ({ force: 'on' | '', permanent: 'on' | '' }).
// The checks look at the argv a spec built, not at the form field names, so a spec cannot skip the confirmation by naming its field differently.
// Only arguments before a literal -- are options.
function dangerOptionsOf(argv) {
  const end = argv.indexOf('--');
  const options = end === -1 ? argv : argv.slice(0, end);
  return Object.fromEntries(Object.keys(DANGEROUS_OPTIONS).map((name) => [name, options.includes(`--${name}`) ? 'on' : '']));
}

module.exports = { dangerOptionsOf, DANGEROUS_OPTIONS, canonical, fingerprint, checkRunRequest, decideExecution, dangerConfirmations, orderResults, countResults, resultSection, isOn };
