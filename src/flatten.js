'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove, hiddenOrSystemEntries, recycleEmptyFolders, recycleBinState, bareDeviceInside, MAX_RECYCLE_PATH } = require('./commands');
const { extractProductNumbers } = require('./product');
const { grant, walk } = require('./target');
const { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, PROGRAM_FOLDER, PROJECT_FILE, leftoverNote, rejectRepository, rejectProjectAncestor } = require('./guards');
const { moveWithoutOverwrite } = require('./safeMove');
const { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS } = require('./video');
const { informativeFolder, containerFolder, subtitleFolder, languageFolder, titleStart, withOuterFolder, outerFolders, detailedName, prefixedName, withTags } = require('./flattenNames');

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

// Files that decorate a folder or hold previews. They mean something only in that folder, so moving them piles them up right under the target like desktop (2).ini (#65).
// They are not moved and are not counted in the file count, and if the folder becomes empty they go to the Recycle Bin with the folder.
const FOLDER_METADATA = /^(?:desktop\.ini|thumbs\.db|ehthumbs(?:_vista)?\.db|\.DS_Store)$/i;
const FOLDER_METADATA_NAMES = ['desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', '.ds_store'];

const isFolderMetadata = (entry) => entry.type === 'file' && FOLDER_METADATA.test(path.basename(entry.relative));

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

const isTop = (entry) => !entry.relative.includes(path.sep);

// The files already directly under the target, keyed by file ID. If a previous run stopped after making a hard link, another name of the same file (possibly with a number) exists directly under the target (#73).
function topLevelFiles(entries) {
  const topFiles = new Map();
  for (const entry of entries) {
    if (!isTop(entry) || entry.type !== 'file') continue;
    const key = fileKey(entry.path);
    if (key) topFiles.set(key, entry.path);
  }
  return topFiles;
}

// It decides what happens to one item below the top level, without looking at its name: { skip: reason }, { guard: folder left whole }, { file: true } for a file to move, or {} for a folder to ignore.
function classifyEntry(entry, guarded, attributes) {
  const isDir = entry.type === 'dir';
  const parts = entry.relative.split(path.sep);
  if (!isDir && parts.some((part) => LEFTOVER.test(part))) return { skip: 'Not moved because it is a leftover from an earlier job.' };
  if (!isDir && parts.some((part) => SYSTEM_FOLDER.test(part))) return { skip: 'Not moved because it is inside a Windows system folder.' };
  const guard = guardOf(entry.relative, guarded);
  if (guard !== undefined) return isDir ? {} : { guard };
  if (isDir) return {};
  if (entry.type === 'link') return { skip: 'Links are not moved.' };
  if (isFolderMetadata(entry)) return { skip: 'Not moved because it is a folder settings or preview file. If the folder becomes empty, it goes to the Recycle Bin with the folder.' };
  if (attributes.has(entry.relative)) return { skip: 'Not moved because it has the hidden or system attribute.' };
  return { file: true };
}

// It sorts every item into stay (directly under the target), skipped, or files to move. Each skipped row carries the position of the entry it came from, so the report keeps the walk order
// even when later steps add reasons. A folder left whole is reported once, as an item that counts the files inside it.
function classifyEntries(entries, target, guarded, attributes) {
  const result = { stay: [], skipped: [], guardItems: new Map(), files: [] };
  entries.forEach((entry, order) => {
    if (isTop(entry)) {
      if (entry.type !== 'dir') result.stay.push(entry.path);
      return;
    }
    const verdict = classifyEntry(entry, guarded, attributes);
    if (verdict.skip !== undefined) result.skipped.push({ order, item: { path: entry.path, reason: verdict.skip } });
    else if (verdict.guard !== undefined) {
      let item = result.guardItems.get(verdict.guard);
      if (!item) {
        item = { path: path.join(target, verdict.guard), label: guarded.get(verdict.guard), count: 0 };
        result.guardItems.set(verdict.guard, item);
        result.skipped.push({ order, item });
      }
      item.count += 1;
    } else if (verdict.file) result.files.push({ entry, order });
  });
  return result;
}

