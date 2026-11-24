'use strict';

// `fctl rename-pattern <target>` (#398): renames many files by rule. The rules run in a fixed order on the base name (the extension is kept):
//   1. --replace=<from>/<to>   regular expression replace (all matches; $1 in <to> is a group; a third part "/i" ignores case; write a slash in the pattern as \/)
//   2. --case=upper|lower      changes the case of the name
//   3. --number=<template>     replaces the name by the template: {n} is the number, {n:3} pads it to 3 digits, {name} is the name after rules 1 and 2, {{ and }} are braces
//   4. --date-prefix           puts the modified date (YYYY-MM-DD) and a space in front, unless the name already starts with it
// Numbers start at 1 and follow the name order (numbers inside names compare as numbers: 2 before 10), separately in each folder.
// It never overwrites: if a new name is taken, if two files would get the same name, or if a new name is not a valid Windows name, nothing is renamed and every problem is reported.
// A video's subtitle and sidecar files (src/sidecar.js) are not renamed by themselves: they follow their video and take its new name.

const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk } = require('./target');
const { rejectRepository } = require('./guards');
const { skipReason, applyRenames } = require('./rename');
const { markerFinder } = require('./downloadMarker');
const { findSidecars } = require('./sidecar');
const { guardedFolders, addHiddenFolders, guardOf, downloadReason, caseOnly, nameKey } = require('./normalizeFiles');

const MAX_NAME = 255;
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Splits at the slashes that are not escaped. \/ is a slash inside the part; every other backslash stays for the regular expression.
function splitReplace(text) {
  const parts = [''];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '/') {
      parts[parts.length - 1] += '/';
      i += 1;
    } else if (text[i] === '/') parts.push('');
    else parts[parts.length - 1] += text[i];
  }
  return parts;
}

function parseReplace(text) {
  const parts = splitReplace(text);
  if (parts.length < 2 || parts.length > 3 || (parts[2] !== undefined && parts[2] !== 'i')) {
    throw new FcError('--replace needs the form --replace=<from>/<to> (or <from>/<to>/i to ignore case). Write a slash inside a part as \\/.');
  }
  if (parts[0] === '') throw new FcError('--replace needs a pattern before the slash.');
  try {
    return { regex: new RegExp(parts[0], parts[2] === 'i' ? 'giu' : 'gu'), to: parts[1] };
  } catch (err) {
    throw new FcError(`--replace has an invalid regular expression: ${err.message}`);
  }
}

