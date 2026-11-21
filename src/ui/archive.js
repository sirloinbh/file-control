'use strict';

// The pure parts of the archive screens (#258): the zip format preview, the extract-all result table and the unzip free-space note.
// The format is decided by tar.exe -a from the extension of the archive name. commands.archiveExt is used as it is to see which extension it will take.

const path = require('node:path');
const commands = require('../commands');

const { archiveExt } = commands;
const { html } = require('./html');
const { summaryCards, badge, table } = require('./layout');

// The tables of extensions and names are the ones of src/archive.js (#362), so a new extension there shows in this preview too.
const { FORMAT_LABELS, COMPRESS_LABELS, TAR_COMPRESS } = commands;

const compressKey = (part) => (part === 'Z' ? 'Z' : part.toLowerCase());
const tarCompressKey = (part) => (part === 'taZ' || part === 'tZ' ? part : part.toLowerCase());

// Describes the format that the archive name will make. { ext, format, layers, label }
// format is the bundle format (tar, ZIP and so on); layers are the compression layers, outermost last.
function describeArchiveFormat(name) {
  const ext = archiveExt(String(name));
  const parts = ext.split('.').filter(Boolean);
  const layers = [];
  let format = null;
  // Peel off compression layers from the end.
  let i = parts.length - 1;
  while (i >= 0) {
    const part = parts[i];
    if (COMPRESS_LABELS[compressKey(part)]) {
      layers.unshift(COMPRESS_LABELS[compressKey(part)]);
      i -= 1;
    } else if (TAR_COMPRESS[tarCompressKey(part)]) {
      layers.unshift(TAR_COMPRESS[tarCompressKey(part)]);
      format = 'tar';
      i -= 1;
      break;
    } else {
      break;
    }
  }
  if (format === null && i >= 0) format = FORMAT_LABELS[parts[i].toLowerCase()] ?? null;
  const unknown = format === null && i >= 0 ? parts[i] : null;
  if (format === null) format = 'tar';
  const plain = layers.length === 0 && format === 'tar';
  let label = [format, ...layers].join(' + ');
  if (plain) label = 'tar (no compression)';
  if (unknown !== null) label += ` - .${unknown} is not read as a format`;
  else if (ext === '') label += ' - the name has no extension';
  return { ext, format, layers, label };
}

const relativeTo = (target) => (p) => path.relative(target, p) || '.';

// The extract-all result screen: one row per archive with the result, the extracted folder, the item count and what happened to the original.
// outcome.result is the result of extractArchives carried as JSON.
function extractAllView(outcome) {
  const result = outcome.result;
  const rel = relativeTo(result.target);
  const prefix = result.dryRun ? 'Will extract' : 'Extracted';
  const removed = new Set(result.removed);
  const kept = new Map(result.kept.map((item) => [item.archive, item.reason]));
  // An archive that was extracted but could not be sent to the Recycle Bin also appears in failed. That line is merged into the original column of its extracted row.
  const extracted = new Set(result.extracted.map((item) => item.archive));
  const removalFailed = new Map(result.failed.filter((item) => extracted.has(item.archive)).map((item) => [item.archive, item.reason]));
  const rows = [];
  for (const item of result.extracted) {
    let original = 'Left as it is';
    if (removed.has(item.archive)) original = badge('done', result.dryRun ? 'Will go to the Recycle Bin' : 'Sent to the Recycle Bin');
    else if (kept.has(item.archive)) original = html`${badge('kept')} ${kept.get(item.archive)}`;
    else if (removalFailed.has(item.archive)) original = html`${badge('failed', 'Original not removed')} ${removalFailed.get(item.archive)}`;
    rows.push([rel(item.archive), badge('done', prefix), rel(item.dest), String(item.entries), original]);
  }
  for (const item of result.failed) {
    if (!removalFailed.has(item.archive)) rows.push([rel(item.archive), badge('failed'), '', '', item.reason]);
  }
  for (const item of result.skipped) rows.push([rel(item.path), badge('skipped'), '', '', item.reason]);

  const cards = [
    { label: result.dryRun ? 'Archives to extract' : 'Archives extracted', value: result.extracted.length, tone: 'ok' },
    ...(result.removeArchives ? [{ label: result.dryRun ? 'Originals to send to the Recycle Bin' : 'Originals sent to the Recycle Bin', value: result.removed.length }, { label: 'Originals kept', value: result.kept.length }] : []),
    { label: 'Skipped', value: result.skipped.length },
    { label: 'Failed', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ];
  return html`<p>Target: <code>${result.target}</code>${result.dryRun ? ' (preview: nothing has been changed yet)' : ''}</p>
${summaryCards(cards)}
${table([{ label: 'Archive', width: '28%' }, { label: 'Result', width: '14%' }, { label: 'Extracted folder', width: '24%' }, { label: 'Items', width: '8%' }, { label: 'Original / reason' }], rows, { empty: 'No archives found.' })}`;
}

// The extraction folder of unzip. Without one, it is a folder next to the archive named after the archive (one extension removed), the same as commands.unzip.
function unzipDest(archive, destDir) {
  return destDir || path.join(path.dirname(archive), path.parse(archive).name);
}

// The free space of the volume the extraction folder will go on (#77). The extracted size is in the report of the preview (unzip --dry-run).
// { dest, free, text }, or { dest, free: null, text } if it could not be checked. freeSpace can be replaced in tests.
function unzipSpace(archive, destDir, { freeSpace = commands.freeSpace } = {}) {
  const dest = unzipDest(archive, destDir);
  const reserve = commands.formatSize(Number(commands.SPACE_RESERVE));
  try {
    const free = Number(freeSpace(dest).free);
    return { dest, free, text: `Free space ${commands.formatSize(free)}. It will not extract if less than ${reserve} would be left afterwards.` };
  } catch (err) {
    return { dest, free: null, text: `Could not check the free space (${err.code ?? err.message}). It is checked again when running, and nothing is extracted if it cannot be checked.` };
  }
}

module.exports = { describeArchiveFormat, extractAllView, unzipDest, unzipSpace };
