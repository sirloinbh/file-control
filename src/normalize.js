'use strict';

const path = require('node:path');
const { findProductNumberRanges } = require('./product');

const MAX_NAME = 255;
// 번호를 빼고 남은 이름의 앞뒤에 남으면 안 되는 구분 문자. Windows는 이름 끝의 점과 공백을 지우므로 끝에 남기지 않는다.
const EDGE = /^[\s._\-–—]+|[\s._\-–—]+$/g;
// 번호만 들어 있던 빈 괄호
const EMPTY_BRACKETS = /[[(（【「『{]\s*[\])）】」』}]/g;

// 파일 이름을 정규화한 결과 { name, number, reason }을 돌려준다. 파일은 건드리지 않는 순수 함수다.
// - 제품번호를 대문자로 바꿔 맨 앞으로 옮기고, 나머지와 공백으로 구분한다. 영상 abc-123.mp4 -> ABC-123 영상.mp4
// - 제품번호가 아닌 알파벳은 옮기거나 대문자로 바꾸지 않는다. 영화 제목 같은 말을 망가뜨리지 않기 위해서다.
// - 확장자는 소문자로 통일한다. 마지막 점 뒤를 확장자로 보고, .tar.gz 같은 겹 확장자는 한 덩어리로 본다.
// 어떤 번호를 앞으로 옮길지 정할 수 없거나 바꾸면 안 되는 이름은 그대로 두고 reason에 사유를 적는다. 바꾸면 reason은 null이다.
// number는 찾은 번호이고 없으면 null이다. 소문자 번호는 파일 이름에 대문자 번호가 없을 때만 본다.
function normalizeName(fileName) {
  // 점으로 시작하는 이름은 숨김 파일이고, 앞에 번호를 붙이면 숨김이 풀린다.
  if (fileName.startsWith('.')) return { name: fileName, number: null, reason: '점으로 시작하는 이름은 바꾸지 않습니다.' };
  const ext = /\.tar\.[^.]+$/i.exec(fileName)?.[0] ?? path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const extension = ext.toLowerCase();

  const upper = findProductNumberRanges(base);
  const ranges = upper.length > 0 ? upper : findProductNumberRanges(base, { lowercase: true });
  if (ranges.length === 0) return { name: `${base}${extension}`, number: null, reason: null };
  const numbers = new Set(ranges.map((range) => range.number));
  if (numbers.size > 1) return { name: fileName, number: null, reason: `번호가 여럿이라 고르지 않습니다: ${[...numbers].join(', ')}` };

  // 지운 자리는 공백으로 채워 양쪽 글자가 붙지 않게 한다.
  let rest = '';
  let at = 0;
  for (const { start, end } of ranges) {
    rest += `${base.slice(at, start)} `;
    at = end;
  }
  rest += base.slice(at);
  rest = rest.replace(EMPTY_BRACKETS, ' ').replace(/\s+/g, ' ').replace(EDGE, '');
  const [{ number }] = ranges;
  const name = `${rest === '' ? number : `${number} ${rest}`}${extension}`;
  if (name.length > MAX_NAME) return { name: fileName, number, reason: `정규화하면 이름이 너무 깁니다: ${name.length}자` };
  return { name, number, reason: null };
}

module.exports = { normalizeName };
