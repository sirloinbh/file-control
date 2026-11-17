'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError, remove, hiddenOrSystemEntries, recycleEmptyFolders, recycleBinState, bareDeviceInside, MAX_RECYCLE_PATH } = require('./commands');
const { extractProductNumbers } = require('./product');
const { grant, walk, isInside } = require('./target');

// The NTFS file name limit (in UTF-16 characters)
const MAX_NAME = 255;

// toLowerCase looks at context and makes ΑΣ and ασ, which are the same name on NTFS, different, so it uses upper case.
function nameKey(name) {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

// It checks whether the name is free. It must check not only the planned names but also the real items, so that an overlap with an 8.3 short name (LONGFI~1.TXT) is caught.
// A name over the limit cannot be asked of the file system, so it is returned as is and the caller skips it.
function isTaken(name, target, taken) {
  if (taken.has(nameKey(name))) return true;
  if (name.length > MAX_NAME) return false;
  try {
    return Boolean(fs.lstatSync(path.join(target, name), { throwIfNoEntry: false }));
  } catch (err) {
    throw new FcError(`Cannot check the path: ${name} (${err.code})`);
  }
}

// If a.mkv collides, it looks for a free name in the order a (2).mkv, a (3).mkv.
// So that it does not search from 2 again every time when there are many of the same name, it remembers the next number for each name.
function freeName(name, target, taken, nextNumber) {
  if (!isTaken(name, target, taken)) return name;
  const { name: base, ext } = path.parse(name);
  const key = nameKey(name);
  for (let n = nextNumber.get(key) ?? 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!isTaken(candidate, target, taken)) {
      nextNumber.set(key, n + 1);
      return candidate;
    }
  }
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
  const stemOf = (folder) => (folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder).normalize('NFC');
  const index = ancestors.slice(0, soleCount).findIndex((folder) => stemOf(folder) === chosen);
  return ancestors.slice(index === -1 ? soleCount : index + 1);
}

