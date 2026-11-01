'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, unzip, archiveEntries, freshPath } = require('./commands');
const { grant, walk, rejectAmbiguousNames } = require('./target');
const { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');

// tar.exe로 읽는 형식. 겹 확장자를 먼저 본다.
const ARCHIVE = /\.(?:tar\.gz|tar\.bz2|tar\.xz|zip|tar|tgz|tbz2|txz|7z|rar)$/i;

// 압축 파일 이름에서 확장자를 뺀 폴더 이름. 압축 파일이 아니면 null이다.
function folderName(name) {
  const match = ARCHIVE.exec(name);
  if (!match || match.index === 0) return null;
  return name.slice(0, match.index);
}

// 타겟 아래 압축 파일마다 풀 새 폴더를 정한다. 파일은 건드리지 않는다.
// 이미 있는 폴더와 합치지 않는다. 다시 실행해도 같은 내용을 또 풀지 않게 번호를 붙이지 않고 건너뛴다.
// - extractions: 풀 압축 파일 ({ archive, dest, name })
// - skipped: 다루지 않는 항목 ({ path, reason })
function planExtractions(dir) {
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, extractions: [], skipped: [] };
  const planned = new Set();
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const skip = (reason) => plan.skipped.push({ path: entry.path, reason });
    if (entry.type === 'link') {
      skip('링크는 풀지 않습니다.');
      continue;
    }
    const name = folderName(path.basename(entry.path));
    if (name === null) continue;
    const parts = entry.relative.split(path.sep);
    try {
      if (parts.some((part) => LEFTOVER.test(part))) throw new FcError('이전 작업의 잔여물이라 풀지 않습니다.');
      if (parts.some((part) => SYSTEM_FOLDER.test(part))) throw new FcError('Windows 시스템 폴더 안의 파일이라 풀지 않습니다.');
      if (parts.some((part) => REPOSITORY_FOLDER.test(part))) throw new FcError('저장소 폴더 안의 파일이라 풀지 않습니다.');
      if (name.length > MAX_NAME) throw new FcError(`폴더 이름이 너무 깁니다: ${name}`);
      const archive = access.read(entry.path);
      const dest = path.join(path.dirname(archive), name);
      const key = dest.toLowerCase();
      if (planned.has(key) || fs.lstatSync(dest, { throwIfNoEntry: false })) throw new FcError(`같은 이름이 이미 있어 풀지 않습니다: ${name}`);
      planned.add(key);
      plan.extractions.push({ archive, dest: access.write(dest), name });
    } catch (err) {
      if (err instanceof FcError) skip(err.message);
      else if (err.syscall) skip(`파일을 확인할 수 없습니다. (${err.code})`);
      else throw err;
    }
  }
  return plan;
}

// 목록과 실제 결과가 다르면 일부를 잃은 것이다. tar.exe는 대소문자만 다른 항목을 오류 없이 덮어쓴다.
// 쓸 수 없는 이름(con.txt, 끝이 점)이나 링크가 나오면 지우기도 어려우므로 결과로 내놓지 않는다.
function checkExtracted(temp, fileCount) {
  let files = 0;
  for (const entry of fs.readdirSync(temp, { recursive: true, withFileTypes: true })) {
    const relative = path.relative(temp, path.join(entry.parentPath, entry.name));
    rejectAmbiguousNames(relative, relative);
    if (entry.isSymbolicLink()) throw new FcError(`압축 파일에 링크가 들어 있습니다: ${relative}`);
    if (entry.isFile()) files += 1;
  }
  if (files !== fileCount) throw new FcError(`압축 파일 목록과 풀린 결과가 다릅니다. 이름이 겹치는 항목이 있을 수 있습니다. (목록 ${fileCount}개, 결과 ${files}개)`);
}

function removeTemp(temp, cause) {
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch (err) {
    throw new FcError(`${cause.message} 임시 폴더를 지우지 못했습니다: ${temp} (${err.code})`);
  }
}

// 임시 폴더에 다 푼 뒤에 이름을 바꾼다. 실패해도 일부만 풀린 폴더가 결과처럼 남지 않는다.
function extractOne(item, access) {
  const archive = access.read(item.archive);
  if (archive !== item.archive) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${item.archive} -> ${archive}`);
  if (!fs.lstatSync(archive).isFile()) throw new FcError(`계획 뒤에 파일이 아니게 됐습니다: ${archive}`);
  if (fs.lstatSync(item.dest, { throwIfNoEntry: false })) throw new FcError(`같은 이름이 이미 있어 풀지 않습니다: ${item.name}`);
  const dest = access.write(item.dest);
  if (dest !== item.dest) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${item.dest} -> ${dest}`);
  const entries = archiveEntries(archive);
  const temp = freshPath(archive, '.fctl-new');
  try {
    unzip(archive, temp);
    checkExtracted(temp, entries.filter((entry) => !entry.endsWith('/')).length);
    // 윈도우에서 폴더 이름 변경은 이미 있는 대상을 덮어쓰지 않고 실패한다.
    fs.renameSync(temp, dest);
  } catch (err) {
    removeTemp(temp, err instanceof FcError ? err : new FcError(failureReason(err)));
    throw err;
  }
  return entries.length;
}

function failureReason(err) {
  if (err instanceof FcError) return err.message;
  // tar.exe의 오류는 코드페이지로 나와 한글이 깨지므로 종료 코드만 쓴다.
  if (err.status !== undefined && err.status !== null) return `압축을 풀지 못했습니다. 손상됐거나 암호가 걸렸거나 타겟 밖을 가리키는 경로가 있을 수 있습니다. (tar 종료 코드 ${err.status})`;
  return `압축을 풀지 못했습니다. (${err.code})`;
}

// 타겟 아래 압축 파일을 각각 새 폴더에 푼다. 압축 파일은 지우지 않고, 풀려 나온 압축 파일을 다시 풀지도 않는다.
// 돌려주는 값: { target, dryRun, extracted, skipped, failed }. extracted는 { archive, dest, name, entries } 목록이고 failed는 { archive, reason } 목록이다.
function extractArchives(dir, { dryRun = false } = {}) {
  return applyExtractions(planExtractions(dir), { dryRun });
}

function applyExtractions(plan, { dryRun = false } = {}) {
  const result = { target: plan.target, dryRun, extracted: [], skipped: plan.skipped, failed: [] };
  const access = grant(plan.target, ['read', 'write']);
  for (const item of plan.extractions) {
    try {
      const entries = dryRun ? archiveEntries(item.archive).length : extractOne(item, access);
      result.extracted.push({ ...item, entries });
    } catch (err) {
      result.failed.push({ archive: item.archive, reason: failureReason(err) });
    }
  }
  return result;
}

function formatExtractions(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[미리보기] ' : '';
  const lines = [];
  for (const item of result.extracted) lines.push(`${prefix}압축 해제: ${relative(item.archive)} -> ${relative(item.dest)} (항목 ${item.entries}개)`);
  for (const item of result.skipped) lines.push(`${prefix}건너뜀: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`실패: ${relative(item.archive)} (${item.reason})`);
  lines.push(`${prefix}압축 해제 ${result.extracted.length}개, 건너뜀 ${result.skipped.length}개, 실패 ${result.failed.length}개`);
  return lines.join('\n');
}

module.exports = { planExtractions, applyExtractions, extractArchives, formatExtractions };
