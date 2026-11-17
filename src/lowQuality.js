'use strict';

const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk, fileSizeInside } = require('./target');
const { LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');
const { VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS, isTransportStream } = require('./productName');
const { describeVideo } = require('./duplicates');
const { readMp4Metadata } = require('./mp4');
const { readMkvMetadata } = require('./mkv');

// The default and range of the low-quality standard (#30). If the shorter side of the screen is under 360 pixels, it is seen as low quality. The bitrate standard is not looked at unless given.
// The bitrate varies a lot by codec and content, so it is hard to set a default.
const DEFAULT_MIN_HEIGHT = 360;
const HEIGHT_LIMIT = 100000;
const BITRATE_LIMIT = 1000000;

// It checks whether the metadata values are in the normal range (#30 comment, PR #68 review). It keeps a broken value from being caught as low quality and becoming a deletion candidate.
// - Screen size: a shorter side under 16 pixels is not used as video, so it is seen as a broken value. A longer side over 65535 is the same.
//   If the visible size differs greatly from the encoded resolution (comparing shorter sides and longer sides, more than a 2x difference), it is seen as a broken value (first review).
//   MP4 uses the tkhd screen size as the visible size if the ratio differs, so if tkhd is broken and 1920x1080 looks like 1920x100, a normal file would be caught as low quality.
//   Normal pixel aspect ratios (720x480 -> 853x480, 1440x1080 -> 1920x1080, 2:1 anamorphic) and 90 and 270 degree rotation are within this range.
// - Length: over 7 days is a broken length value (an abnormal timescale gives trillions of seconds). Then the bitrate computed from the file size gets close to 0.
// - Bitrate: if the length is under 1 second, the head structure has a large share, so it is not trusted. Under 1kbps is a value that video cannot hold, so it is seen as a broken value.
const MIN_SIDE = 16;
const MAX_SIDE = 65535;
const MAX_DISPLAY_SCALE = 2;
const MAX_DURATION = 7 * 24 * 60 * 60;
const MIN_BITRATE_DURATION = 1;
const MIN_BITRATE = 1000;

const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);
const MKV_EXTENSIONS = new Set(['.mkv', '.webm']);

// It checks the option values and returns { minHeight, minBitrate }. minBitrate is in kbps, and if null, the bitrate is not looked at.
// The value is an integer or a string received on the command line ("480"). A string is accepted only if it is all digits.
function lowQualityCriteria({ minHeight = DEFAULT_MIN_HEIGHT, minBitrate = null } = {}) {
  const check = (value, name, limit) => {
    const number = typeof value === 'string' ? (/^\d+$/.test(value) ? Number(value) : Number.NaN) : value;
    if (!Number.isInteger(number) || number < 1 || number > limit) throw new FcError(`${name} must be an integer from 1 to ${limit}: ${JSON.stringify(value)}`);
    return number;
  };
  return {
    minHeight: check(minHeight, '--min-height', HEIGHT_LIMIT),
    minBitrate: minBitrate === null ? null : check(minBitrate, '--min-bitrate', BITRATE_LIMIT),
  };
}

// It turns the read metadata into { shortSide, width, height, displayWidth, displayHeight, duration, bitrate, notes }, keeping only values in the normal range.
// A value out of range is left null and the reason is written in notes. It is a pure function.
function saneInfo(info) {
  const notes = [];
  const number = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  let width = number(info.width);
  let height = number(info.height);
  let displayWidth = number(info.displayWidth);
  let displayHeight = number(info.displayHeight);
  if (displayWidth === null || displayHeight === null) [displayWidth, displayHeight] = [width, height];
  let shortSide = null;
  if (displayWidth !== null && displayHeight !== null && width !== null && height !== null) {
    const sides = [width, height, displayWidth, displayHeight];
    const coded = [width, height].sort((a, b) => a - b);
    const shown = [displayWidth, displayHeight].sort((a, b) => a - b);
    const scaled = coded.some((side, index) => Math.max(side, shown[index]) / Math.min(side, shown[index]) > MAX_DISPLAY_SCALE);
    if (Math.min(...sides) < MIN_SIDE || Math.max(...sides) > MAX_SIDE || scaled) {
      notes.push(`The resolution value (${width}x${height}, displayed size ${displayWidth}x${displayHeight}) is outside the normal range and may be corrupt.`);
      width = height = displayWidth = displayHeight = null;
    } else {
      shortSide = Math.min(displayWidth, displayHeight);
    }
  } else {
    notes.push('There is no resolution information.');
  }
  let duration = number(info.duration);
  if (duration !== null && duration > MAX_DURATION) {
    notes.push(`The duration value (${Math.round(duration)} s) is over 7 days and may be corrupt.`);
    duration = null;
  }
  let bitrate = duration === null || duration < MIN_BITRATE_DURATION ? null : number(info.bitrate);
  // The case where, in reading, the length was cross-checked against the tracks and the real data and could not be trusted (a partly downloaded file, a broken length, #179)
  if (duration !== null && typeof info.bitrateNote === 'string') {
    notes.push(info.bitrateNote);
    bitrate = null;
  }
  if (bitrate !== null && bitrate < MIN_BITRATE) {
    notes.push(`The bitrate value (${bitrate} bps) is too small and may be corrupt.`);
    bitrate = null;
  }
  if (bitrate === null && !notes.some((note) => /duration|bitrate/i.test(note))) notes.push(duration === null ? 'There is no duration information, so the bitrate is unknown.' : duration < MIN_BITRATE_DURATION ? 'The duration is under 1 second, so the bitrate cannot be trusted.' : 'There is no bitrate information.');
  return { width, height, displayWidth, displayHeight, shortSide, duration, bitrate, notes };
}

