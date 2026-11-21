'use strict';

// The basic file commands: ls, mkdir, write, cat, rename, mv and cp with their checks (#315).

const fs = require('node:fs');
const path = require('node:path');
const { FcError, checkOverwrite, ensureCanMakeDir, ensureExists, ensureFree, ensureItemExists, ensureNotIntoSelf, ensureParentDir, entryKey, exists, isSameOrUnder, isWindows, lexists, overwriteNote, pathKey, perform, realKey, rejectHardLinkedWrite, rejectNewDeviceName, targetNote } = require('./base');
const { permanentRefusal, previewRefusal, remove } = require('./recycle');

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
      let statError;
      try {
        stat = fs.statSync(full, { throwIfNoEntry: false });
      } catch (err) {
        stat = undefined;
        statError = err;
      }
      // Junctions and symbolic links are links, not files or folders (#267). linkTo says what the target is: 'dir', 'file', 'broken' (the target is missing), or 'unreadable' (the target exists but cannot be read, such as EPERM).
      if (entry.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.readlinkSync(full).replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
        } catch {
          // The link text cannot be read. The target stays unknown.
        }
        return { name: entry.name, type: 'link', linkTo: stat ? (stat.isDirectory() ? 'dir' : 'file') : statError && statError.code !== 'ENOENT' && statError.code !== 'ENOTDIR' ? 'unreadable' : 'broken', target, size: null, modified: stat ? stat.mtime : null };
      }
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: stat && !entry.isDirectory() ? stat.size : null,
        modified: stat ? stat.mtime : null,
      };
    })
    // Folders and links to folders come first, then files and the other links.
    .sort((a, b) => {
      const rank = (e) => (e.type === 'dir' || e.linkTo === 'dir' ? 0 : 1);
      return rank(a) === rank(b) ? a.name.localeCompare(b.name) : rank(a) - rank(b);
    });
}

function makeDir(dir, { dryRun = false } = {}) {
  if (lexists(dir) && !exists(dir)) throw new FcError(`Already exists: ${dir} (a link whose target is missing)`);
  rejectNewDeviceName(dir);
  if (dryRun) ensureCanMakeDir(dir);
  const note = dryRun && exists(dir) ? ' (already exists)' : '';
  return perform(`Create folder: ${dir}${note}`, dryRun, () => fs.mkdirSync(dir, { recursive: true }));
}

function writeFile(file, content, { append = false, force = false, dryRun = false, info } = {}) {
  if (!append) ensureFree(file, force);
  // Writing through a link would land wherever it points, even outside the intended folder, so no link is written through (#312).
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new FcError(`Cannot write through a link: ${file}. Remove the link first.`);
  rejectNewDeviceName(file);
  rejectHardLinkedWrite(file);
  if (dryRun) {
    ensureCanMakeDir(path.dirname(file));
    if (exists(file) && fs.statSync(file).isDirectory()) throw new FcError(`Cannot write to a folder: ${file}`);
  }
  const note = append ? '' : overwriteNote(file, dryRun, info);
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

function rename(target, newName, { force = false, dryRun = false, info } = {}) {
  ensureItemExists(target);
  if (newName.includes('/') || newName.includes('\\')) {
    throw new FcError('The new name cannot contain a path. Use mv to move.');
  }
  const dest = path.join(path.dirname(target), newName);
  ensureFree(dest, force);
  rejectNewDeviceName(dest);
  // Changing only the case of itself is not an overwrite. "Itself" is decided by volume and file number, not by lowercased names (#302).
  if (dryRun && exists(dest) && !isSameItem(target, dest) && fs.statSync(dest).isDirectory()) throw new FcError(`Cannot overwrite a folder: ${dest}`);
  return perform(`Rename: ${target} -> ${dest}${overwriteNote(dest, dryRun, info)}`, dryRun, () => fs.renameSync(target, dest));
}

// fs.cpSync keeps the times of files with preserveTimestamps but not of folders, so the folder times are set after the copy (best effort: a folder time that cannot be set is not an error) (#313).
function copyFolderTimes(src, dest) {
  try {
    const stat = fs.lstatSync(src);
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory()) copyFolderTimes(path.join(src, entry.name), path.join(dest, entry.name));
    }
    fs.utimesSync(dest, stat.atime, stat.mtime);
  } catch {
    // The times are a nicety; the content was copied.
  }
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
      fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
      copyFolderTimes(src, dest);
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
// The replaced destination goes to the Recycle Bin like rm, so it can be brought back; permanent deletes it for good (#311).
function moveReplacing(src, target, { permanent = false } = {}) {
  if (!lexists(target)) return moveOne(src, target);
  const aside = asidePath(target);
  fs.renameSync(target, aside);
  try {
    moveOne(src, target);
  } catch (err) {
    // If the copy finished and the target exists, only the cleanup of the source failed, so it does not roll back.
    if (lexists(target)) throw new FcError(`Moved, but the source could not be fully deleted: ${src} (${err.code}). The previous destination is at ${aside}.`);
    try {
      fs.renameSync(aside, target);
    } catch (restoreErr) {
      throw new FcError(`Could not move, and could not restore the previous destination either: ${src} (${err.code}, ${restoreErr.code}). The previous destination is at ${aside}.`);
    }
    throw err;
  }
  try {
    remove([aside], { permanent, checkVolume: false });
  } catch (err) {
    throw new FcError(`Moved, but could not ${permanent ? 'delete' : 'send to the Recycle Bin'} the previous destination: ${aside} (${err.message})`);
  }
}

