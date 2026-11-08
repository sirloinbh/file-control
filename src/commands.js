'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { BARE_DEVICE_NAME, deviceNamePart, isDeviceName } = require('./windowsNames');

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

// Node는 nul.mp4·con.txt 같은 이름을 글자 그대로 만들지만 PowerShell·탐색기는 장치로 열어, 만든 파일을 다른 프로그램에서 열거나 지울 수 없다(#135).
// 이미 있는 항목은 이름을 바꿔 꺼낼 수 있게 두고, 새로 만드는 이름만 거부한다. 이미 있는 위 폴더(Con.Air 등)는 따지지 않는다.
// 판단은 grant와 같은 규칙(windowsNames.js)으로 한다.
function rejectNewDeviceName(p) {
  if (!isWindows) return;
  let existing = path.resolve(p);
  const created = [];
  while (!exists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    created.unshift(path.basename(existing));
    existing = parent;
  }
  const part = created.find((name) => isDeviceName(name));
  if (part !== undefined) throw new FcError(`Windows가 장치로 여는 이름이라 만들지 않습니다: ${JSON.stringify(part)} (${p})`);
}

// 하드링크(링크 수 2 이상)의 내용을 바꾸면 같은 파일의 다른 이름도 함께 바뀐다. 다른 이름은 타겟 밖일 수 있어 내용은 쓰지 않는다(#48).
// 이름만 지우거나 바꾸는 것(rm, mv --force의 교체, unzip이 기존 파일을 바꾸는 것)은 다른 이름의 내용을 그대로 두므로 막지 않는다.
// 빌드 26200에서 write --force·내용 추가·cp --force로 폴더를 합칠 때는 다른 이름의 내용이 바뀌었고,
// cp --force 파일 하나·mv --force·unzip은 바뀌지 않았다. cp는 Linux에서 제자리에 쓰므로 파일 하나도 막는다.
function rejectHardLinkedWrite(p) {
  const stat = fs.statSync(p, { throwIfNoEntry: false });
  if (stat && stat.isFile() && stat.nlink > 1) {
    throw new FcError(`하드링크라 내용을 바꾸면 같은 파일의 다른 이름 ${stat.nlink - 1}개도 함께 바뀌어 쓰지 않았습니다: ${p}. 먼저 지우거나 다른 이름으로 쓰세요.`);
  }
}

// cp --force가 덮어쓸 파일 중 하드링크가 있으면 아무것도 복사하기 전에 거부한다. 폴더는 합쳐지므로 안쪽 파일까지 본다.
// 폴더를 합칠 때 fs.cpSync는 안쪽에서 종류가 어긋나면 Node를 오류 없이 끝내거나(폴더 위에 파일 자리, 정션 위에 파일 자리) 일부를 복사한 뒤
// 실패하고(파일 위에 폴더 자리), 대상 안의 정션을 따라 그 밖에 쓴다(#140, 빌드 26200·Node 24.21에서 확인). 그래서 복사 전에 모두 찾아 거부한다.
// 원본과 대상을 함께 내려가며 보되 링크 안으로는 들어가지 않는다. cpSync는 원본의 링크를 링크로 복사한다.
// hardLinks가 false면 하드링크 검사를 하지 않는다. 같은 이름의 앞 원본을 대상으로 볼 때 쓴다(그 파일은 새로 복사되므로).
function checkOverwrite(src, target, { hardLinks = true } = {}) {
  const there = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!there) return;
  const here = fs.lstatSync(src);
  if (there.isSymbolicLink()) throw new FcError(`덮어쓸 대상이 링크라 링크가 가리키는 곳에 쓸 수 있습니다. 아무것도 복사하지 않았습니다: ${target}`);
  if (here.isSymbolicLink()) throw new FcError(`원본의 링크를 이미 있는 항목 위에 복사할 수 없습니다. 아무것도 복사하지 않았습니다: ${src} -> ${target}`);
  if (here.isDirectory() !== there.isDirectory()) throw new FcError(`파일과 폴더는 서로 덮어쓸 수 없습니다: ${src} -> ${target}`);
  if (!here.isDirectory()) {
    if (hardLinks) rejectHardLinkedWrite(target);
    return;
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(target, entry.name);
    const stat = fs.lstatSync(to, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new FcError(`합칠 대상 안에 링크가 있어 링크가 가리키는 곳에 쓸 수 있습니다. 아무것도 복사하지 않았습니다: ${to}`);
    if (entry.isSymbolicLink()) throw new FcError(`합칠 폴더 안에서 원본의 링크가 이미 있는 항목 자리에 있어 덮어쓸 수 없습니다. 아무것도 복사하지 않았습니다: ${from} -> ${to}`);
    if (entry.isDirectory() !== stat.isDirectory()) {
      throw new FcError(`합칠 폴더 안에서 파일과 폴더가 어긋나 덮어쓸 수 없습니다. 아무것도 복사하지 않았습니다: ${from} -> ${to}`);
    }
    if (entry.isDirectory()) checkOverwrite(from, to, { hardLinks });
    else if (hardLinks) rejectHardLinkedWrite(to);
  }
}

// 장치 이름 그대로(nul, CON)가 든 경로는 tar.exe가 인자로 받으면 장치를 열고, 휴지통 이동은 실패한다(#135).
// 휴지통 이동은 그런 폴더 안의 파일(CON\a.txt)도 실패하는 것을 빌드 26200에서 확인해 경로의 모든 이름을 본다.
function bareDeviceName(p) {
  return deviceNamePart(p, BARE_DEVICE_NAME);
}

function rejectBareDeviceArgs(paths, what) {
  const found = paths.find((p) => bareDeviceName(p) !== undefined);
  if (found !== undefined) throw new FcError(`장치 이름(${JSON.stringify(bareDeviceName(found))})이 든 경로는 ${what}: ${found}. fctl rename으로 이름을 바꾼 뒤 다시 실행하세요.`);
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
  rejectNewDeviceName(dir);
  if (dryRun) ensureCanMakeDir(dir);
  const note = dryRun && exists(dir) ? ' (이미 있음)' : '';
  return perform(`폴더 생성: ${dir}${note}`, dryRun, () => fs.mkdirSync(dir, { recursive: true }));
}

function writeFile(file, content, { append = false, force = false, dryRun = false } = {}) {
  if (!append) ensureFree(file, force);
  rejectNewDeviceName(file);
  rejectHardLinkedWrite(file);
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
  rejectNewDeviceName(dest);
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
    // 복사로 옮기므로 cp와 같게 끝나지 않는 링크를 먼저 거부한다(#142). 아무것도 복사하지 않았으므로 원본과 대상은 그대로다.
    rejectLoopingLinks(src, dest);
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

// 원본 폴더 안의 링크가 원본이나 대상과 겹치는 곳을 가리키면 아무것도 복사하기 전에 거부한다(#142).
// fs.cpSync는 Windows에서 정션을 따라가 그 안의 내용을 복사한다(폴더 심볼릭 링크는 링크로 복사한다, 빌드 26200·Node 24.21에서 확인).
// 그래서 원본 자신이나 그 위 폴더, 대상이나 그 위 폴더를 가리키는 정션은 복사가 끝나지 않고 경로가 길어지다가 Node가 오류 없이 끝난다.
// 대상 안을 가리키는 링크도 복사하는 동안 읽는 내용이 바뀌므로 함께 거부한다. Node로는 정션과 폴더 심볼릭 링크를 구분하지 못해 둘 다 본다.
// cpSync처럼 링크를 따라 걸으며, 지나온 폴더(원본 안의 위 폴더, 정션 너머의 폴더와 그 실제 위 폴더 포함)를 가리키는 링크를 찾는다(1차 리뷰).
// src/a/b/up -> src/a, src/out -> X와 X/self -> X, src/out -> X와 X/back -> src가 모두 고리다.
// 경로 글자 대신 폴더의 파일 번호로 비교한다. UNC 별칭(\\localhost\C$)으로 준 원본도 정션의 실제 경로와 맞춰 볼 수 있다.
// 한 번 걸은 폴더는 다시 걷지 않는다. 끊어진 링크와 파일 링크는 따라갈 폴더가 없어 보지 않는다.
function rejectLoopingLinks(src, target) {
  const here = fs.lstatSync(src, { throwIfNoEntry: false });
  if (!here || !here.isDirectory()) return;
  // 지금 걷는 경로 위의 폴더 식별값 -> 겹친 수
  const onPath = new Map();
  const add = (ids) => ids.forEach((id) => onPath.set(id, (onPath.get(id) ?? 0) + 1));
  const drop = (ids) => ids.forEach((id) => (onPath.get(id) === 1 ? onPath.delete(id) : onPath.set(id, onPath.get(id) - 1)));
  const destId = dirId(target);
  add(selfAndAncestorIds(target));
  add(selfAndAncestorIds(src));
  add(selfAndAncestorIds(fs.realpathSync.native(src)));
  const walked = new Set([dirId(src)]);
  const walkDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new FcError(`원본 안의 폴더를 읽을 수 없어 복사가 끝나는지 확인하지 못했습니다. 아무것도 복사하지 않았습니다: ${dir} (${err.code})`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const link = entry.isSymbolicLink();
      let ids;
      if (link) {
        let real;
        try {
          real = fs.realpathSync.native(full);
        } catch {
          continue;
        }
        const id = dirId(real);
        if (id === null) continue;
        const reached = selfAndAncestorIds(real);
        if (onPath.has(id) || (destId !== null && reached.includes(destId))) {
          throw new FcError(`원본 안의 링크가 원본이나 대상, 또는 그 위 폴더를 가리켜 복사가 끝나지 않을 수 있습니다. 아무것도 복사하지 않았습니다: ${full} -> ${real}`);
        }
        if (walked.has(id)) continue;
        walked.add(id);
        ids = reached;
      } else {
        const id = dirId(full);
        if (id === null || walked.has(id)) continue;
        walked.add(id);
        ids = [id];
      }
      add(ids);
      walkDir(full);
      drop(ids);
    }
  };
  walkDir(path.resolve(src));
}

