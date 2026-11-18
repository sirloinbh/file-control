'use strict';

// The basic file screens (#256), category /files: ls, cat, mkdir, write, append, rename, mv, cp, rm.
// - ls and cat only read, so they are plain GET pages (no job, no preview). ls lists one folder; cat shows the start of one file.
// - The commands that change files are specs for the shared preview -> run flow (flowPages.js). Overwrite (force) and permanent delete (permanent) are
//   off by default and need the extra confirmation of the flow.
// - Every path must be a full path. The server's own current folder means nothing to a person in a browser, so a relative path is refused.
// - The changing commands also refuse network and device paths and protected places (CLAUDE.md rule 4), the same list as the whole-folder commands.
// - Several sources (mv, cp, rm) are one per line in a textarea.

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { FcError, formatSize, list } = require('../../commands');
const { protectedPathReason, trailingDotOrSpacePart, TRAILING_DOT_OR_SPACE } = require('../protectedPath');
const { html } = require('../html');
const { page, alertBox, summaryCards, table, badge } = require('../layout');
const { pathInput } = require('../pickPage');

const BASE = '/files';
// The most items one mv, cp, or rm request may name, and the most rows ls shows.
const MAX_SOURCES = 200;
const MAX_ROWS = 1000;
// How much of a file cat reads, and how many bytes of a binary file it shows (as hex).
const CAT_BYTES = 64 * 1024;
const HEX_BYTES = 256;
// The form body limit is 64KiB (security.js) and the content is sent twice (the form and the Run form), so the URL-encoded content stays well under it.
const MAX_ENCODED_CONTENT = 24 * 1024;

const COMMANDS = [
  { command: 'ls', label: 'List a folder', detail: 'Show the files and folders inside a folder' },
  { command: 'cat', label: 'Show a file', detail: 'Show the start of a text file' },
  { command: 'mkdir', label: 'Create a folder', detail: 'Create a folder, and its parent folders if needed' },
  { command: 'write', label: 'Write a file', detail: 'Create a file with the content you type' },
  { command: 'append', label: 'Append to a file', detail: 'Add content to the end of a file' },
  { command: 'rename', label: 'Rename', detail: 'Rename a file or folder in the same folder' },
  { command: 'mv', label: 'Move', detail: 'Move files or folders into another folder' },
  { command: 'cp', label: 'Copy', detail: 'Copy files or folders into another folder' },
  { command: 'rm', label: 'Delete', detail: 'Send files or folders to the Recycle Bin' },
];

// ---------- Checking what a person typed ----------

// The checks both reading and changing share: a real, absolute, local path.
function readablePath(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new FcError(`Enter ${label}.`);
  if (/[\0\r\n]/.test(text)) throw new FcError(`${label} cannot contain a line break: ${JSON.stringify(text)}`);
  // A name starting with a dash would be read as an option by the command.
  if (/^[-–—]/.test(text)) throw new FcError(`${label} cannot start with a dash: ${text}`);
  if (!path.isAbsolute(text)) throw new FcError(`${label} must be a full path such as C:\\Users\\you\\Downloads\\a.txt: ${text}`);
  if (process.platform === 'win32' && /^[\\/]{2}/.test(text) && !/^\\\\\?\\[A-Za-z]:/.test(text)) {
    throw new FcError(`Network and device paths are not used: ${text}`);
  }
  // Slashes and . or .. parts are normalized (D:/x -> D:\x) so the preview, the fingerprint and the command all see one spelling.
  return path.resolve(text);
}

// A path a command will change. It also refuses protected places and names that Windows tools read as another name.
function changeablePath(value, label) {
  const text = readablePath(value, label);
  const bad = trailingDotOrSpacePart(text);
  if (bad !== undefined) throw new FcError(`${label} has a name that ends with a dot or space (${bad}): ${text}`);
  const reason = protectedPathReason(text);
  if (reason) throw new FcError(`${label} is a protected place (${reason}): ${text}`);
  return text;
}

