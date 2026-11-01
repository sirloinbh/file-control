'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove, freshPath } = require('./commands');
const { grant, walk } = require('./target');
const { extractProductNumbers } = require('./product');
const { LEFTOVER, SYSTEM_FOLDER, rejectRepository } = require('./flatten');

// 폴더마다 바로 아래 항목을 모은다. 타겟 자신은 키가 ''이다.
function childrenOf(entries) {
  const children = new Map();
  for (const entry of entries) {
    const parent = path.dirname(entry.relative);
    const key = parent === '.' ? '' : parent;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(entry);
  }
  return children;
}

// 폴더 하나만 든 폴더면 그 폴더 항목을 돌려준다.
function soleFolder(children, relative) {
  const inside = children.get(relative) ?? [];
  return inside.length === 1 && inside[0].type === 'dir' ? inside[0] : null;
}

// 접을 수 없는 사유. 접어도 되면 null이다.
function skipReason(chain) {
  const parts = chain.at(-1).relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return '이전 작업의 잔여물이라 접지 않습니다.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Windows 시스템 폴더라 접지 않습니다.';
  // 접으면 가운데 폴더 이름이 사라진다. 제품번호는 그 이름에만 있을 수 있다.
  const kept = new Set(extractProductNumbers(path.basename(chain[0].path)));
  const lost = chain.slice(1).flatMap((entry) => extractProductNumbers(path.basename(entry.path))).filter((number) => !kept.has(number));
  if (lost.length > 0) return `접으면 폴더 이름의 제품번호가 사라집니다: ${[...new Set(lost)].join(', ')}. product-number를 먼저 실행해 파일 이름에 넣으세요.`;
  return null;
}

// 타겟 아래에서 폴더 하나만 이어지는 구간을 찾는다. 맨 위 폴더 이름을 남기고 맨 아래 폴더의 내용을 그 자리로 올린다.
// 타겟 자신은 접지 않는다. 한 단계에 항목이 여럿이면 그 아래부터 따로 본다.
// - collapses: 접을 구간 ({ top, leaf, folders, dropped }). folders는 맨 위부터 맨 아래까지의 경로다. 깊은 것부터 놓아 앞의 작업이 뒤의 경로를 바꾸지 않게 한다.
// - skipped: 접지 않는 구간 ({ path, reason })
function planCollapse(dir) {
  const access = grant(dir, ['read', 'write', 'delete']);
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  const children = childrenOf(entries);
  const plan = { target: access.target, collapses: [], skipped: [] };
  for (const entry of entries) {
    if (entry.type !== 'dir' || !soleFolder(children, entry.relative)) continue;
    const parent = path.dirname(entry.relative);
    // 위 폴더가 이 폴더 하나만 품고 있으면 위 폴더 쪽 구간에 들어간다.
    if (parent !== '.' && soleFolder(children, parent)) continue;
    const chain = [entry];
    for (let next = soleFolder(children, entry.relative); next; next = soleFolder(children, next.relative)) chain.push(next);
    const reason = skipReason(chain);
    if (reason !== null) {
      plan.skipped.push({ path: entry.path, reason });
      continue;
    }
    try {
      const folders = chain.map((item) => item.path);
      // 링크가 든 폴더처럼 다룰 수 없는 구간은 계획에서 알린다.
      if (access.delete(folders[0]) !== folders[0]) throw new FcError(`링크를 거치는 경로입니다: ${folders[0]}`);
      plan.collapses.push({ top: folders[0], leaf: folders.at(-1), folders, dropped: chain.slice(1).map((item) => path.basename(item.path)) });
    } catch (err) {
      if (err instanceof FcError) plan.skipped.push({ path: entry.path, reason: err.message });
      else if (err.syscall) plan.skipped.push({ path: entry.path, reason: `폴더를 확인할 수 없습니다. (${err.code})` });
      else throw err;
    }
  }
  plan.collapses.sort((a, b) => b.leaf.split(path.sep).length - a.leaf.split(path.sep).length);
  return plan;
}

