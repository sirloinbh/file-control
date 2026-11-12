'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, unzip, remove, archiveEntries, freshPath, ensureRoomToExtract, oemCodePage, MAX_TAR_DIR, TEMP_SERIAL_RESERVE } = require('./commands');
const { grant, walk, readRange, fileSizeInside, fileStamp, rejectAmbiguousNames, stampVolumeReason } = require('./target');
const { scanTarGzSync } = require('./tarGzScan');
const { readSevenZip } = require('./sevenZip');
const { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER, moveWithoutOverwrite } = require('./flatten');

// Formats read with tar.exe. Layered extensions are looked at first.
const ARCHIVE = /\.(?:tar\.gz|tar\.bz2|tar\.xz|zip|tar|tgz|tbz2|txz|7z|rar)$/i;

// Formats where it confirms by content that the original may be deleted. It does not delete the rest.
// For .tar.gz, tar.exe succeeds even if the body changed, so the gzip CRC and the tar structure are checked separately with Node (#197, tarGzScan.js). .tar has no checksum. .tar.xz and .tar.bz2 do not read past the tar end marker, so they can skip the integrity check. RAR was not confirmed.
// tar.exe picks the format by content, not by extension, so it also looks at the leading bytes.
const ZIP = /\.zip$/i;
const TAR_GZ = /\.(?:tar\.gz|tgz)$/i;
const SEVEN_ZIP = /\.7z$/i;
const ZIP_LOCAL = Buffer.from('PK\x03\x04', 'latin1');
const SEVEN_ZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SEVEN_ZIP_HEADER = 32;
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
// tar.exe turns a name with these characters into _ or drops the front part.
const CHANGED_NAME = /[:?*<>|"\x00-\x1f]/;

// The folder name of an archive name without the extension. If it is not an archive, it is null.
function folderName(name) {
  const match = ARCHIVE.exec(name);
  if (!match || match.index === 0) return null;
  return name.slice(0, match.index);
}

// It decides the new folder to extract each archive under the target into. It does not touch files.
// It does not merge with an existing folder. So that running again does not extract the same content again, it does not add a number and skips.
// - extractions: archives to extract ({ archive, dest, name })
// - skipped: items that are not handled ({ path, reason })
function planExtractions(dir) {
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, extractions: [], skipped: [] };
  const planned = new Set();
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const skip = (reason) => plan.skipped.push({ path: entry.path, reason });
    if (entry.type === 'link') {
      skip('Links are not extracted.');
      continue;
    }
    const name = folderName(path.basename(entry.path));
    if (name === null) continue;
    const parts = entry.relative.split(path.sep);
    try {
      if (parts.some((part) => LEFTOVER.test(part))) throw new FcError('Not extracted because it is a leftover from an earlier job.');
      if (parts.some((part) => SYSTEM_FOLDER.test(part))) throw new FcError('Not extracted because it is inside a Windows system folder.');
      if (parts.some((part) => REPOSITORY_FOLDER.test(part))) throw new FcError('Not extracted because it is inside a repository folder.');
      // If the extracted folder becomes a name such as .git, other commands treat it specially. Leftover names are already filtered out above as archive names.
      if (SYSTEM_FOLDER.test(name) || REPOSITORY_FOLDER.test(name)) throw new FcError(`Not extracted because the folder would get a special name: ${name}`);
      if (name.length > MAX_NAME) throw new FcError(`The folder name is too long: ${name}`);
      const archive = access.read(entry.path);
      const dest = path.join(path.dirname(archive), name);
      const key = dest.toLowerCase();
      if (planned.has(key) || fs.lstatSync(dest, { throwIfNoEntry: false })) throw new FcError(`Not extracted because the name already exists: ${name}`);
      planned.add(key);
      plan.extractions.push({ archive, dest: access.write(dest), name });
    } catch (err) {
      if (err instanceof FcError) skip(err.message);
      else if (err.syscall) skip(`Cannot check the file. (${err.code})`);
      else throw err;
    }
  }
  return plan;
}

