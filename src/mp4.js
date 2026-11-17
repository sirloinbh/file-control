'use strict';

const { FcError } = require('./commands');
const { grant } = require('./target');
const { withOpenFile } = require('./openedFile');
const { spsAspect } = require('./videoSps');

// Boxes that can come at the very front of a file. It holds several in order to also accept old QuickTime files that have no ftyp.
const FIRST_BOXES = new Set(['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);

// So that the number of reads does not grow without bound even when a damaged file lines up small boxes endlessly. A normal file ends in tens of reads.
const MAX_READS = 20000;
// The maximum size of a title or comment value. If larger, it is treated as absent. A large value such as a cover image is not loaded into memory.
const MAX_TEXT = 64 * 1024;

// The title is chosen in the order iTunes format, QuickTime keys, old QuickTime, 3GPP. The comment has the same order, and within the same format the left one comes first.
const TITLE_SOURCES = ['ilst:©nam', 'mdta:com.apple.quicktime.title', 'udta:©nam', 'udta:titl'];
const COMMENT_SOURCES = [
  'ilst:©cmt',
  'ilst:desc',
  'ilst:ldes',
  'mdta:com.apple.quicktime.comment',
  'mdta:com.apple.quicktime.description',
  'udta:©cmt',
  'udta:dscp',
];

const fourcc = (buffer, offset = 0) => buffer.toString('latin1', offset, offset + 4);

// It reads length bytes from offset, and if it falls short, it is seen as damage. It also counts the number of reads here. file is the file opened by withOpenFile.
function makeReader(file, p) {
  let reads = 0;
  return (offset, length) => {
    reads += 1;
    if (reads > MAX_READS) throw new FcError(`Stopped reading because there are too many MP4 boxes: ${p}`);
    const buffer = file.read(offset, length);
    if (buffer.length < length) throw new FcError(`Could not read the MP4 file to the end: ${p}`);
    return buffer;
  };
}

// It decodes a box header and returns { type, start, end }. start is the start of the content. If the header is wrong, it is null.
// Size 0 means "to the end of the file" and has meaning only at the top level. A 0 inside is the end marker of an old QuickTime udta, so it returns null to end the traversal.
function readBoxHeader(read, offset, end, topLevel) {
  if (end - offset < 8) return null;
  const head = read(offset, Math.min(16, end - offset));
  const type = fourcc(head, 4);
  const size32 = head.readUInt32BE(0);
  let size = size32;
  let start = offset + 8;
  if (size32 === 0) {
    if (!topLevel) return null;
    size = end - offset;
  } else if (size32 === 1) {
    if (head.length < 16) return null;
    const large = head.readBigUInt64BE(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    start = offset + 16;
  }
  if (size < start - offset || offset + size > end) return null;
  return { type, start, end: offset + size };
}

// It returns the child boxes within start to end in order.
// Less than 8 leftover bytes at the end are ignored. On meeting a wrong header, it is an error only when strict, and otherwise it ends there.
function* boxes(read, p, start, end, strict) {
  let offset = start;
  while (end - offset >= 8) {
    const box = readBoxHeader(read, offset, end, false);
    if (!box) {
      // Size 0 is an end marker, not damage.
      if (strict && read(offset, 4).readUInt32BE(0) !== 0) throw new FcError(`The MP4 structure is damaged: ${p} (at byte ${offset})`);
      return;
    }
    yield box;
    offset = box.end;
  }
}

// It scans the top-level boxes to find moov. It skips mdat without reading its content.
function findMoov(read, p, size) {
  let offset = 0;
  let first = true;
  while (size - offset >= 8) {
    const box = readBoxHeader(read, offset, size, true);
    const type = box ? box.type : fourcc(read(offset, 8), 4);
    if (first && !FIRST_BOXES.has(type)) break;
    first = false;
    if (!box) {
      if (type === 'moov') throw new FcError(`The moov box of the MP4 file is truncated: ${p}`);
      throw new FcError(`The MP4 file has no moov box. The file may be truncated: ${p}`);
    }
    if (type === 'moov') return box;
    offset = box.end;
  }
  if (first) throw new FcError(`Not an MP4/MOV format: ${p}`);
  throw new FcError(`The MP4 file has no moov box. The file may be truncated: ${p}`);
}

// If the value fits entirely inside the box, it returns that value, otherwise null.
function readPayload(read, box, length) {
  const available = box.end - box.start;
  if (available < length) return null;
  return read(box.start, length);
}

// It returns the first byte of the version and flags. A version other than 0 or 1 has an unknown structure, so it is null.
function readVersion(read, box) {
  const head = readPayload(read, box, 1);
  return head && head[0] <= 1 ? head[0] : null;
}

// If the duration is not set, the value is filled with all 1s, so it is seen as null.
function durationValue(buffer, offset, version) {
  if (version === 1) {
    const value = buffer.readBigUInt64BE(offset);
    return value === 0xffffffffffffffffn || value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
  }
  const value = buffer.readUInt32BE(offset);
  return value === 0xffffffff ? null : value;
}

// In the transform matrix { a b u / c d v / x y w }, if a and d are 0 and b and c are not 0, it is a 90 or 270 degree rotation (a phone portrait video).
// 0 and 180 degrees and other matrices (a skew and so on) are seen as not swapping the width and height.
function isQuarterTurn(body, offset) {
  const [a, b, c, d] = [0, 4, 12, 16].map((at) => body.readInt32BE(offset + at));
  return a === 0 && d === 0 && b !== 0 && c !== 0;
}

// quarterTurn is the rotation of the mvhd matrix that applies to the whole movie. If the matrix is not included, it is false (#113).
function readMvhd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 32 : 20);
  if (!body) return null;
  const matrix = readPayload(read, box, version === 1 ? 84 : 72);
  const quarterTurn = matrix ? isQuarterTurn(matrix, version === 1 ? 48 : 36) : false;
  return version === 1
    ? { timescale: body.readUInt32BE(20), duration: durationValue(body, 24, 1), quarterTurn }
    : { timescale: body.readUInt32BE(12), duration: durationValue(body, 16, 0), quarterTurn };
}

function readMehd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 12 : 8);
  return body ? durationValue(body, 4, version) : null;
}

