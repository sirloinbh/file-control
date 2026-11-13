'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { BARE_DEVICE_NAME, deviceNamePart, isDeviceName } = require('./windowsNames');

const isWindows = process.platform === 'win32';
// Instead of the GNU tar that comes with Git Bash and the like, it uses the Windows default bsdtar, which can handle zip.
const TAR = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

class FcError extends Error {}

function exists(p) {
  return fs.existsSync(p);
}

function ensureExists(p) {
  if (!exists(p)) throw new FcError(`Path does not exist: ${p}`);
}

function ensureFree(p, force) {
  if (exists(p) && !force) throw new FcError(`Already exists: ${p} (use --force to overwrite)`);
}

// Node creates names such as nul.mp4 and con.txt literally, but PowerShell and Explorer open them as devices, so the created file cannot be opened or deleted by other programs (#135).
// It leaves existing items so that they can be brought out by renaming, and refuses only names it newly creates. It does not examine an existing folder above (such as Con.Air).
// The judgment uses the same rule as grant (windowsNames.js).
function rejectNewDeviceName(p) {
  if (!isWindows) return;
  let existing = path.resolve(p);
  const created = [];
  while (!exists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    created.unshift(path.basename(existing));
    existing = parent;
  }
  const part = created.find((name) => isDeviceName(name));
  if (part !== undefined) throw new FcError(`Not created because Windows opens this name as a device: ${JSON.stringify(part)} (${p})`);
}

// Changing the content of a hard link (link count 2 or more) also changes the other names of the same file. The other name may be outside the target, so it does not write content (#48).
// Things that only delete or rename (rm, the replacement of mv --force, unzip changing an existing file) leave the content under the other name as it is, so they are not blocked.
// On build 26200, with write --force, appending content, and merging folders with cp --force, the content under the other name changed,
// while cp --force on a single file, mv --force, and unzip did not change it. cp writes in place on Linux, so it blocks even a single file.
function rejectHardLinkedWrite(p) {
  const stat = fs.statSync(p, { throwIfNoEntry: false });
  if (stat && stat.isFile() && stat.nlink > 1) {
    throw new FcError(`Not written because changing the content of a hard link would also change ${stat.nlink - 1} other name(s) of the same file: ${p}. Delete it first or write to another name.`);
  }
}

// If any file that cp --force would overwrite is a hard link, it refuses before copying anything. Folders are merged, so it looks at the files inside too.
// When merging folders, if the kinds mismatch inside, fs.cpSync either ends Node without an error (a file where a folder is, a file where a junction is) or copies part and then
// fails (a folder where a file is), and it writes outside by following a junction inside the target (#140, confirmed on build 26200 and Node 24.21). So it finds all of them and refuses before copying.
// It looks while descending the source and the target together, but does not enter links. cpSync copies a link in the source as a link.
// If hardLinks is false, it does not check hard links. It is used when an earlier source of the same name is seen as the target (because that file will be newly copied).
function checkOverwrite(src, target, { hardLinks = true } = {}) {
  const there = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!there) return;
  const here = fs.lstatSync(src);
  if (there.isSymbolicLink()) throw new FcError(`The destination to overwrite is a link, so this could write to where the link points. Nothing was copied: ${target}`);
  if (here.isSymbolicLink()) throw new FcError(`Cannot copy a source link over an existing item. Nothing was copied: ${src} -> ${target}`);
  if (here.isDirectory() !== there.isDirectory()) throw new FcError(`A file and a folder cannot overwrite each other: ${src} -> ${target}`);
  if (!here.isDirectory()) {
    if (hardLinks) rejectHardLinkedWrite(target);
    return;
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(target, entry.name);
    const stat = fs.lstatSync(to, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new FcError(`The folder to merge into contains a link, so this could write to where the link points. Nothing was copied: ${to}`);
    if (entry.isSymbolicLink()) throw new FcError(`A source link sits where an item already exists in the folder to merge, so it cannot be overwritten. Nothing was copied: ${from} -> ${to}`);
    if (entry.isDirectory() !== stat.isDirectory()) {
      throw new FcError(`A file and a folder do not match inside the folder to merge, so it cannot be overwritten. Nothing was copied: ${from} -> ${to}`);
    }
    if (entry.isDirectory()) checkOverwrite(from, to, { hardLinks });
    else if (hardLinks) rejectHardLinkedWrite(to);
  }
}

// A path that holds exactly a device name (nul, CON) opens a device when tar.exe receives it as an argument, and the Recycle Bin move fails (#135).
// On build 26200 it was confirmed that the Recycle Bin move also fails for a file inside such a folder (CON\a.txt), so it looks at every name in the path.
function bareDeviceName(p) {
  return deviceNamePart(p, BARE_DEVICE_NAME);
}

function rejectBareDeviceArgs(paths, what) {
  const found = paths.find((p) => bareDeviceName(p) !== undefined);
  if (found !== undefined) throw new FcError(`A path containing the device name (${JSON.stringify(bareDeviceName(found))}) ${what}: ${found}. Rename it with fctl rename and run again.`);
}

// In a preview, it does not run the work and only tells what would be done. Every changing command goes through this function.
function perform(message, dryRun, action) {
  if (dryRun) return `[Preview] ${message}`;
  action();
  return message;
}

function overwriteNote(p, dryRun) {
  return dryRun && exists(p) ? ' (overwrites)' : '';
}

function pathKey(p) {
  const full = path.resolve(p);
  return isWindows ? full.toLowerCase() : full;
}

function isSameOrUnder(parentKey, key) {
  return key === parentKey || key.startsWith(parentKey.endsWith(path.sep) ? parentKey : parentKey + path.sep);
}

// To find in the preview too the case that fails after an earlier item is handled in a real run, it remembers the paths already handled.
// If the earlier item is a folder, the paths inside it are handled and disappear together, so it counts as an overlap.
function claim(planned, p) {
  const key = pathKey(p);
  for (const earlier of planned) {
    if (isSameOrUnder(earlier, key)) throw new FcError(`Overlaps an earlier item: ${p} (a real run would fail after handling the earlier item)`);
  }
  planned.add(key);
}

// For the preview: it finds items that gather into the same target and targets that already exist, and returns the text to show.
function targetNote(planned, target, force, dirNote) {
  const key = pathKey(target);
  if (planned.has(key)) {
    if (!force) throw new FcError(`Already exists: ${target} (an earlier item is handled under the same name)`);
    return ' (overwrites: earlier item)';
  }
  planned.add(key);
  if (!exists(target)) return '';
  return fs.statSync(target).isDirectory() ? dirNote : ' (overwrites)';
}

// For the preview: moving or copying a folder into itself, or a file onto itself, fails in a real run.
function ensureNotIntoSelf(src, target) {
  if (isSameOrUnder(pathKey(src), pathKey(target))) throw new FcError(`Cannot move or copy onto itself or into itself: ${src} -> ${target}`);
}

// Preview check: if a file exists on the folder path to be created, it fails in a real run.
function ensureCanMakeDir(dir) {
  let current = path.resolve(dir);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new FcError(`Path does not exist: ${current}`);
    current = parent;
  }
  if (!fs.statSync(current).isDirectory()) throw new FcError(`Cannot create below a file: ${dir} (${current})`);
}

