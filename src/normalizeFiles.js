'use strict';

const fs = require('node:fs');
const path = require('node:path');
const commands = require('./commands');
const { FcError, freshPath } = commands;
const { grant, walk } = require('./target');
const { normalizeName } = require('./normalize');
const { LEFTOVER, SYSTEM_FOLDER, PROGRAM_FOLDER, PROJECT_FILE, moveWithoutOverwrite, leftoverNote, rejectRepository, looksLikeGitDir } = require('./flatten');
const { DOWNLOAD_MARKER, markerFinder } = require('./downloadMarker');

// NTFS는 대소문자를 구분하지 않으므로 이름을 대문자로 비교한다. toLowerCase는 NTFS에서 같은 이름인 ΑΣ와 ασ를 다르게 만든다.
const nameKey = (p) => p.toUpperCase();

function skipReason(entry) {
  const parts = entry.relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return '이전 작업의 잔여물이라 바꾸지 않습니다.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Windows 시스템 폴더 안의 파일이라 바꾸지 않습니다.';
  return null;
}

// 저장한 웹 페이지(페이지.html)와 그 그림·스크립트를 담은 폴더(페이지_files). 페이지가 폴더 이름으로 안의 파일을 찾는다.
const WEB_PAGE = /^(.+)\.(?:html?|xhtml|shtml)$/i;

// 받는 중인 파일인지 본다(#94). 받기 도구의 꼬리가 붙은 이름(x.mp4.crdownload)과, 그런 표시 파일이 옆에 있거나
// Safari 표시 폴더(x.mp4.download) 안에 있는 파일이다. 이름이 바뀌면 받기 도구가 파일을 찾지 못한다.
function downloadReason(entry, findMarker) {
  const name = path.basename(entry.path);
  const own = DOWNLOAD_MARKER.exec(name);
  if (own) return `받는 중인 파일의 이름(${name.slice(own[1].length)})이라 바꾸지 않습니다.`;
  const found = findMarker(entry.path);
  if (found === null) return null;
  if (found.folder !== undefined) return `받기 도구의 표시 폴더(${found.folder}) 안에 있어 받는 중일 수 있어 바꾸지 않습니다.`;
  if (found.error !== undefined) return `받기 도구의 표시 파일을 확인하려고 폴더를 읽지 못해 바꾸지 않습니다. (${found.error})`;
  return `받기 도구의 표시 파일(${found.marker})이 옆에 있어 받는 중일 수 있어 바꾸지 않습니다.`;
}

