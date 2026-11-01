'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk } = require('./target');

// NTFS 파일 이름 한도 (UTF-16 글자 수)
const MAX_NAME = 255;

// toLowerCase는 문맥을 봐서 NTFS에서 같은 이름인 ΑΣ와 ασ를 다르게 만드므로 대문자로 맞춘다.
function nameKey(name) {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

// 이름이 비어 있는지 본다. 계획한 이름뿐 아니라 실제 항목도 확인해야 8.3 짧은 이름(LONGFI~1.TXT)과의 겹침이 잡힌다.
// 한도를 넘는 이름은 파일 시스템에 물어볼 수 없으니 그대로 돌려보내 호출한 쪽에서 건너뛰게 한다.
function isTaken(name, target, taken) {
  if (taken.has(nameKey(name))) return true;
  if (name.length > MAX_NAME) return false;
  try {
    return Boolean(fs.lstatSync(path.join(target, name), { throwIfNoEntry: false }));
  } catch (err) {
    throw new FcError(`경로를 확인할 수 없습니다: ${name} (${err.code})`);
  }
}

// a.mkv가 겹치면 a (2).mkv, a (3).mkv 순으로 비어 있는 이름을 찾는다.
// 같은 이름이 많을 때 매번 2부터 다시 찾지 않도록 이름별 다음 번호를 기억한다.
function freeName(name, target, taken, nextNumber) {
  if (!isTaken(name, target, taken)) return name;
  const { name: base, ext } = path.parse(name);
  const key = nameKey(name);
  for (let n = nextNumber.get(key) ?? 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!isTaken(candidate, target, taken)) {
      nextNumber.set(key, n + 1);
      return candidate;
    }
  }
}

// 제품번호 형식(ABC-123). 정식 규칙은 #22에서 정한다. Report_2023 같은 일반 이름을 잡지 않도록 대문자와 -만 본다.
const PRODUCT_NUMBER = /(?<![A-Za-z0-9])[A-Z]{2,}-\d{2,}(?![A-Za-z0-9])/;

// 폴더 이름의 끝이 확장자처럼 보이는지 본다. Movie.2021.1080p처럼 숫자로 시작하는 끝부분은 확장자로 보지 않는다.
const EXTENSION_LIKE = /\.(?:[A-Za-z][A-Za-z0-9]{0,9}|7z)$/;

// 이름에 정보가 없는 파일명. 이런 파일만 제품번호 폴더 이름으로 바꾼다. 계약서, ko 같은 이름은 지우면 정보를 잃는다.
const GENERIC_NAME = /^(?:[A-Z]|VIDEO|MOVIE|FILM|CLIP|FILE|IMAGE|PHOTO|AUDIO|SAMPLE|UNTITLED|영상|동영상|파일)$/;

// 공백·기호·대소문자 차이를 빼고 단어로 나눈다.
function words(name) {
  return name.normalize('NFC').toUpperCase().split(/[\s\-_.()[\]]+/).filter(Boolean);
}

// 폴더의 이어진 단어들을 붙인 것이 파일 이름과 같으면 true. 글자 단위로 찾으면 v와 movie, 2와 2021처럼 우연히 겹친다.
function containsWords(folderWords, fileText) {
  return folderWords.some((_, start) => {
    let joined = '';
    for (let i = start; i < folderWords.length && joined.length < fileText.length; i++) joined += folderWords[i];
    return joined === fileText;
  });
}

// 폴더명이 파일명보다 자세하면 true. 판단이 서지 않으면 파일 이름을 지키도록 false를 돌려준다.
// 길이만으로는 고르지 않는다. 파일 이름의 정보(날짜, 화질, 언어, 번호)는 지우면 되돌릴 수 없다.
function isMoreDetailed(folder, base) {
  const folderWords = words(folder);
  const baseWords = words(base);
  const f = folderWords.join('');
  const b = baseWords.join('');
  if (f === '' || b === '') return false;
  if (f.length > b.length && containsWords(folderWords, b)) return true;
  if (b.includes(f)) return false;
  return PRODUCT_NUMBER.test(folder) && GENERIC_NAME.test(b);
}