// The temporary folder to create next to the archive (.fctl-new-<pid>-<time>-<number>) is passed to tar.exe with -C, so if that path exceeds MAX_TAR_DIR (258 characters),
// unzip refuses (#228). The preview does not call unzip, so it makes the same judgment here and reports based on the archive, not the temporary path (#238).
// It leaves as many characters as the temporary name of zip (TEMP_SERIAL_RESERVE) as room for the number to grow. When reporting, it shows how many characters the archive's folder must be shortened to (first review).
function rejectLongTempDir(archive) {
  const folder = path.dirname(path.resolve(archive));
  const name = `.fctl-new-${process.pid}-${Date.now()}-0`;
  const limit = MAX_TAR_DIR - TEMP_SERIAL_RESERVE - name.length - 1;
  if (folder.length > limit) {
    throw new FcError(`The path of the folder holding the archive is ${folder.length} characters, so tar.exe cannot change into the temporary folder created inside it when extracting (the -C folder can be up to ${MAX_TAR_DIR} characters). Move the archive to a folder of ${limit} characters or fewer and run again.`);
  }
}

// It returns the number of entries and files. A file that was not downloaded to the end reads as 0 entries without an error, so it is seen as a failure.
// Links and device entries are refused before extracting. It does not leave writing through links to tar.exe alone.
// It also checks whether the extracted size fits in the free space (#77). dest is the extraction folder, and the temporary folder is made in the same folder.
function inspectArchive(archive, dest) {
  rejectLongTempDir(archive);
  const entries = archiveEntries(archive);
  if (entries.length === 0) throw new FcError('The archive has no entries. It may be empty or not fully downloaded.');
  const special = entries.find((entry) => !'-hd'.includes(entry[0]));
  if (special !== undefined) throw new FcError(`The archive contains an item such as a link or device. (type ${JSON.stringify(special[0])})`);
  ensureRoomToExtract(dest, entries);
  // An entry ending in / is extracted as a folder even if it has data.
  const files = entries.filter((entry) => entry[0] !== 'd' && !entry.trimEnd().endsWith('/')).length;
  return { entries: entries.length, files };
}

// If the list and the real result differ, some was lost. tar.exe overwrites entries that differ only in case without an error.
// If an unusable name (con.txt, a trailing dot) or a link appears, it is also hard to delete, so it is not produced as a result.
function checkExtracted(temp, fileCount) {
  let files = 0;
  for (const entry of fs.readdirSync(temp, { recursive: true, withFileTypes: true })) {
    const relative = path.relative(temp, path.join(entry.parentPath, entry.name));
    rejectAmbiguousNames(relative, relative);
    if (entry.isSymbolicLink()) throw new FcError(`The archive contains a link: ${relative}`);
    if (entry.isFile()) files += 1;
  }
  if (files !== fileCount) throw new FcError(`The archive listing and the extracted result differ. Some items may have colliding names. (listing ${fileCount}, result ${files})`);
}

function removeTemp(temp, cause) {
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch (err) {
    throw new FcError(`${cause.message} Could not delete the temporary folder: ${temp} (${err.code})`);
  }
}

