'use strict';

const path = require('node:path');
const { FcError, formatSize } = require('./commands');
const { grant, walk, fileSizeInside, compareRelative } = require('./target');
const { findProductNumberRanges, halfWidth } = require('./product');
const { LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');
const { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS, isTransportStream } = require('./productName');
const { readMp4Metadata } = require('./mp4');
const { readMkvMetadata } = require('./mkv');

// The condition for grouping by length. It is kept narrow so that different videos are not put in one group.
// - The length differs by 1 second or less. Moving the same video to another format changes the length by under 1 second.
// - The visible aspect ratio is within 3%. It is computed from the visible size (displayWidth/displayHeight of readMp4Metadata and readMkvMetadata) that reflects rotation (MP4 tkhd and mvhd matrices, MKV Projection) and pixel aspect ratio (MP4 pasp, tkhd size, SPS, MKV PixelCrop and DisplayWidth/Height)
//   (#106, #113).
//   So a phone video that shows portrait through rotation information (1920x1080 + 90 degrees) is grouped with a portrait video (1080x1920) and not with a landscape video.
// - A video shorter than 60 seconds is not grouped. The length of short clips is often the same by chance.
// It does not look at resolution and size. Re-encoding the same video changes both, and which one to keep is chosen after grouping.
const DURATION_TOLERANCE = 1;
const ASPECT_TOLERANCE = 0.03;
const MIN_DURATION = 60;
const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);
const MKV_EXTENSIONS = new Set(['.mkv', '.webm']);

const SEPARATORS = /[\s._\-–—－＿\u0085]+/g;
// The copy tail that Explorer adds. name - 복사본.mp4 (복사본 is Korean for "copy"), name - Copy (2).mp4
const COPY_SUFFIX = /\s+-\s+(?:복사본|copy)(?:\s*\(\d+\))?$/i;
// Marks that separate different pieces of the same number. Missing a duplicate is safer than putting different videos in one group, so it is set broadly.
// It splits what remains after removing the number into words. Quality and codec marks and the trailing (1) and copy tails are left out.
// - A digit inside a word (CD2, part 1, -1, [2], title3, 1.5) and a circled digit (①)
// - A one-letter English word (ABC-123 B, (A), [A], Title A)
// - A Roman numeral (II, xiv, Ⅲ) is turned into a number. A single letter (I, V, X) is seen as a one-letter English word.
// - Words such as 前編, 後編, 上巻, 下巻, 상, 하편, and 第一話 (Japanese and Korean words for first half, second half, volume 1, volume 2, upper, second part, and episode 1)
const TOKEN_SEPARATORS = /[\s._\-–—＿\u0085[\](){}【】「」『』《》〈〉〔〕〖〗,+&~!#'"]+/;
const QUALITY = /^(?:\d{3,4}[pi]|\d+fps|\d+bit|\d+k|[xh]26[45]|\d+ch|aac\d*|ac3|dts|ddp?\d*|mp[34]|h?vc1|av1|vp[89]|\d+kbps|\d+mbps)$/i;
const ROMAN = /^(?=[ivxlc]{2,}$)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100 };
const SECTION = /^(?:[前中後]編|[上中下]巻?|[前後]半|[상중하]편?|[전후]편)$/;
const KANJI_NUMBER = /^第?[一二三四五六七八九十百]+[話话巻卷部章回]?$/;
// It turns circled digits ①~⑳ and Roman numeral characters Ⅰ~Ⅻ and ⅰ~ⅻ into numbers.
const NUMBER_SYMBOLS = /[\u2460-\u2473\u2160-\u216b\u2170-\u217b]/g;
const symbolValue = (ch) => {
  const code = ch.charCodeAt(0);
  if (code >= 0x2460 && code <= 0x2473) return code - 0x2460 + 1;
  return code >= 0x2170 ? code - 0x2170 + 1 : code - 0x2160 + 1;
};

function romanValue(token) {
  const values = [...token.toLowerCase()].map((ch) => ROMAN_VALUES[ch]);
  return values.reduce((sum, value, index) => sum + (value < (values[index + 1] ?? 0) ? -value : value), 0);
}

const DUPLICATE_TAIL = /\s*\(\d+\)$/;

