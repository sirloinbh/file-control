'use strict';

const { FcError } = require('./commands');
const { grant } = require('./target');
const { withOpenFile } = require('./openedFile');

const ID = {
  EBML: 0x1a45dfa3,
  DOC_TYPE: 0x4282,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TITLE: 0x7ba9,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  DISPLAY_WIDTH: 0x54b0,
  DISPLAY_HEIGHT: 0x54ba,
  DISPLAY_UNIT: 0x54b2,
  PIXEL_CROP_BOTTOM: 0x54aa,
  PIXEL_CROP_TOP: 0x54bb,
  PIXEL_CROP_LEFT: 0x54cc,
  PIXEL_CROP_RIGHT: 0x54dd,
  PROJECTION: 0x7670,
  PROJECTION_TYPE: 0x7671,
  PROJECTION_POSE_YAW: 0x7673,
  PROJECTION_POSE_PITCH: 0x7674,
  PROJECTION_POSE_ROLL: 0x7675,
  TAGS: 0x1254c367,
  TAG: 0x7373,
  TARGETS: 0x63c0,
  TARGET_TYPE_VALUE: 0x68ca,
  TAG_TRACK_UID: 0x63c5,
  TAG_EDITION_UID: 0x63c9,
  TAG_CHAPTER_UID: 0x63c4,
  TAG_ATTACHMENT_UID: 0x63c6,
  SIMPLE_TAG: 0x67c8,
  TAG_NAME: 0x45a3,
  TAG_STRING: 0x4487,
  CLUSTER: 0x1f43b675,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_CLUSTER_POSITION: 0xf1,
};

const WANTED = new Set([ID.SEEK_HEAD, ID.INFO, ID.TRACKS, ID.TAGS, ID.CUES]);
// Elements that can appear anywhere (Void, CRC-32)
const GLOBAL_ELEMENTS = new Set([0xec, 0xbf]);
// The limit of reads needed to find the head elements. Even if a damaged file lines up small elements endlessly, it stops.
const MAX_READS = 20000;
// The limit for loading one element into memory. If larger, it is treated as absent. The Info, Tracks, and Tags of a normal file are much smaller than this.
const MAX_ELEMENT = 16 * 1024 * 1024;
// The limit of the total amount read from one file. Even if an overlapping SeekHead makes it read the same content repeatedly, memory does not run out.
const MAX_TOTAL = 64 * 1024 * 1024;
// The limit of the number of entries taken from SeekHead. A normal file has about ten.
const MAX_SEEK = 1024;
const MAX_TEXT = 64 * 1024;
const MAX_HEADER = 12;
const DEFAULT_SCALE = 1000000;
const VIDEO_TRACK = 1;
// The movie or episode level. If there is no value, it is this level. 70 is a collection, and 30 is a track or chapter, so it is not the file's title.
const MOVIE_LEVEL = 50;

// The position of the first 1 bit of the leading byte decides the length. If wrong, it is null.
function vintLength(first, max) {
  for (let length = 1; length <= max; length += 1) {
    if (first & (0x80 >> (length - 1))) return length;
  }
  return null;
}

// It decodes an element header and returns { id, start, size }. If size is null, it is an element of unknown size. If wrong, it is null.
function readHeader(buffer, offset) {
  if (offset >= buffer.length) return null;
  const idLength = vintLength(buffer[offset], 4);
  if (idLength === null || offset + idLength >= buffer.length) return null;
  const id = buffer.readUIntBE(offset, idLength);
  const sizeOffset = offset + idLength;
  const sizeLength = vintLength(buffer[sizeOffset], 8);
  if (sizeLength === null || sizeOffset + sizeLength > buffer.length) return null;
  let value = BigInt(buffer[sizeOffset] & (0xff >> sizeLength));
  let unknown = value === BigInt(0xff >> sizeLength);
  for (let index = 1; index < sizeLength; index += 1) {
    value = (value << 8n) | BigInt(buffer[sizeOffset + index]);
    if (buffer[sizeOffset + index] !== 0xff) unknown = false;
  }
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { id, start: sizeOffset + sizeLength, size: unknown ? null : Number(value) };
}