// 파일 이름과 폴더 이름(가까운 폴더부터) 중 가장 자세한 이름을 확장자를 유지해 돌려준다.
function detailedName(fileName, folders) {
  const { name: base, ext } = path.parse(fileName);
  // 확장자가 없으면 폴더 이름의 끝이 확장자가 될 수 있고(data + data.zip/), .env.local 같은 점 파일은 이름이 곧 정체다.
  // .tar.gz는 폴더 이름을 붙이면 .gz만 남아 형식을 잃는다. Dr. Strange의 ". Strange"는 확장자가 아니다.
  if (ext === '' || /\s/.test(ext) || fileName.startsWith('.') || /\.tar$/i.test(base)) return fileName;
  let best = base;
  for (const folder of folders) {
    // 폴더 이름에 같은 확장자가 들어 있으면(ABC-123.mp4/) 겹치지 않게 빼고, 다른 확장자면 이중 확장자가 되므로 쓰지 않는다.
    const stem = folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder;
    // .trash-1000 같은 점 폴더 이름을 쓰면 숨김 파일이 된다.
    if (!stem.startsWith('.') && !EXTENSION_LIKE.test(stem) && isMoreDetailed(stem, best)) best = stem.normalize('NFC');
  }
  return best + ext;
}

// mv·zip이 실패했을 때 남긴 잔여물. 오류 메시지가 알려 준 위치에 그대로 있어야 복구할 수 있으니 옮기지 않는다.
const LEFTOVER = /^\.fctl-(?:old|new)-\d+-\d+-\d+(?:\.|$)/;

// Windows가 관리하는 폴더. 안쪽 파일을 꺼내면 복원 정보와 함께 망가진다.
const SYSTEM_FOLDER = /^(?:\$RECYCLE\.BIN|System Volume Information)$/i;

// 파일이 그 폴더(하위 포함)의 유일한 항목일 때만 폴더 이름을 쓸 수 있다. 여럿이면 ep1, ep2 같은 구분을 잃는다.
function soleFolders(entry, fileCounts) {
  const parts = entry.relative.split(path.sep).slice(0, -1);
  const folders = [];
  for (let depth = parts.length; depth > 0; depth--) {
    if (fileCounts.get(parts.slice(0, depth).join(path.sep)) !== 1) break;
    folders.push(parts[depth - 1]);
  }
  return folders;
}

