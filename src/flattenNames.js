'use strict';

// Pure naming heuristics for flatten: which folder name (if any) a file takes or is prefixed with, and the folder-name classifiers behind that.
// Nothing here touches the file system.

const path = require('node:path');
const { extractProductNumbers } = require('./product');
const { MAX_NAME } = require('./guards');

// For a folder name that ends with the same extension as the file (ABC-123.mp4/), it strips that extension. Other names are returned as is.
function stripExtension(folder, ext) {
  return folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder;
}

// True if no folder name can safely be joined to this file name. With no extension, the end of the folder name could become the extension (data + data.zip/),
// and for a dot file such as .env.local the name is the identity. For .tar.gz, attaching the folder name leaves only .gz and loses the format. The ". Strange" of Dr. Strange is not an extension.
function hasNoUsableExtension(fileName) {
  const { name: base, ext } = path.parse(fileName);
  return ext === '' || /\s/.test(ext) || fileName.startsWith('.') || /\.tar$/i.test(base);
}

// It checks whether the end of a folder name looks like an extension. An end that starts with digits, such as Movie.2021.1080p, is not seen as an extension.
const EXTENSION_LIKE = /\.(?:[A-Za-z][A-Za-z0-9]{0,9}|7z)$/;

// File names with no information. Only such files are changed to the product-number folder name. Names such as "계약서" (Korean for "contract") and ko would lose information if removed.
const GENERIC_NAME = /^(?:[A-Z]|VIDEO|MOVIE|FILM|CLIP|FILE|IMAGE|PHOTO|AUDIO|SAMPLE|UNTITLED|영상|동영상|파일)$/;

// GENERIC_NAME without the one-letter names. A one-letter name such as a or o may be an abbreviation, so it is not changed to a folder name that is not a product number (#71).
const GENERIC_WORD = /^(?:VIDEO|MOVIE|FILM|CLIP|FILE|IMAGE|PHOTO|AUDIO|SAMPLE|UNTITLED|영상|동영상|파일)$/;

// If a folder name has only these, it is seen as having no information. Words such as video kind, quality, and codec, and common folder names.
const PLAIN_FOLDER_WORD = /^(?:VIDEOS?|MOVIES?|FILMS?|CLIPS?|FILES?|IMAGES?|PHOTOS?|AUDIO|SAMPLES?|UNTITLED|영상|동영상|파일|DOWNLOADS?|SUBS?|SUBTITLES?|자막|NEW|FOLDER|TEMP|TMP|새|폴더|[HX]\.?26[45]|HEVC|AVC|AV1|\d{3,4}[PI]|[248]K|UHD|FHD|HD|SD|BD\d*|BDRIP|BLURAY|WEB|WEBRIP|DL|DVD|DVDRIP|HDR|SDR|AAC|AC3|DTS)$/;

// The words in PLAIN_FOLDER_WORD that show only quality or codec. Alone they cannot be a name, but they tell versions of the same video apart (#150).
const QUALITY_WORD = /^(?:[HX]\.?26[45]|HEVC|AVC|AV1|\d{3,4}[PI]|[248]K|UHD|FHD|HD|SD|BD\d*|BDRIP|BLURAY|WEB|WEBRIP|DL|DVD|DVDRIP|HDR|SDR|AAC|AC3|DTS)$/;

// The name Windows gives a new folder ("새 폴더", Korean for "New folder"). Even with a number attached, it has no information.
const DEFAULT_FOLDER = /^(?:새 폴더|New folder)(?: \(\d+\))?$/i;

// True if it is a usable folder name to use instead of a file name with no information (#71). It is enough that there is a product number or at least one word that is not one of the common words above.
// Full-width letters are normalized with NFKC, and the number and copy marks Explorer adds (Downloads (2), "새 폴더 - 복사본", "New folder - copy") are stripped before looking (first review).
// A folder name of only one letter (a/) may be an abbreviation, so it is not used.
function informativeFolder(folder) {
  if (extractProductNumbers(folder).length > 0) return true;
  const plain = folder.normalize('NFKC').trim().replace(/(?:\s*\(\d+\)|\s+-\s+(?:복사본|Copy))+$/i, '');
  if (DEFAULT_FOLDER.test(plain)) return false;
  const folderWords = words(plain);
  if (folderWords.join('').length < 2) return false;
  return folderWords.some((word) => !PLAIN_FOLDER_WORD.test(word));
}

