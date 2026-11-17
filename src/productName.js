'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError } = require('./commands');
const { grant, walk, readRange } = require('./target');
const { readMp4Metadata } = require('./mp4');
const { readMkvMetadata } = require('./mkv');
const { extractProductNumbers, findProductNumber, findAttachedProductNumbers, halfWidth } = require('./product');
const { MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER, moveWithoutOverwrite, leftoverNote } = require('./flatten');

// It handles only video files. It does not rename even the subtitles or notes inside an ABC-123 folder.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.m2ts', '.mpg', '.mpeg']);
// A format whose extension is the same as TypeScript source. It is seen as video only after checking the content.
const TRANSPORT_EXTENSIONS = new Set(['.ts', '.mts']);
// MPEG-TS starts with 0x47 every 188 bytes, and AVCHD, with 4 extra bytes in front, every 192 bytes.
const TRANSPORT_LAYOUTS = [
  [0, 188],
  [4, 192],
];
const TRANSPORT_HEAD = 4 + 2 * 192 + 1;

function isTransportStream(target, relative) {
  const head = readRange(target, relative, { length: TRANSPORT_HEAD });
  return TRANSPORT_LAYOUTS.some(([start, step]) => head[start] === 0x47 && head[start + step] === 0x47 && head[start + 2 * step] === 0x47);
}
// Formats whose metadata can be read. For the rest, it looks only in the file name and folder names.
const MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.3gp']);
const MKV_EXTENSIONS = new Set(['.mkv', '.webm']);

// Even if it cannot read the metadata, it continues looking in the file name and folder names. The reason is reported together when none is found.
function readTags(target, entry, ext) {
  const reader = MP4_EXTENSIONS.has(ext) ? readMp4Metadata : MKV_EXTENSIONS.has(ext) ? readMkvMetadata : null;
  if (!reader) return {};
  try {
    return reader(target, entry.relative);
  } catch (err) {
    if (!(err instanceof FcError)) throw err;
    return { metadataError: err.message };
  }
}

// Even if letters are attached to the number (ABC-123-01, ABC-123A, 1ABC-123), it is seen as already present. ABC-1234 is not ABC-123.
function containsNumber(name, number) {
  // number is only English upper-case letters, a hyphen, and digits, so it can go into a regular expression as is.
  return new RegExp(`(?<!\\p{Script=Latin}\\p{M}*)${number}(?!\\d)`, 'u').test(halfWidth(name).toUpperCase());
}

// It checks whether the number was written in the name without a hyphen (ABC123, ABC_123, ABC 123, abc123). If a Latin letter is attached in front or digits continue after, it is a different word.
function containsUnhyphenatedNumber(name, number) {
  const [letters, digits] = number.split('-');
  return new RegExp(`(?<!\\p{Script=Latin}\\p{M}*)${letters}[_ ]?${digits}(?!\\d)`, 'u').test(halfWidth(name).toUpperCase());
}

// If the numbers of the title and the folder conflict, it cannot be known which one is right. The comment can hold other text, so if the title or folder has a number, it is not put into the judgment.
function chooseNumber(found) {
  const trusted = found.candidates.filter((candidate) => candidate.source !== 'comment');
  const list = trusted.length > 0 ? trusted : found.candidates;
  return list.length === 1 ? list[0] : null;
}