// It renames after extracting everything into a temporary folder. Even on failure, a partly extracted folder does not remain as a result.
function extractOne(item, access) {
  const archive = access.read(item.archive);
  if (archive !== item.archive) throw new FcError(`The path changed after planning: ${item.archive} -> ${archive}`);
  if (!fs.lstatSync(archive).isFile()) throw new FcError(`No longer a file after planning: ${archive}`);
  if (fs.lstatSync(item.dest, { throwIfNoEntry: false })) throw new FcError(`Not extracted because the name already exists: ${item.name}`);
  const dest = access.write(item.dest);
  if (dest !== item.dest) throw new FcError(`The path changed after planning: ${item.dest} -> ${dest}`);
  const { entries, files } = inspectArchive(archive, path.dirname(item.dest));
  const temp = freshPath(archive, '.fctl-new');
  try {
    unzip(archive, temp, { checkSpace: false });
    checkExtracted(temp, files);
    // renameSync overwrites if the target is a file. The same name may have appeared during extraction, so it uses a move that does not overwrite.
    if (!moveWithoutOverwrite(temp, dest)) throw new FcError(`Not extracted because the name already exists: ${item.name}`);
  } catch (err) {
    removeTemp(temp, err instanceof FcError ? err : new FcError(failureReason(err)));
    throw err;
  }
  return entries;
}

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
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) return 'Kept because it may be a piece of a split archive.';
  const recordOffset = safeNumber(locator.readBigUInt64LE(8));
  const record = recordOffset === null ? Buffer.alloc(0) : readRange(target, archive, { offset: recordOffset, length: ZIP64_END_SIZE });
  if (record.length < ZIP64_END_SIZE || record.readUInt32LE(0) !== ZIP64_END) return 'Kept because the Zip64 structure could not be read.';
  // After passing the record size (the length minus the first 12 bytes), the locator must appear right away.
  const recordSize = safeNumber(record.readBigUInt64LE(4));
  if (recordSize === null || recordOffset + 12 + recordSize !== locatorAt) return 'Kept because the Zip64 structure does not match the file size.';
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0 || record.readBigUInt64LE(24) !== record.readBigUInt64LE(32)) return 'Kept because it may be a piece of a split archive.';
  const total = safeNumber(record.readBigUInt64LE(32));
  const directorySize = safeNumber(record.readBigUInt64LE(40));
  const directoryOffset = safeNumber(record.readBigUInt64LE(48));
  if (total === null || directorySize === null || directoryOffset === null) return 'Kept because the Zip64 structure could not be read.';
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
  if (sorted.length > 0 && sorted[0].offset !== 0) return 'Kept because there is data at the start of the zip that is not in the directory.';
  for (const [i, entry] of sorted.entries()) {
    const expected = i + 1 < sorted.length ? sorted[i + 1].offset : directoryOffset;
    const local = read(entry.offset, ZIP_LOCAL_SIZE);
    if (local.length < ZIP_LOCAL_SIZE || !local.subarray(0, ZIP_LOCAL.length).equals(ZIP_LOCAL)) return 'Kept because the zip structure could not be read.';
    const dataEnd = entry.offset + ZIP_LOCAL_SIZE + local.readUInt16LE(26) + local.readUInt16LE(28) + entry.compressed;
    const gap = expected - dataEnd;
    if ((local.readUInt16LE(6) & 0x8) === 0) {
      if (gap !== 0) return gap < 0 ? 'Kept because zip entries overlap.' : 'Kept because there is data between zip entries that is not in the directory.';
      continue;
    }
    if (gap === 0) return 'Kept because a zip entry has the data descriptor flag but no descriptor.';
    // The data descriptor may or may not have a signature (4 bytes), and the size fields are 4 or 8 bytes (Zip64 of tar.exe uses 8 bytes).
    // So the length is decided by the distance to the next entry, and it checks that the CRC and the compressed size match the central directory.
    const layout = { 12: [false, false], 16: [true, false], 20: [false, true], 24: [true, true] }[gap];
    if (!layout) return gap < 0 ? 'Kept because zip entries overlap.' : 'Kept because there is data between zip entries that is not in the directory.';
    const [signed, wide] = layout;
    const descriptor = read(dataEnd, gap);
    if (descriptor.length !== gap || (signed && descriptor.readUInt32LE(0) !== ZIP_DESCRIPTOR)) return 'Kept because the zip structure could not be read.';
    const at = signed ? 4 : 0;
    const compressed = wide ? safeNumber(descriptor.readBigUInt64LE(at + 4)) : descriptor.readUInt32LE(at + 4);
    if (descriptor.readUInt32LE(at) !== entry.crc || compressed !== entry.compressed) return 'Kept because a zip data descriptor differs from the central directory. Other data may sit between entries.';
  }
  if (sorted.length === 0 && directoryOffset !== 0) return 'Kept because there is data at the start of the zip that is not in the directory.';
  return null;
}