// It removes tails repeatedly. name - 복사본 (2), name (1) - 복사본
function stripTails(text, tails) {
  let current = text.trim();
  for (let previous = null; previous !== current; ) {
    previous = current;
    for (const tail of tails) current = current.replace(tail, '').trim();
  }
  return current;
}

// It splits what remains after removing the number into words. It drops the trailing (1) and copy tails and turns circled digits and Roman numeral characters into numbers.
// Changing full-width to half-width keeps the character count the same, so the number position is used as it is.
function restTokens(original, ranges) {
  const base = halfWidth(original);
  let rest = '';
  let at = 0;
  for (const { start, end } of ranges) {
    rest += `${base.slice(at, start)} `;
    at = end;
  }
  rest = stripTails(rest + base.slice(at), [COPY_SUFFIX, DUPLICATE_TAIL]).replace(NUMBER_SYMBOLS, (ch) => ` ${symbolValue(ch)} `);
  return rest.split(TOKEN_SEPARATORS).filter((token) => token !== '');
}

// It returns the piece marks joined in the order they appeared. Digits lose their leading 0s. CD1, part 01, and -1 are all 1. If there are none, it is null.
function findPart(original, ranges) {
  const marks = [];
  for (const token of restTokens(original, ranges)) {
    if (QUALITY.test(token)) continue;
    if (/^[A-Za-z]$/.test(token)) marks.push(token.toLowerCase());
    else if (ROMAN.test(token)) marks.push(String(romanValue(token)));
    else if (SECTION.test(token) || KANJI_NUMBER.test(token)) marks.push(token);
    else for (const digits of token.match(/\d+/g) ?? []) marks.push(String(Number(digits)));
  }
  return marks.length === 0 ? null : marks.join(' ');
}

// Words dropped from the title words. Release and subtitle marks, words that call pieces (CD, part), and copy marks. It also drops quality and codec marks (QUALITY).
const TITLE_NOISE = new Set([
  'fhd', 'hd', 'uhd', 'sd', 'hq', 'hdr', 'sub', 'subs', 'subbed', 'dub', 'dubbed', 'web', 'webrip', 'webdl', 'bluray', 'bdrip', 'brrip', 'dvdrip', 'hdrip', 'hdtv', 'remux', 'proper', 'repack',
  'hevc', 'avc', 'uncensored', 'censored', 'leak', 'leaked', 'cd', 'part', 'pt', 'disc', 'disk', 'ep', 'episode', 'vol', 'copy', '복사본', '자막', '한글자막', '무자막',
]);

// Title words for a number group. From what remains after removing the number, it returns the words left after dropping digits, piece marks, and quality and release marks, in lower case, without duplicates, in order of appearance.
// If the name does not have exactly one upper-case product number, it is null. It is a pure function that does not touch files.
// If the number is the same but the title differs (titlesDiffer), it may be a word wrongly recognized as a product number (WWE-2023 Raw and WWE-2023 SmackDown, #103).
function titleWords(fileName) {
  const base = fileName.slice(0, fileName.length - path.extname(fileName).length).normalize('NFC');
  const ranges = findProductNumberRanges(base);
  if (new Set(ranges.map((range) => range.number)).size !== 1) return null;
  const words = new Set();
  for (const token of restTokens(base, ranges)) {
    if (QUALITY.test(token) || ROMAN.test(token) || SECTION.test(token) || KANJI_NUMBER.test(token)) continue;
    const word = token.replace(/\d+/g, '').toLowerCase();
    if (!/\p{L}/u.test(word) || /^[a-z]$/.test(word) || TITLE_NOISE.has(word)) continue;
    words.add(word);
  }
  return [...words];
}

// Whether two title word lists both exist and are different titles. If one side's words are all contained in the other, it is seen as the same title
// (Good Movie and Good Movie Director's Cut). If the words only partly overlap (WWE Raw and WWE SmackDown), it is different. If either side has no title (ABC-123.mp4), it is not seen as different.
function titlesDiffer(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  const within = (small, large) => small.every((word) => large.includes(word));
  return !within(a, b) && !within(b, a);
}

