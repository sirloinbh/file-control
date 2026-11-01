'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, freshPath } = require('./commands');
const { grant, walk } = require('./target');
const { normalizeName } = require('./normalize');
const { LEFTOVER, SYSTEM_FOLDER, moveWithoutOverwrite, rejectRepository, looksLikeGitDir } = require('./flatten');

// NTFS는 대소문자를 구분하지 않으므로 이름을 대문자로 비교한다. toLowerCase는 NTFS에서 같은 이름인 ΑΣ와 ασ를 다르게 만든다.
const nameKey = (p) => p.toUpperCase();

function skipReason(entry) {
  const parts = entry.relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return '이전 작업의 잔여물이라 바꾸지 않습니다.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Windows 시스템 폴더 안의 파일이라 바꾸지 않습니다.';
  return null;
}

// 타겟 아래 파일 이름을 정규화하는 계획을 만든다. 파일은 건드리지 않는다.
// - renames: 바꿀 파일 ({ from, to, name, number })
// - inferred: 소문자 말에서 번호를 추정해 바꾸지 않은 파일 ({ path, name }). includeLowercase를 주면 renames로 간다.
// - conflicts: 결과 이름이 기존 항목이나 다른 결과와 겹쳐 바꾸지 않은 파일 ({ path, name, reason })
// - skipped: 다루지 않는 항목 ({ path, reason })
function planNormalize(dir, { includeLowercase = false } = {}) {
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, renames: [], inferred: [], conflicts: [], skipped: [] };
  const entries = walk(access.target);
  // ref와 객체 이름이 곧 내용이라 이름을 바꾸면 저장소가 깨진다. 이름이 .git이 아닌 베어 저장소도 같다.
  rejectRepository(access.target, entries);
  const bare = entries.find((entry) => entry.type === 'dir' && looksLikeGitDir(entry.path));
  if (bare) throw new FcError(`저장소가 들어 있어 바꾸지 않습니다: ${bare.path}`);
  const existing = new Set(entries.map((entry) => nameKey(entry.path)));
  const wanted = [];
  for (const entry of entries) {
    if (entry.type === 'dir') continue;
    if (entry.type === 'link') {
      plan.skipped.push({ path: entry.path, reason: '링크는 바꾸지 않습니다.' });
      continue;
    }
    const reason = skipReason(entry);
    if (reason !== null) {
      plan.skipped.push({ path: entry.path, reason });
      continue;
    }
    const result = normalizeName(path.basename(entry.path));
    if (result.reason !== null) {
      // 숨김, 임시, 끝이 점인 이름까지 보고하면 목록이 묻힌다. 번호가 여럿이거나 이름이 너무 길어지는 경우만 알린다.
      if (result.number !== null || /번호가 여럿/.test(result.reason)) plan.skipped.push({ path: entry.path, reason: result.reason });
      continue;
    }
    if (result.name === path.basename(entry.path)) continue;
    if (result.inferred && !includeLowercase) {
      plan.inferred.push({ path: entry.path, name: result.name });
      continue;
    }
    wanted.push({ entry, result });
  }

  // 결과가 겹치면 어느 쪽을 남길지 정할 수 없으므로 모두 바꾸지 않는다.
  const targets = new Map();
  for (const item of wanted) {
    const key = nameKey(path.join(path.dirname(item.entry.path), item.result.name));
    targets.set(key, (targets.get(key) ?? 0) + 1);
  }
  for (const { entry, result } of wanted) {
    const to = path.join(path.dirname(entry.path), result.name);
    const key = nameKey(to);
    const conflict = (reason) => plan.conflicts.push({ path: entry.path, name: result.name, reason });
    if (targets.get(key) > 1) {
      conflict('다른 파일도 같은 이름이 됩니다.');
    } else if (key !== nameKey(entry.path) && existing.has(key)) {
      conflict('같은 이름이 이미 있습니다.');
    } else {
      try {
        const from = access.read(entry.path);
        // 대소문자만 바뀌면 access.write가 지금 파일의 실제 표기를 돌려주므로, 원본 폴더에 새 이름을 붙여 쓴다.
        const dest = key === nameKey(entry.path) ? path.join(path.dirname(from), result.name) : access.write(to);
        // 다른 파일의 8.3 짧은 이름과 겹치면 access.write가 그 파일의 긴 경로를 돌려준다.
        if (nameKey(path.basename(dest)) !== nameKey(result.name)) conflict('같은 이름이 이미 있습니다.');
        else plan.renames.push({ from, to: dest, name: result.name, number: result.number });
      } catch (err) {
        if (!(err instanceof FcError)) throw err;
        plan.skipped.push({ path: entry.path, reason: err.message });
      }
    }
  }
  return plan;
}

