'use strict';

const fs = require('node:fs');
const path = require('node:path');
const commands = require('./commands');
const { FcError, freshPath } = commands;
const { grant, walk } = require('./target');
const { normalizeName } = require('./normalize');
const { LEFTOVER, SYSTEM_FOLDER, PROGRAM_FOLDER, PROJECT_FILE, moveWithoutOverwrite, leftoverNote, rejectRepository, looksLikeGitDir, rejectProjectAncestor } = require('./flatten');
const { DOWNLOAD_MARKER, markerFinder } = require('./downloadMarker');

// NTFS is case-insensitive, so names are compared in upper case. toLowerCase makes ΑΣ and ασ, which are the same name on NTFS, different.
const nameKey = (p) => p.toUpperCase();

function skipReason(entry) {
  const parts = entry.relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return 'Not renamed because it is a leftover from an earlier job.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Not renamed because it is inside a Windows system folder.';
  return null;
}

// A saved web page (page.html) and the folder that holds its pictures and scripts (page_files). The page finds the files inside by the folder name.
const WEB_PAGE = /^(.+)\.(?:html?|xhtml|shtml)$/i;

// It checks whether the file is being downloaded (#94). It is a name with a download tool's tail (x.mp4.crdownload), or a file that has such a marker file beside it or
// is inside a Safari marker folder (x.mp4.download). If the name changes, the download tool cannot find the file.
function downloadReason(entry, findMarker) {
  const name = path.basename(entry.path);
  const own = DOWNLOAD_MARKER.exec(name);
  if (own) return `Not renamed because it is the name of a file being downloaded (${name.slice(own[1].length)}).`;
  const found = findMarker(entry.path);
  if (found === null) return null;
  if (found.folder !== undefined) return `Not renamed because it is inside the download tool's marker folder (${found.folder}) and may still be downloading.`;
  if (found.error !== undefined) return `Not renamed because the folder could not be read to check for the download tool's marker file. (${found.error})`;
  return `Not renamed because the download tool's marker file (${found.marker}) is next to it and it may still be downloading.`;
}

