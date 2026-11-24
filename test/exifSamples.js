'use strict';

// Small sample photos with a date taken, built in memory (no real picture data). Used by exif.test.js and sortPhotos.test.js.

// A TIFF structure with IFD0 -> Exif IFD -> DateTimeOriginal (0x9003, or another tag).
function tiff(date, { big = false, tag = 0x9003 } = {}) {
  const w16 = (buf, at, v) => (big ? buf.writeUInt16BE(v, at) : buf.writeUInt16LE(v, at));
  const w32 = (buf, at, v) => (big ? buf.writeUInt32BE(v, at) : buf.writeUInt32LE(v, at));
  const text = Buffer.from(`${date}\0`, 'latin1');
  const buf = Buffer.alloc(44 + text.length);
  buf.write(big ? 'MM' : 'II', 0, 'latin1');
  w16(buf, 2, 42);
  w32(buf, 4, 8);
  // IFD0 at 8: one entry, the pointer to the Exif IFD at 26.
  w16(buf, 8, 1);
  w16(buf, 10, 0x8769);
  w16(buf, 12, 4);
  w32(buf, 14, 1);
  w32(buf, 18, 26);
  w32(buf, 22, 0);
  // Exif IFD at 26: one ASCII entry whose value sits at 44.
  w16(buf, 26, 1);
  w16(buf, 28, tag);
  w16(buf, 30, 2);
  w32(buf, 32, text.length);
  w32(buf, 36, 44);
  w32(buf, 40, 0);
  text.copy(buf, 44);
  return buf;
}

function jpeg(date, options) {
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(date, options)]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(body.length + 2, 2);
  // SOI, a JFIF-like APP0, the EXIF APP1, then the start of scan and the end of image.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, body, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

// A JPEG with no EXIF at all.
const plainJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

// The eXIf chunk comes after a (fake) IDAT chunk, to show the reader walks the chunks.
function png(date) {
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), pngChunk('IHDR', Buffer.alloc(13)), pngChunk('IDAT', Buffer.alloc(10)), pngChunk('eXIf', tiff(date)), pngChunk('IEND', Buffer.alloc(0))]);
}

function webp(date) {
  const data = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(date)]);
  const head = Buffer.alloc(8);
  head.write('EXIF', 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  const chunk = Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(chunk.length + 4, 4);
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, chunk]);
}

module.exports = { tiff, jpeg, plainJpeg, png, webp };
