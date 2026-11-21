'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, unzip, remove, archiveEntries, freshPath, ensureRoomToExtract, MAX_TAR_DIR, TEMP_SERIAL_RESERVE } = require('./commands');
const { grant, walk, readRange, fileSizeInside, fileStamp, rejectAmbiguousNames, stampVolumeReason } = require('./target');
const { scanTarGzSync } = require('./tarGzScan');
const { checkEntryNames } = require('./entryNames');
const { readSevenZip } = require('./sevenZip');
const { readZipEntries, ZIP_LOCAL } = require('./zip');
const { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER } = require('./guards');
const { moveWithoutOverwrite } = require('./safeMove');

// Formats read with tar.exe. Layered extensions are looked at first.
const ARCHIVE = /\.(?:tar\.gz|tar\.bz2|tar\.xz|zip|tar|tgz|tbz2|txz|7z|rar)$/i;

// Formats where it confirms by content that the original may be deleted. It does not delete the rest.
// For .tar.gz, tar.exe succeeds even if the body changed, so the gzip CRC and the tar structure are checked separately with Node (#197, tarGzScan.js). .tar has no checksum. .tar.xz and .tar.bz2 do not read past the tar end marker, so they can skip the integrity check. RAR was not confirmed.
// tar.exe picks the format by content, not by extension, so it also looks at the leading bytes.
const ZIP = /\.zip$/i;
const TAR_GZ = /\.(?:tar\.gz|tgz)$/i;
const SEVEN_ZIP = /\.7z$/i;
const SEVEN_ZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SEVEN_ZIP_HEADER = 32;

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

// The reason the original must not be deleted. If it may be deleted, it is null.
function keepReason(access, item, entryCount, dryRun) {
  const { archive, dest } = item;
  const head = readRange(access, archive, { length: SEVEN_ZIP_HEADER });
  if (ZIP.test(archive)) {
    if (!head.subarray(0, ZIP_LOCAL.length).equals(ZIP_LOCAL)) return 'Kept because the content does not start as a zip.';
    const scan = readZipEntries(access, archive, entryCount);
    return scan.reason ?? checkEntryNames(scan.entries, dest, dryRun);
  }
  if (SEVEN_ZIP.test(archive)) {
    if (head.length < SEVEN_ZIP_HEADER || !head.subarray(0, SEVEN_ZIP_MAGIC.length).equals(SEVEN_ZIP_MAGIC)) return 'Kept because the content does not start as a 7z.';
    // It reads the header (including a compressed header) and checks the UTF-16 names and sizes and whether each entry has a CRC (#198). tar.exe reads only the first 7z, so
    // it also checks whether the end the header points to matches the end of the file and whether there is data between bodies that is not in the list.
    const size = fileSizeInside(access, archive);
    const scan = readSevenZip((offset, length) => readRange(access, archive, { offset, length }), size);
    if (scan.reason !== undefined) return scan.reason;
    if (scan.entries.length !== entryCount) return `Kept because the number of 7z entries differs from the tar.exe listing. (${scan.entries.length}, listing ${entryCount})`;
    return checkEntryNames(scan.entries.map(({ name, size: entrySize, folder }) => ({ name: folder ? `${name}/` : name, size: entrySize })), dest, dryRun);
  }
  if (TAR_GZ.test(archive)) {
    if (head[0] !== 0x1f || head[1] !== 0x8b) return 'Kept because the content does not start as gzip.';
    // It checks the gzip CRC and length and the tar header checksum and end marker from start to end (#197). The entry count must equal the tar.exe list.
    // The child process also checks every name and size against the extracted result and returns only the reason or the entry count.
    const scan = scanTarGzSync(archive, { verify: { dest, dryRun } });
    if (scan.reason !== undefined) return scan.reason;
    if (scan.count !== entryCount) return `Kept because the number of tar entries differs from the tar.exe listing. (${scan.count}, listing ${entryCount})`;
    return null;
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