// Common names that cameras, dashcams, and recording programs add. The key value of a name group (lower case, separators as spaces)
// may have one English word (up to 10 characters) in front, and every remaining word is either "up to 4 English letters + digits + up to 2 English letters" or 1 to 2 English letters,
// and it is seen so if there is at least one digit.
// IMG_0001, IMG_E0001, GH010001, DJI_0001, DJI_20230101123456_0001_D, FILE0001, VID_20230101_123456, VID-20230101-WA0001,
// PXL_20230101_123456789.LS, 20230101_123456_F, NO20230101-123456-000001F, 1
// Such clips often have a fixed length (1-minute and 3-minute dashcam pieces, recordings split by time), so even with the same name and length they can be different videos (#103).
// A product number (ABC-123) is a number group, so it does not fall here.
const COUNTER = '(?:[a-z]{0,4}\\d+[a-z]{0,2}|[a-z]{1,2})';
const GENERIC_NAME = new RegExp(`^(?:[a-z]{1,10} )?${COUNTER}(?: ${COUNTER})*$`);
// A recorder counter made of upper case letters and hyphens (REC-0001, FRONT-0001) looks like a product number and becomes a number group (#110).
// The product number judgment is shared with normalize and product-number, so it is not changed, and the number groups of these prefixes are seen as common names.
const COUNTER_PREFIXES = new Set(['REC', 'RECORD', 'CAM', 'CAMERA', 'MOV', 'MOVI', 'MOVIE', 'VIDEO', 'CLIP', 'FILE', 'FRONT', 'REAR', 'INSIDE', 'EVT', 'EVENT', 'NOR', 'NORMAL', 'PARK', 'PARKING', 'EMER', 'MANUAL', 'MVI', 'MAH', 'SAM', 'SDC', 'PICT', 'CIMG', 'HPIM', 'GOPR', 'DJI', 'PXL', 'IMG', 'DSC', 'VID']);

// Whether a name group ({ kind, key, number }) is a common name such as a camera or sequence name.
function isGenericGroup(group) {
  if (group.kind === 'number') return COUNTER_PREFIXES.has(group.number.split('-')[0]);
  return /\d/.test(group.key) && GENERIC_NAME.test(group.key);
}

// It returns, in order, the reasons a name group needs checking. If there are none, it is an empty array.
function groupCautions(group) {
  const cautions = [];
  if (group.keep?.doubt) cautions.push(group.keep.doubt);
  if (group.generic) cautions.push('This is a common name such as a camera or sequence name, so videos with the same name may be different videos. remove-duplicates does not delete this group.');
  if (group.differentTitles) cautions.push('The number is the same but the titles differ, so they may be different videos. remove-duplicates deletes only files whose title words are identical to the file to keep in this group.');
  return cautions;
}

// The comparison value for names without a number. It removes differences of case, full-width characters, composed Hangul, and separators, and copy tails.
function nameKey(base) {
  return stripTails(halfWidth(base), [COPY_SUFFIX]).replace(SEPARATORS, ' ').trim().toLowerCase();
}

// It returns the grouping key of one video file name. It is a pure function that does not touch files.
// - If the name has exactly one upper-case product number, { kind: 'number', key, number, part }. Even if the extension, quality mark, or title differ, it is the same group if the number and the piece are the same.
// - If there is no number, { kind: 'name', key }. It is the name without the extension, normalized with nameKey.
// - If there are several different numbers, { kind: 'conflict', numbers }. It does not decide which number to group by.
// A lowercase word (abc-123) is not seen as a number, because it is often an ordinary word such as trip-2023. If you first change it to upper case with normalize, it is grouped by number.
function duplicateKey(fileName) {
  // It first converts composed Hangul (names from macOS) to the precomposed form. The number position is also based on the converted name.
  const base = fileName.slice(0, fileName.length - path.extname(fileName).length).normalize('NFC');
  const ranges = findProductNumberRanges(base);
  const numbers = [...new Set(ranges.map((range) => range.number))];
  if (numbers.length > 1) return { kind: 'conflict', numbers };
  if (numbers.length === 1) {
    const [number] = numbers;
    const part = findPart(base, ranges);
    return { kind: 'number', key: part === null ? number : `${number} #${part}`, number, part };
  }
  const key = nameKey(base);
  return key === '' ? null : { kind: 'name', key };
}

function skipReason(parts) {
  if (parts.some((part) => LEFTOVER.test(part))) return 'Not checked because it is a leftover from an earlier job.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Not checked because it is inside a Windows system folder.';
  return null;
}