// The name a file takes from its folders: the folder name, the folder name prepended, or the original name (#71, #168).
function folderBasedName(original, place, fileCounts) {
  const sole = soleFolders(place.parts, fileCounts);
  const ancestors = [...place.parts].reverse();
  const detailed = detailedName(original, sole, titleStart(ancestors));
  if (detailed === original) return prefixedName(original, ancestors);
  return withOuterFolder(original, detailed, outerFolders(original, detailed, ancestors, sole.length));
}

// It chooses the name wanted for one file before numbers are added. It throws an FcError if the file cannot be planned.
function proposeName(entry, order, access, naming) {
  const original = path.basename(entry.path);
  const from = access.read(entry.path);
  // Attaching an extension to a folder name can exceed the length limit. It does not skip the file and goes back to the original name.
  const place = naming.placementOf(entry);
  let detailed = folderBasedName(original, place, naming.fileCounts);
  // It does not leave that name and add a number to make a third name.
  const twin = naming.topFiles.get(fileKey(from));
  if (twin) throw new FcError(`Not moved because the name already exists directly under the target: ${path.basename(twin)}${leftoverNote(from, twin)}`);
  if (detailed.length > MAX_NAME) detailed = original;
  // If the name with the distinguishing folder name attached exceeds the limit, it is not attached. The pair is tied by the name before attaching.
  const tagged = place.tags.length > 0 && detailed !== original ? withTags(detailed, original, place.tags) : detailed;
  return { entry, order, from, original, desired: tagged.length > MAX_NAME ? detailed : tagged, pairName: detailed };
}

// It first assigns names to the files that keep their original name (#63). So that a folder-name candidate (ABC-123 Title/x.mp4 -> ABC-123 Title.mp4)
// does not take the name of the file that originally has that name (z/ABC-123 Title.mp4) first and force a number on it. The order of equal ranks is the item order as it is.
// Pairs that received the same prefix in the same folder (ABC-123/video.mp4, video.en.srt -> ABC-123 video.*) are assigned even before that,
// so that even if they overlap with a file of the original name (z/ABC-123 video.mp4), a number is added to only one of the pair and the pair does not break (first review).
// The key is the attached prefix plus the part before the first dot of the original name. It does not cut at a dot in the prefix folder name (ABC-123 v1.5),
// and it also ties pairs split across subfolders (ABC-123/video.mp4, ABC-123/Subs/video.en.srt) (second review).
// A subtitle with the distinguishing folder name attached (Show video.Forced.srt) is tied to the video by the name before attaching (pairName) (#233).
function assignmentOrder(candidates) {
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
  const ranks = new Map(candidates.map((c) => [c, rank(c)]));
  return [...candidates].sort((a, b) => ranks.get(a) - ranks.get(b));
}

// It picks the free name for one candidate and returns the move. It throws an FcError if no name works.
function planMove(candidate, access, taken, nextNumber) {
  const { from, original } = candidate;
  let desired = candidate.desired;
  let name = freeName(desired, access.target, taken, nextNumber);
  if (name.length > MAX_NAME && desired !== original) {
    desired = original;
    name = freeName(desired, access.target, taken, nextNumber);
  }
  if (name.length > MAX_NAME) throw new FcError(`The name is too long once the number is added: ${name}`);
  const move = { from, to: access.write(name), name, desired, fromFolder: desired !== original, numbered: name !== desired };
  taken.add(nameKey(name));
  return move;
}

// It assigns names to all candidates at once. It returns the moves in item order and the skipped rows of the files whose name could not be assigned.
function assignNames(candidates, access, taken) {
  const nextNumber = new Map();
  const moves = new Map();
  const failed = [];
  for (const candidate of assignmentOrder(candidates)) {
    try {
      moves.set(candidate, planMove(candidate, access, taken, nextNumber));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      failed.push({ order: candidate.order, item: { path: candidate.entry.path, reason: err.message } });
    }
  }
  return { moves: candidates.filter((c) => moves.has(c)).map((c) => moves.get(c)), failed };
}

