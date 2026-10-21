'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');

// 타겟 디렉토리를 실제 절대경로로 정규화한다. 없거나 폴더가 아니면 오류를 낸다.
function resolveTarget(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new FcError('타겟 폴더를 지정하세요.');
  const abs = path.resolve(dir);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new FcError(`타겟 폴더가 없습니다: ${abs}`);
  if (!stat.isDirectory()) throw new FcError(`타겟이 폴더가 아닙니다: ${abs}`);
  // 대소문자·8.3 짧은 이름·드라이브 문자 표기를 실제 경로 하나로 맞춘다.
  return fs.realpathSync.native(abs);
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

module.exports = { resolveTarget, isInside, resolveInside };
