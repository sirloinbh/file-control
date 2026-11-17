'use strict';

// The common screen frame and parts (#251). The server builds the HTML and sends it, and client JS is not used (#250).
// The CSS is put inside the document. Colors are set with :root variables and changed in the dark screen (prefers-color-scheme: dark).
// So that no horizontal scroll appears even in a narrow window, tables have a fixed width and long paths wrap anywhere.

const { html, raw } = require('./html');

// The command categories of the header menu. Each screen is built by later issues (#256 to #259). If the server has no such address, the menu shows "Coming soon".
const CATEGORIES = [
  { path: '/files', label: 'Basic file tasks', detail: 'View, create, rename, move, copy, send to the Recycle Bin' },
  { path: '/organize', label: 'Organize folders', detail: 'Flatten, collapse single-folder chains, add product numbers, normalize names' },
  { path: '/archive', label: 'Archives', detail: 'Compress, extract, extract all archives' },
  { path: '/cleanup', label: 'Find and delete', detail: 'Find and delete broken files, duplicate videos, and low-quality videos' },
];

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1f23; --muted: #5d636e; --border: #d9dbe0;
  --accent: #2f5bd3; --accent-text: #ffffff;
  --ok-bg: #e6f4ea; --ok-text: #1e6b34; --warn-bg: #fff4dc; --warn-text: #7a5300;
  --error-bg: #fde8e8; --error-text: #a12121; --info-bg: #e8effd; --info-text: #23439a;
  --skip-bg: #eceef2; --skip-text: #4a505b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171b; --surface: #1e2127; --text: #e6e8ec; --muted: #a0a6b1; --border: #343944;
    --accent: #7b9cf5; --accent-text: #10131a;
    --ok-bg: #173b24; --ok-text: #8fe0a8; --warn-bg: #3e3113; --warn-text: #f3cf7a;
    --error-bg: #461b1b; --error-text: #ffaaaa; --info-bg: #1c2a4d; --info-text: #a9c1ff;
    --skip-bg: #2a2e36; --skip-text: #c3c8d1;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 "Segoe UI", "Malgun Gothic", system-ui, sans-serif; overflow-wrap: anywhere; }
