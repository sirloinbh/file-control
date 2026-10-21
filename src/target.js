'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('./commands');

// 타겟 디렉토리를 실제 절대경로로 정규화한다. 없거나 폴더가 아니면 오류를 낸다.
// 보호 경로 안이거나 보호 경로를 품은 폴더(C:\, 사용자 폴더 등)도 거부한다.
function resolveTarget(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new FcError('타겟 폴더를 지정하세요.');
  const abs = path.resolve(dir);
  rejectNetworkPath(abs);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new FcError(`타겟 폴더가 없습니다: ${abs}`);
  if (!stat.isDirectory()) throw new FcError(`타겟이 폴더가 아닙니다: ${abs}`);
  // 대소문자·8.3 짧은 이름·드라이브 문자 표기를 실제 경로 하나로 맞춘다.
  const target = fs.realpathSync.native(abs);
  rejectNetworkPath(target);
  const reason = protectedReason(target);
  if (reason) throw new FcError(`보호된 경로라 타겟으로 쓸 수 없습니다: ${target} (${reason})`);
  return target;
}

// UNC·네트워크 경로(\\server\share, \\localhost\C$ 등)는 보호 경로를 우회할 수 있어 타겟으로 받지 않는다.
// \\?\C:\처럼 로컬 드라이브를 가리키는 긴 경로 접두어만 허용한다.
function rejectNetworkPath(p) {
  if (process.platform !== 'win32') return;
  if (p.startsWith('\\\\') && !/^\\\\\?\\[A-Za-z]:/.test(p)) {
    throw new FcError(`네트워크 경로는 타겟으로 쓸 수 없습니다: ${p}`);
  }
}

// 보호 기준 경로를 타겟과 같은 방식(실제 경로)으로 맞춘다. 없는 경로면 그대로 쓴다.
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// Windows 시스템 폴더. 환경 변수가 없거나 절대경로가 아니면 기본 위치를 쓴다.
function systemRoots() {
  if (process.platform !== 'win32') return [];
  const env = process.env;
  const pick = (value, fallback) => (value && path.isAbsolute(value) ? value : fallback);
  return [
    pick(env.SystemRoot, 'C:\\Windows'),
    pick(env.ProgramFiles, 'C:\\Program Files'),
    pick(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)'),
  ].map(realOrResolved);
}

function homeDir() {
  let home;
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (!home || !path.isAbsolute(home)) throw new FcError('사용자 폴더를 알 수 없어 보호 경로를 확인할 수 없습니다.');
  return realOrResolved(home);
}

// 사용자 폴더 바로 아래의 숨김 설정 폴더(.ssh, .config 등 점으로 시작하는 폴더와 AppData)인지 본다.
function isHiddenSettings(name) {
  return name.startsWith('.') || name.toLowerCase() === 'appdata';
}

// 타겟이 보호 경로와 겹치면 이유를, 아니면 null을 돌려준다.
function protectedReason(target) {
  for (const root of systemRoots()) {
    if (isInside(root, target)) return `시스템 폴더 ${root}`;
    if (isInside(target, root)) return `시스템 폴더 ${root}를 포함`;
  }
  const home = homeDir();
  if (isInside(target, home)) return `사용자 폴더 ${home}를 포함`;
  if (isInside(home, target)) {
    const [first] = path.relative(home, target).split(path.sep);
    if (isHiddenSettings(first)) return `사용자 설정 폴더 ${path.join(home, first)}`;
  }
  return null;
}

// p(타겟 기준 상대경로 또는 절대경로)가 타겟 자신이거나 그 안이면 true.
// Windows에서는 대소문자를 구분하지 않고, 다른 드라이브는 밖으로 본다. 링크는 따지지 않는다.
function isInside(target, p) {
  const rel = path.relative(target, path.resolve(target, p));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

// p를 타겟 기준 절대경로로 바꾼다. 타겟 밖이면 오류를 낸다.
function resolveInside(target, p) {
  const abs = path.resolve(target, p);
  if (!isInside(target, abs)) throw new FcError(`타겟 폴더 밖의 경로입니다: ${abs} (타겟: ${target})`);
  return abs;
}

// 타겟 안의 파일을 찾아 실제 경로를 돌려준다. target은 resolveTarget이 돌려준 경로여야 한다.
// 경로 문자열뿐 아니라 링크·정션을 풀어낸 실제 경로도 타겟 안이어야 한다.
function resolveFileInside(target, p) {
  const abs = resolveInside(target, p);
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new FcError(`파일이 없습니다: ${abs}`);
    throw err;
  }
  if (!isInside(target, real)) throw new FcError(`링크를 거쳐 타겟 폴더 밖을 가리킵니다: ${abs} -> ${real}`);
  if (!fs.statSync(real).isFile()) throw new FcError(`파일이 아닙니다: ${abs}`);
  return real;
}

