'use strict';

// The archive screens (#258): zip, unzip and extract-all under /archive.
// All three change files, so they go through the shared preview -> run flow (flowPages.js, #255). Long jobs use the progress page (#253).
// - zip: an archive name and one source per line. The preview names the format that the extension makes.
// - unzip: an archive and an optional folder. The preview shows the size check of #77 (it is part of unzip --dry-run) and the free space left.
// - extract-all: a target folder and --remove-archives. The result is a table with one row per archive. Originals go to the Recycle Bin.
// - Every path field must be a full path and is refused, before any job starts, if it or its real path is in a protected place (#290, CLAUDE.md rule 4).

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('../../commands');
const { html } = require('../html');
const { page, table, alertBox } = require('../layout');
const { describeArchiveFormat, extractAllView, unzipDest, unzipSpace } = require('../archive');
const { refuseProtected, trailingDotOrSpacePart } = require('../protectedPath');

const AREA = '/archive';

// One path per line. Blank lines are dropped and a pair of double quotes around a path (copied with "Copy as path") is removed.
// A pair of double quotes around one path is removed.
const unquote = (text) => String(text).trim().replace(/^"(.*)"$/, '$1').trim();

function parseLines(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim().replace(/^"(.*)"$/, '$1').trim()).filter((line) => line !== '');
}

// A path field after unquoting: a full local path, normalized, and not in a protected place. The server's own current folder means nothing to a
// person in a browser, so a relative path is refused (as on the file screens).
function checkedPath(text, label) {
  if (/[\0\r\n]/.test(text)) throw new FcError(`${label} cannot contain a line break: ${JSON.stringify(text)}`);
  if (!path.isAbsolute(text)) throw new FcError(`${label} must be a full path such as C:\\Users\\you\\Downloads\\a.zip: ${text}`);
  if (process.platform === 'win32' && /^[\\/]{2}/.test(text) && !/^\\\\\?\\[A-Za-z]:/.test(text)) {
    throw new FcError(`Network and device paths are not used: ${text}`);
  }
  const full = path.resolve(text);
  const bad = trailingDotOrSpacePart(full);
  if (bad !== undefined) throw new FcError(`${label} has a name that ends with a dot or space (${bad}): ${full}`);
  return refuseProtected(full, label);
}

// The arguments after the command name, without the options. The spec puts -- before the paths, so everything after it is a path.
function pathsOf(argv) {
  const end = argv.indexOf('--');
  return end === -1 ? argv.slice(1).filter((arg) => !arg.startsWith('--')) : argv.slice(end + 1);
}

