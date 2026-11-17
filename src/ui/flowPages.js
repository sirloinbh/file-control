'use strict';

// The shared preview -> run screens (#255). Each file-changing command has a spec; this file builds the form, the preview request and the run request from it.
// - The form has only a Preview button. Dangerous options (force, permanent) are unchecked by default.
// - Preview starts a job with mode 'preview'. The preview result page (jobPages.js) carries the Run form with the fingerprint.
// - Run is checked first (checkRunRequest), then started with mode 'run' and expect = the fingerprint. The child process re-checks the folder.
// - The server never trusts an argv from the form: spec.toArgv rebuilds it from the named fields only.
//
// spec: { command, path, title, fields: [{ name, label, kind: 'text' | 'path' | 'lines' | 'checkbox' }], toArgv(values) -> string[], doneLabel?, toItems?(outcome), runLabel? }
// A checkbox field that is a dangerous option must be named 'force' or 'permanent' (its confirmation field is confirm-<name>).

const { FcError } = require('../commands');
const { html } = require('./html');
const { page } = require('./layout');
const { pathInput } = require('./pickPage');
const { checkRunRequest, dangerOptionsOf, isOn } = require('./flow');
const { runButton, startJobResponse } = require('./jobPages');

// Only the values of the fields the spec names. Anything else in the form is dropped here.
function fieldValues(spec, source) {
  const values = {};
  for (const field of spec.fields) {
    const value = source.get ? source.get(field.name) : source[field.name];
    if (field.kind === 'checkbox') values[field.name] = isOn(value) ? 'on' : '';
    else values[field.name] = typeof value === 'string' ? value : '';
  }
  return values;
}

function fieldRow(spec, field, value) {
  if (field.kind === 'path') return pathInput({ name: field.name, label: field.label, value, returnTo: spec.path });
  if (field.kind === 'lines') return html`<p><label>${field.label}<br><textarea name="${field.name}" rows="5" cols="60" spellcheck="false">${value}</textarea></label></p>`;
  if (field.kind === 'checkbox') return html`<p><label><input type="checkbox" name="${field.name}" value="on"${isOn(value) ? ' checked' : ''}> ${field.label}</label></p>`;
  return html`<p><label>${field.label}<br><input type="text" name="${field.name}" value="${value}" size="60" spellcheck="false"></label></p>`;
}

function formPage(jobs, spec, req, { available, tokenField }) {
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  const values = fieldValues(spec, params);
  // Dangerous options always start off, even when the address asks for them.
  for (const field of spec.fields) if (field.kind === 'checkbox') values[field.name] = '';
  return {
    body: page({
      title: spec.title,
      available,
      body: html`<form method="post" action="${spec.path}/preview">
${tokenField}${spec.fields.map((field) => fieldRow(spec, field, values[field.name]))}
${runButton(jobs, 'Preview')}
</form>`,
    }),
  };
}

function rejectPage(spec, message, available) {
  return { status: 400, body: page({ title: spec.title, available, alerts: [{ kind: 'error', message }], body: html`<p><a href="${spec.path}">Back to the form</a></p>` }) };
}

// Builds the argv from the named fields. A bad value shows the reason (400) and starts nothing.
function buildArgv(spec, values) {
  try {
    return { argv: spec.toArgv(values) };
  } catch (err) {
    if (!(err instanceof FcError)) throw err;
    return { error: err.message };
  }
}

function previewHandler(jobs, spec) {
  return (req, { available, form }) => {
    const values = fieldValues(spec, form);
    const built = buildArgv(spec, values);
    if (built.error) return rejectPage(spec, built.error, available);
    return startJobResponse(jobs, built.argv, { available, start: { mode: 'preview' }, form: values });
  };
}

function runHandler(jobs, spec) {
  return (req, { available, form }) => {
    const plain = Object.fromEntries([...form.keys()].map((key) => [key, form.get(key)]));
    const values = fieldValues(spec, form);
    const built = buildArgv(spec, values);
    if (built.error) return rejectPage(spec, built.error, available);
    // The overwrite and permanent-delete confirmations follow the argv that will run, not the form field names.
    const checked = checkRunRequest({ ...plain, ...dangerOptionsOf(built.argv) });
    if (checked.action === 'reject') return rejectPage(spec, checked.reason, available);
    return startJobResponse(jobs, built.argv, { available, start: { mode: 'run', expect: plain.fingerprint }, form: values });
  };
}

// The routes of the specs: GET spec.path, POST spec.path/preview, POST spec.path/run.
function flowRoutes(jobs, specs) {
  const routes = new Map();
  for (const spec of specs) {
    routes.set(spec.path, (req, context) => formPage(jobs, spec, req, context));
    routes.set(`${spec.path}/preview`, { POST: previewHandler(jobs, spec) });
    routes.set(`${spec.path}/run`, { POST: runHandler(jobs, spec) });
  }
  return routes;
}

module.exports = { flowRoutes, fieldValues };
