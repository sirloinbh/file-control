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

function pathKey(p) {
  const full = path.resolve(p);
  return isWindows ? full.toLowerCase() : full;
}

function isSameOrUnder(parentKey, key) {
  return key === parentKey || key.startsWith(parentKey.endsWith(path.sep) ? parentKey : parentKey + path.sep);
}

// 실제 실행이라면 앞 항목을 처리한 뒤에 실패할 경우를 미리보기에서도 찾기 위해, 이미 다룬 경로를 기억한다.
// 앞 항목이 폴더면 그 안의 경로도 함께 처리되어 사라지므로 겹친 것으로 본다.
function claim(planned, p) {
  const key = pathKey(p);
  for (const earlier of planned) {
    if (isSameOrUnder(earlier, key)) throw new FcError(`앞 항목과 겹칩니다: ${p} (실제로 실행하면 앞 항목을 처리한 뒤 실패합니다)`);
  }
  planned.add(key);
}

// 미리보기용: 같은 대상으로 모이는 항목과 이미 있는 대상을 찾아 표시할 문구를 돌려준다.
function targetNote(planned, target, force, dirNote) {
  const key = pathKey(target);
  if (planned.has(key)) {
    if (!force) throw new FcError(`이미 있습니다: ${target} (앞 항목이 같은 이름으로 처리됨)`);
    return ' (덮어씀: 앞 항목)';
  }
  planned.add(key);
  if (!exists(target)) return '';
  return fs.statSync(target).isDirectory() ? dirNote : ' (덮어씀)';
}

// 미리보기용: 폴더를 자기 안으로, 파일을 자기 자신으로 옮기거나 복사하면 실제 실행에서 실패한다.
function ensureNotIntoSelf(src, target) {
  if (isSameOrUnder(pathKey(src), pathKey(target))) throw new FcError(`자기 자신이나 그 안으로는 옮기거나 복사할 수 없습니다: ${src} -> ${target}`);
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
  // 자기 자신의 대소문자만 바꾸는 경우는 덮어쓰기가 아니다.
  if (dryRun && pathKey(dest) !== pathKey(target) && exists(dest) && fs.statSync(dest).isDirectory()) throw new FcError(`폴더는 덮어쓸 수 없습니다: ${dest}`);
  return perform(`이름 변경: ${target} -> ${dest}${overwriteNote(dest, dryRun)}`, dryRun, () => fs.renameSync(target, dest));
}

function moveOne(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // 다른 드라이브로 옮길 때는 rename이 안 되므로 복사 후 원본을 지운다.
    if (err.code !== 'EXDEV') throw err;
    try {
      fs.cpSync(src, dest, { recursive: true });
    } catch (copyErr) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw copyErr;
    }
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// 대상을 먼저 지우면 이동이 실패할 때(파일 잠금 등) 대상을 잃으므로, 치워 두었다가 이동이 끝난 뒤에 지운다.
function moveReplacing(src, target) {
  if (!exists(target)) return moveOne(src, target);
  const aside = `${target}.fctl-old-${process.pid}-${Date.now()}`;
  fs.renameSync(target, aside);
  try {
    moveOne(src, target);
  } catch (err) {
    // 복사가 끝나 대상이 생겼다면 원본 정리만 실패한 것이므로 되돌리지 않는다.
    if (exists(target)) throw new FcError(`옮겼지만 원본을 다 지우지 못했습니다: ${src} (${err.code}). 이전 대상은 ${aside}에 있습니다.`);
    fs.renameSync(aside, target);
    throw err;
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true });
  } catch (err) {
    throw new FcError(`옮겼지만 이전 대상을 지우지 못했습니다: ${aside} (${err.code})`);
  }
}

// 없는 경로는 있는 부모까지 올라가 실제 경로를 구한다. 그 밖의 오류는 겹침을 판단할 수 없으니 거부한다.
function realKey(p) {
  const full = path.resolve(p);
  try {
    return pathKey(fs.realpathSync.native(full));
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new FcError(`실제 경로를 확인할 수 없습니다: ${full} (${err.code})`);
    const parent = path.dirname(full);
    return parent === full ? pathKey(full) : pathKey(path.join(realKey(parent), path.basename(full)));
  }
}