// The screen size (before applying the track matrix) is 16.16 fixed point. width and height are the integer part, and exactWidth and exactHeight hold the fraction too.
// If the track matrix is a 90 or 270 degree rotation, quarterTurn is true.
function readTkhd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 96 : 84);
  if (!body) return null;
  const at = version === 1 ? 88 : 76;
  return {
    enabled: (body.readUInt8(3) & 1) === 1,
    duration: durationValue(body, version === 1 ? 28 : 20, version) ?? 0,
    width: body.readUInt32BE(at) >>> 16,
    height: body.readUInt32BE(at + 4) >>> 16,
    exactWidth: body.readUInt32BE(at) / 65536,
    exactHeight: body.readUInt32BE(at + 4) / 65536,
    quarterTurn: isQuarterTurn(body, version === 1 ? 52 : 40),
  };
}

// The fixed-field length of a video sample entry. After it come child boxes such as avcC and pasp.
const VISUAL_ENTRY = 78;

// avcC and hvcC hold a few SPS and PPS, so they are usually a few hundred bytes. If larger, they are not read.
const MAX_CODEC_CONFIG = 64 * 1024;

// It reads the encoded resolution and pixel aspect ratio of the first sample entry. The width and height are at 4+4 bytes before the entry and at position 32 bytes inside the entry.
// pasp is { h, v }, the horizontal:vertical ratio of one pixel. If absent or it holds 0, it is null. 1:1 is also kept as a value.
// spsAspect is the pixel aspect ratio of the SPS inside avcC and hvcC (#113). It does not read the video data (mdat).
function readStsd(read, p, box) {
  const body = readPayload(read, box, 44);
  if (!body || body.readUInt32BE(4) === 0) return null;
  const sample = { width: body.readUInt16BE(40), height: body.readUInt16BE(42), pasp: null, spsAspect: null };
  const entry = readBoxHeader(read, box.start + 8, box.end, false);
  if (!entry || entry.end - entry.start <= VISUAL_ENTRY) return sample;
  for (const child of boxes(read, p, entry.start + VISUAL_ENTRY, entry.end, false)) {
    if (child.type === 'pasp' && sample.pasp === null) {
      const spacing = readPayload(read, child, 8);
      if (spacing && spacing.readUInt32BE(0) > 0 && spacing.readUInt32BE(4) > 0) sample.pasp = { h: spacing.readUInt32BE(0), v: spacing.readUInt32BE(4) };
    }
    if ((child.type === 'avcC' || child.type === 'hvcC') && sample.spsAspect === null && child.end - child.start <= MAX_CODEC_CONFIG) {
      sample.spsAspect = spsAspect(child.type, read(child.start, child.end - child.start));
    }
  }
  return sample;
}

