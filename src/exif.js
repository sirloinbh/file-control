'use strict';

// A reader for the date taken (EXIF DateTimeOriginal) of a photo, with built-in modules only (#389).
// It knows JPEG, PNG (eXIf chunk), WebP (EXIF chunk), HEIC/HEIF and the TIFF family (TIFF, DNG, CR2, NEF, ARW). The format is told by the first bytes, not by the extension.
// HEIC/HEIF (#420) keep the Exif block as an item of an ISO box file: the meta box says which item is "Exif" (iinf) and where its bytes are (iloc).
// Anything it cannot read or that looks wrong gives null; it never throws for a damaged file.
const fs = require('node:fs');

// How much of a file is read: a JPEG keeps its EXIF in the first segments, and a TIFF may point anywhere, so it gets a bigger window.
const JPEG_WINDOW = 256 * 1024;
const TIFF_WINDOW = 8 * 1024 * 1024;
const MAX_EXIF_CHUNK = 1024 * 1024;
const MAX_CHUNKS = 10000;
const MAX_ENTRIES = 1000;

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_ORIGINAL = 0x9003;
const TAG_DATE_DIGITIZED = 0x9004;
const TYPE_ASCII = 2;

// "2026:11:05 14:03:09" -> { year, month, day }, or null when it is blank ("0000:00:00 00:00:00") or out of range.
function parseExifDate(text) {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  if (year < 1970 || year > new Date().getFullYear() + 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

// It reads the date out of a TIFF structure (the part after the "Exif\0\0" header of a JPEG, or a whole TIFF file).
function dateFromTiff(buf) {
  if (buf.length < 8) return null;
  const little = buf.toString('latin1', 0, 2) === 'II';
  if (!little && buf.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (at) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  if (u16(2) !== 42) return null;

  // The entries of one IFD as a Map: tag -> { type, count, at } where at is the position of the entry's 4-byte value field.
  const entries = (offset) => {
    const found = new Map();
    if (offset < 8 || offset + 2 > buf.length) return found;
    const count = u16(offset);
    if (count > MAX_ENTRIES || offset + 2 + count * 12 > buf.length) return found;
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      found.set(u16(at), { type: u16(at + 2), count: u32(at + 4), at: at + 8 });
    }
    return found;
  };
  const text = (entry) => {
    if (!entry || entry.type !== TYPE_ASCII || entry.count < 19) return null;
    const start = entry.count <= 4 ? entry.at : u32(entry.at);
    if (start + entry.count > buf.length) return null;
    return buf.toString('latin1', start, start + entry.count).replace(/\0.*$/s, '');
  };

  const pointer = entries(u32(4)).get(TAG_EXIF_IFD);
  if (!pointer) return null;
  const exif = entries(u32(pointer.at));
  return parseExifDate(text(exif.get(TAG_DATE_ORIGINAL)) ?? '') ?? parseExifDate(text(exif.get(TAG_DATE_DIGITIZED)) ?? '');
}

function dateFromJpeg(buf) {
  let pos = 2;
  while (pos + 4 <= buf.length && buf[pos] === 0xff) {
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    // Markers without a length, and the start of the picture data: no more headers after these.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && buf.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
      const date = dateFromTiff(buf.subarray(pos + 10, pos + 2 + length));
      if (date) return date;
    }
    pos += 2 + length;
  }
  return null;
}

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}

// PNG: chunks are length(4, big endian) + type(4) + data + crc(4). The eXIf chunk holds a TIFF structure.
function dateFromPng(fd, size) {
  let pos = 8;
  for (let i = 0; i < MAX_CHUNKS && pos + 12 <= size; i++) {
    const head = readAt(fd, pos, 8);
    if (head.length < 8) return null;
    const length = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (type === 'IEND') return null;
    if (type === 'eXIf' && length <= MAX_EXIF_CHUNK) return dateFromTiff(readAt(fd, pos + 8, length));
    pos += 12 + length;
  }
  return null;
}

// WebP: a RIFF file of chunks fourcc(4) + size(4, little endian) + data, padded to an even size. The EXIF chunk may start with "Exif\0\0".
function dateFromWebp(fd, size) {
  let pos = 12;
  for (let i = 0; i < MAX_CHUNKS && pos + 8 <= size; i++) {
    const head = readAt(fd, pos, 8);
    if (head.length < 8) return null;
    const length = head.readUInt32LE(4);
    if (head.toString('latin1', 0, 4) === 'EXIF' && length <= MAX_EXIF_CHUNK) {
      let data = readAt(fd, pos + 8, length);
      if (data.toString('latin1', 0, 6) === 'Exif\0\0') data = data.subarray(6);
      return dateFromTiff(data);
    }
    pos += 8 + length + (length % 2);
  }
  return null;
}

const MAX_META = 4 * 1024 * 1024;
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif']);

// A box is size(4, big endian) + type(4) + data. size 1 means a 64-bit size follows the type; size 0 means up to the end of the file. It returns null for a size that cannot be right.
function boxAt(buf, pos, end) {
  if (pos + 8 > end) return null;
  let size = buf.readUInt32BE(pos);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > end) return null;
    const big = buf.readBigUInt64BE(pos + 8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    header = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < header || pos + size > end) return null;
  return { type: buf.toString('latin1', pos + 4, pos + 8), start: pos + header, end: pos + size };
}

// An unsigned number of 0, 4 or 8 bytes (the sizes iloc allows); 0 bytes is the value 0. null if it does not fit or is not allowed.
function uintOf(buf, pos, width) {
  if (width === 0) return 0;
  if (pos + width > buf.length) return null;
  if (width === 4) return buf.readUInt32BE(pos);
  if (width === 8) {
    const big = buf.readBigUInt64BE(pos);
    return big > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(big);
  }
  return null;
}

