'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant } = require('./target');
const { LEFTOVER, SYSTEM_FOLDER, leftoverNote } = require('./guards');
const { moveWithoutOverwrite } = require('./safeMove');

// Shared by normalize-files and product-number.
// It returns the reason a file must not be renamed because of where it is, or null. entry.relative is the path under the target.
function skipReason(entry) {
  const parts = entry.relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return 'Not renamed because it is a leftover from an earlier job.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Not renamed because it is inside a Windows system folder.';
  return null;
}

// If the source was replaced by a link or the name got filled between the plan and the run, it does not change it. It does not overwrite and does not avoid it by adding a number.
// caseOnly is an optional (rename, from) => boolean for a caller that also handles a rename that changes only the case. It returns true when it handled the rename.
function applyRename(rename, access, { caseOnly } = {}) {
  const from = access.delete(rename.from);
  if (from !== rename.from) throw new FcError(`The path changed after planning: ${rename.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`No longer a file after planning: ${from}`);
  if (caseOnly && caseOnly(rename, from)) return;
  const taken = () => new FcError(`Not renamed because the name already exists: ${rename.name}${leftoverNote(from, rename.to)}`);
  // It does not touch an existing item. Opening a broken junction with wx would create a folder outside the target that the junction points to.
  if (fs.lstatSync(rename.to, { throwIfNoEntry: false })) throw taken();
  const to = access.write(rename.to);
  if (to !== rename.to) throw new FcError(`The path changed after planning: ${rename.to} -> ${to}`);
  if (!moveWithoutOverwrite(from, to)) throw taken();
}

// It applies a plan of { target, renames, ...rest }. It does not overwrite, and even if one file fails, it continues with the rest.
// The returned value is { target, dryRun, renamed, ...rest, failed }. failed is a list of { from, reason }.
function applyRenames(plan, { dryRun = false, caseOnly } = {}) {
  const { renames, target, ...rest } = plan;
  const result = { target, dryRun, renamed: [], ...rest, failed: [] };
  if (dryRun) return { ...result, renamed: renames };
  const access = grant(target, ['write', 'delete']);
  for (const rename of renames) {
    try {
      applyRename(rename, access, { caseOnly });
      result.renamed.push(rename);
    } catch (err) {
      result.failed.push({ from: rename.from, reason: err instanceof FcError ? err.message : `Could not rename. (${err.code})` });
    }
  }
  return result;
}

module.exports = { skipReason, applyRename, applyRenames };
