'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { FcError, probeArchive, missingProgram } = require('./commands');
const { grant, walk, readRange, fileSizeInside, fileStamp } = require('./target');
const { LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./flatten');
const { REMOVAL_LOG } = require('./removalLog');
const { checkMp4Structure, FIRST_BOXES } = require('./mp4');
const { checkMkvStructure } = require('./mkv');

const HEAD_SIZE = 1024;
const starts = (head, ...bytes) => head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte);
const text = (head, from, to) => head.toString('latin1', from, to);
const riff = (form) => (head) => text(head, 0, 4) === 'RIFF' && text(head, 8, 12) === form;

// Formats with a fixed extension and fixed leading bytes. Formats with loose leading bytes (mp3, mpg, ts) and old tar without a header are not included.
// A mismatch in the leading bytes alone is not called broken. There are normal cases such as a password-protected Office document (OLE2), an .mp4 that holds TS, and BigTIFF.
const FORMATS = [
  { name: 'MP4/MOV', extensions: ['mp4', 'm4v', 'm4a', 'mov', '3gp', '3g2'], match: (head) => FIRST_BOXES.has(text(head, 4, 8)) },
  { name: 'MKV/WebM', extensions: ['mkv', 'mka', 'webm'], match: (head) => starts(head, 0x1a, 0x45, 0xdf, 0xa3) },
  { name: 'AVI', extensions: ['avi'], match: riff('AVI ') },
  { name: 'WAV', extensions: ['wav'], match: (head) => riff('WAVE')(head) || text(head, 0, 4) === 'RF64' },
  { name: 'WebP', extensions: ['webp'], match: riff('WEBP') },
  { name: 'WMV/ASF', extensions: ['wmv', 'wma', 'asf'], match: (head) => starts(head, 0x30, 0x26, 0xb2, 0x75) },
  { name: 'FLV', extensions: ['flv'], match: (head) => text(head, 0, 3) === 'FLV' },
  { name: 'FLAC', extensions: ['flac'], match: (head) => text(head, 0, 4) === 'fLaC' },
  { name: 'Ogg', extensions: ['ogg', 'oga', 'ogv', 'opus'], match: (head) => text(head, 0, 4) === 'OggS' },
  { name: 'JPEG', extensions: ['jpg', 'jpeg', 'jfif'], match: (head) => starts(head, 0xff, 0xd8, 0xff) },
  { name: 'PNG', extensions: ['png'], match: (head) => starts(head, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { name: 'GIF', extensions: ['gif'], match: (head) => text(head, 0, 4) === 'GIF8' },
  { name: 'BMP', extensions: ['bmp'], match: (head) => text(head, 0, 2) === 'BM' },
  { name: 'TIFF', extensions: ['tif', 'tiff'], match: (head) => starts(head, 0x49, 0x49, 0x2a, 0x00) || starts(head, 0x4d, 0x4d, 0x00, 0x2a) },
  // The PDF standard accepts a file if the header is within the first 1024 bytes.
  { name: 'PDF', extensions: ['pdf'], match: (head) => head.includes('%PDF-', 0, 'latin1') },
  { name: 'ZIP', extensions: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'jar', 'apk'], match: (head) => starts(head, 0x50, 0x4b, 0x03, 0x04) || starts(head, 0x50, 0x4b, 0x05, 0x06) || starts(head, 0x50, 0x4b, 0x07, 0x08) },
  { name: '7z', extensions: ['7z'], match: (head) => starts(head, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) },
  { name: 'RAR', extensions: ['rar'], match: (head) => text(head, 0, 6) === 'Rar!\x1a\x07' },
  { name: 'gzip', extensions: ['gz', 'tgz'], match: (head) => starts(head, 0x1f, 0x8b) },
  { name: 'bzip2', extensions: ['bz2', 'tbz2'], match: (head) => text(head, 0, 3) === 'BZh' },
  { name: 'xz', extensions: ['xz', 'txz'], match: (head) => starts(head, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) },
];
const BY_EXTENSION = new Map(FORMATS.flatMap((format) => format.extensions.map((extension) => [extension, format])));
const MP4 = BY_EXTENSION.get('mp4');
const MKV = BY_EXTENSION.get('mkv');
const ZIP = BY_EXTENSION.get('zip');
const SEVEN_ZIP = BY_EXTENSION.get('7z');
// Formats that are read to the end with tar.exe. A file that is only .gz may not be a tar, so it is not included.
// A compressed tar produces an error at the point where it is cut, but it cannot catch a changed body.
const TAR_LISTED = /\.(?:tar|tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|txz)$/i;

const ZIP_END = Buffer.from('PK\x05\x06', 'latin1');
const ZIP_END_SIZE = 22;
const ZIP_TAIL = ZIP_END_SIZE + 65535;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL_SIZE = 46;
// The limit of the check that opens a file for each entry. Entries beyond it are not examined.
const ZIP_LOCAL_CHECKS = 5000;
// The limit for verifying end-marker candidates. It keeps the check from being tied up by a file filled with markers.
const ZIP_END_CANDIDATES = 16;
// The limit of the zip list loaded into memory. Beyond it, no judgment is made.
const MAX_ZIP_DIRECTORY = 64 * 1024 * 1024;
// The limit for reading with tar.exe. It keeps the check from being tied up by a file with a huge number of entries or one that extracts endlessly. Beyond it, no judgment is made.
const TAR_LIMITS = { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 };
// The case where tar.exe said the file is damaged. Errors that are not the file's fault, such as a lock (Error reading) or a name not in the code page (unreadable filename), do not fall here.
const TAR_DAMAGED = /^\S*tar(?:\.exe)?: (?:Error opening archive: )?(?:Truncated input file|Truncated tar archive|Damaged tar archive|truncated \w+ input|bzip decompression failed|Lzma library error:\s+(?:No progress is possible|Corrupted input data))/m;
const TAR_UNRECOGNIZED = /^\S*tar(?:\.exe)?: Error opening archive: Unrecognized archive format/m;

const RIFF_UNKNOWN_SIZE = 0x7fff0000;
const RIFF_FORMATS = new Set(['AVI', 'WAV', 'WebP']);

const broken = (reason) => ({ status: 'broken', reason });
const suspect = (reason) => ({ status: 'suspect', reason });
const SEVEN_ZIP_HEADER = 32;

// If the size in the RIFF header is larger than the file, it was truncated. The size field is written without the first 8 bytes, but some programs write the whole file size, so 8 bytes are tolerated.
// 0 and the maximum value are files written without knowing the size, and an AVI over 2GB has several RIFFs, so the size is only smaller. A value around 2GB may be a file written through a pipe, so it is treated as suspicious.
function checkRiff(head, size) {
  if (head.length < 8 || text(head, 0, 4) !== 'RIFF') return null;
  const declared = head.readUInt32LE(4);
  if (declared === 0 || declared === 0xffffffff) return null;
  if (declared > size && declared >= RIFF_UNKNOWN_SIZE) return suspect('The RIFF header size may be a value written without knowing the size.');
  return declared > size ? broken('The file is smaller than the size in the RIFF header. It may be truncated.') : null;
}

// Finds end-record candidates from the back and returns them as a list of positions. The one whose comment length matches the end of the file comes first.
// The same marker can appear inside a comment or appended data, so the first one found is not trusted as is.
function findZipEnds(tail) {
  const exact = [];
  const others = [];
  for (let at = tail.lastIndexOf(ZIP_END); at !== -1 && exact.length + others.length < ZIP_END_CANDIDATES; at = at === 0 ? -1 : tail.lastIndexOf(ZIP_END, at - 1)) {
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
  let pos = 0;
  for (let index = 0; index < total; index += 1) {
    if (pos + ZIP_CENTRAL_SIZE > directory.length || directory.readUInt32LE(pos) !== ZIP_CENTRAL) return broken('The zip directory is damaged.');
    const offset = directory.readUInt32LE(pos + 42);
    if (offset !== 0xffffffff && index < ZIP_LOCAL_CHECKS) {
      const local = readRange(target, real, { offset, length: 4 });
      if (local.length < 4 || local.readUInt32LE(0) !== ZIP_LOCAL) return broken('A zip entry header does not match the directory. The file is damaged.');
    }
    pos += ZIP_CENTRAL_SIZE + directory.readUInt16LE(pos + 28) + directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
  }
  return null;
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

// It checks the CRC of the 7z start header and whether the end the header points to is inside the file. It does not read the content.
function check7z(head, size) {
  if (head.length < SEVEN_ZIP_HEADER) return broken('The 7z header is truncated.');
  if (zlib.crc32(head.subarray(12, SEVEN_ZIP_HEADER)) !== head.readUInt32LE(8)) return broken('The 7z header is damaged.');
  const end = BigInt(SEVEN_ZIP_HEADER) + head.readBigUInt64LE(12) + head.readBigUInt64LE(20);
  return end > BigInt(size) ? broken('The file is smaller than the end the 7z header points to. It may be truncated.') : null;
}

// It reads to the end with tar.exe. It says broken only when there is a damage message, and any other failure may not be the file's fault, so it goes out as could not judge.
function checkTarListing(real) {
  const { error, status, stderr, entries } = probeArchive(real, TAR_LIMITS);
  if (error) throw new FcError(`Could not read with tar, so it was not judged. (${error.code})`);
  if (TAR_DAMAGED.test(stderr)) return broken('tar reported that the file is truncated or damaged.');
  if (TAR_UNRECOGNIZED.test(stderr)) return suspect('tar cannot read this format. It may not be a tar file, or its beginning may be damaged.');
  // A file compressed with lz4, lzop, and so on is extracted by tar.exe with an external program (#241). If the program is missing, it is not the file's fault, so it is left as could not judge and the name is stated (#245).
  // It looks only when tar.exe ended with a failure. A lookalike line mixed into the output of a normal exit must not turn a healthy file into could not judge (first review).
  const program = status !== 0 ? missingProgram(stderr) : null;
  if (program !== null) throw new FcError(`The external program ${program} needed to extract it is missing, so it was not judged. Put ${program}.exe on PATH to check it.`);
  // If the program exists but fails, it cannot tell file damage from a program problem, so it is not seen as broken (so that remove-broken does not delete it).
  // If it fails while reading after opening the archive, only this line appears, without "Error opening archive:" (first review).
  const child = status !== 0 ? /^[ \t]*\S*tar(?:\.exe)?: (?:Error opening archive: )?Child process exited with status (\d+)\r?$/m.exec(stderr) : null;
  if (child) throw new FcError(`The external extraction program failed (exit code ${child[1]}), so it was not judged. The file may be damaged or the program may have a problem.`);
  if (status !== 0) throw new FcError(`Could not read with tar, so it was not judged. (exit code ${status}: ${stderr.split(/\r?\n/)[0].replace(/[^\x00-\x7f]+/g, '?')})`);
  return entries === 0 ? suspect('The archive has no entries. It may be empty or not fully downloaded.') : null;
}

// It judges files whose leading bytes do not match the format. If it is all zeros or a web page, it is certain that there is no content, so it says broken. Otherwise the file may be normal.
function checkMismatch(format, head) {
  const actual = FORMATS.find((other) => other.match(head));
  if (actual) return suspect(`The extension says ${format.name} but the content is ${actual.name}. It may only have been renamed.`);
  if (head.every((byte) => byte === 0)) return broken('The beginning is all zeros. The file may be empty or its download stopped midway.');
  if (/^\s*<(?:!doctype html|html)/i.test(text(head, 0, head.length))) return broken(`This is a web page, not a ${format.name} file. The download may have gone wrong.`);
  return suspect(`The content does not start in ${format.name} format. It may be encrypted or wrapped in something else.`);
}

// It judges one file and returns { status, reason }. If it finds no problem, it is null. Input/output problems go out as exceptions.
// - broken: a file judged unusable. It is truncated, structurally damaged, or has no content.
// - suspect: suspicious but possibly normal, so it is not made a removal target. A file with only its name changed, an unknown packaging, and an empty file that may have a meaning are such cases.
function inspect(target, real, size) {
  const extension = path.extname(real).slice(1).toLowerCase();
  const format = BY_EXTENSION.get(extension);
  const listed = TAR_LISTED.test(real);
  if (size === 0) {
    // An empty file often has a meaning, as with __init__.py and .gitkeep, so only formats that must have content are seen as broken.
    return format || listed ? broken('The size is 0.') : suspect('The size is 0.');
  }
  if (!format && !listed) return null;
  const head = readRange(target, real, { length: HEAD_SIZE });
  if (format && !format.match(head)) return checkMismatch(format, head);
  let found = RIFF_FORMATS.has(format?.name) ? checkRiff(head, size) : null;
  if (found === null && format === MP4) found = checkMp4Structure(target, real, real);
  if (found === null && format === MKV) found = checkMkvStructure(target, real, real);
  if (found === null && format === ZIP) found = checkZip(target, real, size);
  if (found === null && format === SEVEN_ZIP) found = check7z(head, size);
  if (found !== null) return found;
  return listed ? checkTarListing(real) : null;
}

function skipReason(entry) {
  const parts = entry.relative.split(path.sep);
  if (parts.some((part) => LEFTOVER.test(part))) return 'Not checked because it is a leftover from an earlier job.';
  if (parts.some((part) => SYSTEM_FOLDER.test(part))) return 'Not checked because it is inside a Windows system folder.';
  return null;
}

// Finds broken files among the files under the target. It does not touch files.
// - broken: broken files ({ path, size, reason, stamp })
// - suspect: files that are suspicious but possibly normal ({ path, size, reason, stamp })
//   stamp is the file identification value taken before reading. It is used to compare whether the file changed while it was being judged.
// - unreadable: files that could not be judged because they were locked or unreadable ({ path, reason }). They are not broken files.
// - skipped: items that are not handled ({ path, reason })
// - checked: the number of files examined
// The inside of repository folders and removal record files are left out silently. A repository has many files, and a record cannot be a removal target.
function findBroken(dir) {
  const access = grant(dir, ['read']);
  const result = { target: access.target, broken: [], suspect: [], unreadable: [], skipped: [], checked: 0 };
  for (const entry of walk(access.target)) {
    if (entry.type === 'dir') continue;
    const parts = entry.relative.split(path.sep);
    if (parts.some((part) => REPOSITORY_FOLDER.test(part)) || REMOVAL_LOG.test(path.basename(entry.path))) continue;
    if (entry.type === 'link') {
      result.skipped.push({ path: entry.path, reason: 'Links are not checked.' });
      continue;
    }
    const reason = skipReason(entry);
    if (reason !== null) {
      result.skipped.push({ path: entry.path, reason });
      continue;
    }
    result.checked += 1;
    try {
      const real = access.read(entry.path);
      const stamp = fileStamp(fs.lstatSync(real, { bigint: true }));
      const size = fileSizeInside(access.target, real);
      const found = inspect(access.target, real, size);
      if (found) result[found.status].push({ path: real, size, reason: found.reason, stamp });
    } catch (err) {
      if (err instanceof FcError) result.unreadable.push({ path: entry.path, reason: err.message });
      // So that one file's problem does not lose the results of other files, any exception makes only that file could not judge.
      else result.unreadable.push({ path: entry.path, reason: `Cannot read the file. (${err.code ?? err.message})` });
    }
  }
  return result;
}

function formatBroken(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const lines = [];
  for (const item of result.broken) lines.push(`Broken: ${relative(item.path)} (${item.reason})`);
  for (const item of result.suspect) lines.push(`Suspect: ${relative(item.path)} (${item.reason})`);
  for (const item of result.unreadable) lines.push(`Undetermined: ${relative(item.path)} (${item.reason})`);
  for (const item of result.skipped) lines.push(`Skipped: ${relative(item.path)} (${item.reason})`);
  lines.push(`Checked ${result.checked} files, ${result.broken.length} broken, ${result.suspect.length} suspect, ${result.unreadable.length} undetermined, ${result.skipped.length} skipped`);
  return lines.join('\n');
}

module.exports = { findBroken, formatBroken, inspect };
