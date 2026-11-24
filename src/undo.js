'use strict';

// `fctl undo` (#397): shows the recent journal runs (#396) and reverses one of them, step by step, in the opposite order of the original steps.
//
// The rules that keep it from losing a file:
// - A step is reversed only when the item is still as the journal left it (a file keeps its size and modification time). Otherwise the step is reported as a mismatch and not touched.
// - Nothing is overwritten: a move goes back only if the old name is free, and a restore from the Recycle Bin only if the original path is free.
// - A file that a step created is sent to the Recycle Bin, not deleted. A folder is removed only when it is empty.
// - A step that cannot be reversed (a permanent delete, something a step replaced) is reported as irreversible, and does not stop the rest.
// - What was reversed is written back into the journal, so a run is never reversed twice and a second try continues where the first stopped.

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { remove } = require('./recycle');
const { restoreFromRecycleBin } = require('./recycle');
const { moveWithoutOverwrite } = require('./safeMove');
const journal = require('./journal');
const { protectedReason } = require('./protectedPaths');

const LIST_LIMIT = 20;

const exists = (p) => Boolean(fs.lstatSync(p, { throwIfNoEntry: false }));

// The runs in the journal folder, newest first: { id, file, command, startedAt, steps, status, undone }.
function listRuns({ dir = journal.journalDir(), limit = LIST_LIMIT } = {}) {
  const runs = [];
  for (const file of journal.listJournals(dir)) {
    if (runs.length >= limit) break;
    const read = journal.readJournal(file);
    if (!read.run) continue;
    runs.push({
      id: read.run.runId,
      file,
      command: read.run.command,
      startedAt: read.run.startedAt,
      steps: read.steps.length,
      // A journal with no end line belongs to a process that was killed.
      status: read.end ? read.end.status : 'interrupted',
      undone: read.undone,
    });
  }
  return runs;
}

function formatRuns(runs) {
  if (runs.length === 0) return 'No runs are recorded in the journal of this folder. The journal is in the folder the command worked on: run undo from there, or give --target=<folder>.';
  return runs.map((run) => `${run.id}  ${run.startedAt}  ${run.command.padEnd(14)}  ${String(run.steps).padStart(4)} steps  ${run.status}${run.undone ? '  (undone)' : ''}`).join('\n');
}

// The run to undo: the one named by id (a prefix is enough), otherwise the newest run that is not undone, not itself an undo, and changed something.
function pickRun(id, dir) {
  const runs = listRuns({ dir, limit: Infinity });
  if (id !== undefined) {
    const found = runs.filter((run) => run.id.startsWith(id));
    if (found.length === 0) throw new FcError(`No run with the id ${id} in the journal. Run undo --list to see the runs.`);
    if (found.length > 1) throw new FcError(`The id ${id} matches several runs. Give more characters.`);
    return found[0];
  }
  const latest = runs.find((run) => !run.undone && run.command !== 'undo' && run.steps > 0);
  if (!latest) throw new FcError('There is no run to undo here. Run undo --list to see the runs, from the folder the command worked on or with --target=<folder>.');
  return latest;
}

// What undo sees on disk. A real run looks at the disk, because each step really happened before the next is looked at.
// A preview (--dry-run) changes nothing, so it keeps an overlay of what the earlier steps of the plan would have done (paths that would exist again, paths that would be gone),
// and looks through it. Without it, the plan of a run that needs its folders back first (flatten) would report mismatches that the real run does not have.
function makeView(dryRun) {
  const added = new Set();
  const gone = new Set();
  const restored = [];
  const real = (p) => Boolean(fs.lstatSync(p, { throwIfNoEntry: false }));
  const isUnder = (dir, p) => p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  return {
    dryRun,
    added,
    exists: (p) => (dryRun ? added.has(p) || (!gone.has(p) && real(p)) : real(p)),
    // The folder a path goes into. In a preview, a folder that a planned restore brings back (with what was inside it) counts as there.
    parentExists(p) {
      const dir = path.dirname(p);
      return this.exists(dir) || (dryRun && restored.some((r) => dir === r || isUnder(r, dir)));
    },
    isEmptyFolder(p) {
      if (!dryRun) return fs.lstatSync(p).isDirectory() && fs.readdirSync(p).length === 0;
      if (added.has(p)) return true;
      const children = fs.lstatSync(p).isDirectory() ? fs.readdirSync(p).map((name) => path.join(p, name)).filter((c) => !gone.has(c)) : [p];
      return children.length === 0 && ![...added].some((a) => path.dirname(a) === p);
    },
    // Records in the overlay what a step of the plan would do.
    plan(step) {
      if (!dryRun) return;
      const drop = (p) => (added.has(p) ? added.delete(p) : gone.add(p));
      if (step.op === 'move') {
        drop(step.to);
        added.add(step.from);
        gone.delete(step.from);
      } else if (step.op === 'recycle') {
        added.add(step.path);
        restored.push(step.path);
      } else if (['copy', 'write', 'create', 'create-dir'].includes(step.op)) drop(step.to ?? step.path);
    },
  };
}