// The width multiplied by the pixel aspect ratio (unchanged if square pixels)
const stretched = (width, aspect) => (Math.abs(aspect - 1) > 1e-9 ? Math.max(1, Math.round(width * aspect)) : width);

// The visible size before applying rotation. For the pixel aspect ratio, it uses the container value before the video data value (like FFmpeg, which uses pasp before the SPS).
// 1. pasp: a value that writes the pixel aspect ratio directly. If it is 1:1, it is seen as square pixels.
// 2. If the tkhd screen size differs from the encoded resolution, that size. By the specification, the sample picture is stretched to this size when shown. There are files that reflect the pixel aspect ratio only in tkhd, without pasp.
//    A size that changed the width and height by the same factor is seen as pixel aspect ratio 1 and the encoded resolution is used.
//    A file of a rotated video that wrote the size after rotation in tkhd (a ratio with width and height swapped) is not a pixel aspect ratio, so it is not used and moves to the next step.
//    A size whose integer part is 0 (a wrong value written without the 16-bit shift and so on) is not used.
// 3. The pixel aspect ratio (VUI) of the SPS. It is used when there is no pasp and the pixel aspect ratio cannot be known from tkhd (some files made with ffmpeg).
function unrotatedSize(sample, header, turned) {
  const { width, height } = sample;
  if (sample.pasp) return [stretched(width, sample.pasp.h / sample.pasp.v), height];
  if (header && header.width >= 1 && header.height >= 1 && (header.width !== sample.width || header.height !== sample.height)) {
    const aspect = (header.exactWidth * height) / (header.exactHeight * width);
    // Whether it is in swapped form is judged by both the encoded resolution and the visible width that reflects the SPS pixel aspect ratio. If a video whose pixels are not square (1440x1080, 4:3) is
    // rotated and tkhd is written with the size after rotation (1080x1920), it is not in swapped form against the encoded resolution (#124).
    const visibleWidth = sample.spsAspect ? (width * sample.spsAspect.h) / sample.spsAspect.v : width;
    const swappedWith = (shown) => Math.abs((header.exactWidth * shown) / (header.exactHeight * height) - 1) < 0.01;
    if (!(turned && (swappedWith(width) || swappedWith(visibleWidth)))) {
      if (Math.abs(aspect - 1) < 1e-9) return [width, height];
      return [Math.round(header.exactWidth), Math.round(header.exactHeight)];
    }
  }
  if (sample.spsAspect) return [stretched(width, sample.spsAspect.h / sample.spsAspect.v), height];
  return [width, height];
}

// movieTurn is the rotation of the mvhd matrix. It is applied together with the track matrix, so if only one of the two is 90 or 270 degrees, the width and height are swapped.
function readTrack(read, p, trak, movieTurn) {
  let header = null;
  let handler = null;
  let sample = null;
  for (const box of boxes(read, p, trak.start, trak.end, true)) {
    if (box.type === 'tkhd') header = readTkhd(read, box);
    if (box.type !== 'mdia') continue;
    for (const part of boxes(read, p, box.start, box.end, true)) {
      if (part.type === 'hdlr') {
        const body = readPayload(read, part, 12);
        if (body) handler = fourcc(body, 8);
      }
      if (part.type !== 'minf') continue;
      for (const inner of boxes(read, p, part.start, part.end, true)) {
        if (inner.type !== 'stbl') continue;
        for (const table of boxes(read, p, inner.start, inner.end, true)) {
          if (table.type === 'stsd') sample = readStsd(read, p, table);
        }
      }
    }
  }
  if (handler !== 'vide') return null;
  // It uses the encoded resolution (stsd) first, and if 0, the screen size (tkhd).
  const width = sample?.width || header?.width || 0;
  const height = sample?.height || header?.height || 0;
  if (width === 0 || height === 0) return null;
  // The visible size. It reflects the pixel aspect ratio (unrotatedSize), and for a 90 or 270 degree rotation swaps the width and height.
  // If it used the tkhd size because the encoded resolution is 0, it is already the visible size, so the pixel aspect ratio is not multiplied again.
  const turned = Boolean(header?.quarterTurn) !== Boolean(movieTurn);
  const [shownWidth, shownHeight] = sample?.width && sample?.height ? unrotatedSize(sample, header, turned) : [width, height];
  const [displayWidth, displayHeight] = turned ? [shownHeight, shownWidth] : [shownWidth, shownHeight];
  return { width, height, displayWidth, displayHeight, enabled: header?.enabled ?? true, duration: header?.duration ?? 0 };
}

