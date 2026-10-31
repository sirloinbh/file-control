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

// 제품번호 형식(ABC-123, abc_123). 정식 규칙은 #22에서 정한다. 잘못 고르지 않도록 구분자가 있는 형식만 보고,
// encoded_1080p처럼 앞뒤에 영숫자가 이어지는 것은 제외한다.
const PRODUCT_NUMBER = /(?<![A-Za-z0-9])[A-Za-z]{2,}[-_]\d{2,}(?![A-Za-z0-9])/;

// 공백·기호·대소문자 차이를 빼고 내용만 비교한다.
function compact(name) {
  return name.normalize('NFC').replace(/[\s\-_.()[\]]/g, '').toUpperCase();
}

// 폴더명이 파일명보다 자세하면 true. 판단이 서지 않으면 파일 이름을 지키도록 false를 돌려준다.
// 길이만으로는 고르지 않는다. video_final_encoded가 ABC-123보다 자세한 이름은 아니기 때문이다.
function isMoreDetailed(folder, base) {
  const f = compact(folder);
  const b = compact(base);
  if (f === '' || b === '') return false;
  if (f.length > b.length && f.includes(b)) return true;
  if (b.includes(f)) return false;
  return PRODUCT_NUMBER.test(folder) && !PRODUCT_NUMBER.test(base);
}

// 파일 이름과 폴더 이름(가까운 폴더부터) 중 가장 자세한 이름을 확장자를 유지해 돌려준다.
function detailedName(fileName, folders) {
  const { name: base, ext } = path.parse(fileName);
  let best = base;
  for (const folder of folders) {
    // 폴더 이름에 확장자까지 들어 있으면(ABC-123.mp4/) 확장자가 겹치지 않게 뺀다.
    const stem = ext && folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder;
    if (isMoreDetailed(stem, best)) best = stem;
  }
  return best + ext;
}

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

// 타겟 아래 모든 파일을 타겟 바로 아래로 옮기는 계획을 만든다. 파일은 건드리지 않는다.
// - moves: 옮길 파일 ({ from, to, name, fromFolder, numbered }). 폴더명이 더 자세하면 fromFolder가 true다.
//   이름이 겹치면 번호를 붙이고 numbered가 true다. 이미 있는 이름은 폴더라도 피한다.
// - stay: 이미 타겟 바로 아래에 있어 그대로 두는 항목의 경로
// - skipped: 옮기지 않는 항목 ({ path, reason }). 링크와 grant가 거부하는 이름은 조용히 빠지지 않게 사유를 남긴다.
function planFlatten(dir) {
  const access = grant(dir, ['read', 'write']);
  const entries = walk(access.target);
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
    if (entry.type === 'link') {
      plan.skipped.push({ path: entry.path, reason: '링크는 옮기지 않습니다.' });
      continue;
    }
    const original = path.basename(entry.path);
    try {
      const from = access.read(entry.path);
      // 폴더 이름에 확장자를 붙이면 길이 한도를 넘을 수 있다. 파일을 건너뛰지 않고 원래 이름으로 돌아간다.
      const detailed = detailedName(original, soleFolders(entry, fileCounts));
      const desired = detailed.length > MAX_NAME ? original : detailed;
      const name = freeName(desired, access.target, taken, nextNumber);
      if (name.length > MAX_NAME) throw new FcError(`번호를 붙이면 이름이 너무 깁니다: ${name}`);
      plan.moves.push({ from, to: access.write(name), name, fromFolder: desired !== original, numbered: name !== desired });
      taken.add(nameKey(name));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      plan.skipped.push({ path: entry.path, reason: err.message });
    }
  }
  return plan;
}

module.exports = { planFlatten, detailedName };