// It returns the folders whose inner file names are not to be changed as { guarded: { relative path -> reason }, pages: { web page relative path -> resource folder name }, dirs } (#94). Like the #65 policy of flatten, it keeps program folders (node_modules and so on),
// folders that hold a project marker file (package.json and so on), folders that hold an executable and a DLL together, and folders with the hidden attribute. This is because a program finds files by name.
// It also keeps the _files folder of a saved web page. If the target itself or a folder above it is such a folder, every file is part of it, so it refuses (#167).
// A folder with the hidden attribute can be known only by calling PowerShell, so it is added separately with addHiddenFolders when there is a file to change (first review).
function guardedFolders(target, entries) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (PROGRAM_FOLDER.test(path.basename(dir))) throw new FcError(`Not handled because it is inside a program folder: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  // If a folder above is a project or program folder, a name inside the target may also be a name the program looks for. It refuses by the same criterion as flatten (#167).
  rejectProjectAncestor(target);
  const guarded = new Map();
  const add = (relative, reason) => {
    if (!guarded.has(relative)) guarded.set(relative, reason);
  };
  const dirs = new Map(entries.filter((entry) => entry.type === 'dir').map((entry) => [nameKey(entry.relative), entry.relative]));
  const pages = new Map();
  const programs = new Map();
  for (const entry of entries) {
    const name = path.basename(entry.relative);
    const parent = path.dirname(entry.relative);
    if (entry.type === 'dir') {
      if (PROGRAM_FOLDER.test(name)) add(entry.relative, `program folder (${name})`);
      continue;
    }
    if (entry.type !== 'file') continue;
    if (PROJECT_FILE.test(name)) {
      if (parent === '.') throw new FcError(`Not handled because the target looks like a project folder (contains ${name}). Choose a folder below it as the target: ${target}`);
      add(parent, `project folder (contains ${name})`);
    }
    const page = WEB_PAGE.exec(name);
    const files = page && dirs.get(nameKey(path.join(parent, `${page[1]}_files`)));
    if (files) {
      add(files, `resource folder of the web page (${name})`);
      pages.set(entry.relative, path.basename(files));
    }
    const ext = path.extname(name).toLowerCase();
    if (ext === '.exe' || ext === '.dll') programs.set(parent, new Set([...(programs.get(parent) ?? []), ext]));
  }
  for (const [parent, kinds] of programs) {
    if (kinds.size < 2) continue;
    if (parent === '.') throw new FcError(`Not handled because the target holds both executables and DLLs, so it is treated as a program folder. Choose a folder below it as the target: ${target}`);
    add(parent, 'program folder holding both executables and DLLs');
  }
  return { guarded, pages, dirs };
}

// It adds folders with the hidden attribute to guarded. The inside of a folder to keep is not changed anyway, so it is not looked at.
function addHiddenFolders(target, { guarded, dirs }) {
  const inside = (relative) => [...guarded.keys()].some((dir) => relative === dir || relative.startsWith(dir + path.sep));
  const folders = [''].concat([...dirs.values()].filter((relative) => !inside(relative)));
  // It is called through the module so that tests can swap it in.
  for (const [relative, bits] of commands.hiddenOrSystemEntries(target, folders)) {
    const folder = dirs.get(nameKey(relative));
    if (bits & 2 && folder !== undefined && !guarded.has(folder)) guarded.set(folder, 'folder with the hidden attribute');
  }
}

// If the relative path is inside a folder to keep, it returns the outermost such folder.
function guardOf(relative, guarded) {
  const parts = relative.split(path.sep);
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join(path.sep);
    if (guarded.has(dir)) return dir;
  }
  return null;
}

// It makes a plan to normalize the file names under the target. It does not touch files.
// - renames: files to rename ({ from, to, name, number })
// - inferred: files whose number was guessed from a lowercase word and that were not changed ({ path, name }). If includeLowercase is given, they go to renames.
// - conflicts: files not changed because the result name overlaps an existing item or another result ({ path, name, reason })
// - skipped: items that are not handled ({ path, reason })
function planNormalize(dir, { includeLowercase = false } = {}) {
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, renames: [], inferred: [], conflicts: [], skipped: [] };
  const entries = walk(access.target);
  // The ref and object names are the content, so renaming breaks the repository. A bare repository whose name is not .git is the same.
  rejectRepository(access.target, entries);
  const bare = entries.find((entry) => entry.type === 'dir' && looksLikeGitDir(entry.path));
  if (bare) throw new FcError(`Not handled because it contains a repository: ${bare.path}`);
  const existing = new Set(entries.map((entry) => nameKey(entry.path)));
  const guards = guardedFolders(access.target, entries);
  const { guarded, pages } = guards;
  let hiddenChecked = false;
  // A folder to keep is reported once, only when it has a file whose name would change. Reporting for each file of node_modules would bury the list.
  const reportedGuards = new Set();
  const findMarker = markerFinder();
  const wanted = [];
  for (const entry of entries) {
    if (entry.type === 'dir') continue;
    if (entry.type === 'link') {
      plan.skipped.push({ path: entry.path, reason: 'Links are not renamed.' });
      continue;
    }
    const reason = skipReason(entry);
    if (reason !== null) {
      plan.skipped.push({ path: entry.path, reason });
      continue;
    }
    const result = normalizeName(path.basename(entry.path));
    const changes = result.reason === null && result.name !== path.basename(entry.path);
    // When a file to change or report (several numbers and so on) first appears, it checks the hidden-attribute folders. So that the report does not differ with the order (second review).
    const reported = result.reason !== null && (result.number !== null || /Several numbers/.test(result.reason));
    let guard = guardOf(entry.relative, guarded);
    if (guard === null && (changes || reported) && !hiddenChecked) {
      hiddenChecked = true;
      addHiddenFolders(access.target, guards);
      guard = guardOf(entry.relative, guarded);
    }
    if (guard !== null) {
      if (changes && !reportedGuards.has(guard)) {
        reportedGuards.add(guard);
        plan.skipped.push({ path: path.join(access.target, guard), reason: `Names inside are not changed because the folder is a ${guarded.get(guard)}.` });
      }
      continue;
    }
    const pageFiles = pages.get(entry.relative);
    if (changes && pageFiles !== undefined) {
      plan.skipped.push({ path: entry.path, reason: `Not renamed because it is a web page linked by name to the resource folder (${pageFiles}).` });
      continue;
    }
    const downloading = changes ? downloadReason(entry, findMarker) : null;
    if (downloading !== null) {
      plan.skipped.push({ path: entry.path, reason: downloading });
      continue;
    }
    if (result.reason !== null) {
      // Reporting even hidden and temporary files and names ending in a dot or a space would bury the list. It reports only cases with several numbers or where the name gets too long.
      if (reported) plan.skipped.push({ path: entry.path, reason: result.reason });
      continue;
    }
    if (result.name === path.basename(entry.path)) continue;
    if (result.inferred && !includeLowercase) {
      plan.inferred.push({ path: entry.path, name: result.name });
      continue;
    }
    wanted.push({ entry, result });
  }

  // If the results overlap, it cannot decide which one to keep, so it changes none of them.
  const targets = new Map();
  for (const item of wanted) {
    const key = nameKey(path.join(path.dirname(item.entry.path), item.result.name));
    targets.set(key, (targets.get(key) ?? 0) + 1);
  }
  for (const { entry, result } of wanted) {
    const to = path.join(path.dirname(entry.path), result.name);
    const key = nameKey(to);
    const conflict = (reason) => plan.conflicts.push({ path: entry.path, name: result.name, reason });
    if (targets.get(key) > 1) {
      conflict('Another file would get the same name.');
    } else if (key !== nameKey(entry.path) && existing.has(key)) {
      // If it is a trace of an earlier run that stopped midway (another name of the same file, an empty file), it adds that fact (#73).
      conflict(`The name already exists.${leftoverNote(entry.path, to)}`);
    } else {
      try {
        const from = access.read(entry.path);
        // If only the case changes, access.write returns the real spelling of the current file, so it writes the new name onto the source folder.
        const dest = key === nameKey(entry.path) ? path.join(path.dirname(from), result.name) : access.write(to);
        // If it overlaps with the 8.3 short name of another file, access.write returns the long path of that file.
        if (nameKey(path.basename(dest)) !== nameKey(result.name)) conflict('The name already exists.');
        else plan.renames.push({ from, to: dest, name: result.name, number: result.number });
      } catch (err) {
        if (!(err instanceof FcError)) throw err;
        plan.skipped.push({ path: entry.path, reason: err.message });
      }
    }
  }
  return plan;
}

// For a name that changes only in case, the target is caught as the file itself and the move that does not overwrite fails. It goes through a temporary name.
// While it was moved to the temporary name, another program may create a file under that name. So that it does not overwrite that file, the move back also does not overwrite.
function renameCaseOnly(from, to, name) {
  const middle = freshPath(from, '.fctl-new');
  fs.renameSync(from, middle);
  let cause;
  try {
    // Opening a broken junction with wx would create a folder outside the target that the junction points to, so it looks first.
    if (!fs.lstatSync(to, { throwIfNoEntry: false }) && moveWithoutOverwrite(middle, to)) return;
    cause = new FcError(`Not renamed because the name already exists: ${name}`);
  } catch (err) {
    cause = err;
  }
  restoreCaseOnly(middle, from, cause);
  throw cause;
}

function restoreCaseOnly(middle, from, cause) {
  let restored = false;
  let reason = 'EEXIST';
  try {
    if (!fs.lstatSync(from, { throwIfNoEntry: false })) restored = moveWithoutOverwrite(middle, from);
  } catch (err) {
    reason = err.code ?? err.message;
  }
  if (!restored) throw new FcError(`Could not rename and could not restore it either. The file is at ${middle}. (${cause.code ?? cause.message}, ${reason})`);
}

// If the source was replaced by a link or the name got filled between the plan and the run, it does not change it. It does not overwrite.
function applyRename(rename, access) {
  const from = access.delete(rename.from);
  if (from !== rename.from) throw new FcError(`The path changed after planning: ${rename.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`No longer a file after planning: ${from}`);
  if (nameKey(rename.from) === nameKey(rename.to)) {
    renameCaseOnly(from, rename.to, rename.name);
    return;
  }
  const taken = () => new FcError(`Not renamed because the name already exists: ${rename.name}${leftoverNote(from, rename.to)}`);
  // It does not touch an existing item. Opening a broken junction with wx would create a folder outside the target that the junction points to.
  if (fs.lstatSync(rename.to, { throwIfNoEntry: false })) throw taken();
  const to = access.write(rename.to);
  if (to !== rename.to) throw new FcError(`The path changed after planning: ${rename.to} -> ${to}`);
  if (!moveWithoutOverwrite(from, to)) throw taken();
}

