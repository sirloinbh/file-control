'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant } = require('./target');

// The number of attempts to find a name by adding a number after it so that an existing record is not overwritten even if run several times in the same second
const MAX_NAME_ATTEMPTS = 1000;
// The record file name. It is also used to leave record files out of the broken-file and duplicate judgments.
const REMOVAL_LOG = /^fctl-removed-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.json$/i;

const pad = (value, width = 2) => String(value).padStart(width, '0');

function nameStamp(now) {
  const date = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// It is a record meant to be read by a person, so it is written in local time with the time zone, not UTC.
function localTime(now) {
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const date = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${zone}`;
}

// It accepts only ordinary files that can be deleted. It checks with grant.delete so that the record and the real removal target do not diverge, and writes that real path.
function describeItem(access, item) {
  if (typeof item?.path !== 'string') throw new FcError(`The path to record is invalid: (${typeof item?.path})`);
  const label = item.path;
  if (typeof item.reason !== 'string' || item.reason.trim() === '') throw new FcError(`No removal reason: ${label}`);
  const real = access.delete(item.path);
  let stat;
  try {
    stat = fs.lstatSync(real);
  } catch (err) {
    throw new FcError(`Cannot check the file: ${label} (${err.code})`);
  }
  if (!stat.isFile()) throw new FcError(`Cannot record it because it is not a file: ${label}`);
  if (REMOVAL_LOG.test(path.basename(real))) throw new FcError(`A removal log cannot be a removal target: ${label}`);
  return { path: real, size: stat.size, reason: item.reason, ...(item.details === undefined ? {} : { details: item.details }) };
}

function describeItems(access, items) {
  const described = [];
  const seen = new Set();
  // Unlike map, for...of also visits and checks the holes of an array.
  for (const item of items) {
    const entry = describeItem(access, item);
    if (seen.has(entry.path)) throw new FcError(`The same file appears twice: ${entry.path}`);
    seen.add(entry.path);
    described.push(entry);
  }
  return described;
}

// It finds a free name. If dryRun, it does not create it and returns only the path; otherwise it creates it with wx and returns the fd too.
// It does not touch an existing item. Opening a broken junction with wx would create a folder outside the target that the junction points to, so it looks first with lstat.
function claimName(access, stamp, dryRun) {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(access.target, `fctl-removed-${stamp}${attempt === 1 ? '' : `-${attempt}`}.json`);
    try {
      if (fs.lstatSync(candidate, { throwIfNoEntry: false })) continue;
      const file = access.write(candidate);
      if (dryRun) return { file };
      return { file, fd: fs.openSync(file, 'wx') };
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (err instanceof FcError) throw err;
      throw new FcError(`Could not create the log file: ${candidate} (${err.code})`);
    }
  }
  throw new FcError(`Could not choose a log file name: fctl-removed-${stamp}`);
}

// It serializes before touching any file, to tell input errors from disk errors, and to catch them in the preview too.
function serialize(log) {
  try {
    return `${JSON.stringify(log, null, 2)}\n`;
  } catch (err) {
    throw new FcError(`Cannot record details: ${err.message}`);
  }
}

function removePartial(file, cause) {
  try {
    fs.rmSync(file);
  } catch (err) {
    throw new FcError(`Could not finish writing the log file and could not delete it either: ${file} (${cause.code}, ${err.code})`);
  }
  throw new FcError(`Could not write the log file: ${file} (${cause.code})`);
}

// Before removal, it leaves the path, size, and reason of the targets as a dated JSON file in the target folder. It does not delete files.
// Why JSON: whatever characters the name and reason contain, they can be restored as they are, and unlike CSV, Excel never runs a file name starting with = as a formula.
//
// kind: the removal kind (for example 'broken files'). items: a list of { path, reason, details? }.
// details is a value that differs by kind, such as the resolution, bitrate, or file to keep. path is a path relative to the target or an absolute path.
// The returned value is { path, count, items, dryRun }. items are the items written in the record, and their path is the real path.
// When removing, use this path instead of the input path, and since the folder can change in the meantime, check again with access.delete right before removing.
// The path in the preview is the expected name. If the time differs, the real name also differs, so the report uses the path of the real run.
// If there are no targets, it does not create a file and returns null.
// If even one target is an item that cannot be deleted, it raises an FcError and leaves nothing. It removes after coming back without an error.
function writeRemovalLog(dir, kind, items, { dryRun = false, now = new Date() } = {}) {
  if (typeof kind !== 'string' || kind.trim() === '') throw new FcError('Specify the removal kind.');
  if (!Array.isArray(items)) throw new FcError('Removal targets must be a list.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new FcError('The record time is invalid.');
  const access = grant(dir, ['write', 'delete']);
  if (items.length === 0) return null;
  const described = describeItems(access, items);
  const text = serialize({ kind, createdAt: localTime(now), target: access.target, count: described.length, items: described });
  const { file, fd } = claimName(access, nameStamp(now), dryRun);
  // So that the returned items do not diverge from the record, it restores them from the serialized content.
  const result = { path: file, count: described.length, items: JSON.parse(text).items, dryRun };
  if (dryRun) return result;
  let failure;
  try {
    fs.writeFileSync(fd, text);
    // It flushes before returning so that removal does not happen before the record reaches the disk.
    fs.fsyncSync(fd);
  } catch (err) {
    failure = err;
  }
  try {
    fs.closeSync(fd);
  } catch (err) {
    failure ??= err;
  }
  if (failure) removePartial(file, failure);
  return result;
}

module.exports = { writeRemovalLog, REMOVAL_LOG };
