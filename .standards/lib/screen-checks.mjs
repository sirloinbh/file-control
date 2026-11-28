// Managed file. Edit it in sirloinbh/project-standards scripts/lib/
// The screen checks every app runs through .standards/check.mjs: text under 12px and Korean screen text (#1127, #1129).
// Source of truth: sirloinbh/design-system, delivery/standards/screen-checks.mjs (#1169). Sync copies the pinned release's file into
// each repository as .standards/lib/screen-checks.mjs; until the first release is pinned, this copy is delivered instead.
// Node built-ins only, and no Hangul characters in this file (the Hangul range is written as escapes).

/** Text under 12px in a frontend source: `text-[10px]`, `fontSize: 11`, `fontSize="10"`, `font-size: 0.7rem` (#1127). */
export const MIN_FONT_PX = 12;
export function smallTextFindings(file, text) {
  const found = [];
  const px = (value, unit) =>
    unit === 'rem' || unit === 'em' ? Number(value) * 16 : Number(value);
  const patterns = [
    /\btext-\[(\d*\.?\d+)(px|rem|em)\]/g,
    /\bfont-size:\s*(\d*\.?\d+)(px|rem|em)\b/g,
    /\bfontSize\s*[:=]\s*\{?\s*['"]?(\d*\.?\d+)(px|rem|em)?['"]?/g,
  ];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const pattern of patterns) {
      for (const m of line.matchAll(pattern)) {
        if (px(m[1], m[2]) < MIN_FONT_PX) found.push(`${file}:${i + 1} ${m[0]}`);
      }
    }
  });
  return found;
}

/** One message for all small text in the frontend sources; the 12px floor is in docs/design-tokens.md (#1127). */
export function checkMinFontSize(sources) {
  const found = sources
    .filter(({ file }) => /\.(tsx|ts|css)$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file))
    .flatMap(({ file, text }) => smallTextFindings(file, text));
  if (!found.length) return [];
  const shown = found.slice(0, 5).join(', ');
  return [
    `frontend/src: text under ${MIN_FONT_PX}px (docs/design-tokens.md). ${found.length} found: ${shown}${found.length > 5 ? ' and more' : ''}`,
  ];
}

const HANGUL = /[\uAC00-\uD7A3]/;
export const SCREEN_TEXT_FILE = /\.(tsx|ts|jsx|js|html)$/;
const NOT_SCREEN_TEXT =
  /\.(test|spec|stories)\.[jt]sx?$|(^|\/)(test|tests|__tests__|__mocks__|fixtures|e2e)\//;

/** The lines of a source file with comments removed, so only code, strings and JSX text are left. */
function codeLines(text) {
  let inBlock = false;
  return text.split(/\r?\n/).map((raw) => {
    let line = '';
    for (let i = 0; i < raw.length; i += 1) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end < 0) break;
        inBlock = false;
        i = end + 1;
      } else if (raw.startsWith('/*', i)) {
        inBlock = true;
        i += 1;
      } else if (raw.startsWith('//', i) && raw[i - 1] !== ':') break;
      else line += raw[i];
    }
    return line;
  });
}

/**
 * Korean (Hangul) in a frontend source outside comments, which is screen text (#1129, user requirement 2026-11-26: no Korean
 * on any screen). Tests, fixtures and e2e files stay allowed because they hold user-data samples. Code that must recognize
 * Korean input (a CSV header, a label parser) says so with `korean-ok: <reason>` on the line or the line above, or
 * `korean-ok-file: <reason>` anywhere in the file. Returns `file:line` entries.
 */
export function koreanScreenTextFindings(file, text) {
  if (!SCREEN_TEXT_FILE.test(file) || NOT_SCREEN_TEXT.test(file) || text.includes('korean-ok-file'))
    return [];
  const raw = text.split(/\r?\n/);
  return codeLines(text).flatMap((line, i) => {
    if (!HANGUL.test(line)) return [];
    // A line is allowed when it, or the line above, says why it must stay Korean (it recognizes Korean input).
    return raw[i].includes('korean-ok') || (i > 0 && raw[i - 1].includes('korean-ok'))
      ? []
      : [`${file}:${i + 1}`];
  });
}

/** One message for all Korean screen text in the frontend sources. A problem, not a warning (#1129). */
export function checkKoreanScreenText(sources) {
  const found = sources.flatMap(({ file, text }) => koreanScreenTextFindings(file, text));
  if (!found.length) return [];
  const shown = found.slice(0, 5).join(', ');
  return [
    `frontend/src: Korean screen text. Screens are English only. ${found.length} found: ${shown}${found.length > 5 ? ' and more' : ''}`,
  ];
}
