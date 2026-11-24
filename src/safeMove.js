'use strict';

const fs = require('node:fs');
const { FcError } = require('./commands');
const journal = require('./journal');

// It moves without overwriting. If it already exists (including an 8.3 short name or case), it changes nothing and returns false.
// renameSync overwrites the target (a folder also overwrites a file of the same name, confirmed on build 26200), so it is not used as is.
// For a file, it creates a hard link under the new name and then deletes the original name (#73). linkSync fails with EEXIST if the name exists, so it does not overwrite a file that slipped in,
// and even if the power goes off midway, only two names with the same content remain, with no empty file left. If the source is locked and the original name cannot be deleted, it deletes the new name and rolls back.
// When a hard link cannot be made (FAT32, exFAT, cloud-only files, and so on) and for folders, it first creates an empty placeholder file and then moves over it.
function moveWithoutOverwrite(from, to) {
  const moved = moveUnrecorded(from, to);
  if (moved) journal.record('move', { from, to });
  return moved;
}

function moveUnrecorded(from, to) {
  if (fs.lstatSync(from).isFile()) {
    try {
      fs.linkSync(from, to);
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      // Even if it reported failure, the link may have been made (a lost network response and so on). Then it is a name I made, so it goes on to delete the original name.
      if (!sameFile(from, to)) return moveOverPlaceholder(from, to);
    }
    try {
      fs.unlinkSync(from);
    } catch (err) {
      removeNewName(from, to, err);
      throw err;
    }
    return true;
  }
  return moveOverPlaceholder(from, to);
}

function moveOverPlaceholder(from, to) {
  try {
    fs.closeSync(fs.openSync(to, 'wx'));
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.renameSync(from, to);
  } catch (err) {
    removePlaceholder(to, err);
    throw err;
  }
  return true;
}

// It checks by file ID whether it is the same file. Windows file IDs are 64 bits, so it reads them as bigint.
// On a file system that reports the file ID as 0 (some network drives), it is seen as not the same, so that different files are not seen as the same.
function sameFile(a, b) {
  const sa = fs.lstatSync(a, { bigint: true, throwIfNoEntry: false });
  const sb = fs.lstatSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(sa && sb && sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev);
}

// If it could not delete the original name, it deletes the hard link it made and rolls back. If the new name was replaced by another file in the meantime, it does not delete.
function removeNewName(from, to, cause) {
  let ours;
  try {
    ours = sameFile(from, to);
  } catch (err) {
    throw new FcError(`Could not move, and could not check the new name either: ${to} (${cause.code}, ${err.code})`);
  }
  if (!ours) {
    if (!fs.lstatSync(to, { throwIfNoEntry: false })) return;
    throw new FcError(`Could not move, and the new name was turned into a different file in the meantime, so it was not deleted: ${to} (${cause.code})`);
  }
  try {
    fs.unlinkSync(to);
  } catch (err) {
    throw new FcError(`Could not move, and could not delete the new name either, so the same file remains under two names: ${from}, ${to} (${cause.code}, ${err.code})`);
  }
}

// If another program wrote content in the meantime, it is not my placeholder, so it does not delete it.
function removePlaceholder(to, cause) {
  let stat;
  try {
    stat = fs.lstatSync(to, { throwIfNoEntry: false });
  } catch (err) {
    throw new FcError(`Could not move, and could not check the placeholder file either: ${to} (${cause.code}, ${err.code})`);
  }
  if (!stat) return;
  if (!stat.isFile() || stat.size !== 0) throw new FcError(`Could not move, and the placeholder file now has other content, so it was not deleted: ${to} (${cause.code})`);
  try {
    fs.rmSync(to, { force: true, maxRetries: 3 });
  } catch (err) {
    throw new FcError(`Could not move, and could not delete the empty placeholder file either: ${to} (${cause.code}, ${err.code})`);
  }
}

module.exports = { moveWithoutOverwrite, sameFile };
