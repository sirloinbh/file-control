'use strict';

// clean-downloads (#392): one combined plan for a Downloads folder, shown as one list and run with one confirmation value.
//   1. junk goes to the Recycle Bin (src/junk.js: unfinished downloads, empty and temp files, identical (1) copies, old installers)
//   2. every other file directly in the folder is sorted by ONE rule, so no file is planned twice: a photo goes by date taken (src/sortPhotos.js),
//      a document by type (src/sortDocs.js), anything else by kind (src/sort.js)
// Removals go to the Recycle Bin only (never permanent), and the move step never overwrites. The junk step runs first; if it cannot start, nothing is moved.
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('./commands');
const { mismatchHints, MAX_RECYCLE_SIZE } = require('./removal');
const { planRemoval: planJunk, sendJunk, formatSize } = require('./junk');
const { planSortWith, applySort, kindFolder } = require('./sort');
const { REMOVAL_LOG } = require('./removalLog');
const { photoFolder } = require('./sortPhotos');
const { docFolder } = require('./sortDocs');

// The Downloads folder in the registry (a known folder GUID), which also follows a Downloads folder moved to another drive or into OneDrive.
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';
const SHELL_FOLDERS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

function registryDownloads() {
  let output;
  try {
    // It is looked up in the module on every call so that tests can intercept it.
    output = childProcess.execFileSync('reg.exe', ['query', SHELL_FOLDERS_KEY, '/v', DOWNLOADS_GUID], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10 * 1000 });
  } catch {
    return null;
  }
  const found = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(output));
  if (!found) return null;
  const expanded = found[1].replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
  return path.isAbsolute(expanded) && !expanded.includes('%') ? expanded : null;
}