// A cover picture or preview track can be larger than the main one, so among the enabled tracks it picks the one with the longer duration, and if equal, the larger.
function mainVideo(tracks) {
  return tracks.reduce((best, track) => {
    if (!best) return track;
    const order = Number(track.enabled) - Number(best.enabled) || track.duration - best.duration || track.width * track.height - best.width * best.height;
    return order > 0 ? track : best;
  }, null);
}

// For UTF-16, it follows the BOM if there is one, and otherwise reads as big endian. Wrong letters become U+FFFD. If fatal, it throws an exception instead.
function decodeText(buffer, encoding = 'utf-8', { fatal = false } = {}) {
  let text;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buffer);
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) text = new TextDecoder('utf-16be').decode(buffer);
  else text = new TextDecoder(encoding, { fatal }).decode(buffer);
  return text.replace(/\0+[^]*$/, '').trim();
}

function remember(tags, key, text) {
  if (text && !tags.has(key)) tags.set(key, text);
}

// It reads the data box inside an ilst entry. The first 8 bytes are the type and the language. Types 0 and 1 are UTF-8, 2 is UTF-16BE, and the rest (numbers, pictures, and so on) are not text.
function readDataBox(read, p, item) {
  for (const box of boxes(read, p, item.start, item.end, false)) {
    if (box.type !== 'data') continue;
    const length = box.end - box.start;
    if (length <= 8 || length > MAX_TEXT) continue;
    const body = read(box.start, length);
    const kind = body.readUInt32BE(0);
    if (kind > 2) continue;
    const text = decodeText(body.subarray(8), kind === 2 ? 'utf-16be' : 'utf-8');
    if (text) return text;
  }
  return null;
}

// The values of the keys box are paired with the numbers (from 1) of the ilst entries.
function readKeys(read, box) {
  const length = box.end - box.start;
  if (length < 8 || length > MAX_TEXT) return [];
  const body = read(box.start, length);
  const names = [];
  let offset = 8;
  for (let i = 0; i < body.readUInt32BE(4) && body.length - offset >= 8; i += 1) {
    const size = body.readUInt32BE(offset);
    if (size < 8 || size > body.length - offset) break;
    names.push(body.toString('utf8', offset + 8, offset + size));
    offset += size;
  }
  return names;
}

// In an ISO-format meta, there are 4 zero-filled bytes (version and flags) in front, and in QuickTime format that position is the size of the first child, so it is not 0.
function readMeta(read, p, meta, tags) {
  const head = readPayload(read, meta, 4);
  if (!head) return;
  const start = head.readUInt32BE(0) === 0 ? meta.start + 4 : meta.start;
  let names = null;
  const items = [];
  for (const box of boxes(read, p, start, meta.end, false)) {
    if (box.type === 'keys') names = readKeys(read, box);
    if (box.type === 'ilst') items.push(...boxes(read, p, box.start, box.end, false));
  }
  for (const item of items) {
    const index = Buffer.from(item.type, 'latin1').readUInt32BE(0);
    // If keys exists, the entry name is a number, not text.
    const key = names ? names[index - 1] && `mdta:${names[index - 1]}` : `ilst:${item.type}`;
    if (key && (TITLE_SOURCES.includes(key) || COMMENT_SOURCES.includes(key))) remember(tags, key, readDataBox(read, p, item));
  }
}