// It reads the length, resolution, and visible size. The formats it can read are MP4/MOV and MKV/WebM. If unknown it is null, and the reason it could not read goes in note.
// It does not read the video data and looks only at the head structure.
function readVideoInfo(target, real) {
  const extension = path.extname(real).toLowerCase();
  const reader = MP4_EXTENSIONS.has(extension) ? readMp4Metadata : MKV_EXTENSIONS.has(extension) ? readMkvMetadata : null;
  const unknown = (note) => ({ duration: null, width: null, height: null, displayWidth: null, displayHeight: null, note });
  if (!reader) return unknown(null);
  try {
    const { duration, width, height, displayWidth, displayHeight } = reader(target, real);
    const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);
    const info = { duration: positive(duration), width: positive(width), height: positive(height) };
    // The visible size is used only when both exist, and if absent, it is seen as the same as the resolution.
    const shown = positive(displayWidth) !== null && positive(displayHeight) !== null && info.width !== null && info.height !== null;
    info.displayWidth = shown ? displayWidth : info.width;
    info.displayHeight = shown ? displayHeight : info.height;
    // Even when a value is missing without an exception, it leaves a reason. A fragmented MP4 that does not write the length and an MKV/WebM whose recording was interrupted are such cases.
    const missing = [info.duration === null && 'duration', (info.width === null || info.height === null) && 'resolution'].filter(Boolean);
    return { ...info, note: missing.length === 0 ? null : `The ${missing.join(' and ')} information is missing.` };
  } catch (err) {
    if (err instanceof FcError) return unknown(err.message);
    return unknown(`Cannot read the metadata. (${err.code ?? err.message})`);
  }
}

// The visible aspect ratio (width / height). If there is no visible size (displayWidth, displayHeight), it is computed from the resolution. If the resolution is unknown, it is null.
function aspectRatio(file) {
  const width = file.displayWidth ?? file.width;
  const height = file.displayHeight ?? file.height;
  return width && height ? width / height : null;
}

// The aspect ratio used in the report. It is written to one decimal place (16:9 is 1.8, 4:3 is 1.3). If the resolution is unknown, it is null.
function aspectKey(file) {
  const ratio = aspectRatio(file);
  return ratio === null ? null : (Math.round(ratio * 10) / 10).toFixed(1);
}

// Whether the aspect ratios of two files can be seen as the same. If the wider is within 3% wider than the narrower, they are the same. If the resolution is unknown, they are not the same.
// Comparing by rounded cells splits the same video that sits on a cell boundary, such as 1920x816 (2.353) and 1920x818 (2.347) (#106).
function aspectsMatch(a, b) {
  const [x, y] = [aspectRatio(a), aspectRatio(b)];
  if (x === null || y === null) return false;
  return Math.max(x, y) / Math.min(x, y) - 1 <= ASPECT_TOLERANCE + 1e-9;
}

// It groups a list of files by length and aspect ratio. A file is { duration, width, height, displayWidth, displayHeight, ... }, and it returns only groups of two or more. It is a pure function.
// Sorted by length, for each file it looks at the groups made earliest first and puts it in a group that is within 1 second of the shortest file and within 3% aspect ratio of every file in the group. If there is none, it makes a new group.
// So no two files in a group differ by more than 1 second in length or more than 3% in aspect ratio.
// It does not first split by only the ratio or only the length, so a pair of the same video is not split because of another file that is close in only the length or only the ratio.
// However, a file goes into only one group, so if another video whose length and ratio are both close makes a group first, a pair of the same video can be split.
// It does not group a file whose length is unknown, which is shorter than 60 seconds, or whose resolution is unknown. aspect is the aspectKey of the shortest file in the group.
function groupByMetadata(files) {
  const usable = files.filter((file) => file.duration !== null && file.duration >= MIN_DURATION && aspectRatio(file) !== null);
  usable.sort((a, b) => a.duration - b.duration || aspectRatio(a) - aspectRatio(b));
  const groups = [];
  // Each open group holds its narrowest and widest ratios. If within 3% of both, it is within 3% of every file in the group.
  let open = [];
  for (const file of usable) {
    const ratio = aspectRatio(file);
    // A group that has passed the length window need not be looked at any more.
    open = open.filter(({ group }) => file.duration - group.files[0].duration <= DURATION_TOLERANCE);
    const fits = (entry) => Math.max(entry.max, ratio) / Math.min(entry.min, ratio) - 1 <= ASPECT_TOLERANCE + 1e-9;
    const entry = open.find(fits);
    if (entry) {
      entry.group.files.push(file);
      entry.min = Math.min(entry.min, ratio);
      entry.max = Math.max(entry.max, ratio);
    } else {
      const group = { aspect: aspectKey(file), files: [file] };
      groups.push(group);
      open.push({ group, min: ratio, max: ratio });
    }
  }
  return groups
    .filter((group) => group.files.length > 1)
    .map((group) => ({ ...group, duration: group.files[0].duration, sameSize: group.files.every((file) => file.size === group.files[0].size) }))
    .sort((a, b) => a.duration - b.duration || (a.aspect < b.aspect ? -1 : 1));
}

