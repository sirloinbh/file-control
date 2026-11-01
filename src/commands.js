'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const isWindows = process.platform === 'win32';
// Git Bash 등에 들어 있는 GNU tar 대신 zip을 다룰 수 있는 Windows 기본 bsdtar를 쓴다.
const TAR = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

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

// 이름 길이 한도에 걸리지 않게 대상 이름을 쓰지 않고, 이미 있는 항목을 덮어쓰지 않게 비어 있는 이름을 고른다.
function freshPath(target, prefix, ext = '') {
  const dir = path.dirname(path.resolve(target));
  let serial = 0;
  let fresh;
  do {
    fresh = path.join(dir, `${prefix}-${process.pid}-${Date.now()}-${serial++}${ext}`);
  } while (fs.lstatSync(fresh, { throwIfNoEntry: false }));
  return fresh;
}

function asidePath(target) {
  return freshPath(target, '.fctl-old');
}

// 대상을 먼저 지우면 이동이 실패할 때(파일 잠금 등) 대상을 잃으므로, 치워 두었다가 이동이 끝난 뒤에 지운다.
function moveReplacing(src, target) {
  if (!exists(target)) return moveOne(src, target);
  const aside = asidePath(target);
  fs.renameSync(target, aside);
  try {
    moveOne(src, target);
  } catch (err) {
    // 복사가 끝나 대상이 생겼다면 원본 정리만 실패한 것이므로 되돌리지 않는다.
    if (exists(target)) throw new FcError(`옮겼지만 원본을 다 지우지 못했습니다: ${src} (${err.code}). 이전 대상은 ${aside}에 있습니다.`);
    try {
      fs.renameSync(aside, target);
    } catch (restoreErr) {
      throw new FcError(`옮기지 못했고 이전 대상도 되돌리지 못했습니다: ${src} (${err.code}, ${restoreErr.code}). 이전 대상은 ${aside}에 있습니다.`);
    }
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

// p의 상위 폴더 중에 dir과 같은 폴더가 있는지 파일 번호로 본다.
function hasAncestorSameAs(dir, p) {
  let current = path.resolve(p);
  for (let parent = path.dirname(current); parent !== current; parent = path.dirname(current)) {
    current = parent;
    if (isSameFile(dir, current)) return true;
  }
  return false;
}

// UNC 별칭은 실제 경로로 드러나지 않고 다른 드라이브처럼 보여서, 폴더를 자기 안으로 복사하기 시작하면 끝나지 않는다.
// 링크는 링크 자체만 옮기거나 복사하므로 가리키는 곳으로 따지지 않는다.
function rejectCopyIntoSelf(src, target) {
  if (!fs.lstatSync(src).isSymbolicLink() && hasAncestorSameAs(src, target)) throw new FcError(`자기 안으로 옮기거나 복사할 수 없습니다: ${src} -> ${target}`);
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
  rejectCopyIntoSelf(src, target);
  const targetIsLink = exists(target) && fs.lstatSync(target).isSymbolicLink();
  if (isSameOrUnder(targetKey, srcKey) || (exists(target) && !targetIsLink && hasAncestorSameAs(target, src))) throw new FcError(`대상이 원본을 품고 있어 옮길 수 없습니다: ${src} -> ${target}`);
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
  const done = [];
  for (const { src, target } of items) {
    const note = dryRun ? targetNote(planned, target, force, ' (기존 폴더 전체를 교체함)') : '';
    try {
      done.push(perform(`이동: ${src} -> ${target}${note}`, dryRun, () => moveReplacing(src, target)));
    } catch (err) {
      // 앞 항목은 이미 옮겨졌으니, 오류만 내면 무엇이 옮겨졌는지 알 수 없다.
      if (done.length === 0) throw err;
      throw new FcError(`${err.message}\n이미 처리한 항목:\n${done.join('\n')}`);
    }
  }
  return done;
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
    rejectCopyIntoSelf(src, target);
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
  // 비대화형 실행(서비스, 예약 작업)에서 이 API는 휴지통을 거치지 않고 영구 삭제하므로 거부한다.
  const script =
    'if (-not [Environment]::UserInteractive) { exit 75 }; ' +
    'Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:FC_TARGET; ' +
    "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } " +
    "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }";
  // 경로는 따옴표 문제를 피하려고 환경 변수로 넘긴다.
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_TARGET: path.resolve(target) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    // PowerShell의 stderr는 코드페이지로 나와 한글이 깨지므로 사유를 종료 코드로 받는다.
    if (err.status === 75) throw new FcError('대화형 세션이 아니면 휴지통으로 보낼 수 없습니다.');
    throw err;
  }
}

function remove(targets, { permanent = false, dryRun = false } = {}) {
  if (!permanent && !isWindows) {
    throw new FcError('휴지통 삭제는 Windows에서만 됩니다. 영구 삭제하려면 --permanent');
  }
  const planned = new Set();
  return targets.map((target) => {
    ensureExists(target);
    // 그대로 지우면 현재 폴더만 지우지 못해 실패하는데, 그 전에 다른 항목은 이미 지워진다.
    // 링크를 지우면 링크만 사라지므로 링크 자체로 비교한다. 글자 비교는 링크를 거쳐 들어온 현재 폴더(rm lnk, 현재 폴더 lnk/s)를 잡는다.
    if (isSameOrUnder(entryKey(target), realKey(process.cwd())) || isSameOrUnder(pathKey(target), pathKey(process.cwd()))) {
      throw new FcError(`현재 폴더나 그 상위는 지울 수 없습니다: ${target}`);
    }
    if (dryRun) claim(planned, target);
    if (permanent) return perform(`영구 삭제: ${target}`, dryRun, () => fs.rmSync(target, { recursive: true, force: true }));
    return perform(`휴지통으로 이동: ${target}`, dryRun, () => moveToRecycleBin(target));
  });
}

// tar.exe는 인자를 시스템 코드페이지로 받아서, 그 코드페이지에 없는 문자를 비슷한 글자로 바꾸거나(é -> e) 비정상 종료한다.
// 그대로 넘기면 다른 파일을 묶거나 다른 폴더에 쓸 수 있으므로, 바뀌는 문자가 있으면 실행하기 전에 거부한다.
function unsupportedChars(text) {
  if (!isWindows) return [];
  const chars = [...new Set(text.replace(/[\x00-\x7f]/g, ''))];
  if (chars.length === 0) return [];
  const script =
    '$e = [Text.Encoding]::Default; foreach ($c in ($env:FC_CHARS -split "`n")) ' +
    '{ if ($e.GetString($e.GetBytes($c)) -cne $c) { [char]::ConvertToUtf32($c, 0) } }';
  const output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FC_CHARS: chars.join('\n') },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return output.split(/\s+/).filter(Boolean).map((code) => String.fromCodePoint(Number(code)));
}

