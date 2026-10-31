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

// 미리보기면 작업을 실행하지 않고 할 일만 알려 준다. 모든 변경 명령이 이 함수를 거친다.
function perform(message, dryRun, action) {
  if (dryRun) return `[미리보기] ${message}`;
  action();
  return message;
}

function overwriteNote(p, dryRun) {
  return dryRun && exists(p) ? ' (덮어씀)' : '';
}

// 실제 실행이라면 앞 항목을 처리한 뒤에 실패할 경우를 미리보기에서도 찾기 위해, 이미 다룬 경로를 기억한다.
function claim(planned, p, message) {
  const full = path.resolve(p);
  const key = isWindows ? full.toLowerCase() : full;
  if (planned.has(key)) throw new FcError(message);
  planned.add(key);
}

// 미리보기용 검사: 만들려는 폴더 경로 위에 파일이 있으면 실제 실행에서 실패한다.
function ensureCanMakeDir(dir) {
  let current = path.resolve(dir);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new FcError(`경로가 없습니다: ${current}`);
    current = parent;
  }
  if (!fs.statSync(current).isDirectory()) throw new FcError(`파일 아래에는 만들 수 없습니다: ${dir} (${current})`);
}

// 미리보기용 검사: 부모 폴더를 만들어 주지 않는 명령(mv, zip)은 부모가 있어야 한다.
function ensureParentDir(p) {
  const parent = path.dirname(path.resolve(p));
  if (!exists(parent) || !fs.statSync(parent).isDirectory()) throw new FcError(`대상의 부모 폴더가 없습니다: ${parent}`);
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

function makeDir(dir, { dryRun = false } = {}) {
  if (dryRun) ensureCanMakeDir(dir);
  const note = dryRun && exists(dir) ? ' (이미 있음)' : '';
  return perform(`폴더 생성: ${dir}${note}`, dryRun, () => fs.mkdirSync(dir, { recursive: true }));
}

function writeFile(file, content, { append = false, force = false, dryRun = false } = {}) {
  if (!append) ensureFree(file, force);
  if (dryRun) {
    ensureCanMakeDir(path.dirname(file));
    if (exists(file) && fs.statSync(file).isDirectory()) throw new FcError(`폴더에는 쓸 수 없습니다: ${file}`);
  }
  const note = append ? '' : overwriteNote(file, dryRun);
  return perform(`${append ? '내용 추가' : '파일 작성'}: ${file}${note}`, dryRun, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (append) fs.appendFileSync(file, content);
    else fs.writeFileSync(file, content);
  });
}

function readFile(file) {
  ensureExists(file);
  return fs.readFileSync(file, 'utf8');
}

function rename(target, newName, { force = false, dryRun = false } = {}) {
  ensureExists(target);
  if (newName.includes('/') || newName.includes('\\')) {
    throw new FcError('새 이름에는 경로를 넣을 수 없습니다. 옮기려면 mv를 쓰세요.');
  }
  const dest = path.join(path.dirname(target), newName);
  ensureFree(dest, force);
  return perform(`이름 변경: ${target} -> ${dest}${overwriteNote(dest, dryRun)}`, dryRun, () => fs.renameSync(target, dest));
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

function move(sources, dest, { force = false, dryRun = false } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`여러 개를 옮기려면 대상이 있는 폴더여야 합니다: ${dest}`);
  }
  const plannedSources = new Set();
  const plannedTargets = new Set();
  return sources.map((src) => {
    ensureExists(src);
    const target = resolveDest(src, dest);
    ensureFree(target, force);
    if (dryRun) {
      ensureParentDir(target);
      claim(plannedSources, src, `같은 원본을 두 번 옮길 수 없습니다: ${src}`);
      if (!force) claim(plannedTargets, target, `이미 있습니다: ${target} (앞 항목이 같은 이름으로 옮겨짐)`);
    }
    return perform(`이동: ${src} -> ${target}${overwriteNote(target, dryRun)}`, dryRun, () => {
      if (force && exists(target)) fs.rmSync(target, { recursive: true, force: true });
      moveOne(src, target);
    });
  });
}

function copy(sources, dest, { force = false, dryRun = false } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`여러 개를 복사하려면 대상이 있는 폴더여야 합니다: ${dest}`);
  }
  const planned = new Set();
  return sources.map((src) => {
    ensureExists(src);
    const target = resolveDest(src, dest);
    ensureFree(target, force);
    if (dryRun && !force) claim(planned, target, `이미 있습니다: ${target} (앞 항목이 같은 이름으로 복사됨)`);
    return perform(`복사: ${src} -> ${target}${overwriteNote(target, dryRun)}`, dryRun, () => fs.cpSync(src, target, { recursive: true, force }));
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

function remove(targets, { permanent = false, dryRun = false } = {}) {
  if (!permanent && !isWindows) {
    throw new FcError('휴지통 삭제는 Windows에서만 됩니다. 영구 삭제하려면 --permanent');
  }
  const planned = new Set();
  return targets.map((target) => {
    ensureExists(target);
    if (dryRun) claim(planned, target, `같은 경로를 두 번 지울 수 없습니다: ${target}`);
    if (permanent) return perform(`영구 삭제: ${target}`, dryRun, () => fs.rmSync(target, { recursive: true, force: true }));
    return perform(`휴지통으로 이동: ${target}`, dryRun, () => moveToRecycleBin(target));
  });
}

// 압축 파일 안의 항목 수를 센다. 읽기만 하므로 깨진 압축 파일은 실제 해제처럼 오류가 난다.
function countEntries(archive) {
  const listing = execFileSync(TAR, ['-tf', path.resolve(archive)], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split('\n').filter((line) => line.trim() !== '').length;
}

function unzip(archive, destDir, { dryRun = false } = {}) {
  ensureExists(archive);
  const dest = destDir || path.join(path.dirname(archive), path.parse(archive).name);
  if (dryRun) {
    ensureCanMakeDir(dest);
    const note = exists(dest) ? ', 대상 폴더가 이미 있어 같은 이름 파일은 덮어씀' : '';
    return perform(`압축 해제: ${archive} -> ${dest} (항목 ${countEntries(archive)}개${note})`, true);
  }
  fs.mkdirSync(dest, { recursive: true });
  execFileSync(TAR, ['-xf', path.resolve(archive), '-C', path.resolve(dest)], { stdio: ['ignore', 'ignore', 'pipe'] });
  return `압축 해제: ${archive} -> ${dest}`;
}

function zip(archive, sources, { force = false, dryRun = false } = {}) {
  ensureFree(archive, force);
  sources.forEach(ensureExists);
  if (dryRun) ensureParentDir(archive);
  return perform(`압축: ${sources.join(', ')} -> ${archive}${overwriteNote(archive, dryRun)}`, dryRun, () => {
    if (exists(archive)) fs.rmSync(archive);
    // -a: 확장자(.zip 등)에 맞는 형식으로 묶는다. 각 항목은 자기 부모 폴더 기준으로 넣는다.
    const args = ['-a', '-cf', path.resolve(archive)];
    for (const src of sources) {
      const full = path.resolve(src);
      args.push('-C', path.dirname(full), path.basename(full));
    }
    execFileSync(TAR, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  });
}

module.exports = {
  FcError,
  perform,
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
