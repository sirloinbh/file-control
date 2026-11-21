'use strict';

const { readRange } = require('./target');
const { halfWidth } = require('./product');
const { formatSize } = require('./commands');

// It handles only video files. It does not rename even the subtitles or notes inside an ABC-123 folder.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.m2ts', '.mpg', '.mpeg']);
// A format whose extension is the same as TypeScript source. It is seen as video only after checking the content.
const TRANSPORT_EXTENSIONS = new Set(['.ts', '.mts']);
// MPEG-TS starts with 0x47 every 188 bytes, and AVCHD, with 4 extra bytes in front, every 192 bytes.
const TRANSPORT_LAYOUTS = [
  [0, 188],
  [4, 192],
];
const TRANSPORT_HEAD = 4 + 2 * 192 + 1;

function isTransportStream(access, relative) {
  const head = readRange(access, relative, { length: TRANSPORT_HEAD });
  return TRANSPORT_LAYOUTS.some(([start, step]) => head[start] === 0x47 && head[start + step] === 0x47 && head[start + 2 * step] === 0x47);
}

// Even if letters are attached to the number (ABC-123-01, ABC-123A, 1ABC-123), it is seen as already present. ABC-1234 is not ABC-123.
function containsNumber(name, number) {
  // number is only English upper-case letters, a hyphen, and digits, so it can go into a regular expression as is.
  return new RegExp(`(?<!\\p{Script=Latin}\\p{M}*)${number}(?!\\d)`, 'u').test(halfWidth(name).toUpperCase());
}

// It writes seconds as h:mm:ss or m:ss.
function formatDuration(seconds) {
  const total = Math.round(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (value) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// A short description of a video: size, resolution and duration.
function describeVideo(file) {
  const parts = [formatSize(file.size)];
  if (file.width !== null && file.height !== null) {
    // If the visible size differs because of rotation or pixel aspect ratio, it writes both. 1920x1080 (displayed size 1080x1920)
    const shown = file.displayWidth != null && file.displayHeight != null && (file.displayWidth !== file.width || file.displayHeight !== file.height);
    parts.push(shown ? `${file.width}x${file.height} (displayed size ${file.displayWidth}x${file.displayHeight})` : `${file.width}x${file.height}`);
  }
  if (file.duration !== null) parts.push(formatDuration(file.duration));
  return parts.join(', ');
}

module.exports = { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS, isTransportStream, containsNumber, formatDuration, describeVideo };