// 폴더마다 안에 든 파일과 링크 수를 하위까지 합쳐 센다.
function countFiles(entries) {
  const counts = new Map();
  for (const entry of entries) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep).slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) {
      const key = parts.slice(0, depth).join(path.sep);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

// HEAD, objects, refs가 함께 있으면 Git 저장소 폴더다. 베어 저장소(backup.git)처럼 이름이 .git이 아니어도 잡는다.
function looksLikeGitDir(dir) {
  const stat = (name) => fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
  try {
    return Boolean(stat('HEAD')?.isFile() && stat('objects')?.isDirectory() && stat('refs')?.isDirectory());
  } catch (err) {
    throw new FcError(`저장소인지 확인할 수 없습니다: ${dir} (${err.code})`);
  }
}

// 저장소는 폴더 구조 자체가 내용이라, .git 안쪽만 건너뛰어도 작업 파일이 흩어져 복구할 수 없다. 일부만 옮기지 않고 거부한다.
// 타겟이 저장소의 일반 하위 폴더(r/src)면 저장소는 망가지지 않고 git으로 되돌릴 수 있으므로 막지 않는다.
function rejectRepository(target, entries) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (path.basename(dir).toLowerCase() === '.git' || looksLikeGitDir(dir)) throw new FcError(`Git 저장소 내부 폴더라 평탄화하지 않습니다: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  const dotGit = entries.find((entry) => entry.relative.split(path.sep).some((part) => part.toLowerCase() === '.git'));
  if (dotGit) throw new FcError(`Git 저장소가 들어 있어 평탄화하지 않습니다: ${dotGit.path}`);
  const bare = entries.find((entry) => entry.type === 'file' && path.basename(entry.path) === 'HEAD' && looksLikeGitDir(path.dirname(entry.path)));
  if (bare) throw new FcError(`Git 저장소가 들어 있어 평탄화하지 않습니다: ${path.dirname(bare.path)}`);
}

// 타겟 아래 모든 파일을 타겟 바로 아래로 옮기는 계획을 만든다. 파일은 건드리지 않는다.
// - moves: 옮길 파일 ({ from, to, name, desired, fromFolder, numbered }). desired는 번호를 붙이기 전의 이름이다. 폴더명이 더 자세하면 fromFolder가 true다.
//   이름이 겹치면 번호를 붙이고 numbered가 true다. 이미 있는 이름은 폴더라도 피한다.
// - stay: 이미 타겟 바로 아래에 있어 그대로 두는 항목의 경로
// - skipped: 옮기지 않는 항목 ({ path, reason }). 링크와 grant가 거부하는 이름은 조용히 빠지지 않게 사유를 남긴다.
function planFlatten(dir) {
  const access = grant(dir, ['read', 'write']);
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  const isTop = (entry) => !entry.relative.includes(path.sep);
  const taken = new Set(entries.filter(isTop).map((entry) => nameKey(entry.relative)));
  const nextNumber = new Map();
  const fileCounts = countFiles(entries);
  const plan = { target: access.target, moves: [], stay: [], skipped: [] };
  for (const entry of entries) {
    if (isTop(entry)) {
      if (entry.type !== 'dir') plan.stay.push(entry.path);
      continue;
    }
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => LEFTOVER.test(part))) {
      plan.skipped.push({ path: entry.path, reason: '이전 작업의 잔여물이라 옮기지 않습니다.' });
      continue;
    }
    if (parts.some((part) => SYSTEM_FOLDER.test(part))) {
      plan.skipped.push({ path: entry.path, reason: 'Windows 시스템 폴더 안의 파일이라 옮기지 않습니다.' });
      continue;
    }
    if (entry.type === 'link') {
      plan.skipped.push({ path: entry.path, reason: '링크는 옮기지 않습니다.' });
      continue;
    }
    const original = path.basename(entry.path);
    try {
      const from = access.read(entry.path);
      // 폴더 이름에 확장자를 붙이면 길이 한도를 넘을 수 있다. 파일을 건너뛰지 않고 원래 이름으로 돌아간다.
      const detailed = detailedName(original, soleFolders(entry, fileCounts));
      let desired = detailed.length > MAX_NAME ? original : detailed;
      let name = freeName(desired, access.target, taken, nextNumber);
      if (name.length > MAX_NAME && desired !== original) {
        desired = original;
        name = freeName(desired, access.target, taken, nextNumber);
      }
      if (name.length > MAX_NAME) throw new FcError(`번호를 붙이면 이름이 너무 깁니다: ${name}`);
      plan.moves.push({ from, to: access.write(name), name, desired, fromFolder: desired !== original, numbered: name !== desired });
      taken.add(nameKey(name));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      plan.skipped.push({ path: entry.path, reason: err.message });
    }
  }
  return plan;
}

// 빈 파일로 자리를 먼저 확보한 뒤 그 위로 옮긴다. 이미 있으면(8.3 짧은 이름, 대소문자 포함) 아무것도 바꾸지 않고 false를 돌려준다.
// renameSync는 대상을 덮어쓰고, linkSync 뒤 unlinkSync는 원본이 잠겨 있으면 두 이름으로 남는다.
function moveWithoutOverwrite(from, to) {
  try {
    fs.closeSync(fs.openSync(to, 'wx'));
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.renameSync(from, to);
  } catch (err) {
    removePlaceholder(to, err);
    throw err;
  }
  return true;
}

// 그사이 다른 프로그램이 내용을 썼다면 내 자리표시가 아니므로 지우지 않는다.
function removePlaceholder(to, cause) {
  let stat;
  try {
    stat = fs.lstatSync(to, { throwIfNoEntry: false });
  } catch (err) {
    throw new FcError(`옮기지 못했고 자리표시 파일도 확인하지 못했습니다: ${to} (${cause.code}, ${err.code})`);
  }
  if (!stat) return;
  if (!stat.isFile() || stat.size !== 0) throw new FcError(`옮기지 못했고 자리표시 파일에 다른 내용이 생겨 지우지 않았습니다: ${to} (${cause.code})`);
  try {
    fs.rmSync(to, { force: true, maxRetries: 3 });
  } catch (err) {
    throw new FcError(`옮기지 못했고 빈 자리표시 파일도 지우지 못했습니다: ${to} (${cause.code}, ${err.code})`);
  }
}

// 번호를 다시 고르는 횟수 한도. 다른 프로그램이 계속 같은 이름을 만들 때 끝나지 않는 일을 막는다.
const MAX_ATTEMPTS = 100;

// 계획한 이름이 그사이 찼으면 번호를 다시 고른다. a/longfilename.txt를 옮기면 LONGFI~1.TXT가 새로 차는 것처럼 계획 단계에서 알 수 없다.
function applyMove(move, access, taken, nextNumber) {
  // 계획과 실행 사이에 원본이 링크로 바뀌었거나 타겟 밖을 가리키면 여기서 거부된다.
  const from = access.delete(move.from);
  // 부모가 안쪽을 가리키는 정션으로 바뀌었거나 파일이 폴더로 바뀌면 계획과 다른 항목을 옮기게 된다.
  if (from !== move.from) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${move.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`계획 뒤에 파일이 아니게 됐습니다: ${from}`);
  let name = move.name;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (name.length > MAX_NAME) throw new FcError(`번호를 붙이면 이름이 너무 깁니다: ${name}`);
    const to = path.join(access.target, name);
    // 이미 있는 항목에는 손대지 않는다. 끊어진 정션에 wx로 열면 정션이 가리키는 타겟 밖에 폴더가 생긴다.
    if (!fs.lstatSync(to, { throwIfNoEntry: false })) {
      access.write(name);
      if (moveWithoutOverwrite(from, to)) return { ...move, from, to, name, numbered: name !== move.desired };
    }
    name = freeName(move.desired, access.target, taken, nextNumber);
    taken.add(nameKey(name));
  }
  throw new FcError(`비어 있는 이름을 찾지 못했습니다: ${move.desired}`);
}

// 타겟 아래 파일을 타겟 바로 아래로 옮긴다. 덮어쓰지 않고, 한 파일이 실패해도 나머지는 계속 옮긴다.
// 돌려주는 값: { target, dryRun, moved, stay, skipped, failed }. failed는 { from, reason } 목록이다.
function flatten(dir, { dryRun = false } = {}) {
  const plan = planFlatten(dir);
  const result = { target: plan.target, dryRun, moved: [], stay: plan.stay, skipped: plan.skipped, failed: [] };
  if (dryRun) return { ...result, moved: plan.moves };
  const access = grant(plan.target, ['write', 'delete']);
  // 앞으로 옮길 파일의 이름을 뺏지 않도록 계획한 이름을 모두 차지한 것으로 본다.
  const taken = new Set(plan.moves.map((move) => nameKey(move.name)));
  const nextNumber = new Map();
  for (const move of plan.moves) {
    try {
      result.moved.push(applyMove(move, access, taken, nextNumber));
    } catch (err) {
      result.failed.push({ from: move.from, reason: err.message });
    }
  }
  return result;
}

// 결과를 사람이 읽을 수 있게 줄로 만든다. 자세한 보고 형식은 #19에서 다듬는다.
function formatFlatten(result) {
  const relative = (p) => path.relative(result.target, p);
  const prefix = result.dryRun ? '[미리보기] ' : '';
  const lines = [];
  for (const move of result.moved) {
    const notes = [move.fromFolder && '폴더명 사용', move.numbered && '번호 붙임'].filter(Boolean);
    lines.push(`${prefix}이동: ${relative(move.from)} -> ${move.name}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`);
  }
  for (const item of result.skipped) lines.push(`${prefix}건너뜀: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`실패: ${relative(item.from)} (${item.reason})`);
  lines.push(`${prefix}이동 ${result.moved.length}개, 그대로 ${result.stay.length}개, 건너뜀 ${result.skipped.length}개, 실패 ${result.failed.length}개`);
  return lines.join('\n');
}

module.exports = { planFlatten, detailedName, flatten, formatFlatten };
