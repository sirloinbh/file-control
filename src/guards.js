'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('./commands');
const { isInside } = require('./target');
const { sameFile } = require('./safeMove');

// Shared skip rules and repository/project detection. They live here so that flatten, productName, collapse, extract and the remove-* modules do not import each other.

// The NTFS file name limit (in UTF-16 characters)
const MAX_NAME = 255;

// Leftovers left when mv or zip failed. They must stay at the location the error message told in order to be recovered, so they are not moved.
const LEFTOVER = /^\.fctl-(?:old|new)-\d+-\d+-\d+(?:\.|$)/;

// A folder Windows manages. Taking out the files inside breaks them together with the restore information.
const SYSTEM_FOLDER = /^(?:\$RECYCLE\.BIN|System Volume Information)$/i;

// What is seen as a folder a program uses by name alone. A program finds files by the inner structure and names, so it does not work if scattered (#65).
const PROGRAM_FOLDER = /^(?:node_modules|bower_components|__pycache__|site-packages)$/i;

// Files that, if present, make the folder a project or Python virtual environment folder.
const PROJECT_FILE = /^(?:package\.json|pyvenv\.cfg|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|CMakeLists\.txt|composer\.json|Gemfile|.+\.(?:sln|csproj|vcxproj|fsproj|vbproj))$/i;

// A version control folder. The inner structure is the content, so if scattered it cannot be recovered.
const REPOSITORY_FOLDER = /^\.(?:git|hg|svn|jj)$/i;

// If HEAD, objects, and refs are together, it is a Git repository folder. A bare repository (backup.git) is caught even when the name is not .git.
function looksLikeGitDir(dir) {
  const stat = (name) => fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
  try {
    return Boolean(stat('HEAD')?.isFile() && stat('objects')?.isDirectory() && stat('refs')?.isDirectory());
  } catch (err) {
    throw new FcError(`Cannot check whether it is a repository: ${dir} (${err.code})`);
  }
}

// In a repository the folder structure itself is the content, so even skipping only the inside of .git would scatter the working files and make them unrecoverable. It refuses instead of moving only part.
// If the target is an ordinary subfolder of a repository (r/src), the repository is not broken and can be restored with git, so it is not blocked.
function rejectRepository(target, entries) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (REPOSITORY_FOLDER.test(path.basename(dir)) || looksLikeGitDir(dir)) throw new FcError(`Not handled because it is inside a repository: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  const folder = entries.find((entry) => entry.relative.split(path.sep).some((part) => REPOSITORY_FOLDER.test(part)));
  if (folder) throw new FcError(`Not handled because it contains a repository: ${folder.path}`);
  const bare = entries.find((entry) => entry.type === 'file' && path.basename(entry.path) === 'HEAD' && looksLikeGitDir(path.dirname(entry.path)));
  if (bare) throw new FcError(`Not handled because it contains a repository: ${path.dirname(bare.path)}`);
}

// It checks whether it is a place where a project marker file or an executable and DLL easily land by accident (#148). A drive root, the user folder and above,
// directly under the user folder (Downloads, Desktop, Documents, and so on), and directly under the OneDrive folder (OneDrive\Desktop and so on) are not seen as a project even if a downloaded package.json or
// an installer is there. From the folder below that (Downloads\myproj), it looks.
// A folder the user made (user-folder\myproj) is the terminal's default location where projects often appear, so only the fixed names are skipped (first review).
function isCommonPlace(dir, home) {
  if (dir === path.dirname(dir)) return true;
  if (!home) return false;
  if (isInside(dir, home)) return true;
  const name = path.basename(dir);
  const parent = path.dirname(dir);
  if (path.relative(home, parent) === '') return HOME_FOLDER.test(name) || ONEDRIVE.test(name);
  return path.relative(home, path.dirname(parent)) === '' && ONEDRIVE.test(path.basename(parent)) && ONEDRIVE_FOLDER.test(name);
}

// The default folders directly under the user folder. The disk names are English even on Korean Windows.
const HOME_FOLDER = /^(?:Downloads|Desktop|Documents|Pictures|Videos|Music|Favorites|Links|Saved Games|Searches|Contacts|3D Objects)$/i;
// The OneDrive folder (OneDrive, OneDrive - Company) and the default folders it syncs directly under it. The OneDrive side is made with display language names.
const ONEDRIVE = /^OneDrive(?:$| - )/i;
const ONEDRIVE_FOLDER = /^(?:Desktop|Documents|Pictures|Videos|Music|Attachments|바탕 화면|문서|사진|동영상|음악|첨부 파일)$/i;

// The real path of the user folder. If unknown, it returns an empty string, and then it skips only drive roots (the side that blocks more).
function realHome() {
  let home;
  try {
    home = os.homedir();
  } catch {
    return '';
  }
  if (!home || !path.isAbsolute(home)) return '';
  try {
    return fs.realpathSync.native(home);
  } catch {
    return path.resolve(home);
  }
}

// If a folder above the target is a project folder (a marker file directly inside) or a program folder (an executable and a DLL together), it refuses (#148).
// If myproj/src is scattered when myproj/package.json exists, the project breaks, and without a repository it cannot be undone.
// It looks at all folders above but skips the ones where isCommonPlace is true. It does not cut by number of levels (myproj/src/a/b is also blocked).
function rejectProjectAncestor(target) {
  const home = realHome();
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    if (!isCommonPlace(dir, home)) {
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch (err) {
        throw new FcError(`Cannot check whether a parent folder is a project folder: ${dir} (${err.code})`);
      }
      const marker = names.find((name) => PROJECT_FILE.test(name));
      if (marker) throw new FcError(`Not handled because a parent folder looks like a project folder (contains ${marker}): ${dir}`);
      const exts = new Set(names.map((name) => path.extname(name).toLowerCase()));
      if (exts.has('.exe') && exts.has('.dll')) throw new FcError(`Not handled because a parent folder holds both executables and DLLs, so it is treated as a program folder: ${dir}`);
    }
    if (dir === path.dirname(dir)) break;
  }
}

// When the target name already exists and it looks like something an earlier run left by stopping midway, it returns a message that says so (#73).
function leftoverNote(from, to) {
  try {
    if (sameFile(from, to)) return ' (another name of the same file as the source (a hard link). It may be a trace of an earlier run that stopped midway; delete one of the names)';
    const target = fs.lstatSync(to, { throwIfNoEntry: false });
    if (target?.isFile() && target.size === 0 && fs.lstatSync(from).size > 0) {
      return ' (that name is an empty file. It may be a placeholder left when an earlier run stopped midway; check it, delete it, and run again)';
    }
  } catch {
    // Only the notice message is left out.
  }
  return '';
}

module.exports = { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER, PROGRAM_FOLDER, PROJECT_FILE, leftoverNote, rejectRepository, looksLikeGitDir, rejectProjectAncestor };
