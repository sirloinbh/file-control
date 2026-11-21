'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, rejectHardLinkedWrite } = require('./commands');
const { WINDOWS_DEVICE_NAME } = require('./windowsNames');
const { resolveTarget, isInside, TRAILING_DOT_OR_SPACE } = require('./protectedPaths');
const { listEntries } = require('./walk');

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
        // A programming error (TypeError and the like) has no code: show its message instead of "undefined" (#318).
        throw new FcError(`Cannot check the path: ${p} (${err.code ?? err.message})`);
      }
    };
  }
  return Object.freeze(access);
}

// The maximum number of bytes that can be read into a Buffer at once (Node's file read limit)
const MAX_READ = 2 ** 31 - 1;

// It checks a file through the read permission of `access` (the same checks as access.read) and returns its real path.
function readableFile(access, p) {
  const real = access.read(p);
  if (!fs.statSync(real).isFile()) throw new FcError(`Not a file: ${p}`);
  return real;
}

// It reads length bytes from offset of a file inside the target. If it goes past the end of the file, it returns only what exists.
// A header (magic number) is read at offset 0, and a structure in the middle, such as a container box, is read at that position.
// Even if it receives the large length of a damaged header as is, it allocates memory only for what the real file has.
function readRange(access, p, { offset = 0, length } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FcError(`Invalid offset: ${offset}`);
  if (!Number.isSafeInteger(length) || length < 0) throw new FcError(`Invalid length: ${length}`);
  if (length > MAX_READ) throw new FcError(`Exceeds the length that can be read at once (${MAX_READ} bytes): ${length}`);
  const fd = fs.openSync(readableFile(access, p), 'r');
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
function fileSizeInside(access, p) {
  return fs.statSync(readableFile(access, p)).size;
}

module.exports = { grant, readRange, fileSizeInside, rejectAmbiguousNames };
