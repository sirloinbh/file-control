'use strict';

const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk } = require('./target');

// NTFS 파일 이름 한도 (UTF-16 글자 수)
const MAX_NAME = 255;

function nameKey(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

// a.mkv가 겹치면 a (2).mkv, a (3).mkv 순으로 비어 있는 이름을 찾는다.
function freeName(name, taken) {
  if (!taken.has(nameKey(name))) return name;
  const { name: base, ext } = path.parse(name);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

// 타겟 아래 모든 파일을 타겟 바로 아래로 옮기는 계획을 만든다. 파일은 건드리지 않는다.
// - moves: 옮길 파일 ({ from, to, name, numbered }). 이름이 겹치면 번호를 붙인다. 이미 있는 이름은 폴더라도 피한다.
// - stay: 이미 타겟 바로 아래에 있어 그대로 두는 항목의 경로
// - skipped: 옮기지 않는 항목 ({ path, reason }). 링크와 grant가 거부하는 이름은 조용히 빠지지 않게 사유를 남긴다.
function planFlatten(dir) {
  const access = grant(dir, ['read', 'write']);
  const entries = walk(access.target);
  const isTop = (entry) => !entry.relative.includes(path.sep);
  const taken = new Set(entries.filter(isTop).map((entry) => nameKey(entry.relative)));
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
      const name = freeName(original, taken);
      if (name.length > MAX_NAME) throw new FcError(`번호를 붙이면 이름이 너무 깁니다: ${name}`);
      plan.moves.push({ from, to: access.write(name), name, numbered: name !== original });
      taken.add(nameKey(name));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      plan.skipped.push({ path: entry.path, reason: err.message });
    }
  }
  return plan;
}

module.exports = { planFlatten };