// iinf: the id of the item whose type is "Exif", or null.
function exifItemId(meta, box) {
  const version = meta[box.start];
  let pos = box.start + 4;
  const count = version === 0 ? meta.readUInt16BE(pos) : meta.readUInt32BE(pos);
  pos += version === 0 ? 2 : 4;
  for (let i = 0; i < Math.min(count, MAX_ENTRIES) && pos < box.end; i++) {
    const infe = boxAt(meta, pos, box.end);
    if (infe === null) return null;
    if (infe.type === 'infe') {
      const v = meta[infe.start];
      let at = infe.start + 4;
      if (v === 2 || v === 3) {
        const id = v === 2 ? meta.readUInt16BE(at) : meta.readUInt32BE(at);
        at += (v === 2 ? 2 : 4) + 2;
        if (meta.toString('latin1', at, at + 4) === 'Exif') return id;
      }
    }
    pos = infe.end;
  }
  return null;
}

// iloc: where the bytes of item id are in the file, as { offset, length } (one extent, stored as file offsets), or null.
function itemPlace(meta, box, id) {
  const version = meta[box.start];
  if (version > 2) return null;
  let pos = box.start + 4;
  const offsetSize = meta[pos] >> 4;
  const lengthSize = meta[pos] & 15;
  const baseSize = meta[pos + 1] >> 4;
  const indexSize = version === 0 ? 0 : meta[pos + 1] & 15;
  pos += 2;
  const count = version < 2 ? meta.readUInt16BE(pos) : meta.readUInt32BE(pos);
  pos += version < 2 ? 2 : 4;
  for (let i = 0; i < Math.min(count, MAX_ENTRIES) && pos < box.end; i++) {
    const itemId = version < 2 ? meta.readUInt16BE(pos) : meta.readUInt32BE(pos);
    pos += version < 2 ? 2 : 4;
    let method = 0;
    if (version > 0) {
      method = meta.readUInt16BE(pos) & 15;
      pos += 2;
    }
    pos += 2;
    const base = uintOf(meta, pos, baseSize);
    pos += baseSize;
    const extents = meta.readUInt16BE(pos);
    pos += 2;
    let first = null;
    for (let e = 0; e < Math.min(extents, MAX_ENTRIES); e++) {
      pos += indexSize;
      const offset = uintOf(meta, pos, offsetSize);
      pos += offsetSize;
      const length = uintOf(meta, pos, lengthSize);
      pos += lengthSize;
      if (first === null) first = { offset, length };
    }
    if (itemId !== id) continue;
    if (method !== 0 || extents !== 1 || base === null || first === null || first.offset === null || first.length === null) return null;
    return { offset: base + first.offset, length: first.length };
  }
  return null;
}

// HEIC/HEIF: the Exif item starts with a 4-byte offset (big endian) to the TIFF header, counted from after those 4 bytes; "Exif\0\0" may sit before the header.
function dateFromHeic(fd, size) {
  let pos = 0;
  let meta = null;
  for (let i = 0; i < MAX_CHUNKS && pos + 8 <= size; i++) {
    const head = readAt(fd, pos, 16);
    if (head.length < 8) return null;
    let boxSize = head.readUInt32BE(0);
    let headerSize = 8;
    if (boxSize === 1) {
      if (head.length < 16) return null;
      const big = head.readBigUInt64BE(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      boxSize = Number(big);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - pos;
    }
    if (boxSize < headerSize || pos + boxSize > size) return null;
    if (head.toString('latin1', 4, 8) === 'meta') {
      if (boxSize - headerSize > MAX_META) return null;
      meta = readAt(fd, pos + headerSize, boxSize - headerSize);
      break;
    }
    pos += boxSize;
  }
  if (meta === null || meta.length < 4) return null;
  // meta is a full box: version and flags first, then its child boxes.
  let id = null;
  let iloc = null;
  for (let at = 4; at < meta.length; ) {
    const child = boxAt(meta, at, meta.length);
    if (child === null) break;
    if (child.type === 'iinf') id = exifItemId(meta, child);
    else if (child.type === 'iloc') iloc = child;
    at = child.end;
  }
  if (id === null || iloc === null) return null;
  const place = itemPlace(meta, iloc, id);
  if (place === null || place.length < 12 || place.length > MAX_EXIF_CHUNK || place.offset + place.length > size) return null;
  const item = readAt(fd, place.offset, place.length);
  if (item.length < 12) return null;
  const skip = item.readUInt32BE(0);
  if (skip > item.length - 8) return null;
  let tiff = item.subarray(4 + skip);
  if (tiff.toString('latin1', 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6);
  return dateFromTiff(tiff);
}

// It returns { year, month, day } of the date taken stored in the photo, or null when there is none or it cannot be read.
function readTakenDate(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = readAt(fd, 0, 12);
    if (head[0] === 0xff && head[1] === 0xd8) return dateFromJpeg(readAt(fd, 0, Math.min(size, JPEG_WINDOW)));
    if (head.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return dateFromPng(fd, size);
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return dateFromWebp(fd, size);
    if (head.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(head.toString('latin1', 8, 12))) return dateFromHeic(fd, size);
    const mark = head.toString('latin1', 0, 4);
    if (mark === 'II*\0' || mark === 'MM\0*') return dateFromTiff(readAt(fd, 0, Math.min(size, TIFF_WINDOW)));
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readTakenDate, parseExifDate, dateFromTiff };
