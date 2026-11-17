'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError, rejectHardLinkedWrite } = require('./commands');
const { WINDOWS_DEVICE_NAME, deviceNamePattern } = require('./windowsNames');

// It normalizes the target directory to a real absolute path. If it does not exist or is not a folder, it raises an error.
// It also refuses a folder that is inside a protected path or contains a protected path (C:\, the user folder, and so on).
function resolveTarget(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new FcError('Specify a target folder.');
  if (dir.includes('\0')) throw new FcError('The target path contains a NUL character.');
  const abs = path.resolve(dir);
  rejectNetworkPath(abs);
  // A folder you have no permission to see, such as System Volume Information, Recovery, and another user's AppData, cannot be checked, so it is not accepted.
  const unreadable = (err) => new FcError(`Cannot use the target folder because it cannot be checked: ${abs} (${err.code ?? err.message})`);
  let stat;
  try {
    stat = fs.statSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    throw unreadable(err);
  }
  if (!stat) throw new FcError(`Target folder does not exist: ${abs}`);
  if (!stat.isDirectory()) throw new FcError(`Target is not a folder: ${abs}`);
  // It matches case, 8.3 short names, and drive letter spelling to one real path.
  let target;
  try {
    target = fs.realpathSync.native(abs);
  } catch (err) {
    throw unreadable(err);
  }
  rejectNetworkPath(target);
  rejectTrailingDotOrSpace(target);
  const reason = protectedReason(target);
  if (reason) throw new FcError(`Cannot use a protected path as the target: ${target} (${reason})`);
  return target;
}

// UNC and network paths (\\server\share, \\localhost\C$, and so on) can bypass protected paths, so they are not accepted as a target.
// It allows only long path prefixes that point to a local drive, such as \\?\C:\.
function rejectNetworkPath(p) {
  if (process.platform !== 'win32') return;
  if (p.startsWith('\\\\') && !/^\\\\\?\\[A-Za-z]:/.test(p)) {
    throw new FcError(`Cannot use a network path as the target: ${p}`);
  }
}

// Node sees a trailing dot or space literally, but PowerShell, tar.exe, and .NET remove it.
// AppData. If the same folder is accepted as the target, it becomes AppData in those tools and bypasses the protected path.
const TRAILING_DOT_OR_SPACE = /[\s\u0085.]$/;

function rejectTrailingDotOrSpace(target) {
  if (process.platform !== 'win32') return;
  const name = target.slice(path.parse(target).root.length).split(path.sep).find((part) => TRAILING_DOT_OR_SPACE.test(part));
  if (name !== undefined) throw new FcError(`Cannot use a folder whose name ends with a dot or space as the target: ${target}`);
}

// It aligns the protected reference paths the same way as the target (real path). If the path does not exist, it uses it as is.
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// Windows system folders. If the environment variable is missing or not an absolute path, it uses the default location.
// In 32-bit Node, ProgramFiles points to the x86 folder, so the 64-bit folder is looked at separately with ProgramW6432.
// C:\Users\All Users is a link that points to ProgramData, so aligning to the real path lands on ProgramData (#50).
function systemRoots() {
  if (process.platform !== 'win32') return [];
  const env = process.env;
  const pick = (value, fallback) => (value && path.isAbsolute(value) ? value : fallback);
  const systemDrive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive : 'C:';
  return [
    pick(env.SystemRoot, 'C:\\Windows'),
    pick(env.ProgramFiles, 'C:\\Program Files'),
    pick(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)'),
    pick(env.ProgramW6432, 'C:\\Program Files'),
    pick(env.ProgramData, pick(env.ALLUSERSPROFILE, 'C:\\ProgramData')),
    `${systemDrive}\\Recovery`,
  ].map(realOrResolved);
}

// The system hidden folders at the root of each drive (the Recycle Bin, restore points). The names come out in mixed case (C:\$Recycle.Bin, D:\$RECYCLE.BIN).
const DRIVE_SYSTEM_FOLDERS = ['$recycle.bin', 'system volume information'];

// A drive root can get a Recycle Bin at any time (on the first rm), so it is blocked regardless of whether it exists.
// It does not recognize the root of a volume mounted on a folder (C:\mnt\vol).
function driveSystemReason(target) {
  if (process.platform !== 'win32') return null;
  const { root } = path.parse(target);
  const [first] = target.slice(root.length).split(path.sep);
  if (!first) return `drive root ${root} (holds or will hold the Recycle Bin and System Volume Information)`;
  if (DRIVE_SYSTEM_FOLDERS.includes(first.toLowerCase())) return `system folder ${path.join(root, first)}`;
  return null;
}