// Whether `p` is still what the step left: a file with the same size, modification time and file ID (when the step recorded them), or any folder.
function unchanged(step, p, view) {
  // Something the plan itself puts there is not on disk yet.
  if (view.dryRun && view.added.has(p)) return null;
  let stat;
  try {
    stat = fs.lstatSync(p, { bigint: true });
  } catch {
    return 'it is gone';
  }
  const stamp = step.stamp;
  if (stamp === undefined) return null;
  if (!stat.isFile()) return 'it is no longer a file';
  if (Number(stat.size) !== stamp.size || Math.floor(Number(stat.mtimeNs / 1000000n)) !== stamp.mtimeMs) return 'it was changed after the run';
  if (stamp.ino !== undefined && stat.ino !== 0n && String(stat.ino) !== stamp.ino) return 'it was replaced by another file after the run';
  return null;
}

// A rename that only changed the case: the old spelling is the same item, so it goes back by a plain rename.
function caseOnly(from, to) {
  if (from.toLowerCase() !== to.toLowerCase()) return false;
  const one = fs.lstatSync(from, { bigint: true, throwIfNoEntry: false });
  const two = fs.lstatSync(to, { bigint: true, throwIfNoEntry: false });
  return Boolean(one && two) && one.ino !== 0n && one.ino === two.ino && one.dev === two.dev;
}

const done = (message) => ({ status: 'done', message });
const mismatch = (message) => ({ status: 'mismatch', message });
const irreversible = (message) => ({ status: 'irreversible', message });

// The reverse of one step. In a preview it only says what it would do, through the overlay of the earlier planned steps.
function reverse(step, view) {
  // A journal is a file in a folder, so whatever it names is checked as if it came from the command line: nothing in a protected place is touched.
  for (const p of [step.from, step.to, step.path]) {
    if (typeof p !== 'string') continue;
    const reason = protectedReason(p);
    if (reason !== null) return mismatch(`${p}: not touched because it is a protected path (${reason})`);
  }
  const act = (verb, fn) => {
    if (!view.dryRun) fn();
    return done(verb);
  };
  switch (step.op) {
    case 'move': {
      const why = unchanged(step, step.to, view);
      if (why) return mismatch(`${step.to}: ${why}, so it was not moved back to ${step.from}`);
      if (!view.dryRun && caseOnly(step.from, step.to)) return act(`Move back: ${step.to} -> ${step.from}`, () => journal.rename(step.to, step.from));
      if (view.exists(step.from)) return mismatch(`${step.from} exists again, so ${step.to} was not moved back (undo never overwrites)`);
      if (!view.parentExists(step.from)) return mismatch(`The folder ${path.dirname(step.from)} no longer exists, so ${step.to} was not moved back`);
      const note = step.replaced ? ' (the file it replaced earlier is not restored)' : '';
      return act(`Move back: ${step.to} -> ${step.from}${note}`, () => {
        if (!moveWithoutOverwrite(step.to, step.from)) throw new FcError(`${step.from} exists again, so ${step.to} was not moved back`);
      });
    }
    case 'copy':
    case 'write':
    case 'create': {
      const target = step.to ?? step.path;
      if (step.existed) return irreversible(`${target} was there before the run and changed, so the earlier content cannot be restored`);
      if (step.stamp === undefined) return irreversible(`${target} is a folder made by ${step.op}; remove it yourself if you do not want it`);
      const why = unchanged(step, target, view);
      if (why) return mismatch(`${target}: ${why}, so it was not removed`);
      return act(`Send to the Recycle Bin: ${target}`, () => remove([target], { checkVolume: false }));
    }
    case 'create-dir': {
      if (!view.exists(step.path)) return mismatch(`${step.path}: it is gone`);
      if (!view.isEmptyFolder(step.path)) return mismatch(`${step.path} is not an empty folder now, so it was not removed`);
      return act(`Remove the empty folder: ${step.path}`, () => fs.rmdirSync(step.path));
    }
    case 'recycle': {
      if (view.exists(step.path)) return mismatch(`${step.path} exists again, so nothing was restored from the Recycle Bin (undo never overwrites)`);
      if (!view.parentExists(step.path)) return mismatch(`The folder ${path.dirname(step.path)} no longer exists, so ${step.path} was not restored`);
      if (view.dryRun) return done(`Restore from the Recycle Bin: ${step.path}`);
      const { status } = restoreFromRecycleBin(step.path);
      if (status === 'ok') return done(`Restore from the Recycle Bin: ${step.path}`);
      return mismatch(`${step.path} is not in the Recycle Bin any more (emptied or restored by hand), so it could not be restored`);
    }
    case 'restore':
      return irreversible(`${step.path} was restored from the Recycle Bin by an undo; delete it again by hand if you do not want it`);
    case 'delete':
      return irreversible(`${step.path} was deleted permanently and cannot be restored`);
    default:
      return mismatch(`Unknown step in the journal: ${step.op} (seq ${step.seq})`);
  }
}