// For a folder name that ends with the same extension as the file, it strips that extension, and it leaves out names that are empty, dot folders, or look like another extension.
function folderStems(folders, ext) {
  return folders
    .map((folder) => (folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder))
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
  // If there is no extension, the end of the folder name could become the extension (data + data.zip/), and for a dot file such as .env.local the name is the identity.
  // For .tar.gz, attaching the folder name leaves only .gz and loses the format. The ". Strange" of Dr. Strange is not an extension.
  if (ext === '' || /\s/.test(ext) || fileName.startsWith('.') || /\.tar$/i.test(base)) return fileName;
  const pick = (loose) => {
    let best = base;
    for (const [index, folder] of folders.entries()) {
      if (loose && index < start) continue;
      // If the folder name contains the same extension (ABC-123.mp4/), it is removed so they do not overlap, and a different extension would make a double extension, so it is not used.
      const stem = folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder;
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
  if (ext === '' || /\s/.test(ext) || fileName.startsWith('.') || /\.tar$/i.test(base)) return fileName;
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

// Leftovers left when mv or zip failed. They must stay at the location the error message told in order to be recovered, so they are not moved.
const LEFTOVER = /^\.fctl-(?:old|new)-\d+-\d+-\d+(?:\.|$)/;

// A folder Windows manages. Taking out the files inside breaks them together with the restore information.
const SYSTEM_FOLDER = /^(?:\$RECYCLE\.BIN|System Volume Information)$/i;

// Files that decorate a folder or hold previews. They mean something only in that folder, so moving them piles them up right under the target like desktop (2).ini (#65).
// They are not moved and are not counted in the file count, and if the folder becomes empty they go to the Recycle Bin with the folder.
const FOLDER_METADATA = /^(?:desktop\.ini|thumbs\.db|ehthumbs(?:_vista)?\.db|\.DS_Store)$/i;
const FOLDER_METADATA_NAMES = ['desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', '.ds_store'];

const isFolderMetadata = (entry) => entry.type === 'file' && FOLDER_METADATA.test(path.basename(entry.relative));

// What is seen as a folder a program uses by name alone. A program finds files by the inner structure and names, so it does not work if scattered (#65).
const PROGRAM_FOLDER = /^(?:node_modules|bower_components|__pycache__|site-packages)$/i;

// Files that, if present, make the folder a project or Python virtual environment folder.
const PROJECT_FILE = /^(?:package\.json|pyvenv\.cfg|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|CMakeLists\.txt|composer\.json|Gemfile|.+\.(?:sln|csproj|vcxproj|fsproj|vbproj))$/i;

// It returns the folders to leave whole without moving, as { relative path -> reason } (#65). Program folders, project folders, folders that hold an executable and a DLL together,
// and folders with the hidden attribute. Even if only the inside is kept and the files beside it are taken out, the program breaks, so everything under that folder is kept.
// A folder with only the system attribute is treated as an ordinary folder, because that attribute is often added when decorating a folder icon (together with desktop.ini) (first review).
// attributes is the { relative path -> attribute bits (hidden 2, system 4) } returned by hiddenOrSystemEntries.
// If the target itself is such a folder or is inside a program folder, every subfolder is part of the program, so it refuses.
function guardedFolders(target, entries, attributes) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (PROGRAM_FOLDER.test(path.basename(dir))) throw new FcError(`Not handled because it is inside a program folder: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  rejectProjectAncestor(target);
  const guarded = new Map();
  const add = (relative, reason) => {
    if (!guarded.has(relative)) guarded.set(relative, reason);
  };
  const programs = new Map();
  for (const entry of entries) {
    const name = path.basename(entry.relative);
    const parent = path.dirname(entry.relative);
    if (entry.type === 'dir') {
      if (PROGRAM_FOLDER.test(name)) add(entry.relative, `program folder (${name})`);
      else if ((attributes.get(entry.relative) ?? 0) & 2) add(entry.relative, 'folder with the hidden attribute');
      continue;
    }
    if (entry.type !== 'file') continue;
    if (PROJECT_FILE.test(name)) {
      if (parent === '.') throw new FcError(`Not handled because the target looks like a project folder (contains ${name}). Choose a folder below it as the target: ${target}`);
      add(parent, `project folder (contains ${name})`);
    }
    const ext = path.extname(name).toLowerCase();
    if (ext === '.exe' || ext === '.dll') programs.set(parent, new Set([...(programs.get(parent) ?? []), ext]));
  }
  for (const [parent, kinds] of programs) {
    if (kinds.size < 2) continue;
    if (parent === '.') throw new FcError(`Not handled because the target holds both executables and DLLs, so it is treated as a program folder. Choose a folder below it as the target: ${target}`);
    add(parent, 'program folder holding both executables and DLLs');
  }
  return guarded;
}

// It checks whether it is a place where a project marker file or an executable and DLL easily land by accident (#148). A drive root, the user folder and above,
// directly under the user folder (Downloads, Desktop, Documents, and so on), and directly under the OneDrive folder (OneDrive\Desktop and so on) are not seen as a project even if a downloaded package.json or
// an installer is there. From the folder below that (Downloads\myproj), it looks.
// A folder the user made (user-folder\myproj) is the terminal's default location where projects often appear, so only the fixed names are skipped (first review).
function isCommonPlace(dir, home) {
  if (dir === path.dirname(dir)) return true;
  if (!home) return false;
  if (isInside(dir, home)) return true;
  const name = path.basename(dir);
  const parent = path.dirname(dir);
  if (path.relative(home, parent) === '') return HOME_FOLDER.test(name) || ONEDRIVE.test(name);
  return path.relative(home, path.dirname(parent)) === '' && ONEDRIVE.test(path.basename(parent)) && ONEDRIVE_FOLDER.test(name);
}

// The default folders directly under the user folder. The disk names are English even on Korean Windows.
const HOME_FOLDER = /^(?:Downloads|Desktop|Documents|Pictures|Videos|Music|Favorites|Links|Saved Games|Searches|Contacts|3D Objects)$/i;
// The OneDrive folder (OneDrive, OneDrive - Company) and the default folders it syncs directly under it. The OneDrive side is made with display language names.
const ONEDRIVE = /^OneDrive(?:$| - )/i;
const ONEDRIVE_FOLDER = /^(?:Desktop|Documents|Pictures|Videos|Music|Attachments|바탕 화면|문서|사진|동영상|음악|첨부 파일)$/i;

// The real path of the user folder. If unknown, it returns an empty string, and then it skips only drive roots (the side that blocks more).
function realHome() {
  let home;
  try {
    home = os.homedir();
  } catch {
    return '';
  }
  if (!home || !path.isAbsolute(home)) return '';
  try {
    return fs.realpathSync.native(home);
  } catch {
    return path.resolve(home);
  }
}

// If a folder above the target is a project folder (a marker file directly inside) or a program folder (an executable and a DLL together), it refuses (#148).
// If myproj/src is scattered when myproj/package.json exists, the project breaks, and without a repository it cannot be undone.
// It looks at all folders above but skips the ones where isCommonPlace is true. It does not cut by number of levels (myproj/src/a/b is also blocked).
function rejectProjectAncestor(target) {
  const home = realHome();
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    if (!isCommonPlace(dir, home)) {
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch (err) {
        throw new FcError(`Cannot check whether a parent folder is a project folder: ${dir} (${err.code})`);
      }
      const marker = names.find((name) => PROJECT_FILE.test(name));
      if (marker) throw new FcError(`Not handled because a parent folder looks like a project folder (contains ${marker}): ${dir}`);
      const exts = new Set(names.map((name) => path.extname(name).toLowerCase()));
      if (exts.has('.exe') && exts.has('.dll')) throw new FcError(`Not handled because a parent folder holds both executables and DLLs, so it is treated as a program folder: ${dir}`);
    }
    if (dir === path.dirname(dir)) break;
  }
}

// If the path is under a folder to leave, it returns the relative path of the outermost such folder; otherwise undefined.
function guardOf(relative, guarded) {
  const parts = relative.split(path.sep);
  for (let depth = 1; depth <= parts.length; depth++) {
    const folder = parts.slice(0, depth).join(path.sep);
    if (guarded.has(folder)) return folder;
  }
  return undefined;
}

// A folder name can be used only when the file is the only item in that folder (including below). If there are several, the distinction such as ep1 and ep2 is lost.
// parts are the folders looked at when choosing a name (from the outer folder). For a subtitle file, they are the folders subtitlePlacement decided (#233).
function soleFolders(parts, fileCounts) {
  const folders = [];
  for (let depth = parts.length; depth > 0; depth--) {
    if (fileCounts.get(folderKey(parts.slice(0, depth))) !== 1) break;
    folders.push(parts[depth - 1]);
  }
  return folders;
}

// A key for comparing folder paths. Like Windows, it treats differences of case and NFC/NFD as the same folder.
function folderKey(parts) {
  return parts.join(path.sep).normalize('NFC').toUpperCase();
}

// Subtitle file extensions (#233). A file of this kind inside a subtitle folder chooses its name to match the video-side folder structure.
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt', '.smi', '.sami', '.sup']);

// The key of a folder that holds video files, including below, and a Map of that folder's real names (#233). A language folder that holds video (Show/English/video.mp4) is seen as a dubbed-version folder, not a subtitle folder.
function videoFolders(entries) {
  // productName imports this module, so it is imported when used.
  const { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS } = require('./productName');
  const folders = new Map();
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const ext = path.extname(entry.relative).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext) && !TRANSPORT_EXTENSIONS.has(ext)) continue;
    const parts = entry.relative.split(path.sep).slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) if (!folders.has(folderKey(parts.slice(0, depth)))) folders.set(folderKey(parts.slice(0, depth)), parts[depth - 1]);
  }
  return folders;
}

// It returns the folders to choose the name of a subtitle file (from the outer folder) and the distinguishing folder names to attach after the name (#233).
// It leaves out the outermost subtitle folder (Subs/, English Subs/, a language folder without video, English/), and for the folders inside it uses them up to where a folder of the same path that holds video exists on the video side.
// If Show/Season 1/ has video, Show/Subtitles/Season 1/video.srt chooses its name like Show/Season 1/video.srt.
// The matched folder name uses the spelling of the video-side folder (the value of videos), so even if the case differs (1080P/cd1), it gets the same prefix as the video (first review).
// It does not match to a folder with no video (Show/Extras/poster.jpg). If matched, the prefix would differ from the video (Show video.mp4) (first review).
// Among the folders deeper than that, a usable name (Forced/, Full/) is attached after the name with a dot (Show video.Forced.srt), keeping the pair with the video while telling them apart.
// A product-number folder (Subs/ABC-123/) is not attached and is left as a folder, picked first as before (first review). An inner folder made only of subtitle and language words (Subs/English/) is not attached.
// If there is no subtitle folder, it returns the folders as they are.
function subtitlePlacement(parts, videos) {
  const container = parts.findIndex((part, index) => subtitleFolder(part) || (languageFolder(part) && !videos.has(folderKey(parts.slice(0, index + 1)))));
  if (container === -1) return { parts, tags: [] };
  const mirrored = parts.slice(0, container);
  let end = container + 1;
  for (; end < parts.length; end++) {
    const name = videos.get(folderKey([...mirrored, parts[end]]));
    if (name === undefined) break;
    mirrored.push(name);
  }
  const inner = parts.slice(end).filter((part) => !part.startsWith('.'));
  const products = inner.filter((part) => extractProductNumbers(part).length > 0);
  const tags = inner.filter((part) => !products.includes(part) && informativeFolder(part) && !containerFolder(part));
  return { parts: [...mirrored, ...products], tags };
}

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

// For each folder, it counts the files and links inside, including below. It does not count folder settings and preview files (desktop.ini and so on).
// placeOf returns the folders (from the outer folder) in which to count an item. A subtitle is counted in the video-side folder, so it is seen as a file in the same folder as its paired video (#233).
function countFiles(entries, placeOf) {
  const counts = new Map();
  for (const entry of entries) {
    if (entry.type === 'dir' || isFolderMetadata(entry)) continue;
    const parts = placeOf(entry);
    for (let depth = 1; depth <= parts.length; depth++) {
      const key = folderKey(parts.slice(0, depth));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

// A version control folder. The inner structure is the content, so if scattered it cannot be recovered.
const REPOSITORY_FOLDER = /^\.(?:git|hg|svn|jj)$/i;

// If HEAD, objects, and refs are together, it is a Git repository folder. A bare repository (backup.git) is caught even when the name is not .git.
function looksLikeGitDir(dir) {
  const stat = (name) => fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
  try {
    return Boolean(stat('HEAD')?.isFile() && stat('objects')?.isDirectory() && stat('refs')?.isDirectory());
  } catch (err) {
    throw new FcError(`Cannot check whether it is a repository: ${dir} (${err.code})`);
  }
}

// In a repository the folder structure itself is the content, so even skipping only the inside of .git would scatter the working files and make them unrecoverable. It refuses instead of moving only part.
// If the target is an ordinary subfolder of a repository (r/src), the repository is not broken and can be restored with git, so it is not blocked.
function rejectRepository(target, entries) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (REPOSITORY_FOLDER.test(path.basename(dir)) || looksLikeGitDir(dir)) throw new FcError(`Not handled because it is inside a repository: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  const folder = entries.find((entry) => entry.relative.split(path.sep).some((part) => REPOSITORY_FOLDER.test(part)));
  if (folder) throw new FcError(`Not handled because it contains a repository: ${folder.path}`);
  const bare = entries.find((entry) => entry.type === 'file' && path.basename(entry.path) === 'HEAD' && looksLikeGitDir(path.dirname(entry.path)));
  if (bare) throw new FcError(`Not handled because it contains a repository: ${path.dirname(bare.path)}`);
}

// It makes a plan to move all files under the target directly under the target. It does not touch files.
// - moves: files to move ({ from, to, name, desired, fromFolder, numbered }). desired is the name before a number is added. If the folder name is more detailed, fromFolder is true.
//   If names collide, a number is added and numbered is true. An existing name is avoided even if it is a folder.
// - stay: the paths of items that are already directly under the target and are left as they are
// - skipped: items not moved ({ path, reason }). Links and names that grant refuses leave a reason so they do not drop out silently.
//   Folders left whole (program, project, and hidden folders) are left as one folder, not file by file.
// - guarded: a Set of relative paths of the folders left whole. The empty-folder cleanup also keeps these folders and the ones above them.
function planFlatten(dir) {
  const access = grant(dir, ['read', 'write']);
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  // It passes on as is what walk saw as folders so the two judgments do not split. The inside of a folder such as node_modules is left whole, so it is not looked at.
  const folders = [''].concat(entries.filter((entry) => entry.type === 'dir' && !entry.relative.split(path.sep).some((part) => PROGRAM_FOLDER.test(part))).map((entry) => entry.relative));
  const attributes = hiddenOrSystemEntries(access.target, folders);
  const guarded = guardedFolders(access.target, entries, attributes);
  const guardItems = new Map();
  const isTop = (entry) => !entry.relative.includes(path.sep);
  const taken = new Set(entries.filter(isTop).map((entry) => nameKey(entry.relative)));
  const nextNumber = new Map();
  // For a subtitle file, it chooses and counts its name by the video-side folder without the subtitle folder (#233).
  const videos = videoFolders(entries);
  const placements = new Map();
  const placementOf = (entry) => {
    let place = placements.get(entry);
    if (!place) {
      const parts = entry.relative.split(path.sep).slice(0, -1);
      place = SUBTITLE_EXTENSIONS.has(path.extname(entry.relative).toLowerCase()) ? subtitlePlacement(parts, videos) : { parts, tags: [] };
      placements.set(entry, place);
    }
    return place;
  };
  const fileCounts = countFiles(entries, (entry) => placementOf(entry).parts);
  const plan = { target: access.target, moves: [], stay: [], skipped: [], guarded: new Set(guarded.keys()) };
  // If a previous run stopped after making a hard link, another name of the same file (possibly with a number) exists directly under the target (#73).
  const topFiles = new Map();
  // The files to assign names to ({ from, original, desired, slot, move })
  const candidates = [];
  for (const entry of entries) {
    if (!isTop(entry) || entry.type !== 'file') continue;
    const key = fileKey(entry.path);
    if (key) topFiles.set(key, entry.path);
  }
  for (const entry of entries) {
    if (isTop(entry)) {
      if (entry.type !== 'dir') plan.stay.push(entry.path);
      continue;
    }
    const parts = entry.relative.split(path.sep);
    if (entry.type !== 'dir' && parts.some((part) => LEFTOVER.test(part))) {
      plan.skipped.push({ path: entry.path, reason: 'Not moved because it is a leftover from an earlier job.' });
      continue;
    }
    if (entry.type !== 'dir' && parts.some((part) => SYSTEM_FOLDER.test(part))) {
      plan.skipped.push({ path: entry.path, reason: 'Not moved because it is inside a Windows system folder.' });
      continue;
    }
    const guard = guardOf(entry.relative, guarded);
    if (guard !== undefined) {
      if (entry.type === 'dir') continue;
      let item = guardItems.get(guard);
      if (!item) {
        item = { path: path.join(access.target, guard), label: guarded.get(guard), count: 0 };
        guardItems.set(guard, item);
        plan.skipped.push(item);
      }
      item.count += 1;
      continue;
    }
    if (entry.type === 'dir') continue;
    if (entry.type === 'link') {
      plan.skipped.push({ path: entry.path, reason: 'Links are not moved.' });
      continue;
    }
    if (isFolderMetadata(entry)) {
      plan.skipped.push({ path: entry.path, reason: 'Not moved because it is a folder settings or preview file. If the folder becomes empty, it goes to the Recycle Bin with the folder.' });
      continue;
    }
    if (attributes.has(entry.relative)) {
      plan.skipped.push({ path: entry.path, reason: 'Not moved because it has the hidden or system attribute.' });
      continue;
    }
    const original = path.basename(entry.path);
    try {
      const from = access.read(entry.path);
      // Attaching an extension to a folder name can exceed the length limit. It does not skip the file and goes back to the original name.
      const place = placementOf(entry);
      const sole = soleFolders(place.parts, fileCounts);
      const ancestors = [...place.parts].reverse();
      let detailed = detailedName(original, sole, titleStart(ancestors));
      if (detailed === original) detailed = prefixedName(original, ancestors);
      else detailed = withOuterFolder(original, detailed, outerFolders(original, detailed, ancestors, sole.length));
      // It does not leave that name and add a number to make a third name.
      const twin = topFiles.get(fileKey(from));
      if (twin) throw new FcError(`Not moved because the name already exists directly under the target: ${path.basename(twin)}${leftoverNote(from, twin)}`);
      // Names are assigned all at once below. On failure, the reason is filled into this place to keep the skipped order.
      const slot = { path: entry.path, reason: null };
      plan.skipped.push(slot);
      if (detailed.length > MAX_NAME) detailed = original;
      // If the name with the distinguishing folder name attached exceeds the limit, it is not attached. The pair is tied by the name before attaching.
      const tagged = place.tags.length > 0 && detailed !== original ? withTags(detailed, original, place.tags) : detailed;
      candidates.push({ from, original, desired: tagged.length > MAX_NAME ? detailed : tagged, pairName: detailed, slot });
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      plan.skipped.push({ path: entry.path, reason: err.message });
    }
  }
  // It first assigns names to the files that keep their original name (#63). So that a folder-name candidate (ABC-123 Title/x.mp4 -> ABC-123 Title.mp4)
  // does not take the name of the file that originally has that name (z/ABC-123 Title.mp4) first and force a number on it. The move order is the item order as it is.
  // Pairs that received the same prefix in the same folder (ABC-123/video.mp4, video.en.srt -> ABC-123 video.*) are assigned even before that,
  // so that even if they overlap with a file of the original name (z/ABC-123 video.mp4), a number is added to only one of the pair and the pair does not break (first review).
  // The key is the attached prefix plus the part before the first dot of the original name. It does not cut at a dot in the prefix folder name (ABC-123 v1.5),
  // and it also ties pairs split across subfolders (ABC-123/video.mp4, ABC-123/Subs/video.en.srt) (second review).
  // A subtitle with the distinguishing folder name attached (Show video.Forced.srt) is tied to the video by the name before attaching (pairName) (#233).
  const pairKey = (c) => {
    if (!c.pairName.endsWith(c.original)) return nameKey(c.pairName);
    return nameKey(c.pairName.slice(0, c.pairName.length - c.original.length) + c.original.split('.')[0]);
  };
  const pairSizes = new Map();
  for (const c of candidates) if (c.desired !== c.original) pairSizes.set(pairKey(c), (pairSizes.get(pairKey(c)) ?? 0) + 1);
  const rank = (c) => {
    if (c.desired === c.original) return 1;
    return pairSizes.get(pairKey(c)) > 1 ? 0 : 2;
  };
  const order = [0, 1, 2].flatMap((r) => candidates.filter((c) => rank(c) === r));
  for (const candidate of order) {
    const { from, original } = candidate;
    try {
      let desired = candidate.desired;
      let name = freeName(desired, access.target, taken, nextNumber);
      if (name.length > MAX_NAME && desired !== original) {
        desired = original;
        name = freeName(desired, access.target, taken, nextNumber);
      }
      if (name.length > MAX_NAME) throw new FcError(`The name is too long once the number is added: ${name}`);
      candidate.move = { from, to: access.write(name), name, desired, fromFolder: desired !== original, numbered: name !== desired };
      taken.add(nameKey(name));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      candidate.slot.reason = err.message;
    }
  }
  plan.moves = candidates.filter((c) => c.move).map((c) => c.move);
  const slots = new Set(candidates.map((c) => c.slot));
  plan.skipped = plan.skipped.filter((item) => !slots.has(item) || item.reason !== null);
  for (const item of guardItems.values()) {
    item.reason = `Not moving the ${item.count} items inside; the folder is left whole because it is a ${item.label}.`;
    delete item.label;
    delete item.count;
  }
  // It reports that a folder to keep that has no files is also not deleted. Those inside another folder to keep were already reported by the outer folder.
  for (const [relative, label] of guarded) {
    if (!guardItems.has(relative) && guardOf(relative, guarded) === relative) plan.skipped.push({ path: path.join(access.target, relative), reason: `Folder left whole because it is a ${label}.` });
  }
  return plan;
}

// It moves without overwriting. If it already exists (including an 8.3 short name or case), it changes nothing and returns false.
// renameSync overwrites the target (a folder also overwrites a file of the same name, confirmed on build 26200), so it is not used as is.
// For a file, it creates a hard link under the new name and then deletes the original name (#73). linkSync fails with EEXIST if the name exists, so it does not overwrite a file that slipped in,
// and even if the power goes off midway, only two names with the same content remain, with no empty file left. If the source is locked and the original name cannot be deleted, it deletes the new name and rolls back.
// When a hard link cannot be made (FAT32, exFAT, cloud-only files, and so on) and for folders, it first creates an empty placeholder file and then moves over it.
function moveWithoutOverwrite(from, to) {
  if (fs.lstatSync(from).isFile()) {
    try {
      fs.linkSync(from, to);
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      // Even if it reported failure, the link may have been made (a lost network response and so on). Then it is a name I made, so it goes on to delete the original name.
      if (!sameFile(from, to)) return moveOverPlaceholder(from, to);
    }
    try {
      fs.unlinkSync(from);
    } catch (err) {
      removeNewName(from, to, err);
      throw err;
    }
    return true;
  }
  return moveOverPlaceholder(from, to);
}

function moveOverPlaceholder(from, to) {
  try {
    fs.closeSync(fs.openSync(to, 'wx'));
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.renameSync(from, to);
  } catch (err) {
    removePlaceholder(to, err);
    throw err;
  }
  return true;
}

// It checks by file ID whether it is the same file. Windows file IDs are 64 bits, so it reads them as bigint.
// On a file system that reports the file ID as 0 (some network drives), it is seen as not the same, so that different files are not seen as the same.
function sameFile(a, b) {
  const sa = fs.lstatSync(a, { bigint: true, throwIfNoEntry: false });
  const sb = fs.lstatSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(sa && sb && sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev);
}

// The key for finding the same file (volume:file ID). If it cannot be confirmed or the file ID is 0, it is null. The reason it could not be confirmed is reported by the name choosing later.
function fileKey(p) {
  try {
    const stat = fs.lstatSync(p, { bigint: true, throwIfNoEntry: false });
    return stat && stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

// If it could not delete the original name, it deletes the hard link it made and rolls back. If the new name was replaced by another file in the meantime, it does not delete.
function removeNewName(from, to, cause) {
  let ours;
  try {
    ours = sameFile(from, to);
  } catch (err) {
    throw new FcError(`Could not move, and could not check the new name either: ${to} (${cause.code}, ${err.code})`);
  }
  if (!ours) {
    if (!fs.lstatSync(to, { throwIfNoEntry: false })) return;
    throw new FcError(`Could not move, and the new name was turned into a different file in the meantime, so it was not deleted: ${to} (${cause.code})`);
  }
  try {
    fs.unlinkSync(to);
  } catch (err) {
    throw new FcError(`Could not move, and could not delete the new name either, so the same file remains under two names: ${from}, ${to} (${cause.code}, ${err.code})`);
  }
}

// When the target name already exists and it looks like something an earlier run left by stopping midway, it returns a message that says so (#73).
function leftoverNote(from, to) {
  try {
    if (sameFile(from, to)) return ' (another name of the same file as the source (a hard link). It may be a trace of an earlier run that stopped midway; delete one of the names)';
    const target = fs.lstatSync(to, { throwIfNoEntry: false });
    if (target?.isFile() && target.size === 0 && fs.lstatSync(from).size > 0) {
      return ' (that name is an empty file. It may be a placeholder left when an earlier run stopped midway; check it, delete it, and run again)';
    }
  } catch {
    // Only the notice message is left out.
  }
  return '';
}

// If another program wrote content in the meantime, it is not my placeholder, so it does not delete it.
function removePlaceholder(to, cause) {
  let stat;
  try {
    stat = fs.lstatSync(to, { throwIfNoEntry: false });
  } catch (err) {
    throw new FcError(`Could not move, and could not check the placeholder file either: ${to} (${cause.code}, ${err.code})`);
  }
  if (!stat) return;
  if (!stat.isFile() || stat.size !== 0) throw new FcError(`Could not move, and the placeholder file now has other content, so it was not deleted: ${to} (${cause.code})`);
  try {
    fs.rmSync(to, { force: true, maxRetries: 3 });
  } catch (err) {
    throw new FcError(`Could not move, and could not delete the empty placeholder file either: ${to} (${cause.code}, ${err.code})`);
  }
}

// The limit on how many times it picks a number again. It prevents an endless task when another program keeps creating the same name.
const MAX_ATTEMPTS = 100;

// If the planned name got filled in the meantime, it picks a number again. It cannot be known at the planning stage, as when moving a/longfilename.txt newly fills LONGFI~1.TXT.
function applyMove(move, access, taken, nextNumber) {
  // If the source was replaced by a link or points outside the target between the plan and the run, it is refused here.
  const from = access.delete(move.from);
  // If the parent was replaced by a junction that points inside, or a file became a folder, an item different from the plan would be moved.
  if (from !== move.from) throw new FcError(`The path changed after planning: ${move.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`No longer a file after planning: ${from}`);
  let name = move.name;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (name.length > MAX_NAME) throw new FcError(`The name is too long once the number is added: ${name}`);
    const to = path.join(access.target, name);
    // It does not touch an existing item. Opening a broken junction with wx would create a folder outside the target that the junction points to.
    if (!fs.lstatSync(to, { throwIfNoEntry: false })) {
      access.write(name);
      if (moveWithoutOverwrite(from, to)) return { ...move, from, to, name, numbered: name !== move.desired };
    }
    name = freeName(move.desired, access.target, taken, nextNumber);
    taken.add(nameKey(name));
  }
  throw new FcError(`Could not find a free name: ${move.desired}`);
}

// It returns the folders above a path as relative paths from the target. If the path itself is a folder, it also includes the path itself.
function folderChain(entry) {
  const parts = entry.relative.split(path.sep);
  const last = entry.type === 'dir' ? parts.length : parts.length - 1;
  return Array.from({ length: last }, (_, i) => parts.slice(0, i + 1).join(path.sep));
}

// Among the folders that held a file moved this time, it returns only the topmost of those that became empty. The folders below it are deleted together.
// A folder that was originally empty (Inbox/) may be a structure the user made, so it is not touched. Only empty folders inside the tree that held a moved file go along.
// If there are remaining files and links, leftovers, or system folders and what is inside them, all the folders above are kept.
function removableFolders(entries, movedFolders, guarded = new Set()) {
  const occupied = new Set();
  for (const entry of entries) {
    // A folder with only folder settings and preview files left is seen as an empty folder and sent to the Recycle Bin together (#65).
    if (isFolderMetadata(entry)) continue;
    const protectedDir = entry.type === 'dir' && (entry.relative.split(path.sep).some((part) => LEFTOVER.test(part) || SYSTEM_FOLDER.test(part)) || guardOf(entry.relative, guarded) !== undefined);
    if (entry.type !== 'dir' || protectedDir) for (const folder of folderChain(entry)) occupied.add(folder);
  }
  const free = entries.filter((entry) => entry.type === 'dir' && !occupied.has(entry.relative));
  const freeNames = new Set(free.map((entry) => entry.relative));
  return free.filter((entry) => !freeNames.has(path.dirname(entry.relative)) && movedFolders.has(entry.relative)).map((entry) => entry.path);
}

// It collects the folders that held a moved file and their parent folders as relative paths from the target.
function foldersOf(moves, target) {
  const folders = new Set();
  for (const { from } of moves) {
    for (const folder of folderChain({ relative: path.relative(target, from), type: 'file' })) folders.add(folder);
  }
  return folders;
}

// The number of folders sent to PowerShell at once. It is the unit of the time limit and of the interim report.
const FOLDER_BATCH = 100;

// It turns the result of the batch Recycle Bin move into reasons.
const FOLDER_STATUS_REASON = {
  moved: 'The path changed after the check (junction, etc.). Not deleted.',
  notdir: 'No longer a folder after the check.',
  filled: 'Not deleted because a file appeared in the folder.',
  gone: 'The folder no longer exists.',
  timeout: 'Not processed because the time limit was hit (an error dialog may have appeared). Try deleting it in Explorer to find the cause.',
};

// The check Node does before deleting. If it passes, it gives the real path; otherwise it gives an FcError.
function checkFolder(folder, access, { dryRun }) {
  const real = access.delete(folder);
  // If it was replaced by a junction that points inside, a different folder would be deleted.
  if (real !== folder) throw new FcError(`The path changed after the check: ${folder} -> ${real}`);
  if (!dryRun) {
    if (!fs.lstatSync(real).isDirectory()) throw new FcError(`No longer a folder after the check: ${real}`);
    const filled = walk(real).find((entry) => entry.type !== 'dir' && !isFolderMetadata(entry));
    if (filled) throw new FcError(`Not deleted because a file appeared in the folder: ${filled.path}`);
    if (real.length > MAX_RECYCLE_PATH) throw new FcError(`The path is ${real.length} characters, so it cannot be sent to the Recycle Bin (up to ${MAX_RECYCLE_PATH}): ${real}`);
    // It runs the checks of rm, such as the current folder and above and device names, as they are, without deleting (as a preview).
    remove([real], { dryRun: true, checkVolume: false });
  }
  return real;
}

// It sends empty folders to the Recycle Bin. Folders that failed stay in kept. onFolder(folder, reason) is called as each folder finishes (if there is no reason, it was sent).
// Starting PowerShell for each folder takes hours at thousands of folders, so it sends FOLDER_BATCH at a time (#67). Node checks again for each batch, and
// PowerShell also checks again, for each folder right before deleting, the real path, whether it is a folder, and the files inside (recycleEmptyFolders).
// On a drive that may have no Recycle Bin (one that is not a fixed disk) and in a non-interactive session, it may be deleted permanently, so it does not delete.
function removeFolders(folders, access, { dryRun, onFolder = () => {} }) {
  const report = { removed: [], kept: [] };
  const done = (folder, reason) => {
    if (reason === undefined) report.removed.push(folder);
    else report.kept.push({ path: folder, reason });
    onFolder(folder, reason);
  };
  if (folders.length === 0) return report;
  // So that the preview also keeps them for the same reason as a real run, it looks at the drive and the session first (first review).
  const state = recycleBinState(access.target);
  let blocked;
  if (state.interactive === false) blocked = 'Cannot send to the Recycle Bin outside an interactive session.';
  else if (state.driveType !== 'Fixed') blocked = `Empty folders were not deleted because the drive (${state.driveType ?? 'unknown type'}) may have no Recycle Bin and they could be permanently deleted.`;
  // It is an empty folder so the size does not matter, but if the Recycle Bin setting is "remove immediately", it is deleted permanently (#81, confirmed on build 26200).
  else if (state.nukeOnDelete === true) blocked = 'Empty folders were not deleted because this volume is set to remove files immediately, so they would be permanently deleted without using the Recycle Bin.';
  const failure = (err) => (err instanceof FcError ? err.message : `Cannot send to the Recycle Bin. (${err.code ?? err.status})`);
  if (dryRun) {
    for (const folder of folders) {
      if (blocked) {
        done(folder, blocked);
        continue;
      }
      try {
        remove([checkFolder(folder, access, { dryRun })], { dryRun, checkVolume: false });
        done(folder);
      } catch (err) {
        done(folder, failure(err));
      }
    }
    return report;
  }
  // For folders left untouched in a batch that hit the time limit (pending), it queues them up again. At least one finishes each time, so it eventually stops.
  // If hitting the time limit right at the first folder of a batch happens in a row (such as a dialog appearing for each folder), only one folder finishes at a time and it would take hours, so it stops (second review).
  const MAX_STALLS = 2;
  let stalls = 0;
  const queue = [...folders];
  while (queue.length > 0) {
    const batch = [];
    for (const folder of queue.splice(0, FOLDER_BATCH)) {
      if (blocked) {
        done(folder, blocked);
        continue;
      }
      try {
        batch.push(checkFolder(folder, access, { dryRun }));
      } catch (err) {
        done(folder, failure(err));
      }
    }
    if (batch.length === 0) continue;
    let results;
    try {
      results = recycleEmptyFolders(batch, { allowedNames: FOLDER_METADATA_NAMES });
    } catch (err) {
      // The failure message of the Recycle Bin call includes the whole script, so it is not used.
      const reason = err instanceof FcError ? err.message : `Could not send to the Recycle Bin. (${err.code ?? err.status})`;
      // For a reason that fails the same way in every batch, such as a non-interactive session or a locked-down environment, it does not send the rest either.
      if (err instanceof FcError) blocked = reason;
      for (const folder of batch) done(folder, reason);
      continue;
    }
    const pending = [];
    for (const { path: folder, status } of results) {
      if (status === 'pending') pending.push(folder);
      else if (status === 'ok' || (status === 'timeout' && !fs.existsSync(folder))) done(folder);
      else if (status === 'error') {
        // If a folder holds an item that is exactly a device name, the Recycle Bin move fails for the whole folder (#135).
        const inside = bareDeviceInside(folder);
        done(folder, inside === undefined ? 'Could not send to the Recycle Bin.' : `Could not send to the Recycle Bin. It may have failed because of an item with a device name inside (${inside}). Rename that item with fctl rename and delete again.`);
      } else done(folder, FOLDER_STATUS_REASON[status]);
    }
    queue.unshift(...pending);
    if (results[0]?.status === 'timeout') stalls += 1;
    else stalls = 0;
    if (stalls >= MAX_STALLS) blocked = `The time limit was hit ${MAX_STALLS} times in a row on the first folder of the batch, so the remaining empty folders were not deleted (an error dialog may have appeared). Check the cause and run again.`;
  }
  return report;
}

// It moves the files under the target directly under the target and sends the folders that became empty to the Recycle Bin. It does not overwrite, and even if one file fails, it continues moving the rest.
// The returned value is { target, dryRun, moved, stay, skipped, failed, removedFolders, keptFolders }.
// failed is { from, reason }, and keptFolders is a list of { path, reason } of folders that could not be deleted.
// If onProgress(line) is given, in a real run it passes a report line each time a file or a folder is done. Even if it is interrupted midway, you can tell what was already done (#67).
function flatten(dir, { dryRun = false, onProgress } = {}) {
  const plan = planFlatten(dir);
  const access = grant(plan.target, ['write', 'delete']);
  const result = { target: plan.target, dryRun, moved: [], stay: plan.stay, skipped: plan.skipped, failed: [], removedFolders: [], keptFolders: [] };
  if (dryRun) {
    const moving = new Set(plan.moves.map((move) => move.from));
    const after = walk(plan.target).filter((entry) => !moving.has(entry.path));
    const { removed, kept } = removeFolders(removableFolders(after, foldersOf(plan.moves, plan.target), plan.guarded), access, { dryRun });
    return { ...result, moved: plan.moves, removedFolders: removed, keptFolders: kept };
  }
  // So that it does not take the names of files to be moved later, all planned names are treated as taken.
  const taken = new Set(plan.moves.map((move) => nameKey(move.name)));
  const nextNumber = new Map();
  const relative = (p) => path.relative(plan.target, p) || '.';
  // Even if the progress display throws, the tally, the handling of the next file, and the empty-folder cleanup carry on (#196). It does not count an already moved file as a failure.
  const report = (line) => {
    try {
      onProgress?.(line);
    } catch {
      // The progress display does not affect the result.
    }
  };
  for (const move of plan.moves) {
    try {
      const moved = applyMove(move, access, taken, nextNumber);
      result.moved.push(moved);
      report(moveLine(moved, relative, ''));
    } catch (err) {
      result.failed.push({ from: move.from, reason: err.message });
      report(`Failed: ${relative(move.from)} (${err.message})`);
    }
  }
  const onFolder = (folder, reason) => report(reason === undefined ? `Empty folder to the Recycle Bin: ${relative(folder)}` : `Folder kept: ${relative(folder)} (${reason})`);
  // It judges by the real state after the move finished, not by the plan. A folder that has a failed file or a file that appeared in the meantime stays.
  try {
    const { removed, kept } = removeFolders(removableFolders(walk(plan.target), foldersOf(result.moved, plan.target), plan.guarded), access, { dryRun, onFolder });
    result.removedFolders = removed;
    result.keptFolders = kept;
  } catch (err) {
    result.keptFolders = [{ path: plan.target, reason: err.message }];
  }
  return result;
}

function moveLine(move, relative, prefix) {
  const notes = [move.fromFolder && 'folder name used', move.numbered && 'number added'].filter(Boolean);
  return `${prefix}Move: ${relative(move.from)} -> ${move.name}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
}

// It makes the result into lines a person can read. The detailed report format will be polished in #19.
function formatFlatten(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [];
  for (const move of result.moved) lines.push(moveLine(move, relative, prefix));
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.from)} (${item.reason})`);
  for (const folder of result.removedFolders) lines.push(`${prefix}Empty folder to the Recycle Bin: ${relative(folder)}`);
  for (const item of result.keptFolders) lines.push(`${prefix}Folder kept: ${relative(item.path)} (${item.reason})`);
  lines.push(`${prefix}Move ${result.moved.length}, stay ${result.stay.length}, skipped ${result.skipped.length}, failed ${result.failed.length}, empty folders removed ${result.removedFolders.length}`);
  return lines.join('\n');
}

module.exports = { withOuterFolder, FOLDER_METADATA, PROGRAM_FOLDER, PROJECT_FILE, planFlatten, detailedName, prefixedName, flatten, formatFlatten, MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER, moveWithoutOverwrite, leftoverNote, rejectRepository, looksLikeGitDir, rejectProjectAncestor };
