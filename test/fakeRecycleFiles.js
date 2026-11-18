'use strict';

// It imitates the batch Recycle Bin move (recycleFiles, FC_RECYCLE_FILES) (#194, #216). It is used in tests so as not to touch the user's Recycle Bin.
// Like the real script (RECYCLE_FILES_SCRIPT), for each line it looks right before deleting at the real path, the file-ness, and the fileStamp,
// and if a file to keep (keep) is given, it looks at that again before deleting. The real script itself is checked by test/recycle.test.js with real PowerShell.
// For each target it calls hook(target, stamp) and deletes. If hook throws, it makes only that file fail as if with a Windows reason (error).

const fs = require('node:fs');

// If src/target were imported here, commands.js would be read before the test's fake execFileSync and would take the real function, so it is imported at use time.
const fileStamp = (stat) => require('../src/target').fileStamp(stat);

const decode = (encoded) => Buffer.from(encoded, 'base64').toString('utf16le');
const encode = (text) => Buffer.from(text, 'utf16le').toString('base64');

function same(file, stamp) {
  try {
    if (fs.realpathSync.native(file) !== file) return 'moved';
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) return 'notfile';
    return fileStamp(stat) === stamp ? 'ok' : 'changed';
  } catch {
    return 'gone';
  }
}

function fakeRecycleFiles(options, hook) {
  const lines = [];
  for (const line of options.input.split('\n').filter(Boolean)) {
    const [path, stamp, keepPath, keepStamp] = line.split(' ');
    const target = decode(path);
    let status = same(target, stamp);
    if (status === 'ok' && keepPath !== undefined && same(decode(keepPath), keepStamp) !== 'ok') status = 'keepchanged';
    if (status !== 'ok') {
      lines.push(`${status} ${path} `);
      continue;
    }
    try {
      hook(target, stamp);
      fs.rmSync(target);
      lines.push(`ok ${path} `);
    } catch (err) {
      lines.push(`error ${path} ${encode(err.message)}`);
    }
  }
  return lines.join('\r\n') + '\r\n';
}

// It imitates the batch move of empty folders (recycleEmptyFolders, FC_BATCH) (#291). Like RECYCLE_FOLDERS_SCRIPT, it checks each folder right before deleting:
// still there, still a folder, the same real path, and nothing inside but folders and the names in FC_ALLOWED. hook(folder) is called before each deletion.
function fakeRecycleFolders(options, hook = () => {}) {
  const allowed = new Set(String(options.env?.FC_ALLOWED ?? '').split('|').filter(Boolean));
  const filled = (folder) => fs.readdirSync(folder, { recursive: true, withFileTypes: true })
    .some((entry) => entry.isSymbolicLink() || (!entry.isDirectory() && !allowed.has(entry.name.toLowerCase())));
  const lines = [];
  for (const line of options.input.split('\n').filter(Boolean)) {
    const folder = decode(line);
    let status;
    try {
      const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
      if (!stat) status = 'gone';
      else if (!stat.isDirectory()) status = 'notdir';
      else if (fs.realpathSync.native(folder) !== folder) status = 'moved';
      else if (filled(folder)) status = 'filled';
      else {
        hook(folder);
        fs.rmSync(folder, { recursive: true });
        status = 'ok';
      }
    } catch {
      status = 'error';
    }
    lines.push(`${status} ${line}`);
  }
  return lines.join('\r\n') + '\r\n';
}

// It swaps child_process.execFileSync so the three Recycle Bin moves only delete inside the test's temp folder (#291):
// FC_TARGET (one file or folder), FC_BATCH (empty folders) and FC_RECYCLE_FILES (files). Every other call, including the
// read-only Recycle Bin state check (FC_VOLUME), goes to the real function. Call it before src/commands.js is imported,
// because commands.js keeps the execFileSync it saw when it was loaded. It returns the list of paths "sent to the Recycle Bin".
function installFakeRecycleBin() {
  const test = require('node:test');
  const childProcess = require('node:child_process');
  const real = childProcess.execFileSync;
  const recycled = [];
  test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    const env = options?.env ?? {};
    if (env.FC_BATCH !== undefined) return fakeRecycleFolders(options, (folder) => recycled.push(folder));
    if (env.FC_RECYCLE_FILES !== undefined) return fakeRecycleFiles(options, (target) => recycled.push(target));
    if (env.FC_TARGET === undefined) return real(file, args, options);
    recycled.push(env.FC_TARGET);
    fs.rmSync(env.FC_TARGET, { recursive: true, force: true });
    return options?.encoding ? '' : Buffer.alloc(0);
  });
  return recycled;
}

module.exports = { fakeRecycleFiles, fakeRecycleFolders, installFakeRecycleBin };
