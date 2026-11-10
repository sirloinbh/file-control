'use strict';

// fctl ui의 폴더 고르기 화면(#254)에 쓸 데이터. 화면(HTML)과 떼어 둔 함수라 서버 없이 시험할 수 있다.
// 드라이브 목록, 자주 쓰는 위치(다운로드·바탕화면·문서), 폴더 안 목록과 요약, 위로 가기, 보호 폴더 표시를 만든다.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError, list } = require('../commands');
const { protectedReason } = require('../target');

// 폴더면 true. 없거나 읽을 수 없으면 false.
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// 드라이브 루트 목록(C:\, D:\ …). Windows가 아니면 루트(/) 하나다. exists는 시험에서 바꿔 끼운다.
function listDrives({ platform = process.platform, exists = isDirectory } = {}) {
  if (platform !== 'win32') return [path.parse(process.cwd()).root];
  const drives = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (exists(root)) drives.push(root);
  }
  return drives;
}

// OneDrive 폴더 후보. 환경 변수(개인·회사)와 사용자 폴더 아래의 OneDrive, OneDrive - 회사 폴더다.
function oneDriveFolders(home, env, readDir) {
  const found = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((p) => typeof p === 'string' && path.isAbsolute(p));
  let names = [];
  try {
    names = readDir(home);
  } catch {
    names = [];
  }
  for (const name of names) if (/^OneDrive(?:$| - )/i.test(name)) found.push(path.join(home, name));
  // 같은 폴더를 두 번 넣지 않는다(대소문자 무시).
  const seen = new Set();
  return found.filter((p) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Windows가 쓰는 다운로드·바탕화면·문서의 실제 위치(레지스트리 User Shell Folders, 환경 변수를 풀어 쓴 값)(1차 리뷰).
// OneDrive로 옮겼으면 이 값이 OneDrive 쪽을 가리킨다. reg.exe는 한글 경로를 코드 페이지로 깨뜨려 내므로 PowerShell에서 UTF-8 JSON으로 받는다.
const SHELL_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'",
  "@{ downloads = $k.'{374DE290-123F-4565-9164-39C4925E467B}'; desktop = $k.Desktop; documents = $k.Personal } | ConvertTo-Json -Compress",
].join('; ');

// 등록된 위치({ downloads?, desktop?, documents? }). 읽지 못하면 빈 객체다. 서버가 도는 동안 한 번만 읽는다.
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
    // 읽지 못하면 아래 후보 경로로 찾는다.
  }
  return shellCache;
}

// 자주 쓰는 위치의 실제 경로({ label, path }). Windows에 등록된 위치(shell)를 먼저 쓰고, 없거나 그 폴더가 없으면 후보를 차례로 본다.
// 후보: 바탕화면·문서는 OneDrive로 옮겨진 쪽을 먼저 본다. OneDrive 쪽 폴더 이름은 표시 언어로 만들어지므로(바탕 화면, 문서) 영어 이름과 함께 찾는다.
// 있는 폴더만 돌려준다.
function commonPlaces({ home = os.homedir(), env = process.env, exists = isDirectory, readDir = (dir) => fs.readdirSync(dir), shell = shellFolders } = {}) {
  if (!home || !path.isAbsolute(home)) return [];
  const oneDrive = oneDriveFolders(home, env, readDir);
  const registered = shell();
  const first = (key) => (registered[key] ? [registered[key]] : []);
  const candidates = [
    { label: '다운로드', paths: [...first('downloads'), path.join(home, 'Downloads')] },
    { label: '바탕화면', paths: [...first('desktop'), ...oneDrive.flatMap((dir) => [path.join(dir, 'Desktop'), path.join(dir, '바탕 화면')]), path.join(home, 'Desktop')] },
    { label: '문서', paths: [...first('documents'), ...oneDrive.flatMap((dir) => [path.join(dir, 'Documents'), path.join(dir, '문서')]), path.join(home, 'Documents')] },
  ];
  const places = [];
  for (const { label, paths } of candidates) {
    const found = paths.find((p) => exists(p));
    if (found) places.push({ label, path: found });
  }
  return places;
}

