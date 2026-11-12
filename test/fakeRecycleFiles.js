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

module.exports = { fakeRecycleFiles };
