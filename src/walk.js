'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { resolveTarget } = require('./protectedPaths');

// The change journal of fctl lives in this folder inside the folder it worked on (#415). A listing never shows it, so no command moves, renames, counts or removes it by accident.
const JOURNAL_FOLDER = '.fctl-journal';

// It reads under the target recursively and returns a list of files, folders, and links. It does not include the target itself.
// Symbolic links and junctions are included only as type 'link' and are not followed into.
// The result is sorted by relative path, and a folder comes before the items inside it.
// If even one subfolder cannot be read, the whole thing fails. This is so that nothing is moved or deleted from a partly read list.
// For work done file by file (product-number), if an unreadable array is passed, it puts the subfolders that could not be read as { path, relative, reason }
// and keeps reading the rest (#74). If the target itself cannot be read or a folder is replaced by a link while reading, the whole thing still fails.
function walk(dir, { unreadable } = {}) {
  const entries = listEntries(resolveTarget(dir), unreadable).sort((a, b) => compareRelative(a.relative, b.relative));
  unreadable?.sort((a, b) => compareRelative(a.relative, b.relative));
  return entries;
}

// Folder read errors that it is fine to skip and continue past. Permission denied, and the case where a folder disappeared or became a file after the list was made.
// Other errors (EMFILE, EIO, and so on) are temporary or of unknown cause, so the whole thing fails as before (first review).
const SKIPPABLE_READ_ERRORS = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR']);

// Subfolders are put in the list and read later, so if a folder is replaced by a link or junction in between, a different place would be read (#46).
// After reading, it checks whether the real path is still at that position, and if it changed, it raises an error without giving the list. Whether it changed before reading and stayed,
// or changed while reading, both are caught. Changing it before reading and restoring it after reading and before the check cannot be blocked with a synchronous API.
// root is a real path that resolveTarget or realInside returned, so the real path of an unchanged folder is root and the names below it as they are.
// It also checks root itself. rejectLinksInside passes the folder that realInside just returned as root.
function ensureUnmoved(dir) {
  let real;
  try {
    real = fs.realpathSync.native(dir);
  } catch (err) {
    throw new FcError(`Cannot read the folder: ${dir} (${err.code})`);
  }
  if (real !== dir) throw new FcError(`The folder was turned into a link while reading and now points elsewhere. Nothing was touched: ${dir} -> ${real}`);
}

function listEntries(root, unreadable) {
  const entries = [];
  const pending = [''];
  while (pending.length > 0) {
    const relDir = pending.pop();
    const dir = path.join(root, relDir);
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (unreadable && relDir !== '' && SKIPPABLE_READ_ERRORS.has(err.code)) {
        unreadable.push({ path: dir, relative: relDir, reason: `Skipped the contents because the folder could not be read: ${err.code}` });
        continue;
      }
      throw new FcError(`Cannot read the folder: ${dir} (${err.code})`);
    }
    ensureUnmoved(dir);
    for (const dirent of dirents) {
      if (dirent.name.toLowerCase() === JOURNAL_FOLDER && dirent.isDirectory()) continue;
      const relative = path.join(relDir, dirent.name);
      const type = dirent.isSymbolicLink() ? 'link' : dirent.isDirectory() ? 'dir' : 'file';
      entries.push({ path: path.join(root, relative), relative, type });
      if (type === 'dir') pending.push(relative);
    }
  }
  return entries;
}

// It compares by path segment so that 'a/b' comes right after 'a' rather than after 'a b' or 'a.txt'.
// Like Windows Explorer, it ignores case, and if only the case differs, it fixes the order by the original string.
function compareRelative(a, b) {
  const pa = a.split(path.sep);
  const pb = b.split(path.sep);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const order = compareName(pa[i].toLowerCase(), pb[i].toLowerCase()) || compareName(pa[i], pb[i]);
    if (order !== 0) return order;
  }
  return pa.length - pb.length;
}

function compareName(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

module.exports = { walk, listEntries, compareRelative, JOURNAL_FOLDER };
