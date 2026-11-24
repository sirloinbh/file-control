'use strict';

// Sidecar files (#399): the subtitle, thumbnail and note files that belong to a video and share its base name (abc-123.mp4 -> abc-123.srt, abc-123.ko.srt, abc-123.jpg, abc-123.nfo).
// When a video is renamed, moved, or removed, its sidecars get the same change, so players keep pairing them.
//
// The rule, in one place:
// - Same folder, and the name is the video's base name followed by a known sidecar extension.
// - A subtitle may carry a language tag before its extension: abc-123.ko.srt, abc-123.en-US.vtt. Other sidecars (.nfo, images) do not.
// - Only regular files count; links and folders never do.
// - If another video in the folder has the same base name (a.mp4 and a.mkv) or a longer base that makes the file its own (a.en.mp4 owns a.en.srt), the file is not this video's sidecar,
//   because moving it along would take it away from the other video.

const fs = require('node:fs');
const path = require('node:path');

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.smi', '.ass', '.ssa', '.vtt', '.sub', '.idx']);
const OTHER_EXTENSIONS = new Set(['.nfo', '.jpg', '.jpeg', '.png', '.webp']);
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

// Required at use time: video.js loads target.js and commands.js, and this file is loaded by commands.js (recycle.js).
const videoExtensions = () => require('./video').VIDEO_EXTENSIONS;
const isVideoName = (name) => videoExtensions().has(path.extname(name).toLowerCase());

// Whether `file` is a video file that can have sidecars (by extension; .ts and .mts need a content check and are not included).
function isVideoPath(file) {
  return isVideoName(file) && fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

// The sidecars of one video file: [{ path, suffix }]. suffix is what follows the base name (".srt", ".ko.srt"), so the same suffix goes after the new base name.
function findSidecars(video) {
  if (!isVideoName(video)) return [];
  const dir = path.dirname(video);
  const own = path.basename(video);
  const base = path.basename(own, path.extname(own));
  const lowBase = base.toLowerCase();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const videoBases = names.filter(isVideoName).map((name) => ({ name, base: path.basename(name, path.extname(name)).toLowerCase() }));
  // Another video with the same base name would lose its subtitle if this video took it away.
  if (videoBases.some((other) => other.name.toLowerCase() !== own.toLowerCase() && other.base === lowBase)) return [];
  const found = [];
  for (const name of names) {
    if (!name.toLowerCase().startsWith(`${lowBase}.`)) continue;
    const suffix = name.slice(base.length);
    // path.extname('.srt') is '' (a name that starts with a dot has no extension), so the last dot is used.
    const extension = suffix.slice(suffix.lastIndexOf('.')).toLowerCase();
    const middle = suffix.slice(0, suffix.length - extension.length);
    const subtitle = SUBTITLE_EXTENSIONS.has(extension) && (middle === '' || LANGUAGE_TAG.test(middle.slice(1)));
    const other = OTHER_EXTENSIONS.has(extension) && middle === '';
    if (!subtitle && !other) continue;
    // abc.en.srt belongs to abc.en.mp4 when that video exists.
    if (middle !== '' && videoBases.some((v) => v.base === `${lowBase}${middle.toLowerCase()}`)) continue;
    const full = path.join(dir, name);
    if (fs.lstatSync(full, { throwIfNoEntry: false })?.isFile() === true) found.push({ path: full, suffix });
  }
  return found.sort((a, b) => (a.suffix < b.suffix ? -1 : 1));
}

// Where a sidecar goes when its video goes to videoTo: next to the new video, with the new base name and the same suffix.
function sidecarTarget(videoTo, sidecar) {
  const extension = path.extname(videoTo);
  return path.join(path.dirname(videoTo), path.basename(videoTo, extension) + sidecar.suffix);
}

// The sidecar moves of a video move: [{ from, to, suffix }].
function sidecarMoves(videoFrom, videoTo) {
  return findSidecars(videoFrom).map((sidecar) => ({ from: sidecar.path, to: sidecarTarget(videoTo, sidecar), suffix: sidecar.suffix }));
}

// Whether two paths are the same item (a rename that only changes the case leads to itself).
function sameItem(a, b) {
  const one = fs.lstatSync(a, { bigint: true, throwIfNoEntry: false });
  const two = fs.lstatSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(one && two) && one.ino !== 0n && one.ino === two.ino && one.dev === two.dev;
}

// The first reason a group of sidecar moves cannot all happen, or null. A name that is taken (by anything but the sidecar itself) is a clash for the whole group.
// claimed is a Set of target names (lower case) already used by other moves of the same plan.
function clashOf(moves, claimed = new Set()) {
  for (const move of moves) {
    const key = move.to.toLowerCase();
    if (claimed.has(key)) return `Another file would get the same name: ${path.basename(move.to)}`;
    if (fs.lstatSync(move.to, { throwIfNoEntry: false }) && !sameItem(move.from, move.to)) return `The name already exists: ${path.basename(move.to)}`;
  }
  for (const move of moves) claimed.add(move.to.toLowerCase());
  return null;
}

// The targets of a removal with the sidecars of each video added right after it (those already in the list are not added twice).
function withSidecarPaths(targets) {
  const listed = new Set(targets.map((target) => path.resolve(target).toLowerCase()));
  const result = [];
  for (const target of targets) {
    result.push(target);
    if (!isVideoPath(target)) continue;
    for (const sidecar of findSidecars(path.resolve(target))) {
      if (!listed.has(sidecar.path.toLowerCase())) {
        listed.add(sidecar.path.toLowerCase());
        result.push(sidecar.path);
      }
    }
  }
  return result;
}

module.exports = { withSidecarPaths, SUBTITLE_EXTENSIONS, OTHER_EXTENSIONS, isVideoPath, findSidecars, sidecarTarget, sidecarMoves, clashOf, sameItem };