// 안의 파일 이름을 바꾸지 않을 폴더를 { guarded: { 상대경로 -> 사유 }, pages: { 웹 페이지 상대경로 -> 자료 폴더 이름 }, dirs }로 돌려준다(#94). flatten의 #65 정책과 같게 프로그램 폴더(node_modules 등),
// 프로젝트 표시 파일(package.json 등)이 든 폴더, 실행 파일과 DLL이 함께 든 폴더, 숨김 속성 폴더를 남긴다. 프로그램이 이름으로 파일을 찾기 때문이다.
// 저장한 웹 페이지의 _files 폴더도 남긴다. 타겟 자신이 이런 폴더면 모든 파일이 그 일부라 거부한다.
// 숨김 속성 폴더는 PowerShell을 불러야 알 수 있어 바뀔 파일이 있을 때 addHiddenFolders로 따로 더한다(1차 리뷰).
function guardedFolders(target, entries) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (PROGRAM_FOLDER.test(path.basename(dir))) throw new FcError(`프로그램 폴더 안이라 다루지 않습니다: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  const guarded = new Map();
  const add = (relative, reason) => {
    if (!guarded.has(relative)) guarded.set(relative, reason);
  };
  const dirs = new Map(entries.filter((entry) => entry.type === 'dir').map((entry) => [nameKey(entry.relative), entry.relative]));
  const pages = new Map();
  const programs = new Map();
  for (const entry of entries) {
    const name = path.basename(entry.relative);
    const parent = path.dirname(entry.relative);
    if (entry.type === 'dir') {
      if (PROGRAM_FOLDER.test(name)) add(entry.relative, `프로그램 폴더(${name})`);
      continue;
    }
    if (entry.type !== 'file') continue;
    if (PROJECT_FILE.test(name)) {
      if (parent === '.') throw new FcError(`타겟이 프로젝트 폴더로 보여(${name} 있음) 다루지 않습니다. 그 아래 폴더를 타겟으로 고르세요: ${target}`);
      add(parent, `프로젝트 폴더(${name} 있음)`);
    }
    const page = WEB_PAGE.exec(name);
    const files = page && dirs.get(nameKey(path.join(parent, `${page[1]}_files`)));
    if (files) {
      add(files, `웹 페이지(${name})의 자료 폴더`);
      pages.set(entry.relative, path.basename(files));
    }
    const ext = path.extname(name).toLowerCase();
    if (ext === '.exe' || ext === '.dll') programs.set(parent, new Set([...(programs.get(parent) ?? []), ext]));
  }
  for (const [parent, kinds] of programs) {
    if (kinds.size < 2) continue;
    if (parent === '.') throw new FcError(`타겟에 실행 파일과 DLL이 함께 있어 프로그램 폴더로 보고 다루지 않습니다. 그 아래 폴더를 타겟으로 고르세요: ${target}`);
    add(parent, '실행 파일과 DLL이 함께 든 프로그램 폴더');
  }
  return { guarded, pages, dirs };
}

// 숨김 속성 폴더를 guarded에 더한다. 남길 폴더 안은 어차피 바꾸지 않으므로 보지 않는다.
function addHiddenFolders(target, { guarded, dirs }) {
  const inside = (relative) => [...guarded.keys()].some((dir) => relative === dir || relative.startsWith(dir + path.sep));
  const folders = [''].concat([...dirs.values()].filter((relative) => !inside(relative)));
  // 시험에서 바꿔 끼울 수 있게 모듈을 거쳐 부른다.
  for (const [relative, bits] of commands.hiddenOrSystemEntries(target, folders)) {
    const folder = dirs.get(nameKey(relative));
    if (bits & 2 && folder !== undefined && !guarded.has(folder)) guarded.set(folder, '숨김 속성 폴더');
  }
}

// 상대경로가 남길 폴더 안이면 가장 바깥의 그 폴더를 돌려준다.
function guardOf(relative, guarded) {
  const parts = relative.split(path.sep);
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join(path.sep);
    if (guarded.has(dir)) return dir;
  }
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
  if (bare) throw new FcError(`저장소가 들어 있어 다루지 않습니다: ${bare.path}`);
  const existing = new Set(entries.map((entry) => nameKey(entry.path)));
  const guards = guardedFolders(access.target, entries);
  const { guarded, pages } = guards;
  let hiddenChecked = false;
  // 남길 폴더는 안에 이름이 바뀔 파일이 있을 때만 한 번 알린다. node_modules의 파일마다 알리면 목록이 묻힌다.
  const reportedGuards = new Set();
  const findMarker = markerFinder();
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
    const changes = result.reason === null && result.name !== path.basename(entry.path);
    let guard = guardOf(entry.relative, guarded);
    if (guard === null && changes && !hiddenChecked) {
      hiddenChecked = true;
      addHiddenFolders(access.target, guards);
      guard = guardOf(entry.relative, guarded);
    }
    if (guard !== null) {
      if (changes && !reportedGuards.has(guard)) {
        reportedGuards.add(guard);
        plan.skipped.push({ path: path.join(access.target, guard), reason: `${guarded.get(guard)}라 안의 파일 이름을 바꾸지 않습니다.` });
      }
      continue;
    }
    const pageFiles = pages.get(entry.relative);
    if (changes && pageFiles !== undefined) {
      plan.skipped.push({ path: entry.path, reason: `자료 폴더(${pageFiles})와 이름으로 이어진 웹 페이지라 바꾸지 않습니다.` });
      continue;
    }
    const downloading = changes ? downloadReason(entry, findMarker) : null;
    if (downloading !== null) {
      plan.skipped.push({ path: entry.path, reason: downloading });
      continue;
    }
    if (result.reason !== null) {
      // 숨김, 임시, 끝이 점이나 공백인 이름까지 보고하면 목록이 묻힌다. 번호가 여럿이거나 이름이 너무 길어지는 경우만 알린다.
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
      // 이전 실행이 중간에 멈춘 흔적(같은 파일의 다른 이름, 빈 파일)이면 그 사실을 덧붙인다(#73).
      conflict(`같은 이름이 이미 있습니다.${leftoverNote(entry.path, to)}`);
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
  const taken = () => new FcError(`같은 이름이 이미 있어 바꾸지 않습니다: ${rename.name}${leftoverNote(from, rename.to)}`);
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
