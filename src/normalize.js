'use strict';

const { findProductNumberRanges } = require('./product');

const MAX_NAME = 255;
// 영숫자로만 된 짧은 꼬리와 겹 확장자만 확장자로 본다. 공백이나 하이픈이 든 꼬리(Title.v2 ABC-123)는 이름의 일부다.
const EXTENSION = /\.(?:tar\.(?:gz|bz2|xz|zst|lz|lzma|br|z)|[A-Za-z0-9]{1,8})$/i;
const SEPARATORS = '\\s._\\-–—－＿\\u0085';
// 번호를 지운 자리와 그 양옆의 구분 문자. 글자가 붙지 않게 공백 하나로 바꾼다.
const HOLE = '\0';
const AROUND_HOLE = new RegExp(`[${SEPARATORS}]*${HOLE}[${SEPARATORS}]*`, 'g');
const EDGE = new RegExp(`^[${SEPARATORS}]+|[${SEPARATORS}]+$`, 'g');
const TRAILING = new RegExp(`[${SEPARATORS}]+$`);
const BRACKETS = ['[]', '()', '{}', '（）', '［］', '｛｝', '【】', '「」', '『』', '《》', '〈〉'];
// Windows는 이름 끝의 점과 공백을 지운다.
const ENDS_BADLY = /[.\s\u0085]$/;
const NOT_A_NAME = /[\\/:*?"<>|\x00-\x1f]/;

const escape = (char) => `\\${char}`;

// 비게 된 괄호를 없애고 괄호 안쪽의 공백을 지운다. 겹괄호는 없어질 때까지 되풀이한다.
function tidyBrackets(text) {
  let current = text;
  for (const [open, close] of BRACKETS) {
    current = current.replace(new RegExp(`${escape(open)}\\s+`, 'g'), open).replace(new RegExp(`\\s+${escape(close)}`, 'g'), close);
  }
  const emptied = BRACKETS.reduce((value, pair) => value.split(pair).join(' '), current);
  return emptied === text ? emptied : tidyBrackets(emptied);
}

// 번호를 지우고 남은 말. 지운 자리 양옆의 구분 문자와 빈 괄호를 함께 지운다.
function remainder(base, ranges) {
  let rest = '';
  let at = 0;
  for (const { start, end } of ranges) {
    rest += base.slice(at, start) + HOLE;
    at = end;
  }
  rest += base.slice(at);
  return tidyBrackets(rest.replace(AROUND_HOLE, ' ')).replace(/\s+/g, ' ').replace(EDGE, '');
}

// 파일 이름을 정규화한 결과 { name, number, inferred, reason }을 돌려준다. 파일은 건드리지 않는 순수 함수다.
// - 제품번호를 대문자로 바꿔 맨 앞으로 옮기고, 나머지와 공백으로 구분한다. 영상 abc-123.mp4 -> ABC-123 영상.mp4
// - 맨 앞의 번호 바로 뒤가 점이면 그대로 둔다. ABC-123.en.srt는 영상과 짝을 이루는 자막 이름이고, ABC-123.7z.001은 분할 압축 조각이다.
// - 제품번호가 아닌 알파벳과 확장자의 대소문자는 바꾸지 않는다. 확장자와 이름의 일부를 확실히 가를 수 없어 말을 망가뜨리지 않기 위해서다.
// 어떤 번호를 옮길지 정할 수 없거나 바꾸면 안 되는 이름은 그대로 두고 reason에 사유를 적는다. 바꿀 수 있으면 reason은 null이다.
// number는 찾은 번호이고 없으면 null이다. 소문자 번호는 이름에 대문자 번호가 없을 때만 보고, 그때 inferred가 true다.
// 소문자 말(trip-2023)은 번호가 아닐 수 있으니 호출하는 쪽이 미리보기에서 구분해 보여 줄 수 있게 한다.
function normalizeName(fileName) {
  const unchanged = (reason, number = null) => ({ name: fileName, number, inferred: false, reason });
  // 점으로 시작하는 이름은 숨김 파일이고, 앞에 번호를 붙이면 숨김이 풀린다. ~$는 Office가 쓰는 잠금 파일이다.
  if (fileName.startsWith('.') || fileName.startsWith('~$')) return unchanged('숨김이나 임시 파일 이름은 바꾸지 않습니다.');
  if (NOT_A_NAME.test(fileName)) return unchanged('파일 이름에 쓸 수 없는 문자가 있습니다.');
  if (ENDS_BADLY.test(fileName)) return unchanged('끝이 점이나 공백인 이름은 바꾸지 않습니다.');
  const extension = EXTENSION.exec(fileName)?.[0] ?? '';
  const base = fileName.slice(0, fileName.length - extension.length);

  const upper = findProductNumberRanges(base);
  const ranges = upper.length > 0 ? upper : findProductNumberRanges(base, { lowercase: true });
  if (ranges.length === 0) return unchanged(null);
  const inferred = upper.length === 0;
  const numbers = new Set(ranges.map((range) => range.number));
  if (numbers.size > 1) return unchanged(`번호가 여럿이라 고르지 않습니다: ${[...numbers].join(', ')}`);

  const [{ number, start, end }] = ranges;
  const keepsDot = ranges.length === 1 && start === 0 && base[end] === '.';
  const rest = keepsDot ? base.slice(end).replace(TRAILING, '').replace(/^\.+/, '.') : remainder(base, ranges);
  const body = keepsDot || rest === '' ? `${number}${rest}` : `${number} ${rest}`;
  const name = `${body}${extension}`;
  if (name.length > MAX_NAME) return unchanged(`정규화하면 이름이 너무 깁니다: ${name.length}자`, number);
  return { name, number, inferred, reason: null };
}

module.exports = { normalizeName };