// One path per line. Blank lines are ignored; at least one is needed.
function pathLines(value, label) {
  const lines = (typeof value === 'string' ? value : '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) throw new FcError(`Enter ${label}, one per line.`);
  if (lines.length > MAX_SOURCES) throw new FcError(`Too many items (${lines.length}). Use at most ${MAX_SOURCES} at a time.`);
  return lines.map((line) => changeablePath(line, label));
}

// The content of write and append. Line breaks are made plain \n so the same text always gives the same preview (a browser sends \r\n).
function contentOf(value) {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
  if (new URLSearchParams({ content: text }).toString().length > MAX_ENCODED_CONTENT) {
    throw new FcError('The content is too long for this form. Write a long file from a terminal with fctl write.');
  }
  return text;
}

function newName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new FcError('Enter the new name.');
  if (/[\0\r\n]/.test(text) || /[\\/]/.test(text)) throw new FcError('The new name cannot contain a path or a line break. Use Move to move.');
  if (/^[-–—]/.test(text)) throw new FcError(`The new name cannot start with a dash: ${text}`);
  if (process.platform === 'win32' && TRAILING_DOT_OR_SPACE.test(text)) throw new FcError(`The new name cannot end with a dot or space: ${text}`);
  return text;
}

const forceFlag = (values) => (values.force ? ['--force'] : []);
const FORCE = (label) => ({ name: 'force', label, kind: 'checkbox' });

// The lines a command printed (a string or an array of strings).
function linesOf(outcome) {
  const result = outcome && outcome.result;
  return (Array.isArray(result) ? result : [result]).filter((line) => typeof line === 'string' && line !== '');
}

// ---------- The specs of the commands that change files ----------

const specs = [
  {
    command: 'mkdir',
    path: `${BASE}/mkdir`,
    title: 'Create a folder',
    fields: [{ name: 'folder', label: 'Folder to create (full path)', kind: 'path' }],
    toArgv: (values) => ['mkdir', changeablePath(values.folder, 'The folder')],
    doneLabel: 'Created',
  },
  {
    command: 'write',
    path: `${BASE}/write`,
    title: 'Write a file',
    fields: [
      { name: 'file', label: 'File to write (full path)', kind: 'text' },
      { name: 'content', label: 'Content', kind: 'textarea', rows: 10 },
      FORCE('Overwrite the file if it already exists'),
    ],
    // The content goes after -- so text such as "--force" or "- item" is never read as an option.
    toArgv: (values) => ['write', changeablePath(values.file, 'The file'), ...forceFlag(values), '--', contentOf(values.content)],
    doneLabel: 'Written',
  },
  {
    command: 'append',
    path: `${BASE}/append`,
    title: 'Append to a file',
    fields: [
      { name: 'file', label: 'File to add to (full path)', kind: 'text' },
      { name: 'content', label: 'Content to add', kind: 'textarea', rows: 10 },
    ],
    toArgv: (values) => ['append', changeablePath(values.file, 'The file'), '--', contentOf(values.content)],
    doneLabel: 'Appended',
  },
  {
    command: 'rename',
    path: `${BASE}/rename`,
    title: 'Rename',
    fields: [
      { name: 'target', label: 'File or folder to rename (full path)', kind: 'text' },
      { name: 'name', label: 'New name (a name only, no path)', kind: 'text' },
      FORCE('Overwrite if the new name already exists'),
    ],
    toArgv: (values) => ['rename', changeablePath(values.target, 'The file or folder'), newName(values.name), ...forceFlag(values)],
    doneLabel: 'Renamed',
  },
  {
    command: 'mv',
    path: `${BASE}/mv`,
    title: 'Move',
    fields: [
      { name: 'sources', label: 'Items to move (full paths, one per line)', kind: 'lines' },
      { name: 'dest', label: 'Destination (full path; a folder to move into)', kind: 'path' },
      FORCE('Overwrite items that already exist in the destination'),
    ],
    toArgv: (values) => ['mv', ...forceFlag(values), ...pathLines(values.sources, 'The items to move'), changeablePath(values.dest, 'The destination')],
    doneLabel: 'Moved',
  },
  {
    command: 'cp',
    path: `${BASE}/cp`,
    title: 'Copy',
    fields: [
      { name: 'sources', label: 'Items to copy (full paths, one per line)', kind: 'lines' },
      { name: 'dest', label: 'Destination (full path; a folder to copy into)', kind: 'path' },
      FORCE('Overwrite items that already exist in the destination'),
    ],
    toArgv: (values) => ['cp', ...forceFlag(values), ...pathLines(values.sources, 'The items to copy'), changeablePath(values.dest, 'The destination')],
    doneLabel: 'Copied',
  },
  {
    command: 'rm',
    path: `${BASE}/rm`,
    title: 'Delete',
    fields: [
      { name: 'targets', label: 'Items to delete (full paths, one per line)', kind: 'lines' },
      { name: 'permanent', label: 'Delete permanently instead of using the Recycle Bin', kind: 'checkbox' },
    ],
    toArgv: (values) => ['rm', ...(values.permanent ? ['--permanent'] : []), ...pathLines(values.targets, 'The items to delete')],
    doneLabel: 'Deleted',
  },
];