// It judges by the standard. It is a pure function. It returns { status: 'low' | 'ok' | 'unknown', reasons }.
// If low quality, it also returns whether it was caught by resolution (byResolution). A file caught only by bitrate may have a broken length, so it is not deleted (#31, #179).
// If it is below any one standard, it is low quality. If no standard is below and the value is unknown for any one of the standards to look at, it is could not judge.
function judgeQuality(info, criteria) {
  const reasons = [];
  const unknown = [];
  if (info.shortSide === null) unknown.push('resolution');
  else if (info.shortSide < criteria.minHeight) reasons.push(`short side ${info.shortSide} px < ${criteria.minHeight}`);
  if (criteria.minBitrate !== null) {
    if (info.bitrate === null) unknown.push('bitrate');
    else if (info.bitrate < criteria.minBitrate * 1000) reasons.push(`bitrate ${Math.round(info.bitrate / 1000)} kbps < ${criteria.minBitrate} kbps`);
  }
  if (reasons.length > 0) return { status: 'low', reasons, byResolution: info.shortSide !== null && info.shortSide < criteria.minHeight };
  if (unknown.length > 0) return { status: 'unknown', reasons: [`Could not judge because the ${unknown.join(' and ')} could not be determined.`, ...info.notes] };
  return { status: 'ok', reasons: [] };
}

function skipReason(parts) {
  if (parts.some((part) => LEFTOVER.test(part))) return 'Not checked because it is a leftover from an earlier job.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Not checked because it is inside a Windows system folder.';
  return null;
}

// It finds low-quality files below the standard among the videos under the target. It does not touch files.
// The formats it reads the resolution and bitrate from are MP4/MOV and MKV/WebM. Other videos are reported as could not judge. It does not look inside repository folders.
// - low: low-quality files ({ path, size, width, height, displayWidth, displayHeight, duration, bitrate, reasons, byResolution })
// - unreadable: videos that could not be judged ({ path, reason })
// - skipped: links, leftovers, system folders ({ path, reason })
// - checked: the number of videos read, criteria: the standards used
function findLowQuality(dir, options = {}) {
  const criteria = lowQualityCriteria(options);
  const access = grant(dir, ['read']);
  const result = { target: access.target, criteria, low: [], unreadable: [], skipped: [], checked: 0 };
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => REPOSITORY_FOLDER.test(part))) continue;
    if (entry.type === 'link') {
      result.skipped.push({ path: entry.path, reason: 'Links are not checked.' });
      continue;
    }
    const extension = path.extname(entry.path).toLowerCase();
    const transport = TRANSPORT_EXTENSIONS.has(extension);
    if (!VIDEO_EXTENSIONS.has(extension) && !transport) continue;
    try {
      if (transport && !isTransportStream(access.target, entry.relative)) continue;
      const skip = skipReason(parts);
      if (skip !== null) {
        result.skipped.push({ path: entry.path, reason: skip });
        continue;
      }
      const real = access.read(entry.path);
      result.checked += 1;
      const reader = MP4_EXTENSIONS.has(extension) ? readMp4Metadata : MKV_EXTENSIONS.has(extension) ? readMkvMetadata : null;
      if (reader === null) {
        result.unreadable.push({ path: real, reason: `Cannot read the resolution of the ${extension} format.` });
        continue;
      }
      const size = fileSizeInside(access.target, real);
      // The bitrate is used for the judgment, so it has the length cross-checked with the sample table and the seek table (#207).
      const info = saneInfo(reader(access.target, real, { verifyBitrate: true }));
      const judged = judgeQuality(info, criteria);
      if (judged.status === 'unknown') result.unreadable.push({ path: real, reason: judged.reasons.join(' ') });
      if (judged.status !== 'low') continue;
      const { width, height, displayWidth, displayHeight, duration, bitrate } = info;
      result.low.push({ path: real, size, width, height, displayWidth, displayHeight, duration, bitrate, reasons: judged.reasons, byResolution: judged.byResolution });
    } catch (err) {
      result.unreadable.push({ path: entry.path, reason: err instanceof FcError ? err.message : `Cannot read the file. (${err.code ?? err.message})` });
    }
  }
  return result;
}

// It attaches the bitrate to the video description. 10.0MB, 640x352, 1:00, 800kbps
function describeLowQuality(file) {
  const base = describeVideo(file);
  return file.bitrate === null ? base : `${base}, ${Math.round(file.bitrate / 1000)}kbps`;
}

function criteriaText(criteria) {
  const parts = [`short side ${criteria.minHeight} px`];
  if (criteria.minBitrate !== null) parts.push(`bitrate ${criteria.minBitrate} kbps`);
  return `below ${parts.join(' or ')}`;
}

function formatLowQuality(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [`Criteria: ${criteriaText(result.criteria)}`];
  for (const file of result.low) lines.push(`Low quality: ${relative(file.path)} (${describeLowQuality(file)}) [${file.reasons.join(', ')}]`);
  for (const item of result.unreadable) lines.push(`Undetermined: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  lines.push(`Checked ${result.checked} videos, ${result.low.length} low quality, ${result.unreadable.length} undetermined, ${result.skipped.length} skipped`);
  return lines.join('\n');
}

module.exports = { lowQualityCriteria, saneInfo, judgeQuality, findLowQuality, formatLowQuality, describeLowQuality, criteriaText, DEFAULT_MIN_HEIGHT };
