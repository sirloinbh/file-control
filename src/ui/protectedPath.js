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

// The longest path and the most components the check walks. Longer paths are refused: Windows paths end at 32767 characters, and walking up a
// path with very many missing components would block the server.
const MAX_PATH_CHARS = 32767;
const MAX_COMPONENTS = 1000;

// A name that ends with a dot or a space (Windows tools read it as another name).
const TRAILING_DOT_OR_SPACE = /[\s\u0085.]$/;

class Unchecked extends Error {}

// The first component of an absolute path p that ends with a dot or a space, or undefined. Only Windows reads such names differently.
function trailingDotOrSpacePart(p) {
  if (process.platform !== 'win32') return undefined;
  return p.slice(path.parse(p).root.length).split(/[\\/]/).find((part) => TRAILING_DOT_OR_SPACE.test(part));
}

// A link target in a form protectedReason understands: a plain drive path (C:\x; \\?\C:\x and \??\C:\x are made plain) or a relative path,
// which is read from the link's folder. Anything else (a UNC path such as \\localhost\C$\x, \\?\UNC\..., a volume GUID path \\?\Volume{...}\,
// a device path \\.\..., a drive-relative C:x or a rooted \x) can lead anywhere, so it is not checked: the path is refused.
function plainTarget(target) {
  const plain = target.replace(/^(?:\\\\\?\\|\\\?\?\\)(?=[A-Za-z]:)/, '');
  const refuse = () => { throw new Unchecked(`a link points to a path that cannot be checked: ${target}`); };
  // A ? or * cannot be part of a Windows name, and a : only follows the drive letter. Such a target is an NT path in disguise
  // (for example D:\??\Volume{...}\x, which Node's symlinkSync stores for a \??\Volume{...} target).
  const named = /^[A-Za-z]:/.test(plain) ? plain.slice(2) : plain;
  if (/[?*:]/.test(named)) refuse();
  if (/^[A-Za-z]:[\\/]/.test(plain)) return plain;
  if (/^[A-Za-z]:/.test(plain) || /^[\\/]/.test(plain)) refuse();
  return plain;
}

// Every real path p can lead to, added to out. It throws Unchecked when a path cannot be checked.
function collectReal(p, out, budget) {
  if (p.length > MAX_PATH_CHARS || p.split(/[\\/]/).length > MAX_COMPONENTS) throw new Unchecked('the path is too long');
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
      rest.push(path.basename(current));
      current = parent;
    }
  }
  // The components were collected from the end.
  rest.reverse();
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
        target = fs.readlinkSync(next);
      } catch (err) {
        throw new Unchecked(err.code ?? err.message);
      }
      target = plainTarget(target);
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

module.exports = { protectedPathReason, refuseProtected, trailingDotOrSpacePart, TRAILING_DOT_OR_SPACE };