// 폴더의 식별값(볼륨과 파일 번호). 링크는 따라간다. 폴더가 아니거나 없으면 null이다.
function dirId(p) {
  try {
    const stat = fs.statSync(p, { bigint: true, throwIfNoEntry: false });
    return stat && stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

// p 자신과 그 위 폴더들의 식별값. 없는 경로는 있는 위 폴더부터 센다.
function selfAndAncestorIds(p) {
  const ids = [];
  for (let current = path.resolve(p); ; current = path.dirname(current)) {
    const id = dirId(current);
    if (id !== null) ids.push(id);
    if (path.dirname(current) === current) break;
  }
  return ids;
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
    rejectNewDeviceName(target);
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
  // 덮어쓰기·합치기(--force일 때만 일어난다)는 여러 원본 중 하나에만 문제가 있어도 아무것도 복사하지 않도록 먼저 모두 본다(#48, #140).
  // 같은 대상으로 모이는 원본은 앞 원본이 복사된 뒤의 대상과도 합쳐지므로, 앞 원본을 대상으로 보고도 확인한다.
  if (force) {
    const earlier = new Map();
    for (const src of sources) {
      ensureExists(src);
      const target = resolveDest(src, dest);
      checkOverwrite(src, target);
      const key = pathKey(target);
      for (const before of earlier.get(key) ?? []) {
        if (pathKey(before) !== pathKey(src)) checkOverwrite(src, before, { hardLinks: false });
      }
      earlier.set(key, [...(earlier.get(key) ?? []), src]);
    }
  }
  // 원본 안의 링크 때문에 복사가 끝나지 않는 경우(#142)는 미리보기에서도, 여러 원본 중 하나만 그래도 아무것도 복사하지 않는다.
  for (const src of sources) {
    ensureExists(src);
    rejectLoopingLinks(src, resolveDest(src, dest));
  }
  const planned = new Set();
  return sources.map((src) => {
    ensureExists(src);
    const target = resolveDest(src, dest);
    ensureFree(target, force);
    rejectNewDeviceName(target);
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

// 타겟 아래 주어진 폴더들의 바로 안 항목 중 숨김(2)이나 시스템(4) 속성이 있는 것을 { 타겟 기준 상대경로 -> 속성 비트 } Map으로 돌려준다(#65).
// Node는 파일 속성을 읽지 못해 PowerShell을 한 번 부른다. 어느 폴더를 볼지는 walk가 정한 폴더 목록(상대경로, 타겟 자신은 '')을 받는다.
// PowerShell이 따로 재귀하면 OneDrive 폴더처럼 ReparsePoint 속성이 있지만 링크가 아닌 폴더에서 판단이 갈린다(1차 리뷰).
// 이름은 코드페이지에 상관없이 주고받도록 UTF-16을 base64로 바꿔 stdin과 stdout으로 넘긴다. 260자를 넘어도 읽도록 \\?\ 경로를 쓴다.
// 폴더 하나라도 읽지 못하면 일부만 보고 진행하지 않게 오류를 낸다. Windows가 아니면 빈 Map이다.
// 드라이브 루트(Q:\)처럼 끝에 구분자가 남는 경로도 상대경로가 잘리지 않게 끝 구분자를 뗀다(1차 리뷰).
function hiddenOrSystemEntries(dir, folders = ['']) {
  if (!isWindows) return new Map();
  const full = path.resolve(dir).replace(/[\\/]+$/, '');
  const root = full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
  const script =
    "$ErrorActionPreference = 'Stop'; try { $root = $env:FC_ROOT; $u = [Text.Encoding]::Unicode; " +
    'foreach ($line in $input) { if (-not $line) { continue }; $rel = $u.GetString([Convert]::FromBase64String($line)); if ($rel -eq ".") { $rel = "" }; ' +
    'foreach ($e in [IO.DirectoryInfo]::new($root + "\\" + $rel).EnumerateFileSystemInfos()) { $a = [int]$e.Attributes -band 6; ' +
    'if ($a) { $name = if ($rel) { $rel + "\\" + $e.Name } else { $e.Name }; "$a " + [Convert]::ToBase64String($u.GetBytes($name)) } } } } catch { exit 3 }';
  // 빈 상대경로는 빈 줄이 되므로 타겟 자신은 '.'으로 넘긴다. 실제 폴더 이름은 '.'일 수 없다.
  const input = folders.map((folder) => Buffer.from(folder === '' ? '.' : folder, 'utf16le').toString('base64')).join('\n') + '\n';
  let output;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_ROOT: root },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    throw new FcError(`숨김·시스템 속성을 확인할 수 없습니다: ${full} (${err.code ?? err.status})`);
  }
  const found = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([246]) ([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (match) found.set(Buffer.from(match[2], 'base64').toString('utf16le'), Number(match[1]));
  }
  return found;
}

// 휴지통 이동(Microsoft.VisualBasic DeleteFile)이 받는 경로 길이의 한도. MAX_PATH(260, 끝의 NUL 포함)를 넘으면
// 파일 이름이 한글이든 영문이든 항상 실패한다(#101에서 확인). 길이는 UTF-16 글자 수다.
const MAX_RECYCLE_PATH = 259;

// 휴지통 이동에는 시간 제한을 두지 않는다(#97). 잠긴 파일과 잠긴 파일이 든 폴더는 대화상자 없이 1~2초 안에 실패했고
// (빌드 26200, 대화형 세션에서 확인), 휴지통 이동은 같은 볼륨에서도 파일 수에 비례해 걸린다(5만 개 폴더 15~25초).
// 도중에 PowerShell을 끝내면 폴더 안의 파일 일부가 원래 자리에도 휴지통에도 남지 않았다(1차 리뷰에서 실측).

// 파일이나 폴더 안에서 다른 프로그램이 쓰기·삭제를 막고 연 파일을 찾는다(#97). 그런 파일은 쓰기로 열면 EBUSY가 난다.
// 휴지통 이동이 실패했을 때만 사유를 알리려고 부른다. 항목(파일과 폴더)이 많으면 limit개를 본 뒤 그만 읽는다.
// 링크·정션은 따라가지 않는다. 읽기 전용 파일은 EPERM이라 사용 중으로 보지 않고, 여는 것만으로는 내용이 바뀌지 않는다.
const MAX_BUSY_PROBE = 10000;
function busyInside(target, limit = MAX_BUSY_PROBE) {
  const busy = (file) => {
    try {
      fs.closeSync(fs.openSync(file, 'r+'));
      return false;
    } catch (err) {
      return err.code === 'EBUSY';
    }
  };
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile()) return busy(target) ? path.basename(target) : undefined;
    if (!stat.isDirectory()) return undefined;
    const stack = [target];
    let seen = 0;
    while (stack.length > 0 && seen < limit) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && busy(full)) return path.relative(target, full);
        if (++seen >= limit) break;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// 휴지통 이동에 넘길 경로를 돌려준다. 보낼 수 없는 것이 확실하면 사유를 밝혀 거부한다(#129).
// rm은 미리보기와 여러 대상 실행 전에 이것으로 모두 검사해, 미리보기와 실제 결과가 같고 일부만 지운 채 멈추지 않게 한다.
// - \\?\D:\... 접두어: 휴지통 이동은 이 꼴을 받지 못하고 항상 실패한다. 접두어를 떼도 같은 파일을 가리킬 때만 뗀다.
//   Node가 정리한 접두어 경로와 뗀 경로가 다르면(\\?\C:\x\..\..\y 등) 거부한다. \\?\UNC\·\\.\ 같은 다른 꼴도 거부한다.
//   장치 이름은 remove가 rejectBareDeviceArgs로 먼저 거부한다.
// - 끝이 점이나 공백인 이름이 든 경로: 접두어가 있든 없든 거부한다(1차 리뷰). Node는 글자 그대로의 dot.을 보지만
//   휴지통 이동(PowerShell 5.1)은 끝의 점·공백을 지운 dot을 열어, 옆에 dot이 있으면 그 파일을 휴지통으로 보냈다(실측).
// - 259자(MAX_RECYCLE_PATH)를 넘는 경로
function recycleTarget(target) {
  let plain = target;
  const prefixed = /^[\\/]{2}[?.][\\/]/.test(target);
  if (prefixed) {
    const drive = /^[\\/]{2}\?[\\/]([A-Za-z]:[\\/].*)$/s.exec(target);
    if (!drive) throw new FcError(`이 꼴의 경로는 휴지통으로 보낼 수 없습니다: ${target}. 드라이브 문자 경로(D:\\...)로 다시 지정하세요.`);
    plain = drive[1];
    if (path.resolve(target).toUpperCase() !== `\\\\?\\${path.resolve(plain)}`.toUpperCase()) {
      throw new FcError(`\\\\?\\ 접두어를 떼면 다른 곳을 가리켜 휴지통으로 보낼 수 없습니다: ${target}. .이나 ..이 없는 경로로 다시 지정하세요.`);
    }
  }
  const full = path.resolve(plain);
  const odd = full.split(path.sep).slice(1).find((part) => /[. ]$/.test(part));
  if (odd !== undefined) {
    // UNC 경로(\\server\share)는 \\?\UNC\server\share 꼴이 접두어 경로다(2차 리뷰).
    const long = full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
    const how = prefixed ? '' : ` 이름을 바꾸려면 fctl rename에 \\\\?\\ 접두어 경로(${long})를 주세요.`;
    throw new FcError(`끝이 점이나 공백인 이름(${odd})이 있어 휴지통으로 보낼 수 없습니다. 휴지통 이동은 끝의 점·공백을 지운 다른 이름을 가리킵니다.${how || ' fctl rename에 이 접두어 경로를 주어 이름을 바꾼 뒤 다시 지우세요.'} 휴지통을 거치지 않으려면 --permanent를 쓰세요: ${target}`);
  }
  if (full.length > MAX_RECYCLE_PATH) throw new FcError(`경로가 ${full.length}자라 휴지통으로 보낼 수 없습니다(${MAX_RECYCLE_PATH}자까지): ${full}`);
  return full;
}

function moveToRecycleBin(target, { permanentHint = false } = {}) {
  const full = recycleTarget(target);
  // 비대화형 실행(서비스, 예약 작업)에서 이 API는 휴지통을 거치지 않고 영구 삭제하므로 거부한다.
  // 실패하면 Windows가 준 사유 문구를 UTF-16 base64로 내보내고 77로 끝낸다. stderr는 코드페이지로 나와 한글이 깨진다(#97).
  // 예외의 HResult는 잠긴 파일과 폴더 모두 0x800736B7로 나와 사유를 가를 수 없어 쓰지 않는다.
  // 지우기 직전에 PowerShell 안에서 볼륨의 휴지통 설정과 크기를 보고, 영구 삭제될 것이면 지우지 않고 78로 끝낸다(#81).
  // 경로는 따옴표 문제를 피하려고 환경 변수로 넘긴다.
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], {
      env: { ...process.env, FC_TARGET: full },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // PowerShell의 stderr는 코드페이지로 나와 한글이 깨지므로 경우는 종료 코드로 나누고, 77이면 사유 문구를 stdout(UTF-16 base64)으로 받는다.
    if (err.status === 75) throw new FcError('대화형 세션이 아니면 휴지통으로 보낼 수 없습니다.');
    if (err.status === 78) throw new FcError(permanentRefusal(full, refusalReason(decodeReason(err.stdout)), permanentHint));
    // 폴더 안에 장치 이름 그대로인 항목이 있으면 휴지통 이동이 폴더째 실패한다(#135). 실패했을 때만 찾아 사유로 알린다.
    const inside = bareDeviceInside(full);
    if (inside !== undefined) throw new FcError(`휴지통으로 보내지 못했습니다. 안에 장치 이름 항목(${inside})이 있어 실패했을 수 있습니다: ${full}. 그 항목을 fctl rename으로 바꾼 뒤 다시 지우세요.`);
    const found = oddNameInside(full);
    if (found !== undefined) {
      // 바꿀 것은 끝이 점·공백인 첫 성분이다(dot./a.txt면 dot.).
      const parts = found.split(path.sep);
      const odd = parts.slice(0, parts.findIndex((part) => /[. ]$/.test(part)) + 1).join(path.sep);
      const inner = path.join(full, odd);
      const long = inner.startsWith('\\\\') ? `\\\\?\\UNC\\${inner.slice(2)}` : `\\\\?\\${inner}`;
      throw new FcError(`휴지통으로 보내지 못했습니다. 안에 끝이 점이나 공백인 이름(${odd})이 있어 휴지통 이동이 폴더째 실패했습니다: ${full}. fctl rename에 \\\\?\\ 접두어 경로(${long})를 주어 이름을 바꾼 뒤 다시 지우세요.`);
    }
    if (err.status === 77) throw new FcError(recycleFailureMessage(full, decodeReason(err.stdout)));
    // 사유를 모르는 실패는 부른 쪽이 맥락을 붙이도록(풀었지만… 등) 원래 오류를 그대로 던진다.
    // 다만 명령 전문과 깨진 stderr가 든 문구는 보여 주지 않도록 바꾼다(#97).
    err.message = `휴지통으로 보내지 못했습니다: ${full} (PowerShell 종료 코드 ${err.status ?? err.code})`;
    throw err;
  }
}

// 휴지통 이동이 Windows의 사유(reason)와 함께 실패했을 때 알릴 문구. 사용 중인 파일이 있으면 그 이름을 붙인다(#97).
function recycleFailureMessage(full, reason) {
  const busy = busyInside(full);
  const isDir = fs.lstatSync(full, { throwIfNoEntry: false })?.isDirectory();
  const where = isDir ? `안에 다른 프로그램이 사용 중인 파일이 있습니다: ${busy}` : '다른 프로그램이 이 파일을 사용 중입니다';
  const note = busy === undefined ? '' : ` ${where}. 그 프로그램을 닫은 뒤 다시 지우세요.`;
  return `휴지통으로 보내지 못했습니다: ${full}${reason ? ` (${reason})` : ''}.${note}`;
}

// PowerShell이 UTF-16 base64로 내보낸 사유 문구를 한 줄로 풀어 돌려준다. 없거나 깨졌으면 빈 문자열이다.
function decodeReason(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  if (!/^[A-Za-z0-9+/=]+$/.test(line)) return '';
  return Buffer.from(line, 'base64').toString('utf16le').replace(/\s+/g, ' ').trim().replace(/[.。]$/, '');
}

// 빈 폴더 여러 개를 PowerShell 한 번으로 휴지통에 보낸다(#67). 폴더마다 PowerShell을 띄우면 한 번에 1~2초씩 걸려 폴더가 많으면 몇 시간이 된다.
// 부른 쪽이 지우기 전에 검사를 마쳤어도, 묶어 보내면 검사와 삭제 사이가 길어지므로 PowerShell이 폴더마다 지우기 직전에 다시 본다.
// - 실제 경로(GetFinalPathNameByHandle)가 넘긴 경로와 같은지. 위 폴더가 정션으로 바뀌어 다른 곳을 가리키면 지우지 않는다.
//   OneDrive 폴더처럼 ReparsePoint 속성이 있어도 링크가 아니면 실제 경로가 그대로라 지운다.
// - 아직 폴더인지, 안에 allowedNames(폴더 설정 파일, 소문자) 말고 파일이 없는지, 하위 폴더가 링크로 바뀌지 않았는지
// 경로는 Node가 realpath로 얻은 실제 경로를 넘긴다. 결과는 넘긴 순서대로 { path, status } 목록이다.
// status: ok(휴지통으로 보냄), moved, notdir, filled, gone, error, timeout(시간 제한에 걸릴 때 처리 중이던 폴더), pending(그 뒤라 손대지 않은 폴더)
// 시간 제한에 걸린 묶음의 뒤 폴더를 pending으로 따로 알려, 부른 쪽이 다시 보낼 수 있게 한다. 같은 폴더가 매번 묶음 전체를 막지 않는다(1차 리뷰).
// script는 테스트에서 DeleteDirectory를 바꿔 실제 PowerShell로 검사 부분을 돌릴 때만 넘긴다.
const FOLDER_BATCH_STATUS = new Set(['ok', 'moved', 'notdir', 'filled', 'gone', 'error']);

const RECYCLE_FOLDERS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { exit 75 }
try { Add-Type -AssemblyName Microsoft.VisualBasic } catch { exit 76 }
try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class FcFinalPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint l, uint f);
  public static string Get(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      StringBuilder b = new StringBuilder(32768);
      return GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0) == 0 ? null : b.ToString();
    }
  }
}' } catch { exit 76 }
$u = [Text.Encoding]::Unicode
$allowed = @(($env:FC_ALLOWED -split '\|') | Where-Object { $_ })
function Long([string]$p) { if ($p.StartsWith('\\')) { return '\\?\UNC\' + $p.Substring(2) }; return '\\?\' + $p }
function Plain([string]$p) { if ($p.StartsWith('\\?\UNC\')) { return '\\' + $p.Substring(8) }; if ($p.StartsWith('\\?\')) { return $p.Substring(4) }; return $p }
function Same([string]$p) { $f = [FcFinalPath]::Get((Long $p)); return ($f -ne $null) -and [string]::Equals((Plain $f), $p, [StringComparison]::OrdinalIgnoreCase) }
function Check([string]$p) {
  $stack = [Collections.Stack]::new(); $stack.Push($p)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($e in [IO.DirectoryInfo]::new((Long $d)).EnumerateFileSystemInfos()) {
      $child = $d + '\' + $e.Name
      if (-not ([int]$e.Attributes -band 16)) { if ($allowed -notcontains $e.Name.ToLowerInvariant()) { return 'filled' }; continue }
      if (-not (Same $child)) { return 'filled' }
      $stack.Push($child)
    }
  }
  return $null
}
foreach ($line in $input) {
  if (-not $line) { continue }
  $p = $u.GetString([Convert]::FromBase64String($line))
  $status = 'error'
  try {
    $long = Long $p
    if (-not [IO.Directory]::Exists($long)) { if ([IO.File]::Exists($long)) { $status = 'notdir' } else { $status = 'gone' } }
    elseif (-not (Same $p)) { $status = 'moved' }
    else {
      $found = Check $p
      if ($found) { $status = $found }
      else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); $status = 'ok' }
    }
  } catch { $status = 'error' }
  [Console]::Out.WriteLine($status + ' ' + $line)
  [Console]::Out.Flush()
}`;

function recycleEmptyFolders(folders, { allowedNames = [], timeoutMs = 30 * 1000 + folders.length * 1000, script = RECYCLE_FOLDERS_SCRIPT } = {}) {
  if (folders.length === 0) return [];
  const input = folders.map((folder) => Buffer.from(folder, 'utf16le').toString('base64')).join('\n') + '\n';
  let output;
  let timedOut = false;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_BATCH: '1', FC_ALLOWED: allowedNames.join('|') },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.status === 75) throw new FcError('대화형 세션이 아니면 휴지통으로 보낼 수 없습니다.');
    // 잠금 환경(Constrained Language Mode, AppLocker)에서는 C# 형식을 만들 수 없다(1차 리뷰).
    if (err.status === 76) throw new FcError('PowerShell에서 경로 확인용 형식을 만들 수 없어(잠금 환경 등) 빈 폴더를 휴지통으로 보내지 못했습니다.');
    // 시간 제한(오류 대화상자에서 멈춘 경우 등)이나 도중 실패여도 이미 보고한 폴더의 결과는 쓴다.
    timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
    output = typeof err.stdout === 'string' ? err.stdout : String(err.stdout ?? '');
    if (!timedOut && output === '') throw err;
  }
  const done = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\w+) ([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (match && FOLDER_BATCH_STATUS.has(match[1])) done.set(Buffer.from(match[2], 'base64').toString('utf16le'), match[1]);
  }
  let first = true;
  return folders.map((folder) => {
    if (done.has(folder)) return { path: folder, status: done.get(folder) };
    if (!timedOut) return { path: folder, status: 'error' };
    const status = first ? 'timeout' : 'pending';
    first = false;
    return { path: folder, status };
  });
}

// 파일 여러 개를 PowerShell 한 번으로 휴지통에 보낸다(#194). 파일마다 PowerShell을 띄우면 파일당 0.5~0.6초가 걸리지만
// 묶으면 50개에 1.6초였다(빌드 26200에서 실측). 묶어 보내면 Node의 검사와 실제 삭제 사이가 길어지므로 PowerShell이 파일마다 지우기 직전에 다시 본다.
// - 실제 경로(GetFinalPathNameByHandle)가 넘긴 경로와 같은지. 위 폴더가 정션으로 바뀌어 다른 곳을 가리키면 지우지 않는다(moved).
// - 아직 파일인지(폴더·링크가 아닌지, notfile)와 판별한 때의 fileStamp(파일 ID, 크기, 수정·변경 시각 ns)와 같은지(changed).
//   링크는 Node처럼 재분석 태그가 심볼릭 링크·정션·앱 실행 링크일 때만 본다. OneDrive 폴더의 파일은 내려받은 것도 재분석 속성이
//   붙어 있어(클라우드 파일 태그), 속성만 보면 모두 지우지 못한다(1차 리뷰).
//   PowerShell이 만든 값은 C:(NTFS)·D:(ReFS)에서 Node의 fileStamp와 글자 그대로 같았다(실측).
// 휴지통 이동을 도중에 끊으면 파일을 잃을 수 있어 시간 제한을 두지 않는다(#97). 파일마다 끝나는 대로 결과를 한 줄씩 내보낸다.
// items는 { path, stamp, keep? } 목록이고 path는 recycleTarget을 거친 경로다. 결과는 넘긴 순서대로 { path, status, reason } 목록이다.
// keep({ path, stamp })을 주면 그 파일(remove-duplicates의 남길 파일)도 지우기 직전에 실제 경로·파일 여부·fileStamp가 그대로인지 보고,
// 다르면 지우지 않는다(keepchanged, #216). 묶음 도중 남길 파일이 바뀌어도 사본을 지우지 않게 한다.
// status: ok(휴지통으로 보냄), moved, notfile, changed, gone, keepchanged, error(reason에 Windows의 사유), unknown(PowerShell이 도중에 끝나 결과를 모름)
const FILE_BATCH_STATUS = new Set(['ok', 'moved', 'notfile', 'changed', 'gone', 'keepchanged', 'error']);

const RECYCLE_FILES_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { exit 75 }
try { Add-Type -AssemblyName Microsoft.VisualBasic } catch { exit 76 }
try { Add-Type -ReferencedAssemblies System.Numerics -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class FcFileCheck {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint l, uint f);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attr; }
  [StructLayout(LayoutKind.Sequential)] struct Standard { public long Alloc, End; public uint Links; public byte Del, Dir; }
  [StructLayout(LayoutKind.Sequential)] struct ById { public uint Attr, C1, C2, A1, A2, W1, W2, Vol, SizeHigh, SizeLow, Links, IdHigh, IdLow; }
  [StructLayout(LayoutKind.Sequential)] struct Tag { public uint Attr, ReparseTag; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Basic b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Standard b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, out Tag b, uint n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out ById b);
  static string Ns(long ft) { return ((System.Numerics.BigInteger)(ft - 116444736000000000L) * 100).ToString(); }
  public static string Final(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      StringBuilder b = new StringBuilder(32768);
      return GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0) == 0 ? null : b.ToString();
    }
  }
  public static string Stamp(string p) {
    using (SafeFileHandle h = CreateFileW(p, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      Basic b; Standard s; ById i; Tag t;
      if (!GetFileInformationByHandleEx(h, 0, out b, (uint)Marshal.SizeOf(typeof(Basic)))) return null;
      if (!GetFileInformationByHandleEx(h, 1, out s, (uint)Marshal.SizeOf(typeof(Standard)))) return null;
      if (!GetFileInformationByHandleEx(h, 9, out t, (uint)Marshal.SizeOf(typeof(Tag)))) return null;
      if (!GetFileInformationByHandle(h, out i)) return null;
      if ((b.Attr & 0x10) != 0) return "notfile";
      if ((b.Attr & 0x400) != 0 && (t.ReparseTag == 0xA000000C || t.ReparseTag == 0xA0000003 || t.ReparseTag == 0x8000001B)) return "notfile";
      ulong id = ((ulong)i.IdHigh << 32) | i.IdLow;
      return id + ":" + s.End + ":" + Ns(b.Write) + ":" + Ns(b.Change);
    }
  }
}' } catch { exit 76 }
$u = [Text.Encoding]::Unicode
function Long([string]$p) { if ($p.StartsWith('\\')) { return '\\?\UNC\' + $p.Substring(2) }; return '\\?\' + $p }
function Plain([string]$p) { if ($p.StartsWith('\\?\UNC\')) { return '\\' + $p.Substring(8) }; if ($p.StartsWith('\\?\')) { return $p.Substring(4) }; return $p }
function Same([string]$k, [string]$stamp) {
  $kl = Long $k
  if (-not [IO.File]::Exists($kl)) { return $false }
  $f = [FcFileCheck]::Final($kl)
  if (($f -eq $null) -or -not [string]::Equals((Plain $f), $k, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return ([FcFileCheck]::Stamp($kl) -eq $stamp)
}
foreach ($line in $input) {
  if (-not $line) { continue }
  $parts = $line.Split(' ')
  $status = 'error'; $reason = ''
  try {
    # 칸은 사본 경로·stamp 2개, 또는 남길 파일 경로·stamp까지 4개다. 그 밖이면 남길 파일 검사를 건너뛰지 않도록 지우지 않는다(1차 리뷰).
    if ($parts.Length -ne 2 -and $parts.Length -ne 4) { throw 'bad input line' }
    $p = $u.GetString([Convert]::FromBase64String($parts[0]))
    $long = Long $p
    if (-not [IO.File]::Exists($long)) { if ([IO.Directory]::Exists($long)) { $status = 'notfile' } else { $status = 'gone' } }
    else {
      $final = [FcFileCheck]::Final($long)
      $now = [FcFileCheck]::Stamp($long)
      if (($final -eq $null) -or -not [string]::Equals((Plain $final), $p, [StringComparison]::OrdinalIgnoreCase)) { $status = 'moved' }
      elseif ($now -eq 'notfile') { $status = 'notfile' }
      elseif ($now -ne $parts[1]) { $status = 'changed' }
      elseif (($parts.Length -ge 4) -and -not (Same ($u.GetString([Convert]::FromBase64String($parts[2]))) $parts[3])) { $status = 'keepchanged' }
      else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); $status = 'ok' }
    }
  } catch { $status = 'error'; $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; $reason = [Convert]::ToBase64String($u.GetBytes([string]$e.Message)) }
  [Console]::Out.WriteLine($status + ' ' + $parts[0] + ' ' + $reason)
  [Console]::Out.Flush()
}`;

function recycleFiles(items, { script = RECYCLE_FILES_SCRIPT } = {}) {
  if (items.length === 0) return [];
  const b64 = (p) => Buffer.from(p, 'utf16le').toString('base64');
  const input = items.map((item) => `${b64(item.path)} ${item.stamp}${item.keep ? ` ${b64(item.keep.path)} ${item.keep.stamp}` : ''}`).join('\n') + '\n';
  let output;
  let failure;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_RECYCLE_FILES: '1' },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.status === 75) throw new FcError('대화형 세션이 아니면 휴지통으로 보낼 수 없습니다.');
    if (err.status === 76) throw new FcError('PowerShell에서 파일 확인용 형식을 만들 수 없어(잠금 환경 등) 휴지통으로 보내지 못했습니다.');
    // 도중에 끝났어도 이미 보고한 파일의 결과는 쓴다. 보고하지 않은 파일은 결과를 모른다.
    output = typeof err.stdout === 'string' ? err.stdout : String(err.stdout ?? '');
    failure = err.status == null && err.signal ? `PowerShell이 ${err.signal}로 끝남` : `PowerShell 종료 코드 ${err.status ?? err.code}`;
  }
  const done = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\w+) ([A-Za-z0-9+/=]+) ?([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (match && FILE_BATCH_STATUS.has(match[1])) done.set(Buffer.from(match[2], 'base64').toString('utf16le'), { status: match[1], reason: decodeReason(match[3]) });
  }
  return items.map((item) => ({ path: item.path, ...(done.get(item.path) ?? { status: 'unknown', reason: failure ?? 'PowerShell이 결과를 알리지 않았습니다' }) }));
}