// It yields the children of an element loaded into memory in order. If the structure is off, it stops there. Values found so far can be used.
function* children(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const header = readHeader(buffer, offset);
    if (!header || header.size === null || header.start + header.size > buffer.length) return;
    yield { id: header.id, body: buffer.subarray(header.start, header.start + header.size) };
    offset = header.start + header.size;
  }
}

function readUint(body) {
  if (body.length === 0 || body.length > 8) return null;
  let value = 0n;
  for (const byte of body) value = (value << 8n) | BigInt(byte);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function readFloat(body) {
  let value = null;
  if (body.length === 4) value = body.readFloatBE(0);
  if (body.length === 8) value = body.readDoubleBE(0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readText(body) {
  if (body.length === 0 || body.length > MAX_TEXT) return null;
  const end = body.indexOf(0);
  const text = body.toString('utf8', 0, end === -1 ? body.length : end).trim();
  return text === '' ? null : text;
}

function parseInfo(body, found) {
  let scale = DEFAULT_SCALE;
  let ticks = null;
  for (const child of children(body)) {
    // An empty element is read as the default. 0 is a specification violation, so it is treated as absent.
    if (child.id === ID.TIMECODE_SCALE) scale = child.body.length === 0 ? DEFAULT_SCALE : readUint(child.body) || null;
    if (child.id === ID.DURATION) ticks = readFloat(child.body);
    if (child.id === ID.TITLE) found.title ??= readText(child.body);
  }
  const seconds = ticks !== null && scale !== null ? (ticks * scale) / 1e9 : null;
  if (Number.isFinite(seconds) && seconds > 0) found.duration ??= seconds;
  found.scale ??= scale;
}

// From the seek table (Cues), it gathers the latest time (in time units) and the position of the last Cluster (bytes inside the Segment) (#179).
// The seek table usually has an entry for each keyframe of the video, so the last entry is near the end of the video.
function parseCues(body, found) {
  for (const point of children(body)) {
    if (point.id !== ID.CUE_POINT) continue;
    found.cuePoints = (found.cuePoints ?? 0) + 1;
    for (const child of children(point.body)) {
      if (child.id === ID.CUE_TIME) {
        const time = readUint(child.body);
        if (time !== null) found.lastCue = Math.max(found.lastCue ?? 0, time);
      }
      if (child.id !== ID.CUE_TRACK_POSITIONS) continue;
      for (const part of children(child.body)) {
        const position = part.id === ID.CUE_CLUSTER_POSITION ? readUint(part.body) : null;
        if (position !== null) found.lastCluster = Math.max(found.lastCluster ?? 0, position);
      }
    }
  }
}

// If the bitrate computed from the header length cannot be trusted, it returns the reason; if it can be trusted, null (#179).
// - If the Segment size or a position that SeekHead or the seek table points to goes past the end of the file, it is a partly downloaded file. The written file size is small and the bitrate comes out low.
// - If the written length is longer than 2 times the last time of the seek table plus 60 seconds, the length is seen as broken. The keyframe interval is shorter than this.
//   A written length that is shorter gives a high bitrate and is not wrongly caught as low quality, so it is not looked at.
// If the seek table is absent, has only one entry, or has a last time of 0, the length is not cross-checked. A screen recording that put keyframes only at the start and
// a music file that has a single still picture as a video track are such cases (first review). Finding the last Cluster would require scanning the video data, so it is not looked at.
function bitrateDoubt(found, beyondEnd, duration) {
  if (beyondEnd) return 'The Segment size or an element position runs past the end of the file, so it may be a partial download and the bitrate cannot be trusted.';
  if (!found.lastCue || (found.cuePoints ?? 0) < 2 || !found.scale) return null;
  const cueSeconds = (found.lastCue * found.scale) / 1e9;
  if (duration > cueSeconds * 2 + 60) return `The duration value (${Math.round(duration)} s) is much longer than the last time in the seek table (${Math.round(cueSeconds)} s), so the bitrate cannot be trusted.`;
  return null;
}

// A signed real number. An empty element has the default 0. If it cannot be read, it is null.
function readSignedFloat(body) {
  if (body.length === 0) return 0;
  let value = null;
  if (body.length === 4) value = body.readFloatBE(0);
  if (body.length === 8) value = body.readDoubleBE(0);
  return Number.isFinite(value) ? value : null;
}

// The visible size. It first subtracts the pixels to crop (PixelCrop). DisplayWidth and DisplayHeight are the size after cropping, and if absent they equal the cropped size (the default in the specification, #113).
// If the unit (DisplayUnit) is pixels (0), it uses the value; for cm (1), inches (2), or aspect ratio (3), only the ratio has meaning, so it fits the height to the cropped height.
// If the unit is unknown (4 and so on), it uses the cropped size. In pixel units, if only one side exists, the other side uses the cropped size (the default in the specification).
// Non-pixel units have no default, so if only one side exists, the ratio cannot be known, so it uses the cropped size.
// If no pixels would remain after cropping, the value is wrong, so it does not crop.
function displaySize(width, height, shownWidth, shownHeight, unit, crop) {
  const croppedWidth = width - crop.left - crop.right;
  const croppedHeight = height - crop.top - crop.bottom;
  const [baseWidth, baseHeight] = croppedWidth > 0 && croppedHeight > 0 ? [croppedWidth, croppedHeight] : [width, height];
  if (unit === null || unit > 3 || (!shownWidth && !shownHeight)) return [baseWidth, baseHeight];
  if (unit !== 0 && (!shownWidth || !shownHeight)) return [baseWidth, baseHeight];
  const [w, h] = [shownWidth || baseWidth, shownHeight || baseHeight];
  if (unit === 0) return [w, h];
  return [Math.max(1, Math.round((baseHeight * w) / h)), baseHeight];
}

// True if the rotation of Projection is 90 or 270 degrees (#113). FFmpeg writes rotation information as ProjectionPoseRoll of a flat (ProjectionType 0) projection.
// A projection of 360-degree video (not flat), a projection tilted up and down (Pitch), and a projection turned left and right by an angle other than 180 degrees (Yaw) are not screen rotation, so it does not look at them.
// Roll is used only when it is within 1 degree of a multiple of 90. Other angles are seen as not swapping the width and height.
function projectionQuarterTurn(body) {
  let type = 0;
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  for (const child of children(body)) {
    if (child.id === ID.PROJECTION_TYPE) type = child.body.length === 0 ? 0 : readUint(child.body);
    if (child.id === ID.PROJECTION_POSE_YAW) yaw = readSignedFloat(child.body);
    if (child.id === ID.PROJECTION_POSE_PITCH) pitch = readSignedFloat(child.body);
    if (child.id === ID.PROJECTION_POSE_ROLL) roll = readSignedFloat(child.body);
  }
  if (type !== 0 || yaw === null || pitch === null || roll === null) return false;
  if (pitch !== 0 || (yaw !== 0 && Math.abs(yaw) !== 180)) return false;
  const turns = roll / 90;
  return Math.abs(turns - Math.round(turns)) * 90 < 1 && Math.abs(Math.round(turns)) % 2 === 1;
}

function parseTracks(body, found) {
  for (const track of children(body)) {
    if (track.id !== ID.TRACK_ENTRY) continue;
    let type = null;
    let video = null;
    for (const child of children(track.body)) {
      if (child.id === ID.TRACK_TYPE) type = readUint(child.body);
      if (child.id === ID.VIDEO) video = child.body;
    }
    if (type !== VIDEO_TRACK || !video) continue;
    let width = null;
    let height = null;
    let shownWidth = null;
    let shownHeight = null;
    let unit = 0;
    const crop = { top: 0, bottom: 0, left: 0, right: 0 };
    let quarterTurn = false;
    for (const child of children(video)) {
      if (child.id === ID.PIXEL_WIDTH) width = readUint(child.body);
      if (child.id === ID.PIXEL_HEIGHT) height = readUint(child.body);
      if (child.id === ID.DISPLAY_WIDTH) shownWidth = readUint(child.body);
      if (child.id === ID.DISPLAY_HEIGHT) shownHeight = readUint(child.body);
      // An empty element is the default (0, pixels).
      if (child.id === ID.DISPLAY_UNIT) unit = child.body.length === 0 ? 0 : readUint(child.body);
      // The default of the pixels to crop is 0. An unreadable value is also seen as 0.
      if (child.id === ID.PIXEL_CROP_TOP) crop.top = readUint(child.body) ?? 0;
      if (child.id === ID.PIXEL_CROP_BOTTOM) crop.bottom = readUint(child.body) ?? 0;
      if (child.id === ID.PIXEL_CROP_LEFT) crop.left = readUint(child.body) ?? 0;
      if (child.id === ID.PIXEL_CROP_RIGHT) crop.right = readUint(child.body) ?? 0;
      if (child.id === ID.PROJECTION) quarterTurn = projectionQuarterTurn(child.body);
    }
    // Even if a small video track such as a cover is in front, the largest track is counted as the main video.
    if (width && height && width * height > (found.width ?? 0) * (found.height ?? 0)) {
      found.width = width;
      found.height = height;
      const [shownW, shownH] = displaySize(width, height, shownWidth, shownHeight, unit, crop);
      [found.displayWidth, found.displayHeight] = quarterTurn ? [shownH, shownW] : [shownW, shownH];
    }
  }
}

// A tag attached to a specific track or chapter, or a tag that is not at the movie level, is not the file's title.
// A UID can be a 64-bit random number, so it is not converted to a number; it looks at whether there is a nonzero byte.
function isFileTag(targets) {
  if (!targets) return true;
  for (const child of children(targets)) {
    if ([ID.TAG_TRACK_UID, ID.TAG_EDITION_UID, ID.TAG_CHAPTER_UID, ID.TAG_ATTACHMENT_UID].includes(child.id) && child.body.some((byte) => byte !== 0)) return false;
    if (child.id === ID.TARGET_TYPE_VALUE && child.body.length > 0 && readUint(child.body) !== MOVIE_LEVEL) return false;
  }
  return true;
}

function parseTags(body, tags) {
  for (const tag of children(body)) {
    if (tag.id !== ID.TAG) continue;
    const parts = [...children(tag.body)];
    if (!isFileTag(parts.find((part) => part.id === ID.TARGETS)?.body)) continue;
    for (const simple of parts) {
      if (simple.id !== ID.SIMPLE_TAG) continue;
      let name = null;
      let value = null;
      for (const child of children(simple.body)) {
        if (child.id === ID.TAG_NAME) name = readText(child.body);
        if (child.id === ID.TAG_STRING) value = readText(child.body);
      }
      if (name && value && !tags.has(name.toUpperCase())) tags.set(name.toUpperCase(), value);
    }
  }
}

function parseSeekHead(body, positions) {
  for (const seek of children(body)) {
    if (seek.id !== ID.SEEK) continue;
    let id = null;
    let position = null;
    for (const child of children(seek.body)) {
      if (child.id === ID.SEEK_ID) id = readUint(child.body);
      if (child.id === ID.SEEK_POSITION) position = readUint(child.body);
    }
    if (!WANTED.has(id) || position === null || positions.length >= MAX_SEEK) continue;
    if (!positions.some((item) => item.id === id && item.position === position)) positions.push({ id, position });
  }
}

// file is the file opened by withOpenFile. It counts the number of reads and the amount read.
function makeReader(file, p) {
  const { size } = file;
  let reads = 0;
  let total = 0;
  return (offset, length) => {
    reads += 1;
    const wanted = Math.min(length, Math.max(0, size - offset));
    total += wanted;
    if (reads > MAX_READS || total > MAX_TOTAL) throw new FcError(`Stopped reading because there are too many MKV elements: ${p}`);
    return file.read(offset, wanted);
  };
}

// It reads the element header at the offset of the file.
function headerAt(read, offset) {
  const header = readHeader(read(offset, MAX_HEADER), 0);
  return header && { ...header, start: offset + header.start };
}

// It accepts only when the first element is an EBML header and the document type is matroska or webm. It returns the end position of the header.
function checkHeader(read, p) {
  const header = headerAt(read, 0);
  if (!header || header.id !== ID.EBML || header.size === null || header.size > MAX_ELEMENT) throw new FcError(`Not an MKV/WebM format: ${p}`);
  const body = read(header.start, header.size);
  const type = [...children(body)].find((child) => child.id === ID.DOC_TYPE);
  const name = type && readText(type.body);
  if (name !== 'matroska' && name !== 'webm') throw new FcError(`Not an MKV/WebM format: ${p}`);
  return header.start + header.size;
}

// It reads the metadata of an MKV/WebM file inside the target and returns { title, comment, duration, width, height, displayWidth, displayHeight, bitrate }.
// A value not found is null. duration is in seconds, and bitrate is the bits per second computed from the whole file size.
// If the file is partly downloaded or the length differs greatly from the seek table (Cues), bitrate is null and the reason is written in bitrateNote (bitrateDoubt, #179).
// bitrate and bitrateNote are filled only when options.verifyBitrate is true (#207). If off, both are null and the seek table (Cues, up to 16MB) is not read.
// This is so that the duplicate and product-number search, which does not use the bitrate, does not spend I/O and the read limit (MAX_TOTAL) on reading a large seek table.
// width and height are the pixel size (PixelWidth/Height), and displayWidth and displayHeight are the visible size reflecting the pixels to crop (PixelCrop), DisplayWidth/Height,
// and the 90 and 270 degree rotation of a flat projection (ProjectionPoseRoll) (#106, #113). It does not look at the pixel aspect ratio inside the video data (the SPS in CodecPrivate). By the specification, if DisplayWidth/Height are absent, the cropped pixel size is the visible size.
// FFmpeg 9.0 also sees an MKV that has 32:27 in the SPS and no DisplayWidth as 1:1 (confirmed in #123).
// It reads the elements before the first Cluster and goes to the elements after it through SeekHead. It does not read the video data.
// A path or I/O problem, or a file that is not MKV/WebM, raises an FcError. Exceeding the read limit also raises an FcError. For damage inside an element, it returns only the values found so far. It is not a broken-file judge.
function readMkvMetadata(dir, p, options = {}) {
  try {
    const access = grant(dir, ['read']);
    return parseMkv(access.target, access.read(p), p, options.verifyBitrate === true);
  } catch (err) {
    if (err.syscall) throw new FcError(`Cannot read the MKV file: ${p} (${err.code})`);
    throw err;
  }
}

function parseMkv(target, real, p, verifyBitrate) {
  return withOpenFile(target, real, (file) => parseOpenedMkv(file, p, verifyBitrate));
}

function parseOpenedMkv(file, p, verifyBitrate) {
  const { size } = file;
  const read = makeReader(file, p);
  const segment = headerAt(read, checkHeader(read, p));
  if (!segment || segment.id !== ID.SEGMENT) throw new FcError(`Not an MKV/WebM format: ${p}`);
  const segmentEnd = segment.size === null ? size : Math.min(size, segment.start + segment.size);

  const found = { title: null, duration: null, width: null, height: null, displayWidth: null, displayHeight: null };
  const tags = new Map();
  const positions = [];
  const seen = new Set();
  const handle = (header) => {
    if (header.size === null || header.size > MAX_ELEMENT || header.start + header.size > segmentEnd) return;
    if (header.id === ID.CUES && !verifyBitrate) return;
    const body = read(header.start, header.size);
    if (header.id === ID.SEEK_HEAD) parseSeekHead(body, positions);
    if (header.id === ID.INFO) parseInfo(body, found);
    if (header.id === ID.TRACKS) parseTracks(body, found);
    if (header.id === ID.TAGS) parseTags(body, tags);
    if (header.id === ID.CUES) parseCues(body, found);
  };
  let beyondEnd = segment.size !== null && segment.start + segment.size > size;

  // On meeting an element of unknown size or the first Cluster, it stops reading in order. This is so as not to scan the video data.
  let offset = segment.start;
  while (offset < segmentEnd) {
    const header = headerAt(read, offset);
    if (!header || header.id === ID.CLUSTER || header.size === null) break;
    if (WANTED.has(header.id)) {
      seen.add(offset);
      handle(header);
    }
    offset = header.start + header.size;
  }

  // A SeekHead can point to another SeekHead, so it keeps looking while the list grows. A position already seen is not read again, so it ends.
  for (const { id, position } of positions) {
    const at = segment.start + position;
    if (at >= size) beyondEnd = true;
    // If the bitrate is not verified, the seek table's header is not even read (#207).
    if (at >= segmentEnd || seen.has(at) || (id === ID.CUES && !verifyBitrate)) continue;
    seen.add(at);
    const header = headerAt(read, at);
    if (header?.id === id) handle(header);
  }

  const duration = found.duration;
  if (found.lastCluster != null && segment.start + found.lastCluster >= size) beyondEnd = true;
  const bitrateNote = verifyBitrate && duration ? bitrateDoubt(found, beyondEnd, duration) : null;
  const bitrate = verifyBitrate && duration && bitrateNote === null ? Math.round((size * 8) / duration) : null;
  return {
    title: found.title ?? tags.get('TITLE') ?? null,
    comment: tags.get('COMMENT') ?? tags.get('DESCRIPTION') ?? null,
    duration,
    width: found.width,
    height: found.height,
    displayWidth: found.displayWidth,
    displayHeight: found.displayHeight,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    bitrateNote,
  };
}

// It checks whether the MKV/WebM structure is intact. For damage it returns { status: 'broken', reason }, for suspicion { status: 'suspect', reason }, and if it finds no problem, null.
// I/O problems and exceeding the read limit go out as exceptions.
// It skips over the headers of the elements right under the Segment in order and looks at elements that go past the end of the file and at Tracks. It does not read the video data, so damage inside a Cluster is not found.
// On meeting an element of unknown size (a live recording), the end cannot be known, so it stops judging there.
function checkMkvStructure(target, real, p) {
  return withOpenFile(target, real, (file) => checkOpenedMkv(file, p));
}

function checkOpenedMkv(file, p) {
  const broken = (reason) => ({ status: 'broken', reason });
  const { size } = file;
  const read = makeReader(file, p);
  const ebml = headerAt(read, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null || ebml.size > MAX_ELEMENT) return broken('The EBML header is damaged.');
  if (ebml.start + ebml.size > size) return broken('The EBML header is truncated.');
  // A Void or CRC can come before the Segment.
  let segment = headerAt(read, ebml.start + ebml.size);
  while (segment && GLOBAL_ELEMENTS.has(segment.id) && segment.size !== null) segment = headerAt(read, segment.start + segment.size);
  if (!segment || segment.id !== ID.SEGMENT) return broken('The Segment element is missing. The file may not be fully downloaded.');
  if (segment.size !== null && segment.start + segment.size > size) return broken('The Segment runs past the end of the file. It may be truncated.');
  const end = segment.size === null ? size : segment.start + segment.size;
  let tracks = false;
  let offset = segment.start;
  while (offset < end) {
    const header = headerAt(read, offset);
    if (!header) {
      // If it has read up to Tracks, what follows may be padding.
      if (tracks) return { status: 'suspect', reason: `There is non-element data from byte ${offset}.` };
      return broken(`The element at byte ${offset} is damaged.`);
    }
    if (header.size === null) return null;
    if (header.start + header.size > end) return broken('An element runs past the end of the file. It may be truncated.');
    if (header.id === ID.TRACKS) tracks = true;
    offset = header.start + header.size;
  }
  return tracks ? null : broken('The Tracks element is missing.');
}

module.exports = { readMkvMetadata, checkMkvStructure };