// It reads the central directory of the zip and returns the entry list. If it cannot be trusted, it returns a reason string.
// tar.exe trusts the first end record it meets from the end, so for an uncompressed zip inside a truncated zip, or a concatenated zip, it extracts only part and succeeds.
// So it checks that the end record fits exactly at the end of the file and the central directory continues right before it. For Zip64, it looks at the Zip64 end record.
function readZipEntries(target, archive, entryCount) {
  const size = fileSizeInside(target, archive);
  const tailOffset = Math.max(0, size - ZIP_TAIL);
  const tail = readRange(target, archive, { offset: tailOffset, length: ZIP_TAIL });
  const at = tail.lastIndexOf(ZIP_END);
  if (at === -1 || at + ZIP_END_SIZE > tail.length) return 'Kept because the zip end marker is missing and the file may be truncated.';
  const end = tailOffset + at;
  if (end + ZIP_END_SIZE + tail.readUInt16LE(at + 20) !== size) return 'Kept because there is other data after the zip end marker.';
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  // If the entry count of this disk differs from the total entry count, tar.exe reads the local headers in order instead of the central directory (measured in the first review).
  if (tail.readUInt16LE(at + 8) !== tail.readUInt16LE(at + 10)) return 'Kept because it may be a piece of a split archive.';
  let total = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  let directoryEnd = end;
  const locatorAt = end - ZIP64_LOCATOR_SIZE;
  const locator = locatorAt >= 0 ? readRange(target, archive, { offset: locatorAt, length: 4 }) : Buffer.alloc(0);
  if (locator.length === 4 && locator.readUInt32LE(0) === ZIP64_LOCATOR) {
    // The values of the 32-bit end record must be the Zip64 marker (all-ones values) or equal to the Zip64 end record.
    const zip64 = readZip64End(target, archive, locatorAt);
    if (typeof zip64 === 'string') return zip64;
    if ((disk !== 0 && disk !== 0xffff) || (directoryDisk !== 0 && directoryDisk !== 0xffff)) return 'Kept because it may be a piece of a split archive.';
    const agrees = (short, full, marker) => short === marker || short === full;
    if (!agrees(total, zip64.total, 0xffff) || !agrees(directorySize, zip64.directorySize, ZIP_MAX) || !agrees(directoryOffset, zip64.directoryOffset, ZIP_MAX)) {
      return 'Kept because the zip structure does not match the file size. It may be truncated or have another file appended.';
    }
    ({ total, directorySize, directoryOffset, directoryEnd } = zip64);
  } else {
    if (disk !== 0 || directoryDisk !== 0) return 'Kept because it may be a piece of a split archive.';
    if (total === 0xffff || directorySize === ZIP_MAX || directoryOffset === ZIP_MAX) return 'Kept because it has Zip64 markers but no Zip64 end record.';
  }
  if (directoryOffset + directorySize !== directoryEnd) return 'Kept because the zip structure does not match the file size. It may be truncated or have another file appended.';
  if (total !== entryCount) return `Kept because the number of zip entries differs from the extracted list. (${total}, ${entryCount})`;
  const directory = readRange(target, archive, { offset: directoryOffset, length: directorySize });
  const entries = [];
  let pos = 0;
  while (pos < directory.length) {
    if (pos + ZIP_CENTRAL_SIZE > directory.length || directory.readUInt32LE(pos) !== ZIP_CENTRAL) return 'Kept because the zip structure could not be read.';
    const nameEnd = pos + ZIP_CENTRAL_SIZE + directory.readUInt16LE(pos + 28);
    const extraEnd = nameEnd + directory.readUInt16LE(pos + 30);
    const entryEnd = extraEnd + directory.readUInt16LE(pos + 32);
    if (entryEnd > directory.length) return 'Kept because the zip structure could not be read.';
    const bytes = directory.subarray(pos + ZIP_CENTRAL_SIZE, nameEnd);
    const unicode = (directory.readUInt16LE(pos + 8) & 0x800) !== 0;
    let name = bytes.toString('utf8');
    if (!unicode && bytes.some((byte) => byte >= 0x80)) {
      name = decodeOemName(bytes);
      if (name === null) return 'Kept because there is an item whose name may differ depending on the code page.';
    }
    // If a 32-bit field is all ones, the Zip64 extra field holds only that field, in the order original size, compressed size, local header position, and disk number.
    let size = directory.readUInt32LE(pos + 24);
    let compressed = directory.readUInt32LE(pos + 20);
    let offset = directory.readUInt32LE(pos + 42);
    const startDisk = directory.readUInt16LE(pos + 34);
    if (size === ZIP_MAX || compressed === ZIP_MAX || offset === ZIP_MAX || startDisk === 0xffff) {
      const extra = extraField(directory.subarray(nameEnd, extraEnd), ZIP64_EXTRA);
      if (!extra) return 'Kept because the Zip64 structure could not be read.';
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
      if (size === null || compressed === null || offset === null) return 'Kept because the Zip64 structure could not be read.';
      if (startDisk === 0xffff && (at64 + 4 > extra.length || extra.readUInt32LE(at64) !== 0)) return 'Kept because it may be a piece of a split archive.';
    } else if (startDisk !== 0) {
      return 'Kept because it may be a piece of a split archive.';
    }
    entries.push({ name, size, compressed, offset, crc: directory.readUInt32LE(pos + 16) });
    pos = entryEnd;
  }
  if (pos !== directory.length || entries.length !== total) return 'Kept because the zip structure could not be read.';
  const layout = checkZipLayout(target, archive, entries, directoryOffset);
  if (layout !== null) return layout;
  return entries.map(({ name, size }) => ({ name, size }));
}