// 계획 뒤에 구간에 다른 항목이 생겼으면 그 항목까지 빈 폴더와 함께 치우게 되므로 멈춘다.
function checkChain(item, access) {
  for (const [index, folder] of item.folders.entries()) {
    const real = access.delete(folder);
    if (real !== folder) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${folder} -> ${real}`);
    if (!fs.lstatSync(real).isDirectory()) throw new FcError(`계획 뒤에 폴더가 아니게 됐습니다: ${real}`);
    if (index === item.folders.length - 1) break;
    const inside = fs.readdirSync(real);
    if (inside.length !== 1 || inside[0] !== path.basename(item.folders[index + 1])) throw new FcError(`계획 뒤에 폴더 내용이 바뀌었습니다: ${real}`);
  }
}

// 앞서 한 이름 변경을 되돌린다. 되돌리지 못하면 항목이 어디에 있는지 알린다.
function restore(steps, cause) {
  for (const [from, to] of steps) {
    try {
      fs.renameSync(from, to);
    } catch (err) {
      throw new FcError(`접지 못했고 되돌리지도 못했습니다: ${from} -> ${to} (${cause.code}, ${err.code})`);
    }
  }
}

// 폴더 통째로 이름을 바꾸므로 안쪽 항목의 이름이 가운데 폴더 이름과 같아도 충돌하지 않는다.
// 맨 아래 폴더를 빼낸 뒤 비게 된 맨 위 폴더를 치우고, 그 이름으로 맨 아래 폴더를 옮긴다.
function collapseOne(item, access) {
  checkChain(item, access);
  const lifted = freshPath(item.top, '.fctl-new');
  const emptied = freshPath(item.top, '.fctl-old');
  fs.renameSync(item.leaf, lifted);
  try {
    fs.renameSync(item.top, emptied);
  } catch (err) {
    restore([[lifted, item.leaf]], err);
    throw err;
  }
  try {
    fs.renameSync(lifted, item.top);
  } catch (err) {
    restore([[emptied, item.top], [lifted, item.leaf]], err);
    throw err;
  }
  return emptied;
}

// 빈 폴더만 휴지통으로 보낸다. 파일이 있으면 지우지 않는다.
function removeEmptied(emptied) {
  const filled = fs.readdirSync(emptied, { recursive: true, withFileTypes: true }).find((entry) => !entry.isDirectory());
  if (filled) throw new FcError(`접었지만 치운 폴더에 파일이 있어 지우지 않았습니다: ${emptied}`);
  remove([emptied]);
}

function emptiedFailure(emptied, err) {
  if (err instanceof FcError && err.message.startsWith('접었지만')) return err.message;
  return `접었지만 빈 폴더를 휴지통으로 보내지 못했습니다: ${emptied} (${err instanceof FcError ? err.message : err.code ?? err.status})`;
}

// 폴더 하나만 이어지는 구간을 접는다. 덮어쓰지 않고, 한 구간이 실패해도 나머지는 계속한다.
// 돌려주는 값: { target, dryRun, collapsed, skipped, failed }. collapsed는 계획의 구간, failed는 { path, reason } 목록이다.
function collapse(dir, options = {}) {
  return applyCollapse(planCollapse(dir), options);
}

function applyCollapse(plan, { dryRun = false } = {}) {
  const result = { target: plan.target, dryRun, collapsed: [], skipped: plan.skipped, failed: [] };
  if (dryRun) return { ...result, collapsed: plan.collapses };
  const access = grant(plan.target, ['read', 'write', 'delete']);
  for (const item of plan.collapses) {
    let emptied;
    try {
      emptied = collapseOne(item, access);
      result.collapsed.push(item);
    } catch (err) {
      result.failed.push({ path: item.top, reason: err instanceof FcError ? err.message : `접지 못했습니다. (${err.code})` });
      continue;
    }
    try {
      removeEmptied(emptied);
    } catch (err) {
      result.failed.push({ path: item.top, reason: emptiedFailure(emptied, err) });
    }
  }
  return result;
}

function formatCollapse(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[미리보기] ' : '';
  const lines = [];
  for (const item of result.collapsed) lines.push(`${prefix}접기: ${relative(item.leaf)} -> ${relative(item.top)}`);
  for (const item of result.skipped) lines.push(`${prefix}건너뜀: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`실패: ${relative(item.path)} (${item.reason})`);
  lines.push(`${prefix}접기 ${result.collapsed.length}개, 건너뜀 ${result.skipped.length}개, 실패 ${result.failed.length}개`);
  return lines.join('\n');
}

module.exports = { planCollapse, applyCollapse, collapse, formatCollapse };
