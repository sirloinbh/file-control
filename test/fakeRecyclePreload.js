'use strict';

// A preload that keeps a test from touching the real Recycle Bin (#257). It replaces child_process.execFileSync before src/commands.js is imported
// and imitates the three Recycle Bin related PowerShell calls the way test/collapse.test.js and test/flatten.test.js do:
//   FC_VOLUME  the Recycle Bin state check answers "a fixed disk, normal Recycle Bin"
//   FC_TARGET  the single-folder move (collapse) only deletes the empty folder
//   FC_BATCH   the batch move of empty folders (flatten) checks each folder like the real script and deletes the empty ones
// Any other call that would reach the Recycle Bin (FC_RECYCLE_FILES, or a script that mentions SendToRecycleBin) throws, so it can never fall through to the real bin.
// Use it as `--require` for a job process (see the `fork` of createJobs in test/uiOrganizeScreen.test.js) and as the first require of a test file for in-process runs.
// If FC_FAKE_RECYCLE_LOG is set, each folder it "sent to the Recycle Bin" is appended to that file, so a test can see that the fake was used.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const real = childProcess.execFileSync;
const METADATA = /^(?:desktop\.ini|thumbs\.db|ehthumbs(?:_vista)?\.db|\.DS_Store)$/i;

function log(folder) {
  if (process.env.FC_FAKE_RECYCLE_LOG) fs.appendFileSync(process.env.FC_FAKE_RECYCLE_LOG, `${folder}\n`);
}

const filledEntry = (folder) => fs.readdirSync(folder, { recursive: true, withFileTypes: true }).find((entry) => entry.isSymbolicLink() || (!entry.isDirectory() && !METADATA.test(entry.name)));

function fakeBatch(options) {
  const lines = [];
  for (const line of options.input.split('\n').filter(Boolean)) {
    const folder = Buffer.from(line, 'base64').toString('utf16le');
    let status;
    try {
      const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
      if (!stat) status = 'gone';
      else if (!stat.isDirectory() && !stat.isSymbolicLink()) status = 'notdir';
      else if (fs.realpathSync.native(folder) !== folder) status = 'moved';
      else if (filledEntry(folder)) status = 'filled';
      else {
        log(folder);
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

childProcess.execFileSync = function fakeExecFileSync(file, args, options) {
  const env = (options && options.env) || {};
  if (env.FC_RECYCLE_FILES !== undefined) throw new Error('fakeRecyclePreload: the batch file Recycle Bin call is not faked');
  if (env.FC_VOLUME !== undefined) return 'True|Fixed\r\n';
  if (env.FC_BATCH !== undefined) return fakeBatch(options);
  if (env.FC_TARGET !== undefined) {
    // mv --force sets the replaced item aside under a .fctl-old-* name and sends it to the Recycle Bin (#311); it may hold files.
    const filled = /^\.fctl-old-/.test(path.basename(env.FC_TARGET)) ? undefined : filledEntry(env.FC_TARGET);
    if (filled) throw new Error(`Tried to send a folder that is not empty to the Recycle Bin: ${filled.name}`);
    log(env.FC_TARGET);
    fs.rmSync(env.FC_TARGET, { recursive: true });
    return Buffer.alloc(0);
  }
  if (String(args && args[args.length - 1]).includes('SendToRecycleBin')) throw new Error('fakeRecyclePreload: a Recycle Bin call got past the fake');
  return real.apply(this, arguments);
};
