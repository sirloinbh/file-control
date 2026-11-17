'use strict';

// A snapshot of what mv, cp and rm will touch (#280). Their dry-run result names only the given paths, so a file added, removed or changed
// inside a source folder after the preview would not change the fingerprint. The snapshot is added to what is fingerprinted.
// A junction or symlink is recorded as a link with its target. It is walked only for cp (see snapshotSources).
const crypto = require('node:crypto');
const fs = require('node:fs');
const { FcError } = require('../commands');

const MAX_ENTRIES = 200000;
const COMMANDS = new Set(['mv', 'cp', 'rm']);

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
  return result;
}

// The snapshot of every source of argv (already without --dry-run and --yes), or null for a command that is not mv, cp or rm.
// Only cp follows links: fs.cpSync copies what a junction holds. mv renames (a cross-drive move cannot be told apart here, and following would
// cause false new previews) and rm deletes the link itself.
function snapshotSources(command, argv, options) {
  if (!COMMANDS.has(command)) return null;
  return sourcePaths(command, argv).map((source) => snapshotSource(source, { followLinks: command === 'cp', ...options }));
}

module.exports = { MAX_ENTRIES, snapshotSource, snapshotSources, sourcePaths };
