'use strict';

// sort-photos (#389): photos go into YYYY/YYYY-MM folders by the date taken stored in the photo (EXIF), and screenshots into Screenshots.
// A photo without a date taken falls back to the modified time and the report says so. It builds its plan with the shared sort engine (src/sort.js).
const path = require('node:path');
const { planSortWith, applySort, monthFolder } = require('./sort');
const { readTakenDate } = require('./exif');

const PHOTO_EXTENSIONS = new Set('.jpg .jpeg .png .heic .heif .tif .tiff .webp .dng .cr2 .nef .arw'.split(' '));
const SCREENSHOTS_FOLDER = 'Screenshots';

// File names the screenshot tools give: Windows (Screenshot 2026-11-05 ..., 스크린샷, 화면 캡처), Android (Screenshot_), macOS (Screen Shot ...).
// The English names need a separator, a digit or the extension after them, so a photo called Screenshots_from_trip.jpg or screenshot-lake.jpg is not taken for one.
const SCREENSHOT_NAME = /^(?:(?:screenshot|screen[ _]shot)(?:[_ (]|\d|\.\w+$)|스크린샷|화면 캡처)/i;

const FALLBACK_NOTE = 'no date taken, used the modified time';
// HEIC/HEIF may well have a date taken that src/exif.js does not parse, so the report must not say there is none.
const UNREAD_FORMAT_NOTE = 'date taken not read for this format, used the modified time';
const UNREAD_FORMATS = new Set(['.heic', '.heif']);

function photoFolder(file) {
  if (!PHOTO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) return { ignore: true };
  if (SCREENSHOT_NAME.test(file.name)) return { folder: SCREENSHOTS_FOLDER };
  const taken = readTakenDate(file.real);
  if (taken) return { folder: `${taken.year}/${taken.year}-${String(taken.month).padStart(2, '0')}` };
  const month = monthFolder(file.stat.mtime);
  return { folder: `${month.slice(0, 4)}/${month}`, note: UNREAD_FORMATS.has(path.extname(file.name).toLowerCase()) ? UNREAD_FORMAT_NOTE : FALLBACK_NOTE };
}

function sortPhotos(dir, { dryRun = false, recursive = false } = {}) {
  return applySort(planSortWith(dir, photoFolder, { recursive }), { dryRun });
}

module.exports = { PHOTO_EXTENSIONS, SCREENSHOT_NAME, FALLBACK_NOTE, UNREAD_FORMAT_NOTE, photoFolder, sortPhotos };
