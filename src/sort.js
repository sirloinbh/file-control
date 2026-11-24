'use strict';

// The shared sort engine (#388). It takes the files of a folder and a rule (file -> destination folder name) and makes a move plan,
// then runs the plan without overwriting. sort-by uses it with the kind and month rules; sort-photos, sort-docs and clean-downloads reuse it with their own rules.
const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant } = require('./target');
const { moveWithoutOverwrite } = require('./safeMove');
const journal = require('./journal');
const { LEFTOVER, PROGRAM_FOLDER, PROJECT_FILE, rejectRepository, rejectProjectAncestor } = require('./guards');
const { FOLDER_METADATA } = require('./flatten');
const { listEntries } = require('./walk');
const { sidecarMoves } = require('./sidecar');
const { plural } = require('./plural');

const ext = (name) => path.extname(name).toLowerCase();
const extensions = (list) => new Set(list.split(' '));

// The extension to kind table. Folder names are the ones the user sees.
const KINDS = [
  ['Videos', extensions('.mp4 .mkv .avi .mov .wmv .flv .webm .m4v .mpg .mpeg .m2ts .mts .3gp .ogv')],
  ['Images', extensions('.jpg .jpeg .png .gif .bmp .webp .heic .heif .tif .tiff .svg .ico .raw .cr2 .nef .arw .dng .avif')],
  ['Documents', extensions('.pdf .doc .docx .xls .xlsx .csv .ppt .pptx .hwp .hwpx .txt .md .rtf .odt .ods .odp .epub')],
  ['Archives', extensions('.zip .rar .7z .tar .gz .tgz .bz2 .xz .zst .iso')],
  ['Audio', extensions('.mp3 .wav .flac .aac .ogg .m4a .wma .opus .mid')],
  ['Installers', extensions('.exe .msi .msix .appx .dmg .pkg .deb .rpm .apk')],
];
const OTHER_FOLDER = 'Other';

// Files that are not finished yet. Moving one would break the download or the program that is writing it, so they stay.
const UNFINISHED = extensions('.crdownload .part .partial .download .opdownload .tmp .temp');

function kindFolder(name) {
  const e = ext(name);
  return KINDS.find(([, set]) => set.has(e))?.[0] ?? OTHER_FOLDER;
}

// YYYY-MM from the modified time, in local time (the month the user sees in Explorer).
function monthFolder(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const RULES = {
  kind: (file) => ({ folder: kindFolder(file.name) }),
  month: (file) => ({ folder: monthFolder(file.stat.mtime) }),
};

const reasonOf = (err) => (err instanceof FcError ? err.message : `Cannot check the file. (${err.code ?? err.message})`);
const nameKey = (name) => (process.platform === 'win32' ? name.toUpperCase() : name);

// The files directly in the target, or all files below it with recursive. It reads only what it needs, so a big tree is not read for a flat sort.
function listFiles(target, recursive) {
  if (recursive) return listEntries(target);
  let dirents;
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    throw new FcError(`Cannot read the folder: ${target} (${err.code})`);
  }
  return dirents.filter((dirent) => !(dirent.isDirectory() && dirent.name.toLowerCase() === '.fctl-journal')).map((dirent) => ({
    path: path.join(target, dirent.name),
    relative: dirent.name,
    type: dirent.isSymbolicLink() ? 'link' : dirent.isDirectory() ? 'dir' : 'file',
  }));
}

// A project folder keeps its files where the tools expect them, so it is not sorted.
function guardTarget(target, entries) {
  rejectRepository(target, entries);
  rejectProjectAncestor(target);
  const marker = entries.find((entry) => entry.type === 'file' && path.dirname(entry.relative) === '.' && PROJECT_FILE.test(entry.relative));
  if (marker) throw new FcError(`Not handled because the target looks like a project folder (contains ${marker.relative}). Choose a folder below it as the target: ${target}`);
}

// The folders a recursive sort must leave whole: program folders (node_modules and so on) and folders that hold a project marker file.
// Taking files out of them would break the project or the dependencies, and there is nothing to restore them from.
function guardedFolders(entries) {
  const guarded = new Map();
  for (const entry of entries) {
    const name = path.basename(entry.relative);
    const parent = path.dirname(entry.relative);
    if (entry.type === 'dir' && PROGRAM_FOLDER.test(name)) guarded.set(entry.relative, `program folder (${name})`);
    else if (entry.type === 'file' && parent !== '.' && PROJECT_FILE.test(name) && !guarded.has(parent)) guarded.set(parent, `project folder (contains ${name})`);
  }
  return guarded;
}