function bareDeviceInside(dir) {
  return entryInside(dir, (part) => BARE_DEVICE_NAME.test(part));
}

// 폴더 안에서 끝이 점이나 공백인 이름이 든 항목을 찾는다(#190). 휴지통 이동(PowerShell 5.1)은 그런 이름을 열지 못해 폴더째
// "지정한 파일을 찾을 수 없습니다"로 실패하고, 아무것도 옮기지 않는다(빌드 26200에서 확인). 실패했을 때만 찾아 사유로 알린다.
// 안쪽의 259자를 넘는 경로는 실패 원인이 아니다. 274~377자 경로가 든 폴더도 그대로 휴지통으로 갔고 휴지통 안에 남았다(실측).
function oddNameInside(dir) {
  return entryInside(dir, (part) => /[. ]$/.test(part));
}

// 폴더 안의 항목 중 경로 성분 하나가 test를 만족하는 첫 항목의 상대 경로를 돌려준다. 폴더가 아니거나 읽지 못하면 undefined다.
// 링크·정션은 따라가지 않는다(readdirSync recursive는 링크를 폴더로 보지 않는다).
function entryInside(dir, test) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return undefined;
    return fs.readdirSync(dir, { recursive: true }).find((rel) => rel.split(path.sep).some(test));
  } catch {
    return undefined;
  }
}