// Other profiles under the profile folder (C:\Users). Public is an ordinary shared folder, so it is allowed, and
// Default is the original profile of new users, so it is blocked as a whole. For other users, like the current user, the profile itself and the hidden settings folders are blocked.
// The profile folder is found as the parent of PUBLIC (C:\Users\Public). This rule is used only when the user folder is directly under it.
// This is so that, when the user folder was moved elsewhere, its sibling folders are not wrongly seen as other users.
function profilesDir() {
  const env = process.env;
  const systemDrive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive : 'C:';
  const pub = env.PUBLIC && path.isAbsolute(env.PUBLIC) ? env.PUBLIC : `${systemDrive}\\Users\\Public`;
  return realOrResolved(path.dirname(pub));
}

function otherProfileReason(target, home) {
  if (process.platform !== 'win32') return null;
  const profiles = profilesDir();
  // path.relative is case-insensitive on Windows.
  if (profiles === path.parse(profiles).root || path.relative(profiles, path.dirname(home)) !== '' || !isInside(profiles, target)) return null;
  const rel = path.relative(profiles, target);
  if (rel === '') return null;
  const [name, sub] = rel.split(path.sep);
  const lower = name.toLowerCase();
  if (lower === 'public') return null;
  const profile = path.join(profiles, name);
  if (lower === 'default' || lower === 'default user') return `default user profile ${profile}`;
  if (sub === undefined) return `another user's folder ${profile}`;
  if (isHiddenSettings(sub)) return `another user's settings folder ${path.join(profile, sub)}`;
  return null;
}

function homeDir() {
  let home;
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (!home || !path.isAbsolute(home)) throw new FcError('Cannot check protected paths because the user folder is unknown.');
  return realOrResolved(home);
}

// It checks whether it is a hidden settings folder directly under the user folder (a folder starting with a dot such as .ssh and .config, and AppData).
function isHiddenSettings(name) {
  return name.startsWith('.') || name.toLowerCase() === 'appdata';
}

// If the target overlaps a protected path, it returns the reason; otherwise null.
function protectedReason(target) {
  for (const root of systemRoots()) {
    if (isInside(root, target)) return `system folder ${root}`;
    if (isInside(target, root)) return `contains system folder ${root}`;
  }
  const drive = driveSystemReason(target);
  if (drive) return drive;
  const home = homeDir();
  if (isInside(target, home)) return `contains user folder ${home}`;
  if (isInside(home, target)) {
    const [first] = path.relative(home, target).split(path.sep);
    if (isHiddenSettings(first)) return `user settings folder ${path.join(home, first)}`;
    return null;
  }
  return otherProfileReason(target, home);
}

// True if p (a path relative to the target or an absolute path) is the target itself or inside it.
// On Windows it is case-insensitive, and another drive is seen as outside. Links are not considered.
function isInside(target, p) {
  const rel = path.relative(target, path.resolve(target, p));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

// It turns p into an absolute path relative to the target. If it is outside the target, it raises an error.
function resolveInside(target, p) {
  const abs = path.resolve(target, p);
  if (!isInside(target, abs)) throw new FcError(`Path is outside the target folder: ${abs} (target: ${target})`);
  return abs;
}

// It returns the real path of an existing path with links and junctions resolved. If the real path is outside the target, it raises an error.
function realInside(target, abs) {
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new FcError(`Path does not exist or is a broken link: ${abs}`);
    throw err;
  }
  // Both are real paths, so they are compared literally. The case-insensitivity of isInside is wider than NTFS (K and U+212A), so it would see a sibling folder as inside.
  const prefix = target.endsWith(path.sep) ? target : target + path.sep;
  if (real !== target && !real.startsWith(prefix)) throw new FcError(`Path points outside the target folder through a link: ${abs} -> ${real}`);
  return real;
}

// It finds a file inside the target and returns its real path. target must be the path that resolveTarget returned.
// Not only the path string but also the real path with links and junctions resolved must be inside the target.
function resolveFileInside(target, p) {
  const abs = resolveInside(target, p);
  const real = realInside(target, abs);
  if (!fs.statSync(real).isFile()) throw new FcError(`Not a file: ${abs}`);
  return real;
}

