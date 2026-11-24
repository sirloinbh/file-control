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
  if (runs.length === 0) return 'No runs are recorded in the journal.';
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
  if (!latest) throw new FcError('There is no run to undo. Run undo --list to see the runs.');
  return latest;
}

// Whether `p` is still what the step left: a file with the same size and modification time (when the step recorded them), or any folder.
function unchanged(step, p) {
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return 'it is gone';
  }
  if (step.stamp === undefined) return null;
  if (!stat.isFile()) return 'it is no longer a file';
  if (stat.size !== step.stamp.size || Math.floor(stat.mtimeMs) !== step.stamp.mtimeMs) return 'it was changed after the run';
  return null;
}

function sameItem(a, b) {
  const one = fs.lstatSync(a, { bigint: true, throwIfNoEntry: false });
  const two = fs.lstatSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(one && two) && one.ino !== 0n && one.ino === two.ino && one.dev === two.dev;
}

const done = (message) => ({ status: 'done', message });
const mismatch = (message) => ({ status: 'mismatch', message });
const irreversible = (message) => ({ status: 'irreversible', message });

// The reverse of one step. With dryRun it only says what it would do (and still finds the mismatches that can be seen without acting).
function reverse(step, dryRun) {
  const act = (verb, fn) => {
    if (!dryRun) fn();
    return done(verb);
  };
  switch (step.op) {
    case 'move': {
      const why = unchanged(step, step.to);
      if (why) return mismatch(`${step.to}: ${why}, so it was not moved back to ${step.from}`);
      if (sameItem(step.from, step.to)) {
        // A rename that only changed the case: the old spelling is the same item, so it goes back by a plain rename.
        return act(`Move back: ${step.to} -> ${step.from}`, () => journal.rename(step.to, step.from));
      }
      if (exists(step.from)) return mismatch(`${step.from} exists again, so ${step.to} was not moved back (undo never overwrites)`);
      if (!exists(path.dirname(step.from))) return mismatch(`The folder ${path.dirname(step.from)} no longer exists, so ${step.to} was not moved back`);
      const note = step.replaced ? ' (the file it replaced earlier is not restored)' : '';
      const result = act(`Move back: ${step.to} -> ${step.from}${note}`, () => {
        if (!moveWithoutOverwrite(step.to, step.from)) throw new FcError(`${step.from} exists again, so ${step.to} was not moved back`);
      });
      return step.replaced ? { ...result, replaced: true } : result;
    }
    case 'copy':
    case 'write':
    case 'create': {
      const target = step.to ?? step.path;
      if (step.existed) return irreversible(`${target} was there before the run and changed, so the earlier content cannot be restored`);
      if (step.stamp === undefined) return irreversible(`${target} is a folder made by ${step.op}; remove it yourself if you do not want it`);
      const why = unchanged(step, target);
      if (why) return mismatch(`${target}: ${why}, so it was not removed`);
      return act(`Send to the Recycle Bin: ${target}`, () => remove([target], { checkVolume: false }));
    }
    case 'create-dir': {
      if (!exists(step.path)) return mismatch(`${step.path}: it is gone`);
      if (!fs.lstatSync(step.path).isDirectory() || fs.readdirSync(step.path).length > 0) return mismatch(`${step.path} is not an empty folder now, so it was not removed`);
      return act(`Remove the empty folder: ${step.path}`, () => fs.rmdirSync(step.path));
    }
    case 'recycle': {
      if (exists(step.path)) return mismatch(`${step.path} exists again, so nothing was restored from the Recycle Bin (undo never overwrites)`);
      if (!exists(path.dirname(step.path))) return mismatch(`The folder ${path.dirname(step.path)} no longer exists, so ${step.path} was not restored`);
      if (dryRun) return done(`Restore from the Recycle Bin: ${step.path}`);
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
function undo({ id, dryRun = false, dir = journal.journalDir() } = {}) {
  const run = pickRun(id, dir);
  const read = journal.readJournal(run.file);
  if (read.undone) throw new FcError(`The run ${run.id} was already undone.`);
  const results = [];
  const finished = [];
  for (const step of [...read.steps].reverse()) {
    if (read.reversed.has(step.seq)) {
      results.push({ seq: step.seq, op: step.op, status: 'skipped', message: `Step ${step.seq} was already reversed` });
      continue;
    }
    let outcome;
    try {
      outcome = reverse(step, dryRun);
    } catch (err) {
      outcome = mismatch(err instanceof FcError ? err.message : `Could not reverse step ${step.seq}: ${err.code ?? err.message}`);
    }
    results.push({ seq: step.seq, op: step.op, ...outcome });
    if (!dryRun && (outcome.status === 'done' || outcome.status === 'irreversible')) finished.push(step.seq);
  }
  const clean = results.every((r) => r.status !== 'mismatch');
  if (!dryRun) journal.markUndone(run.file, finished, clean);
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
