'use strict';

// The change journal (#396). Every command that changes files writes one journal file per run, listing each change that really happened
// (moved from -> to, created, copied, sent to the Recycle Bin, deleted), in order, so a later `undo` (#397) can walk it backwards.
//
// Format: JSON Lines, one JSON object per line, so a crash or a failure midway still leaves every step that already happened.
//   {"type":"run","version":1,"runId","command","args","cwd","startedAt"}   the first line, written together with the first step
//   {"type":"step","seq","op","time", ...}                                   one line per change
//   {"type":"undo-step","seq"} / {"type":"undone"}                   added by `undo` (#397)
//   (ops written by undo itself: restore { path } for an item put back from the Recycle Bin)
//   {"type":"end","status":"ok"|"failed","error?","steps","endedAt"}         the last line (missing if the process was killed)
// ops: move { from, to }, copy { from, to }, create-dir { path }, write { path, append }, create { path, source? } (made by extraction or compression),
//      recycle { path }, delete { path } (permanent).
// A move with replaced:true overwrote an existing item (the old content is gone). create/write/copy with existed:true changed something that was already there,
// so a reverse replay must not delete it. Fields named source may be relative; every other path is absolute.
//
// Where: the folder in FCTL_JOURNAL_DIR, else %LOCALAPPDATA%\fctl\journal, else ~/.fctl/journal. It is not inside the target folder,
// because mv, cp and rename have no single target folder and a journal inside the target would itself be a file the command could touch.
// A run that changes nothing (a preview, a read-only command, a command that failed before its first change) writes no file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const JOURNAL_VERSION = 1;
const STAMPED = new Set(['move', 'copy', 'write', 'create']);
const JOURNAL_FILE = /^fctl-journal-\d{4}-\d{2}-\d{2}-\d{6}-\d{3}-[0-9a-f]{8}\.jsonl$/;

let active = null;

function journalDir() {
  if (process.env.FCTL_JOURNAL_DIR) return path.resolve(process.env.FCTL_JOURNAL_DIR);
  // `node --test` runs a test file without the helper of `npm test`, so a test still never writes into the real journal.
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), 'fctl-test-journal');
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'fctl', 'journal');
  return path.join(os.homedir(), '.fctl', 'journal');
}

const pad = (value, width = 2) => String(value).padStart(width, '0');