// Preview check: for commands that do not create the parent folder (mv, zip), the parent must exist.
function ensureParentDir(p) {
  const parent = path.dirname(path.resolve(p));
  if (!exists(parent) || !fs.statSync(parent).isDirectory()) throw new FcError(`The parent folder of the destination does not exist: ${parent}`);
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${i === 0 ? size : size.toFixed(1)}${units[i]}`;
}

function list(dir = '.') {
  ensureExists(dir);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dir, entry.name);
      // Locked system files (C:\DumpStack.log.tmp, pagefile.sys) cannot have their information read (EPERM, EBUSY). It does not fail the whole list and only blanks the size and time (#254).
      let stat;
      try {
        stat = fs.statSync(full, { throwIfNoEntry: false });
      } catch {
        stat = undefined;
      }
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: stat && !entry.isDirectory() ? stat.size : null,
        modified: stat ? stat.mtime : null,
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

function makeDir(dir, { dryRun = false } = {}) {
  rejectNewDeviceName(dir);
  if (dryRun) ensureCanMakeDir(dir);
  const note = dryRun && exists(dir) ? ' (already exists)' : '';
  return perform(`Create folder: ${dir}${note}`, dryRun, () => fs.mkdirSync(dir, { recursive: true }));
}

function writeFile(file, content, { append = false, force = false, dryRun = false } = {}) {
  if (!append) ensureFree(file, force);
  rejectNewDeviceName(file);
  rejectHardLinkedWrite(file);
  if (dryRun) {
    ensureCanMakeDir(path.dirname(file));
    if (exists(file) && fs.statSync(file).isDirectory()) throw new FcError(`Cannot write to a folder: ${file}`);
  }
  const note = append ? '' : overwriteNote(file, dryRun);
  return perform(`${append ? 'Append to file' : 'Write file'}: ${file}${note}`, dryRun, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (append) fs.appendFileSync(file, content);
    else fs.writeFileSync(file, content);
  });
}

function readFile(file) {
  ensureExists(file);
  return fs.readFileSync(file, 'utf8');
}

function rename(target, newName, { force = false, dryRun = false } = {}) {
  ensureExists(target);
  if (newName.includes('/') || newName.includes('\\')) {
    throw new FcError('The new name cannot contain a path. Use mv to move.');
  }
  const dest = path.join(path.dirname(target), newName);
  ensureFree(dest, force);
  rejectNewDeviceName(dest);
  // Changing only the case of itself is not an overwrite.
  if (dryRun && pathKey(dest) !== pathKey(target) && exists(dest) && fs.statSync(dest).isDirectory()) throw new FcError(`Cannot overwrite a folder: ${dest}`);
  return perform(`Rename: ${target} -> ${dest}${overwriteNote(dest, dryRun)}`, dryRun, () => fs.renameSync(target, dest));
}

function moveOne(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // When moving to another drive, rename does not work, so it deletes the original after copying.
    if (err.code !== 'EXDEV') throw err;
    // Because it moves by copying, it first refuses links that never end, the same as cp (#142). Nothing was copied, so the source and the target stay as they were.
    rejectLoopingLinks(src, dest);
    try {
      fs.cpSync(src, dest, { recursive: true });
    } catch (copyErr) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw copyErr;
    }
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// It does not use the target name, so that it does not hit the name length limit, and it picks a free name so that it does not overwrite an existing item.
function freshPath(target, prefix, ext = '') {
  const dir = path.dirname(path.resolve(target));
  let serial = 0;
  let fresh;
  do {
    fresh = path.join(dir, `${prefix}-${process.pid}-${Date.now()}-${serial++}${ext}`);
  } while (fs.lstatSync(fresh, { throwIfNoEntry: false }));
  return fresh;
}

function asidePath(target) {
  return freshPath(target, '.fctl-old');
}

// If the target is deleted first and the move fails (a file lock and so on), the target is lost, so it sets it aside and deletes it after the move finishes.
function moveReplacing(src, target) {
  if (!exists(target)) return moveOne(src, target);
  const aside = asidePath(target);
  fs.renameSync(target, aside);
  try {
    moveOne(src, target);
  } catch (err) {
    // If the copy finished and the target exists, only the cleanup of the source failed, so it does not roll back.
    if (exists(target)) throw new FcError(`Moved, but the source could not be fully deleted: ${src} (${err.code}). The previous destination is at ${aside}.`);
    try {
      fs.renameSync(aside, target);
    } catch (restoreErr) {
      throw new FcError(`Could not move, and could not restore the previous destination either: ${src} (${err.code}, ${restoreErr.code}). The previous destination is at ${aside}.`);
    }
    throw err;
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true });
  } catch (err) {
    throw new FcError(`Moved, but could not delete the previous destination: ${aside} (${err.code})`);
  }
}

// For a path that does not exist, it goes up to the parent that exists and gets the real path. Any other error makes it impossible to judge overlap, so it refuses.
function realKey(p) {
  const full = path.resolve(p);
  try {
    return pathKey(fs.realpathSync.native(full));
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new FcError(`Cannot check the real path: ${full} (${err.code})`);
    const parent = path.dirname(full);
    return parent === full ? pathKey(full) : pathKey(path.join(realKey(parent), path.basename(full)));
  }
}

// A key that points to the item itself that is deleted or moved. A link is seen as the link itself, not the place it points to.
function entryKey(p) {
  const full = path.resolve(p);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return pathKey(path.join(realKey(path.dirname(full)), path.basename(full)));
  return realKey(full);
}

// It compares by volume and file ID so that it also catches aliases such as \\localhost\C$ that look different as real paths.
function isSameFile(a, b) {
  const statA = fs.statSync(a, { bigint: true, throwIfNoEntry: false });
  const statB = fs.statSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(statA && statB) && statA.ino !== 0n && statA.dev === statB.dev && statA.ino === statB.ino;
}

// It checks by file ID whether one of the parent folders of p is the same folder as dir.
function hasAncestorSameAs(dir, p) {
  let current = path.resolve(p);
  for (let parent = path.dirname(current); parent !== current; parent = path.dirname(current)) {
    current = parent;
    if (isSameFile(dir, current)) return true;
  }
  return false;
}

// If a link inside the source folder points to a place that overlaps the source or the target, it refuses before copying anything (#142).
// fs.cpSync on Windows follows a junction and copies the content inside it (a folder symbolic link is copied as a link, confirmed on build 26200 and Node 24.21).
// So with a junction that points to the source itself or a folder above it, or to the target or a folder above it, the copy never ends, the path keeps getting longer, and Node ends without an error.
// A link that points inside the target is also refused, because what is read changes while copying. Node cannot tell a junction from a folder symbolic link, so it looks at both.
// Like cpSync, it walks following links and looks for a link that points to a folder it already passed (including a parent folder inside the source, and a folder beyond a junction and its real parent folders) (first review).
// src/a/b/up -> src/a, src/out -> X with X/self -> X, and src/out -> X with X/back -> src are all loops.
// It compares by the folder's file ID instead of the path text. A source given by a UNC alias (\\localhost\C$) can also be matched against the junction's real path.
// A folder that was walked once is not walked again. Broken links and file links have no folder to follow, so it does not look at them.
function rejectLoopingLinks(src, target) {
  const here = fs.lstatSync(src, { throwIfNoEntry: false });
  if (!here || !here.isDirectory()) return;
  // Identification value of a folder on the path being walked now -> the number of overlaps
  const onPath = new Map();
  const add = (ids) => ids.forEach((id) => onPath.set(id, (onPath.get(id) ?? 0) + 1));
  const drop = (ids) => ids.forEach((id) => (onPath.get(id) === 1 ? onPath.delete(id) : onPath.set(id, onPath.get(id) - 1)));
  const destId = dirId(target);
  add(selfAndAncestorIds(target));
  add(selfAndAncestorIds(src));
  add(selfAndAncestorIds(fs.realpathSync.native(src)));
  const walked = new Set([dirId(src)]);
  const walkDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new FcError(`Cannot read a folder inside the source, so it could not be confirmed that the copy will finish. Nothing was copied: ${dir} (${err.code})`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const link = entry.isSymbolicLink();
      let ids;
      if (link) {
        let real;
        try {
          real = fs.realpathSync.native(full);
        } catch {
          continue;
        }
        const id = dirId(real);
        if (id === null) continue;
        const reached = selfAndAncestorIds(real);
        if (onPath.has(id) || (destId !== null && reached.includes(destId))) {
          throw new FcError(`A link inside the source points to the source, the destination, or a folder above them, so the copy might never finish. Nothing was copied: ${full} -> ${real}`);
        }
        if (walked.has(id)) continue;
        walked.add(id);
        ids = reached;
      } else {
        const id = dirId(full);
        if (id === null || walked.has(id)) continue;
        walked.add(id);
        ids = [id];
      }
      add(ids);
      walkDir(full);
      drop(ids);
    }
  };
  walkDir(path.resolve(src));
}

// The identification value of a folder (volume and file ID). It follows links. If it is not a folder or does not exist, it is null.
function dirId(p) {
  try {
    const stat = fs.statSync(p, { bigint: true, throwIfNoEntry: false });
    return stat && stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

// The identification values of p itself and the folders above it. For a path that does not exist, it counts from the parent folder that exists.
function selfAndAncestorIds(p) {
  const ids = [];
  for (let current = path.resolve(p); ; current = path.dirname(current)) {
    const id = dirId(current);
    if (id !== null) ids.push(id);
    if (path.dirname(current) === current) break;
  }
  return ids;
}

// A UNC alias is not revealed as a real path and looks like another drive, so if copying a folder into itself starts, it never ends.
// A link moves or copies only the link itself, so it is not judged by what it points to.
function rejectCopyIntoSelf(src, target) {
  if (!fs.lstatSync(src).isSymbolicLink() && hasAncestorSameAs(src, target)) throw new FcError(`Cannot move or copy into itself: ${src} -> ${target}`);
}

// A Windows alternate data stream (a.txt:st) is part of the file, so when the target file is cleared, the source moves along with it.
function rejectStreamPath(p) {
  if (!isWindows) return;
  const full = path.resolve(p);
  if (full.slice(path.parse(full).root.length).includes(':')) throw new FcError(`Alternate data streams are not supported: ${p}`);
}

// The current folder or a folder above it cannot be moved or cleared, so it fails or is only partly handled.
function rejectCurrentDir(p) {
  if (isSameOrUnder(realKey(p), realKey(process.cwd()))) throw new FcError(`Cannot move the current folder or its parents: ${p}`);
}

// If the target and the source overlap, clearing the target also moves the source along, or moving the source ruins the target.
// It compares by real path so that the same item is caught even through an 8.3 name, case, or a junction.
function rejectMoveOverlap(src, target) {
  const srcKey = entryKey(src);
  const targetKey = entryKey(target);
  const stat = fs.statSync(src, { bigint: true, throwIfNoEntry: false });
  // Hard links to each other are different items even with the same file ID, so moving them does not lose content.
  if (srcKey === targetKey || (exists(target) && isSameFile(src, target) && stat.nlink === 1n)) throw new FcError(`The source and destination are the same: ${src} -> ${target}`);
  if (isSameOrUnder(srcKey, targetKey)) throw new FcError(`Cannot move into itself: ${src} -> ${target}`);
  rejectCopyIntoSelf(src, target);
  const targetIsLink = exists(target) && fs.lstatSync(target).isSymbolicLink();
  if (isSameOrUnder(targetKey, srcKey) || (exists(target) && !targetIsLink && hasAncestorSameAs(target, src))) throw new FcError(`Cannot move because the destination contains the source: ${src} -> ${target}`);
  // If a link is moved onto the place it points to, the moment the target is deleted, the content the link pointed to disappears.
  if (fs.lstatSync(src).isSymbolicLink() && isSameOrUnder(targetKey, realKey(src))) throw new FcError(`Cannot overwrite where the link points: ${src} -> ${target}`);
}

// It finds, before moving anything, the combinations where a later item is ruined after an earlier item is handled.
function rejectBatchOverlap(items) {
  const keys = items.map(({ src, target }) => ({ src: entryKey(src), target: entryKey(target) }));
  keys.forEach((a, i) => {
    keys.forEach((b, j) => {
      if (i === j) return;
      const pair = `${items[i].src}, ${items[j].src}`;
      if (a.target === b.target) throw new FcError(`Several sources go to the same destination: ${items[i].target} (${pair})`);
      if (isSameOrUnder(a.target, b.src)) throw new FcError(`The destination of one item overlaps the source of another: ${pair}`);
      if (i < j && (isSameOrUnder(a.src, b.src) || isSameOrUnder(a.src, b.target))) throw new FcError(`Moving an earlier item would remove a later item: ${pair}`);
    });
  });
}

// If dest is an existing folder, it moves inside it; otherwise it moves under the name dest.
function resolveDest(src, dest) {
  return exists(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, path.basename(src)) : dest;
}

function move(sources, dest, { force = false, dryRun = false } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`To move several items, the destination must be an existing folder: ${dest}`);
  }
  // It runs after checking everything, so that if it fails, nothing has been moved.
  const items = sources.map((src) => {
    ensureExists(src);
    rejectStreamPath(src);
    rejectCurrentDir(src);
    // It resolves the names so that a source ending in d/. uses the same target as d.
    const target = resolveDest(path.resolve(src), dest);
    rejectStreamPath(target);
    rejectCurrentDir(target);
    ensureFree(target, force);
    rejectNewDeviceName(target);
    ensureParentDir(target);
    rejectMoveOverlap(src, target);
    return { src, target };
  });
  rejectBatchOverlap(items);
  const planned = new Set();
  const done = [];
  for (const { src, target } of items) {
    const note = dryRun ? targetNote(planned, target, force, ' (replaces the whole existing folder)') : '';
    try {
      done.push(perform(`Move: ${src} -> ${target}${note}`, dryRun, () => moveReplacing(src, target)));
    } catch (err) {
      // The earlier items have already been moved, so just raising an error would not tell what was moved.
      if (done.length === 0) throw err;
      throw new FcError(`${err.message}\nItems already handled:\n${done.join('\n')}`);
    }
  }
  return done;
}

function copy(sources, dest, { force = false, dryRun = false } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`To copy several items, the destination must be an existing folder: ${dest}`);
  }
  // For overwriting and merging (which happen only with --force), it first looks at everything so that nothing is copied even if only one of several sources has a problem (#48, #140).
  // Sources that gather into the same target are also merged with the target after an earlier source was copied, so it also checks while seeing the earlier source as the target.
  if (force) {
    const earlier = new Map();
    for (const src of sources) {
      ensureExists(src);
      const target = resolveDest(src, dest);
      checkOverwrite(src, target);
      const key = pathKey(target);
      for (const before of earlier.get(key) ?? []) {
        if (pathKey(before) !== pathKey(src)) checkOverwrite(src, before, { hardLinks: false });
      }
      earlier.set(key, [...(earlier.get(key) ?? []), src]);
    }
  }
  // When copying never ends because of a link inside a source (#142), nothing is copied, even in the preview and even if only one of several sources is like that.
  for (const src of sources) {
    ensureExists(src);
    rejectLoopingLinks(src, resolveDest(src, dest));
  }
  const planned = new Set();
  return sources.map((src) => {
    ensureExists(src);
    const target = resolveDest(src, dest);
    ensureFree(target, force);
    rejectNewDeviceName(target);
    rejectCopyIntoSelf(src, target);
    let note = '';
    if (dryRun) {
      ensureCanMakeDir(path.dirname(target));
      ensureNotIntoSelf(src, target);
      if (exists(target) && fs.statSync(src).isDirectory() !== fs.statSync(target).isDirectory()) {
        throw new FcError(`A file and a folder cannot overwrite each other: ${src} -> ${target}`);
      }
      note = targetNote(planned, target, force, ' (merged into the folder, files with the same name are overwritten)');
    }
    return perform(`Copy: ${src} -> ${target}${note}`, dryRun, () => fs.cpSync(src, target, { recursive: true, force }));
  });
}

// Among the items directly inside the folders given under the target, it returns, as a Map of { relative path from the target -> attribute bits }, those that have the hidden (2) or system (4) attribute (#65).
// Node cannot read file attributes, so it calls PowerShell once. Which folders to look at is the folder list that walk decided (relative paths, '' for the target itself).
// If PowerShell recursed on its own, the judgment would split on folders that have the ReparsePoint attribute but are not links, such as the OneDrive folder (first review).
// Names are passed through stdin and stdout as UTF-16 converted to base64, so that they are exchanged regardless of the code page. It uses a \\?\ path so that it reads even past 260 characters.
// If even one folder cannot be read, it raises an error so that it does not proceed with only a partial view. If it is not Windows, it is an empty Map.
// It strips the trailing separator so that a path that keeps a trailing separator, such as a drive root (Q:\), does not get its relative path cut (first review).
function hiddenOrSystemEntries(dir, folders = ['']) {
  if (!isWindows) return new Map();
  const full = path.resolve(dir).replace(/[\\/]+$/, '');
  const root = full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
  const script =
    "$ErrorActionPreference = 'Stop'; try { $root = $env:FC_ROOT; $u = [Text.Encoding]::Unicode; " +
    'foreach ($line in $input) { if (-not $line) { continue }; $rel = $u.GetString([Convert]::FromBase64String($line)); if ($rel -eq ".") { $rel = "" }; ' +
    'foreach ($e in [IO.DirectoryInfo]::new($root + "\\" + $rel).EnumerateFileSystemInfos()) { $a = [int]$e.Attributes -band 6; ' +
    'if ($a) { $name = if ($rel) { $rel + "\\" + $e.Name } else { $e.Name }; "$a " + [Convert]::ToBase64String($u.GetBytes($name)) } } } } catch { exit 3 }';
  // An empty relative path becomes an empty line, so the target itself is passed as '.'. A real folder name cannot be '.'.
  const input = folders.map((folder) => Buffer.from(folder === '' ? '.' : folder, 'utf16le').toString('base64')).join('\n') + '\n';
  let output;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_ROOT: root },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    throw new FcError(`Cannot check hidden and system attributes: ${full} (${err.code ?? err.status})`);
  }
  const found = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([246]) ([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (match) found.set(Buffer.from(match[2], 'base64').toString('utf16le'), Number(match[1]));
  }
  return found;
}

// The limit of the path length that the Recycle Bin move (Microsoft.VisualBasic DeleteFile) accepts. If it exceeds MAX_PATH (260, including the trailing NUL),
// it always fails whether the file name is Korean or English (confirmed in #101). The length is the number of UTF-16 characters.
const MAX_RECYCLE_PATH = 259;

// There is no time limit on the Recycle Bin move (#97). A locked file and a folder that holds a locked file failed within 1 to 2 seconds without a dialog
// (build 26200, checked in an interactive session), and the Recycle Bin move takes time in proportion to the number of files even on the same volume (15 to 25 seconds for a 50,000-file folder).
// When PowerShell was ended midway, some files in the folder were left in neither the original place nor the Recycle Bin (measured in the first review).

// It finds a file, inside a file or folder, that another program opened while blocking writes and deletes (#97). Opening such a file for writing gives EBUSY.
// It is called only to report the reason when the Recycle Bin move failed. If there are many items (files and folders), it stops reading after limit of them.
// It does not follow links or junctions. A read-only file gives EPERM, so it is not seen as in use, and opening it alone does not change the content.
const MAX_BUSY_PROBE = 10000;
function busyInside(target, limit = MAX_BUSY_PROBE) {
  const busy = (file) => {
    try {
      fs.closeSync(fs.openSync(file, 'r+'));
      return false;
    } catch (err) {
      return err.code === 'EBUSY';
    }
  };
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile()) return busy(target) ? path.basename(target) : undefined;
    if (!stat.isDirectory()) return undefined;
    const stack = [target];
    let seen = 0;
    while (stack.length > 0 && seen < limit) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && busy(full)) return path.relative(target, full);
        if (++seen >= limit) break;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// It returns the path to pass to the Recycle Bin move. If it is certain that it cannot be sent, it refuses and states the reason (#129).
// rm checks everything with this before the preview and before running on several targets, so that the preview and the real result are the same and it does not stop after deleting only part.
// - \\?\D:\... prefix: the Recycle Bin move cannot accept this form and always fails. It strips the prefix only when it still points to the same file after stripping.
//   If the prefixed path Node normalized differs from the stripped path (\\?\C:\x\..\..\y and so on), it refuses. Other forms such as \\?\UNC\ and \\.\ are also refused.
//   remove refuses device names first with rejectBareDeviceArgs.
// - A path that holds a name ending in a dot or a space: refused with or without the prefix (first review). Node sees the literal dot.,
//   but the Recycle Bin move (PowerShell 5.1) opens dot with the trailing dot and space removed, so if a dot is beside it, it sent that file to the Recycle Bin (measured).
// - A path longer than 259 characters (MAX_RECYCLE_PATH)
function recycleTarget(target) {
  let plain = target;
  const prefixed = /^[\\/]{2}[?.][\\/]/.test(target);
  if (prefixed) {
    const drive = /^[\\/]{2}\?[\\/]([A-Za-z]:[\\/].*)$/s.exec(target);
    if (!drive) throw new FcError(`A path of this form cannot be sent to the Recycle Bin: ${target}. Specify it again as a drive-letter path (D:\\...).`);
    plain = drive[1];
    if (path.resolve(target).toUpperCase() !== `\\\\?\\${path.resolve(plain)}`.toUpperCase()) {
      throw new FcError(`Removing the \\\\?\\ prefix would point somewhere else, so it cannot be sent to the Recycle Bin: ${target}. Specify it again as a path without . or ..`);
    }
  }
  const full = path.resolve(plain);
  const odd = full.split(path.sep).slice(1).find((part) => /[. ]$/.test(part));
  if (odd !== undefined) {
    // For a UNC path (\\server\share), the \\?\UNC\server\share form is the prefixed path (second review).
    const long = full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
    const how = prefixed ? '' : ` To rename it, give fctl rename the \\\\?\\ prefixed path (${long}).`;
    throw new FcError(`It cannot be sent to the Recycle Bin because of a name ending with a dot or space (${odd}). Sending to the Recycle Bin points to another name with the trailing dot or space removed.${how || ' Give fctl rename this prefixed path, rename it, and delete again.'} To skip the Recycle Bin, use --permanent: ${target}`);
  }
  if (full.length > MAX_RECYCLE_PATH) throw new FcError(`The path is ${full.length} characters, so it cannot be sent to the Recycle Bin (up to ${MAX_RECYCLE_PATH}): ${full}`);
  return full;
}

function moveToRecycleBin(target, { permanentHint = false } = {}) {
  const full = recycleTarget(target);
  // In a non-interactive run (a service, a scheduled task), this API deletes permanently without going through the Recycle Bin, so it refuses.
  // On failure, it sends the reason text Windows gave as UTF-16 base64 and ends with 77. stderr comes out in the code page and Korean is garbled (#97).
  // The HResult of the exception comes out as 0x800736B7 for both locked files and folders and cannot separate the reasons, so it is not used.
  // Right before deleting, inside PowerShell, it looks at the volume's Recycle Bin setting and the size, and if it would be deleted permanently, it does not delete and ends with 78 (#81).
  // The path is passed in an environment variable to avoid quoting problems.
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], {
      env: { ...process.env, FC_TARGET: full },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // PowerShell's stderr comes out in the code page and Korean is garbled, so the cases are separated by exit code, and for 77 the reason text is received on stdout (UTF-16 base64).
    if (err.status === 75) throw new FcError('Cannot send to the Recycle Bin outside an interactive session.');
    if (err.status === 78) throw new FcError(permanentRefusal(full, refusalReason(decodeReason(err.stdout)), permanentHint));
    // If a folder holds an item that is exactly a device name, the Recycle Bin move fails for the whole folder (#135). It is searched for only on failure and reported as the reason.
    const inside = bareDeviceInside(full);
    if (inside !== undefined) throw new FcError(`Could not send to the Recycle Bin. It may have failed because of an item with a device name inside (${inside}): ${full}. Rename that item with fctl rename and delete again.`);
    const found = oddNameInside(full);
    if (found !== undefined) {
      // What to change is the first component that ends in a dot or a space (for dot./a.txt, dot.).
      const parts = found.split(path.sep);
      const odd = parts.slice(0, parts.findIndex((part) => /[. ]$/.test(part)) + 1).join(path.sep);
      const inner = path.join(full, odd);
      const long = inner.startsWith('\\\\') ? `\\\\?\\UNC\\${inner.slice(2)}` : `\\\\?\\${inner}`;
      throw new FcError(`Could not send to the Recycle Bin. A name ending with a dot or space inside (${odd}) made the whole folder fail: ${full}. Give fctl rename the \\\\?\\ prefixed path (${long}), rename it, and delete again.`);
    }
    if (err.status === 77) throw new FcError(recycleFailureMessage(full, decodeReason(err.stdout)));
    // For a failure whose reason is unknown, it throws the original error as it is, so that the caller can add context (extracted but... and so on).
    // However, it is changed so that the full command and a message that contains garbled stderr are not shown (#97).
    err.message = `Could not send to the Recycle Bin: ${full} (PowerShell exit code ${err.status ?? err.code})`;
    throw err;
  }
}

// The message to report when the Recycle Bin move failed with a Windows reason. If a file in use exists, its name is attached (#97).
function recycleFailureMessage(full, reason) {
  const busy = busyInside(full);
  const isDir = fs.lstatSync(full, { throwIfNoEntry: false })?.isDirectory();
  const where = isDir ? `A file inside is in use by another program: ${busy}` : 'Another program is using this file';
  const note = busy === undefined ? '' : ` ${where}. Close that program and delete again.`;
  return `Could not send to the Recycle Bin: ${full}${reason ? ` (${reason})` : ''}.${note}`;
}

// It decodes the reason text that PowerShell sent as UTF-16 base64 into one line and returns it. If it is missing or garbled, it is an empty string.
function decodeReason(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  if (!/^[A-Za-z0-9+/=]+$/.test(line)) return '';
  return Buffer.from(line, 'base64').toString('utf16le').replace(/\s+/g, ' ').trim().replace(/[.。]$/, '');
}

// It sends several empty folders to the Recycle Bin with one PowerShell run (#67). Starting PowerShell for each folder takes 1 to 2 seconds each, which becomes hours when there are many folders.
// Even if the caller finished the check before deleting, sending in a batch makes the gap between the check and the deletion longer, so PowerShell checks again for each folder right before deleting.
// - Whether the real path (GetFinalPathNameByHandle) is the same as the path passed in. If a folder above was replaced by a junction and points elsewhere, it does not delete.
//   Even with the ReparsePoint attribute, as for the OneDrive folder, if it is not a link the real path stays the same, so it deletes.
// - Whether it is still a folder, whether it holds no file other than allowedNames (folder settings files, lower case), and whether a subfolder was replaced by a link
// For the path, it passes the real path that Node obtained with realpath. The result is a list of { path, status } in the order passed.
// status: ok (sent to the Recycle Bin), moved, notdir, filled, gone, error, timeout (the folder being processed when the time limit hit), pending (a folder after it that was not touched)
// It reports separately as pending the folders after the one in a batch that hit the time limit, so the caller can send them again. The same folder does not block a whole batch every time (first review).
// script is passed only when a test replaces DeleteDirectory and runs the checking part with real PowerShell.
const FOLDER_BATCH_STATUS = new Set(['ok', 'moved', 'notdir', 'filled', 'gone', 'error']);

const RECYCLE_FOLDERS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { exit 75 }
try { Add-Type -AssemblyName Microsoft.VisualBasic } catch { exit 76 }
try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class FcFinalPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint l, uint f);
  public static string Get(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      StringBuilder b = new StringBuilder(32768);
      return GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0) == 0 ? null : b.ToString();
    }
  }
}' } catch { exit 76 }
$u = [Text.Encoding]::Unicode
$allowed = @(($env:FC_ALLOWED -split '\|') | Where-Object { $_ })
function Long([string]$p) { if ($p.StartsWith('\\')) { return '\\?\UNC\' + $p.Substring(2) }; return '\\?\' + $p }
function Plain([string]$p) { if ($p.StartsWith('\\?\UNC\')) { return '\\' + $p.Substring(8) }; if ($p.StartsWith('\\?\')) { return $p.Substring(4) }; return $p }
function Same([string]$p) { $f = [FcFinalPath]::Get((Long $p)); return ($f -ne $null) -and [string]::Equals((Plain $f), $p, [StringComparison]::OrdinalIgnoreCase) }
function Check([string]$p) {
  $stack = [Collections.Stack]::new(); $stack.Push($p)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($e in [IO.DirectoryInfo]::new((Long $d)).EnumerateFileSystemInfos()) {
      $child = $d + '\' + $e.Name
      if (-not ([int]$e.Attributes -band 16)) { if ($allowed -notcontains $e.Name.ToLowerInvariant()) { return 'filled' }; continue }
      if (-not (Same $child)) { return 'filled' }
      $stack.Push($child)
    }
  }
  return $null
}
foreach ($line in $input) {
  if (-not $line) { continue }
  $p = $u.GetString([Convert]::FromBase64String($line))
  $status = 'error'
  try {
    $long = Long $p
    if (-not [IO.Directory]::Exists($long)) { if ([IO.File]::Exists($long)) { $status = 'notdir' } else { $status = 'gone' } }
    elseif (-not (Same $p)) { $status = 'moved' }
    else {
      $found = Check $p
      if ($found) { $status = $found }
      else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); $status = 'ok' }
    }
  } catch { $status = 'error' }
  [Console]::Out.WriteLine($status + ' ' + $line)
  [Console]::Out.Flush()
}`;

function recycleEmptyFolders(folders, { allowedNames = [], timeoutMs = 30 * 1000 + folders.length * 1000, script = RECYCLE_FOLDERS_SCRIPT } = {}) {
  if (folders.length === 0) return [];
  const input = folders.map((folder) => Buffer.from(folder, 'utf16le').toString('base64')).join('\n') + '\n';
  let output;
  let timedOut = false;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_BATCH: '1', FC_ALLOWED: allowedNames.join('|') },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.status === 75) throw new FcError('Cannot send to the Recycle Bin outside an interactive session.');
    // In a locked-down environment (Constrained Language Mode, AppLocker), a C# type cannot be created (first review).
    if (err.status === 76) throw new FcError('PowerShell could not create the type used to check paths (locked-down environment, etc.), so the empty folder was not sent to the Recycle Bin.');
    // Even on a time limit (such as when it stalls at an error dialog) or a mid-run failure, it uses the results of the folders already reported.
    timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
    output = typeof err.stdout === 'string' ? err.stdout : String(err.stdout ?? '');
    if (!timedOut && output === '') throw err;
  }
  const done = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\w+) ([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (match && FOLDER_BATCH_STATUS.has(match[1])) done.set(Buffer.from(match[2], 'base64').toString('utf16le'), match[1]);
  }
  let first = true;
  return folders.map((folder) => {
    if (done.has(folder)) return { path: folder, status: done.get(folder) };
    if (!timedOut) return { path: folder, status: 'error' };
    const status = first ? 'timeout' : 'pending';
    first = false;
    return { path: folder, status };
  });
}

