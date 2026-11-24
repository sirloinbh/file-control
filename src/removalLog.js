'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant } = require('./target');
const journal = require('./journal');

// The version of the record layout. 1: every item has an `outcome` (pending, removed, failed) and a failed item has `error`.
const LOG_VERSION = 1;
// The name of the separate record file that older versions wrote (#415 moved the record into the change journal). It is still used to leave such old files out of the broken-file and duplicate judgments.
const REMOVAL_LOG = /^fctl-removed-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.json$/i;

const pad = (value, width = 2) => String(value).padStart(width, '0');

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
  if (real.split(path.sep).some((part) => part.toLowerCase() === journal.JOURNAL_FOLDER)) throw new FcError(`The change journal cannot be a removal target: ${label}`);
  return { path: real, size: stat.size, reason: item.reason, outcome: 'pending', ...(item.details === undefined ? {} : { details: item.details }) };
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

// It serializes before touching any file, to tell input errors from disk errors, and to catch them in the preview too.
function serialize(record) {
  try {
    return JSON.stringify(record);
  } catch (err) {
    throw new FcError(`Cannot record details: ${err.message}`);
  }
}

// Before removal, it writes the path, size, and reason of the targets into the change journal of the current run (#415), flushed to the disk. It does not delete files.
// Why JSON: whatever characters the name and reason contain, they can be restored as they are, and a file name starting with = is never run as a formula.
//
// kind: the removal kind (for example 'broken files'). items: a list of { path, reason, details? }.
// details is a value that differs by kind, such as the resolution, bitrate, or file to keep. path is a path relative to the target or an absolute path.
// The returned value is { path, count, items, dryRun }. path is the journal file, items are the items written in the record, and their path is the real path.
// When removing, use this path instead of the input path, and since the folder can change in the meantime, check again with access.delete right before removing.
// If there are no targets, it writes nothing and returns null.
// If even one target is an item that cannot be deleted, it raises an FcError and leaves nothing. It removes after coming back without an error.
// A journal run must be open (execute opens one; runConfirmedRemoval opens its own when it is called without one).
function writeRemovalLog(dir, kind, items, { dryRun = false, now = new Date() } = {}) {
  if (typeof kind !== 'string' || kind.trim() === '') throw new FcError('Specify the removal kind.');
  if (!Array.isArray(items)) throw new FcError('Removal targets must be a list.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new FcError('The record time is invalid.');
  const access = grant(dir, ['write', 'delete']);
  if (items.length === 0) return null;
  const described = describeItems(access, items);
  const record = { type: 'removal', version: LOG_VERSION, kind, createdAt: localTime(now), target: access.target, count: described.length, items: described };
  const text = serialize(record);
  // So that the returned items do not diverge from the record, it restores them from the serialized content.
  const document = JSON.parse(text);
  const result = { path: undefined, count: described.length, items: document.items, dryRun, document };
  if (dryRun) return result;
  if (!journal.current()) throw new FcError('The change journal is not open, so the removal record cannot be written. Nothing was deleted.');
  try {
    result.path = journal.writeRemoval(document);
  } catch (err) {
    throw new FcError(`Could not write the removal record into the change journal. Nothing was deleted. (${err.message})`);
  }
  return result;
}

// It writes the outcome of items into the journal. updates is a Map of item index => { outcome, error? }.
// It is one more line, so a crash leaves the earlier lines as they are.
function updateRemovalLog(log, updates) {
  for (const [index, update] of updates) Object.assign(log.items[index], update);
  try {
    journal.writeRemoval({ type: 'removal-outcome', updates: [...updates].map(([index, update]) => ({ index, ...update })) });
  } catch (err) {
    throw new FcError(`Could not update the removal record in the change journal: ${err.message}`);
  }
}

module.exports = { writeRemovalLog, updateRemovalLog, REMOVAL_LOG, LOG_VERSION };