// It checks that the entry was extracted under its original name. Even if the content remains, the name may exist only in the original.
// The preview has no extracted result, so it looks only at the name letters. If there is no size, it does not look at the size.
function checkEntryNames(entries, dest, dryRun) {
  for (const { name, size } of entries) {
    if (CHANGED_NAME.test(name)) return `Kept because an item would get a different name when extracted: ${JSON.stringify(name)}`;
    const relative = name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    const folder = relative === '' || relative.endsWith('/');
    if (folder && size > 0) return `Kept because a folder entry has content: ${JSON.stringify(name)}`;
    if (dryRun) continue;
    const stat = fs.lstatSync(path.join(dest, relative), { throwIfNoEntry: false });
    if (!stat) return `Kept because an item was not extracted under the same name: ${JSON.stringify(name)}`;
    if (folder ? !stat.isDirectory() : size !== undefined && (!stat.isFile() || stat.size !== size)) return `Kept because the extracted size differs: ${JSON.stringify(name)}`;
  }
  return null;
}

// The reason the original must not be deleted. If it may be deleted, it is null.
function keepReason(access, item, entryCount, dryRun) {
  const { archive, dest } = item;
  const head = readRange(access.target, archive, { length: SEVEN_ZIP_HEADER });
  if (ZIP.test(archive)) {
    if (!head.subarray(0, ZIP_LOCAL.length).equals(ZIP_LOCAL)) return 'Kept because the content does not start as a zip.';
    const entries = readZipEntries(access.target, archive, entryCount);
    return typeof entries === 'string' ? entries : checkEntryNames(entries, dest, dryRun);
  }
  if (SEVEN_ZIP.test(archive)) {
    if (head.length < SEVEN_ZIP_HEADER || !head.subarray(0, SEVEN_ZIP_MAGIC.length).equals(SEVEN_ZIP_MAGIC)) return 'Kept because the content does not start as a 7z.';
    // It reads the header (including a compressed header) and checks the UTF-16 names and sizes and whether each entry has a CRC (#198). tar.exe reads only the first 7z, so
    // it also checks whether the end the header points to matches the end of the file and whether there is data between bodies that is not in the list.
    const size = fileSizeInside(access.target, archive);
    const scan = readSevenZip((offset, length) => readRange(access.target, archive, { offset, length }), size);
    if (scan.reason !== undefined) return scan.reason;
    if (scan.entries.length !== entryCount) return `Kept because the number of 7z entries differs from the tar.exe listing. (${scan.entries.length}, listing ${entryCount})`;
    return checkEntryNames(scan.entries.map(({ name, size: entrySize, folder }) => ({ name: folder ? `${name}/` : name, size: entrySize })), dest, dryRun);
  }
  if (TAR_GZ.test(archive)) {
    if (head[0] !== 0x1f || head[1] !== 0x8b) return 'Kept because the content does not start as gzip.';
    // It checks the gzip CRC and length and the tar header checksum and end marker from start to end (#197). The entry count must equal the tar.exe list.
    const scan = scanTarGzSync(archive);
    if (scan.reason !== undefined) return scan.reason;
    if (scan.entries.length !== entryCount) return `Kept because the number of tar entries differs from the tar.exe listing. (${scan.entries.length}, listing ${entryCount})`;
    return checkEntryNames(scan.entries.map(({ name, size }) => ({ name, size: size ?? undefined })), dest, dryRun);
  }
  return 'Kept because it cannot be confirmed that the extracted content of this format is intact.';
}