// It makes a plan to put the product number in the names of the video files under the target. It does not touch files.
// - renames: files to rename ({ from, to, name, number, source, note })
// - already: files left as they are because the name already has a number ({ path, number })
//   A lowercase word in a file name (abc-123, trip-2023) is not certain to be a number. It is seen as a number only when there is no number elsewhere or it is the same, and if different, it goes into conflicts.
// - notFound: files where no number was found ({ path, note }). note is the reason the metadata could not be read, and if none, null.
// - conflicts: files not chosen because the numbers found conflict ({ path, numbers, note })
//   The note of renames and conflicts is also the reason the metadata could not be read. Even when renaming by the folder number, it cannot be known whether the title had a different number, so it reports it (#90).
// - skipped: items that are not handled ({ path, reason })
//   Subfolders that could not be read also go here, and it continues looking at the other files. Files are changed one by one, so not seeing some folders does not affect other files (#74).
function planProductNames(dir) {
  const access = grant(dir, ['read', 'write']);
  const plan = { target: access.target, renames: [], already: [], notFound: [], conflicts: [], skipped: [] };
  const unreadable = [];
  const entries = walk(access.target, { unreadable });
  for (const folder of unreadable) plan.skipped.push({ path: folder.path, reason: folder.reason });
  for (const entry of entries) {
    if (entry.type === 'dir') continue;
    const skip = (reason) => plan.skipped.push({ path: entry.path, reason });
    // A link that points to a folder reports that its inside was not looked at, even without an extension.
    if (entry.type === 'link') {
      skip('Links are not renamed.');
      continue;
    }
    const name = path.basename(entry.path);
    const { name: base, ext } = path.parse(name);
    const extension = ext.toLowerCase();
    const transport = TRANSPORT_EXTENSIONS.has(extension);
    if (!VIDEO_EXTENSIONS.has(extension) && !transport) continue;
    const parts = entry.relative.split(path.sep);
    try {
      const from = access.read(entry.path);
      // A .ts that is not video is not reported wherever it is. So it checks the content before deciding whether to skip it.
      if (transport && !isTransportStream(access.target, entry.relative)) continue;
      if (parts.some((part) => LEFTOVER.test(part))) throw new FcError('Not renamed because it is a leftover from an earlier job.');
      if (parts.some((part) => SYSTEM_FOLDER.test(part))) throw new FcError('Not renamed because it is inside a Windows system folder.');
      if (parts.some((part) => REPOSITORY_FOLDER.test(part))) throw new FcError('Not renamed because it is inside a repository folder.');
      if (name.startsWith('.')) throw new FcError('Not renamed because adding the number in front of a name that starts with a dot would make it no longer a hidden name.');
      const inName = extractProductNumbers(name);
      if (inName.length > 0) {
        // If a move of the old method stopped midway, an empty file with the numbered name was left (#73). It is not counted as an already-changed video and is reported separately.
        if (fs.lstatSync(from).size === 0) throw new FcError('The file is empty. It may be a placeholder left when an earlier run stopped midway; check it and delete it.');
        plan.already.push({ path: entry.path, number: inName[0] });
        continue;
      }
      const lowerInName = extractProductNumbers(name, { lowercase: true });
      const { title, comment, metadataError } = readTags(access.target, entry, extension);
      // The file name was looked at above. The names of the target itself and the folders above it are not used.
      const found = findProductNumber({ title, comment, folders: parts.slice(0, -1).reverse() });
      if (!found) {
        if (lowerInName.length > 0) plan.already.push({ path: entry.path, number: lowerInName[0] });
        else plan.notFound.push({ path: entry.path, note: metadataError ?? null });
        continue;
      }
      const chosen = chooseNumber(found);
      const numbers = found.candidates.map((candidate) => candidate.number);
      if (!chosen) {
        plan.conflicts.push({ path: entry.path, numbers: [...new Set([...lowerInName, ...numbers])], note: metadataError ?? null });
        continue;
      }
      // The same number written without a hyphen (ABC123, ABC_123, ABC 123) is also seen as already present (#75).
      if (containsNumber(name, chosen.number) || containsUnhyphenatedNumber(name, chosen.number)) {
        plan.already.push({ path: entry.path, number: chosen.number });
        continue;
      }
      // If there is another number that has letters attached and is not caught by the number rule (ABC-123-01, ABC-123A, 1ABC-123), no further number is put in front and it is reported as a conflict (#75).
      const attached = findAttachedProductNumbers(name).filter((number) => number !== chosen.number);
      if (lowerInName.length > 0 || attached.length > 0) {
        plan.conflicts.push({ path: entry.path, numbers: [...new Set([...lowerInName, ...attached, chosen.number])], note: metadataError ?? null });
        continue;
      }
      // It does not use text inside the file and puts only a number that passed the format into the name, so path and control characters from the title do not enter the name.
      const desired = `${chosen.number} ${base}${ext}`;
      if (desired.length > MAX_NAME) throw new FcError(`The name is too long once the number is added: ${desired}`);
      const to = path.join(path.dirname(from), desired);
      if (fs.lstatSync(to, { throwIfNoEntry: false })) throw new FcError(`Not renamed because the name already exists: ${desired}${leftoverNote(from, to)}`);
      plan.renames.push({ from, to: access.write(to), name: desired, number: chosen.number, source: chosen.source, note: metadataError ?? null });
    } catch (err) {
      if (err instanceof FcError) skip(err.message);
      else if (err.syscall) skip(`Cannot check the file. (${err.code})`);
      else throw err;
    }
  }
  return plan;
}