// It normalizes the file names under the target. It does not overwrite, and even if one file fails, it continues with the rest.
// The returned value is { target, dryRun, renamed, inferred, conflicts, skipped, failed }. failed is a list of { from, reason }.
function normalizeFiles(dir, { dryRun = false, includeLowercase = false } = {}) {
  return applyNormalize(planNormalize(dir, { includeLowercase }), { dryRun });
}

function applyNormalize(plan, { dryRun = false } = {}) {
  const { renames, target, ...rest } = plan;
  const result = { target, dryRun, renamed: [], ...rest, failed: [] };
  if (dryRun) return { ...result, renamed: renames };
  const access = grant(target, ['write', 'delete']);
  for (const rename of renames) {
    try {
      applyRename(rename, access);
      result.renamed.push(rename);
    } catch (err) {
      result.failed.push({ from: rename.from, reason: err instanceof FcError ? err.message : `Could not rename. (${err.code})` });
    }
  }
  return result;
}

function formatNormalize(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [];
  for (const item of result.renamed) lines.push(`${prefix}Rename: ${relative(item.from)} -> ${item.name}`);
  for (const item of result.inferred) lines.push(`${prefix}Left as is because it is a lowercase word: ${relative(item.path)} -> ${item.name}`);
  for (const item of result.conflicts) lines.push(`${prefix}Name conflict: ${relative(item.path)} -> ${item.name} (${item.reason})`);
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.from)} (${item.reason})`);
  lines.push(
    `${prefix}Rename ${result.renamed.length}, lowercase words ${result.inferred.length}, conflicts ${result.conflicts.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`,
  );
  return lines.join('\n');
}

module.exports = { planNormalize, applyNormalize, normalizeFiles, formatNormalize };