// If the language code of an old QuickTime entry is under 0x400 (a Macintosh language code) or 0x7FFF (unspecified), the text is in a Mac encoding (#69).
// FFmpeg (libavformat/mov.c) also reads it as a Mac encoding in this case. FFmpeg uses MacRoman regardless of language, but here it picks, among the Mac encodings that fit the language code,
// one that Node can read. Japanese (11) Shift_JIS, Traditional Chinese (19) Big5, Korean (23) EUC-KR, Simplified Chinese (33) GBK,
// Cyrillic-script languages (Russian 32, Serbian 42, Macedonian 43, Bulgarian 44, Ukrainian 45, Belarusian 46, Uzbek 47, Kazakh 48,
// Azerbaijani Cyrillic 49, Moldavian 53, Kyrgyz 54, Tajik 55, Turkmen 56, Mongolian Cyrillic 58) Mac Cyrillic, and
// the rest are MacRoman (Mac encodings Node does not have, such as Greek, Hebrew, and Arabic, are read as MacRoman like FFmpeg, so letters can be wrong).
// If it is 0x400 or more (an ISO 639-2/T language code), it is UTF-8.
const MAC_ENCODINGS = new Map([
  [11, 'shift_jis'],
  [19, 'big5'],
  [23, 'euc-kr'],
  [33, 'gbk'],
  ...[32, 42, 43, 44, 45, 46, 47, 48, 49, 53, 54, 55, 56, 58].map((code) => [code, 'x-mac-cyrillic']),
]);

function classicEncoding(language) {
  if (language >= 0x400 && language !== 0x7fff) return 'utf-8';
  return MAC_ENCODINGS.get(language) ?? 'macintosh';
}

// CJK encodings. It is common for a two-byte letter to become a UTF-8 letter in U+0080 to U+07FF by chance (EUC-KR "chicken" C4 A1 C5 B2 = ġŲ).
const CJK_ENCODINGS = new Set(['shift_jis', 'big5', 'euc-kr', 'gbk']);

// If it is a Mac language code but the content is valid UTF-8, it is seen as written in UTF-8. This is because some tools leave the language code as 0 and write UTF-8.
// Non-ASCII letters of MacRoman and Mac Cyrillic hardly fit the UTF-8 rules (the é of café = 0x8E).
// For a CJK language code, it is seen as UTF-8 only when the text read as UTF-8 has U+0800 or above (the range with CJK letters) and has no non-ASCII letter below it (first review).
function decodeClassic(buffer, language) {
  const encoding = classicEncoding(language);
  if (encoding !== 'utf-8') {
    let text = null;
    try {
      text = decodeText(buffer, 'utf-8', { fatal: true });
    } catch {
      // If it is not UTF-8, it reads in the encoding of the language code.
    }
    if (text !== null && (!CJK_ENCODINGS.has(encoding) || !/[\u0080-\u07ff]/.test(text))) return text;
  }
  return decodeText(buffer, encoding);
}

// An old QuickTime entry has several languages in a row in the order 2-byte length, 2-byte language, text. It uses the first value.
function readClassicText(read, box) {
  const length = box.end - box.start;
  if (length < 4 || length > MAX_TEXT) return null;
  const body = read(box.start, length);
  const size = body.readUInt16BE(0);
  if (size === 0 || size > length - 4) return null;
  return decodeClassic(body.subarray(4, 4 + size), body.readUInt16BE(2));
}

// A 3GPP entry is in the order 4 bytes of version and flags, 2-byte language, text.
function readGppText(read, box) {
  const length = box.end - box.start;
  if (length <= 6 || length > MAX_TEXT) return null;
  return decodeText(read(box.start, length).subarray(6));
}

function readUdta(read, p, udta, tags) {
  for (const box of boxes(read, p, udta.start, udta.end, false)) {
    if (box.type === 'meta') readMeta(read, p, box, tags);
    if (box.type === '©nam' || box.type === '©cmt') remember(tags, `udta:${box.type}`, readClassicText(read, box));
    if (box.type === 'titl' || box.type === 'dscp') remember(tags, `udta:${box.type}`, readGppText(read, box));
  }
}

function firstTag(tags, sources) {
  for (const source of sources) {
    if (tags.has(source)) return tags.get(source);
  }
  return null;
}

