'use strict';

// The folder cleanup screens (#257): flatten, collapse, normalize and product-number under /organize.
// Every command changes files, so each goes through the shared preview -> run flow (flowPages.js). This module holds the command specs, the result views
// (organizeResults.js draws the tables for both the preview and the run result) and the category landing page.

const { FcError } = require('../../commands');
const { html } = require('../html');
const { page, table } = require('../layout');
const { organizeResultView, ORGANIZE_COMMANDS } = require('../organizeResults');

const CATEGORY_PATH = '/organize';
const TARGET_FIELD = { name: 'target', label: 'Target folder', kind: 'path' };

function requireTarget(values) {
  const target = (values.target ?? '').trim();
  if (!target) throw new FcError('Enter a target folder.');
  return target;
}

// What each command does, for the landing page and the form titles.
const DETAILS = {
  flatten: 'Move files from subfolders directly under the target. Emptied folders go to the Recycle Bin. Nothing is overwritten.',
  collapse: 'Collapse single-folder chains (a/b/c/file) into the top folder.',
  normalize: 'Put the product number in file names first, in uppercase. Nothing is overwritten.',
  'product-number': 'Prefix video file names with the product number. Nothing is overwritten.',
};

const specs = [
  {
    command: 'flatten',
    path: `${CATEGORY_PATH}/flatten`,
    title: 'Flatten folders',
    fields: [TARGET_FIELD],
    toArgv: (values) => ['flatten', '--', requireTarget(values)],
    doneLabel: 'Moved',
  },
  {
    command: 'collapse',
    path: `${CATEGORY_PATH}/collapse`,
    title: 'Collapse single-folder chains',
    fields: [TARGET_FIELD],
    toArgv: (values) => ['collapse', '--', requireTarget(values)],
    doneLabel: 'Collapsed',
  },
  {
    command: 'normalize',
    path: `${CATEGORY_PATH}/normalize`,
    title: 'Normalize names',
    fields: [TARGET_FIELD, { name: 'includeLowercase', label: 'Also treat lowercase words (abc-123) as product numbers', kind: 'checkbox' }],
    toArgv: (values) => ['normalize', ...(values.includeLowercase ? ['--include-lowercase'] : []), '--', requireTarget(values)],
    doneLabel: 'Renamed',
  },
  {
    command: 'product-number',
    path: `${CATEGORY_PATH}/product-number`,
    title: 'Add product numbers',
    fields: [TARGET_FIELD],
    toArgv: (values) => ['product-number', '--', requireTarget(values)],
    doneLabel: 'Renamed',
  },
];

// The result and preview content. The tables come from the result object of execute(), the same one the CLI prints as text.
const views = Object.fromEntries(ORGANIZE_COMMANDS.map((command) => [command, (outcome) => organizeResultView(command, outcome.result)]));

function landingPage({ available }) {
  const rows = specs.map((spec) => [html`<a href="${spec.path}">${spec.title}</a>`, DETAILS[spec.command]]);
  return {
    body: page({
      title: 'Organize folders',
      current: CATEGORY_PATH,
      available,
      body: html`<p>Each command shows a preview first. Nothing changes until you run it from the preview.</p>
${table([{ label: 'Command', width: '30%' }, { label: 'What it does' }], rows)}`,
    }),
  };
}

function routes() {
  return new Map([[CATEGORY_PATH, landingPage]]);
}

module.exports = { specs, views, routes };
