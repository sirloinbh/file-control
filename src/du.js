'use strict';

// du (#395): the total size and file count of each subfolder under a target, largest first. It does not touch any file.
// It walks with walk.js, so the target rules (protected paths, network paths, links not followed) are the same as the other whole-target commands.

const fs = require('node:fs');
const path = require('node:path');
const { FcError, formatSize } = require('./commands');
const { walk } = require('./walk');
const { resolveTarget } = require('./protectedPaths');
const { plural } = require('./plural');

const DEFAULT_DEPTH = 1;
const DEFAULT_TOP = 20;
const MAX_OPTION = 1000000;

function positiveInt(value, option, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d{1,7}$/.test(String(value).trim()) || Number(value) < 1 || Number(value) > MAX_OPTION) {
    throw new FcError(`--${option} needs a whole number from 1 to ${MAX_OPTION}: ${value}`);
  }
  return Number(value);
}

// It returns { target, depth, top, total, files, folders: [{ relative, size, files }], hidden, own, skipped }.
// folders holds the largest `top` folders at depths 1..depth, largest first; hidden is how many more folders were left out by --top.
// own is the size and count of files directly in the target. A subfolder that cannot be read is listed in skipped and the rest is still counted.
function folderSizes(dir, options = {}) {
  const depth = positiveInt(options.depth, 'depth', DEFAULT_DEPTH);
  const top = positiveInt(options.top, 'top', DEFAULT_TOP);
  const target = resolveTarget(dir);
  const unreadable = [];
  const entries = walk(target, { unreadable });
  const skipped = unreadable.map((item) => ({ path: item.path, relative: item.relative, reason: item.reason }));
  const sums = new Map();
  const own = { size: 0, files: 0 };
  const bump = (relative, size) => {
    const sum = sums.get(relative) ?? { relative, size: 0, files: 0 };
    sum.size += size;
    sum.files += 1;
    sums.set(relative, sum);
  };
  let total = 0;
  let files = 0;
  for (const entry of entries) {
    const parts = entry.relative.split(path.sep);
    // A folder is listed even when it is empty, so it shows as 0 files.
    if (entry.type === 'dir') {
      if (parts.length <= depth && !sums.has(entry.relative)) sums.set(entry.relative, { relative: entry.relative, size: 0, files: 0 });
      continue;
    }
    if (entry.type !== 'file') continue;
    let stat;
    try {
      stat = fs.lstatSync(entry.path);
    } catch (err) {
      skipped.push({ path: entry.path, relative: entry.relative, reason: `Could not read the file: ${err.code}` });
      continue;
    }
    if (!stat.isFile()) continue;
    total += stat.size;
    files += 1;
    if (parts.length === 1) {
      own.size += stat.size;
      own.files += 1;
    }
    for (let level = 1; level <= Math.min(depth, parts.length - 1); level++) bump(parts.slice(0, level).join(path.sep), stat.size);
  }
  const ordered = [...sums.values()].sort((a, b) => b.size - a.size || a.relative.localeCompare(b.relative));
  return { target, depth, top, total, files, folders: ordered.slice(0, top), hidden: Math.max(0, ordered.length - top), own, skipped };
}

function formatDu(result) {
  const lines = result.folders.map((folder) => `${formatSize(folder.size).padStart(9)}  ${String(folder.files).padStart(7)} ${folder.files === 1 ? 'file ' : 'files'}  ${folder.relative}`);
  if (result.hidden > 0) lines.push(`(${plural(result.hidden, 'more folder')} not shown; raise --top to see them)`);
  if (result.own.files > 0) lines.push(`${formatSize(result.own.size).padStart(9)}  ${String(result.own.files).padStart(7)} ${result.own.files === 1 ? 'file ' : 'files'}  (files directly in the target)`);
  lines.push(`Total: ${formatSize(result.total)} in ${plural(result.files, 'file')}.`);
  for (const item of result.skipped) lines.push(`Skipped: ${item.relative} (${item.reason})`);
  return lines.join('\n');
}

module.exports = { folderSizes, formatDu };
