'use strict';

// The product number format: 2 to 6 English letters, a hyphen, 2 to 5 digits (ABC-123).
// If alphanumerics continue before or after (1ABC-123, ABC-123A), if there is an English word and a hyphen in front (summer-trip-20), or
// if more digit groups continue after (PIC-2024-05-01, CVE-2024-1234, ABC-123-01), it is not a product number.
// A quality tail (ABC-123-1080p, -60fps, -10bit) is not seen as a digit group.
// The boundary "English" is all Latin letters and the combining marks after them. It does not catch the middle of a word such as Pokémon-12 or naïve-12 (even where é is written as e plus a combining mark) as a number.
// Hangul, Chinese characters, and kana are not seen as boundaries, so the number in "영상ABC-123" ("video ABC-123") is found. A combining mark after kana (the ド of NFD ガイド = ト + U+3099) is not a boundary either.
const CANDIDATE = /(?<![\p{Script=Latin}0-9]\p{M}*)(?<!\p{Script=Latin}\p{M}*-)[A-Za-z]{2,6}-\d{2,5}(?![\p{Script=Latin}\p{M}0-9]|-\d{2}(?!\d*(?:[pPiI]|[fF][pP][sS]|[bB][iI][tT])(?![\p{Script=Latin}\p{M}0-9])))/gu;

// Words that fit the format but are not product numbers. Reporting that none was found is safer than wrongly finding one and renaming the file, so it is set broadly.
const NOT_PRODUCT = new Set([
  // Order and bundle
  'PART', 'PARTS', 'DISC', 'DISK', 'CD', 'DVD', 'BD', 'EP', 'VOL', 'NO', 'SEASON', 'DAY', 'WEEK', 'YEAR', 'LESSON', 'PAGE', 'TRACK', 'SCENE', 'TOP',
  // General file names
  'CLIP', 'CLIPS', 'COPY', 'FINAL', 'DRAFT', 'TEST', 'BACKUP', 'SAMPLE', 'FILE', 'FILES', 'VIDEO', 'VIDEOS', 'MOVIE', 'MOVIES', 'FILM', 'IMAGE', 'IMAGES', 'PHOTO', 'PHOTOS', 'AUDIO', 'REPORT', 'VLOG', 'SCAN', 'PIC', 'PICS',
  // Camera file names
  'IMG', 'DSC', 'DSCF', 'DSCN', 'VID', 'MOV', 'MVI', 'PXL', 'GOPR', 'DJI', 'DCIM',
  // Quality, codec, technology, and rating names
  'HD', 'SD', 'FHD', 'QHD', 'UHD', 'HDR', 'MP', 'MPEG', 'AVC', 'HEVC', 'AAC', 'UTF', 'CP', 'ISO', 'SHA', 'AES', 'MD', 'RFC', 'CVE', 'HTTP', 'WIN', 'OS', 'IOS', 'MACOS', 'OFFICE', 'RTX', 'GTX', 'PG', 'TV', 'TEL',
  // Video source, container, audio, and codec names (words attached to video titles, such as REMUX-2160, BLURAY-1080, DTS-51, and VP-09). Ones of 7 or more characters are originally not in the number format, so they are not included.
  'REMUX', 'BLURAY', 'BLU', 'BDRIP', 'BRRIP', 'WEB', 'WEBDL', 'WEBRIP', 'HDRIP', 'DVDRIP', 'HDTV', 'UHDTV', 'AMZN', 'NF', 'DSNP', 'HMAX', 'ATVP', 'HULU',
  'MKV', 'AVI', 'WMV', 'FLV', 'WEBM', 'TS', 'DTS', 'DD', 'DDP', 'EAC', 'AC', 'FLAC', 'OPUS', 'PCM', 'LPCM', 'ATMOS', 'TRUEHD',
  'VP', 'AV', 'XVID', 'DIVX', 'VC', 'YUV', 'RGB', 'BT', 'SDR', 'HLG', 'DOVI', 'CH', 'BIT', 'BITS', 'FPS', 'HZ', 'KHZ', 'KBPS', 'MBPS',
  // Language and subtitles
  'KOR', 'KOREAN', 'KR', 'ENG', 'ENGSUB', 'EN', 'JPN', 'JP', 'JAP', 'CHN', 'CHS', 'CHT', 'SUB', 'SUBS', 'DUB', 'MULTI',
  // Words that come before dates and years, and common names
  'JAN', 'FEB', 'MAR', 'MARCH', 'APR', 'APRIL', 'MAY', 'JUN', 'JUNE', 'JUL', 'JULY', 'AUG', 'AUGUST', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC', 'FY', 'COVID',
]);

