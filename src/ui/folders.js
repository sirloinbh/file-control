'use strict';

// fctl ui의 폴더 고르기 화면(#254)에 쓸 데이터. 화면(HTML)과 떼어 둔 함수라 서버 없이 시험할 수 있다.
// 드라이브 목록, 자주 쓰는 위치(다운로드·바탕화면·문서), 폴더 안 목록과 요약, 위로 가기, 보호 폴더 표시를 만든다.

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

// 자주 쓰는 위치의 실제 경로({ label, path }). 바탕화면·문서는 OneDrive로 옮겨졌으면 그쪽을 먼저 본다.
// OneDrive 쪽 폴더 이름은 표시 언어로 만들어지므로(바탕 화면, 문서) 영어 이름과 함께 찾는다. 있는 폴더만 돌려준다.
function commonPlaces({ home = os.homedir(), env = process.env, exists = isDirectory, readDir = (dir) => fs.readdirSync(dir) } = {}) {
  if (!home || !path.isAbsolute(home)) return [];
  const oneDrive = oneDriveFolders(home, env, readDir);
  const candidates = [
    { label: '다운로드', paths: [path.join(home, 'Downloads')] },
    { label: '바탕화면', paths: [...oneDrive.flatMap((dir) => [path.join(dir, 'Desktop'), path.join(dir, '바탕 화면')]), path.join(home, 'Desktop')] },
    { label: '문서', paths: [...oneDrive.flatMap((dir) => [path.join(dir, 'Documents'), path.join(dir, '문서')]), path.join(home, 'Documents')] },
  ];
  const places = [];
  for (const { label, paths } of candidates) {
    const found = paths.find((p) => exists(p));
    if (found) places.push({ label, path: found });
  }
  return places;
}

// 보호 폴더면 그 사유, 아니면 null. 사유를 알 수 없으면(사용자 폴더를 모름 등) 고르지 못하게 사유를 돌려준다.
function protection(dir) {
  try {
    return protectedReason(dir);
  } catch (err) {
    if (err instanceof FcError) return err.message;
    throw err;
  }
}

// 폴더 하나를 열어 고르기 화면에 쓸 내용을 돌려준다.
// - path: 정리한 절대경로, parent: 위 폴더(드라이브 루트면 null)
// - protected: 이 폴더를 고를 수 없는 사유(시스템 폴더, 사용자 폴더 자체, AppData·.ssh 등) 또는 null
// - folders: 안의 폴더({ name, path, protected }) 이름순, files: 안의 파일 수, size: 파일 크기 합(하위 폴더 제외)
// 보호 폴더도 들어가 볼 수는 있다(읽기만 한다). 고르는 것만 막는다.
function browseFolder(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new FcError(`절대경로가 아닙니다: ${dir}`);
  const resolved = path.resolve(dir);
  if (!isDirectory(resolved)) throw new FcError(`폴더가 아니거나 없습니다: ${resolved}`);
  let entries;
  try {
    entries = list(resolved);
  } catch (err) {
    if (err instanceof FcError) throw err;
    throw new FcError(`폴더를 읽을 수 없습니다: ${resolved} (${err.code ?? err.message})`);
  }
  const folders = entries
    .filter((entry) => entry.type === 'dir')
    .map((entry) => {
      const full = path.join(resolved, entry.name);
      return { name: entry.name, path: full, protected: protection(full) };
    });
  const files = entries.filter((entry) => entry.type === 'file');
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    protected: protection(resolved),
    folders,
    files: files.length,
    size: files.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
  };
}

module.exports = { listDrives, commonPlaces, browseFolder };
