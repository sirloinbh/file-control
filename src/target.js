'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError, rejectHardLinkedWrite } = require('./commands');
const { WINDOWS_DEVICE_NAME, deviceNamePattern } = require('./windowsNames');

// 타겟 디렉토리를 실제 절대경로로 정규화한다. 없거나 폴더가 아니면 오류를 낸다.
// 보호 경로 안이거나 보호 경로를 품은 폴더(C:\, 사용자 폴더 등)도 거부한다.
function resolveTarget(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new FcError('타겟 폴더를 지정하세요.');
  if (dir.includes('\0')) throw new FcError('타겟 경로에 NUL 문자가 있습니다.');
  const abs = path.resolve(dir);
  rejectNetworkPath(abs);
  // System Volume Information·Recovery·다른 사용자의 AppData처럼 볼 권한이 없는 폴더는 확인할 수 없어 받지 않는다.
  const unreadable = (err) => new FcError(`타겟 폴더를 확인할 수 없어 쓸 수 없습니다: ${abs} (${err.code ?? err.message})`);
  let stat;
  try {
    stat = fs.statSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    throw unreadable(err);
  }
  if (!stat) throw new FcError(`타겟 폴더가 없습니다: ${abs}`);
  if (!stat.isDirectory()) throw new FcError(`타겟이 폴더가 아닙니다: ${abs}`);
  // 대소문자·8.3 짧은 이름·드라이브 문자 표기를 실제 경로 하나로 맞춘다.
  let target;
  try {
    target = fs.realpathSync.native(abs);
  } catch (err) {
    throw unreadable(err);
  }
  rejectNetworkPath(target);
  rejectTrailingDotOrSpace(target);
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

// Node는 끝의 점·공백을 글자 그대로 보지만 PowerShell·tar.exe·.NET은 지운다.
// AppData. 같은 폴더를 타겟으로 받으면 그 도구들에서는 AppData가 되어 보호 경로를 우회한다.
const TRAILING_DOT_OR_SPACE = /[\s\u0085.]$/;

function rejectTrailingDotOrSpace(target) {
  if (process.platform !== 'win32') return;
  const name = target.slice(path.parse(target).root.length).split(path.sep).find((part) => TRAILING_DOT_OR_SPACE.test(part));
  if (name !== undefined) throw new FcError(`끝이 점이나 공백인 폴더는 타겟으로 쓸 수 없습니다: ${target}`);
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
// 32비트 Node에서는 ProgramFiles가 x86 폴더를 가리키므로 64비트 폴더는 ProgramW6432로 따로 본다.
// C:\Users\All Users는 ProgramData를 가리키는 링크라 실제 경로로 맞추면 ProgramData에 걸린다(#50).
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

// 드라이브마다 루트에 있는 시스템 숨김 폴더(휴지통, 복원 지점). 이름은 대소문자가 섞여 나온다(C:\$Recycle.Bin, D:\$RECYCLE.BIN).
const DRIVE_SYSTEM_FOLDERS = ['$recycle.bin', 'system volume information'];

// 드라이브 루트는 언제든 휴지통이 생길 수 있어(처음 rm할 때) 있는지와 상관없이 막는다.
// 폴더에 연결한 볼륨(C:\mnt\vol)의 루트는 알아보지 못한다.
function driveSystemReason(target) {
  if (process.platform !== 'win32') return null;
  const { root } = path.parse(target);
  const [first] = target.slice(root.length).split(path.sep);
  if (!first) return `드라이브 루트 ${root}(휴지통·System Volume Information이 있거나 생기는 곳)`;
  if (DRIVE_SYSTEM_FOLDERS.includes(first.toLowerCase())) return `시스템 폴더 ${path.join(root, first)}`;
  return null;
}

// 프로필 폴더(C:\Users) 아래의 다른 프로필. Public은 일반 공유 폴더라 허용하고,
// Default는 새 사용자의 원본 프로필이라 통째로 막는다. 다른 사용자는 현재 사용자처럼 프로필 자신과 숨김 설정 폴더를 막는다.
// 프로필 폴더는 PUBLIC(C:\Users\Public)의 상위로 알아낸다. 사용자 폴더가 그 바로 아래에 있을 때만 이 규칙을 쓴다.
// 사용자 폴더를 다른 곳으로 옮긴 경우에는 그 형제 폴더를 다른 사용자로 잘못 보지 않기 위해서다.
function profilesDir() {
  const env = process.env;
  const systemDrive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive : 'C:';
  const pub = env.PUBLIC && path.isAbsolute(env.PUBLIC) ? env.PUBLIC : `${systemDrive}\\Users\\Public`;
  return realOrResolved(path.dirname(pub));
}

function otherProfileReason(target, home) {
  if (process.platform !== 'win32') return null;
  const profiles = profilesDir();
  // path.relative는 Windows에서 대소문자를 구분하지 않는다.
  if (profiles === path.parse(profiles).root || path.relative(profiles, path.dirname(home)) !== '' || !isInside(profiles, target)) return null;
  const rel = path.relative(profiles, target);
  if (rel === '') return null;
  const [name, sub] = rel.split(path.sep);
  const lower = name.toLowerCase();
  if (lower === 'public') return null;
  const profile = path.join(profiles, name);
  if (lower === 'default' || lower === 'default user') return `기본 사용자 프로필 ${profile}`;
  if (sub === undefined) return `다른 사용자 폴더 ${profile}`;
  if (isHiddenSettings(sub)) return `다른 사용자의 설정 폴더 ${path.join(profile, sub)}`;
  return null;
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
  const drive = driveSystemReason(target);
  if (drive) return drive;
  const home = homeDir();
  if (isInside(target, home)) return `사용자 폴더 ${home}를 포함`;
  if (isInside(home, target)) {
    const [first] = path.relative(home, target).split(path.sep);
    if (isHiddenSettings(first)) return `사용자 설정 폴더 ${path.join(home, first)}`;
    return null;
  }
  return otherProfileReason(target, home);
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

// 있는 경로의 링크·정션을 풀어낸 실제 경로를 돌려준다. 실제 경로가 타겟 밖이면 오류를 낸다.
function realInside(target, abs) {
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new FcError(`경로가 없거나 끊어진 링크입니다: ${abs}`);
    throw err;
  }
  // 둘 다 실제 경로이므로 글자 그대로 비교한다. isInside의 대소문자 무시는 NTFS보다 넓어서(K와 U+212A) 형제 폴더를 안으로 본다.
  const prefix = target.endsWith(path.sep) ? target : target + path.sep;
  if (real !== target && !real.startsWith(prefix)) throw new FcError(`링크를 거쳐 타겟 폴더 밖을 가리킵니다: ${abs} -> ${real}`);
  return real;
}

// 타겟 안의 파일을 찾아 실제 경로를 돌려준다. target은 resolveTarget이 돌려준 경로여야 한다.
// 경로 문자열뿐 아니라 링크·정션을 풀어낸 실제 경로도 타겟 안이어야 한다.
function resolveFileInside(target, p) {
  const abs = resolveInside(target, p);
  const real = realInside(target, abs);
  if (!fs.statSync(real).isFile()) throw new FcError(`파일이 아닙니다: ${abs}`);
  return real;
}

// Node는 이름을 글자 그대로 쓰지만 PowerShell·tar.exe·.NET은 끝의 점과 공백을 지우고 스트림(:)과 장치 이름을 따로 해석한다.
// 검사한 경로와 실제 작업 경로가 달라지지 않게 이런 이름과 Windows에서 쓸 수 없는 문자가 든 이름은 거부한다.
const WINDOWS_BAD_CHARS = /[:<>"|?*\x00-\x1f]/;
// 장치 이름 규칙은 기본 명령(src/commands.js)과 함께 쓰려고 windowsNames.js에 둔다(#53, #135).

function rejectAmbiguousNames(rel, p) {
  if (process.platform !== 'win32') return;
  const name = rel.split(path.sep).find((part) => TRAILING_DOT_OR_SPACE.test(part) || WINDOWS_BAD_CHARS.test(part) || WINDOWS_DEVICE_NAME.test(part));
  if (name !== undefined) throw new FcError(`Windows에서 다르게 해석될 수 있는 이름입니다: ${JSON.stringify(name)} (${p})`);
}

// 타겟 기준으로 정리한 절대경로를 돌려준다. 타겟 밖이거나 Windows에서 해석이 갈리는 이름이면 오류를 낸다.
function resolveAccessPath(target, p) {
  const abs = resolveInside(target, p);
  // path.relative는 K와 U+212A를 같게 보므로, 그런 형제 폴더의 경로가 타겟 안 다른 파일로 바뀌지 않게 한다.
  if (abs.slice(0, target.length).toUpperCase() !== target.toUpperCase()) throw new FcError(`타겟 폴더 밖의 경로입니다: ${abs} (타겟: ${target})`);
  const rel = path.relative(target, abs);
  rejectAmbiguousNames(rel, p);
  return path.join(target, rel);
}

// 링크를 풀어낸 실제 경로에도 같은 이름 검사를 한다. 입력은 평범해도 정션을 거쳐 그런 이름이 나올 수 있다.
function realForAccess(target, abs) {
  const real = realInside(target, abs);
  rejectAmbiguousNames(path.relative(target, real), real);
  return real;
}

// tar·cpSync·압축 해제는 폴더 안의 정션을 따라가므로, 링크가 든 폴더는 어떤 작업에도 내주지 않는다.
function rejectLinksInside(real, abs) {
  if (!fs.statSync(real).isDirectory()) return;
  const link = listEntries(real).find((entry) => entry.type === 'link');
  if (link) throw new FcError(`링크가 든 폴더는 다룰 수 없습니다: ${abs} (링크: ${link.path})`);
}

function checkRead(target, p) {
  const abs = resolveAccessPath(target, p);
  const real = realForAccess(target, abs);
  rejectLinksInside(real, abs);
  return real;
}

// 아직 없는 경로도 쓸 수 있으므로, 가장 가까운 있는 경로까지 올라가 그 실제 경로를 확인한다.
// 끊어진 링크는 있는 경로로 잡혀 거부된다. 그대로 쓰면 링크가 가리키는 타겟 밖에 파일이 생기기 때문이다.
function checkWrite(target, p) {
  const abs = resolveAccessPath(target, p);
  let existing = abs;
  while (existing !== target && !fs.lstatSync(existing, { throwIfNoEntry: false })) existing = path.dirname(existing);
  const real = realForAccess(target, existing);
  if (existing === abs) {
    if (real === target) throw new FcError(`타겟 폴더 자체에는 쓸 수 없습니다: ${abs}`);
    rejectLinksInside(real, abs);
    // 하드링크는 경로로 타겟 밖 파일과 구분할 수 없다. 읽기·삭제는 그대로 두고, 내용을 바꾸는 쓰기만 거부한다(#48).
    rejectHardLinkedWrite(real);
    return real;
  }
  if (!fs.statSync(real).isDirectory()) throw new FcError(`파일 아래에는 쓸 수 없습니다: ${abs} (${real})`);
  return path.join(real, path.relative(existing, abs));
}

// 링크 자체는 지우지 않는다. 휴지통 등 삭제 방식에 따라 링크를 따라갈 위험을 피한다.
function checkDelete(target, p) {
  const abs = resolveAccessPath(target, p);
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (stat && stat.isSymbolicLink()) throw new FcError(`링크는 삭제할 수 없습니다: ${abs}`);
  const real = realForAccess(target, abs);
  if (real === target) throw new FcError(`타겟 폴더 자체는 삭제할 수 없습니다: ${abs}`);
  rejectLinksInside(real, abs);
  return real;
}

const ACCESS = {
  read: { name: '읽기', check: checkRead },
  write: { name: '쓰기', check: checkWrite },
  delete: { name: '삭제', check: checkDelete },
};

// 타겟 하나에 작업 종류('read', 'write', 'delete')별 권한을 부여한다. 보호 경로는 resolveTarget이 거부하고,
// 타겟 안의 실제 경로는 보호 경로와 겹칠 수 없으므로 각 검사는 타겟 안인지만 본다.
// access.read(p)·write(p)·delete(p)는 경로를 검사해 실제 작업에 쓸 경로를 돌려주고, 아무것도 바꾸지 않는다.
// 검사와 작업 사이에 폴더가 바뀔 수 있으니 작업 직전에 호출하고, 돌려받은 경로를 그대로 쓴다.
function grant(dir, kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) throw new FcError('부여할 권한을 지정하세요. (read, write, delete)');
  if (kinds.findIndex((kind) => typeof kind !== 'string' || !Object.hasOwn(ACCESS, kind)) !== -1) {
    throw new FcError('알 수 없는 권한이 있습니다. (read, write, delete만 됩니다)');
  }
  const granted = new Set(kinds);
  const target = resolveTarget(dir);
  const access = { target };
  for (const [kind, { name, check }] of Object.entries(ACCESS)) {
    access[kind] = (p) => {
      if (typeof p !== 'string') throw new FcError('경로는 문자열이어야 합니다.');
      if (!granted.has(kind)) throw new FcError(`${name} 권한이 없습니다: ${p} (타겟: ${target})`);
      try {
        return check(target, p);
      } catch (err) {
        if (err instanceof FcError) throw err;
        throw new FcError(`경로를 확인할 수 없습니다: ${p} (${err.code})`);
      }
    };
  }
  return Object.freeze(access);
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

// 타겟 안 파일의 크기를 바이트로 돌려준다.
function fileSizeInside(target, p) {
  return fs.statSync(resolveFileInside(target, p)).size;
}

// 파일이 그대로인지 비교하는 값. bigint로 받은 lstat 결과를 넘긴다. 수정 시각을 되돌려도 변경 시각(ctime)이 달라진다.
function fileStamp(stat) {
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// 타겟 아래를 재귀로 읽어 파일·폴더·링크 목록을 돌려준다. 타겟 자신은 넣지 않는다.
// 심볼릭 링크와 정션은 type 'link'로만 넣고 따라 들어가지 않는다.
// 결과는 상대경로 순으로 정렬하며, 폴더가 그 안의 항목보다 먼저 온다.
// 하위 폴더 하나라도 읽지 못하면 전체를 실패시킨다. 일부만 읽은 목록으로 이동·삭제하지 않게 하려는 것이다.
// 파일마다 따로 하는 작업(product-number)은 unreadable 배열을 넘기면, 읽지 못한 하위 폴더를 { path, relative, reason }으로
// 담고 나머지를 계속 읽는다(#74). 타겟 자신을 읽지 못하거나 읽는 도중 폴더가 링크로 바뀌면 여전히 전체를 실패시킨다.
function walk(dir, { unreadable } = {}) {
  const entries = listEntries(resolveTarget(dir), unreadable).sort((a, b) => compareRelative(a.relative, b.relative));
  unreadable?.sort((a, b) => compareRelative(a.relative, b.relative));
  return entries;
}

// 건너뛰고 계속해도 되는 폴더 읽기 오류. 권한 거부와, 목록을 만든 뒤 폴더가 사라졌거나 파일로 바뀐 경우다.
// 그 밖의 오류(EMFILE, EIO 등)는 일시적이거나 원인을 알 수 없어 지금처럼 전체를 실패시킨다(1차 리뷰).
const SKIPPABLE_READ_ERRORS = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR']);

// 하위 폴더는 목록에 올린 뒤 나중에 읽으므로, 그 사이에 폴더가 링크·정션으로 바뀌면 다른 곳을 읽게 된다(#46).
// 읽은 뒤에 실제 경로가 그 자리 그대로인지 보고, 달라졌으면 목록을 내지 않고 오류를 낸다. 읽기 전에 바뀌어 그대로 있거나
// 읽는 동안 바뀌면 모두 잡힌다. 읽기 전에 바꿨다가 읽은 뒤 확인 전에 되돌리는 경우는 동기 API로 막을 수 없다.
// root는 resolveTarget이나 realInside가 돌려준 실제 경로라서, 바뀌지 않은 폴더의 실제 경로는 root와 그 아래 이름 그대로다.
// root 자신도 확인한다. rejectLinksInside는 realInside가 막 돌려준 폴더를 root로 넘긴다.
function ensureUnmoved(dir) {
  let real;
  try {
    real = fs.realpathSync.native(dir);
  } catch (err) {
    throw new FcError(`폴더를 읽을 수 없습니다: ${dir} (${err.code})`);
  }
  if (real !== dir) throw new FcError(`읽는 도중 폴더가 링크로 바뀌어 다른 곳을 가리킵니다. 아무것도 다루지 않았습니다: ${dir} -> ${real}`);
}

function listEntries(root, unreadable) {
  const entries = [];
  const pending = [''];
  while (pending.length > 0) {
    const relDir = pending.pop();
    const dir = path.join(root, relDir);
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (unreadable && relDir !== '' && SKIPPABLE_READ_ERRORS.has(err.code)) {
        unreadable.push({ path: dir, relative: relDir, reason: `폴더를 읽을 수 없어 그 안은 보지 않았습니다: ${err.code}` });
        continue;
      }
      throw new FcError(`폴더를 읽을 수 없습니다: ${dir} (${err.code})`);
    }
    ensureUnmoved(dir);
    for (const dirent of dirents) {
      const relative = path.join(relDir, dirent.name);
      const type = dirent.isSymbolicLink() ? 'link' : dirent.isDirectory() ? 'dir' : 'file';
      entries.push({ path: path.join(root, relative), relative, type });
      if (type === 'dir') pending.push(relative);
    }
  }
  return entries;
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

module.exports = { resolveTarget, isInside, resolveInside, readInside, readRange, fileSizeInside, fileStamp, walk, grant, rejectAmbiguousNames, compareRelative, deviceNamePattern, protectedReason };
