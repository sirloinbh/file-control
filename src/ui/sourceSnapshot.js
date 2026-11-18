'use strict';

// A snapshot of what mv, cp and rm will touch (#280). Their dry-run result names only the given paths, so a file added, removed or changed
// inside a source folder after the preview would not change the fingerprint. The snapshot is added to what is fingerprinted.
// A junction or symlink is recorded as a link with its target. It is walked only where the command reads through it (see snapshotSources).
// With --force, mv and cp also replace or overwrite what is already at the destination, so that is snapshotted too (#284, see snapshotDestinations),
// and so are the item rename --force and zip --force overwrite (#297).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FcError, resolveDest } = require('../commands');

const MAX_ENTRIES = 200000;
const COMMANDS = new Set(['mv', 'cp', 'rm']);
// The commands that overwrite what is already there when given --force (see destinationPaths).
const DESTINATION_COMMANDS = new Set(['mv', 'cp', 'rename', 'zip']);

// The positional arguments of argv (after the command name). Only what is before a literal -- can be an option.
function positional(argv) {
  const end = argv.indexOf('--');
  const head = (end === -1 ? argv : argv.slice(0, end)).filter((arg) => !arg.startsWith('--') && arg !== '-h');
  return [...head, ...(end === -1 ? [] : argv.slice(end + 1))].slice(1);
}

// The paths the command reads from or deletes: mv and cp <source...> <dest>, rm <path...>.
function sourcePaths(command, argv) {
  if (!COMMANDS.has(command)) return [];
  const args = positional(argv);
  return command === 'rm' ? args : args.slice(0, -1);
}

function kindOf(stat) {
  if (stat.isSymbolicLink()) return 'link';
  return stat.isDirectory() ? 'dir' : 'file';
}

// Runs a file system call; any error becomes an FcError that names the path, like the cap error.
function guarded(where, call) {
  try {
    return call();
  } catch (err) {
    if (err instanceof FcError) throw err;
    throw new FcError(`${where} could not be read (${err.code || err.message}), so it cannot be checked for changes between the preview and the run and cannot be previewed here. Use the command line (fctl) for it.`);
  }
}

// { path, type: 'file' | 'dir' | 'link' | 'missing', count, size, digest, target? }
// count is the number of entries under a folder (not counting the folder itself), size the total size of the files in bytes, digest a hash of every entry's
// relative path, type, size and mtimeMs (and a link's target). Past maxEntries it throws instead of fingerprinting a partial snapshot.
// A link is recorded as a link and not followed, unless followLinks is on (cp: fs.cpSync on Windows copies what a junction holds, see rejectLoopingLinks in commands.js).
// With followLinks a link to a folder is walked, and a link to a folder already on the path being walked (a loop) is not walked again.
function snapshotSource(source, { maxEntries = MAX_ENTRIES, followLinks = false } = {}) {
  let top;
  try {
    top = fs.lstatSync(source);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { path: source, type: 'missing', count: 0, size: 0, digest: '' };
    guarded(source, () => { throw err; });
  }
  const hash = crypto.createHash('sha256');
  const record = (...parts) => hash.update(JSON.stringify(parts) + '\n');
  const type = kindOf(top);
  let count = 0;
  let size = 0;
  let target;
  record('.', type, top.size, top.mtimeMs);
  if (type === 'link') {
    target = guarded(source, () => fs.readlinkSync(source));
    record('->', target);
  }
  if (type === 'file') size = top.size;
  // The real path of the folder that full leads to (a folder, or a link to one when links are followed), or null when there is nothing to walk.
  const walkable = (full, kind) => {
    if (kind === 'dir') return guarded(full, () => fs.realpathSync(full));
    if (kind !== 'link' || !followLinks) return null;
    const real = guarded(full, () => {
      try {
        return fs.realpathSync(full);
      } catch (err) {
        if (err.code === 'ENOENT') return null; // a broken link has nothing to walk
        throw err;
      }
    });
    return real !== null && guarded(full, () => fs.statSync(real)).isDirectory() ? real : null;
  };
  const root = walkable(source, type);
  if (root !== null) {
    const stack = [{ full: source, rel: '', ancestors: [root] }];
    while (stack.length > 0) {
      const { full, rel, ancestors } = stack.pop();
      const names = guarded(full, () => fs.readdirSync(full)).sort();
      const dirs = [];
      for (const name of names) {
        if (++count > maxEntries) {
          throw new FcError(`${source} holds more than ${maxEntries} entries, too many to check for changes between the preview and the run, so it cannot be previewed here. Use the command line (fctl) for it.`);
        }
        const child = `${full}${full.endsWith('\\') || full.endsWith('/') ? '' : '/'}${name}`;
        const childRel = rel ? `${rel}/${name}` : name;
        const stat = guarded(child, () => fs.lstatSync(child));
        const childType = kindOf(stat);
        record(childRel, childType, stat.size, stat.mtimeMs);
        if (childType === 'link') record('->', guarded(child, () => fs.readlinkSync(child)));
        else if (childType === 'file') size += stat.size;
        const real = walkable(child, childType);
        if (real !== null && !ancestors.includes(real)) dirs.push({ full: child, rel: childRel, ancestors: [...ancestors, real] });
      }
      // Pushed in reverse so folders are visited in name order.
      stack.push(...dirs.reverse());
    }
  }
  const result = { path: source, type, count, size, digest: hash.digest('hex') };
  if (target !== undefined) result.target = target;
  if (followLinks) result.followed = true;
  return result;
}