// 대소문자만 바뀌는 이름은 대상이 자기 자신으로 잡혀 덮어쓰지 않는 이동이 실패한다. 임시 이름을 거친다.
// 임시 이름으로 옮긴 사이 그 이름에 다른 프로그램이 파일을 만들 수 있다. 그 파일을 덮어쓰지 않도록 되돌릴 때도 덮어쓰지 않는 이동을 쓴다.
function renameCaseOnly(from, to, name) {
  const middle = freshPath(from, '.fctl-new');
  fs.renameSync(from, middle);
  let cause;
  try {
    // 끊어진 정션에 wx로 열면 정션이 가리키는 타겟 밖에 폴더가 생기므로 먼저 본다.
    if (!fs.lstatSync(to, { throwIfNoEntry: false }) && moveWithoutOverwrite(middle, to)) return;
    cause = new FcError(`같은 이름이 이미 있어 바꾸지 않습니다: ${name}`);
  } catch (err) {
    cause = err;
  }
  restoreCaseOnly(middle, from, cause);
  throw cause;
}

function restoreCaseOnly(middle, from, cause) {
  let restored = false;
  let reason = 'EEXIST';
  try {
    if (!fs.lstatSync(from, { throwIfNoEntry: false })) restored = moveWithoutOverwrite(middle, from);
  } catch (err) {
    reason = err.code ?? err.message;
  }
  if (!restored) throw new FcError(`이름을 바꾸지 못했고 되돌리지도 못했습니다. 파일은 ${middle}에 있습니다. (${cause.code ?? cause.message}, ${reason})`);
}

// 계획과 실행 사이에 원본이 링크로 바뀌었거나 이름이 찼으면 바꾸지 않는다. 덮어쓰지 않는다.
function applyRename(rename, access) {
  const from = access.delete(rename.from);
  if (from !== rename.from) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${rename.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`계획 뒤에 파일이 아니게 됐습니다: ${from}`);
  if (nameKey(rename.from) === nameKey(rename.to)) {
    renameCaseOnly(from, rename.to, rename.name);
    return;
  }
  const taken = () => new FcError(`같은 이름이 이미 있어 바꾸지 않습니다: ${rename.name}`);
  // 이미 있는 항목에는 손대지 않는다. 끊어진 정션에 wx로 열면 정션이 가리키는 타겟 밖에 폴더가 생긴다.
  if (fs.lstatSync(rename.to, { throwIfNoEntry: false })) throw taken();
  const to = access.write(rename.to);
  if (to !== rename.to) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${rename.to} -> ${to}`);
  if (!moveWithoutOverwrite(from, to)) throw taken();
}

// 타겟 아래 파일 이름을 정규화한다. 덮어쓰지 않고, 한 파일이 실패해도 나머지는 계속한다.
// 돌려주는 값: { target, dryRun, renamed, inferred, conflicts, skipped, failed }. failed는 { from, reason } 목록이다.
function normalizeFiles(dir, { dryRun = false, includeLowercase = false } = {}) {
  return applyNormalize(planNormalize(dir, { includeLowercase }), { dryRun });
}

function applyNormalize(plan, { dryRun = false } = {}) {
  const { renames, target, ...rest } = plan;
  const result = { target, dryRun, renamed: [], ...rest, failed: [] };
  if (dryRun) return { ...result, renamed: renames };
  const access = grant(target, ['write', 'delete']);
  for (const rename of renames) {
    try {
      applyRename(rename, access);
      result.renamed.push(rename);
    } catch (err) {
      result.failed.push({ from: rename.from, reason: err instanceof FcError ? err.message : `이름을 바꾸지 못했습니다. (${err.code})` });
    }
  }
  return result;
}

function formatNormalize(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[미리보기] ' : '';
  const lines = [];
  for (const item of result.renamed) lines.push(`${prefix}이름 변경: ${relative(item.from)} -> ${item.name}`);
  for (const item of result.inferred) lines.push(`${prefix}소문자 말이라 그대로 둠: ${relative(item.path)} -> ${item.name}`);
  for (const item of result.conflicts) lines.push(`${prefix}이름이 겹침: ${relative(item.path)} -> ${item.name} (${item.reason})`);
  for (const item of result.skipped) lines.push(`${prefix}건너뜀: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`실패: ${relative(item.from)} (${item.reason})`);
  lines.push(
    `${prefix}이름 변경 ${result.renamed.length}개, 소문자 말 ${result.inferred.length}개, 겹침 ${result.conflicts.length}개, 건너뜀 ${result.skipped.length}개, 실패 ${result.failed.length}개`,
  );
  return lines.join('\n');
}

module.exports = { planNormalize, applyNormalize, normalizeFiles, formatNormalize };