// 한 번에 Buffer로 읽을 수 있는 최대 바이트 수 (Node 파일 읽기 한도)
const MAX_READ = 2 ** 31 - 1;

// 타겟 안 파일의 내용 전체를 Buffer로 읽는다. MAX_READ보다 큰 파일은 readRange로 나눠 읽는다.
function readInside(target, p) {
  const real = resolveFileInside(target, p);
  const { size } = fs.statSync(real);
  if (size > MAX_READ) throw new FcError(`파일이 너무 커서 한 번에 읽을 수 없습니다: ${real} (${size}바이트, readRange로 나눠 읽으세요)`);
  return fs.readFileSync(real);
}

// 타겟 안 파일의 offset부터 length바이트를 읽는다. 파일 끝을 넘으면 있는 만큼만 돌려준다.
// 헤더(매직 넘버)는 offset 0으로, 컨테이너 박스처럼 중간에 있는 구조는 그 위치로 읽는다.
// 손상된 헤더의 큰 length를 그대로 받아도 실제 파일에 있는 만큼만 메모리를 잡는다.
function readRange(target, p, { offset = 0, length } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FcError(`offset이 올바르지 않습니다: ${offset}`);
  if (!Number.isSafeInteger(length) || length < 0) throw new FcError(`length가 올바르지 않습니다: ${length}`);
  if (length > MAX_READ) throw new FcError(`한 번에 읽을 수 있는 길이(${MAX_READ}바이트)를 넘습니다: ${length}`);
  const fd = fs.openSync(resolveFileInside(target, p), 'r');
  try {
    const available = Math.max(0, fs.fstatSync(fd).size - offset);
    length = Math.min(length, available);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// 타겟 아래를 재귀로 읽어 파일·폴더·링크 목록을 돌려준다. 타겟 자신은 넣지 않는다.
// 심볼릭 링크와 정션은 type 'link'로만 넣고 따라 들어가지 않는다.
// 결과는 상대경로 순으로 정렬하며, 폴더가 그 안의 항목보다 먼저 온다.
// 하위 폴더 하나라도 읽지 못하면 전체를 실패시킨다. 일부만 읽은 목록으로 이동·삭제하지 않게 하려는 것이다.
function walk(dir) {
  const target = resolveTarget(dir);
  const entries = [];
  const pending = [''];
  while (pending.length > 0) {
    const relDir = pending.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(path.join(target, relDir), { withFileTypes: true });
    } catch (err) {
      throw new FcError(`폴더를 읽을 수 없습니다: ${path.join(target, relDir)} (${err.code})`);
    }
    for (const dirent of dirents) {
      const relative = path.join(relDir, dirent.name);
      const type = dirent.isSymbolicLink() ? 'link' : dirent.isDirectory() ? 'dir' : 'file';
      entries.push({ path: path.join(target, relative), relative, type });
      if (type === 'dir') pending.push(relative);
    }
  }
  return entries.sort((a, b) => compareRelative(a.relative, b.relative));
}

// 경로 조각 단위로 비교해서 'a/b'가 'a b'나 'a.txt'보다 'a' 바로 뒤에 오게 한다.
// Windows 탐색기처럼 대소문자를 무시하고, 대소문자만 다르면 원래 문자열로 순서를 고정한다.
function compareRelative(a, b) {
  const pa = a.split(path.sep);
  const pb = b.split(path.sep);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const order = compareName(pa[i].toLowerCase(), pb[i].toLowerCase()) || compareName(pa[i], pb[i]);
    if (order !== 0) return order;
  }
  return pa.length - pb.length;
}

function compareName(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

module.exports = { resolveTarget, isInside, resolveInside, readInside, readRange, walk };