// It checks whether a folder is one to pick by name (#211). Even a usable name, a subtitle folder (English Subs/, Eng Sub/) holds only subtitles, so it is not picked.
// A folder with other words together (Movie [Eng Sub]/) may be the title of a hard-subbed video, so it is picked (second review).
// A folder with only a language name (English/) is picked here (#233). A language folder that holds only subtitles is removed in advance by planFlatten from the subtitle's folder list.
function titleFolder(folder) {
  return informativeFolder(folder) && !subtitleFolder(folder);
}

// It checks whether it is a nearby folder to attach together between prefixes (#150). It is enough that it is a usable name or a name with only quality or codec (1080p, WEB-DL).
// Container folder names such as Subs, "자막" (subtitles), Videos, and "새 폴더" (new folder) are not attached. If attached, ABC-123/Subs/video.en.srt would lose its pair with ABC-123/video.mp4.
function distinguishingFolder(folder) {
  if (informativeFolder(folder)) return true;
  const folderWords = words(folder.normalize('NFKC'));
  return folderWords.length > 0 && folderWords.every((word) => QUALITY_WORD.test(word));
}

// When a file name with no information received the nearby folder name (CD1), it prepends the product number or the title of an outer folder that is not the only file (#150).
// ABC-123/CD1/video.mp4 and ABC-123/CD2/video.mp4 become ABC-123 CD1.mp4 and ABC-123 CD2.mp4. If the received name has a product number,
// the outer name is already in it, or attaching would exceed the length limit, it returns the received name as is.
// outer is the folders outside the folder of the received name (from the nearest). An outer folder that holds only one file (Show of Show/CD1/video.mp4) is included too (#168).
function withOuterFolder(fileName, detailed, outer) {
  const { name: base, ext } = path.parse(fileName);
  if (!GENERIC_WORD.test(words(base).join(''))) return detailed;
  const chosen = detailed.slice(0, detailed.length - ext.length);
  if (extractProductNumbers(chosen).length > 0) return detailed;
  // An outer folder with an extension attached (ABC-123.mp4/) is also used with that extension stripped (first review).
  const stems = folderStems(outer, ext);
  const pick = stems.find((stem) => extractProductNumbers(stem).length > 0) ?? outerTitle(stems);
  if (pick === undefined || containsWords(words(chosen), words(pick).join(''))) return detailed;
  // If the outer name already contains the received name (Show CD1/CD1/video.mp4), it uses only the outer name and the in-between folders so they do not overlap (#178).
  if (containsWords(words(pick), words(chosen).join(''))) {
    const merged = `${joinBetween(pick, stems.slice(0, stems.indexOf(pick)), chosen)}${ext}`;
    return merged.length <= MAX_NAME ? merged : detailed;
  }
  // Quality folders and the like between the outer folder and the received name are also attached like a prefix (first review). Show/1080p/CD1/video.mp4 -> Show 1080p CD1.mp4
  const full = `${joinBetween(pick, stems.slice(0, stems.indexOf(pick)), chosen)} ${detailed}`;
  if (full.length <= MAX_NAME) return full;
  const short = `${pick.normalize('NFC')} ${detailed}`;
  return short.length <= MAX_NAME ? short : detailed;
}

// It returns the folders outside the folder detailedName chose, from the nearest (#168). Before, it passed only an outer folder that was not the only file, so
// a lone Show/CD1/video.mp4 became CD1.mp4 and lost Show, and the result differed from when the same Show had a CD2 (Show CD1.mp4).
// If it cannot find the chosen folder, it returns only the outer folder that is not the only file, as before.
function outerFolders(fileName, detailed, ancestors, soleCount) {
  const ext = path.extname(fileName);
  const chosen = detailed.slice(0, detailed.length - ext.length);
  const stemOf = (folder) => stripExtension(folder, ext).normalize('NFC');
  const index = ancestors.slice(0, soleCount).findIndex((folder) => stemOf(folder) === chosen);
  return ancestors.slice(index === -1 ? soleCount : index + 1);
}

