'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The tails of the names that download tools use while downloading. While downloading x.mp4, they are attached after the file name, as x.mp4.part and x.mp4.aria2.
// .part: Firefox, yt-dlp, JDownloader, Transmission / .crdownload: Chrome, Edge / .partial: old Edge / .download: Safari / .opdownload: Opera
// .fdmdownload: Free Download Manager / .aria2: aria2 / .ytdl, .part-Frag<number>: yt-dlp / .td, .td.cfg, .xltd: Thunder / .!qB: qBittorrent / .!ut: uTorrent / .bc!: BitComet
// Many tools use this name for the content being downloaded itself, but some also keep a file of their own name alongside. aria2 keeps x.mp4.aria2 beside the size-reserved x.mp4,
// and Firefox keeps x.mp4.part beside the size-0 placeholder file x.mp4. Such an x.mp4 cannot be told by its time when it stays stalled for long, so it can only be told by this marker.
const DOWNLOAD_MARKER = /^(.+?)\.(?:part(?:-frag\d+)?|crdownload|partial|download|opdownload|fdmdownload|aria2|ytdl|td(?:\.cfg)?|xltd|!qb|!ut|bc!)$/i;

// It collects the marker files in a folder so they can be looked up by the name of the file being downloaded (lower case). Windows is case-insensitive about names.
function downloadMarkers(dir) {
  const markers = new Map();
  for (const name of fs.readdirSync(dir)) {
    const match = DOWNLOAD_MARKER.exec(name);
    if (match && !markers.has(match[1].toLowerCase())) markers.set(match[1].toLowerCase(), name);
  }
  return markers;
}

// It makes a function that looks for a marker that a file may be downloading. It reads the marker file list only once per folder.
// The returned function returns null if there is no marker, and if there is, one of { folder } (inside a Safari marker folder), { marker } (the name of the marker file beside it),
// and { error } (the folder could not be read, an error code). It also remembers a folder that could not be read and treats all files of that folder as having a marker.
function markerFinder() {
  const markersIn = new Map();
  return (file) => {
    const dir = path.dirname(file);
    const name = path.basename(file).toLowerCase();
    // Safari keeps a file being downloaded as x.mp4 inside an x.mp4.download folder.
    if (path.basename(dir).toLowerCase() === `${name}.download`) return { folder: path.basename(dir) };
    if (!markersIn.has(dir)) {
      try {
        markersIn.set(dir, downloadMarkers(dir));
      } catch (err) {
        markersIn.set(dir, err);
      }
    }
    const markers = markersIn.get(dir);
    if (markers instanceof Error) return { error: markers.code ?? markers.message };
    const marker = markers.get(name);
    return marker === undefined ? null : { marker };
  };
}

// It uses the marker markerFinder found as the reason for keeping. If keeper is given, it writes it as the marker of the file to keep.
function markerReason(found, { keeper = false } = {}) {
  if (found === null) return null;
  if (found.folder !== undefined) return `Kept because ${keeper ? 'the file to keep is' : 'the file is'} inside the download tool's marker folder (${found.folder}) and may still be downloading.`;
  if (found.error !== undefined) return `Kept because the folder ${keeper ? 'of the file to keep ' : ''}could not be read to check for the download tool's marker file. (${found.error})`;
  return `Kept because the download tool's marker file (${found.marker}) is next to ${keeper ? 'the file to keep' : 'the file'} and it may still be downloading. If you gave up the download, delete the marker file and run again.`;
}

module.exports = { DOWNLOAD_MARKER, downloadMarkers, markerFinder, markerReason };