// It fills in the reasons of the folders left whole. It also returns rows for the folders to keep that have no files, which are reported as not deleted.
// Those inside another folder to keep were already reported by the outer folder.
function guardedReasons(classified, guarded, target, firstOrder) {
  for (const item of classified.guardItems.values()) {
    item.reason = `Not moving the ${item.count} items inside; the folder is left whole because it is a ${item.label}.`;
    delete item.label;
    delete item.count;
  }
  const rows = [];
  for (const [relative, label] of guarded) {
    if (!classified.guardItems.has(relative) && guardOf(relative, guarded) === relative) rows.push({ order: firstOrder + rows.length, item: { path: path.join(target, relative), reason: `Folder left whole because it is a ${label}.` } });
  }
  return rows;
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
  const classified = classifyEntries(entries, access.target, guarded, attributes);
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
  const naming = { placementOf, fileCounts: countFiles(entries, (entry) => placementOf(entry).parts), topFiles: topLevelFiles(entries) };
  const skipped = classified.skipped;
  const candidates = [];
  for (const { entry, order } of classified.files) {
    try {
      candidates.push(proposeName(entry, order, access, naming));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      skipped.push({ order, item: { path: entry.path, reason: err.message } });
    }
  }
  const taken = new Set(entries.filter(isTop).map((entry) => nameKey(entry.relative)));
  const { moves, failed } = assignNames(candidates, access, taken);
  skipped.push(...failed, ...guardedReasons(classified, guarded, access.target, entries.length));
  // Every row keeps the position of the entry it came from, so a stable sort restores the walk order.
  skipped.sort((a, b) => a.order - b.order);
  return { target: access.target, moves, stay: classified.stay, skipped: skipped.map((row) => row.item), guarded: new Set(guarded.keys()) };
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

// The reason the Recycle Bin cannot be used for this target (a non-interactive session, a drive that is not fixed, "remove immediately"), or undefined if it can.
function recycleBlock(target) {
  const state = recycleBinState(target);
  if (state.interactive === false) return 'Cannot send to the Recycle Bin outside an interactive session.';
  if (state.driveType !== 'Fixed') return `Empty folders were not deleted because the drive (${state.driveType ?? 'unknown type'}) may have no Recycle Bin and they could be permanently deleted.`;
  // It is an empty folder so the size does not matter, but if the Recycle Bin setting is "remove immediately", it is deleted permanently (#81, confirmed on build 26200).
  if (state.nukeOnDelete === true) return 'Empty folders were not deleted because this volume is set to remove files immediately, so they would be permanently deleted without using the Recycle Bin.';
  return undefined;
}

// The preview of removeFolders: it runs the same checks as a real run for each folder and reports the result without deleting.
function previewFolders(folders, access, blocked, done, failure) {
  for (const folder of folders) {
    if (blocked) {
      done(folder, blocked);
      continue;
    }
    try {
      remove([checkFolder(folder, access, { dryRun: true })], { dryRun: true, checkVolume: false });
      done(folder);
    } catch (err) {
      done(folder, failure(err));
    }
  }
}

// It reports the per-folder results of one Recycle Bin batch through done and returns the folders left untouched (pending) to queue up again.
function settleBatch(results, done) {
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
  return pending;
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
  let blocked = recycleBlock(access.target);
  const failure = (err) => (err instanceof FcError ? err.message : `Cannot send to the Recycle Bin. (${err.code ?? err.status})`);
  if (dryRun) {
    previewFolders(folders, access, blocked, done, failure);
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
    const pending = settleBatch(results, done);
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

module.exports = { withOuterFolder, FOLDER_METADATA, planFlatten, detailedName, prefixedName, flatten, formatFlatten };