// It reads the metadata of an MP4/MOV file inside the target and returns { title, comment, duration, width, height, displayWidth, displayHeight, bitrate }.
// A value not found is null. duration is in seconds, and bitrate is the bits per second computed from the whole file size.
// If the file is partly downloaded or the length differs greatly from the sample table, bitrate is null and the reason is written in bitrateNote (bitrateDoubt, #179).
// bitrate and bitrateNote are filled only when options.verifyBitrate is true (#207). If off, both are null and the track's sample table (stts, up to 8MB) and
// the data position table (stco, co64) are not looked at. This is to reduce the I/O of the duplicate and product-number search, which does not use the bitrate.
// width and height are the encoded resolution, and displayWidth and displayHeight are the visible size reflecting the pixel aspect ratio and the 90 and 270 degree rotation (#106, #113).
// The pixel aspect ratio is chosen in the order pasp, tkhd screen size, SPS (unrotatedSize), and for rotation it looks at the track (tkhd) and whole-movie (mvhd) matrices together.
// It reads only the needed boxes in pieces, so even for a large file it does not load the whole content into memory.
// A path or I/O problem, a file that is not MP4/MOV, a file truncated before moov or in moov itself, and damage in the structure read raise an FcError.
// Broken-file judgment is done by checkMp4Structure. This function cannot catch a file whose mdat after moov is truncated or zero-filled, and for damage on the title and comment (udta, meta) side, it returns only the values found so far.
function readMp4Metadata(dir, p, options = {}) {
  try {
    const access = grant(dir, ['read']);
    return parseMp4(access.target, access.read(p), p, options.verifyBitrate === true);
  } catch (err) {
    if (err.syscall) throw new FcError(`Cannot read the MP4 file: ${p} (${err.code})`);
    throw err;
  }
}

function parseMp4(target, real, p, verifyBitrate) {
  return withOpenFile(target, real, (file) => parseOpenedMp4(file, p, verifyBitrate));
}

function parseOpenedMp4(file, p, verifyBitrate) {
  const { size } = file;
  const read = makeReader(file, p);
  const moov = findMoov(read, p, size);

  let movie = null;
  let fragmentDuration = null;
  let fragmented = false;
  const traks = [];
  const tags = new Map();
  for (const box of boxes(read, p, moov.start, moov.end, true)) {
    if (box.type === 'mvhd') movie = readMvhd(read, box);
    // The mvhd rotation must also be reflected, so tracks are read after scanning all of moov. Some files have mvhd after the tracks.
    if (box.type === 'trak') traks.push(box);
    if (box.type === 'mvex') {
      fragmented = true;
      for (const part of boxes(read, p, box.start, box.end, true)) {
        if (part.type === 'mehd') fragmentDuration = readMehd(read, part);
      }
    }
    if (box.type === 'udta') readUdta(read, p, box, tags);
    if (box.type === 'meta') readMeta(read, p, box, tags);
  }

  // mehd is the whole length including the fragments and mvhd is the length of the part in moov, so mehd is used first.
  const units = fragmentDuration || movie?.duration;
  const duration = units && movie?.timescale ? units / movie.timescale : null;
  const tracks = traks.map((box) => readTrack(read, p, box, movie?.quarterTurn)).filter(Boolean);
  const video = mainVideo(tracks);
  const bitrateNote = verifyBitrate && duration ? bitrateDoubt(read, traks, size, duration, fragmented) : null;
  return {
    title: firstTag(tags, TITLE_SOURCES),
    comment: firstTag(tags, COMMENT_SOURCES),
    duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    displayWidth: video?.displayWidth ?? null,
    displayHeight: video?.displayHeight ?? null,
    bitrate: verifyBitrate && duration && bitrateNote === null ? Math.round((size * 8) / duration) : null,
    bitrateNote,
  };
}

// It gathers the child boxes of start to end and returns { list, complete }. If complete is false, a wrong header was met midway. Size 0 is an end marker, not a wrong one.
function childBoxes(read, start, end) {
  const list = [];
  let offset = start;
  while (end - offset >= 8) {
    const box = readBoxHeader(read, offset, end, false);
    if (!box) return { list, complete: read(offset, 4).readUInt32BE(0) === 0 };
    list.push(box);
    offset = box.end;
  }
  return { list, complete: true };
}

