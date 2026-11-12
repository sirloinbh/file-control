'use strict';

// It builds a 7z for tests directly (#198). The body is not compressed (COPY) and is concatenated in one folder.
// files: [{ name, data } | { name, folder: true }]. If crc is false, the entry CRC is not written.
// gap is the number of bytes not in the list to put after the body and before the header. encoded wraps the header once in a COPY EncodedHeader.
// folderCrcOnly writes only the folder CRC without the entry CRC (libarchive does not check in this case).
// mutateHeader is a function that changes header bytes, and after changing, the next-header CRC is recomputed.
const zlib = require('node:zlib');

function number(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([0x80 | (value >> 8), value & 0xff]);
  const out = Buffer.alloc(9);
  out[0] = 0xff;
  out.writeBigUInt64LE(BigInt(value), 1);
  return out;
}

const u32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
};

function bits(flags) {
  const out = Buffer.alloc(Math.ceil(flags.length / 8));
  flags.forEach((flag, i) => {
    if (flag) out[i >> 3] |= 0x80 >> (i % 8);
  });
  return out;
}

const property = (id, body) => Buffer.concat([number(id), number(body.length), body]);

function streamsInfo({ packPos, packSizes, unpackSize, streams, crc, folderCrc }) {
  const parts = [number(0x06), number(packPos), number(packSizes.length), number(0x09), ...packSizes.map(number), number(0x00)];
  parts.push(number(0x07), number(0x0b), number(1), Buffer.from([0]), number(1), Buffer.from([0x01, 0x00]), number(0x0c), number(unpackSize));
  if (folderCrc !== undefined) parts.push(number(0x0a), Buffer.from([1]), u32(folderCrc));
  parts.push(number(0x00));
  if (streams !== undefined) {
    parts.push(number(0x08), number(0x0d), number(streams.length));
    if (streams.length > 1) parts.push(number(0x09), ...streams.slice(0, -1).map((s) => number(s.length)));
    if (crc && streams.length > 0) parts.push(number(0x0a), Buffer.from([1]), ...streams.map((s) => u32(zlib.crc32(s))));
    parts.push(number(0x00));
  }
  parts.push(number(0x00));
  return Buffer.concat(parts);
}

function sevenZipBuffer(files, { crc = true, gap = 0, encoded = false, encodedCrc = true, anti = false, folderCrcOnly = false, mutateHeader = null } = {}) {
  const streams = files.filter((f) => !f.folder && Buffer.byteLength(f.data) > 0).map((f) => Buffer.from(f.data));
  const body = Buffer.concat(streams);
  const emptyStream = files.map((f) => f.folder || Buffer.byteLength(f.data) === 0);
  const emptyFile = files.filter((_, i) => emptyStream[i]).map((f) => !f.folder);
  const fileProps = [];
  if (emptyStream.some(Boolean)) fileProps.push(property(0x0e, bits(emptyStream)), property(0x0f, bits(emptyFile)));
  if (anti) fileProps.push(property(0x10, bits(emptyStream.filter(Boolean).map(() => false))));
  const names = Buffer.concat(files.map((f) => Buffer.from(`${f.name}\0`, 'utf16le')));
  fileProps.push(property(0x11, Buffer.concat([Buffer.from([0]), names])));
  const parts = [number(0x01)];
  if (streams.length > 0) parts.push(number(0x04), streamsInfo({ packPos: 0, packSizes: [body.length], unpackSize: body.length, streams, crc: crc && !folderCrcOnly, folderCrc: folderCrcOnly ? zlib.crc32(body) : undefined }));
  parts.push(number(0x05), number(files.length), ...fileProps, number(0x00), number(0x00));
  let header = Buffer.concat(parts);
  let data = Buffer.concat([body, Buffer.alloc(gap, 0x41)]);
  if (encoded) {
    const packPos = data.length;
    data = Buffer.concat([data, header]);
    header = Buffer.concat([number(0x17), streamsInfo({ packPos, packSizes: [header.length], unpackSize: header.length, folderCrc: encodedCrc ? zlib.crc32(header) : undefined })]);
  }
  if (mutateHeader) header = mutateHeader(header);
  const start = Buffer.alloc(32);
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]).copy(start);
  start.writeBigUInt64LE(BigInt(data.length), 12);
  start.writeBigUInt64LE(BigInt(header.length), 20);
  start.writeUInt32LE(zlib.crc32(header), 28);
  start.writeUInt32LE(zlib.crc32(start.subarray(12, 32)), 8);
  return Buffer.concat([start, data, header]);
}

module.exports = { sevenZipBuffer };