// It chooses one file to keep from a group. files are { path, size, duration, width, height, note }, and it is a pure function that does not touch files.
// It applies the criteria below in order. For each criterion, only the best files pass to the next criterion.
// 1. A file in a readable format (.mp4, .mkv, and so on) whose length or resolution could not be read (a file that has a note) may be broken, so it is moved to the back.
//    A format that is not read (.avi and so on) is not moved back, because it is not known whether it is broken.
// 2. Among the files left from 1, a file more than 1 second shorter than the longest file whose length is known may be a copy not fully downloaded or truncated, so it is moved to the back. A file whose length is unknown is not moved back.
// 3. The file with the highest resolution (width x height in pixels). A file whose resolution is unknown comes after one whose resolution is known.
// 4. The file with the largest size. With the same resolution, the one that holds more data often has better quality.
// 5. The file with the shortest name (including the extension). It is more likely the original file than one with a copy tail (` - 복사본`, ` (1)`, ` copy`) attached.
// 6. If still equal, the first file in path order. It compares ignoring case first, the same as the report order of name groups.
// The returned value is { path, reason, doubt }. reason is why it was chosen, and doubt is the notice for when files whose lengths are known differ by more than 1 second and may not be the same video (null if none).
// If there are no files, it is null. If there is only one, it picks that file and reason is "only one file".
function chooseKeeper(files) {
  if (files.length === 0) return null;
  const durations = files.map((file) => file.duration).filter((value) => value !== null);
  // A criterion takes the remaining candidates and returns a score function. The length criterion measures the longest length with the remaining candidates, so that it does not look at the length of a file removed in 1.
  const criteria = [
    ['excludes files whose duration or resolution could not be read', () => (file) => (file.note === null ? 1 : 0)],
    [
      'longest duration',
      (candidates) => {
        const known = candidates.map((file) => file.duration).filter((value) => value !== null);
        const longest = known.length === 0 ? null : Math.max(...known);
        return (file) => (file.duration !== null && longest - file.duration > DURATION_TOLERANCE ? 0 : 1);
      },
    ],
    ['highest resolution', () => (file) => (file.width === null || file.height === null ? -1 : file.width * file.height)],
    ['largest size', () => (file) => file.size],
    ['shortest name', () => (file) => -path.basename(file.path).length],
  ];
  let candidates = [...files].sort((a, b) => compareRelative(a.path, b.path));
  const reasons = [];
  for (const [reason, makeScore] of criteria) {
    const score = makeScore(candidates);
    const best = Math.max(...candidates.map(score));
    const kept = candidates.filter((file) => score(file) === best);
    if (kept.length < candidates.length) reasons.push(reason);
    candidates = kept;
  }
  if (files.length === 1) reasons.push('only one file');
  else if (candidates.length > 1) reasons.push(reasons.length === 0 ? 'all equal, first by path' : 'the rest equal, first by path');
  const doubt = durations.length > 1 && Math.max(...durations) - Math.min(...durations) > DURATION_TOLERANCE ? 'The durations differ, so they may not be the same video.' : null;
  return { path: candidates[0].path, reason: reasons.join(', '), doubt };
}