const specs = [
  {
    command: 'zip',
    path: `${AREA}/zip`,
    title: 'Compress (zip)',
    fields: [
      { name: 'archive', label: 'Archive file to create (the extension decides the format, for example .zip or .tar.gz)', kind: 'text' },
      { name: 'sources', label: 'Files and folders to compress (one path per line)', kind: 'lines' },
      { name: 'force', label: 'Overwrite the archive if it already exists', kind: 'checkbox' },
    ],
    toArgv(values) {
      const archive = unquote(values.archive);
      const sources = parseLines(values.sources);
      if (archive === '') throw new FcError('Enter the archive file to create.');
      if (sources.length === 0) throw new FcError('Enter at least one file or folder to compress.');
      return ['zip', ...(values.force ? ['--force'] : []), '--', checkedPath(archive, 'The archive'), ...sources.map((source) => checkedPath(source, 'A source'))];
    },
    doneLabel: 'Compressed',
  },
  {
    command: 'unzip',
    path: `${AREA}/unzip`,
    title: 'Extract (unzip)',
    fields: [
      { name: 'archive', label: 'Archive file to extract', kind: 'text' },
      { name: 'dest', label: 'Folder to extract into (empty: a folder named after the archive, next to it)', kind: 'path' },
      { name: 'force', label: 'Overwrite files that already exist in the folder with the same name (the old content cannot be restored)', kind: 'checkbox' },
    ],
    toArgv(values) {
      const archive = unquote(values.archive);
      const dest = unquote(values.dest);
      if (archive === '') throw new FcError('Enter the archive file to extract.');
      const checked = checkedPath(archive, 'The archive');
      // An empty folder means a folder named after the archive next to it; that folder is checked too.
      const destination = checkedPath(unzipDest(checked, dest), 'The folder to extract into');
      return ['unzip', ...(values.force ? ['--force'] : []), '--', checked, ...(dest === '' ? [] : [destination])];
    },
    doneLabel: 'Extracted',
  },
  {
    command: 'extract-all',
    path: `${AREA}/extract-all`,
    title: 'Extract all archives in a folder',
    fields: [
      { name: 'target', label: 'Folder to look in (its subfolders are searched too)', kind: 'path' },
      { name: 'removeArchives', label: 'Send each archive to the Recycle Bin after it was extracted and checked (--remove-archives)', kind: 'checkbox' },
    ],
    toArgv(values) {
      const target = unquote(values.target);
      if (target === '') throw new FcError('Enter the folder to look in.');
      return ['extract-all', ...(values.removeArchives ? ['--remove-archives'] : []), '--', checkedPath(target, 'The folder to look in')];
    },
    doneLabel: 'Extracted',
    runLabel: 'Extract',
  },
];

// The report text of the command, shown as it is under the notes of this screen.
const report = (outcome) => html`<pre class="report">${outcome.report}</pre>`;
const isPreview = (outcome, job) => job.mode === 'preview' || outcome.repreview === true;

// Extracting into a folder that already has entries: without Overwrite a same-name file stops the extraction before anything is written (#349);
// with Overwrite (--force) those files are replaced, and the old content cannot be restored.
function existingWarning(dest, force) {
  let count = 0;
  try {
    count = fs.readdirSync(dest).length;
  } catch {
    return '';
  }
  if (count === 0) return '';
  return alertBox('warning', `The extraction folder already exists and has ${count} ${count === 1 ? 'entry' : 'entries'}. ${force
    ? 'Overwrite is on: files in the archive with the same name will replace them, and the old content cannot be restored.'
    : 'Files in the archive with the same name are not overwritten: if there is one, the extraction stops before it writes anything. Tick Overwrite to replace them.'}`);
}

const views = {
  zip(outcome, job) {
    const archive = pathsOf(job.argv)[0] ?? '';
    return html`<p>Format by the extension: <strong>${describeArchiveFormat(archive).label}</strong></p>
${report(outcome)}`;
  },
  unzip(outcome, job) {
    const [archive, dest] = pathsOf(job.argv);
    if (!isPreview(outcome, job)) return report(outcome);
    const space = unzipSpace(archive ?? '', dest);
    return html`${existingWarning(space.dest, job.argv.includes('--force'))}<p>Extraction folder: <code>${space.dest}</code></p>
<p>${space.text}</p>
${report(outcome)}`;
  },
  'extract-all': extractAllView,
};

function landing(available) {
  const rows = specs.map((spec) => [html`<a href="${spec.path}">${spec.title}</a>`, {
    zip: 'Bundle files and folders into one archive. The extension picks the format.',
    unzip: 'Extract one archive. The size check and the free space are shown before extracting.',
    'extract-all': 'Extract every archive in a folder, and optionally send the originals to the Recycle Bin.',
  }[spec.command]]);
  return page({
    title: 'Archives',
    current: AREA,
    available,
    body: html`<p>Each command shows a preview first. Nothing changes until you run it from the preview.</p>
${table([{ label: 'Command', width: '30%' }, { label: 'What it does' }], rows)}`,
  });
}

function routes() {
  return new Map([[AREA, (req, { available }) => ({ body: landing(available) })]]);
}

module.exports = { specs, views, routes, parseLines };
