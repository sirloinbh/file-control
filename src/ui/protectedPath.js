'use strict';

// The protected-place check for the path fields of the UI screens (#290). CLAUDE.md rule 4: C:\Windows, Program Files and the hidden settings
// folders of the user folder are not touched unless the user names them.
// A typed path alone is not enough: a junction, a symbolic link or an 8.3 short name (C:\PROGRA~1) can lead into a protected place. So the check
// runs protectedReason (src/target.js) on the typed path and on every real path it can lead to:
// - An existing path: its real path (fs.realpathSync.native resolves links, junctions and short names).
// - A path that does not exist yet (a folder to create, a destination): the real path of its nearest existing parent, with the rest added back.
// - A dangling link on the way (a symbolic link whose target does not exist yet, such as ok\dang -> <home>\.ssh\newfile): realpath fails with
//   ENOENT, so each missing component is looked at with lstat, and a link's target (readlink, relative to the link's folder) is checked the same way.
// - Any other error (EACCES, a link loop, too many links) refuses the path: the check fails closed instead of trusting the typed path.

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('../commands');
const { protectedReason } = require('../target');

// The most links one path may lead through before the check gives up (and refuses).
const MAX_LINKS = 32;

class Unchecked extends Error {}

// A link target as Windows may store it (\\?\C:\x or \??\C:\x) in the plain form protectedReason understands.
function plainTarget(target) {
  return target.replace(/^(?:\\\\\?\\|\\\?\?\\)(?=[A-Za-z]:)/, '');
}

// Every real path p can lead to, added to out. It throws Unchecked when a path cannot be checked.
function collectReal(p, out, budget) {
  const rest = [];
  let current = p;
  let real;
  for (;;) {
    try {
      real = fs.realpathSync.native(current);
      break;
    } catch (err) {
      const parent = path.dirname(current);
      if ((err.code !== 'ENOENT' && err.code !== 'ENOTDIR') || parent === current) throw new Unchecked(err.code ?? err.message);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
  // real is the nearest existing parent, and its child rest[0] is where realpath failed: it is missing, or it is a dangling link.
  if (rest.length > 0) {
    const next = path.join(real, rest[0]);
    let stat = null;
    try {
      stat = fs.lstatSync(next);
    } catch (err) {
      // Missing (or its parent is a file): nothing below it exists either, so the path is plain from here.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new Unchecked(err.code ?? err.message);
    }
    if (stat && stat.isSymbolicLink()) {
      // A dangling link (Node reports a junction as a symbolic link too): its target is where a command would write.
      if (budget.left <= 0) throw new Unchecked('too many links');
      budget.left -= 1;
      let target;
      try {
        target = plainTarget(fs.readlinkSync(next));
      } catch (err) {
        throw new Unchecked(err.code ?? err.message);
      }
      out.push(path.join(next, ...rest.slice(1)));
      collectReal(path.join(path.resolve(real, target), ...rest.slice(1)), out, budget);
      return;
    }
    // It exists although realpath of it failed (it appeared meanwhile, or something odd). Do not guess.
    if (stat) throw new Unchecked('the path changed while it was checked');
  }
  out.push(path.join(real, ...rest));
}

// The reason p (an absolute path) is protected or cannot be checked, or null if it may be used.
function protectedPathReason(p) {
  const typed = protectedReason(p);
  if (typed) return typed;
  const reals = [];
  try {
    collectReal(p, reals, { left: MAX_LINKS });
  } catch (err) {
    if (!(err instanceof Unchecked)) throw err;
    return `its real path could not be checked: ${err.message}`;
  }
  for (const real of reals) {
    const reason = protectedReason(real);
    if (reason) return reason;
  }
  return null;
}

// Throws an FcError (shown as a 400 page, no job starts) if p is in a protected place or cannot be checked.
function refuseProtected(p, label) {
  const reason = protectedPathReason(p);
  if (reason) throw new FcError(`${label} is a protected place or cannot be checked (${reason}): ${p}`);
  return p;
}

module.exports = { protectedPathReason, refuseProtected };
