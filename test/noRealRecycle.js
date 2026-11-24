'use strict';

// A guard that makes a test fail instead of sending files to the developer's real Recycle Bin (#291).
// `npm test` loads it with --require before any test file, and it adds itself to NODE_OPTIONS, so every Node process the run starts
// (the test file processes of node --test, job processes forked by the UI tests, and so on) loads it too.
//
// It wraps the child_process functions that can start PowerShell. A call whose script (or input) uses a Recycle Bin API throws.
// Tests that fake the Recycle Bin replace child_process.execFileSync after this guard is installed, so a faked call never reaches it,
// and a call a fake passes through to "the real execFileSync" reaches it.
//
// It looks at the script text, not at the FC_TARGET / FC_BATCH / FC_RECYCLE_FILES variables, because test/recycle.test.js and
// test/flatten.test.js run the real scripts with real PowerShell after swapping the Recycle Bin call for a plain delete inside a temp folder.
// The Recycle Bin state check (FC_VOLUME) only reads the volume and its Recycle Bin settings, so it is allowed to pass.
// FC_TEST_REAL_RECYCLE=1 turns the guard off, only for running the real Recycle Bin premise test in test/recycle.test.js by hand.
//
// src/ code often catches the error and reports the item as failed, which a test could still accept. So every blocked call is also
// written to a log file (FC_NO_REAL_RECYCLE_LOG) that the first process of the run creates, and that process fails the run on exit if the log is not empty.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');

const RECYCLE_API = /SendToRecycleBin|Shell\.Application|NameSpace\(\s*(?:10|0xa)\s*\)|SHFileOperation|FOF_ALLOWUNDO/i;
const MARK = Symbol.for('file-control.noRealRecycle');

class RealRecycleBinError extends Error {}

function texts(args) {
  const out = [];
  for (const arg of args) {
    if (typeof arg === 'string') out.push(arg);
    else if (Array.isArray(arg)) for (const item of arg) out.push(String(item));
    else if (arg && typeof arg === 'object' && !Buffer.isBuffer(arg) && typeof arg.input === 'string') out.push(arg.input);
  }
  return out;
}

// It throws if the arguments of a child process call would use the real Recycle Bin.
function check(name, args) {
  // The one deliberate exception: a person running the real Recycle Bin premise test by hand (test/recycle.test.js, #190).
  if (process.env.FC_TEST_REAL_RECYCLE === '1') return;
  const hit = texts(args).find((text) => RECYCLE_API.test(text));
  if (hit === undefined) return;
  const api = RECYCLE_API.exec(hit)[0];
  const err = new RealRecycleBinError(`noRealRecycle: a test tried to use the real Recycle Bin (${name}, ${api}). Fake the call (see test/fakeRecycleFiles.js) or use --permanent inside the test's temp folder.`);
  record(err);
  throw err;
}

function record(err) {
  const log = process.env.FC_NO_REAL_RECYCLE_LOG;
  if (!log) return;
  try {
    fs.appendFileSync(log, `${process.argv.slice(1).join(' ')}\n${err.stack}\n\n`);
  } catch {
    // The thrown error still reaches the caller.
  }
}

// The first process of the run owns the log: it creates it, and on exit it reports what was blocked and fails the run.
function ownLog() {
  if (process.env.FC_NO_REAL_RECYCLE_LOG) return;
  const log = path.join(os.tmpdir(), `fc-no-real-recycle-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(log, '');
  process.env.FC_NO_REAL_RECYCLE_LOG = log;
  // Commands run through execute() write a change journal (#396). Every process of the run writes it into one temporary folder, never the real one.
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-journal-'));
  process.env.FCTL_JOURNAL_DIR = journalDir;
  process.on('exit', () => fs.rmSync(journalDir, { recursive: true, force: true }));
  process.on('exit', () => {
    let text = '';
    try {
      text = fs.readFileSync(log, 'utf8');
      fs.rmSync(log, { force: true });
    } catch {
      // Nothing to report.
    }
    if (!text) return;
    process.stderr.write(`\nnoRealRecycle: calls to the real Recycle Bin were blocked during this run:\n\n${text}`);
    process.exitCode = 1;
  });
}

function install() {
  if (childProcess[MARK]) return;
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'execSync', 'exec']) {
    const real = childProcess[name];
    const guarded = function (...args) {
      check(name, args);
      return real.apply(this, args);
    };
    const custom = real[util.promisify.custom];
    if (custom) {
      guarded[util.promisify.custom] = function (...args) {
        try {
          check(name, args);
        } catch (err) {
          return Promise.reject(err);
        }
        return custom.apply(this, args);
      };
    }
    childProcess[name] = guarded;
  }
  Object.defineProperty(childProcess, MARK, { value: true });
  ownLog();

  // Child Node processes load the guard too. A forward-slash path works for require on Windows and needs no escaping in NODE_OPTIONS.
  const self = `--require "${path.resolve(__filename).replace(/\\/g, '/')}"`;
  const current = process.env.NODE_OPTIONS || '';
  if (!current.includes(self)) process.env.NODE_OPTIONS = current ? `${current} ${self}` : self;
}

install();

module.exports = { RECYCLE_API, RealRecycleBinError, check };