// Every spec shows what it printed as one row per line (the result table after a run is built from the same lines).
for (const spec of specs) {
  spec.toItems = (outcome) => linesOf(outcome).map((line) => ({ status: 'done', path: line }));
}

// ---------- The preview view ----------

// The preview is what the command would do, one row per line. A line that says it overwrites or replaces something gets a warning.
function previewView(outcome) {
  const lines = linesOf(outcome).map((line) => line.replace(/^\[Preview\] /, ''));
  const risky = lines.some((line) => /\((?:overwrites|replaces)\b|overwritten/i.test(line));
  return html`${risky ? alertBox('warning', 'Existing items would be overwritten or replaced. This is done only with the confirmation below.') : ''}
<h2>What will happen</h2>
${table([{ label: 'Action' }], lines.map((line) => [line]), { empty: 'Nothing would change.' })}`;
}

const views = Object.fromEntries(specs.map((spec) => [spec.command, previewView]));

// ---------- Read-only screens: landing page, ls, cat ----------

// Extra hardening on top of the session cookie and the Host check (#265, #252): a read is also refused when the browser says the request was started by another site.
// A link or image on another site cannot make it read (same rule as the folder picker).
function fromOtherSite(req) {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
}

function queryOf(req) {
  return new URL(req.url, 'http://127.0.0.1').searchParams;
}

function readOnlyPage(title, available, alerts, body) {
  return { body: page({ title, current: BASE, available, alerts, body }) };
}

function landing({ available }) {
  const rows = COMMANDS.map(({ command, label, detail }) => [html`<a href="${BASE}/${command}">${label}</a>`, html`<code>${command}</code>`, detail]);
  return {
    body: page({
      title: 'Basic file tasks',
      current: BASE,
      available,
      body: html`<p>Commands that change files show a preview first. Deleting sends items to the Recycle Bin unless you choose permanent delete, and overwriting or permanent delete ask for one more confirmation.</p>
${table([{ label: 'Task', width: '30%' }, { label: 'Command', width: '12%' }, { label: 'What it does' }], rows)}`,
    }),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function catLink(file) {
  return `${BASE}/cat?${new URLSearchParams({ file })}`;
}
function lsLink(dir) {
  return `${BASE}/ls?${new URLSearchParams({ dir })}`;
}

// ls: a GET form (no token, it changes nothing). Like the folder picker, it can look into protected folders (it shows only names, sizes and times); cat and the changing commands cannot. With ?dir=<folder> it also shows the folder. The folder picker returns here with ?dir=.
function lsPage(req, { available }) {
  const dir = (queryOf(req).get('dir') ?? '').trim();
  const form = html`<form method="get" action="${BASE}/ls">
${pathInput({ name: 'dir', label: 'Folder (full path)', value: dir, returnTo: `${BASE}/ls` })}
<button type="submit">Show</button>
</form>`;
  if (dir === '') return readOnlyPage('List a folder', available, [], form);
  if (fromOtherSite(req)) return readOnlyPage('List a folder', available, [{ kind: 'error', message: 'The address was opened from another site, so the folder was not read. Press Show to read it.' }], form);
  let entries;
  let folder;
  try {
    folder = readablePath(dir, 'The folder');
    if (!fs.statSync(folder).isDirectory()) throw new FcError(`Not a folder: ${folder}`);
    entries = list(folder);
  } catch (err) {
    const message = err instanceof FcError ? err.message : `Could not read the folder: ${err.code ?? err.message}`;
    return readOnlyPage('List a folder', available, [{ kind: 'error', message }], form);
  }
  const shown = entries.slice(0, MAX_ROWS);
  const dirs = entries.filter((entry) => entry.type === 'dir').length;
  const files = entries.length - dirs;
  const rows = shown.map((entry) => {
    const full = path.join(folder, entry.name);
    return [
      entry.type === 'dir' ? html`<a href="${lsLink(full)}">${entry.name}</a>` : html`<a href="${catLink(full)}">${entry.name}</a>`,
      entry.type === 'dir' ? 'Folder' : 'File',
      entry.size === null ? '' : formatSize(entry.size),
      entry.modified ? formatTime(entry.modified) : '',
    ];
  });
  const parent = path.dirname(folder);
  return readOnlyPage('List a folder', available, [], html`${form}
<h2>${folder}</h2>
${parent === folder ? '' : html`<p><a href="${lsLink(parent)}">Up one level</a></p>`}
${summaryCards([{ label: 'Folders', value: dirs }, { label: 'Files', value: files }])}
${table([{ label: 'Name', width: '46%' }, { label: 'Type', width: '10%' }, { label: 'Size', width: '14%' }, { label: 'Modified' }], rows, { empty: 'This folder is empty.' })}
${entries.length > shown.length ? html`<p class="muted">Too many items, so only the first ${shown.length} are shown (${entries.length - shown.length} more).</p>` : ''}`);
}

// The start of a file: { size, bytes, truncated }. Only a regular file is opened (a folder or a device name is refused).
function readStart(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new FcError(`Not a regular file: ${file}`);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, CAT_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { size: stat.size, bytes: buffer.subarray(0, read), truncated: stat.size > read };
  } finally {
    fs.closeSync(fd);
  }
}

function hexDump(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, i + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const text = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${text}`);
  }
  return lines.join('\n');
}

// cat: a GET form with ?file=<file>. A text file shows its start as it is (line breaks and spaces kept); a binary file shows only the first bytes as hex.
function catPage(req, { available }) {
  const file = (queryOf(req).get('file') ?? '').trim();
  const form = html`<form method="get" action="${BASE}/cat">
<p><label>File (full path)<br><input type="text" name="file" value="${file}" size="60" spellcheck="false"></label></p>
<button type="submit">Show</button>
</form>`;
  if (file === '') return readOnlyPage('Show a file', available, [], form);
  if (fromOtherSite(req)) return readOnlyPage('Show a file', available, [{ kind: 'error', message: 'The address was opened from another site, so the file was not read. Press Show to read it.' }], form);
  let start;
  let full;
  try {
    full = readablePath(file, 'The file');
    const reason = protectedPathReason(full);
    if (reason) throw new FcError(`This file is in a protected place (${reason}), so it is not shown: ${full}`);
    start = readStart(full);
  } catch (err) {
    const message = err instanceof FcError ? err.message : `Could not read the file: ${err.code ?? err.message}`;
    return readOnlyPage('Show a file', available, [{ kind: 'error', message }], form);
  }
  const binary = start.bytes.includes(0);
  const alerts = [];
  let content;
  if (binary) {
    alerts.push({ kind: 'warning', message: `This looks like a binary file (${formatSize(start.size)}), so only the first ${Math.min(HEX_BYTES, start.bytes.length)} bytes are shown, as hex.` });
    content = hexDump(start.bytes.subarray(0, HEX_BYTES));
  } else {
    if (start.truncated) alerts.push({ kind: 'info', message: `This file is large (${formatSize(start.size)}), so only the first ${formatSize(start.bytes.length)} are shown.` });
    // A multi-byte character cut at the end of what was read is dropped, not shown as a broken character.
    content = new StringDecoder('utf8').write(start.bytes);
  }
  return readOnlyPage('Show a file', available, alerts, html`${form}
<h2>${full}</h2>
<p class="muted">${badge('skip', binary ? 'Binary' : 'Text')} ${formatSize(start.size)}</p>
${start.bytes.length === 0 ? html`<p class="muted">The file is empty.</p>` : html`<pre class="report">${content}</pre>`}
<p><a href="${lsLink(path.dirname(full))}">List the folder</a></p>`);
}

// The addresses of this area besides the specs' own: the landing page, ls, and cat. jobs is not needed (nothing here runs a job).
function routes() {
  return new Map([
    [BASE, (req, context) => landing(context)],
    [`${BASE}/ls`, (req, context) => lsPage(req, context)],
    [`${BASE}/cat`, (req, context) => catPage(req, context)],
  ]);
}

module.exports = { specs, views, routes, MAX_SOURCES, CAT_BYTES };