// Node uses names literally, but PowerShell, tar.exe, and .NET remove a trailing dot and space and interpret streams (:) and device names separately.
// So that the checked path and the real work path do not diverge, it refuses such names and names that contain characters unusable on Windows.
const WINDOWS_BAD_CHARS = /[:<>"|?*\x00-\x1f]/;
// The device name rule is placed in windowsNames.js to be shared with the basic commands (src/commands.js) (#53, #135).

function rejectAmbiguousNames(rel, p) {
  if (process.platform !== 'win32') return;
  const name = rel.split(path.sep).find((part) => TRAILING_DOT_OR_SPACE.test(part) || WINDOWS_BAD_CHARS.test(part) || WINDOWS_DEVICE_NAME.test(part));
  if (name !== undefined) throw new FcError(`Name may be interpreted differently on Windows: ${JSON.stringify(name)} (${p})`);
}

// It returns an absolute path normalized against the target. If it is outside the target or a name that Windows interprets in different ways, it raises an error.
function resolveAccessPath(target, p) {
  const abs = resolveInside(target, p);
  // path.relative sees K and U+212A as the same, so it keeps the path of such a sibling folder from turning into another file inside the target.
  if (abs.slice(0, target.length).toUpperCase() !== target.toUpperCase()) throw new FcError(`Path is outside the target folder: ${abs} (target: ${target})`);
  const rel = path.relative(target, abs);
  rejectAmbiguousNames(rel, p);
  return path.join(target, rel);
}

// It runs the same name check on the real path with links resolved. Even if the input is ordinary, such a name can come out through a junction.
function realForAccess(target, abs) {
  const real = realInside(target, abs);
  rejectAmbiguousNames(path.relative(target, real), real);
  return real;
}

// tar, cpSync, and extraction follow junctions inside a folder, so a folder that holds a link is not handed to any work.
function rejectLinksInside(real, abs) {
  if (!fs.statSync(real).isDirectory()) return;
  const link = listEntries(real).find((entry) => entry.type === 'link');
  if (link) throw new FcError(`Cannot handle a folder that contains a link: ${abs} (link: ${link.path})`);
}

function checkRead(target, p) {
  const abs = resolveAccessPath(target, p);
  const real = realForAccess(target, abs);
  rejectLinksInside(real, abs);
  return real;
}

// A path that does not exist yet can also be used, so it goes up to the nearest path that exists and checks that real path.
// A broken link is caught as an existing path and refused. If used as is, a file would be created outside the target that the link points to.
function checkWrite(target, p) {
  const abs = resolveAccessPath(target, p);
  let existing = abs;
  while (existing !== target && !fs.lstatSync(existing, { throwIfNoEntry: false })) existing = path.dirname(existing);
  const real = realForAccess(target, existing);
  if (existing === abs) {
    if (real === target) throw new FcError(`Cannot write to the target folder itself: ${abs}`);
    rejectLinksInside(real, abs);
    // A hard link cannot be told by path from a file outside the target. Reading and deleting are left as they are, and only writes that change the content are refused (#48).
    rejectHardLinkedWrite(real);
    return real;
  }
  if (!fs.statSync(real).isDirectory()) throw new FcError(`Cannot write below a file: ${abs} (${real})`);
  return path.join(real, path.relative(existing, abs));
}

// The link itself is not deleted. This avoids the risk of following the link, depending on the deletion method such as the Recycle Bin.
function checkDelete(target, p) {
  const abs = resolveAccessPath(target, p);
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (stat && stat.isSymbolicLink()) throw new FcError(`Cannot delete a link: ${abs}`);
  const real = realForAccess(target, abs);
  if (real === target) throw new FcError(`Cannot delete the target folder itself: ${abs}`);
  rejectLinksInside(real, abs);
  return real;
}

const ACCESS = {
  read: { name: 'Read', check: checkRead },
  write: { name: 'Write', check: checkWrite },
  delete: { name: 'Delete', check: checkDelete },
};

// It grants a target permissions per kind of work ('read', 'write', 'delete'). Protected paths are refused by resolveTarget, and
// a real path inside the target cannot overlap a protected path, so each check looks only at whether it is inside the target.
// access.read(p), write(p), and delete(p) check the path and return the path to use for the real work, and change nothing.
// The folder can change between the check and the work, so call it right before the work and use the returned path as it is.
function grant(dir, kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) throw new FcError('Specify the permissions to grant. (read, write, delete)');
  if (kinds.findIndex((kind) => typeof kind !== 'string' || !Object.hasOwn(ACCESS, kind)) !== -1) {
    throw new FcError('Unknown permission. (only read, write, delete are allowed)');
  }
  const granted = new Set(kinds);
  const target = resolveTarget(dir);
  const access = { target };
  for (const [kind, { name, check }] of Object.entries(ACCESS)) {
    access[kind] = (p) => {
      if (typeof p !== 'string') throw new FcError('Paths must be strings.');
      if (!granted.has(kind)) throw new FcError(`No ${name} permission: ${p} (target: ${target})`);
      try {
        return check(target, p);
      } catch (err) {
        if (err instanceof FcError) throw err;
        throw new FcError(`Cannot check the path: ${p} (${err.code})`);
      }
    };
  }
  return Object.freeze(access);
}

