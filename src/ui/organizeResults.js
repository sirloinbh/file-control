'use strict';

// The result tables of the folder cleanup screens (#257). They turn the result object of flatten, collapse, normalize and product-number
// (both preview and run) into summary cards and tables. Failed and skipped items come first, and the part of a new name that was added or changed
// (a prefix, a product number) is wrapped in <mark>.
// The result object may be a value that crossed from the job process as JSON (#253 serialize). This is screen code, so it never reads or changes files.

const path = require('node:path');
const { html } = require('./html');
const { summaryCards, table, badge } = require('./layout');

// The path relative to the target. '.' if it is the target itself.
function relativeTo(target, p) {
  return path.relative(target, p) || '.';
}

// The new name with the same start and end left as they are and only the changed middle wrapped in <mark>. It compares by code point, so Korean and emoji are not split.
// video.mp4 -> Show CD1 video.mp4 marks 'Show CD1 ', and abc.mp4 -> ABC-123 abc.mp4 marks 'ABC-123 '.
function highlightChange(oldName, newName) {
  const a = [...String(oldName)];
  const b = [...String(newName)];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = b.slice(0, start).join('');
  const middle = b.slice(start, b.length - end).join('');
  const tail = b.slice(b.length - end).join('');
  return middle === '' ? html`${newName}` : html`${head}<mark>${middle}</mark>${tail}`;
}

// The table of failed or skipped items (shared). items: [{ path, reason }]
function reasonTable(target, items, label = 'Path') {
  return table([{ label, width: '45%' }, { label: 'Reason' }], items.map((item) => [relativeTo(target, item.path ?? item.from), item.reason]));
}

// The table of names that will change. rows: [{ from, name, notes? }]. It shows the original path and the new name (changed part marked) side by side.
function renameTable(target, rows, { status = 'moved' } = {}) {
  return table([{ label: 'Original path', width: '45%' }, { label: 'New name' }], rows.map((row) => [
    relativeTo(target, row.from),
    html`${highlightChange(path.basename(row.from), row.name)}${(row.notes ?? []).map((note) => html` ${badge(note.status ?? status, note.text)}`)}`,
  ]));
}

// One section (a heading and a table). It is left out when empty to keep the screen short, unless always is set.
function section(title, count, content, { always = false } = {}) {
  if (count === 0 && !always) return '';
  return html`<h2>${title} <span class="muted">(${count})</span></h2>${content}`;
}

// The preview mark
function previewNote(result) {
  return result.dryRun ? html`<p>${badge('warning', 'Preview')} Nothing has been changed yet.</p>` : '';
}

function flattenView(result) {
  const t = result.target;
  const moves = result.moved.map((move) => ({
    from: move.from,
    name: move.name,
    notes: [move.fromFolder && { text: 'Folder name used', status: 'done' }, move.numbered && { text: 'Number added', status: 'warning' }].filter(Boolean),
  }));
  return html`${previewNote(result)}${summaryCards([
    { label: 'Moved', value: result.moved.length, tone: 'ok' },
    { label: 'Left in place', value: result.stay.length },
    { label: 'Skipped', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: 'Failed', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
    { label: 'Empty folders removed', value: result.removedFolders.length },
    { label: 'Folders kept', value: result.keptFolders.length, tone: result.keptFolders.length > 0 ? 'warning' : undefined },
  ])}
${section('Failed', result.failed.length, reasonTable(t, result.failed))}
${section('Skipped', result.skipped.length, reasonTable(t, result.skipped))}
${section('Folders kept', result.keptFolders.length, reasonTable(t, result.keptFolders, 'Folder'))}
${section('Moved', result.moved.length, renameTable(t, moves), { always: true })}
${section('Empty folders to the Recycle Bin', result.removedFolders.length, table([{ label: 'Folder' }], result.removedFolders.map((folder) => [relativeTo(t, folder)])))}`;
}

