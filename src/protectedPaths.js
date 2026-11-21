'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('./commands');

// It normalizes the target directory to a real absolute path. If it does not exist or is not a folder, it raises an error.
// It also refuses a folder that is inside a protected path or contains a protected path (C:\, the user folder, and so on).
function resolveTarget(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new FcError('Specify a target folder.');
  if (dir.includes('\0')) throw new FcError('The target path contains a NUL character.');
  const abs = path.resolve(dir);
  rejectNetworkPath(abs);
  // A folder you have no permission to see, such as System Volume Information, Recovery, and another user's AppData, cannot be checked, so it is not accepted.
  const unreadable = (err) => new FcError(`Cannot use the target folder because it cannot be checked: ${abs} (${err.code ?? err.message})`);
  let stat;
  try {
    stat = fs.statSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    throw unreadable(err);
  }
  if (!stat) throw new FcError(`Target folder does not exist: ${abs}`);
  if (!stat.isDirectory()) throw new FcError(`Target is not a folder: ${abs}`);
  // It matches case, 8.3 short names, and drive letter spelling to one real path.
  let target;
  try {
    target = fs.realpathSync.native(abs);
  } catch (err) {
    throw unreadable(err);
  }
  rejectNetworkPath(target);
  rejectTrailingDotOrSpace(target);
  const reason = protectedReason(target);
  if (reason) throw new FcError(`Cannot use a protected path as the target: ${target} (${reason})`);
  return target;
}

// UNC and network paths (\\server\share, \\localhost\C$, and so on) can bypass protected paths, so they are not accepted as a target.
// It allows only long path prefixes that point to a local drive, such as \\?\C:\.
function rejectNetworkPath(p) {
  if (process.platform !== 'win32') return;
  if (p.startsWith('\\\\') && !/^\\\\\?\\[A-Za-z]:/.test(p)) {
    throw new FcError(`Cannot use a network path as the target: ${p}`);
  }
}

// Node sees a trailing dot or space literally, but PowerShell, tar.exe, and .NET remove it.
// AppData. If the same folder is accepted as the target, it becomes AppData in those tools and bypasses the protected path.
const TRAILING_DOT_OR_SPACE = /[\s\u0085.]$/;

function rejectTrailingDotOrSpace(target) {
  if (process.platform !== 'win32') return;
  const name = target.slice(path.parse(target).root.length).split(path.sep).find((part) => TRAILING_DOT_OR_SPACE.test(part));
  if (name !== undefined) throw new FcError(`Cannot use a folder whose name ends with a dot or space as the target: ${target}`);
}

// It aligns the protected reference paths the same way as the target (real path). If the path does not exist, it uses it as is.
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// Windows system folders. If the environment variable is missing or not an absolute path, it uses the default location.
// In 32-bit Node, ProgramFiles points to the x86 folder, so the 64-bit folder is looked at separately with ProgramW6432.
// C:\Users\All Users is a link that points to ProgramData, so aligning to the real path lands on ProgramData (#50).
function systemRoots() {
  if (process.platform !== 'win32') return [];
  const env = process.env;
  const pick = (value, fallback) => (value && path.isAbsolute(value) ? value : fallback);
  const systemDrive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive : 'C:';
  return [
    pick(env.SystemRoot, 'C:\\Windows'),
    pick(env.ProgramFiles, 'C:\\Program Files'),
    pick(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)'),
    pick(env.ProgramW6432, 'C:\\Program Files'),
    pick(env.ProgramData, pick(env.ALLUSERSPROFILE, 'C:\\ProgramData')),
    `${systemDrive}\\Recovery`,
  ].map(realOrResolved);
}

// The system hidden folders at the root of each drive (the Recycle Bin, restore points). The names come out in mixed case (C:\$Recycle.Bin, D:\$RECYCLE.BIN).
const DRIVE_SYSTEM_FOLDERS = ['$recycle.bin', 'system volume information'];