// It looks in advance whether it can go through the Recycle Bin. If it fails, it returns unknown (null) so that the caller does not delete.
// The returned value is { interactive, driveType }. driveType is a .NET DriveType name such as Fixed, Removable, or Network.
// The returned value also includes that volume's Recycle Bin setting (#100). nukeOnDelete is whether "Don't move files to the Recycle Bin. Remove files immediately when deleted" is on,
// and maxCapacity is the Recycle Bin maximum size (in bytes). If it cannot be read, it is null.
// Measured (build 26200, interactive): on a volume where one item (a file, or the total inside for a folder) exceeds maxCapacity or nukeOnDelete is on,
// the Recycle Bin move deleted permanently without asking and finished as a success (with a D: capacity of 7164MB, 7100MB went to the Recycle Bin and 7200MB was deleted permanently).
// The amount already in the Recycle Bin did not matter (even when the total exceeded the capacity, it neither emptied existing items nor deleted the new one).
// The volume is found with GetVolumePathName, so under a volume mount folder it also looks at that volume's setting. The setting is, per user (HKCU),
// NukeOnDelete and MaxCapacity (MB) of BitBucket\Volume\{GUID}. If the policy (NoRecycleFiles) is on, it is seen as remove-immediately,
// and if the size was set by policy (RecycleBinSize), the size is treated as unknown.
// It decides the volume type ($type) and the Recycle Bin setting ($nuke: '0', '1', or '', $cap: MB or '') of $p. RECYCLE_STATE_SCRIPT and the Recycle Bin move script use it together (#81).
const VOLUME_STATE_PS = String.raw`$names = @('Unknown', 'NoRootDirectory', 'Removable', 'Fixed', 'Network', 'CDRom', 'Ram')
$type = 'Unknown'; $nuke = ''; $cap = ''
try {
  Add-Type -Namespace FcVolume -Name Native -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetVolumePathNameW(string f, System.Text.StringBuilder b, uint n);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetVolumeNameForVolumeMountPointW(string m, System.Text.StringBuilder b, uint n);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetDriveTypeW(string r);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
[StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attr, ReparseTag; }
[DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle h, int c, out TagInfo b, uint n);
public static bool IsLink(string p) {
  using (var h = CreateFileW(p, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
    if (h.IsInvalid) return false;
    TagInfo t;
    if (!GetFileInformationByHandleEx(h, 9, out t, 8)) return false;
    return (t.Attr & 0x400) != 0 && (t.ReparseTag == 0xA000000C || t.ReparseTag == 0xA0000003);
  }
}'
  $b = New-Object Text.StringBuilder 1024
  $root = if ([FcVolume.Native]::GetVolumePathNameW($p, $b, 1024)) { $b.ToString() } else { [IO.Path]::GetPathRoot($p) }
  $type = $names[[int][FcVolume.Native]::GetDriveTypeW($root)]
  $g = New-Object Text.StringBuilder 1024
  if ([FcVolume.Native]::GetVolumeNameForVolumeMountPointW($root, $g, 1024) -and ($g.ToString() -match '(\{[0-9A-Fa-f-]+\})')) {
    $k = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $matches[1]) -ErrorAction SilentlyContinue
    if ($k -and $k.NukeOnDelete -ne $null) { $nuke = [string][int]$k.NukeOnDelete }
    if ($k -and $k.MaxCapacity -ne $null) { $cap = [string][long]$k.MaxCapacity }
  }
  foreach ($hive in 'HKLM:', 'HKCU:') {
    $pol = Get-ItemProperty -LiteralPath ($hive + '\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer') -ErrorAction SilentlyContinue
    if ($pol -and [int]$pol.NoRecycleFiles -eq 1) { $nuke = '1' }
    if ($pol -and $pol.RecycleBinSize -ne $null) { $cap = '' }
  }
} catch { $type = 'Unknown' }`;