// It reverses one run. Returns { run, dryRun, steps: [{ seq, op, status, message }], undone }.
// status: done, mismatch (state changed, not touched), irreversible (cannot be reversed), skipped (already reversed by an earlier undo).
// Each reversed step is written into the journal right away, so a crash in the middle keeps what was done.
function undo({ id, dryRun = false, dir = journal.journalDir() } = {}) {
  const run = pickRun(id, dir);
  const read = journal.readJournal(run.file);
  if (read.undone) throw new FcError(`The run ${run.id} was already undone.`);
  const untrusted = journal.untrustedReason(run.file, read.run);
  if (untrusted !== null) throw new FcError(untrusted);
  const view = makeView(dryRun);
  const results = [];
  for (const step of [...read.steps].reverse()) {
    if (read.reversed.has(step.seq)) {
      results.push({ seq: step.seq, op: step.op, status: 'skipped', message: `Step ${step.seq} was already reversed` });
      continue;
    }
    let outcome;
    try {
      outcome = reverse(step, view);
    } catch (err) {
      outcome = mismatch(err instanceof FcError ? err.message : `Could not reverse step ${step.seq}: ${err.code ?? err.message}`);
    }
    results.push({ seq: step.seq, op: step.op, ...outcome });
    if (outcome.status === 'mismatch') continue;
    if (dryRun) view.plan(step);
    else journal.markUndone(run.file, [step.seq], false);
  }
  const clean = results.every((r) => r.status !== 'mismatch');
  if (!dryRun && clean) journal.markUndone(run.file, [], true);
  return { run, dryRun, steps: results, undone: !dryRun && clean };
}

function formatUndo(result) {
  const count = (status) => result.steps.filter((s) => s.status === status).length;
  const lines = result.steps.map((s) => `${s.status === 'done' ? (result.dryRun ? '[Preview] ' : '') : `[${s.status}] `}${s.message}`);
  const head = `${result.dryRun ? 'Plan to undo' : 'Undo of'} run ${result.run.id} (${result.run.command}, ${result.run.startedAt})`;
  const tail = `${count('done')} ${result.dryRun ? 'would be reversed' : 'reversed'}, ${count('mismatch')} not touched because the state changed, ${count('irreversible')} cannot be reversed${count('skipped') ? `, ${count('skipped')} already reversed earlier` : ''}.`;
  return [head, ...lines, tail].join('\n');
}

module.exports = { undo, listRuns, formatRuns, formatUndo };