// It finds the real Downloads folder instead of hard-coding one: the registry on Windows, else Downloads under the user folder. It must be an existing folder.
function downloadsFolder() {
  const candidates = [process.platform === 'win32' ? registryDownloads() : null, path.join(os.homedir(), 'Downloads')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return fs.realpathSync.native(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  throw new FcError('Cannot find the Downloads folder. Give the folder: clean-downloads <folder>');
}

const key = (p) => (process.platform === 'win32' ? p.toUpperCase() : p);
const GROUPS = ['photos', 'documents', 'other'];

// It makes the combined plan and does not touch files. Returns { target, junk (the junk plan), sort (the sort plan), groups, stamps, interactive }.
function planClean(dir, { older, now, maxSize = MAX_RECYCLE_SIZE } = {}) {
  const junk = planJunk(dir, { older, now, maxSize });
  // Junk, and junk that is kept for now (it changed a moment ago), is never sorted: it stays put or goes to the Recycle Bin.
  const junkKeys = new Set([...junk.junk, ...junk.removals, ...junk.kept].map((item) => key(item.path)));
  const groups = new Map();
  const stamps = new Map();
  const rule = (file) => {
    // The removal logs this command and the other remove commands write into the folder stay where they are.
    if (junkKeys.has(key(file.path)) || junkKeys.has(key(file.real)) || REMOVAL_LOG.test(file.name)) return { ignore: true };
    stamps.set(file.real, `${file.stat.size}:${file.stat.mtimeMs}:${file.stat.ino}`);
    const photo = photoFolder(file);
    if (!photo.ignore) {
      groups.set(file.real, 'photos');
      return photo;
    }
    const doc = docFolder(file.name);
    if (doc !== undefined) {
      groups.set(file.real, 'documents');
      return { folder: doc };
    }
    groups.set(file.real, 'other');
    return { folder: kindFolder(file.name) };
  };
  const sort = planSortWith(junk.target, rule, { recursive: false });
  // The sort engine leaves unfinished downloads and .tmp files in place and says so; the junk list already says it for those, so it is not said twice.
  sort.skipped = sort.skipped.filter((item) => !junkKeys.has(key(item.path)));
  return { target: junk.target, junk, sort, groups, stamps };
}

// A value that stands for the whole list a person saw (junk and moves). It changes if any file in it is added, removed or changed.
function confirmationCode(plan) {
  const removals = plan.junk.removals.map((item) => [item.path, item.reason, item.stamp, item.keep ?? null, item.keepStamp ?? null]).sort(([a], [b]) => (a < b ? -1 : 1));
  const moves = plan.sort.moves.map((move) => [move.from, move.to, plan.stamps.get(move.from) ?? null]).sort(([a], [b]) => (a < b ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(['clean-downloads', plan.target, removals, moves])).digest('hex').slice(0, 12);
}

const empty = () => ({ removed: [], failed: [], log: null });

// Without confirm, or with dryRun, it only makes the list. With the right confirm: the junk goes to the Recycle Bin first, then the files are sorted.
// Returns { ...plan, code, dryRun, confirmed, mismatch, junkResult: { removed, failed, log }, sorted: { moved, skipped, failed } | null }.
function cleanDownloads(dir, { confirm, dryRun = false, older, now, maxSize = MAX_RECYCLE_SIZE, onProgress } = {}) {
  const plan = planClean(dir, { older, now, maxSize });
  const code = confirmationCode(plan);
  const result = { ...plan, code, dryRun, confirmed: false, mismatch: false, junkResult: empty(), sorted: null };
  if (confirm === undefined || dryRun) return result;
  if (confirm !== code) return { ...result, mismatch: true, mismatchHints: mismatchHints(plan.junk) };
  result.confirmed = true;
  // Step 1: junk. If it cannot start (not an interactive session), it throws before the removal log is written and nothing has been moved.
  if (plan.junk.removals.length > 0) {
    const junkResult = sendJunk(plan.junk, { ...plan.junk, confirmed: false, removed: [], failed: [], log: null }, onProgress);
    result.junkResult = { removed: junkResult.removed, failed: junkResult.failed, log: junkResult.log, logWarning: junkResult.logWarning };
  }
  // Step 2: sort. A file that stopped being there or a name that was taken in the meantime is skipped and reported.
  if (plan.sort.moves.length > 0) result.sorted = applySort(plan.sort, { dryRun: false });
  else result.sorted = { moved: [], skipped: [...plan.sort.skipped], failed: [], stay: plan.sort.stay, ignored: plan.sort.ignored };
  return result;
}

function formatClean(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [`Target: ${result.target}`];
  const { junk, sort } = result;
  const doneMoves = new Map((result.sorted?.moved ?? []).map((move) => [move.from, move]));
  if (result.confirmed) {
    for (const item of result.junkResult.removed) lines.push(`Recycle Bin (junk): ${relative(item.path)} (${item.reason})`);
  } else {
    for (const item of junk.removals) lines.push(`To delete (junk): ${relative(item.path)} (${item.reason}; ${formatSize(item.size)})`);
  }
  for (const group of GROUPS) {
    for (const move of sort.moves.filter((entry) => result.groups.get(entry.from) === group)) {
      if (result.confirmed && !doneMoves.has(move.from)) continue;
      const note = move.note === undefined ? '' : ` (${move.note})`;
      lines.push(`${result.confirmed ? 'Moved' : 'To move'} (${group}): ${relative(move.from)} -> ${relative(move.to)}${note}`);
    }
  }
  for (const item of junk.kept) lines.push(`Kept: ${relative(item.path)} (${item.reason})`);
  for (const item of result.junkResult.failed) lines.push(`Failed (junk): ${relative(item.path)} (${item.reason})`);
  for (const item of result.sorted?.failed ?? []) lines.push(`Failed (move): ${relative(item.path)} (${item.reason})`);
  const skipped = result.confirmed ? result.sorted.skipped : sort.skipped;
  for (const item of [...junk.skipped, ...skipped]) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  if (result.mismatch) {
    lines.push('The list changed after the confirmation value was made, so nothing was deleted or moved.');
    for (const item of result.mismatchHints ?? []) lines.push(`Changed: ${relative(item.path)} (${item.reason})`);
  }
  if (result.junkResult.logWarning) lines.push(`Warning: ${result.junkResult.logWarning}`);
  if (result.junkResult.log) lines.push(`Removal log: ${result.junkResult.log}`);
  const count = (group, moves) => moves.filter((move) => result.groups.get(move.from) === group).length;
  const moves = result.confirmed ? (result.sorted?.moved ?? []) : sort.moves;
  const parts = GROUPS.map((group) => `${group} ${count(group, moves)}`).join(', ');
  const failed = result.junkResult.failed.length + (result.sorted?.failed.length ?? 0);
  if (result.confirmed) {
    lines.push(`Recycle Bin ${result.junkResult.removed.length}, moved: ${parts}, failed ${failed}, kept ${junk.kept.length}, skipped ${junk.skipped.length + skipped.length}`);
  } else {
    lines.push(`To delete ${junk.removals.length} (${formatSize(junk.removals.reduce((sum, item) => sum + item.size, 0))}), to move: ${parts}, kept ${junk.kept.length}, skipped ${junk.skipped.length + sort.skipped.length}`);
    if (junk.removals.length + sort.moves.length > 0) lines.push(`Nothing has been changed yet. After checking the list, run again ${result.dryRun ? 'without --dry-run and ' : ''}with --yes=${result.code} to send the junk to the Recycle Bin and sort the rest.`);
    else lines.push('Nothing to clean.');
  }
  return lines.join('\n');
}

module.exports = { downloadsFolder, registryDownloads, planClean, confirmationCode, cleanDownloads, formatClean };