// It sends several files to the Recycle Bin with one PowerShell run (#194). Starting PowerShell for each file takes 0.5 to 0.6 second per file, but
// bundled it took 1.6 seconds for 50 (measured on build 26200). Sending in a batch makes the gap between Node's check and the real deletion longer, so PowerShell checks again for each file right before deleting.
// - Whether the real path (GetFinalPathNameByHandle) is the same as the path passed in. If a folder above was replaced by a junction and points elsewhere, it does not delete (moved).
// - Whether it is still a file (not a folder or link, notfile) and whether it equals the fileStamp from the judgment (file ID, size, modification and change times in ns) (changed).
//   It looks at a link only when, as in Node, the reparse tag is a symbolic link, a junction, or an app execution link. Files in the OneDrive folder, even downloaded ones, carry a reparse attribute
//   (a cloud file tag), so looking at the attribute alone would leave all of them undeleted (first review).
//   The value PowerShell made was literally the same as Node's fileStamp on C: (NTFS) and D: (ReFS) (measured).
// Interrupting the Recycle Bin move midway can lose files, so there is no time limit (#97). It sends the result one line at a time as each file finishes.
// items is a list of { path, stamp, keep? } and path is a path that went through recycleTarget. The result is a list of { path, status, reason } in the order passed.
// If keep({ path, stamp }) is given, right before deleting it also checks that the real path, the file-ness, and the fileStamp of that file (the file to keep of remove-duplicates) are unchanged,
// and if different, it does not delete (keepchanged, #216). Even if the file to keep changes in the middle of a batch, the copies are not deleted.
// status: ok (sent to the Recycle Bin), moved, notfile, changed, gone, keepchanged, error (the Windows reason is in reason), unknown (PowerShell ended midway and the result is not known)
// permanent: it looked at the volume's Recycle Bin setting again right before deleting and it would be deleted permanently, so it did not delete (#236). reason is the reason sentence (starting with "because ...") of the same judgment as RECYCLE_SCRIPT.
// Even if "remove immediately" is turned on or the maximum size is reduced after the judgment at the planning stage and before running, it does not delete. The setting is read once, the first time each volume is met in a batch.
const FILE_BATCH_STATUS = new Set(['ok', 'moved', 'notfile', 'changed', 'gone', 'keepchanged', 'permanent', 'error']);