// It checks whether the track's data is in another file. If the last flag bit of a dref entry is 1, it is inside this file. If there is no location string, there is no file to point to, so it is seen as this file.
function isExternalTrack(read, minf) {
  const dinf = findChild(read, minf, 'dinf');
  const dref = dinf && findChild(read, dinf, 'dref');
  if (!dref || dref.end - dref.start < 8) return false;
  return childBoxes(read, dref.start + 8, dref.end).list.some((entry) => entry.end - entry.start > 4 && (read(entry.start, 4).readUInt32BE(0) & 1) === 0);
}

function findChild(read, parent, type) {
  return childBoxes(read, parent.start, parent.end).list.find((box) => box.type === type);
}

// It looks at the track's data position table (stco, co64). If there is no problem, it returns null; if there is, { outside, reason }.
// outside is the case where the position table points past the end of the file. It means this file has no data, so it is damage regardless of other tracks.
function checkTrack(read, trak, size) {
  const unsound = (reason) => ({ outside: false, reason });
  const mdia = findChild(read, trak, 'mdia');
  const minf = mdia && findChild(read, mdia, 'minf');
  const stbl = minf && findChild(read, minf, 'stbl');
  if (!stbl) return unsound('The mdia, minf, and stbl boxes of the track are not intact.');
  if (isExternalTrack(read, minf)) return null;
  const table = childBoxes(read, stbl.start, stbl.end).list.find((box) => box.type === 'stco' || box.type === 'co64');
  if (!table) return unsound('The track has no data location table (stco, co64).');
  if (table.end - table.start < 8) return unsound('The data location table is truncated.');
  const count = read(table.start + 4, 4).readUInt32BE(0);
  if (count === 0) return null;
  const width = table.type === 'co64' ? 8 : 4;
  if (8 + count * width > table.end - table.start) return unsound('The data location table is truncated.');
  const at = read(table.start + 8 + (count - 1) * width, width);
  const last = width === 8 ? at.readBigUInt64BE(0) : BigInt(at.readUInt32BE(0));
  return last >= BigInt(size) ? { outside: true, reason: 'The data location table points past the end of the file. It may be truncated.' } : null;
}

// The limit on the number of sample table (stts) entries. One entry is 8 bytes, so it is 8MB. Even a variable-frame-rate video holds several hours' worth with one entry per sample.
const MAX_STTS_ENTRIES = 1024 * 1024;

// It divides the sum of the sample lengths written in the track's sample table (stts) by the time unit of mdhd and returns seconds (#179).
// Unlike the header lengths (mvhd, tkhd, mdhd), it is a value written for each real sample. If the table is absent, empty, or unreadable, it is null (a fragmented file has an empty table in moov).
function trackDataSeconds(read, trak) {
  const mdia = findChild(read, trak, 'mdia');
  const mdhd = mdia && findChild(read, mdia, 'mdhd');
  const minf = mdia && findChild(read, mdia, 'minf');
  const stbl = minf && findChild(read, minf, 'stbl');
  const stts = stbl && findChild(read, stbl, 'stts');
  if (!mdhd || !stts) return null;
  const version = readVersion(read, mdhd);
  if (version === null) return null;
  const head = readPayload(read, mdhd, version === 1 ? 24 : 16);
  const timescale = head?.readUInt32BE(version === 1 ? 20 : 12);
  if (!timescale || stts.end - stts.start < 8) return null;
  const count = read(stts.start + 4, 4).readUInt32BE(0);
  if (count === 0 || count > MAX_STTS_ENTRIES || 8 + count * 8 > stts.end - stts.start) return null;
  const table = read(stts.start + 8, count * 8);
  let units = 0;
  for (let at = 0; at < table.length; at += 8) units += table.readUInt32BE(at) * table.readUInt32BE(at + 4);
  return units > 0 && Number.isSafeInteger(units) ? units / timescale : null;
}

