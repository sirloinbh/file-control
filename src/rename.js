'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant } = require('./target');
const { LEFTOVER, SYSTEM_FOLDER, leftoverNote } = require('./guards');
const { moveWithoutOverwrite } = require('./safeMove');
const { sidecarMoves, clashOf } = require('./sidecar');

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
  if (caseOnly && caseOnly(rename, from)) {
    // The video only changed its case, and its sidecars still change theirs with it.
    if (rename.sidecars?.length) moveSidecars(rename, from, rename.to, access, caseOnly);
    return;
  }
  const taken = () => new FcError(`Not renamed because the name already exists: ${rename.name}${leftoverNote(from, rename.to)}`);
  // It does not touch an existing item. Opening a broken junction with wx would create a folder outside the target that the junction points to.
  if (fs.lstatSync(rename.to, { throwIfNoEntry: false })) throw taken();
  const to = access.write(rename.to);
  if (to !== rename.to) throw new FcError(`The path changed after planning: ${rename.to} -> ${to}`);
  if (!moveWithoutOverwrite(from, to)) throw taken();
  if (rename.sidecars?.length) moveSidecars(rename, from, to, access, caseOnly);
}

// The subtitle and sidecar files go with the video (#399). If one of them cannot move, what already moved (the sidecars before it and the video) goes back,
// so a video is never left with half of its group under the new name.
// It puts one moved item back. A move that only changed the case goes back the way it went (through caseOnly), because the old spelling is "taken" by the item itself.
function moveBack(src, dst, caseOnly) {
  if (caseOnly && src.toLowerCase() === dst.toLowerCase()) return caseOnly({ from: src, to: dst, name: path.basename(dst) }, src);
  return moveWithoutOverwrite(src, dst);
}

function moveSidecars(rename, videoFrom, videoTo, access, caseOnly) {
  const done = [];
  try {
    for (const move of rename.sidecars) {
      if (!fs.lstatSync(move.from, { throwIfNoEntry: false })) continue;
      const from = access.delete(move.from);
      if (from !== move.from) throw new FcError(`The path changed after planning: ${move.from} -> ${from}`);
      const pseudo = { from: move.from, to: move.to, name: path.basename(move.to) };
      if (caseOnly && caseOnly(pseudo, from)) {
        done.push(move);
        continue;
      }
      if (fs.lstatSync(move.to, { throwIfNoEntry: false })) throw new FcError(`Not renamed because the name already exists: ${path.basename(move.to)}`);
      const to = access.write(move.to);
      if (to !== move.to || !moveWithoutOverwrite(from, to)) throw new FcError(`Not renamed because the name already exists: ${path.basename(move.to)}`);
      done.push(move);
    }
  } catch (err) {
    const left = [];
    for (const move of [...done].reverse()) {
      try {
        if (!moveBack(move.to, move.from, caseOnly)) left.push(move.to);
      } catch {
        left.push(move.to);
      }
    }
    try {
      if (!moveBack(videoTo, videoFrom, caseOnly)) left.push(videoTo);
    } catch {
      left.push(videoTo);
    }
    const stuck = left.length > 0 ? ` Could not put these back: ${left.join(', ')}` : '';
    throw new FcError(`${err instanceof FcError ? err.message : `Could not rename a subtitle or sidecar file. (${err.code})`} The video and its sidecar files were left under the old names.${stuck}`);
  }
}

// It finds the sidecar files of every video of a plan and puts them on the rename (rename.sidecars), so the preview shows them and the run moves them.
// normalize also renames a subtitle on its own when its name holds a product number. When that rename leads to the very name the group would give it, the subtitle moves with its video
// (its own rename is dropped), so the group stays one unit; if it leads somewhere else, the subtitle keeps its own rename and does not go with the video.
// A name that is taken for any sidecar is a clash for the whole group: the video is not renamed either, and it is reported as skipped.
function withSidecars(renames) {
  const byFrom = new Map(renames.map((rename) => [rename.from.toLowerCase(), rename]));
  const groups = new Map();
  const absorbed = new Set();
  for (const rename of renames) {
    const moves = [];
    const own = [];
    for (const move of sidecarMoves(rename.from, rename.to)) {
      const itself = byFrom.get(move.from.toLowerCase());
      if (itself === undefined) moves.push(move);
      else if (itself !== rename && itself.to.toLowerCase() === move.to.toLowerCase()) {
        moves.push(move);
        absorbed.add(itself);
        own.push(itself);
      }
    }
    groups.set(rename, { moves, own });
  }
  const kept = [];
  const skipped = [];
  const claimed = new Set(renames.filter((rename) => !absorbed.has(rename)).map((rename) => rename.to.toLowerCase()));
  for (const rename of renames) {
    if (absorbed.has(rename)) continue;
    const { moves, own } = groups.get(rename);
    const reason = clashOf(moves, claimed);
    if (reason === null) {
      kept.push(moves.length > 0 ? { ...rename, sidecars: moves } : rename);
      continue;
    }
    const why = `Not renamed because a subtitle or sidecar file would clash (no overwriting): ${reason}`;
    skipped.push({ path: rename.from, reason: why }, ...own.map((item) => ({ path: item.from, reason: why })));
  }
  return { renames: kept, skipped };
}

// It applies a plan of { target, renames, ...rest }. It does not overwrite, and even if one file fails, it continues with the rest.
// The returned value is { target, dryRun, renamed, ...rest, failed }. failed is a list of { from, reason }.
function applyRenames(plan, { dryRun = false, caseOnly } = {}) {
  const { target, ...rest } = plan;
  const grouped = withSidecars(plan.renames);
  const { renames } = grouped;
  const result = { target, dryRun, renamed: [], ...rest, skipped: [...(plan.skipped ?? []), ...grouped.skipped], failed: [] };
  delete result.renames;
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

module.exports = { skipReason, applyRename, applyRenames, withSidecars };