const RECYCLE_FILES_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { exit 75 }
try { Add-Type -AssemblyName Microsoft.VisualBasic } catch { exit 76 }
try { Add-Type -ReferencedAssemblies System.Numerics -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class FcFileCheck {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint l, uint f);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attr; }
  [StructLayout(LayoutKind.Sequential)] struct Standard { public long Alloc, End; public uint Links; public byte Del, Dir; }
  [StructLayout(LayoutKind.Sequential)] struct ById { public uint Attr, C1, C2, A1, A2, W1, W2, Vol, SizeHigh, SizeLow, Links, IdHigh, IdLow; }
  [StructLayout(LayoutKind.Sequential)] struct Tag { public uint Attr, ReparseTag; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Basic b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Standard b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Tag b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out ById b);
  static string Ns(long ft) { return ((System.Numerics.BigInteger)(ft - 116444736000000000L) * 100).ToString(); }
  public static string Final(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      StringBuilder b = new StringBuilder(32768);
      return GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0) == 0 ? null : b.ToString();
    }
  }
  public static string Stamp(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      Basic b; Standard s; ById i; Tag t;
      if (!GetFileInformationByHandleEx(h, 0, out b, (uint)Marshal.SizeOf(typeof(Basic)))) return null;
      if (!GetFileInformationByHandleEx(h, 1, out s, (uint)Marshal.SizeOf(typeof(Standard)))) return null;
      if (!GetFileInformationByHandleEx(h, 9, out t, (uint)Marshal.SizeOf(typeof(Tag)))) return null;
      if (!GetFileInformationByHandle(h, out i)) return null;
      if ((b.Attr & 0x10) != 0) return "notfile";
      if ((b.Attr & 0x400) != 0 && (t.ReparseTag == 0xA000000C || t.ReparseTag == 0xA0000003 || t.ReparseTag == 0x8000001B)) return "notfile";
      ulong id = ((ulong)i.IdHigh << 32) | i.IdLow;
      return id + ":" + s.End + ":" + Ns(b.Write) + ":" + Ns(b.Change);
    }
  }
}' } catch { exit 76 }
$u = [Text.Encoding]::Unicode
function Long([string]$p) { if ($p.StartsWith('\\')) { return '\\?\UNC\' + $p.Substring(2) }; return '\\?\' + $p }
function Plain([string]$p) { if ($p.StartsWith('\\?\UNC\')) { return '\\' + $p.Substring(8) }; if ($p.StartsWith('\\?\')) { return $p.Substring(4) }; return $p }
function Same([string]$k, [string]$stamp) {
  $kl = Long $k
  if (-not [IO.File]::Exists($kl)) { return $false }
  $f = [FcFileCheck]::Final($kl)
  if (($f -eq $null) -or -not [string]::Equals((Plain $f), $k, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return ([FcFileCheck]::Stamp($kl) -eq $stamp)
}
# It reads the volume's Recycle Bin setting (#236). Files in the same folder are on the same volume, so it looks only once per folder in a batch, the first time.
# Reading the registry takes about 40ms per folder (measured in the first review), so if the volume root (GetVolumePathName) is the same, it reuses the setting it read.
function VolumeState([string]$p) {
${VOLUME_STATE_PS}
  return @($type, $nuke, $cap, $root)
}
$volumes = @{}; $roots = @{}
function VolumeOf([string]$dir) {
  if ('FcVolume.Native' -as [type]) {
    $b = New-Object Text.StringBuilder 1024
    if ([FcVolume.Native]::GetVolumePathNameW($dir, $b, 1024) -and $roots.ContainsKey($b.ToString())) { return $roots[$b.ToString()] }
  }
  $state = VolumeState $dir
  if ($state[3] -and $state[0] -ne 'Unknown') { $roots[$state[3]] = $state }
  return $state
}
# If deleting would be permanent, it returns the same marker as RECYCLE_SCRIPT (type|kind, nuke, cap|MB, unknown); otherwise $null.
function PermanentMark([string]$p, [long]$size) {
  $dir = [IO.Path]::GetDirectoryName($p)
  if (-not $volumes.ContainsKey($dir)) { $volumes[$dir] = VolumeOf $dir }
  $type, $nuke, $cap, $root = $volumes[$dir]
  if ($type -ne 'Fixed') { return 'type|' + $type }
  if ($nuke -ne '' -and $nuke -ne '0') { return 'nuke' }
  $limit = if ($cap -ne '') { [long]$cap * 1MB } else { 1GB - 1 }
  if ($size -gt $limit) { if ($cap -ne '') { return 'cap|' + $cap } else { return 'unknown' } }
  return $null
}
foreach ($line in $input) {
  if (-not $line) { continue }
  $parts = $line.Split(' ')
  $status = 'error'; $reason = ''
  try {
    # The fields are the copy path and stamp (2), or also the path and stamp of the file to keep (4). Anything else is not deleted, so that the check of the file to keep is not skipped (first review).
    if ($parts.Length -ne 2 -and $parts.Length -ne 4) { throw 'bad input line' }
    $p = $u.GetString([Convert]::FromBase64String($parts[0]))
    $long = Long $p
    if (-not [IO.File]::Exists($long)) { if ([IO.Directory]::Exists($long)) { $status = 'notfile' } else { $status = 'gone' } }
    else {
      $final = [FcFileCheck]::Final($long)
      $now = [FcFileCheck]::Stamp($long)
      if (($final -eq $null) -or -not [string]::Equals((Plain $final), $p, [StringComparison]::OrdinalIgnoreCase)) { $status = 'moved' }
      elseif ($now -eq 'notfile') { $status = 'notfile' }
      elseif ($now -ne $parts[1]) { $status = 'changed' }
      elseif (($parts.Length -ge 4) -and -not (Same ($u.GetString([Convert]::FromBase64String($parts[2]))) $parts[3])) { $status = 'keepchanged' }
      elseif (($mark = PermanentMark $p ([long]$now.Split(':')[1])) -ne $null) { $status = 'permanent'; $reason = [Convert]::ToBase64String($u.GetBytes($mark)) }
      else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); $status = 'ok' }
    }
  } catch { $status = 'error'; $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; $reason = [Convert]::ToBase64String($u.GetBytes([string]$e.Message)) }
  [Console]::Out.WriteLine($status + ' ' + $parts[0] + ' ' + $reason)
  [Console]::Out.Flush()
}`;

function recycleFiles(items, { script = RECYCLE_FILES_SCRIPT } = {}) {
  if (items.length === 0) return [];
  const b64 = (p) => Buffer.from(p, 'utf16le').toString('base64');
  const input = items.map((item) => `${b64(item.path)} ${item.stamp}${item.keep ? ` ${b64(item.keep.path)} ${item.keep.stamp}` : ''}`).join('\n') + '\n';
  let output;
  let failure;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_RECYCLE_FILES: '1' },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.status === 75) throw new FcError('Cannot send to the Recycle Bin outside an interactive session.');
    if (err.status === 76) throw new FcError('PowerShell could not create the type used to check files (locked-down environment, etc.), so they were not sent to the Recycle Bin.');
    // Even if it ended midway, it uses the results of files already reported. For files not reported, the result is not known.
    output = typeof err.stdout === 'string' ? err.stdout : String(err.stdout ?? '');
    failure = err.status == null && err.signal ? `PowerShell ended with ${err.signal}` : `PowerShell exit code ${err.status ?? err.code}`;
  }
  const done = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\w+) ([A-Za-z0-9+/=]+) ?([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (!match || !FILE_BATCH_STATUS.has(match[1])) continue;
    const reason = decodeReason(match[3]);
    done.set(Buffer.from(match[2], 'base64').toString('utf16le'), { status: match[1], reason: match[1] === 'permanent' ? refusalReason(reason) : reason });
  }
  return items.map((item) => ({ path: item.path, ...(done.get(item.path) ?? { status: 'unknown', reason: failure ?? 'PowerShell did not report a result' }) }));
}

function bareDeviceInside(dir) {
  return entryInside(dir, (part) => BARE_DEVICE_NAME.test(part));
}

// It finds an item inside a folder that holds a name ending in a dot or a space (#190). The Recycle Bin move (PowerShell 5.1) cannot open such a name, so for the whole folder
// it fails with "지정한 파일을 찾을 수 없습니다" (Windows message: "The specified file cannot be found") and moves nothing (confirmed on build 26200). It is searched for only on failure and reported as the reason.
// A path longer than 259 characters inside is not the cause of the failure. A folder that held 274 to 377 character paths also went to the Recycle Bin as is and stayed inside the Recycle Bin (measured).
function oddNameInside(dir) {
  return entryInside(dir, (part) => /[. ]$/.test(part));
}

// Among the items in a folder, it returns the relative path of the first item where one path component satisfies test. If it is not a folder or cannot be read, it is undefined.
// It does not follow links or junctions (readdirSync recursive does not see a link as a folder).
function entryInside(dir, test) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return undefined;
    return fs.readdirSync(dir, { recursive: true }).find((rel) => rel.split(path.sep).some(test));
  } catch {
    return undefined;
  }
}

const RECYCLE_STATE_SCRIPT = `$p = $env:FC_VOLUME
${VOLUME_STATE_PS}
[Environment]::UserInteractive.ToString() + '|' + $type + '|' + $nuke + '|' + $cap`;

// The PowerShell script of moveToRecycleBin. In a non-interactive run (a service, a scheduled task), this API deletes permanently without going through the Recycle Bin, so it ends with 75.
// Right before deleting, it looks at the volume's Recycle Bin setting and the size (for a folder, the total inside; links and junctions are not followed), and if it would be deleted permanently, it does not delete and
// sends a reason marker as UTF-16 base64 and ends with 78 (#81). If it is not a fixed disk or the type is unknown, type|type; if remove-immediately, nuke;
// if it exceeds the maximum size, cap|MB; if the maximum size is unknown and it is 1GB or more, unknown; if the size cannot be read, size.
// If the Recycle Bin move fails, it sends the reason text Windows gave as UTF-16 base64 and ends with 77. stderr comes out in the code page and Korean is garbled (#97).
// The HResult of the exception comes out as 0x800736B7 for both locked files and folders and cannot separate the reasons, so it is not used.
const RECYCLE_SCRIPT = `if (-not [Environment]::UserInteractive) { exit 75 }
$p = $env:FC_TARGET
${VOLUME_STATE_PS}
$u = [Text.Encoding]::Unicode
function Refuse([string]$why) { [Console]::Out.WriteLine([Convert]::ToBase64String($u.GetBytes($why))); exit 78 }
if ($type -ne 'Fixed') { Refuse ('type|' + $type) }
if ($nuke -ne '' -and $nuke -ne '0') { Refuse 'nuke' }
$limit = if ($cap -ne '') { [long]$cap * 1MB } else { 1GB - 1 }
$long = if ($p.StartsWith('\\\\')) { '\\\\?\\UNC\\' + $p.Substring(2) } else { '\\\\?\\' + $p }
$size = [long]0
try {
  $isLink = { param($x) ([int][IO.File]::GetAttributes($x) -band 1024) -and [FcVolume.Native]::IsLink($x) }
  if ([IO.Directory]::Exists($long) -and -not (& $isLink $long)) {
    $stack = [Collections.Stack]::new(); $stack.Push($long)
    while ($stack.Count -gt 0 -and $size -le $limit) {
      foreach ($e in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()) {
        if ([int]$e.Attributes -band 16) { if (-not (([int]$e.Attributes -band 1024) -and [FcVolume.Native]::IsLink($e.FullName))) { $stack.Push($e.FullName) } }
        elseif (-not (([int]$e.Attributes -band 1024) -and [FcVolume.Native]::IsLink($e.FullName))) { $size += $e.Length; if ($size -gt $limit) { break } }
      }
    }
  } elseif ([IO.File]::Exists($long) -and -not (& $isLink $long)) { $size = [IO.FileInfo]::new($long).Length }
} catch { Refuse 'size' }
if ($size -gt $limit) { if ($cap -ne '') { Refuse ('cap|' + $cap) } else { Refuse 'unknown' } }
try { Add-Type -AssemblyName Microsoft.VisualBasic
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }
catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; [Convert]::ToBase64String($u.GetBytes([string]$e.Message)); exit 77 }`;

// It turns the marker that RECYCLE_SCRIPT reported with 78 into a reason (a sentence starting with "because ...").
function refusalReason(mark) {
  const [kind, value] = mark.split('|');
  if (kind === 'type') return volumeTypeReason(value === 'Unknown' ? null : value);
  if (kind === 'nuke') return permanentDeleteReason({ nukeOnDelete: true }, 0);
  if (kind === 'cap') return permanentDeleteReason({ nukeOnDelete: false, maxCapacity: Number(value) * 1024 * 1024 }, Infinity);
  if (kind === 'unknown') return permanentDeleteReason({ nukeOnDelete: false, maxCapacity: null }, Infinity);
  return 'because the size could not be checked, so it is unknown whether it exceeds the Recycle Bin maximum size';
}

function volumeTypeReason(driveType) {
  return driveType === null || driveType === undefined
    ? 'because the drive type could not be checked, so it is unknown whether a Recycle Bin exists'
    : `because the drive (${driveType}) may have no Recycle Bin and the file could be permanently deleted`;
}

// hint is turned on only for commands that accept --permanent, like rm. extract-all and collapse do not accept --permanent (first review).
function permanentRefusal(full, why, hint = false) {
  const tail = hint ? ' To delete without the Recycle Bin, use --permanent.' : '';
  return `Not sent to the Recycle Bin: ${full}. It was not deleted ${why}.${tail}`;
}

// In the preview, it makes the same judgment as RECYCLE_SCRIPT (#81). If it would be deleted permanently it returns the reason, otherwise null.
function previewRefusal(full) {
  const state = recycleBinState(full);
  if (state.driveType !== 'Fixed') return volumeTypeReason(state.driveType);
  if (state.nukeOnDelete === true) return permanentDeleteReason(state, 0);
  const limit = state.maxCapacity ?? UNKNOWN_RECYCLE_LIMIT - 1;
  let size;
  try {
    size = sizeUpTo(full, limit);
  } catch {
    return refusalReason('size');
  }
  return permanentDeleteReason(state, size);
}

// The file size, or for a folder the total size of the files inside. It does not follow links or junctions, and stops counting if the total exceeds limit.
function sizeUpTo(full, limit) {
  const stat = fs.lstatSync(full);
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let size = 0;
  const stack = [full];
  while (stack.length > 0 && size <= limit) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) size += fs.lstatSync(child).size;
      if (size > limit) break;
    }
  }
  return size;
}

function recycleBinState(target) {
  const unknown = { interactive: null, driveType: null, nukeOnDelete: null, maxCapacity: null };
  if (!isWindows) return unknown;
  try {
    const output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_STATE_SCRIPT], {
      env: { ...process.env, FC_VOLUME: path.resolve(target) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60 * 1000,
    });
    // It also accepts the form without a setting field (True|Fixed). Then the setting is treated as unknown.
    const found = /^(True|False)\|(\w+)(?:\|(\d*)\|(\d*))?\s*$/.exec(output);
    if (!found) return unknown;
    const driveType = found[2] === 'Unknown' ? null : found[2];
    const nukeOnDelete = found[3] ? found[3] !== '0' : null;
    const maxCapacity = found[4] ? Number(found[4]) * 1024 * 1024 : null;
    return { interactive: found[1] === 'True', driveType, nukeOnDelete, maxCapacity };
  } catch {
    return unknown;
  }
}

// The size to keep when the Recycle Bin capacity could not be confirmed. The default Recycle Bin capacity is about 5% of the volume, so it is 1GB for a 20GB volume.
const UNKNOWN_RECYCLE_LIMIT = 1024 * 1024 * 1024;

// It looks, by the volume setting (recycleBinState), at whether sending an item of size bytes to the Recycle Bin would delete it permanently (#100).
// If it would be deleted permanently, it returns the reason (a sentence starting with "because ..."), otherwise null. If the capacity is unknown, it is seen as permanent deletion from UNKNOWN_RECYCLE_LIMIT.
// fallback is the limit for when the capacity is unknown, and is changed only in tests.
function permanentDeleteReason(state, size, fallback = UNKNOWN_RECYCLE_LIMIT) {
  if (state.nukeOnDelete === true) return 'because this volume is set to remove files immediately instead of using the Recycle Bin, so it would be permanently deleted';
  const mb = (bytes) => `${Math.floor(bytes / (1024 * 1024))}MB`;
  if (state.maxCapacity !== null && state.maxCapacity !== undefined) {
    return size > state.maxCapacity ? `because it is larger than the Recycle Bin maximum size (${mb(state.maxCapacity)}), so Windows would permanently delete it without asking` : null;
  }
  return size >= fallback ? 'because it is 1GB or larger and the Recycle Bin maximum size could not be checked, so it could be permanently deleted' : null;
}

// If checkVolume is true, before deleting (including the preview) it looks at the volume's Recycle Bin setting and size for every target, and if any target would be deleted permanently,
// it deletes nothing and refuses (#81). On a real delete, the Recycle Bin move script looks once more right before deleting.
// Callers that already made the same judgment (remove-broken and so on) call it with false so that PowerShell is not started once more.
// permanentHint is whether to attach the --permanent hint to the refusal reason (only the rm command turns it on).
function remove(targets, { permanent = false, dryRun = false, checkVolume = true, permanentHint = false } = {}) {
  if (!permanent && !isWindows) {
    throw new FcError('Deleting to the Recycle Bin works only on Windows. To delete permanently, use --permanent');
  }
  const planned = new Set();
  // It checks every target before deleting anything (#129). In rm a b c, if only c cannot be sent, a and b are not deleted either and the reason is reported.
  // The preview goes through the same check, so it does not show a target that would really fail as "Move to the Recycle Bin".
  const checked = targets.map((target) => {
    ensureExists(target);
    // If deleted as is, only the current folder cannot be deleted and it fails, but before that the other items have already been deleted.
    // Deleting a link removes only the link, so it compares by the link itself. Comparing by text catches the current folder reached through a link (rm lnk, current folder lnk/s).
    if (isSameOrUnder(entryKey(target), realKey(process.cwd())) || isSameOrUnder(pathKey(target), pathKey(process.cwd()))) {
      throw new FcError(`Cannot delete the current folder or its parents: ${target}`);
    }
    if (!permanent) rejectBareDeviceArgs([target], 'cannot be sent to the Recycle Bin');
    // Permanent deletion deletes with Node (fs.rmSync), so it does not run the Recycle Bin path check.
    const recycleAs = permanent ? undefined : recycleTarget(target);
    if (!permanent && checkVolume) {
      const why = previewRefusal(recycleAs);
      if (why !== null) throw new FcError(permanentRefusal(recycleAs, why, permanentHint));
    }
    if (dryRun) claim(planned, target);
    return { target, recycleAs };
  });
  return checked.map(({ target, recycleAs }) => {
    // If an earlier target contained this target and it was already deleted (rm a a/b), it reports that it does not exist, as before.
    if (!dryRun) ensureExists(target);
    if (permanent) return perform(`Delete permanently: ${target}`, dryRun, () => fs.rmSync(target, { recursive: true, force: true }));
    return perform(`Move to the Recycle Bin: ${target}`, dryRun, () => moveToRecycleBin(recycleAs, { permanentHint }));
  });
}

// The system OEM code page number. tar.exe reads and writes the names of zip entries that have no UTF-8 marker in this code page (#173, #83).
// If it cannot be confirmed, it is null. Once read, it is remembered.
let oemCodePageCache;
function oemCodePage() {
  if (oemCodePageCache !== undefined) return oemCodePageCache;
  oemCodePageCache = null;
  if (!isWindows) return null;
  try {
    const output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage').OEMCP"], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const cp = Number(output.trim());
    if (Number.isSafeInteger(cp) && cp > 0) oemCodePageCache = cp;
  } catch {
    // If it cannot be confirmed, it is left null. The user of it does not trust the name.
  }
  return oemCodePageCache;
}

// tar.exe takes arguments in the system code page, so it either changes a character not in that code page into a similar letter (é -> e) or ends abnormally.
// If passed on as is, it could bundle another file or write to another folder, so if there is a character that would change, it refuses before running.
// Arguments are taken in the ANSI code page but zip and cpio entry names are written in the OEM code page. On English Windows (ANSI 1252, OEM 437),
// bundling COM¹.tar.gz into zip and extracting it became COM1.tar.gz without an error (#136). So for those entry names it refuses a character that would change in either ANSI or OEM.
// The entry names of formats other than the path arguments (pax tar, 7z, jar, iso, and so on) do not go through OEM (#173, confirmed on the English Windows of CI).
// If withOem is false, it looks only at ANSI. If codePages is given, it looks at that instead of the system code pages (for tests).
function unsupportedChars(text, codePages = null, { withOem = true } = {}) {
  if (!isWindows) return [];
  const chars = [...new Set(text.replace(/[\x00-\x7f]/g, ''))];
  if (chars.length === 0) return [];
  // If even one code page cannot be confirmed, it stops and refuses to run, so that the check does not pass in a weakened state.
  // If OEMCP is empty, [int] becomes 0 and GetEncoding(0) returns ANSI, so it is blocked separately.
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    '$cps = if ($env:FC_CODEPAGES) { $env:FC_CODEPAGES -split "," } else { ' +
    "@([Text.Encoding]::Default.CodePage) + @(if ($env:FC_WITH_OEM) { (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage').OEMCP }) }; " +
    '$encs = @($cps | ForEach-Object { if ([int]$_ -le 0) { throw "code page $_" }; [Text.Encoding]::GetEncoding([int]$_) }); ' +
    'foreach ($c in ($env:FC_CHARS -split "`n")) { foreach ($e in $encs) ' +
    '{ if ($e.GetString($e.GetBytes($c)) -cne $c) { [char]::ConvertToUtf32($c, 0); break } } }';
  let output;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_CHARS: chars.join('\n'), FC_CODEPAGES: codePages ? codePages.join(',') : '', FC_WITH_OEM: withOem ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    throw new FcError(`Could not check the system code page, so tar.exe was not run. (${err.status ?? err.code})`);
  }
  return output.split(/\s+/).filter(Boolean).map((code) => String.fromCodePoint(Number(code)));
}

// tar.exe removes the trailing dot and space of a name but Node handles them literally, so passing a.txt. would bundle a.txt.
function trailingDotOrSpaceName(p) {
  return p.slice(path.parse(p).root.length).split(path.sep).find((part) => /[. ]$/.test(part));
}

// paths are looked at only as ANSI, and oemNames are looked at as OEM too.
function ensureTarCanUse(paths, oemNames = []) {
  if (!isWindows) return;
  const all = [...paths, ...oemNames];
  const trailing = all.find(trailingDotOrSpaceName);
  // It wraps the name in quotes so that the trailing space can be seen.
  if (trailing !== undefined) throw new FcError(`tar.exe cannot handle a name ending with a dot or space: ${JSON.stringify(trailingDotOrSpaceName(trailing))} (${trailing})`);
  let bad = unsupportedChars(paths.join(''), null, { withOem: false });
  let checked = paths;
  if (bad.length === 0) {
    bad = unsupportedChars(oemNames.join(''));
    checked = oemNames;
  }
  if (bad.length === 0) return;
  // There are also characters that look like spaces and Hangul jamo that came from macOS, so it shows the code and the path together with the letters.
  const codes = bad.map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}(${char})`);
  const where = checked.find((p) => bad.some((char) => p.includes(char)));
  throw new FcError(`The name contains characters tar.exe cannot handle: ${codes.join(' ')} (${where})`);
}

// args are the paths passed to tar.exe as arguments, and entries are the names to be written inside the archive (the source names and the names inside the folder to bundle).
// Device names inside a folder are handled as files by tar.exe, so it looks only at the arguments (#135). oemEntries is whether the format writes entry names in OEM (zip, cpio, and formats not checked).
function ensureTarArgs(args, entries = [], { oemEntries = false } = {}) {
  if (oemEntries) ensureTarCanUse(args, entries);
  else ensureTarCanUse([...args, ...entries]);
  rejectBareDeviceArgs(args, 'would be opened as a device by tar.exe and cannot be handled');
}

// The names inside the folder to bundle must also be readable by tar.exe, so they are checked together. Like tar, it follows the source and the junctions inside it.
function namesInside(src) {
  if (!fs.statSync(src).isDirectory()) return [];
  return fs.readdirSync(src, { recursive: true });
}

// tar.exe reads the TAR_READER_OPTIONS and TAR_WRITER_OPTIONS environment variables like --options.
// If mtree:checkfs is in them, it copies the local file at the contents= path of the mtree text into the extraction folder, so they are not passed on (#87).
// Windows environment variable names are case-insensitive.
const TAR_OPTION_ENV = new Set(['TAR_READER_OPTIONS', 'TAR_WRITER_OPTIONS']);
function tarEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !TAR_OPTION_ENV.has(isWindows ? name.toUpperCase() : name)));
}

// tar.exe (libarchive) looks for external compression programs (lz4, lzop, and so on) with SearchPath, and in that order the current folder comes before the PATH.
// So an lz4.exe planted in the folder where fctl was run could be executed (measured on build 26200: a fake lz4.exe in the current folder was executed, #242).
// It always runs tar.exe from the folder where tar.exe lives (System32). Every argument is an absolute path or relative to -C, so the interpretation does not change.
const TAR_CWD = isWindows ? path.dirname(TAR) : undefined;

// 0xC0000005: when tar.exe meets a name it cannot handle, it ends like this without any error message.
function runTar(args, options) {
  try {
    return execFileSync(TAR, args, { ...options, env: tarEnv(), cwd: TAR_CWD });
  } catch (err) {
    if (err.status === 0xc0000005) throw new FcError(`tar.exe exited abnormally. A name it cannot handle may be present. (${err.status})`);
    const program = missingProgram(err.stderr);
    if (program !== null) {
      throw new FcError(`This archive is not handled by tar.exe, so it needs the external program ${program}, but it could not be run. Put ${program}.exe on PATH or use another archive format (.zip, .tar.gz, etc.).`);
    }
    throw err;
  }
}

// stderr when tar.exe could not find an external compression program (measured on build 26200). When extracting (including reading the list),
// `Can't initialize filter; unable to run program "lz4 -d -q"`, and when bundling, `Can't launch external program: lz4 -z ...` (#241).
// Compression is identified by content, not by name, so it cannot be known in advance from the extension; it is recognized from this message after a failure. It returns the program name.
// An entry error line (`<entry name>: <reason>`) prints the name as is and can imitate this message, so it is accepted only when the whole tar.exe line matches and
// the program is a known external compression program (first review: an entry name such as `../unable to run program "lz4 x"` hid another failure).
const MISSING_PROGRAM = [
  /^[ \t]*\S*tar(?:\.exe)?: Error opening archive: Can't initialize filter; unable to run program "(lz4|lzop|lrzip|grzip)(?: [^"\r\n]*)?"\r?$/m,
  /^[ \t]*\S*tar(?:\.exe)?: Can't launch external program: (lz4|lzop|lrzip|grzip)(?: [^\r\n]*)?\r?$/m,
];
function missingProgram(stderr) {
  const text = Buffer.isBuffer(stderr) ? stderr.toString('latin1') : String(stderr ?? '');
  for (const pattern of MISSING_PROGRAM) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

// It hands over any value in advance, so that tar.exe does not stall asking for a password on the console for a password-protected archive. It fails with the wrong password.
const NO_PASSWORD = isWindows ? ['--passphrase', 'fctl-no-password'] : [];

// It returns the entries in an archive as lines in tar -tv format. The first character is the kind (d folder, - file, h hard link, l link, and so on).
// RAR folder names do not get a trailing /, so the kind is not judged by name. It only reads, so a broken archive gives an error just like a real extraction.
// Names come out in the code page and Korean can be garbled, so only the count and the first character are trusted.
function archiveEntries(archive) {
  ensureTarArgs([path.resolve(archive)]);
  const listing = runTar(['-tvf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

// The list of entry names in an archive. They come out in the code page, so non-ASCII names cannot be trusted.
function archiveNames(archive) {
  ensureTarArgs([path.resolve(archive)]);
  const listing = runTar(['-tf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

// It reads an archive to the end with tar.exe. It does not raise an error and returns { error, status, stderr, entries }.
// A damage message also comes out with exit code 0 (Damaged tar archive), so the judgment uses stderr. error is a run failure or a limit exceeded (ENOBUFS, ETIMEDOUT).
function probeArchive(archive, { maxBuffer, timeout }) {
  ensureTarArgs([path.resolve(archive)]);
  const { error, status, stdout, stderr } = spawnSync(TAR, ['-tf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer, timeout, env: tarEnv(), cwd: TAR_CWD });
  return { error, status, stderr: stderr ? stderr.toString('latin1') : '', entries: stdout ? stdout.toString('latin1').split(/\r?\n/).filter((line) => line.trim() !== '').length : 0 };
}

// The size column of a tar -tv line. bsdtar writes the kind and permissions, link count, owner, group, and size, in that order.
// For an item with an ACL or extended attributes, one more character such as + or @ is attached at the end of the permission column.
// If the owner name has a space or the item is a device entry (major, minor numbers), it cannot be read, so it does not extract in that case.
const LISTED_SIZE = /^\S{10,11}\s+\d+\s+\S+\s+\S+\s+(\d+)\s/;
// A file takes space in clusters, so it rounds the size up to the cluster size (at least 4KB) and adds.
const DISK_BLOCK = 4096n;
// Files and folders of size 0 also use a file system record (an NTFS MFT record of 1KB) for each entry.
const ENTRY_OVERHEAD = 1024n;
// At least this much must remain even after extracting. It is room for other programs that use the same disk and for the OneDrive sync.
const SPACE_RESERVE = 1024n ** 3n;

// The sum of the sizes written in the list (rounded up by block and with ENTRY_OVERHEAD added per entry). It is a value the archive wrote, so it can differ from the real one.
// Even a case that makes a large empty file only from a size= value, as in mtree text, shows up in the list with that size.
function listedSize(entries, block) {
  let total = 0n;
  for (const line of entries) {
    const match = LISTED_SIZE.exec(line);
    if (!match) throw new FcError(`Could not read the size from the archive listing, so it was not extracted: ${JSON.stringify(line.slice(0, 80))}`);
    total += ((BigInt(match[1]) + block - 1n) / block) * block + ENTRY_OVERHEAD;
  }
  return total;
}

// The free space and the cluster size of the volume that dir will go into. If it is a folder that does not exist yet, it looks at the parent folder that exists.
function freeSpace(dir) {
  let current = path.resolve(dir);
  while (!exists(current) && path.dirname(current) !== current) current = path.dirname(current);
  const stat = fs.statfsSync(current, { bigint: true });
  return { free: stat.bavail * stat.bsize, block: stat.bsize > DISK_BLOCK ? stat.bsize : DISK_BLOCK };
}

// If the extracted size is larger than the free space minus SPACE_RESERVE, it refuses before extracting (#77). It also does not extract if it cannot be confirmed.
// The returned value is the sum of the list sizes (bytes, BigInt).
function ensureRoomToExtract(dest, entries) {
  let space;
  try {
    space = freeSpace(dest);
  } catch (err) {
    throw new FcError(`Could not check the free disk space, so it was not extracted: ${dest} (${err.code ?? err.message})`);
  }
  const need = listedSize(entries, space.block);
  const { free } = space;
  if (need + SPACE_RESERVE > free) {
    throw new FcError(`Extracting would take about ${formatSize(Number(need))} and leave less than ${formatSize(Number(SPACE_RESERVE))} free on the disk, so it was not extracted. (free space ${formatSize(Number(free))})`);
  }
  return need;
}

// Only extract-all, which already made the same check, turns checkSpace off.
function unzip(archive, destDir, { dryRun = false, checkSpace = true } = {}) {
  ensureExists(archive);
  const dest = destDir || path.join(path.dirname(archive), path.parse(archive).name);
  rejectLongName(dest, 'The extraction folder');
  rejectLongTarDir(dest, 'The extraction folder');
  rejectNewDeviceName(dest);
  ensureTarArgs([path.resolve(archive), path.resolve(dest)]);
  let note = '';
  if (dryRun) ensureCanMakeDir(dest);
  if (dryRun || checkSpace) {
    const entries = archiveEntries(archive);
    const size = checkSpace ? ensureRoomToExtract(dest, entries) : null;
    const sizeNote = size === null ? '' : `, extracted size about ${formatSize(Number(size))}`;
    if (dryRun) note = ` (${entries.length} items${sizeNote}${exists(dest) ? ', the destination folder already exists, so files with the same name are overwritten' : ''})`;
  }
  if (isWindows) rejectExtractShortNameClash(archiveNames(archive), dest);
  return perform(`Extract: ${archive} -> ${dest}${note}`, dryRun, () => {
    fs.mkdirSync(dest, { recursive: true });
    runTar(['-xf', path.resolve(archive), '-C', path.resolve(dest), ...NO_PASSWORD], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
}

// -a decides the format by the extension, so the temporary file gets the same extension (including a layered extension such as .tar.gz).
// The temporary name is also used as an --exclude pattern, so it accepts only alphanumeric extensions with no pattern characters.
// tar.exe looks at extensions case-sensitively and makes X.ZIP and x.TAR.GZ an uncompressed tar. So the temporary file gets a lower-case extension.
// However, the compress formats .Z, .taZ, and .tZ are told apart by case (.z is an uncompressed tar, .taz is gzip, .tz is an uncompressed tar), so they are left as they are.
const KEEP_CASE_EXT = new Set(['Z', 'taZ', 'tZ']);
// Extensions that were confirmed on the English Windows of CI to be written by tar.exe without going through the OEM code page (in UTF-8 or UTF-16) (#173).
// It compares with the value archiveExt returns. .zip and .cpio (including .tar.zip and .tar.cpio) are written in OEM, and an extension that was not checked is also seen as written in OEM.
const ANSI_ENTRY_EXT = new Set(['.tar', '.tgz', '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.gz', '.taZ', '.7z', '.jar', '.iso', '.xar', '.mtree', '.warc']);
// The extensions that tar.exe reads as a format from an archive name, and the extensions that, when they follow, are read as compression (#164).
// Giving x.cpio.gz to tar.exe as it is puts a cpio inside gzip, so the temporary file must also get both extensions for the name and the content to be the same.
// An extension that is not read as a format, such as .jar, makes x.jar.gz also a tar inside gzip, the same as just adding .gz.
const FORMAT_EXT = new Set(['cpio', 'iso', 'ar', 'shar', 'xar', 'warc', 'mtree', '7z', 'zip']);
const COMPRESS_EXT = /^(?:gz|bz2|xz|zst|lzma|lz|lz4|lzo|lrz|grz|uu)$/i;
// tar.exe peels off compression extensions at the end layer by layer (#193, measured on build 26200: x.tar.gz.gz is a tar inside two layers of gzip, x.cpio.gz.xz is a cpio inside gzip inside xz,
// y.tgz.gz is a tar inside two layers of gzip, y.Z.gz is a compress inside gzip). So it moves
// all the compression extensions continuing from the end (including .tgz and the like, which mean tar and compression together) to the temporary file, so tar.exe decides the format from the original name (lower-cased) the same way. It does not imitate the peeling rules separately.
// Extensions accept only alphanumerics, so no --exclude pattern characters enter the temporary name.
const LAYER_EXT = /^(?:gz|bz2|xz|zst|lzma|lz|lz4|lzo|lrz|grz|uu|tgz|tbz|tbz2|txz|tlz|tzst|taz|tz2|tzo)$/i;
const isLayerExt = (part) => LAYER_EXT.test(part) || KEEP_CASE_EXT.has(part);
function archiveExt(archive) {
  const parts = path.basename(path.resolve(archive)).split('.');
  // parts[0] is the name, so it is not seen as an extension.
  const usable = (i) => i >= 1 && /^[a-z0-9]+$/i.test(parts[i]);
  const last = parts.length - 1;
  if (!usable(last)) return '';
  let start = last;
  while (usable(start - 1) && isLayerExt(parts[start]) && isLayerExt(parts[start - 1])) start -= 1;
  if (usable(start - 1)) {
    const before = parts[start - 1].toLowerCase();
    // For format plus compression (x.cpio.gz, #164) and an extension after tar (x.tar.gz, x.tar.zip), the earlier extension is also moved.
    const compressed = COMPRESS_EXT.test(parts[start]) || parts[start] === 'Z';
    if ((compressed && (FORMAT_EXT.has(before) || before === 'tar')) || (start === last && before === 'tar')) start -= 1;
  }
  return parts.slice(start).map((part) => `.${KEEP_CASE_EXT.has(part) ? part : part.toLowerCase()}`).join('');
}

// If the archive is inside the folder to bundle, tar also bundles the existing archive, so it must be set aside in advance.
// It can also be reached through a link inside the folder, so a folder that holds a link is also seen as containing it. A UNC alias is caught by file ID.
function archiveInsideSources(archive, sources) {
  const dir = realKey(path.dirname(path.resolve(archive)));
  return sources.some((src) => {
    if (!fs.statSync(src).isDirectory()) return false;
    if (isSameOrUnder(realKey(src), dir) || hasAncestorSameAs(src, archive)) return true;
    return fs.readdirSync(src, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink());
  });
}

// It restores the archive set aside to its original name and throws the original error. If it cannot restore it, it tells where it was set aside.
function restoreAside(archive, aside, err) {
  try {
    fs.renameSync(aside, archive);
  } catch (restoreErr) {
    throw new FcError(`Could not compress, and could not restore the existing archive either: ${archive} (${restoreErr.code}). The existing archive is at ${aside}.`);
  }
  throw err;
}

// It first bundles under a temporary name and, after success, swaps it with the existing archive. If it fails, the existing archive is left as it is.
// Only when the archive is inside the folder to bundle, it sets the existing archive aside and takes it out of the name before running tar. Otherwise it stays under its original name while tar runs.
function writeArchive(archive, sources) {
  const fresh = freshPath(archive, '.fctl-new', archiveExt(archive));
  const early = exists(archive) && archiveInsideSources(archive, sources);
  let aside = early ? asidePath(archive) : null;
  const args = ['-a', '-cf', fresh, '--exclude', path.basename(fresh)];
  if (aside) args.push('--exclude', path.basename(aside));
  for (const src of sources) {
    const full = path.resolve(src);
    const name = path.basename(full);
    // Without ./, tar interprets a name that starts with - or @ as an option or a directive.
    args.push('-C', path.dirname(full), /^[-@]/.test(name) ? `./${name}` : name);
  }
  if (aside) fs.renameSync(archive, aside);
  try {
    runTar(args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (aside) restoreAside(archive, aside, err);
    throw err;
  }
  if (!aside && exists(archive)) {
    aside = asidePath(archive);
    try {
      fs.renameSync(archive, aside);
    } catch (err) {
      fs.rmSync(fresh, { force: true });
      throw err;
    }
  }
  try {
    fs.renameSync(fresh, archive);
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (aside) restoreAside(archive, aside, err);
    throw err;
  }
  if (aside) {
    try {
      fs.rmSync(aside, { force: true });
    } catch (err) {
      throw new FcError(`Compressed, but could not delete the existing archive: ${aside} (${err.code})`);
    }
  }
}

// A name that looks like an 8.3 short name (LONGNA~1.TXT). Before ~ there are 1 to 6 characters, and ~ may appear in it (~$LONG~1.DOC). The extension is 0 to 3 characters.
const SHORT_NAME = /^([^.]{1,6})~(\d{1,6})(?:\.([^.]{1,3}))?$/i;

// It estimates generously whether name could be the 8.3 short name of another name other. Windows upper-cases the long name (removing spaces and dots, and turning
// +,;=[] into _) and cuts the name and extension by OEM code page bytes. If there are many of the same name or the name is short, it appends a hash after the first 1 to 2 bytes,
// and a letter not in OEM is dropped or becomes _. So it compares only the first letter and the front part of the extension, and if a non-ASCII letter is involved, it assumes they can overlap.
// It can also refuse names that do not really overlap. A name that contains ~N is rare, so that side is safe (#159).
// An ASCII name that is originally in 8.3 form (name of 1 to 8 characters, extension of 0 to 3 characters, at most one dot, and only characters that 8.3 uses as they are). For such names Windows
// does not make a separate short name regardless of case (measured with dir /x on build 26200: photo.jpg, PHOTO2.JPG, Photo3.Jpg, noext, ab~1.txt),
// so they do not overlap with ~N names (#205). A short name is made for a space, +,;=[], two dots, a leading or trailing dot, 9 or more characters, and a 4-character extension.
// A non-ASCII name (é.txt, a Hangul name) also made no short name when it fit 8.3 in OEM bytes, but it differs by code page, so it is generously assumed that they can overlap.
const PLAIN_8DOT3 = /^[A-Za-z0-9!#$%&'()\-@^_`{}~]{1,8}(?:\.[A-Za-z0-9!#$%&'()\-@^_`{}~]{1,3})?$/;

function couldBeShortNameOf(name, other) {
  const short = SHORT_NAME.exec(name);
  if (!short || name.toUpperCase() === other.toUpperCase()) return false;
  if (PLAIN_8DOT3.test(other)) return false;
  // It strips the leading dots and spaces and splits off the extension (..foo is FOO~1, .gitignore is GITIGN~1).
  const trimmed = other.replace(/^[ .]+/, '');
  const dot = trimmed.lastIndexOf('.');
  const rawBase = dot >= 0 ? trimmed.slice(0, dot) : trimmed;
  const rawExt = dot >= 0 ? trimmed.slice(dot + 1) : '';
  const clean = (text) => text.toUpperCase().replace(/[ .]/g, '').replace(/[+,;=[\]]/g, '_');
  // Some letters become ASCII when upper-cased (ﬁ -> FI), so whether it is ASCII is judged by the letters before changing.
  const nonAscii = (text) => /[^\x00-\x7f]/.test(text);
  // A letter not in OEM is dropped and the later letters move forward, so if one is anywhere in the name, it is assumed they can overlap.
  const base = nonAscii(rawBase) ? '\u0080' : clean(rawBase);
  const ext = nonAscii(rawExt) ? '\u0080' : clean(rawExt);
  // The short side's extension is the front part of the long name's extension. If there is no extension, the long name has none either.
  const shortExt = (short[3] ?? '').toUpperCase();
  const extMatches = nonAscii(ext) || nonAscii(shortExt) || (shortExt === '' ? ext === '' : [...shortExt].every((char, i) => char === '_' || ext[i] === char));
  if (!extMatches) return false;
  const head = short[1].toUpperCase()[0];
  return head === '_' || nonAscii(head) || nonAscii(base.slice(0, 6)) || base[0] === head;
}

// If the extraction volume makes short names, LONGNA~1.TXT and longname.txt in one folder become the same file depending on the extraction order, and one is overwritten (#159).
// If a source is given as a short name, tar.exe writes that short name as is as the entry name, so the top-level name is also looked at. It checks for each folder in the archive.
// inside is the result of namesInside for each source.
function rejectShortNameClash(sources, inside) {
  const top = sources.map((src) => path.basename(path.resolve(src)));
  // When they overlap at the top, it reports by the source path so you can see which source it is.
  const levels = new Map([['', top.map((name, i) => ({ name, shown: sources[i] }))]]);
  sources.forEach((src, i) => {
    for (const rel of inside[i]) {
      const dir = path.join(top[i], path.dirname(rel));
      if (!levels.has(dir)) levels.set(dir, []);
      levels.get(dir).push({ name: path.basename(rel), shown: path.join(dir, path.basename(rel)) });
    }
  });
  for (const items of levels.values()) {
    for (const item of items.filter(({ name }) => SHORT_NAME.test(name))) {
      const other = items.find(({ name }) => couldBeShortNameOf(item.name, name));
      if (other !== undefined) {
        throw new FcError(`Names that could collide through 8.3 short names are together, so they are not bundled. One could overwrite the other when extracting: ${item.shown}, ${other.shown}`);
      }
    }
  }
}

// When extracting, it prevents a ~N name in the archive from becoming another file through a short name (#188). names is the result of archiveNames, and dest is the extraction folder.
// 1) If it could overlap with another item in the same folder by short name, one is overwritten depending on the extraction order, so it refuses (the same estimate as rejectShortNameClash).
//    Windows is case-insensitive, so a/ and A/ are seen as the same folder.
// 2) If a ~N name reaches an item that already exists in the extraction folder as a short name, it would overwrite an existing file or mix into an existing folder, so it refuses.
//    ASCII names are judged by the short names that actually exist on the volume (if the name is not in the list but that path exists, it refuses). On a volume that does not make short names, it does not trigger.
// Names in the list come out in the code page, so a non-ASCII letter can become ?, a garbled letter, or another letter. Such letters are seen as a letter that can be anything,
// and such ~N names cannot be checked by path, so they are compared with existing names by estimate. Such a folder name counts as every existing non-ASCII folder at the same position.
const UNRELIABLE_NAME = /[^\x00-\x7f]|\?/;
function rejectExtractShortNameClash(names, dest) {
  const unknown = (name) => name.replace(/[^\x00-\x7f]|\?/g, '\u0080');
  // A short name that contains non-ASCII letters is made only from a long name that contains such letters (the short name of an ASCII long name is ASCII).
  const mayBe = (name, other) => (!UNRELIABLE_NAME.test(name) || UNRELIABLE_NAME.test(other)) && couldBeShortNameOf(unknown(name), unknown(other));
  const levels = new Map();
  for (const raw of names) {
    const parts = raw.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
    parts.forEach((part, i) => {
      const key = parts.slice(0, i).map((p) => p.toUpperCase()).join('/');
      if (!levels.has(key)) levels.set(key, { parts: parts.slice(0, i), items: new Map() });
      levels.get(key).items.set(part.toUpperCase(), part);
    });
  }
  const shown = (parts, name) => [...parts, name].join('/');
  // Non-ASCII names in the list look garbled, so it reports that they do (second review).
  const garbled = (...texts) => (texts.some((text) => UNRELIABLE_NAME.test(text)) ? ' (non-ASCII names in the archive listing may look garbled because of the code page)' : '');
  for (const { parts, items } of levels.values()) {
    const all = [...items.values()];
    const shorts = all.filter((name) => SHORT_NAME.test(name));
    for (const name of shorts) {
      const other = all.find((candidate) => candidate !== name && mayBe(name, candidate));
      if (other !== undefined) {
        throw new FcError(`The archive contains items that could collide through 8.3 short names, so it is not extracted. One could overwrite the other when extracting: ${shown(parts, name)}, ${shown(parts, other)}${garbled(shown(parts, name), other)}`);
      }
    }
    if (shorts.length === 0) continue;
    for (const place of existingPlaces(dest, parts)) {
      const existing = fs.readdirSync(place);
      const keys = new Set(existing.map((name) => name.toUpperCase()));
      for (const name of shorts) {
        let real;
        let note = '';
        if (UNRELIABLE_NAME.test(name)) {
          real = existing.find((candidate) => mayBe(name, candidate));
          if (real === undefined) continue;
          // The name cannot be confirmed, so an item whose name is exactly the same, as when extracting the same archive again, is also caught here.
          note = ` It might be an item with exactly the same name, but that cannot be confirmed.${garbled(name)}`;
        } else {
          if (keys.has(name.toUpperCase()) || !exists(path.join(place, name))) continue;
          real = existing.find((candidate) => couldBeShortNameOf(name, candidate)) ?? name;
          note = garbled(shown(parts, name));
        }
        throw new FcError(`${shown(parts, name)} in the archive may point to an item that already exists through an 8.3 short name, so it is not extracted. Extracting would overwrite or mix that item: ${path.join(place, real)}${note}`);
      }
    }
  }
}

// The existing folders that the archive's folder path parts can reach from the extraction folder dest. A name that cannot be trusted counts as every existing non-ASCII folder at that position.
function existingPlaces(dest, parts) {
  const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  let places = isDir(dest) ? [dest] : [];
  for (const part of parts) {
    const next = [];
    for (const place of places) {
      if (!UNRELIABLE_NAME.test(part)) {
        if (isDir(path.join(place, part))) next.push(path.join(place, part));
        continue;
      }
      for (const entry of fs.readdirSync(place, { withFileTypes: true })) {
        if (UNRELIABLE_NAME.test(entry.name) && isDir(path.join(place, entry.name))) next.push(path.join(place, entry.name));
      }
    }
    places = next;
  }
  return places;
}

// Which encoding entry names are written in is decided by the innermost format, and outer compression layers do not change it (#212). So from the layers of archiveExt
// it keeps only the innermost judgment (the first extension, and for a format or tar, up to one compression after it) and compares it with ANSI_ENTRY_EXT.
// .tar.gz.gz -> .tar.gz, .gz.xz -> .gz, .tgz.gz -> .tgz, .cpio.gz.xz -> .cpio.gz (not in the list, so it is seen as OEM).
function innerEntryExt(ext) {
  const parts = ext.split('.').filter(Boolean);
  if (parts.length === 0) return ext;
  const first = parts[0].toLowerCase();
  const keep = parts.length > 1 && (FORMAT_EXT.has(first) || first === 'tar') ? 2 : 1;
  return parts.slice(0, keep).map((part) => `.${part}`).join('');
}

// Compressions not built into tar.exe (bsdtar 3.8.9) that run an external program (measured on build 26200: "Can't launch external program: lz4 -z ...").
// If that program is not on the PATH, it ends in a raw failure, so it refuses in advance (#230). If it exists, it leaves the work to tar.exe.
// .tzo is an alias of .tar.lzo (first review).
const EXTERNAL_COMPRESSORS = { lz4: 'lz4', lzo: 'lzop', tzo: 'lzop', lrz: 'lrzip', grz: 'grzip' };
// tar.exe (libarchive filter_fork_windows.c) looks with SearchPath(NULL, name, ".exe"), so it runs only .exe. It does not look at .cmd and .bat of PATHEXT (first review).
// SearchPath also looks in the tar.exe folder, the system folder, and the current folder (fctl pins it to System32, #242), but it looks only at the PATH, so a program that is only there is generously refused.
// Relative PATH entries (., bin, and so on) are resolved by tar.exe relative to System32 and differ from fctl's current folder, so they are not looked at (#242 first review).
function findOnPath(program) {
  for (const raw of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, `${program}.exe`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // It skips places that do not exist or cannot be read.
    }
  }
  return null;
}
function rejectMissingCompressor(archive) {
  for (const part of archiveExt(archive).split('.').filter(Boolean)) {
    const program = EXTERNAL_COMPRESSORS[part.toLowerCase()];
    if (program !== undefined && findOnPath(program) === null) {
      throw new FcError(`A .${part} archive is not handled by tar.exe, so it needs the external program ${program}, but it was not found on PATH. Use another archive format (.gz, .xz, .zst, etc.) or install ${program}: ${archive}`);
    }
  }
}

// The limit of one segment of a file name (NTFS, in UTF-16 characters)
const MAX_NAME_LENGTH = 255;
// If even one segment of a path exceeds the limit, it cannot be created. zip failed at the final rename after bundling under a short temporary name, and unzip failed with a raw ENOENT when creating the extraction folder,
// and the preview looked like a success, so it refuses first, including in the preview (#228).
function rejectLongName(target, what) {
  const full = path.resolve(target);
  const long = full.split(/[\\/]/).slice(1).find((part) => part.length > MAX_NAME_LENGTH);
  if (long !== undefined) {
    throw new FcError(`The ${what} path has a name of ${long.length} characters, so it cannot be created (one name can be up to ${MAX_NAME_LENGTH} characters): ${long.slice(0, 40)}… (${target})`);
  }
}

// tar.exe moves into the folder given with -C, and if that path is longer than this, it fails raw with "could not chdir" (up to 258 UTF-16 characters works).
// It was measured both on this PC (LongPathsEnabled=0) and on CI with long paths turned on (GitHub windows-latest). The tar.exe manifest is longPathAware, but
// it does not apply to changing the working folder (second review). The extraction folder of unzip and the parent folder of the zip source are passed with -C, so it refuses in advance (#228).
const MAX_TAR_DIR = 258;
function rejectLongTarDir(dir, what) {
  const full = path.resolve(dir);
  if (full.length > MAX_TAR_DIR) {
    throw new FcError(`The ${what} path is ${full.length} characters, so tar.exe cannot change into that folder (up to ${MAX_TAR_DIR}). Specify a shorter path: ${dir}`);
  }
}

// zip bundles into a temporary file in the same folder (.fctl-new-<pid>-<time>-<number><extension layers>) and then renames it. If the extension layers are very long (all layers are moved since #193),
// the temporary name exceeds the limit and tar.exe fails with a raw error, so it refuses in advance (#213). It leaves a few characters as room for the number to grow.
const TEMP_SERIAL_RESERVE = 4;
// tar.exe can extract only up to this many compression layers. From 25 layers it bundles, but when reading it fails with "Input requires too many filters for decoding"
// (measured on build 26200, both gzip and xz). It is refused too, so as not to make an archive that cannot be extracted again (#213).
const MAX_TAR_LAYERS = 24;
function rejectLongTempName(archive) {
  const ext = archiveExt(archive);
  const layers = ext.split('.').filter((part) => part !== '' && isLayerExt(part)).length;
  if (layers > MAX_TAR_LAYERS) {
    throw new FcError(`The archive extension has ${layers} layers, so tar.exe cannot extract it again (up to ${MAX_TAR_LAYERS} layers). Shorten the extension and specify it again: ${archive}`);
  }
  const length = `.fctl-new-${process.pid}-${Date.now()}-0`.length + TEMP_SERIAL_RESERVE + ext.length;
  if (length > MAX_NAME_LENGTH) {
    throw new FcError(`The extension is too long (${ext.length} characters), so the temporary file name used while bundling exceeds ${MAX_NAME_LENGTH} characters. Shorten the extension and specify it again: ${archive}`);
  }
}

function zip(archive, sources, { force = false, dryRun = false } = {}) {
  ensureFree(archive, force);
  // Wrapping 7z in one more compression layer makes tar.exe unable to seek back and forth (Seek error), so it cannot be extracted (#164).
  if (archiveExt(archive).startsWith('.7z.')) throw new FcError(`A 7z archive cannot be wrapped in another archive. tar.exe cannot extract it: ${archive}`);
  rejectLongName(archive, 'archive file');
  rejectLongTempName(archive);
  rejectMissingCompressor(archive);
  rejectNewDeviceName(archive);
  sources.forEach(ensureExists);
  for (const src of sources) rejectLongTarDir(path.dirname(path.resolve(src)), "source's parent folder");
  [archive, ...sources].forEach(rejectStreamPath);
  // There is no name to pass to tar, and before that it would scan the whole drive, so it refuses first.
  const root = sources.find((src) => path.basename(path.resolve(src)) === '');
  if (root !== undefined) throw new FcError(`Cannot bundle a drive root: ${root}`);
  // If the archive itself is bundled, the archive set aside cannot be found, or the archive itself goes in instead of the original content.
  const self = sources.find((src) => realKey(src) === realKey(archive) || isSameFile(src, archive));
  if (self !== undefined) throw new FcError(`Cannot bundle the archive into itself: ${self}`);
  // Sources are bundled under their top-level name, so for sources with the same name, only one remains when extracted over each other from the archive. Windows is case-insensitive.
  const seen = new Map();
  for (const src of sources) {
    const name = path.basename(path.resolve(src));
    // toLowerCase makes ΑΣ and ασ, which are the same name on NTFS, different, so it compares in upper case (the same as flatten.js).
    const key = isWindows ? name.toUpperCase() : name;
    if (seen.has(key)) throw new FcError(`Sources with the same name cannot be bundled together. Only one would remain when extracting: ${seen.get(key)}, ${src}`);
    seen.set(key, src);
  }
  const inside = sources.map(namesInside);
  if (isWindows) rejectShortNameClash(sources, inside);
  ensureParentDir(archive);
  if (exists(archive) && fs.statSync(archive).isDirectory()) throw new FcError(`Cannot overwrite a folder: ${archive}`);
  const entries = [...sources.map((src) => path.basename(path.resolve(src))), ...inside.flat()];
  ensureTarArgs([path.resolve(archive), ...sources.map((src) => path.resolve(src))], entries, { oemEntries: !ANSI_ENTRY_EXT.has(innerEntryExt(archiveExt(archive))) });
  return perform(`Compress: ${sources.join(', ')} -> ${archive}${overwriteNote(archive, dryRun)}`, dryRun, () => writeArchive(archive, sources));
}

module.exports = {
  rejectHardLinkedWrite,
  FcError,
  perform,
  formatSize,
  list,
  makeDir,
  writeFile,
  readFile,
  rename,
  move,
  copy,
  remove,
  recycleBinState,
  permanentDeleteReason,
  UNKNOWN_RECYCLE_LIMIT,
  RECYCLE_STATE_SCRIPT,
  RECYCLE_SCRIPT,
  previewRefusal,
  sizeUpTo,
  hiddenOrSystemEntries,
  recycleEmptyFolders,
  RECYCLE_FOLDERS_SCRIPT,
  recycleFiles,
  RECYCLE_FILES_SCRIPT,
  permanentRefusal,
  recycleFailureMessage,
  bareDeviceInside,
  MAX_RECYCLE_PATH,
  decodeReason,
  busyInside,
  recycleTarget,
  unzip,
  archiveEntries,
  archiveNames, probeArchive, archiveExt,
  unsupportedChars,
  oemCodePage,
  couldBeShortNameOf,
  rejectExtractShortNameClash,
  ensureRoomToExtract,
  freshPath,
  MAX_TAR_DIR,
  TEMP_SERIAL_RESERVE,
  missingProgram,
  zip,
};
