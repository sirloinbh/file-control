'use strict';

// The shared base of the file commands: platform constants, FcError, the existence checks, path keys and the preview helpers (#315).

const fs = require('node:fs');
const path = require('node:path');
const { BARE_DEVICE_NAME, deviceNamePart, isDeviceName } = require('./windowsNames');

// The platform values the modules read (#362). They are read through this object at call time (config.isWindows, config.tar, config.powershell),
// so a test sets them with withConfig() of test/withConfig.js and restores them, instead of reloading modules to get new constants.
const systemRoot = () => process.env.SystemRoot || 'C:\\Windows';
const config = {
  isWindows: process.platform === 'win32',
  // Instead of the GNU tar that comes with Git Bash and the like, it uses the Windows default bsdtar, which can handle zip.
  tar: process.platform === 'win32' ? path.join(systemRoot(), 'System32', 'tar.exe') : 'tar',
  powershell: path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
};

class FcError extends Error {}

function exists(p) {
  return fs.existsSync(p);
}

// Whether the item itself is there, without following a link. A dangling link (its target is gone) exists as an item (#312).
function lexists(p) {
  return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

function ensureExists(p) {
  if (!exists(p)) throw new FcError(`Path does not exist: ${p}`);
}

// For the commands that act on the item itself (rename, mv, rm): a dangling link is an item they can handle.
function ensureItemExists(p) {
  if (!lexists(p)) throw new FcError(`Path does not exist: ${p}`);
}

function ensureFree(p, force) {
  if (lexists(p) && !force) throw new FcError(`Already exists: ${p} (use --force to overwrite)`);
}

// Node creates names such as nul.mp4 and con.txt literally, but PowerShell and Explorer open them as devices, so the created file cannot be opened or deleted by other programs (#135).
// It leaves existing items so that they can be brought out by renaming, and refuses only names it newly creates. It does not examine an existing folder above (such as Con.Air).
// The judgment uses the same rule as grant (windowsNames.js).
function rejectNewDeviceName(p) {
  if (!config.isWindows) return;
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

// info is the structured side of the preview (#361): when the note says something is overwritten or replaced, it sets info.overwrites, so a screen never has to read the words.
function overwriteNote(p, dryRun, info) {
  if (!(dryRun && lexists(p))) return '';
  if (info) info.overwrites = true;
  return ' (overwrites)';
}

function pathKey(p) {
  const full = path.resolve(p);
  return config.isWindows ? full.toLowerCase() : full;
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
function targetNote(planned, target, force, dirNote, fileNote = ' (overwrites)', info) {
  const key = pathKey(target);
  if (planned.has(key)) {
    if (!force) throw new FcError(`Already exists: ${target} (an earlier item is handled under the same name)`);
    if (info) info.overwrites = true;
    return ' (overwrites: earlier item)';
  }
  planned.add(key);
  if (!lexists(target)) return '';
  if (info) info.overwrites = true;
  return exists(target) && fs.statSync(target).isDirectory() ? dirNote : fileNote;
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

module.exports = {
  FcError,
  config,
  checkOverwrite,
  claim,
  ensureCanMakeDir,
  ensureExists,
  ensureFree,
  ensureItemExists,
  ensureNotIntoSelf,
  ensureParentDir,
  entryKey,
  exists,
  isSameOrUnder,
  lexists,
  overwriteNote,
  pathKey,
  perform,
  realKey,
  rejectBareDeviceArgs,
  rejectHardLinkedWrite,
  rejectNewDeviceName,
  targetNote,
};
