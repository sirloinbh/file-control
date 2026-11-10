'use strict';

// 화면에 내보내는 모든 값은 이 파일의 escapeHtml을 거친다(#251). 경로·파일 이름에 <, &, 따옴표가 들어 있어도
// 태그나 속성으로 읽히지 않게 한다. 한글·이모지 같은 글자는 그대로 둔다(문서는 UTF-8).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// 이미 이스케이프했거나 코드가 직접 만든 HTML 조각. html``에 넣으면 다시 이스케이프하지 않는다.
class SafeHtml {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

// 믿을 수 있는 고정 HTML(코드에 적은 문자열)만 감싼다. 사용자 입력이나 파일 이름은 넣지 않는다.
function raw(text) {
  return new SafeHtml(String(text));
}

function render(value) {
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

// 태그 템플릿: 끼워 넣는 값은 모두 이스케이프하고(SafeHtml과 그 배열은 그대로), 결과는 SafeHtml이다.
// 예: html`<td>${file}</td>`
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new SafeHtml(out);
}

module.exports = { escapeHtml, html, raw, SafeHtml };
