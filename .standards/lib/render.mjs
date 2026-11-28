// Renders central templates for one target repository: fills {{variables}}, adds the
// "managed file" header, and keeps the project-owned section of section-managed files.
import path from 'node:path';

export const PROJECT_MARKER = '# --- project ---';
// The header every synced file gets. It is ASCII because Windows PowerShell 5.1 reads a BOM-less .ps1
// as the system ANSI code page; since #455 every file uses it.
export const HEADER_TEXT = 'Managed file. Edit it in sirloinbh/project-standards';
// Kept as an alias for older imports.
export const HEADER_TEXT_ASCII = HEADER_TEXT;
// Files synced before #455 carry this Korean header. It is still recognized.
export const LEGACY_HEADER_TEXT = '중앙 관리 파일. 수정은 sirloinbh/project-standards의';

/** True when the text already carries the managed header in either form. */
export function hasHeader(text) {
  return text.includes(HEADER_TEXT) || text.includes(LEGACY_HEADER_TEXT);
}

// `${{ ... }}` is GitHub Actions syntax, so a `$` right before `{{` keeps it literal.
// `@` and `/` let a key be an npm package name, e.g. {{versions.packages.@sirloinbh/tsconfig}}.
const VARIABLE = /(?<!\$)\{\{\s*([A-Za-z0-9_.@/-]+)\s*\}\}/g;

function lookup(vars, dotted) {
  return dotted.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), vars);
}

/** Replaces {{a.b}} with values from `vars`. Throws if any variable is missing or not a scalar. */
export function renderText(text, vars, file = '(template)') {
  const missing = new Set();
  const out = text.replace(VARIABLE, (match, name) => {
    const value = lookup(vars, name);
    if (value === undefined || value === null || typeof value === 'object') {
      missing.add(name);
      return match;
    }
    return String(value);
  });
  if (missing.size) throw new Error(`${file}: undefined template variable(s): ${[...missing].join(', ')}`);
  return out;
}

const HASH_STYLE = new Set(['.editorconfig', '.gitattributes', '.gitignore', '.prettierignore', '.npmrc', '.env.example', '.dockerignore', 'Dockerfile']);
const HASH_EXT = new Set(['.yml', '.yaml', '.sh', '.ps1', '.conf', '.toml', '.service', '.timer']);
const SLASH_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

/** Comment style for the managed header, or null when the format has no comments (JSON, .nvmrc). */
export function commentStyle(file) {
  const base = path.posix.basename(file);
  const ext = path.posix.extname(file);
  if (HASH_STYLE.has(base) || HASH_EXT.has(ext)) return 'hash';
  if (SLASH_EXT.has(ext)) return 'slash';
  if (ext === '.md' || ext === '.html') return 'html';
  if (ext === '.css') return 'css';
  return null;
}

/** Header line pointing back to the template source, e.g. templates/common/.editorconfig. */
export function headerLine(file, source) {
  const dir = path.posix.dirname(source);
  const text = `${HEADER_TEXT} ${dir}/`;
  switch (commentStyle(file)) {
    case 'hash': return `# ${text}`;
    case 'slash': return `// ${text}`;
    case 'html': return `<!-- ${text} -->`;
    case 'css': return `/* ${text} */`;
    default: return null;
  }
}

// Lines that must stay first: shebangs, Dockerfile parser directives, Markdown frontmatter.
function leadingLines(file, lines) {
  if (lines[0]?.startsWith('#!')) return 1;
  if (path.posix.basename(file) === 'Dockerfile') {
    let n = 0;
    while (n < lines.length && /^#\s*(syntax|escape|check)=/i.test(lines[n])) n++;
    return n;
  }
  if (path.posix.extname(file) === '.md' && lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) return end + 1;
  }
  return 0;
}

/** Adds the managed header unless the format has no comments or the header is already there. */
export function addHeader(text, file, source) {
  const header = headerLine(file, source);
  if (!header || hasHeader(text)) return text;
  const lines = text.split('\n');
  const at = leadingLines(file, lines);
  // Keep a blank line between Markdown frontmatter and the header comment.
  const isMarkdown = path.posix.extname(file) === '.md';
  const insert = at > 0 && isMarkdown ? ['', header] : [header];
  // The apps run `prettier --check` on the delivered UI kit (not on the other managed files), and Prettier wants a blank
  // line between a leading comment and the first Markdown block (#1219).
  if (isMarkdown && source.startsWith('templates/ui/') && lines[at]?.trim()) insert.push('');
  lines.splice(at, 0, ...insert);
  return lines.join('\n');
}

/**
 * For section-managed files (.gitignore, .env.example ...): the rendered template is the
 * central part and must end with PROJECT_MARKER; the target's lines after the marker are kept.
 */
export function mergeSection(rendered, existing, file) {
  const central = rendered.replace(/\s*$/, '');
  if (!central.endsWith(PROJECT_MARKER)) throw new Error(`${file}: section template must end with "${PROJECT_MARKER}"`);
  const normalized = (existing ?? '').replace(/\r\n/g, '\n');
  const at = normalized.lastIndexOf(`${PROJECT_MARKER}\n`);
  let project;
  if (at >= 0) project = normalized.slice(at + PROJECT_MARKER.length + 1);
  else {
    // First sync of a file without the marker: keep the project's own lines (those the central part
    // does not already have) below the marker instead of dropping them.
    const centralLines = new Set(central.split('\n').map((l) => l.trim()));
    project = normalized.split('\n').filter((l) => l.trim() && !centralLines.has(l.trim())).join('\n');
  }
  return `${central}\n${project}`.replace(/\n*$/, '\n');
}

/**
 * Renders one template file for a target.
 * mode: "full" (whole file managed) or "section" (central part + project part).
 */
export function renderFile({ text, file, source, vars, mode = 'full', existing = null }) {
  // Work in LF; the target's .gitattributes decides line endings on checkout (e.g. *.ps1 CRLF).
  const lf = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const filled = addHeader(renderText(lf, vars, source), file, source);
  return mode === 'section' ? mergeSection(filled, existing, file) : filled;
}