function stamp(now) {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// It is written for a person to read too, so the time carries the local zone, not UTC.
function localTime(now) {
  const offset = -now.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${stamp(now).slice(0, 10)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${zone}`;
}

function append(run, object) {
  try {
    if (run.file === undefined) {
      fs.mkdirSync(run.dir, { recursive: true });
      run.file = path.join(run.dir, `fctl-journal-${stamp(run.startedAt)}-${pad(run.startedAt.getMilliseconds(), 3)}-${run.runId}.jsonl`);
      const header = { type: 'run', version: JOURNAL_VERSION, runId: run.runId, command: run.command, args: run.redacted ?? run.args, cwd: process.cwd(), startedAt: localTime(run.startedAt) };
      fs.appendFileSync(run.file, `${JSON.stringify(header)}\n`);
    }
    fs.appendFileSync(run.file, `${JSON.stringify(object)}\n`);
  } catch (err) {
    // The files were already changed, so a journal that cannot be written must not stop the command. It is reported at the end.
    run.error ??= `${err.code ?? err.message}`;
  }
}

// Starts recording. Nested calls (a command run from inside a command) join the outer run.
function begin(command, args = [], { redacted } = {}) {
  if (active) {
    active.depth += 1;
    return active;
  }
  active = { command, args, dir: journalDir(), runId: crypto.randomBytes(4).toString('hex'), startedAt: new Date(), steps: 0, depth: 1, muted: 0, redacted };
  return active;
}

// Ends recording. error is the error the command ended with, if any. It returns { file, steps, error } for the outermost call, else null.
function finish(run, error) {
  if (!run || run !== active) return null;
  run.depth -= 1;
  if (run.depth > 0) return null;
  active = null;
  if (run.file !== undefined) {
    const end = { type: 'end', status: error ? 'failed' : 'ok', steps: run.steps, endedAt: localTime(new Date()) };
    if (error) end.error = String(error.message ?? error);
    append(run, end);
  }
  return { file: run.file, steps: run.steps, error: run.error };
}

// Records one change that already happened. Paths are written as absolute paths.
function record(op, fields = {}) {
  const run = active;
  if (!run || run.muted > 0) return;
  const step = { type: 'step', seq: run.steps + 1, op, time: localTime(new Date()) };
  for (const [key, value] of Object.entries(fields)) step[key] = typeof value === 'string' && key !== 'source' && key !== 'kind' ? path.resolve(value) : value;
  // The size and modification time of a file the step left behind, so `undo` can tell whether it was changed after the run (#397).
  const left = fields.to ?? fields.path;
  if (typeof left === 'string' && STAMPED.has(op)) {
    try {
      const stat = fs.lstatSync(left, { bigint: true });
      // ino is the file ID, so a different file saved under the same name is not taken for this one (0 means the file system gives no ID).
      if (stat.isFile()) step.stamp = { size: Number(stat.size), mtimeMs: Math.floor(Number(stat.mtimeNs / 1000000n)), ...(stat.ino === 0n ? {} : { ino: String(stat.ino) }) };
    } catch {
      // No stamp: undo then has nothing to compare and treats the item as unchanged only for folders.
    }
  }
  run.steps += 1;
  append(run, step);
}

// Runs fn without recording its own changes. A caller that records one summary step itself (extraction records "created", not the move out of a temporary folder) uses it.
function quiet(fn) {
  const run = active;
  if (run) run.muted += 1;
  try {
    return fn();
  } finally {
    if (run) run.muted -= 1;
  }
}

// renameSync that records the move. Callers that rename with it keep renameSync's behavior, including overwriting.
function rename(from, to, extra = {}) {
  // A case-only rename finds the item itself under the new name, which is not a replacement.
  const before = fs.lstatSync(to, { bigint: true, throwIfNoEntry: false });
  const self = before && fs.lstatSync(from, { bigint: true, throwIfNoEntry: false });
  const replaced = Boolean(before) && !(self && self.ino !== 0n && self.ino === before.ino && self.dev === before.dev);
  fs.renameSync(from, to);
  record('move', { from, to, ...(replaced ? { replaced: true } : {}), ...extra });
}

// Reads a journal file back: { run, steps, end }. A missing end means the process ended without finishing (a crash or a kill).
function readJournal(file) {
  const result = { run: undefined, steps: [], end: undefined, reversed: new Set(), undone: false };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A line cut off by a crash is the end of what was recorded.
      break;
    }
    if (entry.type === 'run') result.run = entry;
    else if (entry.type === 'step') result.steps.push(entry);
    else if (entry.type === 'end') result.end = entry;
    else if (entry.type === 'undo-step') result.reversed.add(entry.seq);
    else if (entry.type === 'undone') result.undone = true;
  }
  return result;
}

// `undo` marks what it reversed in the journal itself: one line per reversed step, and a last line when the whole run is undone, so a run is never reversed twice.
function markUndone(file, seqs, whole) {
  const time = localTime(new Date());
  const lines = seqs.map((seq) => JSON.stringify({ type: 'undo-step', seq, time }));
  if (whole) lines.push(JSON.stringify({ type: 'undone', time }));
  if (lines.length > 0) fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

// The journal files, newest first.
function listJournals(dir = journalDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => JOURNAL_FILE.test(name)).sort().reverse().map((name) => path.join(dir, name));
}

module.exports = { begin, finish, record, quiet, rename, readJournal, markUndone, listJournals, journalDir, JOURNAL_FILE, JOURNAL_VERSION };