function collapseView(result) {
  const t = result.target;
  const rows = result.collapsed.map((item) => [relativeTo(t, item.leaf), relativeTo(t, item.dest)]);
  return html`${previewNote(result)}${summaryCards([
    { label: 'Collapsed', value: result.collapsed.length, tone: 'ok' },
    { label: 'Skipped', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: 'Failed', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ])}
${section('Failed', result.failed.length, reasonTable(t, result.failed))}
${section('Skipped', result.skipped.length, reasonTable(t, result.skipped))}
${section('Collapsed', result.collapsed.length, table([{ label: 'Inner folder', width: '50%' }, { label: 'New location' }], rows), { always: true })}`;
}

function normalizeView(result) {
  const t = result.target;
  return html`${previewNote(result)}${summaryCards([
    { label: 'Renamed', value: result.renamed.length, tone: 'ok' },
    { label: 'Lowercase words', value: result.inferred.length },
    { label: 'Clashes', value: result.conflicts.length, tone: result.conflicts.length > 0 ? 'warning' : undefined },
    { label: 'Skipped', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: 'Failed', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ])}
${section('Failed', result.failed.length, reasonTable(t, result.failed))}
${section('Name clashes', result.conflicts.length, table([{ label: 'Path', width: '35%' }, { label: 'New name', width: '30%' }, { label: 'Reason' }], result.conflicts.map((item) => [relativeTo(t, item.path), highlightChange(path.basename(item.path), item.name), item.reason])))}
${section('Skipped', result.skipped.length, reasonTable(t, result.skipped))}
${section('Renamed', result.renamed.length, renameTable(t, result.renamed), { always: true })}
${section('Left alone as lowercase words', result.inferred.length, renameTable(t, result.inferred.map((item) => ({ from: item.path, name: item.name }))))}`;
}

const SOURCE_NAMES = { title: 'title', comment: 'comment', folder: 'folder name' };

function productNumberView(result) {
  const t = result.target;
  const renamed = result.renamed.map((item) => ({
    from: item.from,
    name: item.name,
    notes: [{ text: `Found in the ${SOURCE_NAMES[item.source] ?? item.source}`, status: 'done' }, item.note && { text: `Could not read metadata: ${item.note}`, status: 'warning' }].filter(Boolean),
  }));
  return html`${previewNote(result)}${summaryCards([
    { label: 'Renamed', value: result.renamed.length, tone: 'ok' },
    { label: 'Already named', value: result.already.length },
    { label: 'Not found', value: result.notFound.length },
    { label: 'Disagreeing numbers', value: result.conflicts.length, tone: result.conflicts.length > 0 ? 'warning' : undefined },
    { label: 'Skipped', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: 'Failed', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ])}
${section('Failed', result.failed.length, reasonTable(t, result.failed))}
${section('Numbers disagree', result.conflicts.length, table([{ label: 'Path', width: '45%' }, { label: 'Numbers' }], result.conflicts.map((item) => [relativeTo(t, item.path), html`${item.numbers.join(', ')}${item.note ? html` ${badge('warning', `Could not read metadata: ${item.note}`)}` : ''}`])))}
${section('Skipped', result.skipped.length, reasonTable(t, result.skipped))}
${section('Renamed', result.renamed.length, renameTable(t, renamed), { always: true })}
${section('Already named', result.already.length, table([{ label: 'Path', width: '60%' }, { label: 'Number' }], result.already.map((item) => [relativeTo(t, item.path), item.number])))}
${section('Not found', result.notFound.length, table([{ label: 'Path', width: '60%' }, { label: 'Note' }], result.notFound.map((item) => [relativeTo(t, item.path), item.note ?? ''])))}`;
}

// The result screen body by command name.
const VIEWS = { flatten: flattenView, collapse: collapseView, normalize: normalizeView, 'product-number': productNumberView };
function organizeResultView(command, result) {
  const view = VIEWS[command];
  if (!view) throw new Error(`Not a folder cleanup command: ${command}`);
  return view(result);
}

module.exports = { highlightChange, organizeResultView, ORGANIZE_COMMANDS: Object.keys(VIEWS) };