// If the bitrate computed from the header length cannot be trusted, it returns the reason; if it can be trusted, null (#179).
// - If the data position table points past the end of the file, it is a partly downloaded file. The file size is smaller than the written length and the bitrate comes out low.
// - If the written length is longer than 2 times the sample table length (the longest among the tracks) plus 60 seconds, the length is seen as broken. The empty stretches of an edit list and
//   the length differences between tracks are smaller than this. A written length that is shorter gives a high bitrate and is not wrongly caught as low quality, so it is not looked at.
// A fragmented file (mvex) has an empty sample table in moov, so the length is not cross-checked.
function bitrateDoubt(read, traks, size, duration, fragmented) {
  if (traks.some((trak) => checkTrack(read, trak, size)?.outside)) return 'The data location table points past the end of the file, so it may be a partial download and the bitrate cannot be trusted.';
  if (fragmented || !duration) return null;
  const seconds = traks.map((trak) => trackDataSeconds(read, trak)).filter((value) => value !== null);
  if (seconds.length === 0) return null;
  const data = Math.max(...seconds);
  if (duration > data * 2 + 60) return `The duration value (${Math.round(duration)} s) is much longer than the sample table duration (${Math.round(data)} s), so the bitrate cannot be trusted.`;
  return null;
}

// Boxes that can be seen as truncated if they go past the end. Other names may be data appended after.
const CONTENT_BOXES = new Set(['moov', 'mdat', 'moof']);

// It checks whether the MP4/MOV structure is intact. For damage it returns { status: 'broken', reason }, for suspicion { status: 'suspect', reason }, and if it finds no problem, null.
// I/O problems and exceeding the read limit go out as exceptions.
// It looks at the top-level boxes, mvhd and trak inside moov, and up to the track's data position table. It does not read the video data itself, so damage inside mdat is not found.
// If the structure needed for playback is intact, padding or appended data after it is not seen as damage. A compressed moov (cmov) and a reference movie (rmra) are not judged.
function checkMp4Structure(target, real, p) {
  return withOpenFile(target, real, (file) => checkOpenedMp4(file, p));
}

function checkOpenedMp4(file, p) {
  const broken = (reason) => ({ status: 'broken', reason });
  const { size } = file;
  const read = makeReader(file, p);
  let moov = null;
  let fragment = false;
  let trailing = false;
  let offset = 0;
  while (size - offset >= 8) {
    const box = readBoxHeader(read, offset, size, true);
    const type = box ? box.type : fourcc(read(offset, 8), 4);
    if (!box && CONTENT_BOXES.has(type)) return broken(`The ${type} box runs past the end of the file. It may be truncated.`);
    if (!box || /[\x00-\x1f]/.test(type)) {
      trailing = true;
      break;
    }
    if (type === 'moov' && !moov) moov = box;
    if (type === 'moof' || (type === 'styp' && offset === 0)) fragment = true;
    offset = box.end;
  }
  // A DASH or HLS media fragment has only moof without moov. The initialization file is separate, so it cannot be judged from this file alone.
  if (!moov && fragment) return { status: 'suspect', reason: 'The file has only fragments (moof) and no moov. It may be a streaming fragment.' };
  if (!moov) return broken('The moov box is missing. The file may not be fully downloaded or may be damaged.');
  const { list, complete } = childBoxes(read, moov.start, moov.end);
  if (list.some((box) => box.type === 'cmov' || box.type === 'rmra')) return null;
  if (!list.some((box) => box.type === 'mvhd')) return broken('The moov box has no mvhd.');
  const tracks = list.filter((box) => box.type === 'trak');
  if (tracks.length === 0) {
    if (list.some((box) => box.type === 'mvex')) return { status: 'suspect', reason: 'The moov box has no tracks.' };
    return broken('The moov box has no tracks.');
  }
  const problems = tracks.map((trak) => checkTrack(read, trak, size)).filter((problem) => problem !== null);
  const outside = problems.find((problem) => problem.outside);
  if (outside) return broken(outside.reason);
  if (problems.length === tracks.length) return broken(problems[0].reason);
  if (problems.length > 0) return { status: 'suspect', reason: problems[0].reason };
  if (!complete) return { status: 'suspect', reason: 'There is non-box data at the end of the moov box. The tracks are intact.' };
  return trailing ? { status: 'suspect', reason: `There is non-box data after byte ${offset}. The structure is intact.` } : null;
}

module.exports = { readMp4Metadata, checkMp4Structure, FIRST_BOXES };