// It compares by volume and file ID so that it also catches aliases such as \\localhost\C$ that look different as real paths.
function isSameFile(a, b) {
  const statA = fs.statSync(a, { bigint: true, throwIfNoEntry: false });
  const statB = fs.statSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(statA && statB) && statA.ino !== 0n && statA.dev === statB.dev && statA.ino === statB.ino;
}

// Whether two paths are the same item itself (not what a link leads to): the same volume and file number, refusing file number 0 as isSameFile does.
// Names are not enough, because NTFS folds case with its own table (KELVIN SIGN and k are two names) and a folder can be case-sensitive (#302).
function isSameItem(a, b) {
  try {
    const one = fs.lstatSync(a, { bigint: true });
    const two = fs.lstatSync(b, { bigint: true });
    return one.ino !== 0n && one.dev === two.dev && one.ino === two.ino;
  } catch {
    return false;
  }
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

function move(sources, dest, { force = false, dryRun = false, permanent = false, info } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`To move several items, the destination must be an existing folder: ${dest}`);
  }
  // It runs after checking everything, so that if it fails, nothing has been moved.
  const items = sources.map((src) => {
    ensureItemExists(src);
    rejectStreamPath(src);
    rejectCurrentDir(src);
    // It resolves the names so that a source ending in d/. uses the same target as d.
    const target = resolveDest(path.resolve(src), dest);
    rejectStreamPath(target);
    rejectCurrentDir(target);
    ensureFree(target, force);
    // Before anything moves, the replaced destination must be able to go to the Recycle Bin (the preview too), as rm checks (#311).
    if (force && !permanent && lexists(target)) {
      // The replaced item is sent under a short temporary name, so its own name length and device names do not matter; the volume setting and size do.
      if (!isWindows) throw new FcError('Sending the replaced destination to the Recycle Bin works only on Windows. To delete it permanently instead, use --permanent');
      const why = previewRefusal(path.resolve(target));
      if (why !== null) throw new FcError(`${permanentRefusal(path.resolve(target), why, false)} Nothing was moved. To delete the replaced item permanently instead, use --permanent.`);
    }
    rejectNewDeviceName(target);
    ensureParentDir(target);
    rejectMoveOverlap(src, target);
    return { src, target };
  });
  rejectBatchOverlap(items);
  const planned = new Set();
  const done = [];
  for (const { src, target } of items) {
    const where = permanent ? 'it is deleted permanently' : 'the old one goes to the Recycle Bin';
    const note = dryRun ? targetNote(planned, target, force, ` (replaces the whole existing folder; ${where})`, ` (overwrites; ${where})`, info) : '';
    try {
      done.push(perform(`Move: ${src} -> ${target}${note}`, dryRun, () => moveReplacing(src, target, { permanent })));
    } catch (err) {
      // The earlier items have already been moved, so just raising an error would not tell what was moved.
      if (done.length === 0) throw err;
      throw new FcError(`${err.message}\nItems already handled:\n${done.join('\n')}`);
    }
  }
  return done;
}

function copy(sources, dest, { force = false, dryRun = false, info } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`To copy several items, the destination must be an existing folder: ${dest}`);
  }
  // For overwriting and merging (which happen only with --force), it first looks at everything so that nothing is copied even if only one of several sources has a problem (#48, #140).
  // Sources that gather into the same target are also merged with the target after an earlier source was copied, so it also checks while seeing the earlier source as the target.
  if (force) {
    const earlier = new Map();
    for (const src of sources) {
      ensureExists(src);
      const target = resolveDest(path.resolve(src), dest);
      checkOverwrite(src, target);
      const key = pathKey(target);
      for (const before of earlier.get(key) ?? []) {
        if (!isSameItem(before, src)) checkOverwrite(src, before, { hardLinks: false });
      }
      earlier.set(key, [...(earlier.get(key) ?? []), src]);
    }
  }
  // The checks for every source run before the first copy, so that one bad source copies nothing (#313). The names are resolved first, as move does,
  // so that a source ending in d/. uses the same target as d.
  const items = sources.map((src) => {
    ensureExists(src);
    const target = resolveDest(path.resolve(src), dest);
    // When copying never ends because of a link inside a source (#142), nothing is copied, even in the preview and even if only one of several sources is like that.
    rejectLoopingLinks(src, target);
    ensureFree(target, force);
    rejectNewDeviceName(target);
    rejectCopyIntoSelf(src, target);
    return { src, target };
  });
  // Two sources with the same name would gather into one target, and the second would fail after the first was copied.
  if (!force) {
    const seen = new Map();
    for (const { src, target } of items) {
      const key = pathKey(target);
      if (seen.has(key)) throw new FcError(`Several sources go to the same destination: ${target} (${seen.get(key)}, ${src})`);
      seen.set(key, src);
    }
  }
  if (dryRun) {
    for (const { src, target } of items) {
      ensureCanMakeDir(path.dirname(target));
      ensureNotIntoSelf(src, target);
      if (exists(target) && fs.statSync(src).isDirectory() !== fs.statSync(target).isDirectory()) {
        throw new FcError(`A file and a folder cannot overwrite each other: ${src} -> ${target}`);
      }
    }
  }
  const planned = new Set();
  return items.map(({ src, target }) => {
    const note = dryRun ? targetNote(planned, target, force, ' (merged into the folder, files with the same name are overwritten)', ' (overwrites)', info) : '';
    return perform(`Copy: ${src} -> ${target}${note}`, dryRun, () => fs.cpSync(src, target, { recursive: true, force }));
  });
}

module.exports = {
  asidePath,
  copy,
  formatSize,
  freshPath,
  hasAncestorSameAs,
  isSameFile,
  list,
  makeDir,
  move,
  readFile,
  rejectStreamPath,
  rename,
  resolveDest,
  writeFile,
};