// 휴지통을 거칠 수 있는지 미리 본다. 실패하면 알 수 없음(null)으로 돌려주어 호출한 쪽이 지우지 않게 한다.
// 돌려주는 값: { interactive, driveType }. driveType은 Fixed, Removable, Network 같은 .NET DriveType 이름이다.
// 돌려주는 값에는 그 볼륨의 휴지통 설정도 들어 있다(#100). nukeOnDelete는 "파일을 휴지통으로 이동하지 않고 바로 제거"가 켜졌는지,
// maxCapacity는 휴지통 최대 크기(바이트)다. 읽지 못하면 null이다.
// 실측(빌드 26200, 대화형): 항목 하나(파일, 폴더면 안의 합계)가 maxCapacity를 넘거나 nukeOnDelete가 켜진 볼륨이면
// 휴지통 이동이 묻지 않고 영구 삭제하면서 성공으로 끝났다(D: 용량 7164MB에서 7100MB는 휴지통, 7200MB는 영구 삭제).
// 휴지통에 이미 든 양은 상관없었다(합계가 용량을 넘어도 기존 항목을 비우거나 새 항목을 지우지 않았다).
// 볼륨은 GetVolumePathName으로 찾아 볼륨 마운트 폴더 아래도 그 볼륨의 설정을 본다. 설정은 사용자별(HKCU)
// BitBucket\Volume\{GUID}의 NukeOnDelete·MaxCapacity(MB)다. 정책(NoRecycleFiles)이 켜져 있으면 바로 제거로 보고,
// 정책으로 크기를 정했으면(RecycleBinSize) 크기를 모르는 것으로 본다.
// $p의 볼륨 종류($type)와 휴지통 설정($nuke: '0'·'1'·'', $cap: MB 또는 '')를 정한다. RECYCLE_STATE_SCRIPT와 휴지통 이동 스크립트가 함께 쓴다(#81).
const VOLUME_STATE_PS = String.raw`$names = @('Unknown', 'NoRootDirectory', 'Removable', 'Fixed', 'Network', 'CDRom', 'Ram')
$type = 'Unknown'; $nuke = ''; $cap = ''
try {
  Add-Type -Namespace FcVolume -Name Native -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetVolumePathNameW(string f, System.Text.StringBuilder b, uint n);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetVolumeNameForVolumeMountPointW(string m, System.Text.StringBuilder b, uint n);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetDriveTypeW(string r);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
[StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attr, ReparseTag; }
[DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle h, int c, out TagInfo b, uint n);
public static bool IsLink(string p) {
  using (var h = CreateFileW(p, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
    if (h.IsInvalid) return false;
    TagInfo t;
    if (!GetFileInformationByHandleEx(h, 9, out t, 8)) return false;
    return (t.Attr & 0x400) != 0 && (t.ReparseTag == 0xA000000C || t.ReparseTag == 0xA0000003);
  }
}'
  $b = New-Object Text.StringBuilder 1024
  $root = if ([FcVolume.Native]::GetVolumePathNameW($p, $b, 1024)) { $b.ToString() } else { [IO.Path]::GetPathRoot($p) }
  $type = $names[[int][FcVolume.Native]::GetDriveTypeW($root)]
  $g = New-Object Text.StringBuilder 1024
  if ([FcVolume.Native]::GetVolumeNameForVolumeMountPointW($root, $g, 1024) -and ($g.ToString() -match '(\{[0-9A-Fa-f-]+\})')) {
    $k = Get-ItemProperty -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $matches[1]) -ErrorAction SilentlyContinue
    if ($k -and $k.NukeOnDelete -ne $null) { $nuke = [string][int]$k.NukeOnDelete }
    if ($k -and $k.MaxCapacity -ne $null) { $cap = [string][long]$k.MaxCapacity }
  }
  foreach ($hive in 'HKLM:', 'HKCU:') {
    $pol = Get-ItemProperty -LiteralPath ($hive + '\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer') -ErrorAction SilentlyContinue
    if ($pol -and [int]$pol.NoRecycleFiles -eq 1) { $nuke = '1' }
    if ($pol -and $pol.RecycleBinSize -ne $null) { $cap = '' }
  }
} catch { $type = 'Unknown' }`;

const RECYCLE_STATE_SCRIPT = `$p = $env:FC_VOLUME
${VOLUME_STATE_PS}
[Environment]::UserInteractive.ToString() + '|' + $type + '|' + $nuke + '|' + $cap`;

// moveToRecycleBin의 PowerShell 스크립트. 비대화형 실행(서비스, 예약 작업)에서 이 API는 휴지통을 거치지 않고 영구 삭제하므로 75로 끝낸다.
// 지우기 직전에 볼륨의 휴지통 설정과 크기(폴더면 안의 합계, 링크·정션은 따라가지 않음)를 보고, 영구 삭제될 것이면 지우지 않고
// 사유 표시를 UTF-16 base64로 내보내고 78로 끝낸다(#81). 고정 디스크가 아니거나 종류를 모르면 type|종류, 바로 제거면 nuke,
// 최대 크기를 넘으면 cap|MB, 최대 크기를 모르는데 1GB 이상이면 unknown, 크기를 읽지 못하면 size다.
// 휴지통 이동이 실패하면 Windows가 준 사유 문구를 UTF-16 base64로 내보내고 77로 끝낸다. stderr는 코드페이지로 나와 한글이 깨진다(#97).
// 예외의 HResult는 잠긴 파일과 폴더 모두 0x800736B7로 나와 사유를 가를 수 없어 쓰지 않는다.
const RECYCLE_SCRIPT = `if (-not [Environment]::UserInteractive) { exit 75 }
$p = $env:FC_TARGET
${VOLUME_STATE_PS}
$u = [Text.Encoding]::Unicode
function Refuse([string]$why) { [Console]::Out.WriteLine([Convert]::ToBase64String($u.GetBytes($why))); exit 78 }
if ($type -ne 'Fixed') { Refuse ('type|' + $type) }
if ($nuke -ne '' -and $nuke -ne '0') { Refuse 'nuke' }
$limit = if ($cap -ne '') { [long]$cap * 1MB } else { 1GB - 1 }
$long = if ($p.StartsWith('\\\\')) { '\\\\?\\UNC\\' + $p.Substring(2) } else { '\\\\?\\' + $p }
$size = [long]0
try {
  $isLink = { param($x) ([int][IO.File]::GetAttributes($x) -band 1024) -and [FcVolume.Native]::IsLink($x) }
  if ([IO.Directory]::Exists($long) -and -not (& $isLink $long)) {
    $stack = [Collections.Stack]::new(); $stack.Push($long)
    while ($stack.Count -gt 0 -and $size -le $limit) {
      foreach ($e in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()) {
        if ([int]$e.Attributes -band 16) { if (-not (([int]$e.Attributes -band 1024) -and [FcVolume.Native]::IsLink($e.FullName))) { $stack.Push($e.FullName) } }
        elseif (-not (([int]$e.Attributes -band 1024) -and [FcVolume.Native]::IsLink($e.FullName))) { $size += $e.Length; if ($size -gt $limit) { break } }
      }
    }
  } elseif ([IO.File]::Exists($long) -and -not (& $isLink $long)) { $size = [IO.FileInfo]::new($long).Length }
} catch { Refuse 'size' }
if ($size -gt $limit) { if ($cap -ne '') { Refuse ('cap|' + $cap) } else { Refuse 'unknown' } }
try { Add-Type -AssemblyName Microsoft.VisualBasic
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }
catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; [Convert]::ToBase64String($u.GetBytes([string]$e.Message)); exit 77 }`;

// RECYCLE_SCRIPT가 78로 알린 표시를 사유("…므로")로 바꾼다.
function refusalReason(mark) {
  const [kind, value] = mark.split('|');
  if (kind === 'type') return volumeTypeReason(value === 'Unknown' ? null : value);
  if (kind === 'nuke') return permanentDeleteReason({ nukeOnDelete: true }, 0);
  if (kind === 'cap') return permanentDeleteReason({ nukeOnDelete: false, maxCapacity: Number(value) * 1024 * 1024 }, Infinity);
  if (kind === 'unknown') return permanentDeleteReason({ nukeOnDelete: false, maxCapacity: null }, Infinity);
  return '크기를 확인하지 못해 휴지통 최대 크기를 넘는지 알 수 없으므로';
}

