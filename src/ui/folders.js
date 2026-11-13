'use strict';

// Data for the folder picker screen of fctl ui (#254). It is a function kept apart from the screen (HTML), so it can be tested without a server.
// It builds the drive list, the frequently used places (Downloads, Desktop, Documents), the list and summary inside a folder, going up, and the protected folder marks.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError, list } = require('../commands');
const { protectedReason } = require('../target');

// True if it is a folder. False if it does not exist or cannot be read.
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The drive root list (C:\, D:\ ...). If it is not Windows, it is the single root (/). exists is swapped in tests.
function listDrives({ platform = process.platform, exists = isDirectory } = {}) {
  if (platform !== 'win32') return [path.parse(process.cwd()).root];
  const drives = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (exists(root)) drives.push(root);
  }
  return drives;
}

// OneDrive folder candidates. The environment variables (personal and company) and the OneDrive and "OneDrive - Company" folders under the user folder.
function oneDriveFolders(home, env, readDir) {
  const found = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((p) => typeof p === 'string' && path.isAbsolute(p));
  let names = [];
  try {
    names = readDir(home);
  } catch {
    names = [];
  }
  for (const name of names) if (/^OneDrive(?:$| - )/i.test(name)) found.push(path.join(home, name));
  // It does not put the same folder in twice (case-insensitive).
  const seen = new Set();
  return found.filter((p) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The real locations of Downloads, Desktop, and Documents that Windows uses (the registry User Shell Folders, with environment variables expanded) (first review).
// If moved to OneDrive, this value points to the OneDrive side. reg.exe garbles Korean paths with the code page, so it is received from PowerShell as UTF-8 JSON.
const SHELL_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'",
  "@{ downloads = $k.'{374DE290-123F-4565-9164-39C4925E467B}'; desktop = $k.Desktop; documents = $k.Personal } | ConvertTo-Json -Compress",
].join('; ');

// The registered locations ({ downloads?, desktop?, documents? }). If it cannot read them, it is an empty object. It is read only once while the server runs.
let shellCache = null;
function shellFolders() {
  if (shellCache) return shellCache;
  shellCache = {};
  if (process.platform !== 'win32') return shellCache;
  try {
    const output = childProcess.execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SHELL_SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30 * 1000, windowsHide: true });
    const parsed = JSON.parse(output);
    for (const key of ['downloads', 'desktop', 'documents']) if (typeof parsed[key] === 'string' && path.isAbsolute(parsed[key])) shellCache[key] = parsed[key];
  } catch {
    // If it cannot be read, it looks for the candidate paths below.
  }
  return shellCache;
}

// The real paths of the frequently used places ({ label, path }). It uses the locations registered in Windows (shell) first, and if absent or that folder does not exist, it looks at the candidates in order.
// Candidates: for Desktop and Documents, it looks at the one moved to OneDrive first. The OneDrive-side folder names are made in the display language ("바탕 화면", "문서", Korean for Desktop and Documents), so it looks together with the English names.
// It returns only folders that exist.
function commonPlaces({ home = os.homedir(), env = process.env, exists = isDirectory, readDir = (dir) => fs.readdirSync(dir), shell = shellFolders } = {}) {
  if (!home || !path.isAbsolute(home)) return [];
  const oneDrive = oneDriveFolders(home, env, readDir);
  const registered = shell();
  const first = (key) => (registered[key] ? [registered[key]] : []);
  const candidates = [
    { label: 'Downloads', paths: [...first('downloads'), path.join(home, 'Downloads')] },
    { label: 'Desktop', paths: [...first('desktop'), ...oneDrive.flatMap((dir) => [path.join(dir, 'Desktop'), path.join(dir, '바탕 화면')]), path.join(home, 'Desktop')] },
    { label: 'Documents', paths: [...first('documents'), ...oneDrive.flatMap((dir) => [path.join(dir, 'Documents'), path.join(dir, '문서')]), path.join(home, 'Documents')] },
  ];
  const places = [];
  for (const { label, paths } of candidates) {
    const found = paths.find((p) => exists(p));
    if (found) places.push({ label, path: found });
  }
  return places;
}

