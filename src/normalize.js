'use strict';

const { findProductNumberRanges } = require('./product');

const MAX_NAME = 255;
// It sees the whole run of alphanumeric dot groups as the tail and leaves it as it is. .en.srt, .7z.001, .tar.gz, and .mp4.part are not cut.
// A tail that contains a space or hyphen (Title.v2 ABC-123) is part of the name. It does not hide the number or change the case, so there is no loss even if misjudged.
const EXTENSION = /(?:\.[A-Za-z0-9]+)+$/;
const SEPARATORS = '\\s._\\-–—－＿\\u0085';
// The place where the number was removed and the separator characters on both sides of it. It is replaced with one space so that letters do not stick together.
const HOLE = '\0';
const AROUND_HOLE = new RegExp(`[${SEPARATORS}]*${HOLE}[${SEPARATORS}]*`, 'g');
const EDGE = new RegExp(`^[${SEPARATORS}]+|[${SEPARATORS}]+$`, 'g');
const TRAILING = new RegExp(`[${SEPARATORS}]+$`);
const BRACKETS = ['[]', '()', '{}', '（）', '［］', '｛｝', '【】', '「」', '『』', '《》', '〈〉', '〔〕', '〖〗'];
// Windows removes a trailing dot and space from a name.
const ENDS_BADLY = /[.\s\u0085]$/;
const NOT_A_NAME = /[\\/:*?"<>|\x00-\x1f]/;

const escape = (char) => `\\${char}`;

// It removes brackets that became empty and removes spaces inside brackets. Nested brackets are repeated until they are gone.
function tidyBrackets(text) {
  let current = text;
  for (const [open, close] of BRACKETS) {
    current = current.replace(new RegExp(`${escape(open)}\\s+`, 'g'), open).replace(new RegExp(`\\s+${escape(close)}`, 'g'), close);
  }
  const emptied = BRACKETS.reduce((value, pair) => value.split(pair).join(' '), current);
  return emptied === text ? emptied : tidyBrackets(emptied);
}

// What remains after removing the number. It also removes the separator characters on both sides of the removed place and empty brackets.
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

// It returns the result of normalizing a file name, { name, number, inferred, reason }. It is a pure function that does not touch files.
// - It changes the product number to upper case, moves it to the front, and separates it from the rest with a space. Video abc-123.mp4 -> ABC-123 Video.mp4
// - If a dot comes right after the number at the front, it is left as it is. ABC-123.en.srt is a subtitle name paired with a video, and ABC-123.7z.001 is a split archive piece.
// - It does not change the case of letters that are not the product number or of the extension. It cannot reliably tell the extension from part of the name, so as not to ruin words.
// A name where it cannot decide which number to move, or that must not be changed, is left as it is and the reason is written in reason. If it can be changed, reason is null.
// number is the number found, and if none, null. A lowercase number is looked at only when the name has no upper-case number, and then inferred is true.
// A lowercase word (trip-2023) may not be a number, so the caller can show it separately in the preview.
function normalizeName(fileName) {
  const unchanged = (reason, number = null, inferred = false) => ({ name: fileName, number, inferred, reason });
  // A file name cannot exceed 255 characters. It filters first so that the regular expression does not get slow on long input or the bracket repetition does not get deep.
  if (fileName.length > MAX_NAME) return unchanged('The file name is too long.');
  // A name that starts with a dot is a hidden file, and putting a number in front would lift the hiding. A name that starts with ~ is an Office lock file (~$) or
  // a temporary file (~WRL0001.tmp, ~abc-123.mp4). The program that made it looks for it by that name, so it is not changed (#94).
  if (fileName.startsWith('.') || fileName.startsWith('~')) return unchanged('Hidden and temporary file names are not changed.');
  if (NOT_A_NAME.test(fileName)) return unchanged('The file name contains characters that cannot be used.');
  if (ENDS_BADLY.test(fileName)) return unchanged('Names ending with a dot or space are not changed.');
  const extension = EXTENSION.exec(fileName)?.[0] ?? '';
  const base = fileName.slice(0, fileName.length - extension.length);

  const upper = findProductNumberRanges(base);
  const ranges = upper.length > 0 ? upper : findProductNumberRanges(base, { lowercase: true });
  if (ranges.length === 0) return unchanged(null);
  const inferred = upper.length === 0;
  const numbers = new Set(ranges.map((range) => range.number));
  if (numbers.size > 1) return unchanged(`Several numbers, so none is chosen: ${[...numbers].join(', ')}`);

  const [{ number, start, end }] = ranges;
  const keepsDot = ranges.length === 1 && start === 0 && base[end] === '.';
  const rest = keepsDot ? base.slice(end).replace(TRAILING, '').replace(/^\.+/, '.') : remainder(base, ranges);
  const body = keepsDot || rest === '' ? `${number}${rest}` : `${number} ${rest}`;
  const name = `${body}${extension}`;
  if (name.length > MAX_NAME) return unchanged(`The name is too long once normalized: ${name.length} characters`, number, inferred);
  // It also tidies what the first run did not tidy, such as the separator before a tail that newly appeared in the result. The name shrinks or stays the same, so it ends.
  return { name: name === fileName ? name : normalizeName(name).name, number, inferred, reason: null };
}

module.exports = { normalizeName };