// It finds duplicate candidates by grouping the video files under the target by the name criterion and the length criterion. It does not touch files.
// It attaches the file to keep (keep: the result of chooseKeeper) to each group. Name groups and length groups choose separately, so a file in both groups can be kept in one and not kept in the other.
// - groups: groups with the same name ({ kind, key, number, part, generic, differentTitles, files }). Only those with two or more files are included.
//   generic is a group with a common name such as a camera or sequence name (isGenericGroup), and differentTitles is a number group that has two files with different titles (titlesDiffer) (#103).
//   A file in a number group gets a title (the value of titleWords).
//   Number groups come first, and within them they are in key order. Files are in path order inside the target.
// - metadataGroups: groups with the same length and aspect ratio ({ aspect, duration, sameSize, alsoNamed, files }). See groupByMetadata.
//   alsoNamed is a group whose files are all already in one name group. Files are in length order.
//   An item of files is { path, size, duration, width, height, displayWidth, displayHeight, note } (a file of a number group also has title). Unknown values are null, and note is the reason the metadata could not be read.
// - unknownMetadata: the number of videos whose length is unknown. It includes formats that cannot be read (avi, wmv, and so on) and files that could not be read.
// - metadataErrors: files in a readable format whose length or resolution could not be read ({ path, reason })
// - conflicts: files not grouped by name because they have several numbers ({ path, numbers }). They can still be grouped by length.
// - unreadable: files not grouped because the size or content could not be read ({ path, reason })
// - skipped: items that are not handled ({ path, reason })
// - checked: the number of video files examined
// A link is reported as skipped regardless of extension. The inside of repository folders is left out silently. Files that are not video (including the removal records fctl-removed-*.json) are not looked at.
function findDuplicateNames(dir) {
  const access = grant(dir, ['read']);
  const result = { target: access.target, groups: [], metadataGroups: [], unknownMetadata: 0, metadataErrors: [], conflicts: [], unreadable: [], skipped: [], checked: 0 };
  const byKey = new Map();
  const videos = [];
  const nameGroupOf = new Map();
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => REPOSITORY_FOLDER.test(part))) continue;
    // A link that points to a folder also reports that its inside was not looked at, regardless of extension.
    if (entry.type === 'link') {
      result.skipped.push({ path: entry.path, reason: 'Links are not checked.' });
      continue;
    }
    const name = path.basename(entry.path);
    const extension = path.extname(name).toLowerCase();
    const transport = TRANSPORT_EXTENSIONS.has(extension);
    if (!VIDEO_EXTENSIONS.has(extension) && !transport) continue;
    try {
      // A .ts that is not video (a TypeScript source) is not reported wherever it is. So it checks the content before deciding whether to skip it.
      if (transport && !isTransportStream(access.target, entry.relative)) continue;
      const reason = skipReason(parts);
      if (reason !== null) {
        result.skipped.push({ path: entry.path, reason });
        continue;
      }
      const real = access.read(entry.path);
      result.checked += 1;
      const size = fileSizeInside(access.target, real);
      const file = { path: real, size, ...readVideoInfo(access.target, real) };
      videos.push(file);
      if (file.duration === null) result.unknownMetadata += 1;
      const found = duplicateKey(name);
      if (found === null) continue;
      if (found.kind === 'conflict') {
        result.conflicts.push({ path: real, numbers: found.numbers });
        continue;
      }
      const id = `${found.kind}\0${found.key}`;
      if (!byKey.has(id)) byKey.set(id, { kind: found.kind, key: found.key, number: found.number ?? null, part: found.part ?? null, files: [] });
      // A file in a number group gets title words. They are used to see whether the title differs despite the same number.
      if (found.kind === 'number') file.title = titleWords(name);
      byKey.get(id).files.push(file);
      nameGroupOf.set(file, id);
    } catch (err) {
      const message = err instanceof FcError ? err.message : `Cannot read the file. (${err.code ?? err.message})`;
      result.unreadable.push({ path: entry.path, reason: message });
    }
  }
  const order = (a, b) => (a.kind === b.kind ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.kind === 'number' ? -1 : 1);
  result.groups = [...byKey.values()]
    .filter((group) => group.files.length > 1)
    .sort(order)
    .map((group) => ({
      ...group,
      generic: isGenericGroup(group),
      differentTitles: group.kind === 'number' && group.files.some((a, index) => group.files.slice(index + 1).some((b) => titlesDiffer(a.title, b.title))),
      keep: chooseKeeper(group.files),
    }));
  // A length group whose files are all in one name group is marked alsoNamed. The report does not repeat it, but it keeps the information that the name and the length both match.
  // A file that does not appear in a name group because it is alone is not seen as being in a name group.
  const shown = (file) => (byKey.get(nameGroupOf.get(file))?.files.length ?? 0) > 1;
  const sameNameGroup = (group) => group.files.every((file) => shown(file) && nameGroupOf.get(file) === nameGroupOf.get(group.files[0]));
  result.metadataGroups = groupByMetadata(videos).map((group) => ({ ...group, alsoNamed: sameNameGroup(group), keep: chooseKeeper(group.files) }));
  result.metadataErrors = videos.filter((file) => file.note !== null).map((file) => ({ path: file.path, reason: file.note }));
  return result;
}

