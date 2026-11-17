'use strict';

// A snapshot of what mv, cp and rm will touch (#280). Their dry-run result names only the given paths, so a file added, removed or changed
// inside a source folder after the preview would not change the fingerprint. The snapshot is added to what is fingerprinted.
// Nothing is followed through a junction or symlink: a link is recorded as a link with its target.
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

// { path, type: 'file' | 'dir' | 'link' | 'missing', count, size, digest }
// count is the number of entries under a folder (not counting the folder itself), size the total size of the files in bytes, digest a hash of every entry's
// relative path, type, size and mtimeMs (and a link's target). Past maxEntries it throws instead of fingerprinting a partial snapshot.
function snapshotSource(source, { maxEntries = MAX_ENTRIES } = {}) {
  let top;
  try {
    top = fs.lstatSync(source);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { path: source, type: 'missing', count: 0, size: 0, digest: '' };
    throw err;
  }
  const hash = crypto.createHash('sha256');
  const record = (...parts) => hash.update(JSON.stringify(parts) + '\n');
  const type = kindOf(top);
  let count = 0;
  let size = 0;
  record('.', type, top.size, top.mtimeMs);
  if (type === 'link') record('->', fs.readlinkSync(source));
  if (type === 'file') size = top.size;
  if (type === 'dir') {
    const stack = [{ full: source, rel: '' }];
    while (stack.length > 0) {
      const { full, rel } = stack.pop();
      const names = fs.readdirSync(full).sort();
      // Pushed in reverse so folders are visited in name order.
      const dirs = [];
      for (const name of names) {
        if (++count > maxEntries) {
          throw new FcError(`${source} holds more than ${maxEntries} entries, too many to check for changes between the preview and the run, so it cannot be previewed here. Use the command line (fctl) for it.`);
        }
        const child = `${full}${full.endsWith('\\') || full.endsWith('/') ? '' : '/'}${name}`;
        const childRel = rel ? `${rel}/${name}` : name;
        const stat = fs.lstatSync(child);
        const childType = kindOf(stat);
        record(childRel, childType, stat.size, stat.mtimeMs);
        if (childType === 'link') record('->', fs.readlinkSync(child));
        else if (childType === 'file') size += stat.size;
        else dirs.push({ full: child, rel: childRel });
      }
      stack.push(...dirs.reverse());
    }
  }
  return { path: source, type, count, size, digest: hash.digest('hex') };
}

// The snapshot of every source of argv (already without --dry-run and --yes), or null for a command that is not mv, cp or rm.
function snapshotSources(command, argv, options) {
  if (!COMMANDS.has(command)) return null;
  return sourcePaths(command, argv).map((source) => snapshotSource(source, options));
}

module.exports = { MAX_ENTRIES, snapshotSource, snapshotSources, sourcePaths };
