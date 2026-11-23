'use strict';

// find (#393): list files under a target that match size, age, extension and name conditions. It does not touch any file.
// It walks with walk.js, so the target rules (protected paths, network paths, links not followed) are the same as the other whole-target commands.

const fs = require('node:fs');
const path = require('node:path');
const { FcError, formatSize } = require('./commands');
const { walk } = require('./walk');
const { resolveTarget } = require('./protectedPaths');
const { plural } = require('./plural');

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const DAY = 24 * 60 * 60 * 1000;
const AGE_UNITS = { d: DAY, w: 7 * DAY, m: 30 * DAY };
const SORTS = ['size', 'date'];

// "1GB", "500KB", "1.5MB", "2048" (bytes). Units are 1024-based, the same as the sizes fctl prints.
function parseSize(text, option) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i.exec(String(text).trim());
  if (!match) throw new FcError(`--${option} needs a size such as 500KB, 1MB or 1GB: ${text}`);
  return Math.floor(Number(match[1]) * SIZE_UNITS[(match[2] ?? 'B').toUpperCase()]);
}

// "180d", "4w", "6m" (a month is 30 days).
function parseAge(text, option) {
  const match = /^(\d+)([dwm])$/i.exec(String(text).trim());
  if (!match) throw new FcError(`--${option} needs an age such as 30d, 4w or 6m (days, weeks, months of 30 days): ${text}`);
  return Number(match[1]) * AGE_UNITS[match[2].toLowerCase()];
}

// "mp4,mkv" or ".mp4, .MKV" -> ['.mp4', '.mkv']
function parseExtensions(text) {
  const list = String(text).split(',').map((part) => part.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  if (list.length === 0) throw new FcError('--ext needs at least one extension, such as --ext=mp4,mkv.');
  return list.map((ext) => `.${ext}`);
}

// A glob on the file name: * is any run of characters, ? is one character. It ignores case, like Windows.
function globToRegExp(pattern) {
  const source = [...pattern].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${source}$`, 'is');
}

// It turns the option texts into one criteria object, refusing a bad value before anything is read.
function findCriteria(options = {}) {
  const criteria = {};
  if (options.larger !== undefined) criteria.larger = parseSize(options.larger, 'larger');
  if (options.smaller !== undefined) criteria.smaller = parseSize(options.smaller, 'smaller');
  if (options.older !== undefined) criteria.older = parseAge(options.older, 'older');
  if (options.newer !== undefined) criteria.newer = parseAge(options.newer, 'newer');
  if (options.ext !== undefined) criteria.ext = parseExtensions(options.ext);
  if (options.name !== undefined) {
    if (options.name === '') throw new FcError('--name needs a pattern, such as --name=*.part or --name=report*.');
    criteria.name = options.name;
  }
  if (options.sort !== undefined) {
    if (!SORTS.includes(options.sort)) throw new FcError(`--sort must be one of ${SORTS.join(', ')}: ${options.sort}`);
    criteria.sort = options.sort;
  }
  if (criteria.larger !== undefined && criteria.smaller !== undefined && criteria.larger >= criteria.smaller) {
    throw new FcError('--larger must be less than --smaller, or nothing can match.');
  }
  if (criteria.older !== undefined && criteria.newer !== undefined && criteria.older >= criteria.newer) {
    throw new FcError('--newer must be a longer age than --older, or nothing can match.');
  }
  return criteria;
}

// It returns { target, criteria, checked, files: [{ path, relative, size, mtimeMs }], total, skipped }.
// A subfolder that cannot be read is listed in skipped and the rest is still searched. now is injectable for tests.
function findFiles(dir, options = {}, { now = Date.now() } = {}) {
  const criteria = findCriteria(options);
  const nameMatch = criteria.name === undefined ? undefined : globToRegExp(criteria.name);
  const target = resolveTarget(dir);
  const unreadable = [];
  const entries = walk(target, { unreadable });
  const files = [];
  const skipped = unreadable.map((item) => ({ path: item.path, relative: item.relative, reason: item.reason }));
  let checked = 0;
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    checked++;
    let stat;
    try {
      stat = fs.lstatSync(entry.path);
    } catch (err) {
      skipped.push({ path: entry.path, relative: entry.relative, reason: `Could not read the file: ${err.code}` });
      continue;
    }
    // The entry was a file when listed; if it became something else since, it is not a file result.
    if (!stat.isFile()) continue;
    const base = path.basename(entry.path);
    if (criteria.larger !== undefined && !(stat.size > criteria.larger)) continue;
    if (criteria.smaller !== undefined && !(stat.size < criteria.smaller)) continue;
    if (criteria.older !== undefined && !(stat.mtimeMs < now - criteria.older)) continue;
    if (criteria.newer !== undefined && !(stat.mtimeMs > now - criteria.newer)) continue;
    if (criteria.ext !== undefined && !criteria.ext.includes(path.extname(base).toLowerCase())) continue;
    if (nameMatch !== undefined && !nameMatch.test(base)) continue;
    files.push({ path: entry.path, relative: entry.relative, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  if (criteria.sort === 'size') files.sort((a, b) => b.size - a.size || a.relative.localeCompare(b.relative));
  else if (criteria.sort === 'date') files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relative.localeCompare(b.relative));
  return { target, criteria, checked, files, total: files.reduce((sum, file) => sum + file.size, 0), skipped };
}

const pad = (n) => String(n).padStart(2, '0');
function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatFind(result) {
  const lines = result.files.map((file) => `${formatSize(file.size).padStart(9)}  ${formatDate(file.mtimeMs)}  ${file.relative}`);
  lines.push(`${plural(result.files.length, 'file')} found out of ${plural(result.checked, 'file')} checked, ${formatSize(result.total)} in total.`);
  for (const item of result.skipped) lines.push(`Skipped: ${item.relative} (${item.reason})`);
  return lines.join('\n');
}

module.exports = { findFiles, formatFind, findCriteria, formatDate, parseSize, parseAge };