// If the source was replaced by a link or the name got filled between the plan and the run, it does not change it. It does not overwrite and does not avoid it by adding a number.
function applyRename(rename, access) {
  const from = access.delete(rename.from);
  if (from !== rename.from) throw new FcError(`The path changed after planning: ${rename.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`No longer a file after planning: ${from}`);
  // It does not touch an existing item. Opening a broken junction with wx would create a folder outside the target that the junction points to.
  const taken = () => new FcError(`Not renamed because the name already exists: ${rename.name}${leftoverNote(from, rename.to)}`);
  if (fs.lstatSync(rename.to, { throwIfNoEntry: false })) throw taken();
  const to = access.write(rename.to);
  if (to !== rename.to) throw new FcError(`The path changed after planning: ${rename.to} -> ${to}`);
  if (!moveWithoutOverwrite(from, to)) throw taken();
}

// It puts the product number in front of the names of the video files under the target. It does not overwrite, and even if one file fails, it continues with the rest.
// The returned value is { target, dryRun, renamed, already, notFound, conflicts, skipped, failed }. failed is a list of { from, reason }.
function addProductNumbers(dir, { dryRun = false } = {}) {
  return applyProductNames(planProductNames(dir), { dryRun });
}

function applyProductNames(plan, { dryRun = false } = {}) {
  const { renames, target, ...rest } = plan;
  const result = { target, dryRun, renamed: [], ...rest, failed: [] };
  if (dryRun) return { ...result, renamed: renames };
  const access = grant(target, ['write', 'delete']);
  for (const rename of renames) {
    try {
      applyRename(rename, access);
      result.renamed.push(rename);
    } catch (err) {
      result.failed.push({ from: rename.from, reason: err instanceof FcError ? err.message : `Could not rename. (${err.code})` });
    }
  }
  return result;
}

const SOURCE_NAMES = { title: 'title', comment: 'comment', folder: 'folder name' };

function formatProductNumbers(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [];
  for (const item of result.renamed) lines.push(`${prefix}Rename: ${relative(item.from)} -> ${item.name} (${SOURCE_NAMES[item.source]}${item.note ? `, could not read metadata: ${item.note}` : ''})`);
  for (const item of result.already) lines.push(`${prefix}Already present: ${relative(item.path)} (${item.number})`);
  for (const item of result.notFound) lines.push(`${prefix}Not found: ${relative(item.path)}${item.note ? ` (${item.note})` : ''}`);
  for (const item of result.conflicts) lines.push(`${prefix}Numbers disagree: ${relative(item.path)} (${item.numbers.join(', ')}${item.note ? `, could not read metadata: ${item.note}` : ''})`);
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.from)} (${item.reason})`);
  lines.push(
    `${prefix}Rename ${result.renamed.length}, already present ${result.already.length}, not found ${result.notFound.length}, disagree ${result.conflicts.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`,
  );
  return lines.join('\n');
}

module.exports = { planProductNames, applyProductNames, addProductNumbers, formatProductNumbers, containsNumber, isTransportStream, VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS };
