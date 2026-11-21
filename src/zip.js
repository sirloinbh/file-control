'use strict';

// The ZIP reader. Two jobs share the end record and central directory logic:
// - readZipEntries (used by extract.js) reads the directory and returns { entries: [{ name, size }] } or { reason }, so that the extracted result can be matched to it.
// - checkZip (used by broken.js) judges an .zip file broken, suspect, or fine (null).

const fs = require('node:fs');
const { FcError, oemCodePage } = require('./commands');
const { readRange, fileSizeInside } = require('./target');

const ZIP_LOCAL = Buffer.from('PK\x03\x04', 'latin1');
// The zip end record is 22 bytes, with a comment of up to 65535 bytes attached.
const ZIP_END_SIZE = 22;
const ZIP_TAIL = ZIP_END_SIZE + 65535;
const ZIP_END = Buffer.from('PK\x05\x06', 'latin1');
const ZIP_CENTRAL = 0x02014b50;
const ZIP_CENTRAL_SIZE = 46;
const ZIP_LOCAL_SIZE = 30;
const ZIP_DESCRIPTOR = 0x08074b50;
const ZIP_MAX = 0xffffffff;
const ZIP64_EXTRA = 0x0001;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_END = 0x06064b50;
const ZIP64_END_SIZE = 56;
// The limit for verifying end-marker candidates. It keeps the check from being tied up by a file filled with markers.
const ZIP_END_TRIES = 16;
const ZIP_LOCAL_SIG = 0x04034b50;
// The limit of the check that opens a file for each entry. Entries beyond it are not examined.
const ZIP_LOCAL_CHECKS = 5000;
// The limit of the zip list loaded into memory. Beyond it, no judgment is made.
const MAX_ZIP_DIRECTORY = 64 * 1024 * 1024;
const broken = (reason) => ({ status: 'broken', reason });
const suspect = (reason) => ({ status: 'suspect', reason });

// It finds the data of the id entry in the extra field. If absent, undefined; if the structure is off, null.
function extraField(extra, id) {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const length = extra.readUInt16LE(pos + 2);
    if (pos + 4 + length > extra.length) return null;
    if (extra.readUInt16LE(pos) === id) return extra.subarray(pos + 4, pos + 4 + length);
    pos += 4 + length;
  }
  return pos === extra.length ? undefined : null;
}

const safeNumber = (big) => (big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : null);

// It reads a name without a UTF-8 marker in the OEM code page like tar.exe (#83). If Node does not know that code page or the bytes do not fit, it is null.
// Node's CP949 reads extended-area (UHC) letters as other letters without an error. Even if misread this way, the name is not in the extracted result so it is kept, so nothing is deleted.
function decodeOemName(bytes) {
  const cp = oemCodePage();
  const label = { 949: 'euc-kr', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 866: 'ibm866' }[cp] ?? (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : null);
  if (label === null) return null;
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// It reads the Zip64 end record and returns the entry count and the central directory position (#83). If it cannot be trusted, it is a reason string.
// locatorAt is the position of the Zip64 locator right before the 32-bit end record.
function readZip64End(target, archive, locatorAt) {
  const locator = readRange(target, archive, { offset: locatorAt, length: ZIP64_LOCATOR_SIZE });
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) return { reason: 'Kept because it may be a piece of a split archive.' };
  const recordOffset = safeNumber(locator.readBigUInt64LE(8));
  const record = recordOffset === null ? Buffer.alloc(0) : readRange(target, archive, { offset: recordOffset, length: ZIP64_END_SIZE });
  if (record.length < ZIP64_END_SIZE || record.readUInt32LE(0) !== ZIP64_END) return { reason: 'Kept because the Zip64 structure could not be read.' };
  // After passing the record size (the length minus the first 12 bytes), the locator must appear right away.
  const recordSize = safeNumber(record.readBigUInt64LE(4));
  if (recordSize === null || recordOffset + 12 + recordSize !== locatorAt) return { reason: 'Kept because the Zip64 structure does not match the file size.' };
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0 || record.readBigUInt64LE(24) !== record.readBigUInt64LE(32)) return { reason: 'Kept because it may be a piece of a split archive.' };
  const total = safeNumber(record.readBigUInt64LE(32));
  const directorySize = safeNumber(record.readBigUInt64LE(40));
  const directoryOffset = safeNumber(record.readBigUInt64LE(48));
  if (total === null || directorySize === null || directoryOffset === null) return { reason: 'Kept because the Zip64 structure could not be read.' };
  return { total, directorySize, directoryOffset, directoryEnd: recordOffset };
}

// It checks that the entries continue without a gap from the start of the file to the central directory. If an entry not in the list is in between,
// tar.exe does not extract it but the original would be deleted (#83). The end of an entry is the local header, the compressed body, and the data descriptor added together.
// So that the file is not reopened for each entry when reading in order from the front, it reads 1MB at a time (for a zip with tens of thousands of entries).
function chunkReader(target, archive, chunk = 1 << 20) {
  let start = 0;
  let data = Buffer.alloc(0);
  return (offset, length) => {
    if (offset < start || offset + length > start + data.length) {
      start = offset;
      data = readRange(target, archive, { offset, length: Math.max(length, chunk) });
    }
    return data.subarray(offset - start, offset - start + length);
  };
}

function checkZipLayout(target, archive, entries, directoryOffset) {
  const read = chunkReader(target, archive);
  const sorted = [...entries].sort((a, b) => a.offset - b.offset);
  // If the first entry does not start at the start of the file, there may be an entry in front that is not in the list. A zip whose offsets were fixed after concatenation is like this.
  if (sorted.length > 0 && sorted[0].offset !== 0) return { reason: 'Kept because there is data at the start of the zip that is not in the directory.' };
  for (const [i, entry] of sorted.entries()) {
    const expected = i + 1 < sorted.length ? sorted[i + 1].offset : directoryOffset;
    const local = read(entry.offset, ZIP_LOCAL_SIZE);
    if (local.length < ZIP_LOCAL_SIZE || !local.subarray(0, ZIP_LOCAL.length).equals(ZIP_LOCAL)) return { reason: 'Kept because the zip structure could not be read.' };
    const dataEnd = entry.offset + ZIP_LOCAL_SIZE + local.readUInt16LE(26) + local.readUInt16LE(28) + entry.compressed;
    const gap = expected - dataEnd;
    if ((local.readUInt16LE(6) & 0x8) === 0) {
      if (gap !== 0) return { reason: gap < 0 ? 'Kept because zip entries overlap.' : 'Kept because there is data between zip entries that is not in the directory.' };
      continue;
    }
    if (gap === 0) return { reason: 'Kept because a zip entry has the data descriptor flag but no descriptor.' };
    // The data descriptor may or may not have a signature (4 bytes), and the size fields are 4 or 8 bytes (Zip64 of tar.exe uses 8 bytes).
    // So the length is decided by the distance to the next entry, and it checks that the CRC and the compressed size match the central directory.
    const layout = { 12: [false, false], 16: [true, false], 20: [false, true], 24: [true, true] }[gap];
    if (!layout) return { reason: gap < 0 ? 'Kept because zip entries overlap.' : 'Kept because there is data between zip entries that is not in the directory.' };
    const [signed, wide] = layout;
    const descriptor = read(dataEnd, gap);
    if (descriptor.length !== gap || (signed && descriptor.readUInt32LE(0) !== ZIP_DESCRIPTOR)) return { reason: 'Kept because the zip structure could not be read.' };
    const at = signed ? 4 : 0;
    const compressed = wide ? safeNumber(descriptor.readBigUInt64LE(at + 4)) : descriptor.readUInt32LE(at + 4);
    if (descriptor.readUInt32LE(at) !== entry.crc || compressed !== entry.compressed) return { reason: 'Kept because a zip data descriptor differs from the central directory. Other data may sit between entries.' };
  }
  if (sorted.length === 0 && directoryOffset !== 0) return { reason: 'Kept because there is data at the start of the zip that is not in the directory.' };
  return null;
}

// It reads the central directory of the zip and returns the entry list. If it cannot be trusted, it returns a reason string.
// tar.exe trusts the first end record it meets from the end, so for an uncompressed zip inside a truncated zip, or a concatenated zip, it extracts only part and succeeds.
// So it checks that the end record fits exactly at the end of the file and the central directory continues right before it. For Zip64, it looks at the Zip64 end record.
function readZipEntries(target, archive, entryCount) {
  const size = fileSizeInside(target, archive);
  const tailOffset = Math.max(0, size - ZIP_TAIL);
  const tail = readRange(target, archive, { offset: tailOffset, length: ZIP_TAIL });
  // The marker can also appear inside the comment or in appended data, so every candidate is tried from the back and the first one that validates is taken.
  // The reason of the candidate nearest the end is kept if none validates.
  let first = null;
  let tried = 0;
  for (let at = tail.lastIndexOf(ZIP_END); at !== -1 && tried < ZIP_END_TRIES; at = at === 0 ? -1 : tail.lastIndexOf(ZIP_END, at - 1)) {
    if (at + ZIP_END_SIZE > tail.length) continue;
    tried += 1;
    const found = readZipEnd(target, archive, tail, tailOffset, at, size, entryCount);
    if (found.entries) {
      // The accepted record's comment runs to the end of the file, so every candidate tried before it sits inside that comment. tar.exe trusts the one nearest the end,
      // so a fake record there could make tar.exe extract something other than the entries checked here (#347).
      if (tried > 1) return { reason: 'Kept because the zip comment contains another end marker. tar.exe may have extracted from a different record.' };
      return found;
    }
    first ??= found;
  }
  return first ?? { reason: 'Kept because the zip end marker is missing and the file may be truncated.' };
}

// It validates the zip structure from one end record candidate at tail[at]. It returns { entries: [{ name, size }] } or { reason }.
function readZipEnd(target, archive, tail, tailOffset, at, size, entryCount) {
  const end = tailOffset + at;
  if (end + ZIP_END_SIZE + tail.readUInt16LE(at + 20) !== size) return { reason: 'Kept because there is other data after the zip end marker.' };
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  // If the entry count of this disk differs from the total entry count, tar.exe reads the local headers in order instead of the central directory (measured in the first review).
  if (tail.readUInt16LE(at + 8) !== tail.readUInt16LE(at + 10)) return { reason: 'Kept because it may be a piece of a split archive.' };
  let total = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  let directoryEnd = end;
  const locatorAt = end - ZIP64_LOCATOR_SIZE;
  const locator = locatorAt >= 0 ? readRange(target, archive, { offset: locatorAt, length: 4 }) : Buffer.alloc(0);
  if (locator.length === 4 && locator.readUInt32LE(0) === ZIP64_LOCATOR) {
    // The values of the 32-bit end record must be the Zip64 marker (all-ones values) or equal to the Zip64 end record.
    const zip64 = readZip64End(target, archive, locatorAt);
    if (zip64.reason !== undefined) return zip64;
    if ((disk !== 0 && disk !== 0xffff) || (directoryDisk !== 0 && directoryDisk !== 0xffff)) return { reason: 'Kept because it may be a piece of a split archive.' };
    const agrees = (short, full, marker) => short === marker || short === full;
    if (!agrees(total, zip64.total, 0xffff) || !agrees(directorySize, zip64.directorySize, ZIP_MAX) || !agrees(directoryOffset, zip64.directoryOffset, ZIP_MAX)) {
      return { reason: 'Kept because the zip structure does not match the file size. It may be truncated or have another file appended.' };
    }
    ({ total, directorySize, directoryOffset, directoryEnd } = zip64);
  } else {
    if (disk !== 0 || directoryDisk !== 0) return { reason: 'Kept because it may be a piece of a split archive.' };
    if (total === 0xffff || directorySize === ZIP_MAX || directoryOffset === ZIP_MAX) return { reason: 'Kept because it has Zip64 markers but no Zip64 end record.' };
  }
  if (directoryOffset + directorySize !== directoryEnd) return { reason: 'Kept because the zip structure does not match the file size. It may be truncated or have another file appended.' };
  if (total !== entryCount) return { reason: `Kept because the number of zip entries differs from the extracted list. (${total}, ${entryCount})` };
  const directory = readRange(target, archive, { offset: directoryOffset, length: directorySize });
  const entries = [];
  let pos = 0;
  while (pos < directory.length) {
    if (pos + ZIP_CENTRAL_SIZE > directory.length || directory.readUInt32LE(pos) !== ZIP_CENTRAL) return { reason: 'Kept because the zip structure could not be read.' };
    const nameEnd = pos + ZIP_CENTRAL_SIZE + directory.readUInt16LE(pos + 28);
    const extraEnd = nameEnd + directory.readUInt16LE(pos + 30);
    const entryEnd = extraEnd + directory.readUInt16LE(pos + 32);
    if (entryEnd > directory.length) return { reason: 'Kept because the zip structure could not be read.' };
    const bytes = directory.subarray(pos + ZIP_CENTRAL_SIZE, nameEnd);
    const unicode = (directory.readUInt16LE(pos + 8) & 0x800) !== 0;
    let name = bytes.toString('utf8');
    if (!unicode && bytes.some((byte) => byte >= 0x80)) {
      name = decodeOemName(bytes);
      if (name === null) return { reason: 'Kept because there is an item whose name may differ depending on the code page.' };
    }
    // If a 32-bit field is all ones, the Zip64 extra field holds only that field, in the order original size, compressed size, local header position, and disk number.
    let size = directory.readUInt32LE(pos + 24);
    let compressed = directory.readUInt32LE(pos + 20);
    let offset = directory.readUInt32LE(pos + 42);
    const startDisk = directory.readUInt16LE(pos + 34);
    if (size === ZIP_MAX || compressed === ZIP_MAX || offset === ZIP_MAX || startDisk === 0xffff) {
      const extra = extraField(directory.subarray(nameEnd, extraEnd), ZIP64_EXTRA);
      if (!extra) return { reason: 'Kept because the Zip64 structure could not be read.' };
      let at64 = 0;
      const take = () => {
        if (at64 + 8 > extra.length) return null;
        const value = safeNumber(extra.readBigUInt64LE(at64));
        at64 += 8;
        return value;
      };
      if (size === ZIP_MAX) size = take();
      if (compressed === ZIP_MAX) compressed = take();
      if (offset === ZIP_MAX) offset = take();
      if (size === null || compressed === null || offset === null) return { reason: 'Kept because the Zip64 structure could not be read.' };
      if (startDisk === 0xffff && (at64 + 4 > extra.length || extra.readUInt32LE(at64) !== 0)) return { reason: 'Kept because it may be a piece of a split archive.' };
    } else if (startDisk !== 0) {
      return { reason: 'Kept because it may be a piece of a split archive.' };
    }
    entries.push({ name, size, compressed, offset, crc: directory.readUInt32LE(pos + 16) });
    pos = entryEnd;
  }
  if (pos !== directory.length || entries.length !== total) return { reason: 'Kept because the zip structure could not be read.' };
  const layout = checkZipLayout(target, archive, entries, directoryOffset);
  if (layout !== null) return layout;
  return { entries: entries.map(({ name, size }) => ({ name, size })) };
}

// Finds end-record candidates from the back and returns them as a list of positions. The one whose comment length matches the end of the file comes first.
// The same marker can appear inside a comment or appended data, so the first one found is not trusted as is.
function findZipEnds(tail) {
  const exact = [];
  const others = [];
  for (let at = tail.lastIndexOf(ZIP_END); at !== -1 && exact.length + others.length < ZIP_END_TRIES; at = at === 0 ? -1 : tail.lastIndexOf(ZIP_END, at - 1)) {
    if (at + ZIP_END_SIZE > tail.length) continue;
    if (at + ZIP_END_SIZE + tail.readUInt16LE(at + 20) === tail.length) exact.push(at);
    else others.push(at);
  }
  return { exact, others };
}

// Starting from one end record, it checks that the central directory and the entry headers fit together. It does not read the compressed content (CRC) of the entries.
// Split archives and Zip64 cannot be judged this way, so they are treated as having no problem found.
function checkZipEnd(target, real, tail, tailOffset, at) {
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0) return null;
  const total = tail.readUInt16LE(at + 10);
  const directorySize = tail.readUInt32LE(at + 12);
  const directoryOffset = tail.readUInt32LE(at + 16);
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null;
  if (directoryOffset + directorySize > tailOffset + at) return broken('The zip directory runs past the end marker. The file is damaged.');
  if (directorySize > MAX_ZIP_DIRECTORY) throw new FcError(`The zip directory is too large to judge: ${directorySize} bytes`);
  const directory = readRange(target, real, { offset: directoryOffset, length: directorySize });
  // The entry headers are read through one opened handle, not one open per entry (#326). fileSizeInside checks once that the path is a file inside the target.
  fileSizeInside(target, real);
  let fd = null;
  try {
    let pos = 0;
    for (let index = 0; index < total; index += 1) {
      if (pos + ZIP_CENTRAL_SIZE > directory.length || directory.readUInt32LE(pos) !== ZIP_CENTRAL) return broken('The zip directory is damaged.');
      const offset = directory.readUInt32LE(pos + 42);
      if (offset !== 0xffffffff && index < ZIP_LOCAL_CHECKS) {
        fd ??= fs.openSync(real, 'r');
        const local = Buffer.alloc(4);
        const read = fs.readSync(fd, local, 0, 4, offset);
        if (read < 4 || local.readUInt32LE(0) !== ZIP_LOCAL_SIG) return broken('A zip entry header does not match the directory. The file is damaged.');
      }
      pos += ZIP_CENTRAL_SIZE + directory.readUInt16LE(pos + 28) + directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
    }
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// If the candidate that matches the end of the file is intact, the file is normal. If only another candidate is intact, other data is attached after it, so it is suspicious. Only when all are wrong is it broken.
function checkZip(target, real, size) {
  const tailOffset = Math.max(0, size - ZIP_TAIL);
  const tail = readRange(target, real, { offset: tailOffset, length: ZIP_TAIL });
  const { exact, others } = findZipEnds(tail);
  if (exact.length === 0 && others.length === 0) return broken('The zip end marker is missing. The file may be truncated.');
  let first = null;
  for (const at of exact) {
    const found = checkZipEnd(target, real, tail, tailOffset, at);
    if (found === null) return null;
    first ??= found;
  }
  for (const at of others) {
    const found = checkZipEnd(target, real, tail, tailOffset, at);
    if (found === null) return suspect('There is other data after the zip end marker.');
    first ??= found;
  }
  return first;
}

module.exports = { readZipEntries, checkZip, ZIP_LOCAL };