function guardOf(relative, guarded) {
  const parts = relative.split(path.sep);
  for (let depth = 1; depth <= parts.length; depth++) {
    const folder = parts.slice(0, depth).join(path.sep);
    if (guarded.has(folder)) return folder;
  }
  return undefined;
}

// The subtitle and sidecar files of the videos in the list (#426): { sidecar path (lower case) -> video path }. They are not sorted by a rule of their own; they go where their video goes (or stay with it).
function ownedSidecars(entries, guarded) {
  const { VIDEO_EXTENSIONS } = require('./video');
  const { findSidecars } = require('./sidecar');
  const owned = new Map();
  for (const entry of entries) {
    if (entry.type !== 'file' || !VIDEO_EXTENSIONS.has(ext(entry.relative)) || guardOf(entry.relative, guarded) !== undefined) continue;
    for (const sidecar of findSidecars(entry.path)) owned.set(sidecar.path.toLowerCase(), entry.path);
  }
  return owned;
}

// A destination folder name must be a real folder: a file with that name (or a link) is in the way.
function folderBlock(target, name) {
  const stat = fs.lstatSync(path.join(target, name), { throwIfNoEntry: false });
  if (!stat || stat.isDirectory()) return undefined;
  return `Left in place because ${name} exists and is ${stat.isSymbolicLink() ? 'a link' : 'a file'}, not a folder. Rename it and run again.`;
}

// Windows refuses a path of 260 characters or more in many programs, so a move that would make one is skipped.
const MAX_PATH = 259;

// rule(file) gets { name, path, real (the checked real path), relative, stat } and returns { folder } (a folder name, or 'a/b' for nested folders), { stay: reason } to leave the file where it is and report it, or { ignore: true } to leave it without a report line. A { folder, note } decision shows the note after the move in the report.
// It does not touch files. Returns { target, moves, stay, ignored, skipped }; stay is the count of files already in the right folder and ignored the count of files the rule does not concern.
function planSortWith(dir, rule, { recursive = false } = {}) {
  const access = grant(dir, ['read', 'write']);
  const target = access.target;
  const entries = listFiles(target, recursive);
  guardTarget(target, entries);
  const moves = [];
  const skipped = [];
  let stay = 0;
  let ignored = 0;
  const taken = new Set();
  const guarded = recursive ? guardedFolders(entries) : new Map();
  const reported = new Set();
  const owned = ownedSidecars(entries, guarded);
  for (const entry of entries) {
    const guard = guardOf(entry.relative, guarded);
    if (guard !== undefined) {
      if (!reported.has(guard)) {
        reported.add(guard);
        skipped.push({ path: path.join(target, guard), reason: `Left whole because it is a ${guarded.get(guard)}.` });
      }
      continue;
    }
    const name = path.basename(entry.relative);
    if (entry.type === 'link') {
      skipped.push({ path: entry.path, reason: 'Left in place because it is a link.' });
      continue;
    }
    if (entry.type !== 'file') continue;
    // A sidecar of a video goes with its video, so it is handled when the video is.
    if (owned.has(entry.path.toLowerCase())) continue;
    if (FOLDER_METADATA.test(name)) continue;
    if (LEFTOVER.test(name)) {
      skipped.push({ path: entry.path, reason: 'Left in place because it is a leftover of a failed move and must stay where the message said.' });
      continue;
    }
    if (UNFINISHED.has(ext(name))) {
      skipped.push({ path: entry.path, reason: 'Left in place because it looks like an unfinished download.' });
      continue;
    }
    try {
      const from = access.read(entry.path);
      const stat = fs.lstatSync(from);
      const decision = rule({ name, path: entry.path, real: from, relative: entry.relative, stat });
      // ignore: the rule does not concern this file (a photo rule and a text file). It is counted but not listed.
      if (decision.ignore) {
        ignored++;
        continue;
      }
      if (decision.stay !== undefined) {
        skipped.push({ path: entry.path, reason: decision.stay });
        continue;
      }
      const folders = decision.folder.split('/');
      const toRelative = path.join(...folders, name);
      // A file anywhere under its destination folder stays, so a second run does not flatten Videos/2020/a.mp4 into Videos/.
      const dirKey = nameKey(path.dirname(entry.relative));
      const destKey = nameKey(folders[0]);
      if (dirKey === destKey || dirKey.startsWith(destKey + path.sep)) {
        stay++;
        continue;
      }
      const block = folderBlock(target, folders[0]);
      if (block !== undefined) {
        skipped.push({ path: entry.path, reason: block });
        continue;
      }
      if (path.join(target, toRelative).length > MAX_PATH) {
        skipped.push({ path: entry.path, reason: 'Left in place because the new path would be too long.' });
        continue;
      }
      const to = access.write(toRelative);
      if (taken.has(nameKey(toRelative)) || fs.lstatSync(to, { throwIfNoEntry: false })) {
        skipped.push({ path: entry.path, reason: `Left in place because ${path.join(...folders, name)} already exists.` });
        continue;
      }
      // The sidecars of a video move to the same folder with it. A clash on any of them leaves the whole group in place.
      const group = [{ from, to, folder: decision.folder, name, ...(decision.note === undefined ? {} : { note: decision.note }) }];
      const clash = [];
      for (const move of sidecarMoves(from, to)) {
        const sidecarName = path.basename(move.to);
        const sidecarRelative = path.join(...folders, sidecarName);
        const sidecarTo = access.write(sidecarRelative);
        if (taken.has(nameKey(sidecarRelative)) || fs.lstatSync(sidecarTo, { throwIfNoEntry: false })) clash.push(path.join(...folders, sidecarName));
        else group.push({ from: move.from, to: sidecarTo, folder: decision.folder, name: sidecarName, note: `sidecar of ${name}` });
      }
      if (clash.length > 0) {
        skipped.push({ path: entry.path, reason: `Left in place because ${clash[0]} already exists, and its sidecar files stay with it.` });
        continue;
      }
      taken.add(nameKey(toRelative));
      for (const move of group.slice(1)) taken.add(nameKey(path.join(...folders, move.name)));
      moves.push(...group);
    } catch (err) {
      skipped.push({ path: entry.path, reason: reasonOf(err) });
    }
  }
  return { target, moves, stay, ignored, skipped };
}