// The template as a list of pieces: strings, or { n: width } and { name: true }.
function parseTemplate(text) {
  const pieces = [];
  let last = 0;
  let hasNumber = false;
  const token = /\{\{|\}\}|\{(n|name)(?::(\d{1,2}))?\}/g;
  for (let match = token.exec(text); match !== null; match = token.exec(text)) {
    const between = text.slice(last, match.index);
    if (/[{}]/.test(between)) throw new FcError(`--number has a { or } that is not a placeholder: ${text} (write {{ and }} for braces; placeholders are {n}, {n:3} and {name})`);
    if (between) pieces.push(between);
    if (match[0] === '{{') pieces.push('{');
    else if (match[0] === '}}') pieces.push('}');
    else if (match[1] === 'n') {
      pieces.push({ n: match[2] === undefined ? 0 : Number(match[2]) });
      hasNumber = true;
    } else {
      if (match[2] !== undefined) throw new FcError('--number: {name} takes no width.');
      pieces.push({ name: true });
    }
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (/[{}]/.test(rest)) throw new FcError(`--number has a { or } that is not a placeholder: ${text} (write {{ and }} for braces; placeholders are {n}, {n:3} and {name})`);
  if (rest) pieces.push(rest);
  if (!hasNumber) throw new FcError('--number needs {n} (for example --number="photo_{n:3}").');
  return pieces;
}

function parseRules({ replace, number, caseMode, datePrefix }) {
  if (replace === undefined && number === undefined && caseMode === undefined && !datePrefix) {
    throw new FcError('Give at least one rule: --replace=<from>/<to>, --number=<template>, --case=upper|lower, or --date-prefix.');
  }
  if (caseMode !== undefined && caseMode !== 'upper' && caseMode !== 'lower') throw new FcError(`--case must be upper or lower: ${caseMode}`);
  return {
    replace: replace === undefined ? undefined : parseReplace(replace),
    caseMode,
    number: number === undefined ? undefined : parseTemplate(number),
    datePrefix: Boolean(datePrefix),
  };
}

const pad = (value, width = 2) => String(value).padStart(width, '0');
const dateOf = (date) => `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// The new base name of one file under the rules. `index` is its place (from 1) in its folder.
function applyRules(rules, base, index, modified) {
  let name = base;
  if (rules.replace) name = name.replace(rules.replace.regex, rules.replace.to);
  if (rules.caseMode === 'upper') name = name.toUpperCase();
  if (rules.caseMode === 'lower') name = name.toLowerCase();
  if (rules.number) {
    name = rules.number.map((piece) => {
      if (typeof piece === 'string') return piece;
      return piece.n === undefined || 'name' in piece ? name : String(index).padStart(piece.n, '0');
    }).join('');
  }
  if (rules.datePrefix) {
    const prefix = `${dateOf(modified)} `;
    if (!name.startsWith(prefix)) name = prefix + name;
  }
  return name;
}

// Why a new file name cannot be used on Windows, or null.
function invalidName(name) {
  if (name === '' || name === '.' || name === '..') return 'The new name is empty.';
  if (INVALID_CHARS.test(name)) return 'The new name has a character Windows does not allow in a name.';
  if (/[. ]$/.test(name)) return 'The new name ends with a dot or a space.';
  if (name.length > MAX_NAME) return `The new name is longer than ${MAX_NAME} characters.`;
  return null;
}

// It makes the plan. It does not touch files.
// - renames: files to rename ({ from, to, name }), with the sidecars of videos added when the plan is applied
// - conflicts: problems that stop the whole run ({ path, name, reason })
// - skipped: files left alone ({ path, reason })
// - unchanged: the number of files the rules did not change
function planRenamePattern(dir, options = {}) {
  const rules = parseRules(options);
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, renames: [], conflicts: [], skipped: [], unchanged: 0, rules: describeRules(rules, options) };
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  const guards = guardedFolders(access.target, entries);
  const findMarker = markerFinder();
  let hiddenChecked = false;
  const reportedGuards = new Set();
  // The sidecars of a video follow it, so they are not renamed or numbered on their own.
  const carried = new Set();
  const files = [];
  for (const entry of entries) {
    if (entry.type === 'dir') continue;
    if (!options.recursive && entry.relative.includes(path.sep)) continue;
    if (entry.type === 'link') {
      plan.skipped.push({ path: entry.path, reason: 'Links are not renamed.' });
      continue;
    }
    const reason = skipReason(entry);
    if (reason !== null) {
      plan.skipped.push({ path: entry.path, reason });
      continue;
    }
    files.push(entry);
  }
  for (const entry of files) for (const sidecar of findSidecars(entry.path)) carried.add(sidecar.path.toLowerCase());
  // Each folder is numbered on its own, in name order.
  const byFolder = new Map();
  for (const entry of files) {
    if (carried.has(entry.path.toLowerCase())) continue;
    const folder = path.dirname(entry.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
  }
  const wanted = [];
  for (const folder of [...byFolder.keys()].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : 1))) {
    const group = byFolder.get(folder).sort((a, b) => collator.compare(path.basename(a.path), path.basename(b.path)) || (a.path < b.path ? -1 : 1));
    group.forEach((entry, i) => {
      const file = path.basename(entry.path);
      const extension = path.extname(file);
      const base = file.slice(0, file.length - extension.length);
      let modified;
      try {
        modified = rules.datePrefix ? require('node:fs').lstatSync(entry.path).mtime : undefined;
      } catch (err) {
        plan.skipped.push({ path: entry.path, reason: `Cannot read the file. (${err.code})` });
        return;
      }
      const name = applyRules(rules, base, i + 1, modified) + extension;
      if (name === file) {
        plan.unchanged += 1;
        return;
      }
      wanted.push({ entry, name });
    });
  }
  const existing = new Set(entries.map((entry) => nameKey(entry.path)));
  const targets = new Map();
  for (const { entry, name } of wanted) {
    const key = nameKey(path.join(path.dirname(entry.path), name));
    targets.set(key, (targets.get(key) ?? 0) + 1);
  }
  for (const { entry, name } of wanted) {
    const guarded = checkGuards(entry, plan, guards, access, findMarker, reportedGuards, () => {
      if (hiddenChecked) return;
      hiddenChecked = true;
      addHiddenFolders(access.target, guards);
    });
    if (guarded) continue;
    planOne(entry, name, access, plan, existing, targets);
  }
  return plan;
}

// Folders and files that are kept as they are (program and project folders, web page resources, downloads in progress). It returns true when the file is left alone.
function checkGuards(entry, plan, guards, access, findMarker, reportedGuards, checkHidden) {
  const { guarded, pages } = guards;
  checkHidden();
  const guard = guardOf(entry.relative, guarded);
  if (guard !== null) {
    if (!reportedGuards.has(guard)) {
      reportedGuards.add(guard);
      plan.skipped.push({ path: path.join(access.target, guard), reason: `Names inside are not changed because the folder is a ${guarded.get(guard)}.` });
    }
    return true;
  }
  const pageFiles = pages.get(entry.relative);
  if (pageFiles !== undefined) {
    plan.skipped.push({ path: entry.path, reason: `Not renamed because it is a web page linked by name to the resource folder (${pageFiles}).` });
    return true;
  }
  const downloading = downloadReason(entry, findMarker);
  if (downloading !== null) {
    plan.skipped.push({ path: entry.path, reason: downloading });
    return true;
  }
  return false;
}

// One file: a problem with the new name goes to plan.conflicts, which stops the whole run.
function planOne(entry, name, access, plan, existing, targets) {
  const to = path.join(path.dirname(entry.path), name);
  const key = nameKey(to);
  const conflict = (reason) => plan.conflicts.push({ path: entry.path, name, reason });
  const invalid = invalidName(name);
  if (invalid !== null) return conflict(invalid);
  if (targets.get(key) > 1) return conflict('Another file would get the same name.');
  if (key !== nameKey(entry.path) && existing.has(key)) return conflict('The name already exists.');
  try {
    const from = access.read(entry.path);
    // A rename that only changes the case leads to the file itself, so the real spelling of its folder is used.
    const dest = key === nameKey(entry.path) ? path.join(path.dirname(from), name) : access.write(to);
    if (nameKey(path.basename(dest)) !== nameKey(name)) return conflict('The name already exists.');
    plan.renames.push({ from, to: dest, name });
  } catch (err) {
    if (!(err instanceof FcError)) throw err;
    plan.skipped.push({ path: entry.path, reason: err.message });
  }
  return undefined;
}

function describeRules(rules, options) {
  const parts = [];
  if (options.replace !== undefined) parts.push(`replace ${options.replace}`);
  if (rules.caseMode) parts.push(`case ${rules.caseMode}`);
  if (options.number !== undefined) parts.push(`number ${options.number}`);
  if (rules.datePrefix) parts.push('date prefix');
  return parts.join(', ');
}

// It renames the files of the plan. If the plan has any conflict, it renames nothing. Otherwise it goes through applyRenames (no overwriting, sidecars, change journal, case-only renames).
// The returned value: { target, dryRun, renamed, conflicts, skipped, unchanged, failed, refused, rules }.
function renamePattern(dir, options = {}) {
  const plan = planRenamePattern(dir, options);
  return applyRenamePattern(plan, { dryRun: Boolean(options.dryRun) });
}

function applyRenamePattern(plan, { dryRun = false } = {}) {
  if (plan.conflicts.length > 0) {
    const { renames, ...rest } = plan;
    return { ...rest, dryRun, renamed: [], failed: [], refused: true };
  }
  return { ...applyRenames(plan, { dryRun, caseOnly }), refused: false };
}

function formatRenamePattern(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [`Rules: ${result.rules}`];
  for (const item of result.renamed) {
    lines.push(`${prefix}Rename: ${relative(item.from)} -> ${item.name}`);
    for (const move of item.sidecars ?? []) lines.push(`${prefix}  and its sidecar: ${path.basename(move.from)} -> ${path.basename(move.to)}`);
  }
  for (const item of result.conflicts) lines.push(`${prefix}Name problem: ${relative(item.path)} -> ${item.name} (${item.reason})`);
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.from)} (${item.reason})`);
  if (result.refused) lines.push(`${prefix}Nothing was renamed because ${result.conflicts.length === 1 ? 'a new name has a problem' : `${result.conflicts.length} new names have problems`}. Change the rules and run again.`);
  lines.push(`${prefix}Rename ${result.renamed.length}, unchanged ${result.unchanged}, name problems ${result.conflicts.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
  return lines.join('\n');
}

module.exports = { planRenamePattern, applyRenamePattern, renamePattern, formatRenamePattern, parseRules, applyRules };