// 지우거나 옮기는 항목 자체를 가리키는 키. 링크는 가리키는 곳이 아니라 링크 자체로 본다.
function entryKey(p) {
  const full = path.resolve(p);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return pathKey(path.join(realKey(path.dirname(full)), path.basename(full)));
  return realKey(full);
}

// \\localhost\C$처럼 실제 경로로는 다르게 보이는 별칭도 잡도록 볼륨과 파일 번호로 비교한다.
function isSameFile(a, b) {
  const statA = fs.statSync(a, { bigint: true, throwIfNoEntry: false });
  const statB = fs.statSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(statA && statB) && statA.ino !== 0n && statA.dev === statB.dev && statA.ino === statB.ino;
}

// Windows의 대체 데이터 스트림(a.txt:st)은 파일 안의 일부라, 대상 파일을 치우면 원본도 함께 움직인다.
function rejectStreamPath(p) {
  if (!isWindows) return;
  const full = path.resolve(p);
  if (full.slice(path.parse(full).root.length).includes(':')) throw new FcError(`대체 데이터 스트림은 다룰 수 없습니다: ${p}`);
}

// 현재 폴더나 그 상위는 옮기거나 치울 수 없어 실패하거나 일부만 처리된다.
function rejectCurrentDir(p) {
  if (isSameOrUnder(realKey(p), realKey(process.cwd()))) throw new FcError(`현재 폴더나 그 상위는 옮길 수 없습니다: ${p}`);
}

// 대상과 원본이 겹치면 대상을 치우면서 원본도 함께 움직이거나, 원본을 옮겨 대상을 망가뜨린다.
// 8.3 이름, 대소문자, 정션을 거쳐도 같은 항목이면 잡히도록 실제 경로로 비교한다.
function rejectMoveOverlap(src, target) {
  const srcKey = entryKey(src);
  const targetKey = entryKey(target);
  const stat = fs.statSync(src, { bigint: true, throwIfNoEntry: false });
  // 하드링크끼리는 같은 파일 번호여도 서로 다른 항목이라 이동해도 내용을 잃지 않는다.
  if (srcKey === targetKey || (exists(target) && isSameFile(src, target) && stat.nlink === 1n)) throw new FcError(`원본과 대상이 같습니다: ${src} -> ${target}`);
  if (isSameOrUnder(srcKey, targetKey)) throw new FcError(`자기 안으로 옮길 수 없습니다: ${src} -> ${target}`);
  if (isSameOrUnder(targetKey, srcKey)) throw new FcError(`대상이 원본을 품고 있어 옮길 수 없습니다: ${src} -> ${target}`);
  // 링크를 자기가 가리키는 곳 위로 옮기면, 대상을 지우는 순간 링크가 가리키던 내용이 사라진다.
  if (fs.lstatSync(src).isSymbolicLink() && isSameOrUnder(targetKey, realKey(src))) throw new FcError(`링크가 가리키는 곳을 덮어쓸 수 없습니다: ${src} -> ${target}`);
}

// 앞 항목을 처리한 뒤 뒤 항목이 망가지는 조합을 아무것도 옮기기 전에 찾는다.
function rejectBatchOverlap(items) {
  const keys = items.map(({ src, target }) => ({ src: entryKey(src), target: entryKey(target) }));
  keys.forEach((a, i) => {
    keys.forEach((b, j) => {
      if (i === j) return;
      const pair = `${items[i].src}, ${items[j].src}`;
      if (a.target === b.target) throw new FcError(`여러 원본이 같은 대상으로 모입니다: ${items[i].target} (${pair})`);
      if (isSameOrUnder(a.target, b.src)) throw new FcError(`한 항목의 대상이 다른 항목의 원본과 겹칩니다: ${pair}`);
      if (i < j && (isSameOrUnder(a.src, b.src) || isSameOrUnder(a.src, b.target))) throw new FcError(`앞 항목을 옮기면 뒤 항목이 사라집니다: ${pair}`);
    });
  });
}