// It runs a plan. A clash found at run time (a file that appeared in the meantime) is skipped, and even if one file fails the rest go on.
function applySort(plan, { dryRun = false } = {}) {
  const result = { target: plan.target, dryRun, moved: [], stay: plan.stay, ignored: plan.ignored ?? 0, skipped: [...plan.skipped], failed: [] };
  if (dryRun) {
    result.moved = plan.moves.map((move) => ({ ...move }));
    return result;
  }
  const access = grant(plan.target, ['read', 'write']);
  for (const move of plan.moves) {
    const created = [];
    try {
      const from = access.read(move.from);
      const to = access.write(path.relative(plan.target, move.to));
      // Remember which folders this move creates, outermost last, so a failed move can remove them again.
      for (let dir = path.dirname(to); dir !== plan.target && !fs.existsSync(dir); dir = path.dirname(dir)) created.push(dir);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // The move is recorded after the folders it made (outermost first), so undo moves the file back before it removes the empty folder (#427).
      // A folder is recorded only when a move happened, so a failed or skipped move leaves no step that undo cannot find.
      const moved = journal.quiet(() => moveWithoutOverwrite(from, to));
      if (moved) {
        for (const dir of [...created].reverse()) journal.record('create-dir', { path: dir });
        journal.record('move', { from, to });
        created.length = 0;
        result.moved.push({ ...move, from, to });
      } else result.skipped.push({ path: move.from, reason: `Left in place because ${path.relative(plan.target, move.to)} already exists.` });
    } catch (err) {
      result.failed.push({ path: move.from, reason: reasonOf(err) });
    }
    // Folders this move created and nothing was moved into are removed again (rmdir refuses a folder that has anything in it).
    for (const dir of created) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // It has content or is gone: leave it.
      }
    }
  }
  return result;
}

// by: 'kind' or 'month'. Returns the result of applySort plus by.
function sortBy(dir, { by, dryRun = false, recursive = false } = {}) {
  if (!Object.hasOwn(RULES, by ?? '')) throw new FcError('Choose how to sort: --by=kind or --by=month.');
  return { by, ...applySort(planSortWith(dir, RULES[by], { recursive }), { dryRun }) };
}

function formatSort(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [];
  for (const item of result.moved) lines.push(`${prefix}Move: ${relative(item.from)} -> ${relative(item.to)}${item.note === undefined ? '' : ` (${item.note})`}`);
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.path)} (${item.reason})`);
  lines.push(`${prefix}Move ${plural(result.moved.length, 'file')}, already in place ${result.stay}, skipped ${result.skipped.length}, failed ${result.failed.length}${result.ignored > 0 ? `, not concerned ${result.ignored}` : ''}`);
  return lines.join('\n');
}

module.exports = { KINDS, OTHER_FOLDER, RULES, kindFolder, monthFolder, guardedFolders, guardOf, planSortWith, applySort, sortBy, formatSort };