// The maximum number of bytes that can be read into a Buffer at once (Node's file read limit)
const MAX_READ = 2 ** 31 - 1;

// It reads the whole content of a file inside the target into a Buffer. A file larger than MAX_READ is read in parts with readRange.
function readInside(target, p) {
  const real = resolveFileInside(target, p);
  const { size } = fs.statSync(real);
  if (size > MAX_READ) throw new FcError(`File is too large to read at once: ${real} (${size} bytes, read it in pieces with readRange)`);
  return fs.readFileSync(real);
}

// It reads length bytes from offset of a file inside the target. If it goes past the end of the file, it returns only what exists.
// A header (magic number) is read at offset 0, and a structure in the middle, such as a container box, is read at that position.
// Even if it receives the large length of a damaged header as is, it allocates memory only for what the real file has.
function readRange(target, p, { offset = 0, length } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FcError(`Invalid offset: ${offset}`);
  if (!Number.isSafeInteger(length) || length < 0) throw new FcError(`Invalid length: ${length}`);
  if (length > MAX_READ) throw new FcError(`Exceeds the length that can be read at once (${MAX_READ} bytes): ${length}`);
  const fd = fs.openSync(resolveFileInside(target, p), 'r');
  try {
    const available = Math.max(0, fs.fstatSync(fd).size - offset);
    length = Math.min(length, available);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// It returns the size of a file inside the target in bytes.
function fileSizeInside(target, p) {
  return fs.statSync(resolveFileInside(target, p)).size;
}

// A value for comparing whether the file is unchanged. It takes the lstat result received as bigint. Even if the modification time is set back, the change time (ctime) differs.
function fileStamp(stat) {
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// File systems that do not record the change time (ctime). On exFAT the change time of every file comes out as the same value (#120),
// so a file rewritten with the same size and with the modification time set back cannot be recognized by fileStamp and the 5-minute protection (#184).
const NO_CHANGE_TIME = new Set(['FAT', 'FAT12', 'FAT16', 'FAT32', 'EXFAT']);
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The file system name (NTFS, ReFS, exFAT, and so on) of the volume where the target is. If it cannot be confirmed, it is null.
// It looks at the volume of the drive letter. Under a volume mount folder, the value of the drive where that folder lives comes out.
function volumeFormat(target) {
  if (process.platform !== 'win32') return null;
  const script = '[IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:FC_FORMAT_VOLUME)).DriveFormat';
  try {
    // It is looked up in the module on every call so that tests can intercept it.
    const output = childProcess.execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_FORMAT_VOLUME: path.resolve(target) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60 * 1000,
    });
    const found = /^(\w+)\s*$/.exec(String(output));
    return found ? found[1] : null;
  } catch {
    return null;
  }
}

// If it is a volume where a swap cannot be recognized by fileStamp, it returns the reason for not deleting; if it can be recognized, null.
// Even if the file system cannot be confirmed, it does not delete.
function stampVolumeReason(target) {
  const format = volumeFormat(target);
  if (format === null) return 'Kept because the file system could not be checked, so a file changed after the check could not be detected.';
  if (NO_CHANGE_TIME.has(format.toUpperCase())) return `Kept because ${format} volumes do not record change times, so a file changed to the same size after the check could not be detected.`;
  return null;
}

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

module.exports = { resolveTarget, isInside, resolveInside, readInside, readRange, fileSizeInside, fileStamp, volumeFormat, stampVolumeReason, walk, grant, rejectAmbiguousNames, compareRelative, deviceNamePattern, protectedReason };