// If it is a protected folder, that reason; otherwise null. If the reason cannot be known (the user folder is unknown and so on), it returns a reason so that it cannot be picked.
// A name ending in a dot or a space also returns a reason so that it cannot be picked. PowerShell and .NET remove those characters and read it as another folder (AppData. -> AppData) (first review).
function protection(dir) {
  if (process.platform === 'win32') {
    const name = dir.slice(path.parse(dir).root.length).split(path.sep).find((part) => TRAILING_DOT_OR_SPACE.test(part));
    if (name !== undefined) return `name ending with a dot or space (${name})`;
  }
  try {
    return protectedReason(dir);
  } catch (err) {
    if (err instanceof FcError) return err.message;
    throw err;
  }
}

// A name ending in a dot or a space (the same criterion as target.js)
const TRAILING_DOT_OR_SPACE = /[\s\u0085.]$/;

// True if it is a network or device path (\\server\share, \\?\, \\.\). Opening it would try to connect to that server and could leak credentials, so it is not opened (first review).
function isNetworkOrDevicePath(p) {
  return process.platform === 'win32' && /^[\\/]{2}/.test(p);
}

// It turns the input path into a real folder path (first review). It resolves 8.3 short names (C:\PROGRA~1), case, and junctions and symbolic links
// so that the protection judgment and the picked value point to the real folder. It refuses network and device paths and links that lead there.
function realFolder(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) throw new FcError(`Not an absolute path: ${dir}`);
  if (isNetworkOrDevicePath(dir)) throw new FcError(`Network and device paths are not opened: ${dir}`);
  const resolved = path.resolve(dir);
  if (!isDirectory(resolved)) throw new FcError(`Not a folder or does not exist: ${resolved}`);
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (err) {
    throw new FcError(`Cannot check the folder: ${resolved} (${err.code ?? err.message})`);
  }
  if (isNetworkOrDevicePath(real)) throw new FcError(`Folders that lead to a network path are not opened: ${resolved}`);
  return real;
}

// If a child inherits the parent's protection reason, it returns that reason (first review, so as not to judge each child in a large folder).
// If the parent is "inside" a protected folder (a system folder, a settings folder, and so on), the child is the same. If the parent is blocked because it "contains" a protected folder (a drive root, the user folder itself) or
// the reason could not be known, it differs for each child, so it is null.
function inheritedProtection(parentReason) {
  if (parentReason === null || parentReason.startsWith('contains ')) return null;
  return /^(?:system folder|user settings folder|another user's settings folder|default user profile|name ending with a dot or space)/.test(parentReason) ? parentReason : null;
}

// The limit on the number of subfolders shown on the screen. It keeps the screen from getting too large and the server from stalling long on a large folder (C:\Windows\WinSxS and so on) (first review).
const MAX_FOLDERS = 1000;

// It opens one folder and returns the content for the picker screen.
// - path: the real path (with links and short names resolved), parent: the folder above (null for a drive root)
// - protected: the reason this folder cannot be picked (a system folder, the user folder itself, AppData, .ssh, and so on, a name ending in a dot or space) or null
// - folders: the folders inside ({ name, path, protected }) in name order, and if there are many, the first MAX_FOLDERS. hiddenFolders: the number of folders dropped by the limit
// - files: the number of files inside, size: the total file size (excluding subfolders)
// A protected folder can also be looked into (it only reads). Only picking is blocked.
function browseFolder(dir) {
  const resolved = realFolder(dir);
  let entries;
  try {
    entries = list(resolved);
  } catch (err) {
    if (err instanceof FcError) throw err;
    throw new FcError(`Cannot read the folder: ${resolved} (${err.code ?? err.message})`);
  }
  const own = protection(resolved);
  const inherited = inheritedProtection(own);
  const dirs = entries.filter((entry) => entry.type === 'dir');
  const folders = dirs.slice(0, MAX_FOLDERS).map((entry) => {
    const full = path.join(resolved, entry.name);
    return { name: entry.name, path: full, protected: inherited ?? protection(full) };
  });
  const files = entries.filter((entry) => entry.type === 'file');
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    protected: own,
    folders,
    hiddenFolders: dirs.length - folders.length,
    files: files.length,
    size: files.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
  };
}

module.exports = { listDrives, commonPlaces, browseFolder, MAX_FOLDERS };