// If the extracted archive changed after that, it does not delete. What is deleted must be the very file whose content was checked.
// before is the fileStamp taken before extracting. It also looks at the change time, so even a rewrite in place with the same size and a restored modification time is noticed.
function removeArchive(access, item, before, dryRun) {
  const archive = access.delete(item.archive);
  if (archive !== item.archive) throw new FcError(`Not deleted because the path changed after extracting: ${item.archive} -> ${archive}`);
  const stat = fs.lstatSync(archive, { bigint: true });
  if (!stat.isFile() || fileStamp(stat) !== before) throw new FcError(`Not deleted because the file changed after extracting: ${archive}`);
  try {
    remove([archive], { dryRun });
  } catch (err) {
    // The FcError of the Recycle Bin move carries only the reason, so the context that it is after extracting is added (#185). Other errors get it from removalFailure.
    if (err instanceof FcError) throw new FcError(`${dryRun ? 'Even if extracted, the original cannot be deleted.' : 'Extracted, but could not delete the original.'} ${err.message}`);
    throw err;
  }
}

// The preview did not really extract, so it reports with "Even if extracted, ..." (#185 first review).
function removalFailure(err, dryRun) {
  if (err instanceof FcError) return err.message;
  return `${dryRun ? 'Even if extracted, the original cannot be checked or sent to the Recycle Bin.' : 'Extracted, but could not check the original or send it to the Recycle Bin.'} (${err.code ?? err.status})`;
}

function failureReason(err) {
  if (err instanceof FcError) return err.message;
  // The errors of tar.exe come out in the code page and Korean is garbled, so only the exit code is used.
  if (err.status !== undefined && err.status !== null) return `Could not extract. The archive may be damaged, encrypted, or contain a path that points outside the target or a name that cannot be used. (tar exit code ${err.status})`;
  return `Could not extract. (${err.code})`;
}

// It extracts each archive under the target into a new folder. It does not extract again an archive that came out of an extraction.
// If removeArchives is given, it sends archives that extracted normally to the Recycle Bin. It does not delete archives that were skipped or failed.
// The returned value is { target, dryRun, removeArchives, extracted, skipped, removed, kept, failed }.
// extracted is { archive, dest, name, entries }, removed is paths, and kept and failed are lists of { archive, reason }. A file that was extracted but could not be deleted goes in failed.
function extractArchives(dir, options = {}) {
  return applyExtractions(planExtractions(dir), options);
}

function applyExtractions(plan, { dryRun = false, removeArchives = false } = {}) {
  const result = { target: plan.target, dryRun, removeArchives, extracted: [], skipped: plan.skipped, removed: [], kept: [], failed: [] };
  const access = grant(plan.target, removeArchives ? ['read', 'write', 'delete'] : ['read', 'write']);
  // On a volume without a change time (exFAT and so on), it cannot recognize an archive that changed to the same size after extracting, so it does not delete (#184).
  const volumeReason = removeArchives && plan.extractions.length > 0 ? stampVolumeReason(plan.target) : null;
  for (const item of plan.extractions) {
    let before;
    let entries;
    try {
      // ReFS file IDs exceed 2^53 and would lose precision as numbers, so they are received as bigint.
      before = fileStamp(fs.lstatSync(item.archive, { bigint: true }));
      entries = dryRun ? inspectArchive(item.archive, path.dirname(item.dest)).entries : extractOne(item, access);
      result.extracted.push({ ...item, entries });
    } catch (err) {
      result.failed.push({ archive: item.archive, reason: failureReason(err) });
      continue;
    }
    if (!removeArchives) continue;
    try {
      const reason = volumeReason ?? keepReason(access, item, entries, dryRun);
      if (reason !== null) {
        result.kept.push({ archive: item.archive, reason });
        continue;
      }
      removeArchive(access, item, before, dryRun);
      result.removed.push(item.archive);
    } catch (err) {
      result.failed.push({ archive: item.archive, reason: removalFailure(err, dryRun) });
    }
  }
  return result;
}

function formatExtractions(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [];
  for (const item of result.extracted) lines.push(`${prefix}Extract: ${relative(item.archive)} -> ${relative(item.dest)} (${item.entries} items)`);
  for (const archive of result.removed) lines.push(`${prefix}Move to the Recycle Bin: ${relative(archive)}`);
  for (const item of result.kept) lines.push(`${prefix}Kept: ${relative(item.archive)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.archive)} (${item.reason})`);
  const removal = result.removeArchives ? `, Recycle Bin ${result.removed.length}, kept ${result.kept.length}` : '';
  lines.push(`${prefix}Extract ${result.extracted.length}${removal}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
  return lines.join('\n');
}

module.exports = { planExtractions, applyExtractions, extractArchives, formatExtractions };