// For a folder name that ends with the same extension as the file, it strips that extension, and it leaves out names that are empty, dot folders, or look like another extension.
function folderStems(folders, ext) {
  return folders
    .map((folder) => stripExtension(folder, ext))
    .filter((stem) => stem.trim() !== '' && !stem.startsWith('.') && !EXTENSION_LIKE.test(stem));
}

// Words that go in subtitle folder names. Even together with other words, as in English Subs/, it is seen as a subtitle folder.
const SUBTITLE_WORD = /^(?:SUBS?|SUBTITLES?|자막)$/;

// Language names. A folder with only these words and no video (English/, "한국어/" Korean) is seen as a folder that holds subtitles split by language and is handled like a subtitle folder (second review, #233).
const LANGUAGE_WORD = /^(?:ENGLISH|ENG|EN|KOREAN|KOR|KO|JAPANESE|JPN|JA|CHINESE|CHS|CHT|CHI|ZH|SPANISH|SPA|ES|FRENCH|FRE|FRA|FR|GERMAN|GER|DEU|DE|한국어|한글|영어|일본어|중국어)$/;

// True if it is a folder with subtitle words (Subs/, English Subs/, "자막/" subtitles). This folder and the folders inside it are seen as holding only subtitles.
function hasSubtitleWord(folder) {
  return words(folder.normalize('NFKC')).some((word) => SUBTITLE_WORD.test(word));
}

// True if it is a folder with only a language name (English/, "한국어/" Korean). It is a folder that holds subtitles split by language or a folder of videos by language (dubbed versions).
function languageFolder(folder) {
  const folderWords = words(folder.normalize('NFKC'));
  return folderWords.length > 0 && folderWords.every((word) => LANGUAGE_WORD.test(word));
}

// True if it is a folder made only of subtitle words and language names (Subs/, Eng Sub/, English/).
function containerFolder(folder) {
  const folderWords = words(folder.normalize('NFKC'));
  return folderWords.length > 0 && folderWords.every((word) => SUBTITLE_WORD.test(word) || LANGUAGE_WORD.test(word));
}

// True if it has subtitle words and is made only of subtitle and language words (Subs/, English Subs/, "자막/" subtitles). A folder that holds a title, such as Movie [Eng Sub]/, is not seen as a subtitle folder (second review).
function subtitleFolder(folder) {
  return hasSubtitleWord(folder) && containerFolder(folder);
}

// It looks, from the nearest, for the title folder to attach from outside the chosen folder (#211). A folder with only a language name and a subtitle folder (English Subs/) are used only when there is no other title.
// Show/English/CD1/video.mp4 picks Show, and the English in between is attached by joinBetween, making Show English CD1 (#233). English/CD1/video.mp4 attaches English.
function outerTitle(stems) {
  return stems.find((stem) => titleFolder(stem) && !languageFolder(stem)) ?? stems.find(titleFolder) ?? stems.find(informativeFolder);
}

// The position after the outermost one that is a subtitle folder among folders (from the nearest) (#211). Folders nearer than that are inside a subtitle folder, so they are not picked as a title.
// For a subtitle file, planFlatten removes the subtitle folder in advance, so this position is used for other files inside a subtitle folder (Subs/Fonts/font.ttf).
function titleStart(folders) {
  return folders.findLastIndex(subtitleFolder) + 1;
}