// Whether --force is among the options (before a literal --).
function forced(argv) {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--force');
}

// The item a source of mv or cp lands on, resolved the same way as move and copy in commands.js (inside dest when it is an existing folder).
function targetOf(command, source, dest) {
  return resolveDest(command === 'mv' ? path.resolve(source) : source, dest);
}

// The volume a path is on, from the nearest folder that exists: its volume number and the root of its real path (a junction on the way can lead
// to another drive). null when it cannot be told.
function volumeOf(p) {
  for (let current = path.resolve(p); ; current = path.dirname(current)) {
    try {
      const real = fs.realpathSync.native(current);
      return `${fs.statSync(real).dev}|${path.parse(real).root.toLowerCase()}`;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
    }
    if (path.dirname(current) === current) return null;
  }
}

// Whether mv of source to target may cross volumes. Then rename fails with EXDEV and moveOne (commands.js) copies with fs.cpSync, which on
// Windows copies what a junction inside the source holds (#284). When it cannot be told, it counts as crossing, so the snapshot follows rather too much.
function crossesVolumes(source, target) {
  const from = volumeOf(path.dirname(path.resolve(source)));
  const to = volumeOf(path.dirname(path.resolve(target)));
  return from === null || to === null || from !== to;
}

// The snapshot of every source of argv (already without --dry-run and --yes), or null for a command that is not mv, cp or rm.
// cp follows links: fs.cpSync copies what a junction holds. mv follows them only when it moves to another volume, because it copies then;
// a plain rename moves the link itself, and following would cause false new previews. rm deletes the link itself.
function snapshotSources(command, argv, options) {
  if (!COMMANDS.has(command)) return null;
  const dest = command === 'rm' ? undefined : positional(argv).at(-1);
  return sourcePaths(command, argv).map((source) => {
    const followLinks = command === 'cp' || (command === 'mv' && dest !== undefined && crossesVolumes(source, targetOf(command, source, dest)));
    return snapshotSource(source, { followLinks, ...options });
  });
}

// Whether two paths are the same item on disk: the same volume and file number. Comparing the names is not enough, because NTFS folds case
// with its own table (KELVIN SIGN and k are different names there, though toLowerCase makes them equal) and a folder can be case-sensitive (#297).
// When either cannot be read, they do not count as the same, so the destination is still snapshotted.
function sameItem(a, b) {
  try {
    const one = fs.lstatSync(a, { bigint: true });
    const two = fs.lstatSync(b, { bigint: true });
    return one.dev === two.dev && one.ino === two.ino;
  } catch {
    return false;
  }
}

// What mv --force replaces and cp --force overwrites (#284): the item each source lands on, once per path. Empty without --force,
// because then an existing destination is an error and nothing is overwritten.
// rename --force and zip --force overwrite one item too (#297): the new name in the same folder (as rename in commands.js joins it), and the archive.
// A rename whose new name leads to the item itself (only its case changes) overwrites nothing, so it has no destination.
function destinationPaths(command, argv) {
  if (!DESTINATION_COMMANDS.has(command) || !forced(argv)) return [];
  const args = positional(argv);
  if (args.length < 2) return [];
  if (command === 'zip') return [args[0]];
  if (command === 'rename') {
    const target = path.join(path.dirname(args[0]), args[1]);
    return sameItem(target, args[0]) ? [] : [target];
  }
  const dest = args.at(-1);
  const seen = new Set();
  const targets = [];
  for (const source of args.slice(0, -1)) {
    const target = targetOf(command, source, dest);
    const key = path.resolve(target).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

// The snapshot of what is at each destination of mv, cp, rename or zip with --force (type 'missing' where nothing is yet), or null for any other run.
// Links at the destination are not followed: mv --force sets the old item aside and deletes it (a link is deleted, not what it leads to),
// cp --force refuses to overwrite a link or to merge into a folder that holds one (checkOverwrite in commands.js), and rename and zip replace
// the link itself by renaming onto it. Both refuse to overwrite a folder, so their destination is a file, a link or missing.
function snapshotDestinations(command, argv, options) {
  const targets = destinationPaths(command, argv);
  return targets.length === 0 ? null : targets.map((target) => snapshotSource(target, { ...options, followLinks: false }));
}

module.exports = { DESTINATION_COMMANDS, MAX_ENTRIES, crossesVolumes, destinationPaths, sameItem, snapshotDestinations, snapshotSource, snapshotSources, sourcePaths };