function volumeTypeReason(driveType) {
  return driveType === null || driveType === undefined
    ? '드라이브 종류를 확인하지 못해 휴지통이 있는지 알 수 없으므로'
    : `휴지통이 없을 수 있는 드라이브(${driveType})라 영구 삭제될 수 있으므로`;
}

// hint는 rm처럼 --permanent를 받는 명령에서만 켠다. extract-all·collapse는 --permanent를 받지 않는다(1차 리뷰).
function permanentRefusal(full, why, hint = false) {
  const tail = hint ? ' 휴지통을 거치지 않고 지우려면 --permanent를 쓰세요.' : '';
  return `휴지통으로 보내지 않았습니다: ${full}. ${why} 지우지 않았습니다.${tail}`;
}

// 미리보기에서 RECYCLE_SCRIPT와 같은 판정을 한다(#81). 영구 삭제될 것이면 사유를, 아니면 null을 돌려준다.
function previewRefusal(full) {
  const state = recycleBinState(full);
  if (state.driveType !== 'Fixed') return volumeTypeReason(state.driveType);
  if (state.nukeOnDelete === true) return permanentDeleteReason(state, 0);
  const limit = state.maxCapacity ?? UNKNOWN_RECYCLE_LIMIT - 1;
  let size;
  try {
    size = sizeUpTo(full, limit);
  } catch {
    return refusalReason('size');
  }
  return permanentDeleteReason(state, size);
}

// 파일 크기, 폴더면 안의 파일 크기 합계. 링크·정션은 따라가지 않고, 합계가 limit를 넘으면 그만 센다.
function sizeUpTo(full, limit) {
  const stat = fs.lstatSync(full);
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let size = 0;
  const stack = [full];
  while (stack.length > 0 && size <= limit) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) size += fs.lstatSync(child).size;
      if (size > limit) break;
    }
  }
  return size;
}

function recycleBinState(target) {
  const unknown = { interactive: null, driveType: null, nukeOnDelete: null, maxCapacity: null };
  if (!isWindows) return unknown;
  try {
    const output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_STATE_SCRIPT], {
      env: { ...process.env, FC_VOLUME: path.resolve(target) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60 * 1000,
    });
    // 설정 칸이 없는 꼴(True|Fixed)도 받는다. 그때 설정은 모르는 것으로 둔다.
    const found = /^(True|False)\|(\w+)(?:\|(\d*)\|(\d*))?\s*$/.exec(output);
    if (!found) return unknown;
    const driveType = found[2] === 'Unknown' ? null : found[2];
    const nukeOnDelete = found[3] ? found[3] !== '0' : null;
    const maxCapacity = found[4] ? Number(found[4]) * 1024 * 1024 : null;
    return { interactive: found[1] === 'True', driveType, nukeOnDelete, maxCapacity };
  } catch {
    return unknown;
  }
}

// 휴지통 용량을 확인하지 못했을 때 남기는 크기. 기본 휴지통 용량은 볼륨의 약 5%라 20GB 볼륨이면 1GB다.
const UNKNOWN_RECYCLE_LIMIT = 1024 * 1024 * 1024;

// 크기가 size바이트인 항목을 휴지통으로 보내면 영구 삭제되는지 볼륨 설정(recycleBinState)으로 본다(#100).
// 영구 삭제되면 사유("…라 영구 삭제되므로")를, 아니면 null을 돌려준다. 용량을 모르면 UNKNOWN_RECYCLE_LIMIT부터 영구 삭제로 본다.
// fallback은 용량을 모를 때의 한도로, 테스트에서만 바꾼다.
function permanentDeleteReason(state, size, fallback = UNKNOWN_RECYCLE_LIMIT) {
  if (state.nukeOnDelete === true) return '이 볼륨은 휴지통 설정이 "바로 제거"라 휴지통을 거치지 않고 영구 삭제되므로';
  const mb = (bytes) => `${Math.floor(bytes / (1024 * 1024))}MB`;
  if (state.maxCapacity !== null && state.maxCapacity !== undefined) {
    return size > state.maxCapacity ? `휴지통 최대 크기(${mb(state.maxCapacity)})보다 커서 Windows가 묻지 않고 영구 삭제하므로` : null;
  }
  return size >= fallback ? '1GB 이상이고 휴지통 최대 크기를 확인하지 못해 영구 삭제될 수 있으므로' : null;
}

// checkVolume이 true면 지우기 전에(미리보기 포함) 모든 대상의 볼륨 휴지통 설정과 크기를 보고, 영구 삭제될 대상이 있으면
// 아무것도 지우지 않고 거부한다(#81). 실제로 지울 때는 휴지통 이동 스크립트가 지우기 직전에 한 번 더 본다.
// 이미 같은 판정을 한 쪽(remove-broken 등)은 PowerShell을 한 번 더 띄우지 않도록 false로 부른다.
// permanentHint는 거부 사유에 --permanent 안내를 붙일지다(rm 명령만 켬).
function remove(targets, { permanent = false, dryRun = false, checkVolume = true, permanentHint = false } = {}) {
  if (!permanent && !isWindows) {
    throw new FcError('휴지통 삭제는 Windows에서만 됩니다. 영구 삭제하려면 --permanent');
  }
  const planned = new Set();
  // 아무것도 지우기 전에 모든 대상을 검사한다(#129). rm a b c에서 c만 보낼 수 없으면 a와 b도 지우지 않고 사유를 알린다.
  // 미리보기도 같은 검사를 거쳐, 실제로는 실패할 대상을 "휴지통으로 이동"으로 보여 주지 않는다.
  const checked = targets.map((target) => {
    ensureExists(target);
    // 그대로 지우면 현재 폴더만 지우지 못해 실패하는데, 그 전에 다른 항목은 이미 지워진다.
    // 링크를 지우면 링크만 사라지므로 링크 자체로 비교한다. 글자 비교는 링크를 거쳐 들어온 현재 폴더(rm lnk, 현재 폴더 lnk/s)를 잡는다.
    if (isSameOrUnder(entryKey(target), realKey(process.cwd())) || isSameOrUnder(pathKey(target), pathKey(process.cwd()))) {
      throw new FcError(`현재 폴더나 그 상위는 지울 수 없습니다: ${target}`);
    }
    if (!permanent) rejectBareDeviceArgs([target], '휴지통으로 보낼 수 없습니다');
    // 영구 삭제는 Node(fs.rmSync)로 지우므로 휴지통 경로 검사를 하지 않는다.
    const recycleAs = permanent ? undefined : recycleTarget(target);
    if (!permanent && checkVolume) {
      const why = previewRefusal(recycleAs);
      if (why !== null) throw new FcError(permanentRefusal(recycleAs, why, permanentHint));
    }
    if (dryRun) claim(planned, target);
    return { target, recycleAs };
  });
  return checked.map(({ target, recycleAs }) => {
    // 앞 대상이 이 대상을 품고 있어 이미 지워졌으면(rm a a/b) 예전처럼 없다고 알린다.
    if (!dryRun) ensureExists(target);
    if (permanent) return perform(`영구 삭제: ${target}`, dryRun, () => fs.rmSync(target, { recursive: true, force: true }));
    return perform(`휴지통으로 이동: ${target}`, dryRun, () => moveToRecycleBin(recycleAs, { permanentHint }));
  });
}

// 시스템 OEM 코드페이지 번호. tar.exe는 UTF-8 표시가 없는 zip 항목 이름을 이 코드페이지로 읽고 쓴다(#173, #83).
// 확인하지 못하면 null이다. 한 번 읽으면 기억해 둔다.
let oemCodePageCache;
function oemCodePage() {
  if (oemCodePageCache !== undefined) return oemCodePageCache;
  oemCodePageCache = null;
  if (!isWindows) return null;
  try {
    const output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage').OEMCP"], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const cp = Number(output.trim());
    if (Number.isSafeInteger(cp) && cp > 0) oemCodePageCache = cp;
  } catch {
    // 확인하지 못하면 null로 둔다. 쓰는 쪽에서 이름을 믿지 않는다.
  }
  return oemCodePageCache;
}

// tar.exe는 인자를 시스템 코드페이지로 받아서, 그 코드페이지에 없는 문자를 비슷한 글자로 바꾸거나(é -> e) 비정상 종료한다.
// 그대로 넘기면 다른 파일을 묶거나 다른 폴더에 쓸 수 있으므로, 바뀌는 문자가 있으면 실행하기 전에 거부한다.
// 인자는 ANSI 코드페이지로 받지만 zip·cpio 항목 이름은 OEM 코드페이지로 적는다. 영어 Windows(ANSI 1252, OEM 437)에서
// COM¹.tar.gz를 zip으로 묶고 풀면 오류 없이 COM1.tar.gz가 됐다(#136). 그래서 그 항목 이름은 ANSI와 OEM 어느 쪽에서든 바뀌는 문자를 거부한다.
// 경로 인자와 다른 형식(pax tar, 7z, jar, iso 등)의 항목 이름은 OEM을 거치지 않는다(#173, CI의 영어 Windows에서 확인).
// withOem이 거짓이면 ANSI만 본다. codePages를 주면 시스템 코드페이지 대신 그것으로 본다(테스트용).
function unsupportedChars(text, codePages = null, { withOem = true } = {}) {
  if (!isWindows) return [];
  const chars = [...new Set(text.replace(/[\x00-\x7f]/g, ''))];
  if (chars.length === 0) return [];
  // 코드페이지를 하나라도 확인하지 못하면 검사가 약해진 채 통과하지 않도록 멈추고 실행을 거부한다.
  // OEMCP가 비면 [int]가 0이 되어 GetEncoding(0)이 ANSI를 돌려주므로 따로 막는다.
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    '$cps = if ($env:FC_CODEPAGES) { $env:FC_CODEPAGES -split "," } else { ' +
    "@([Text.Encoding]::Default.CodePage) + @(if ($env:FC_WITH_OEM) { (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage').OEMCP }) }; " +
    '$encs = @($cps | ForEach-Object { if ([int]$_ -le 0) { throw "code page $_" }; [Text.Encoding]::GetEncoding([int]$_) }); ' +
    'foreach ($c in ($env:FC_CHARS -split "`n")) { foreach ($e in $encs) ' +
    '{ if ($e.GetString($e.GetBytes($c)) -cne $c) { [char]::ConvertToUtf32($c, 0); break } } }';
  let output;
  try {
    output = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_CHARS: chars.join('\n'), FC_CODEPAGES: codePages ? codePages.join(',') : '', FC_WITH_OEM: withOem ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    throw new FcError(`시스템 코드페이지를 확인하지 못해 tar.exe를 실행하지 않았습니다. (${err.status ?? err.code})`);
  }
  return output.split(/\s+/).filter(Boolean).map((code) => String.fromCodePoint(Number(code)));
}

// tar.exe는 이름 끝의 점과 공백을 지우지만 Node는 글자 그대로 다루므로, a.txt.를 넘기면 a.txt를 묶게 된다.
function trailingDotOrSpaceName(p) {
  return p.slice(path.parse(p).root.length).split(path.sep).find((part) => /[. ]$/.test(part));
}