// It writes seconds as h:mm:ss or m:ss.
function formatDuration(seconds) {
  const total = Math.round(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (value) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// The name of a name group. number ABC-123, number ABC-123 piece 2, name "trip"
function groupLabel(group) {
  return group.kind === 'number' ? `number ${group.number}${group.part === null ? '' : ` part ${group.part}`}` : `name "${group.key}"`;
}

function describe(file) {
  const parts = [formatSize(file.size)];
  if (file.width !== null && file.height !== null) {
    // If the visible size differs because of rotation or pixel aspect ratio, it writes both. 1920x1080 (displayed size 1080x1920)
    const shown = file.displayWidth != null && file.displayHeight != null && (file.displayWidth !== file.width || file.displayHeight !== file.height);
    parts.push(shown ? `${file.width}x${file.height} (displayed size ${file.displayWidth}x${file.displayHeight})` : `${file.width}x${file.height}`);
  }
  if (file.duration !== null) parts.push(formatDuration(file.duration));
  return parts.join(', ');
}

function formatDuplicateNames(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  // The file lines of a group. The file to keep gets the reason it was chosen.
  const pushFiles = (group) => {
    for (const file of group.files) {
      const keep = file.path === group.keep.path ? ` [kept: ${group.keep.reason}]` : '';
      lines.push(`  ${relative(file.path)} (${describe(file)})${keep}`);
    }
  };
  // For a name group, it adds, as caution lines, the reasons it may not be the same video (different length, common name, different title) (#103).
  for (const group of result.groups) {
    const label = groupLabel(group);
    lines.push(`Duplicate candidates (${label}, ${group.files.length} files):`);
    pushFiles(group);
    for (const caution of groupCautions(group)) lines.push(`  Caution: ${caution}`);
  }
  const metadataGroups = result.metadataGroups.filter((group) => !group.alsoNamed);
  for (const group of metadataGroups) {
    const same = group.sameSize ? ', same size too' : '';
    lines.push(`Videos with the same duration (${formatDuration(group.duration)}, aspect ratio ${group.aspect}${same}, ${group.files.length} files):`);
    pushFiles(group);
    if (group.keep.doubt !== null) lines.push(`  Caution: ${group.keep.doubt}`);
  }
  for (const item of result.conflicts) lines.push(`Several numbers: ${relative(item.path)} (${item.numbers.join(', ')})`);
  for (const item of result.metadataErrors) lines.push(`Could not read duration/resolution: ${relative(item.path)} (${item.reason})`);
  for (const item of result.unreadable) lines.push(`Undetermined: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  const files = result.groups.reduce((sum, group) => sum + group.files.length, 0);
  const cautious = result.groups.filter((group) => groupCautions(group).length > 0).length;
  const metadataFiles = metadataGroups.reduce((sum, group) => sum + group.files.length, 0);
  lines.push(
    `Checked ${result.checked} videos, ${result.groups.length} duplicate candidate groups (${files} files, ${cautious} need checking), ${metadataGroups.length} same-duration groups (${metadataFiles} files), ${result.unknownMetadata} with unknown duration, ${result.conflicts.length} with several numbers, ${result.unreadable.length} undetermined, ${result.skipped.length} skipped`,
  );
  return lines.join('\n');
}

module.exports = { duplicateKey, titleWords, titlesDiffer, isGenericGroup, groupCautions, groupByMetadata, chooseKeeper, findDuplicateNames, formatDuplicateNames, aspectKey, aspectsMatch, groupLabel, describeVideo: describe, DURATION_TOLERANCE, MIN_DURATION };