// After chosen, it attaches, from the outside, the names to attach among the in-between folders (between, from the nearest) (#150). Names already in it (including also) are not attached again.
// Folders with subtitle words and the folders below them (Subs/English/) are not attached. If attached, ABC-123/Subs/English/video.en.srt would get a different prefix from the video (first review).
// A folder with only a language name (Show/English/CD1/) may be a folder of videos by language, so it is attached (#233). A language folder that holds only subtitles is removed in advance by planFlatten.
function joinBetween(chosen, between, also = '') {
  let prefix = chosen.normalize('NFC');
  for (const stem of [...between].reverse()) {
    const stemWords = words(stem);
    if (hasSubtitleWord(stem)) break;
    if (!distinguishingFolder(stem) || containsWords(words(`${prefix} ${also}`), stemWords.join(''))) continue;
    prefix = `${prefix} ${stem.normalize('NFC')}`;
  }
  return prefix;
}

// It drops differences of spaces, symbols, and case and splits into words.
function words(name) {
  return name.normalize('NFC').toUpperCase().split(/[\s\-_.()[\]]+/).filter(Boolean);
}

// True if the folder's consecutive words joined together equal the file name. Searching by character would overlap by chance, as with v and movie, or 2 and 2021.
function containsWords(folderWords, fileText) {
  return folderWords.some((_, start) => {
    let joined = '';
    for (let i = start; i < folderWords.length && joined.length < fileText.length; i++) joined += folderWords[i];
    return joined === fileText;
  });
}

// True if the folder name is more detailed than the file name. If it cannot decide, it returns false so that the file name is kept.
// It does not choose by length alone. The information in a file name (date, quality, language, number) cannot be restored once removed.
// If loose is true, even a folder name that is not a product number is used for a file name with no information (#71).
function isMoreDetailed(folder, base, loose = false) {
  const folderWords = words(folder);
  const baseWords = words(base);
  const f = folderWords.join('');
  const b = baseWords.join('');
  if (f === '' || b === '') return false;
  if (f.length > b.length && containsWords(folderWords, b)) return true;
  if (b.includes(f)) return false;
  if (extractProductNumbers(folder).length > 0 && GENERIC_NAME.test(b)) return true;
  // A file name with no information, such as video.mp4, uses even a folder name not accepted as a product number (PART-01, BD-123). If left as is, the folder is deleted and the information is lost (#71).
  return loose && GENERIC_WORD.test(b) && titleFolder(folder);
}

// It returns the most detailed name among the file name and the folder names (from the nearest folder), keeping the extension.
// Folders nearer than start (folders inside a subtitle folder) are not picked as the new name for a file name with no information (#211). A product-number folder is still picked.
function detailedName(fileName, folders, start = 0) {
  const { name: base, ext } = path.parse(fileName);
  if (hasNoUsableExtension(fileName)) return fileName;
  const pick = (loose) => {
    let best = base;
    for (const [index, folder] of folders.entries()) {
      if (loose && index < start) continue;
      // If the folder name contains the same extension (ABC-123.mp4/), it is removed so they do not overlap, and a different extension would make a double extension, so it is not used.
      const stem = stripExtension(folder, ext);
      // Using a dot folder name such as .trash-1000 would make a hidden file.
      if (!stem.startsWith('.') && !EXTENSION_LIKE.test(stem) && isMoreDetailed(stem, best, loose)) best = stem.normalize('NFC');
    }
    return best;
  };
  // It looks for a product-number folder first. Only when there is none does it use another folder name for a file name with no information, so a nearer summer-2023/ does not push out an outer ABC-123/.
  const strict = pick(false);
  return (strict === base ? pick(true) : strict) + ext;
}