// paths는 ANSI로만 보고, oemNames는 OEM으로도 본다.
function ensureTarCanUse(paths, oemNames = []) {
  if (!isWindows) return;
  const all = [...paths, ...oemNames];
  const trailing = all.find(trailingDotOrSpaceName);
  // 끝 공백이 눈에 보이도록 이름을 따옴표로 감싼다.
  if (trailing !== undefined) throw new FcError(`끝이 점이나 공백인 이름은 tar.exe로 다룰 수 없습니다: ${JSON.stringify(trailingDotOrSpaceName(trailing))} (${trailing})`);
  let bad = unsupportedChars(paths.join(''), null, { withOem: false });
  let checked = paths;
  if (bad.length === 0) {
    bad = unsupportedChars(oemNames.join(''));
    checked = oemNames;
  }
  if (bad.length === 0) return;
  // 공백처럼 보이는 문자나 macOS에서 온 한글 자모도 있어서, 글자와 함께 코드와 경로를 보여 준다.
  const codes = bad.map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}(${char})`);
  const where = checked.find((p) => bad.some((char) => p.includes(char)));
  throw new FcError(`tar.exe가 처리할 수 없는 문자가 이름에 있습니다: ${codes.join(' ')} (${where})`);
}

// args는 tar.exe에 인자로 넘기는 경로, entries는 압축 안에 적힐 이름(원본 이름과 묶을 폴더 안의 이름)이다.
// 폴더 안의 장치 이름은 tar.exe가 파일로 다루므로 인자만 본다(#135). oemEntries는 항목 이름을 OEM으로 적는 형식(zip·cpio와 확인하지 않은 형식)인지다.
function ensureTarArgs(args, entries = [], { oemEntries = false } = {}) {
  if (oemEntries) ensureTarCanUse(args, entries);
  else ensureTarCanUse([...args, ...entries]);
  rejectBareDeviceArgs(args, 'tar.exe가 장치로 열어 다룰 수 없습니다');
}

// 묶을 폴더 안의 이름도 tar.exe가 읽어야 하므로 함께 확인한다. tar처럼 원본과 그 안의 정션을 따라간다.
function namesInside(src) {
  if (!fs.statSync(src).isDirectory()) return [];
  return fs.readdirSync(src, { recursive: true });
}

// tar.exe는 TAR_READER_OPTIONS·TAR_WRITER_OPTIONS 환경 변수를 --options처럼 읽는다.
// mtree:checkfs가 들어 있으면 mtree 글의 contents= 경로에 있는 로컬 파일을 풀린 폴더로 복사하므로 물려주지 않는다(#87).
// Windows의 환경 변수 이름은 대소문자를 가리지 않는다.
const TAR_OPTION_ENV = new Set(['TAR_READER_OPTIONS', 'TAR_WRITER_OPTIONS']);
function tarEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !TAR_OPTION_ENV.has(isWindows ? name.toUpperCase() : name)));
}

// 0xC0000005: tar.exe가 처리하지 못하는 이름을 만나면 오류 내용 없이 이렇게 끝난다.
function runTar(args, options) {
  try {
    return execFileSync(TAR, args, { ...options, env: tarEnv() });
  } catch (err) {
    if (err.status === 0xc0000005) throw new FcError(`tar.exe가 비정상 종료했습니다. 처리할 수 없는 이름이 있을 수 있습니다. (${err.status})`);
    throw err;
  }
}

// 암호가 걸린 압축 파일에서 tar.exe가 콘솔에 암호를 물어 멈추지 않도록 아무 값이나 미리 준다. 틀린 암호로 실패한다.
const NO_PASSWORD = isWindows ? ['--passphrase', 'fctl-no-password'] : [];

// 압축 파일 안의 항목을 tar -tv 형식의 줄로 돌려준다. 첫 글자가 종류다(d 폴더, - 파일, h 하드링크, l 링크 등).
// RAR는 폴더 이름에 /가 붙지 않으므로 이름으로 종류를 가리지 않는다. 읽기만 하므로 깨진 압축 파일은 실제 해제처럼 오류가 난다.
// 이름은 코드페이지로 나와 한글이 깨질 수 있으니 개수와 첫 글자만 믿는다.
function archiveEntries(archive) {
  ensureTarArgs([path.resolve(archive)]);
  const listing = runTar(['-tvf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

// 압축 파일 안의 항목 이름 목록. 코드페이지로 나오므로 ASCII가 아닌 이름은 믿을 수 없다.
function archiveNames(archive) {
  ensureTarArgs([path.resolve(archive)]);
  const listing = runTar(['-tf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

// 압축 파일을 tar.exe로 끝까지 읽어 본다. 오류를 내지 않고 { error, status, stderr, entries }를 돌려준다.
// 손상 문구는 종료 코드 0으로도 나오므로(Damaged tar archive) 판단은 stderr로 한다. error는 실행 실패나 한도 초과(ENOBUFS, ETIMEDOUT)다.
function probeArchive(archive, { maxBuffer, timeout }) {
  ensureTarArgs([path.resolve(archive)]);
  const { error, status, stdout, stderr } = spawnSync(TAR, ['-tf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer, timeout, env: tarEnv() });
  return { error, status, stderr: stderr ? stderr.toString('latin1') : '', entries: stdout ? stdout.toString('latin1').split(/\r?\n/).filter((line) => line.trim() !== '').length : 0 };
}

// tar -tv 줄의 크기 칸. bsdtar는 종류와 권한, 링크 수, 소유자, 그룹, 크기 순으로 적는다.
// ACL이나 확장 속성이 있는 항목은 권한 칸 끝에 +·@ 같은 글자가 하나 더 붙는다.
// 소유자 이름에 공백이 있거나 장치 항목(주,부 번호)이면 읽지 못하므로 그때는 풀지 않는다.
const LISTED_SIZE = /^\S{10,11}\s+\d+\s+\S+\s+\S+\s+(\d+)\s/;
// 파일은 클러스터 단위로 자리를 차지하므로 크기를 클러스터 크기(최소 4KB) 단위로 올려 더한다.
const DISK_BLOCK = 4096n;
// 크기가 0인 파일과 폴더도 항목마다 파일 시스템 기록(NTFS MFT 레코드 1KB)을 쓴다.
const ENTRY_OVERHEAD = 1024n;
// 풀고 나서도 이만큼은 남아야 한다. 같은 디스크를 쓰는 다른 프로그램과 OneDrive 동기화가 쓸 자리다.
const SPACE_RESERVE = 1024n ** 3n;

// 목록에 적힌 크기의 합(block 단위로 올리고 항목마다 ENTRY_OVERHEAD를 더함). 압축 파일이 적은 값이라 실제와 다를 수 있다.
// mtree 글처럼 size= 값만으로 큰 빈 파일을 만드는 경우도 목록에 그 크기로 나온다.
function listedSize(entries, block) {
  let total = 0n;
  for (const line of entries) {
    const match = LISTED_SIZE.exec(line);
    if (!match) throw new FcError(`압축 파일 목록에서 크기를 읽지 못해 풀지 않았습니다: ${JSON.stringify(line.slice(0, 80))}`);
    total += ((BigInt(match[1]) + block - 1n) / block) * block + ENTRY_OVERHEAD;
  }
  return total;
}

// dir이 들어갈 볼륨의 남은 공간과 클러스터 크기. 아직 없는 폴더면 있는 상위 폴더로 본다.
function freeSpace(dir) {
  let current = path.resolve(dir);
  while (!exists(current) && path.dirname(current) !== current) current = path.dirname(current);
  const stat = fs.statfsSync(current, { bigint: true });
  return { free: stat.bavail * stat.bsize, block: stat.bsize > DISK_BLOCK ? stat.bsize : DISK_BLOCK };
}

// 풀린 크기가 남은 공간에서 SPACE_RESERVE를 뺀 것보다 크면 풀기 전에 거부한다(#77). 확인할 수 없어도 풀지 않는다.
// 돌려주는 값은 목록 크기의 합(바이트, BigInt)이다.
function ensureRoomToExtract(dest, entries) {
  let space;
  try {
    space = freeSpace(dest);
  } catch (err) {
    throw new FcError(`남은 디스크 공간을 확인하지 못해 풀지 않았습니다: ${dest} (${err.code ?? err.message})`);
  }
  const need = listedSize(entries, space.block);
  const { free } = space;
  if (need + SPACE_RESERVE > free) {
    throw new FcError(`풀면 약 ${formatSize(Number(need))}가 되어 디스크에 ${formatSize(Number(SPACE_RESERVE))}보다 적게 남으므로 풀지 않았습니다. (남은 공간 ${formatSize(Number(free))})`);
  }
  return need;
}

// checkSpace를 끄는 것은 이미 같은 확인을 한 extract-all뿐이다.
function unzip(archive, destDir, { dryRun = false, checkSpace = true } = {}) {
  ensureExists(archive);
  const dest = destDir || path.join(path.dirname(archive), path.parse(archive).name);
  rejectLongName(dest, '풀 폴더');
  rejectLongTarDir(dest, '풀 폴더');
  rejectNewDeviceName(dest);
  ensureTarArgs([path.resolve(archive), path.resolve(dest)]);
  let note = '';
  if (dryRun) ensureCanMakeDir(dest);
  if (dryRun || checkSpace) {
    const entries = archiveEntries(archive);
    const size = checkSpace ? ensureRoomToExtract(dest, entries) : null;
    const sizeNote = size === null ? '' : `, 풀린 크기 약 ${formatSize(Number(size))}`;
    if (dryRun) note = ` (항목 ${entries.length}개${sizeNote}${exists(dest) ? ', 대상 폴더가 이미 있어 같은 이름 파일은 덮어씀' : ''})`;
  }
  if (isWindows) rejectExtractShortNameClash(archiveNames(archive), dest);
  return perform(`압축 해제: ${archive} -> ${dest}${note}`, dryRun, () => {
    fs.mkdirSync(dest, { recursive: true });
    runTar(['-xf', path.resolve(archive), '-C', path.resolve(dest), ...NO_PASSWORD], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
}

// -a는 확장자로 형식을 정하므로 임시 파일에도 같은 확장자를 붙인다. (.tar.gz 같은 겹 확장자 포함)
// 임시 이름은 --exclude의 패턴으로도 쓰이므로, 패턴 문자가 없는 영숫자 확장자만 받는다.
// tar.exe는 확장자를 대소문자 구분해서 보아 X.ZIP·x.TAR.GZ를 압축 없는 tar로 만든다. 그래서 임시 파일에는 소문자 확장자를 붙인다.
// 다만 compress 형식인 .Z, .taZ, .tZ는 대소문자로 갈리므로(.z는 압축 없는 tar, .taz는 gzip, .tz는 압축 없는 tar) 그대로 둔다.
const KEEP_CASE_EXT = new Set(['Z', 'taZ', 'tZ']);
// tar.exe가 항목 이름을 OEM 코드페이지를 거치지 않고(UTF-8이나 UTF-16으로) 적는다고 CI의 영어 Windows에서 확인한 확장자(#173).
// archiveExt가 돌려주는 값으로 비교한다. .zip·.cpio(.tar.zip·.tar.cpio 포함)는 OEM으로 적고, 확인하지 않은 확장자도 OEM으로 적는다고 본다.
const ANSI_ENTRY_EXT = new Set(['.tar', '.tgz', '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.gz', '.taZ', '.7z', '.jar', '.iso', '.xar', '.mtree', '.warc']);
// tar.exe가 압축 파일 이름에서 형식으로 읽는 확장자와, 그 뒤에 붙으면 압축으로 읽는 확장자(#164).
// x.cpio.gz를 tar.exe에 그대로 주면 gzip 안에 cpio를 넣으므로, 임시 파일에도 두 확장자를 함께 붙여야 이름과 내용이 같다.
// .jar처럼 형식으로 읽지 않는 것은 x.jar.gz도 gzip 안의 tar가 되어 .gz만 붙인 것과 같다.
const FORMAT_EXT = new Set(['cpio', 'iso', 'ar', 'shar', 'xar', 'warc', 'mtree', '7z', 'zip']);
const COMPRESS_EXT = /^(?:gz|bz2|xz|zst|lzma|lz|lz4|lzo|lrz|grz|uu)$/i;
// tar.exe는 끝의 압축 확장자를 겹겹이 벗긴다(#193, 빌드 26200 실측: x.tar.gz.gz는 gzip 두 겹 안의 tar, x.cpio.gz.xz는 xz 안의 gzip 안의 cpio,
// y.tgz.gz는 gzip 두 겹 안의 tar, y.Z.gz는 gzip 안의 compress). 그래서 끝에서부터 이어지는 압축 확장자(tar와 압축을 함께 뜻하는 .tgz 등 포함)를
// 모두 임시 파일에 옮겨, tar.exe가 원래 이름(소문자로 바꾼 것)에서 정할 형식을 그대로 정하게 한다. 벗기는 규칙을 따로 흉내 내지 않는다.
// 확장자는 영숫자만 받으므로 임시 이름에 --exclude 패턴 문자가 들어가지 않는다.
const LAYER_EXT = /^(?:gz|bz2|xz|zst|lzma|lz|lz4|lzo|lrz|grz|uu|tgz|tbz|tbz2|txz|tlz|tzst|taz|tz2|tzo)$/i;
const isLayerExt = (part) => LAYER_EXT.test(part) || KEEP_CASE_EXT.has(part);
function archiveExt(archive) {
  const parts = path.basename(path.resolve(archive)).split('.');
  // parts[0]은 이름이라 확장자로 보지 않는다.
  const usable = (i) => i >= 1 && /^[a-z0-9]+$/i.test(parts[i]);
  const last = parts.length - 1;
  if (!usable(last)) return '';
  let start = last;
  while (usable(start - 1) && isLayerExt(parts[start]) && isLayerExt(parts[start - 1])) start -= 1;
  if (usable(start - 1)) {
    const before = parts[start - 1].toLowerCase();
    // 형식+압축(x.cpio.gz, #164)이나 tar 뒤의 확장자(x.tar.gz, x.tar.zip)는 앞의 확장자도 옮긴다.
    const compressed = COMPRESS_EXT.test(parts[start]) || parts[start] === 'Z';
    if ((compressed && (FORMAT_EXT.has(before) || before === 'tar')) || (start === last && before === 'tar')) start -= 1;
  }
  return parts.slice(start).map((part) => `.${KEEP_CASE_EXT.has(part) ? part : part.toLowerCase()}`).join('');
}

// 압축 파일이 묶을 폴더 안에 있으면 tar가 기존 압축 파일까지 묶으므로 미리 치워야 한다.
// 폴더 안의 링크를 거쳐 닿을 수도 있어, 링크가 든 폴더도 안에 있는 것으로 본다. UNC 별칭은 파일 번호로 잡는다.
function archiveInsideSources(archive, sources) {
  const dir = realKey(path.dirname(path.resolve(archive)));
  return sources.some((src) => {
    if (!fs.statSync(src).isDirectory()) return false;
    if (isSameOrUnder(realKey(src), dir) || hasAncestorSameAs(src, archive)) return true;
    return fs.readdirSync(src, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink());
  });
}

// 치워 둔 기존 압축 파일을 원래 이름으로 되돌리고 원래 오류를 던진다. 되돌리지 못하면 치운 위치를 알려 준다.
function restoreAside(archive, aside, err) {
  try {
    fs.renameSync(aside, archive);
  } catch (restoreErr) {
    throw new FcError(`압축하지 못했고 기존 압축 파일도 되돌리지 못했습니다: ${archive} (${restoreErr.code}). 기존 압축 파일은 ${aside}에 있습니다.`);
  }
  throw err;
}

// 먼저 임시 이름으로 묶고, 성공한 뒤에 기존 압축 파일과 바꾼다. 실패하면 기존 압축 파일을 그대로 둔다.
// 압축 파일이 묶을 폴더 안에 있을 때만 tar 실행 전에 기존 압축 파일을 치워 이름으로 뺀다. 그 밖에는 tar가 도는 동안 원래 이름으로 남는다.
function writeArchive(archive, sources) {
  const fresh = freshPath(archive, '.fctl-new', archiveExt(archive));
  const early = exists(archive) && archiveInsideSources(archive, sources);
  let aside = early ? asidePath(archive) : null;
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
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (aside) restoreAside(archive, aside, err);
    throw err;
  }
  if (!aside && exists(archive)) {
    aside = asidePath(archive);
    try {
      fs.renameSync(archive, aside);
    } catch (err) {
      fs.rmSync(fresh, { force: true });
      throw err;
    }
  }
  try {
    fs.renameSync(fresh, archive);
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (aside) restoreAside(archive, aside, err);
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

// 8.3 짧은 이름처럼 생긴 이름(LONGNA~1.TXT). ~ 앞은 1~6자이고 ~가 들어갈 수 있다(~$LONG~1.DOC). 확장자는 0~3자다.
const SHORT_NAME = /^([^.]{1,6})~(\d{1,6})(?:\.([^.]{1,3}))?$/i;

// name이 다른 이름 other의 8.3 짧은 이름이 될 수 있는지 넉넉하게 어림한다. Windows는 긴 이름을 대문자로 바꾸고(공백과 점은 빼고
// +,;=[] 는 _로) 이름과 확장자를 OEM 코드페이지 바이트 단위로 자른다. 같은 이름이 많거나 이름이 짧으면 앞 1~2바이트 뒤에 해시를 붙이고,
// OEM에 없는 글자는 빠지거나 _가 된다. 그래서 첫 글자와 확장자 앞부분만 비교하고, ASCII가 아닌 글자가 걸리면 겹칠 수 있다고 본다.
// 실제로는 겹치지 않는 이름도 거부할 수 있다. ~N이 든 이름은 드물어서 그쪽이 안전하다(#159).
// 원래 8.3 형식인 ASCII 이름(이름 1~8자, 확장자 0~3자, 점 하나 이하, 8.3에서 그대로 쓰는 글자만). Windows는 이런 이름에
// 대소문자와 상관없이 따로 짧은 이름을 만들지 않으므로(빌드 26200 dir /x 실측: photo.jpg, PHOTO2.JPG, Photo3.Jpg, noext, ab~1.txt)
// ~N 이름과 겹치지 않는다(#205). 공백, +,;=[], 점 두 개, 앞이나 끝의 점, 9자 이상, 4자 확장자에는 짧은 이름이 생긴다.
// ASCII가 아닌 이름(é.txt, 한글한글.txt)도 OEM 바이트로 8.3에 들면 짧은 이름이 생기지 않았지만, 코드페이지마다 다르므로 넉넉하게 겹칠 수 있다고 둔다.
const PLAIN_8DOT3 = /^[A-Za-z0-9!#$%&'()\-@^_`{}~]{1,8}(?:\.[A-Za-z0-9!#$%&'()\-@^_`{}~]{1,3})?$/;

function couldBeShortNameOf(name, other) {
  const short = SHORT_NAME.exec(name);
  if (!short || name.toUpperCase() === other.toUpperCase()) return false;
  if (PLAIN_8DOT3.test(other)) return false;
  // 앞쪽 점과 공백은 떼고 확장자를 나눈다(..foo는 FOO~1, .gitignore는 GITIGN~1).
  const trimmed = other.replace(/^[ .]+/, '');
  const dot = trimmed.lastIndexOf('.');
  const rawBase = dot >= 0 ? trimmed.slice(0, dot) : trimmed;
  const rawExt = dot >= 0 ? trimmed.slice(dot + 1) : '';
  const clean = (text) => text.toUpperCase().replace(/[ .]/g, '').replace(/[+,;=[\]]/g, '_');
  // 대문자로 바꾸면 ASCII가 되는 글자(ﬁ -> FI)도 있어 ASCII인지는 바꾸기 전 글자로 본다.
  const nonAscii = (text) => /[^\x00-\x7f]/.test(text);
  // OEM에 없는 글자는 빠져 뒤 글자가 앞으로 오므로 이름 어디에든 있으면 겹칠 수 있다고 본다.
  const base = nonAscii(rawBase) ? '\u0080' : clean(rawBase);
  const ext = nonAscii(rawExt) ? '\u0080' : clean(rawExt);
  // 짧은 쪽 확장자는 긴 이름 확장자의 앞부분이다. 확장자가 없으면 긴 이름에도 없다.
  const shortExt = (short[3] ?? '').toUpperCase();
  const extMatches = nonAscii(ext) || nonAscii(shortExt) || (shortExt === '' ? ext === '' : [...shortExt].every((char, i) => char === '_' || ext[i] === char));
  if (!extMatches) return false;
  const head = short[1].toUpperCase()[0];
  return head === '_' || nonAscii(head) || nonAscii(base.slice(0, 6)) || base[0] === head;
}

// 풀 볼륨이 짧은 이름을 만들면, 한 폴더 안의 LONGNA~1.TXT와 longname.txt는 푸는 순서에 따라 같은 파일이 되어 한쪽이 덮어써진다(#159).
// 원본을 짧은 이름으로 주면 tar.exe는 그 짧은 이름을 그대로 항목 이름으로 적으므로 맨 위 이름도 함께 본다. 압축 안의 폴더마다 확인한다.
// inside는 원본마다 namesInside의 결과다.
function rejectShortNameClash(sources, inside) {
  const top = sources.map((src) => path.basename(path.resolve(src)));
  // 맨 위에서 겹치면 어느 원본인지 보이도록 원본 경로로 알린다.
  const levels = new Map([['', top.map((name, i) => ({ name, shown: sources[i] }))]]);
  sources.forEach((src, i) => {
    for (const rel of inside[i]) {
      const dir = path.join(top[i], path.dirname(rel));
      if (!levels.has(dir)) levels.set(dir, []);
      levels.get(dir).push({ name: path.basename(rel), shown: path.join(dir, path.basename(rel)) });
    }
  });
  for (const items of levels.values()) {
    for (const item of items.filter(({ name }) => SHORT_NAME.test(name))) {
      const other = items.find(({ name }) => couldBeShortNameOf(item.name, name));
      if (other !== undefined) {
        throw new FcError(`8.3 짧은 이름으로 겹칠 수 있는 이름이 함께 있어 묶지 않습니다. 풀 때 한쪽이 덮어써질 수 있습니다: ${item.shown}, ${other.shown}`);
      }
    }
  }
}

// 풀 때 압축 안의 ~N 이름이 짧은 이름을 거쳐 다른 파일이 되는 것을 막는다(#188). names는 archiveNames의 결과, dest는 풀 폴더다.
// 1) 같은 폴더의 다른 항목과 짧은 이름으로 겹칠 수 있으면 푸는 순서에 따라 한쪽이 덮어써지므로 거부한다(rejectShortNameClash와 같은 어림).
//    Windows는 대소문자를 가리지 않으므로 a/와 A/는 같은 폴더로 본다.
// 2) 풀 폴더에 이미 있는 항목에 ~N 이름이 짧은 이름으로 닿으면 기존 파일을 덮어쓰거나 기존 폴더에 섞이므로 거부한다.
//    ASCII 이름은 볼륨에 실제로 있는 짧은 이름으로 본다(이름은 목록에 없는데 그 경로가 있으면 거부). 짧은 이름을 만들지 않는 볼륨에서는 걸리지 않는다.
// 목록의 이름은 코드페이지로 나와 ASCII가 아닌 글자가 ?나 깨진 글자, 다른 글자가 될 수 있다. 그런 글자는 무엇이든 될 수 있는 글자로 보고,
// 그런 ~N 이름은 경로로 확인할 수 없으므로 기존 이름과 어림으로 비교한다. 그런 폴더 이름은 같은 자리의 ASCII가 아닌 기존 폴더 모두로 본다.
const UNRELIABLE_NAME = /[^\x00-\x7f]|\?/;
function rejectExtractShortNameClash(names, dest) {
  const unknown = (name) => name.replace(/[^\x00-\x7f]|\?/g, '\u0080');
  // ASCII가 아닌 글자가 든 짧은 이름은 그런 글자가 든 긴 이름에서만 생긴다(ASCII 긴 이름의 짧은 이름은 ASCII다).
  const mayBe = (name, other) => (!UNRELIABLE_NAME.test(name) || UNRELIABLE_NAME.test(other)) && couldBeShortNameOf(unknown(name), unknown(other));
  const levels = new Map();
  for (const raw of names) {
    const parts = raw.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
    parts.forEach((part, i) => {
      const key = parts.slice(0, i).map((p) => p.toUpperCase()).join('/');
      if (!levels.has(key)) levels.set(key, { parts: parts.slice(0, i), items: new Map() });
      levels.get(key).items.set(part.toUpperCase(), part);
    });
  }
  const shown = (parts, name) => [...parts, name].join('/');
  // 목록의 ASCII가 아닌 이름은 깨져 보이므로 그렇다고 알린다(2차 리뷰).
  const garbled = (...texts) => (texts.some((text) => UNRELIABLE_NAME.test(text)) ? ' (압축 목록의 ASCII가 아닌 이름은 코드페이지 때문에 깨져 보일 수 있습니다)' : '');
  for (const { parts, items } of levels.values()) {
    const all = [...items.values()];
    const shorts = all.filter((name) => SHORT_NAME.test(name));
    for (const name of shorts) {
      const other = all.find((candidate) => candidate !== name && mayBe(name, candidate));
      if (other !== undefined) {
        throw new FcError(`압축 안에 8.3 짧은 이름으로 겹칠 수 있는 항목이 함께 있어 풀지 않습니다. 풀 때 한쪽이 덮어써질 수 있습니다: ${shown(parts, name)}, ${shown(parts, other)}${garbled(shown(parts, name), other)}`);
      }
    }
    if (shorts.length === 0) continue;
    for (const place of existingPlaces(dest, parts)) {
      const existing = fs.readdirSync(place);
      const keys = new Set(existing.map((name) => name.toUpperCase()));
      for (const name of shorts) {
        let real;
        let note = '';
        if (UNRELIABLE_NAME.test(name)) {
          real = existing.find((candidate) => mayBe(name, candidate));
          if (real === undefined) continue;
          // 이름을 확인할 수 없으므로 같은 압축을 다시 풀 때처럼 이름이 그대로 같은 항목도 여기서 걸린다.
          note = ` 이름이 그대로 같은 항목일 수도 있지만 확인할 수 없습니다.${garbled(name)}`;
        } else {
          if (keys.has(name.toUpperCase()) || !exists(path.join(place, name))) continue;
          real = existing.find((candidate) => couldBeShortNameOf(name, candidate)) ?? name;
          note = garbled(shown(parts, name));
        }
        throw new FcError(`압축 안의 ${shown(parts, name)}이 8.3 짧은 이름으로 이미 있는 항목을 가리킬 수 있어 풀지 않습니다. 풀면 그 항목이 덮어써지거나 섞입니다: ${path.join(place, real)}${note}`);
      }
    }
  }
}

// 압축 안의 폴더 경로 parts가 풀 폴더 dest에서 닿을 수 있는 기존 폴더들. 믿을 수 없는 이름은 그 자리의 ASCII가 아닌 기존 폴더 모두로 본다.
function existingPlaces(dest, parts) {
  const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  let places = isDir(dest) ? [dest] : [];
  for (const part of parts) {
    const next = [];
    for (const place of places) {
      if (!UNRELIABLE_NAME.test(part)) {
        if (isDir(path.join(place, part))) next.push(path.join(place, part));
        continue;
      }
      for (const entry of fs.readdirSync(place, { withFileTypes: true })) {
        if (UNRELIABLE_NAME.test(entry.name) && isDir(path.join(place, entry.name))) next.push(path.join(place, entry.name));
      }
    }
    places = next;
  }
  return places;
}

// 항목 이름을 어떤 인코딩으로 적는지는 가장 안쪽 형식이 정하고 바깥 압축 겹은 바꾸지 않는다(#212). 그래서 archiveExt의 겹에서
// 가장 안쪽 판정(첫 확장자, 형식·tar이면 그 뒤의 압축 하나까지)만 남겨 ANSI_ENTRY_EXT와 비교한다.
// .tar.gz.gz -> .tar.gz, .gz.xz -> .gz, .tgz.gz -> .tgz, .cpio.gz.xz -> .cpio.gz(목록에 없어 OEM으로 본다).
function innerEntryExt(ext) {
  const parts = ext.split('.').filter(Boolean);
  if (parts.length === 0) return ext;
  const first = parts[0].toLowerCase();
  const keep = parts.length > 1 && (FORMAT_EXT.has(first) || first === 'tar') ? 2 : 1;
  return parts.slice(0, keep).map((part) => `.${part}`).join('');
}

// 파일 이름 한 칸의 한도(NTFS, UTF-16 글자 수)
const MAX_NAME_LENGTH = 255;
// 경로의 한 칸이라도 한도를 넘으면 만들 수 없다. zip은 짧은 임시 이름으로 묶은 뒤 마지막 이름 바꾸기에서, unzip은 풀 폴더를 만들 때
// 날것의 ENOENT로 실패하고 미리보기는 성공으로 보였으므로, 미리보기를 포함해 먼저 거부한다(#228).
function rejectLongName(target, what) {
  const full = path.resolve(target);
  const long = full.split(/[\\/]/).slice(1).find((part) => part.length > MAX_NAME_LENGTH);
  if (long !== undefined) {
    throw new FcError(`${what} 경로에 ${long.length}자인 이름이 있어 만들 수 없습니다(이름 한 칸은 ${MAX_NAME_LENGTH}자까지): ${long.slice(0, 40)}… (${target})`);
  }
}

// tar.exe는 -C로 받은 폴더로 옮겨 가는데, 그 경로가 이보다 길면 "could not chdir"로 날것의 실패를 낸다(UTF-16 258자까지 됨).
// 이 PC(LongPathsEnabled=0)와 긴 경로가 켜진 CI(GitHub windows-latest) 모두에서 실측했다. tar.exe 매니페스트는 longPathAware지만
// 작업 폴더 옮기기에는 적용되지 않는다(2차 리뷰). unzip의 풀 폴더와 zip 원본의 상위 폴더가 -C로 넘어가므로 미리 거부한다(#228).
const MAX_TAR_DIR = 258;
function rejectLongTarDir(dir, what) {
  const full = path.resolve(dir);
  if (full.length > MAX_TAR_DIR) {
    throw new FcError(`${what} 경로가 ${full.length}자라 tar.exe가 그 폴더로 옮겨 갈 수 없습니다(${MAX_TAR_DIR}자까지). 더 짧은 경로를 지정하세요: ${dir}`);
  }
}

// zip은 같은 폴더의 임시 파일(.fctl-new-<pid>-<시각>-<번호><확장자 겹>)에 묶은 뒤 이름을 바꾼다. 확장자 겹이 아주 길면(#193 이후 겹을 모두 옮김)
// 임시 이름이 한도를 넘어 tar.exe가 날것의 오류로 실패하므로 미리 거부한다(#213). 번호가 늘어날 자리로 몇 글자를 남긴다.
const TEMP_SERIAL_RESERVE = 4;
// tar.exe는 압축 겹을 이만큼까지만 풀 수 있다. 25겹부터는 묶기는 하지만 읽을 때 "Input requires too many filters for decoding"으로
// 실패한다(빌드 26200 실측, gzip·xz 모두). 다시 풀 수 없는 압축 파일을 만들지 않도록 함께 거부한다(#213).
const MAX_TAR_LAYERS = 24;
function rejectLongTempName(archive) {
  const ext = archiveExt(archive);
  const layers = ext.split('.').filter((part) => part !== '' && isLayerExt(part)).length;
  if (layers > MAX_TAR_LAYERS) {
    throw new FcError(`압축 확장자가 ${layers}겹이라 tar.exe가 다시 풀 수 없습니다(${MAX_TAR_LAYERS}겹까지). 확장자를 줄여 다시 지정하세요: ${archive}`);
  }
  const length = `.fctl-new-${process.pid}-${Date.now()}-0`.length + TEMP_SERIAL_RESERVE + ext.length;
  if (length > MAX_NAME_LENGTH) {
    throw new FcError(`확장자가 너무 길어(${ext.length}자) 묶는 동안 쓸 임시 파일 이름이 ${MAX_NAME_LENGTH}자를 넘습니다. 확장자를 줄여 다시 지정하세요: ${archive}`);
  }
}

function zip(archive, sources, { force = false, dryRun = false } = {}) {
  ensureFree(archive, force);
  // 7z를 압축으로 한 겹 더 싸면 tar.exe가 앞뒤로 옮겨 읽지 못해(Seek error) 풀 수 없다(#164).
  if (archiveExt(archive).startsWith('.7z.')) throw new FcError(`7z 압축 파일은 다른 압축으로 한 번 더 쌀 수 없습니다. tar.exe가 풀지 못합니다: ${archive}`);
  rejectLongName(archive, '압축 파일');
  rejectLongTempName(archive);
  rejectNewDeviceName(archive);
  sources.forEach(ensureExists);
  for (const src of sources) rejectLongTarDir(path.dirname(path.resolve(src)), '원본의 상위 폴더');
  [archive, ...sources].forEach(rejectStreamPath);
  // tar에 넘길 이름이 없고, 그 전에 드라이브 전체를 훑게 되므로 먼저 거부한다.
  const root = sources.find((src) => path.basename(path.resolve(src)) === '');
  if (root !== undefined) throw new FcError(`드라이브 루트는 묶을 수 없습니다: ${root}`);
  // 압축 파일 자신을 묶으면, 치워 둔 기존 압축 파일을 찾지 못하거나 원래 내용 대신 자기 자신이 들어간다.
  const self = sources.find((src) => realKey(src) === realKey(archive) || isSameFile(src, archive));
  if (self !== undefined) throw new FcError(`압축 파일 자신을 묶을 수 없습니다: ${self}`);
  // 원본은 맨 위 이름으로 묶이므로, 이름이 같은 원본은 압축 안에서 겹쳐 풀 때 하나만 남는다. Windows는 대소문자를 가리지 않는다.
  const seen = new Map();
  for (const src of sources) {
    const name = path.basename(path.resolve(src));
    // toLowerCase는 NTFS에서 같은 이름인 ΑΣ와 ασ를 다르게 만들므로 대문자로 비교한다(flatten.js와 같다).
    const key = isWindows ? name.toUpperCase() : name;
    if (seen.has(key)) throw new FcError(`이름이 같은 원본은 함께 묶을 수 없습니다. 풀 때 하나만 남습니다: ${seen.get(key)}, ${src}`);
    seen.set(key, src);
  }
  const inside = sources.map(namesInside);
  if (isWindows) rejectShortNameClash(sources, inside);
  ensureParentDir(archive);
  if (exists(archive) && fs.statSync(archive).isDirectory()) throw new FcError(`폴더는 덮어쓸 수 없습니다: ${archive}`);
  const entries = [...sources.map((src) => path.basename(path.resolve(src))), ...inside.flat()];
  ensureTarArgs([path.resolve(archive), ...sources.map((src) => path.resolve(src))], entries, { oemEntries: !ANSI_ENTRY_EXT.has(innerEntryExt(archiveExt(archive))) });
  return perform(`압축: ${sources.join(', ')} -> ${archive}${overwriteNote(archive, dryRun)}`, dryRun, () => writeArchive(archive, sources));
}

module.exports = {
  rejectHardLinkedWrite,
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
  recycleBinState,
  permanentDeleteReason,
  UNKNOWN_RECYCLE_LIMIT,
  RECYCLE_STATE_SCRIPT,
  RECYCLE_SCRIPT,
  previewRefusal,
  sizeUpTo,
  hiddenOrSystemEntries,
  recycleEmptyFolders,
  RECYCLE_FOLDERS_SCRIPT,
  recycleFiles,
  RECYCLE_FILES_SCRIPT,
  recycleFailureMessage,
  bareDeviceInside,
  MAX_RECYCLE_PATH,
  decodeReason,
  busyInside,
  recycleTarget,
  unzip,
  archiveEntries,
  archiveNames, probeArchive, archiveExt,
  unsupportedChars,
  oemCodePage,
  couldBeShortNameOf,
  rejectExtractShortNameClash,
  ensureRoomToExtract,
  freshPath,
  zip,
};
