'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const isWindows = process.platform === 'win32';
// Git Bash 등에 들어 있는 GNU tar 대신 zip을 다룰 수 있는 Windows 기본 bsdtar를 쓴다.
const TAR = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

class FcError extends Error {}

function exists(p) {
  return fs.existsSync(p);
}

function ensureExists(p) {
  if (!exists(p)) throw new FcError(`경로가 없습니다: ${p}`);
}

function ensureFree(p, force) {
  if (exists(p) && !force) throw new FcError(`이미 있습니다: ${p} (덮어쓰려면 --force)`);
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${i === 0 ? size : size.toFixed(1)}${units[i]}`;
}

function list(dir = '.') {
  ensureExists(dir);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: stat && !entry.isDirectory() ? stat.size : null,
        modified: stat ? stat.mtime : null,
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

function makeDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return `폴더 생성: ${dir}`;
}

function writeFile(file, content, { append = false, force = false } = {}) {
  if (!append) ensureFree(file, force);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (append) fs.appendFileSync(file, content);
  else fs.writeFileSync(file, content);
  return `${append ? '내용 추가' : '파일 작성'}: ${file}`;
}

function readFile(file) {
  ensureExists(file);
  return fs.readFileSync(file, 'utf8');
}

function rename(target, newName, { force = false } = {}) {
  ensureExists(target);
  if (newName.includes('/') || newName.includes('\\')) {
    throw new FcError('새 이름에는 경로를 넣을 수 없습니다. 옮기려면 mv를 쓰세요.');
  }
  const dest = path.join(path.dirname(target), newName);
  ensureFree(dest, force);
  fs.renameSync(target, dest);
  return `이름 변경: ${target} -> ${dest}`;
}

function moveOne(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // 다른 드라이브로 옮길 때는 rename이 안 되므로 복사 후 원본을 지운다.
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// dest가 이미 있는 폴더면 그 안으로, 아니면 dest라는 이름으로 옮긴다.
function resolveDest(src, dest) {
  return exists(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, path.basename(src)) : dest;
}

function move(sources, dest, { force = false } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`여러 개를 옮기려면 대상이 있는 폴더여야 합니다: ${dest}`);
  }
  return sources.map((src) => {
    ensureExists(src);
    const target = resolveDest(src, dest);
    ensureFree(target, force);
    if (force && exists(target)) fs.rmSync(target, { recursive: true, force: true });
    moveOne(src, target);
    return `이동: ${src} -> ${target}`;
  });
}

function copy(sources, dest, { force = false } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`여러 개를 복사하려면 대상이 있는 폴더여야 합니다: ${dest}`);
  }
  return sources.map((src) => {
    ensureExists(src);
    const target = resolveDest(src, dest);
    ensureFree(target, force);
    fs.cpSync(src, target, { recursive: true, force });
    return `복사: ${src} -> ${target}`;
  });
}

function moveToRecycleBin(target) {
  const script =
    'Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:FC_TARGET; ' +
    "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } " +
    "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }";
  // 경로는 따옴표 문제를 피하려고 환경 변수로 넘긴다.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FC_TARGET: path.resolve(target) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function remove(targets, { permanent = false } = {}) {
  if (!permanent && !isWindows) {
    throw new FcError('휴지통 삭제는 Windows에서만 됩니다. 영구 삭제하려면 --permanent');
  }
  return targets.map((target) => {
    ensureExists(target);
    if (permanent) {
      fs.rmSync(target, { recursive: true, force: true });
      return `영구 삭제: ${target}`;
    }
    moveToRecycleBin(target);
    return `휴지통으로 이동: ${target}`;
  });
}

function unzip(archive, destDir) {
  ensureExists(archive);
  const dest = destDir || path.join(path.dirname(archive), path.parse(archive).name);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync(TAR, ['-xf', path.resolve(archive), '-C', path.resolve(dest)], { stdio: ['ignore', 'ignore', 'pipe'] });
  return `압축 해제: ${archive} -> ${dest}`;
}

function zip(archive, sources, { force = false } = {}) {
  ensureFree(archive, force);
  sources.forEach(ensureExists);
  if (exists(archive)) fs.rmSync(archive);
  // -a: 확장자(.zip 등)에 맞는 형식으로 묶는다. 각 항목은 자기 부모 폴더 기준으로 넣는다.
  const args = ['-a', '-cf', path.resolve(archive)];
  for (const src of sources) {
    const full = path.resolve(src);
    args.push('-C', path.dirname(full), path.basename(full));
  }
  execFileSync(TAR, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return `압축: ${sources.join(', ')} -> ${archive}`;
}

module.exports = {
  FcError,
  formatSize,
  list,
  makeDir,
  writeFile,
  readFile,
  rename,
  move,
  copy,
  remove,
  unzip,
  zip,
};
