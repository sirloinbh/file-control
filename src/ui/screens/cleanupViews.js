'use strict';

// The result tables of the find and remove screens (#259). They plug into the job result page (jobPages.resultPage) as views.
// outcome.result is the result of the find-* / remove-* function carried as JSON (serialize.toPlain).
// File descriptions, group names and cautions use the same functions as the CLI report.

const path = require('node:path');
const { formatSize } = require('../../commands');
const { describeVideo, groupLabel, groupCautions } = require('../../duplicates');
const { criteriaText } = require('../../lowQuality');
const { html } = require('../html');
const { summaryCards, badge, table, alertBox } = require('../layout');

const relativeTo = (target) => (p) => path.relative(target, p) || '.';

// Video columns: resolution (with the shown size when it differs), bitrate, duration, size
function resolution(file) {
  if (file.width == null || file.height == null) return 'unknown';
  const shown = file.displayWidth != null && file.displayHeight != null && (file.displayWidth !== file.width || file.displayHeight !== file.height);
  return shown ? `${file.width}x${file.height} (shown as ${file.displayWidth}x${file.displayHeight})` : `${file.width}x${file.height}`;
}
const bitrate = (file) => (file.bitrate == null ? 'unknown' : `${Math.round(file.bitrate / 1000)}kbps`);
function duration(seconds) {
  if (seconds == null) return 'unknown';
  const total = Math.round(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`;
}
const size = (bytes) => (bytes == null ? '' : formatSize(bytes));

// Table of files a find command did not judge (undetermined, skipped, and so on).
function otherTable(rel, groups) {
  const rows = groups.flatMap(([label, tone, items]) => items.map((item) => [rel(item.path), badge(tone, label), item.reason]));
  if (rows.length === 0) return '';
  return html`<h2>Files that were not judged</h2>
${table([{ label: 'File', width: '45%' }, { label: 'Status', width: '15%' }, { label: 'Reason' }], rows)}`;
}

function targetLine(result) {
  return html`<p>Target: <code>${result.target}</code></p>`;
}

// find-broken
function findBrokenView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const rows = [
    ...r.broken.map((item) => [rel(item.path), badge('failed', 'Broken'), size(item.size), item.reason]),
    ...r.suspect.map((item) => [rel(item.path), badge('warning', 'Suspect'), size(item.size), item.reason]),
  ];
  return html`${targetLine(r)}
${summaryCards([
    { label: 'Files checked', value: r.checked },
    { label: 'Broken', value: r.broken.length, tone: r.broken.length > 0 ? 'error' : 'ok' },
    { label: 'Suspect', value: r.suspect.length, tone: r.suspect.length > 0 ? 'warning' : undefined },
    { label: 'Undetermined', value: r.unreadable.length },
    { label: 'Skipped', value: r.skipped.length },
  ])}
${table([{ label: 'File', width: '40%' }, { label: 'Verdict', width: '10%' }, { label: 'Size', width: '12%' }, { label: 'Reason' }], rows, { empty: 'No broken or suspect files.' })}
${otherTable(rel, [['Undetermined', 'warning', r.unreadable], ['Skipped', 'skipped', r.skipped]])}`;
}

// One video group: the file to keep and the candidates to delete are shown apart.
function groupSection(rel, title, group, cautions) {
  const rows = group.files.map((file) => {
    const keep = file.path === group.keep.path;
    return [rel(file.path), keep ? html`${badge('kept', 'Keep')} ${group.keep.reason}` : badge('warning', 'Delete candidate'), resolution(file), duration(file.duration), size(file.size)];
  });
  return html`<h3>${title}</h3>
${cautions.map((caution) => alertBox('warning', caution))}
${table([{ label: 'File', width: '34%' }, { label: 'Role', width: '24%' }, { label: 'Resolution', width: '18%' }, { label: 'Length', width: '10%' }, { label: 'Size' }], rows)}`;
}

// find-duplicates
function findDuplicatesView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const byLength = r.metadataGroups.filter((group) => !group.alsoNamed);
  const named = r.groups.map((group) => groupSection(rel, `Duplicate candidates: ${groupLabel(group)} (${group.files.length} files)`, group, groupCautions(group)));
  const lengths = byLength.map((group) => groupSection(
    rel,
    `Same length: ${duration(group.duration)}, aspect ratio ${group.aspect}${group.sameSize ? ', same size' : ''} (${group.files.length} files)`,
    group,
    group.keep.doubt == null ? [] : [group.keep.doubt],
  ));
  const conflicts = r.conflicts.map((item) => ({ path: item.path, reason: `Several numbers: ${item.numbers.join(', ')}` }));
  return html`${targetLine(r)}
${summaryCards([
    { label: 'Videos checked', value: r.checked },
    { label: 'Same-name groups', value: r.groups.length, tone: r.groups.length > 0 ? 'warning' : 'ok' },
    { label: 'Same-length groups', value: byLength.length },
    { label: 'Length unknown', value: r.unknownMetadata },
  ])}
${r.groups.length === 0 && byLength.length === 0 ? html`<p class="muted">No duplicate candidates.</p>` : ''}
${named}
${lengths.length > 0 ? html`<h2>Different names, same length</h2><p class="muted">These may be different videos, so remove-duplicates does not delete these groups.</p>${lengths}` : ''}
${otherTable(rel, [['Several numbers', 'skipped', conflicts], ['Length or resolution unreadable', 'warning', r.metadataErrors], ['Undetermined', 'warning', r.unreadable], ['Skipped', 'skipped', r.skipped]])}`;
}

// find-low-quality
function findLowQualityView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const rows = r.low.map((file) => [rel(file.path), resolution(file), bitrate(file), duration(file.duration), size(file.size), file.reasons.join(', ')]);
  return html`${targetLine(r)}
<p>Criteria: ${criteriaText(r.criteria)}</p>
${summaryCards([
    { label: 'Videos checked', value: r.checked },
    { label: 'Low quality', value: r.low.length, tone: r.low.length > 0 ? 'warning' : 'ok' },
    { label: 'Undetermined', value: r.unreadable.length },
    { label: 'Skipped', value: r.skipped.length },
  ])}
${table([{ label: 'File', width: '30%' }, { label: 'Resolution', width: '18%' }, { label: 'Bitrate', width: '11%' }, { label: 'Length', width: '9%' }, { label: 'Size', width: '10%' }, { label: 'Reason' }], rows, { empty: 'No videos below the limit.' })}
${otherTable(rel, [['Undetermined', 'warning', r.unreadable], ['Skipped', 'skipped', r.skipped]])}`;
}

// The state notice of a removal result: the preview (list to delete), a stop on a changed list, or sent to the Recycle Bin.
function removalState(r) {
  if (r.mismatch) {
    const why = (r.mismatchHints ?? []).length > 0 ? ` ${r.mismatchHints.length} file${r.mismatchHints.length === 1 ? ' is' : 's are'} now held back because they changed within the last 5 minutes.` : '';
    return alertBox('error', `The list differs from the one the confirmation value was made for, so nothing was deleted. Check the new list.${why}`);
  }
  if (r.confirmed) return alertBox(r.failed.length > 0 ? 'warning' : 'success', `Sent ${r.removed.length} files to the Recycle Bin.${r.failed.length > 0 ? ` ${r.failed.length} failed.` : ''}`);
  if (r.removals.length === 0) return alertBox('info', 'There is nothing to delete.');
  return alertBox('info', `Nothing is deleted yet. Check the ${r.removals.length} files below, then run to send them to the Recycle Bin.`);
}

// The description columns of one file to delete (or deleted). They differ per command.
const DESCRIBE = {
  'remove-broken': (item) => [size(item.size), item.reason],
  'remove-duplicates': (item) => [describeVideo(item), ''],
  'remove-low-quality': (item) => [`${resolution(item)}, ${bitrate(item)}, ${duration(item.duration)}, ${size(item.size)}`, (item.reasons ?? []).join(', ')],
};

// remove-broken, remove-duplicates, remove-low-quality
function removeView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const describe = DESCRIBE[outcome.command];
  const duplicates = outcome.command === 'remove-duplicates';
  const setLabel = (item) => (duplicates && r.sets[item.set] ? `${r.sets[item.set].label} (keeping ${rel(r.sets[item.set].keep.path)})` : '');
  const removedPaths = new Set(r.removed.map((item) => item.path));
  const failedPaths = new Set(r.failed.map((item) => item.path));
  const listed = r.confirmed ? r.removals.filter((item) => removedPaths.has(item.path)) : r.removals;
  // A planned file that is neither removed nor failed was not attempted. It stays in the table instead of disappearing (#309).
  const notAttempted = r.confirmed ? r.removals.filter((item) => !removedPaths.has(item.path) && !failedPaths.has(item.path)) : [];
  const doneLabel = r.confirmed ? 'Sent to Recycle Bin' : 'To delete';
  const rows = [
    ...listed.map((item) => [rel(item.path), badge(r.confirmed ? 'done' : 'warning', doneLabel), ...describe(item), setLabel(item)]),
    ...r.failed.map((item) => [rel(item.path), badge('failed'), '', item.reason, setLabel(item)]),
    ...notAttempted.map((item) => [rel(item.path), badge('skipped', 'Not attempted'), ...describe(item), setLabel(item)]),
    // Kept files show their reason (size that would be deleted permanently, Recycle Bin settings, just changed, and so on).
    ...r.kept.map((item) => [rel(item.path), badge('kept'), item.file ? describe(item.file)[0] : '', item.reason, setLabel(item)]),
  ];
  const columns = [{ label: 'File', width: '30%' }, { label: 'Role', width: '13%' }, { label: 'Details', width: '20%' }, { label: 'Reason' }];
  if (duplicates) columns.push({ label: 'Group', width: '20%' });
  const cells = duplicates ? rows : rows.map((row) => row.slice(0, 4));
  const others = [['Undetermined', 'warning', r.unreadable], ['Skipped', 'skipped', r.skipped]];
  if (r.suspect) others.unshift(['Suspect (not deleted)', 'warning', r.suspect]);
  if (r.conflicts) others.unshift(['Several numbers', 'skipped', r.conflicts.map((item) => ({ path: item.path, reason: item.numbers.join(', ') }))]);
  return html`${targetLine(r)}
${r.criteria ? html`<p>Criteria: ${criteriaText(r.criteria)}</p>` : ''}
${removalState(r)}
${duplicates && r.sets.some((set) => set.doubt != null) ? r.sets.filter((set) => set.doubt != null).map((set) => alertBox('warning', `${set.label}: ${set.doubt}`)) : ''}
${duplicates && r.lengthOnly > 0 ? html`<p class="muted">${r.lengthOnly} same-length groups have different names and may be different videos, so they are not deleted.</p>` : ''}
${table(columns, cells, { empty: 'No files to delete or keep.' })}
${r.log ? html`<p>Removal log: <code>${r.log}</code></p>` : ''}
${otherTable(rel, others)}`;
}

// The per-command screens for the result page.
const CLEANUP_VIEWS = {
  'find-broken': findBrokenView,
  'find-duplicates': findDuplicatesView,
  'find-low-quality': findLowQualityView,
  'remove-broken': removeView,
  'remove-duplicates': removeView,
  'remove-low-quality': removeView,
};

module.exports = { CLEANUP_VIEWS, findBrokenView, findDuplicatesView, findLowQualityView, removeView };
