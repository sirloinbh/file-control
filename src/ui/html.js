'use strict';

// Every value sent to the screen goes through escapeHtml of this file (#251). Even if a path or file name contains <, &, or a quote,
// it is not read as a tag or an attribute. Letters such as Hangul and emoji are left as they are (the document is UTF-8).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// An HTML fragment that was already escaped or that the code built itself. Putting it in html`` does not escape it again.
class SafeHtml {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

// It wraps only trusted fixed HTML (strings written in the code). Do not put user input or file names in it.
function raw(text) {
  return new SafeHtml(String(text));
}

function render(value) {
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

// Tag template: every inserted value is escaped (SafeHtml and arrays of it are left as they are), and the result is SafeHtml.
// Example: html`<td>${file}</td>`
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new SafeHtml(out);
}

module.exports = { escapeHtml, html, raw, SafeHtml };