// When a file name with no information is not the only file in the folder and cannot be changed to the folder name, it returns a name with the nearest folder name prepended (#71).
// ABC-123/video.mp4 and ABC-123/sample.mp4 become ABC-123 video.mp4 and ABC-123 sample.mp4. The original name is kept so they can be told apart,
// and the main feature and the sample do not fight over the same name. If it cannot attach, it returns the original name.
// folders is in order from the nearest folder to the outer folders. If the nearest folder has no information, like 1080p/, it goes up and attaches the first usable folder name it meets (first review).
// Whether it has no information is judged by the part before the first dot. video.en.srt also gets the same prefix as video.mp4, so the subtitle pair is kept. It only prepends, so no information is lost.
function prefixedName(fileName, folders) {
  const { name: base, ext } = path.parse(fileName);
  if (hasNoUsableExtension(fileName)) return fileName;
  const b = words(base.split('.')[0]).join('');
  if (!GENERIC_NAME.test(b)) return fileName;
  // It also accepts a single folder (a string) or a missing value.
  const stems = folderStems([folders].flat().filter((folder) => folder !== undefined), ext);
  // Like detailedName, it looks for a product-number folder first, so that ABC-123/Extras/video.mp4 attaches ABC-123 instead of Extras (second review).
  // The title folder is picked only outside a folder with subtitle words (#211). If Show/Subs/Forced/video.en.srt received Forced, it would lose its pair with the video.
  const titles = stems.slice(titleStart(stems));
  const chosen = stems.find((stem) => extractProductNumbers(stem).length > 0) ?? (GENERIC_WORD.test(b) ? titles.find(titleFolder) : undefined);
  if (chosen === undefined) return fileName;
  // The nearby folder names between the chosen folder and the file (1080p, CD1) are also attached together from the outside (#150). So that Show/1080p/video.mp4 and Show/720p/video.mp4
  // do not become Show video.mp4 and Show video (2).mp4 and lose the quality distinction. Names already in it are not attached again.
  const inner = joinBetween(chosen, stems.slice(0, stems.indexOf(chosen)));
  const prefixes = [inner, chosen.normalize('NFC')];
  // If the chosen folder is not a product-number folder, the outer title folder is also prepended like withOuterFolder (#178). So that Show/CD1/video.mp4 and video.en.srt
  // become Show CD1 video.mp4 and Show CD1 video.en.srt and do not lose Show, as with a lone video.mp4 (Show CD1.mp4).
  // The chosen folder is also attached with joinBetween like the in-between folders, and if the outer name already contains it (Show CD1/CD1/1080p/), it is not attached again (first review).
  if (extractProductNumbers(chosen).length === 0) {
    const pick = outerTitle(titles.slice(titles.indexOf(chosen) + 1));
    if (pick !== undefined && !containsWords(words(inner), words(pick).join(''))) prefixes.unshift(joinBetween(pick, stems.slice(0, stems.indexOf(pick))));
  }
  // The length limit is judged not by the whole file name but by the prefix and the part before the first dot (first review). Because if video.mp4 and video.en.srt received
  // different prefixes because of a length difference, the pair would break. It leaves PAIR_RESERVE characters for the extension and the language mark.
  const stem = fileName.split('.')[0];
  const prefix = prefixes.find((candidate) => candidate.length + 1 + stem.length + PAIR_RESERVE <= MAX_NAME) ?? prefixes.at(-1);
  return `${prefix} ${fileName}`;
}

// The number of characters left after the first dot (the extension and a language mark such as .en.forced) when choosing a prefix (#178).
const PAIR_RESERVE = 30;

// It attaches the distinguishing folder name (tags) to the chosen name with a dot after the part before the first dot (#233). Show video.en.srt -> Show video.Forced.en.srt
// A name changed to the folder name (Show Season 1.srt) gets it before the extension.
function withTags(detailed, original, tags) {
  const label = tags.map((tag) => tag.normalize('NFC')).join('.');
  if (detailed.endsWith(original)) {
    const dot = original.indexOf('.');
    return `${detailed.slice(0, detailed.length - original.length)}${original.slice(0, dot)}.${label}${original.slice(dot)}`;
  }
  const ext = path.extname(original);
  return `${detailed.slice(0, detailed.length - ext.length)}.${label}${ext}`;
}

module.exports = {
  stripExtension,
  hasNoUsableExtension,
  informativeFolder,
  titleFolder,
  distinguishingFolder,
  withOuterFolder,
  outerFolders,
  folderStems,
  subtitleFolder,
  languageFolder,
  containerFolder,
  hasSubtitleWord,
  outerTitle,
  titleStart,
  joinBetween,
  words,
  containsWords,
  isMoreDetailed,
  detailedName,
  prefixedName,
  withTags,
};