// It converts only full-width alphanumerics and symbols (ＡＢＣ－１２３) to half-width. NFKC would unfold characters such as ½, ², and ① into digits and change the number itself.
function halfWidth(text) {
  return text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// It finds product numbers in text, makes them upper case, and returns them in the order they appeared. The same number is included only once.
// By default it finds only upper case. Lowercase and mixed case are often ordinary words, such as summer-2023 and Vlog-2024.
// If lowercase is on, it also finds words that are all lowercase (abc-123). It does not find mixed case.
function extractProductNumbers(text, options) {
  return [...new Set(findProductNumberRanges(text, options).map((range) => range.number))];
}

// It returns the product numbers and their positions in the original, in the order they appeared, as a list of { number, start, end }. If the same number appears again, it is included again.
// Changing full-width to half-width keeps the character count the same, so the position is based on the original.
function findProductNumberRanges(text, { lowercase = false } = {}) {
  if (typeof text !== 'string') return [];
  const ranges = [];
  for (const { 0: match, index } of halfWidth(text).matchAll(CANDIDATE)) {
    const letters = match.slice(0, match.indexOf('-'));
    const upper = letters.toUpperCase();
    if (letters !== upper && !(lowercase && letters === letters.toLowerCase())) continue;
    if (!NOT_PRODUCT.has(upper)) ranges.push({ number: match.toUpperCase(), start: index, end: index + match.length });
  }
  return ranges;
}

// It finds the product number and returns { number, source, candidates }. If it finds none, it is null.
// The search order: an upper-case number in the file name, the title, the folder names (from the nearest folder), the comment, a lowercase number in the file name.
// - The file name is looked at first so as to skip if a number is already in it.
// - The comment can hold an address or other text, so it is placed after the folder name.
// - A lowercase number is accepted only in the file name and placed last. It recognizes the number of abc-123.mp4 but does not let vlog-2024.mp4 hide the ABC-123 in the title.
// number is the first number found, and candidates holds all the numbers found, so the caller can pick out files whose numbers conflict.
// source is one of 'fileName', 'title', 'folder', and 'comment'.
function findProductNumber(input) {
  const { fileName, title, comment, folders } = input ?? {};
  const sources = [
    ['fileName', fileName, false],
    ['title', title, false],
    ...(folders ?? []).map((folder) => ['folder', folder, false]),
    ['comment', comment, false],
    ['fileName', fileName, true],
  ];
  const candidates = new Map();
  for (const [source, text, lowercase] of sources) {
    for (const number of extractProductNumbers(text, { lowercase })) {
      if (!candidates.has(number)) candidates.set(number, { number, source });
    }
  }
  if (candidates.size === 0) return null;
  const list = [...candidates.values()];
  return { number: list[0].number, source: list[0].source, candidates: list };
}

// It finds upper-case numbers that the product number rule does not see as a number because letters or digits are attached before or after (1ABC-123, ABC-123A, ABC-123-01) and returns only the front number.
// It is used only as a signal that the name may already hold another number (#75). A word with a Latin letter attached in front (Pokémon-12, XABC-123) is not seen, because it is the middle of a word.
// It also does not look at the year-month-day date form (ZZZ-2024-05-01: after a 19xx or 20xx year, two groups of 1 to 2 digits) and words that are not product numbers (PIC, CVE, TEL, and so on).
// A digit group after a number that is not a year, as in ABC-123-01-1080p and ABC-123-01-02, is seen as a number with letters attached (second review).
const ATTACHED = /(?<!\p{Script=Latin}\p{M}*)(?<!\p{Script=Latin}\p{M}*-)([A-Z]{2,6})-(\d{2,5})(?!\d)/gu;
const YEAR = /^(?:19|20)\d\d$/;
const MONTH_DAY = /^-\d{1,2}-\d{1,2}(?!\d)/;

function findAttachedProductNumbers(text) {
  if (typeof text !== 'string') return [];
  const numbers = [];
  const half = halfWidth(text);
  for (const { 0: match, 1: letters, 2: digits, index } of half.matchAll(ATTACHED)) {
    if (YEAR.test(digits) && MONTH_DAY.test(half.slice(index + match.length))) continue;
    if (!NOT_PRODUCT.has(letters)) numbers.push(`${letters}-${digits}`);
  }
  return [...new Set(numbers)];
}

module.exports = { extractProductNumbers, findProductNumberRanges, findProductNumber, findAttachedProductNumbers, halfWidth };