// tar.exe는 이름 끝의 점과 공백을 지우지만 Node는 글자 그대로 다루므로, a.txt.를 넘기면 a.txt를 묶게 된다.
function trailingDotOrSpaceName(p) {
  return p.slice(path.parse(p).root.length).split(path.sep).find((part) => /[. ]$/.test(part));
}

function ensureTarCanUse(paths) {
  if (!isWindows) return;
  const trailing = paths.find(trailingDotOrSpaceName);
  // 끝 공백이 눈에 보이도록 이름을 따옴표로 감싼다.
  if (trailing !== undefined) throw new FcError(`끝이 점이나 공백인 이름은 tar.exe로 다룰 수 없습니다: ${JSON.stringify(trailingDotOrSpaceName(trailing))} (${trailing})`);
  const bad = unsupportedChars(paths.join(''));
  if (bad.length === 0) return;
  // 공백처럼 보이는 문자나 macOS에서 온 한글 자모도 있어서, 글자와 함께 코드와 경로를 보여 준다.
  const codes = bad.map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}(${char})`);
  const where = paths.find((p) => bad.some((char) => p.includes(char)));
  throw new FcError(`tar.exe가 처리할 수 없는 문자가 이름에 있습니다: ${codes.join(' ')} (${where})`);
}

// 묶을 폴더 안의 이름도 tar.exe가 읽어야 하므로 함께 확인한다. tar처럼 원본과 그 안의 정션을 따라간다.
function namesInside(src) {
  if (!fs.statSync(src).isDirectory()) return [];
  return fs.readdirSync(src, { recursive: true });
}

// 0xC0000005: tar.exe가 처리하지 못하는 이름을 만나면 오류 내용 없이 이렇게 끝난다.
function runTar(args, options) {
  try {
    return execFileSync(TAR, args, options);
  } catch (err) {
    if (err.status === 0xc0000005) throw new FcError(`tar.exe가 비정상 종료했습니다. 처리할 수 없는 이름이 있을 수 있습니다. (${err.status})`);
    throw err;
  }
}

// tar.exe는 확장자가 아니라 내용으로 형식을 고르고, mtree 글에 적힌 contents= 경로의 로컬 파일을 그대로 복사한다.
// 내려받은 파일이 다른 파일의 내용을 끌어오지 못하게 앞 바이트가 아는 형식일 때만 tar.exe에 넘긴다.
const ARCHIVE_MAGIC = [
  Buffer.from('PK\x03\x04', 'latin1'), // zip
  Buffer.from('PK\x05\x06', 'latin1'), // 빈 zip
  Buffer.from('PK\x07\x08', 'latin1'), // 분할 zip
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), // 7z
  Buffer.from('Rar!\x1a\x07', 'latin1'), // rar
  // bzip2와 xz는 Node로 풀어 안쪽을 볼 수 없어 겉 형식만 확인한다.
  Buffer.from('BZh', 'latin1'), // bzip2
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), // xz
];
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const TAR_BLOCK = 512;
const ARCHIVE_HEAD = 64 * 1024;

function readHead(archive) {
  const fd = fs.openSync(path.resolve(archive), 'r');
  try {
    const head = Buffer.alloc(ARCHIVE_HEAD);
    return head.subarray(0, fs.readSync(fd, head, 0, ARCHIVE_HEAD, 0));
  } finally {
    fs.closeSync(fd);
  }
}

// tar 머리글인지 본다. 체크섬은 ustar 표시가 없는 옛 tar에도 있다. 전부 0인 블록은 빈 tar의 끝 표시다.
function looksLikeTar(head) {
  if (head.length === 0) return true;
  if (head.length < TAR_BLOCK) return false;
  const block = head.subarray(0, TAR_BLOCK);
  if (block.every((byte) => byte === 0)) return true;
  const stored = Number.parseInt(block.subarray(148, 156).toString('latin1').replace(/\0.*$/, '').trim(), 8);
  const sum = block.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
  return stored === sum;
}

// 앞부분만 풀어 안쪽이 tar인지 본다. 잘라 읽었으니 끝까지 풀 수 없어도 오류로 보지 않는다.
function gzipHoldsTar(head) {
  try {
    return looksLikeTar(zlib.gunzipSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, TAR_BLOCK));
  } catch {
    return false;
  }
}

function rejectUnknownFormat(archive) {
  const head = readHead(archive);
  if (head.length === 0) return;
  if (ARCHIVE_MAGIC.some((magic) => head.subarray(0, magic.length).equals(magic))) return;
  if (head.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC) ? gzipHoldsTar(head) : looksLikeTar(head)) return;
  throw new FcError(`압축 형식을 확인할 수 없습니다: ${archive}`);
}

// 암호가 걸린 압축 파일에서 tar.exe가 콘솔에 암호를 물어 멈추지 않도록 아무 값이나 미리 준다. 틀린 암호로 실패한다.
const NO_PASSWORD = isWindows ? ['--passphrase', 'fctl-no-password'] : [];

// 압축 파일 안의 항목을 tar -tv 형식의 줄로 돌려준다. 첫 글자가 종류다(d 폴더, - 파일, h 하드링크, l 링크 등).
// RAR는 폴더 이름에 /가 붙지 않으므로 이름으로 종류를 가리지 않는다. 읽기만 하므로 깨진 압축 파일은 실제 해제처럼 오류가 난다.
// 이름은 코드페이지로 나와 한글이 깨질 수 있으니 개수와 첫 글자만 믿는다.
function archiveEntries(archive) {
  ensureTarCanUse([path.resolve(archive)]);
  rejectUnknownFormat(archive);
  const listing = runTar(['-tvf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

// 압축 파일 안의 항목 이름 목록. 코드페이지로 나오므로 ASCII가 아닌 이름은 믿을 수 없다.
function archiveNames(archive) {
  ensureTarCanUse([path.resolve(archive)]);
  rejectUnknownFormat(archive);
  const listing = runTar(['-tf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

function unzip(archive, destDir, { dryRun = false } = {}) {
  ensureExists(archive);
  const dest = destDir || path.join(path.dirname(archive), path.parse(archive).name);
  ensureTarCanUse([path.resolve(archive), path.resolve(dest)]);
  rejectUnknownFormat(archive);
  let note = '';
  if (dryRun) {
    ensureCanMakeDir(dest);
    note = ` (항목 ${archiveEntries(archive).length}개${exists(dest) ? ', 대상 폴더가 이미 있어 같은 이름 파일은 덮어씀' : ''})`;
  }
  return perform(`압축 해제: ${archive} -> ${dest}${note}`, dryRun, () => {
    fs.mkdirSync(dest, { recursive: true });
    runTar(['-xf', path.resolve(archive), '-C', path.resolve(dest), ...NO_PASSWORD], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
}

// -a는 확장자로 형식을 정하므로 임시 파일에도 같은 확장자를 붙인다. (.tar.gz 같은 겹 확장자 포함)
// 임시 이름은 --exclude의 패턴으로도 쓰이므로, 패턴 문자가 없는 영숫자 확장자만 받는다.
function archiveExt(archive) {
  const match = /\.tar\.[a-z0-9]+$|\.[a-z0-9]+$/i.exec(path.basename(path.resolve(archive)));
  return match ? match[0] : '';
}

// 먼저 임시 이름으로 묶고, 성공한 뒤에 기존 압축 파일과 바꾼다. 실패하면 기존 압축 파일을 되돌린다.
// 압축 파일이 원본 폴더 안에 있어도 임시 파일과 기존 압축 파일이 함께 묶이지 않게 이름으로 뺀다.
function writeArchive(archive, sources) {
  const fresh = freshPath(archive, '.fctl-new', archiveExt(archive));
  const aside = exists(archive) ? asidePath(archive) : null;
  const args = ['-a', '-cf', fresh, '--exclude', path.basename(fresh)];
  if (aside) args.push('--exclude', path.basename(aside));
  for (const src of sources) {
    const full = path.resolve(src);
    const name = path.basename(full);
    // ./를 붙이지 않으면 tar가 -나 @로 시작하는 이름을 옵션이나 지시로 해석한다.
    args.push('-C', path.dirname(full), /^[-@]/.test(name) ? `./${name}` : name);
  }
  if (aside) fs.renameSync(archive, aside);
  try {
    runTar(args, { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.renameSync(fresh, archive);
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (aside) {
      try {
        fs.renameSync(aside, archive);
      } catch (restoreErr) {
        throw new FcError(`압축하지 못했고 기존 압축 파일도 되돌리지 못했습니다: ${archive} (${restoreErr.code}). 기존 압축 파일은 ${aside}에 있습니다.`);
      }
    }
    throw err;
  }
  if (aside) {
    try {
      fs.rmSync(aside, { force: true });
    } catch (err) {
      throw new FcError(`압축했지만 기존 압축 파일을 지우지 못했습니다: ${aside} (${err.code})`);
    }
  }
}

function zip(archive, sources, { force = false, dryRun = false } = {}) {
  ensureFree(archive, force);
  sources.forEach(ensureExists);
  [archive, ...sources].forEach(rejectStreamPath);
  // tar에 넘길 이름이 없고, 그 전에 드라이브 전체를 훑게 되므로 먼저 거부한다.
  const root = sources.find((src) => path.basename(path.resolve(src)) === '');
  if (root !== undefined) throw new FcError(`드라이브 루트는 묶을 수 없습니다: ${root}`);
  // 압축 파일 자신을 묶으면, 치워 둔 기존 압축 파일을 찾지 못하거나 원래 내용 대신 자기 자신이 들어간다.
  const self = sources.find((src) => realKey(src) === realKey(archive) || isSameFile(src, archive));
  if (self !== undefined) throw new FcError(`압축 파일 자신을 묶을 수 없습니다: ${self}`);
  ensureParentDir(archive);
  if (exists(archive) && fs.statSync(archive).isDirectory()) throw new FcError(`폴더는 덮어쓸 수 없습니다: ${archive}`);
  ensureTarCanUse([path.resolve(archive), ...sources.map((src) => path.resolve(src)), ...sources.flatMap(namesInside)]);
  return perform(`압축: ${sources.join(', ')} -> ${archive}${overwriteNote(archive, dryRun)}`, dryRun, () => writeArchive(archive, sources));
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
  archiveEntries,
  archiveNames,
  freshPath,
  zip,
};