// A drive root can get a Recycle Bin at any time (on the first rm), so it is blocked regardless of whether it exists.
// It does not recognize the root of a volume mounted on a folder (C:\mnt\vol).
function driveSystemReason(target) {
  if (process.platform !== 'win32') return null;
  const { root } = path.parse(target);
  const [first] = target.slice(root.length).split(path.sep);
  if (!first) return { kind: 'contains', reason: `drive root ${root} (holds or will hold the Recycle Bin and System Volume Information)` };
  if (DRIVE_SYSTEM_FOLDERS.includes(first.toLowerCase())) return { kind: 'inside', reason: `system folder ${path.join(root, first)}` };
  return null;
}

// Other profiles under the profile folder (C:\Users). Public is an ordinary shared folder, so it is allowed, and
// Default is the original profile of new users, so it is blocked as a whole. For other users, like the current user, the profile itself and the hidden settings folders are blocked.
// The profile folder is found as the parent of PUBLIC (C:\Users\Public). This rule is used only when the user folder is directly under it.
// This is so that, when the user folder was moved elsewhere, its sibling folders are not wrongly seen as other users.
function profilesDir() {
  const env = process.env;
  const systemDrive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive : 'C:';
  const pub = env.PUBLIC && path.isAbsolute(env.PUBLIC) ? env.PUBLIC : `${systemDrive}\\Users\\Public`;
  return realOrResolved(path.dirname(pub));
}

function otherProfileReason(target, home) {
  if (process.platform !== 'win32') return null;
  const profiles = profilesDir();
  // path.relative is case-insensitive on Windows.
  if (profiles === path.parse(profiles).root || path.relative(profiles, path.dirname(home)) !== '' || !isInside(profiles, target)) return null;
  const rel = path.relative(profiles, target);
  if (rel === '') return null;
  const [name, sub] = rel.split(path.sep);
  const lower = name.toLowerCase();
  if (lower === 'public') return null;
  const profile = path.join(profiles, name);
  if (lower === 'default' || lower === 'default user') return { kind: 'inside', reason: `default user profile ${profile}` };
  if (sub === undefined) return { kind: 'itself', reason: `another user's folder ${profile}` };
  if (isHiddenSettings(sub)) return { kind: 'inside', reason: `another user's settings folder ${path.join(profile, sub)}` };
  return null;
}

function homeDir() {
  let home;
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (!home || !path.isAbsolute(home)) throw new FcError('Cannot check protected paths because the user folder is unknown.');
  return realOrResolved(home);
}

// It checks whether it is a hidden settings folder directly under the user folder (a folder starting with a dot such as .ssh and .config, and AppData).
function isHiddenSettings(name) {
  return name.startsWith('.') || name.toLowerCase() === 'appdata';
}

// If the target overlaps a protected path, it returns { reason, kind }; otherwise null. kind says how the target relates to the protected path, so callers do not read the reason text (#317):
// 'inside' (the target is inside a protected folder, so every folder under it is protected too), 'contains' (the target holds a protected folder, so each child differs),
// and 'itself' (the target is the protected folder, and its children are not protected by that).
function protectedInfo(target) {
  for (const root of systemRoots()) {
    if (isInside(root, target)) return { kind: 'inside', reason: `system folder ${root}` };
    if (isInside(target, root)) return { kind: 'contains', reason: `contains system folder ${root}` };
  }
  const drive = driveSystemReason(target);
  if (drive) return drive;
  const home = homeDir();
  if (isInside(target, home)) return { kind: 'contains', reason: `contains user folder ${home}` };
  if (isInside(home, target)) {
    const [first] = path.relative(home, target).split(path.sep);
    if (isHiddenSettings(first)) return { kind: 'inside', reason: `user settings folder ${path.join(home, first)}` };
    return null;
  }
  return otherProfileReason(target, home);
}

// True if p (a path relative to the target or an absolute path) is the target itself or inside it.
// On Windows it is case-insensitive, and another drive is seen as outside. Links are not considered.
function isInside(target, p) {
  const rel = path.relative(target, path.resolve(target, p));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

// If the target overlaps a protected path, it returns the reason; otherwise null.
function protectedReason(target) {
  return protectedInfo(target)?.reason ?? null;
}

module.exports = { resolveTarget, isInside, protectedReason, protectedInfo, TRAILING_DOT_OR_SPACE };