// dest가 이미 있는 폴더면 그 안으로, 아니면 dest라는 이름으로 옮긴다.
function resolveDest(src, dest) {
  return exists(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, path.basename(src)) : dest;
}

function move(sources, dest, { force = false, dryRun = false } = {}) {
  if (sources.length > 1 && !(exists(dest) && fs.statSync(dest).isDirectory())) {
    throw new FcError(`여러 개를 옮기려면 대상이 있는 폴더여야 합니다: ${dest}`);
  }
  // 전체를 검사한 뒤에 실행해서, 실패하면 아무것도 옮겨지지 않게 한다.
  const items = sources.map((src) => {
    ensureExists(src);
    rejectStreamPath(src);
    rejectCurrentDir(src);
    // d/.처럼 끝나는 원본도 d와 같은 대상을 쓰도록 이름을 풀어서 구한다.
    const target = resolveDest(path.resolve(src), dest);
    rejectStreamPath(target);
    rejectCurrentDir(target);
    ensureFree(target, force);
    ensureParentDir(target);
    rejectMoveOverlap(src, target);
    return { src, target };
  });
  rejectBatchOverlap(items);
  const planned = new Set();
  return items.map(({ src, target }) => {
    const note = dryRun ? targetNote(planned, target, force, ' (기존 폴더 전체를 교체함)') : '';
    return perform(`이동: ${src} -> ${target}${note}`, dryRun, () => moveReplacing(src, target));
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
    let note = '';
    if (dryRun) {
      ensureCanMakeDir(path.dirname(target));
      ensureNotIntoSelf(src, target);
      if (exists(target) && fs.statSync(src).isDirectory() !== fs.statSync(target).isDirectory()) {
        throw new FcError(`파일과 폴더는 서로 덮어쓸 수 없습니다: ${src} -> ${target}`);
      }
      note = targetNote(planned, target, force, ' (폴더에 합침, 같은 이름 파일은 덮어씀)');
    }
    return perform(`복사: ${src} -> ${target}${note}`, dryRun, () => fs.cpSync(src, target, { recursive: true, force }));
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
    // 그대로 지우면 현재 폴더만 지우지 못해 실패하는데, 그 전에 다른 항목은 이미 지워진다.
    if (isSameOrUnder(pathKey(target), pathKey(process.cwd()))) throw new FcError(`현재 폴더나 그 상위는 지울 수 없습니다: ${target}`);
    if (dryRun) claim(planned, target);
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
  let note = '';
  if (dryRun) {
    ensureCanMakeDir(dest);
    note = ` (항목 ${countEntries(archive)}개${exists(dest) ? ', 대상 폴더가 이미 있어 같은 이름 파일은 덮어씀' : ''})`;
  }
  return perform(`압축 해제: ${archive} -> ${dest}${note}`, dryRun, () => {
    fs.mkdirSync(dest, { recursive: true });
    execFileSync(TAR, ['-xf', path.resolve(archive), '-C', path.resolve(dest)], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
}

function zip(archive, sources, { force = false, dryRun = false } = {}) {
  ensureFree(archive, force);
  sources.forEach(ensureExists);
  [archive, ...sources].forEach(rejectStreamPath);
  // tar가 이 이름을 옵션으로 해석해, 기존 압축 파일을 지운 뒤에 실패하거나 다른 내용을 묶는다. (#52)
  const dashed = sources.find((src) => /^[-@]/.test(path.basename(path.resolve(src))));
  if (dashed !== undefined) throw new FcError(`-나 @로 시작하는 이름은 아직 압축할 수 없습니다: ${dashed}`);
  // 기존 압축 파일을 지운 뒤 묶으므로, 압축 파일 자신을 묶으면 원래 내용을 잃는다.
  const self = sources.find((src) => realKey(src) === realKey(archive) || isSameFile(src, archive));
  if (self !== undefined) throw new FcError(`압축 파일 자신을 묶을 수 없습니다: ${self}`);
  if (dryRun) {
    ensureParentDir(archive);
    if (exists(archive) && fs.statSync(archive).isDirectory()) throw new FcError(`폴더는 덮어쓸 수 없습니다: ${archive}`);
  }
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
