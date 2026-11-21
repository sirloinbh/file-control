'use strict';

// zlib.crc32 exists only from Node 22.2, and package.json allows 22.0. Use it when present and a table version otherwise.
const zlib = require('node:zlib');

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

function crc32Table(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32 = typeof zlib.crc32 === 'function' ? (buffer) => zlib.crc32(buffer) : crc32Table;

module.exports = { crc32, crc32Table };