a { color: var(--accent); }
header { background: var(--surface); border-bottom: 1px solid var(--border); }
.bar { max-width: 1100px; margin: 0 auto; padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; }
.brand { font-weight: 700; text-decoration: none; color: var(--text); margin-right: 8px; }
nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
nav a, nav span { display: inline-block; padding: 4px 10px; border-radius: 6px; text-decoration: none; }
nav a[aria-current="page"] { background: var(--accent); color: var(--accent-text); }
nav span { color: var(--muted); }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 40px; }
h1 { font-size: 1.4rem; margin: 0 0 16px; }
h2 { font-size: 1.1rem; margin: 24px 0 10px; }
.alert { border-radius: 8px; padding: 10px 14px; margin: 0 0 12px; border: 1px solid transparent; }
.alert-success { background: var(--ok-bg); color: var(--ok-text); }
.alert-warning { background: var(--warn-bg); color: var(--warn-text); }
.alert-error { background: var(--error-bg); color: var(--error-text); }
.alert-info { background: var(--info-bg); color: var(--info-text); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 0 0 16px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; min-width: 0; }
.card .value { font-size: 1.5rem; font-weight: 700; }
.card .label { color: var(--muted); font-size: 0.9rem; }
.card-ok .value { color: var(--ok-text); } .card-warning .value { color: var(--warn-text); } .card-error .value { color: var(--error-text); }
table { width: 100%; table-layout: fixed; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
th, td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; word-break: break-word; }
th { font-weight: 600; color: var(--muted); font-size: 0.9rem; }
tr:last-child td { border-bottom: 0; }
.empty { color: var(--muted); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.85rem; white-space: nowrap; }
.badge-ok { background: var(--ok-bg); color: var(--ok-text); }
.badge-skip { background: var(--skip-bg); color: var(--skip-text); }
.badge-warning { background: var(--warn-bg); color: var(--warn-text); }
.badge-error { background: var(--error-bg); color: var(--error-text); }
.menu { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; padding: 0; list-style: none; }
.menu li { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.menu .detail { color: var(--muted); font-size: 0.9rem; margin: 4px 0 0; }
.muted { color: var(--muted); }
code { font-family: Consolas, "Cascadia Mono", monospace; }
pre.report { font-family: Consolas, "Cascadia Mono", monospace; font-size: 0.9rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0; }
`;

// An alert box. kind: success, warning, error, info
const ALERT_KINDS = new Set(['success', 'warning', 'error', 'info']);
function alertBox(kind, message) {
  if (!ALERT_KINDS.has(kind)) throw new Error(`Unknown alert kind: ${kind}`);
  const role = kind === 'error' || kind === 'warning' ? 'alert' : 'status';
  return html`<div class="alert alert-${kind}" role="${role}">${message}</div>`;
}

// Summary number cards. items: [{ label, value, tone? }], tone is one of ok, warning, error.
function summaryCards(items) {
  return html`<div class="cards">${items.map(({ label, value, tone }) => html`<div class="card${tone ? ` card-${tone}` : ''}"><div class="value">${value}</div><div class="label">${label}</div></div>`)}</div>`;
}

// A status badge. It separates the status of a command result by color.
const BADGES = {
  moved: ['ok', 'Moved'],
  done: ['ok', 'Done'],
  skipped: ['skip', 'Skipped'],
  kept: ['skip', 'Kept'],
  warning: ['warning', 'Check'],
  failed: ['error', 'Failed'],
};
function badge(status, text) {
  const [tone, label] = BADGES[status] ?? ['skip', status];
  return html`<span class="badge badge-${tone}">${text ?? label}</span>`;
}

// A table. columns: [{ label, width? }], rows: an array of arrays of cell values (strings are escaped, html`` and badge() are left as they are).
// width is a CSS width such as '40%'. Long paths wrap inside the cell.
function table(columns, rows, { empty = 'No items.' } = {}) {
  const head = html`<colgroup>${columns.map((column) => (column.width ? html`<col style="width: ${column.width}">` : html`<col>`))}</colgroup><thead><tr>${columns.map((column) => html`<th scope="col">${column.label}</th>`)}</tr></thead>`;
  const body = rows.length === 0
    ? html`<tr><td class="empty" colspan="${columns.length}">${empty}</td></tr>`
    : rows.map((cells) => html`<tr>${cells.map((cell) => html`<td>${cell}</td>`)}</tr>`);
  return html`<table>${head}<tbody>${body}</tbody></table>`;
}

// The whole document. current is the category path of the current screen, and available is the list of paths the server has (a category not there is "Coming soon").
// If refresh: { seconds, url? } is given, <meta http-equiv=refresh> reopens url (or the same address if none) after that time (#253 progress display).
function page({ title, current = null, alerts = [], body = '', available = new Set(), refresh = null }) {
  const nav = CATEGORIES.map((category) => {
    if (!available.has(category.path)) return html`<li><span title="Coming soon">${category.label}</span></li>`;
    return category.path === current
      ? html`<li><a href="${category.path}" aria-current="page">${category.label}</a></li>`
      : html`<li><a href="${category.path}">${category.label}</a></li>`;
  });
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? html`<meta http-equiv="refresh" content="${Math.max(0, Math.floor(refresh.seconds))}${refresh.url ? `; url=${refresh.url}` : ''}">\n` : ''}<title>${title} - fctl</title>
<style>${raw(CSS)}</style>
</head>
<body>
<header><div class="bar"><a class="brand" href="/">fctl</a><nav aria-label="Command categories"><ul>${nav}</ul></nav></div></header>
<main>
<h1>${title}</h1>
${alerts.map(({ kind, message }) => alertBox(kind, message))}
${body}
</main>
</body>
</html>
`.text;
}

module.exports = { CATEGORIES, page, alertBox, summaryCards, badge, table };