// 보호 폴더면 그 사유, 아니면 null. 사유를 알 수 없으면(사용자 폴더를 모름 등) 고르지 못하게 사유를 돌려준다.
// 끝이 점이나 공백인 이름도 고르지 못하게 사유를 돌려준다. PowerShell·.NET은 그 글자를 지워 다른 폴더(AppData. → AppData)로 읽는다(1차 리뷰).
function protection(dir) {
  if (process.platform === 'win32') {
    const name = dir.slice(path.parse(dir).root.length).split(path.sep).find((part) => TRAILING_DOT_OR_SPACE.test(part));
    if (name !== undefined) return `끝이 점이나 공백인 이름(${name})`;
  }
  try {
    return protectedReason(dir);
  } catch (err) {
    if (err instanceof FcError) return err.message;
    throw err;
  }
}

// 끝이 점이나 공백인 이름(target.js와 같은 기준)
const TRAILING_DOT_OR_SPACE = /[\s\u0085.]$/;

// 네트워크·장치 경로(\\서버\공유, \\?\, \\.\)면 true. 열면 그 서버에 접속을 시도해 인증 정보가 나갈 수 있으므로 열지 않는다(1차 리뷰).
function isNetworkOrDevicePath(p) {
  return process.platform === 'win32' && /^[\\/]{2}/.test(p);
}

// 입력 경로를 실제 폴더 경로로 바꾼다(1차 리뷰). 8.3 짧은 이름(C:\PROGRA~1), 대소문자, 정션·심볼릭 링크를 풀어
// 보호 판정과 고른 값이 실제 폴더를 가리키게 한다. 네트워크·장치 경로와 그리로 이어지는 링크는 거부한다.
function realFolder(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) throw new FcError(`절대경로가 아닙니다: ${dir}`);
  if (isNetworkOrDevicePath(dir)) throw new FcError(`네트워크·장치 경로는 열지 않습니다: ${dir}`);
  const resolved = path.resolve(dir);
  if (!isDirectory(resolved)) throw new FcError(`폴더가 아니거나 없습니다: ${resolved}`);
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (err) {
    throw new FcError(`폴더를 확인할 수 없습니다: ${resolved} (${err.code ?? err.message})`);
  }
  if (isNetworkOrDevicePath(real)) throw new FcError(`네트워크 경로로 이어지는 폴더는 열지 않습니다: ${resolved}`);
  return real;
}

// 부모의 보호 사유를 자식이 물려받으면 그 사유를 돌려준다(1차 리뷰, 큰 폴더에서 자식마다 판정하지 않게).
// 부모가 보호 폴더 "안"이면(시스템 폴더, 설정 폴더 등) 자식도 같다. 부모가 보호 폴더를 "포함"해 막혔거나(드라이브 루트, 사용자 폴더 자체)
// 사유를 알 수 없었으면 자식마다 다르므로 null이다.
function inheritedProtection(parentReason) {
  if (parentReason === null || parentReason.endsWith('를 포함')) return null;
  return /^(?:시스템 폴더|사용자 설정 폴더|다른 사용자의 설정 폴더|기본 사용자 프로필|끝이 점이나 공백인 이름)/.test(parentReason) ? parentReason : null;
}

// 화면에 보여 줄 하위 폴더 수 한도. 큰 폴더(C:\Windows\WinSxS 등)에서 화면이 지나치게 커지고 서버가 오래 멈추지 않게 한다(1차 리뷰).
const MAX_FOLDERS = 1000;

// 폴더 하나를 열어 고르기 화면에 쓸 내용을 돌려준다.
// - path: 실제 경로(링크·짧은 이름을 푼 값), parent: 위 폴더(드라이브 루트면 null)
// - protected: 이 폴더를 고를 수 없는 사유(시스템 폴더, 사용자 폴더 자체, AppData·.ssh 등, 끝이 점·공백인 이름) 또는 null
// - folders: 안의 폴더({ name, path, protected }) 이름순, 많으면 앞의 MAX_FOLDERS개. hiddenFolders: 한도로 뺀 폴더 수
// - files: 안의 파일 수, size: 파일 크기 합(하위 폴더 제외)
// 보호 폴더도 들어가 볼 수는 있다(읽기만 한다). 고르는 것만 막는다.
function browseFolder(dir) {
  const resolved = realFolder(dir);
  let entries;
  try {
    entries = list(resolved);
  } catch (err) {
    if (err instanceof FcError) throw err;
    throw new FcError(`폴더를 읽을 수 없습니다: ${resolved} (${err.code ?? err.message})`);
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
