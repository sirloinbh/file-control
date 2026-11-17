'use strict';

// The checked run (#255): a preview that carries a fingerprint, and a run that happens only when the folder still matches that preview.
// It runs inside the job process (worker.js), never in the UI server, so the server stays free while PowerShell and tar are waited for.
const fc = require('../commands');
const { fingerprint } = require('./flow');
const { toPlain } = require('./serialize');

const FINGERPRINT = /^[0-9a-f]{64}$/;
const REMOVING = new Set(['remove-broken', 'remove-duplicates', 'remove-low-quality']);

// Keys of the preview result that change between two dry-runs of an unchanged folder, per command.
// Checked empirically (test/uiCheckedRun.test.js runs every file-changing command twice on an unchanged folder). No command needs an entry today:
// dry-runs do not write a removal log or any timing value into the result. Add a key here, with a test, if one ever appears.
const VOLATILE = {};

// The options that a person types and that this flow owns, so they never come from the caller: --dry-run and --yes.
function stripFlow(argv) {
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  const tail = end === -1 ? [] : argv.slice(end);
  return [...head.filter((arg) => arg !== '--dry-run' && arg !== '--yes' && !arg.startsWith('--yes=')), ...tail];
}

// The fingerprint of a preview. The same command, arguments, and preview result give the same value.
function previewFingerprint(argv, outcome) {
  const args = stripFlow(argv.map(String));
  return fingerprint(
    { command: outcome.command, args, options: {}, preview: toPlain(outcome.result) },
    { volatile: VOLATILE[outcome.command] || [] },
  );
}

// Put --dry-run before a literal -- so it is read as an option.
function withOption(argv, option) {
  const end = argv.indexOf('--');
  return end === -1 ? [...argv, option] : [...argv.slice(0, end), option, ...argv.slice(end)];
}

function preview(argv, execute, progress) {
  const outcome = execute(withOption(argv, '--dry-run'), { progress });
  if (outcome.help) return { outcome, fingerprint: null };
  return { outcome, fingerprint: previewFingerprint(argv, outcome) };
}

// mode 'preview': the dry-run outcome plus its fingerprint.
// mode 'run': preview again; if the fingerprint differs from expect, change nothing and return the fresh preview with repreview: true;
//   if it matches, run for real (the remove-* commands get the fresh confirmation code) and return the outcome with ran: true.
function runChecked(argv, { mode, expect } = {}, { execute, progress } = {}) {
  if (mode !== 'preview' && mode !== 'run') throw new fc.FcError('Unknown run mode.');
  if (mode === 'run' && !(typeof expect === 'string' && FINGERPRINT.test(expect))) {
    throw new fc.FcError('Run only after a preview: the preview fingerprint is missing or invalid. Nothing was changed.');
  }
  const base = stripFlow(argv.map(String));
  const first = preview(base, execute, progress);
  if (first.fingerprint === null) throw new fc.FcError('Nothing to preview: no command was given.');
  if (mode === 'preview') return { ...first.outcome, fingerprint: first.fingerprint };
  if (first.fingerprint !== expect) return { ...first.outcome, repreview: true, fingerprint: first.fingerprint };
  const runArgv = REMOVING.has(first.outcome.command) ? withOption(base, `--yes=${first.outcome.result.code}`) : base;
  return { ...execute(runArgv, { progress }), ran: true };
}

module.exports = { previewFingerprint, runChecked, stripFlow, VOLATILE };
