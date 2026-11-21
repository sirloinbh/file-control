'use strict';

// zip, unzip and the tar.exe runner, the name and size checks around them (#315).

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { FcError, POWERSHELL, TAR, ensureCanMakeDir, ensureExists, ensureFree, ensureParentDir, exists, isSameOrUnder, isWindows, overwriteNote, perform, realKey, rejectBareDeviceArgs, rejectNewDeviceName } = require('./base');
const { asidePath, formatSize, freshPath, hasAncestorSameAs, isSameFile, rejectStreamPath } = require('./fsOps');

// The system OEM code page number. tar.exe reads and writes the names of zip entries that have no UTF-8 marker in this code page (#173, #83).
// If it cannot be confirmed, it is null. Once read, it is remembered.
let oemCodePageCache;

function oemCodePage() {
  if (oemCodePageCache !== undefined) return oemCodePageCache;
  oemCodePageCache = null;
  if (!isWindows) return null;
  try {
    const output = childProcess.execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage').OEMCP"], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const cp = Number(output.trim());
    if (Number.isSafeInteger(cp) && cp > 0) oemCodePageCache = cp;
  } catch {
    // If it cannot be confirmed, it is left null. The user of it does not trust the name.
  }
  return oemCodePageCache;
}

// tar.exe takes arguments in the system code page, so it either changes a character not in that code page into a similar letter (é -> e) or ends abnormally.
// If passed on as is, it could bundle another file or write to another folder, so if there is a character that would change, it refuses before running.
// Arguments are taken in the ANSI code page but zip and cpio entry names are written in the OEM code page. On English Windows (ANSI 1252, OEM 437),
// bundling COM¹.tar.gz into zip and extracting it became COM1.tar.gz without an error (#136). So for those entry names it refuses a character that would change in either ANSI or OEM.
// The entry names of formats other than the path arguments (pax tar, 7z, jar, iso, and so on) do not go through OEM (#173, confirmed on the English Windows of CI).
// If withOem is false, it looks only at ANSI. If codePages is given, it looks at that instead of the system code pages (for tests).
function unsupportedChars(text, codePages = null, { withOem = true } = {}) {
  if (!isWindows) return [];
  const chars = [...new Set(text.replace(/[\x00-\x7f]/g, ''))];
  if (chars.length === 0) return [];
  // If even one code page cannot be confirmed, it stops and refuses to run, so that the check does not pass in a weakened state.
  // If OEMCP is empty, [int] becomes 0 and GetEncoding(0) returns ANSI, so it is blocked separately.
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    '$cps = if ($env:FC_CODEPAGES) { $env:FC_CODEPAGES -split "," } else { ' +
    "@([Text.Encoding]::Default.CodePage) + @(if ($env:FC_WITH_OEM) { (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage').OEMCP }) }; " +
    '$encs = @($cps | ForEach-Object { if ([int]$_ -le 0) { throw "code page $_" }; [Text.Encoding]::GetEncoding([int]$_) }); ' +
    'foreach ($c in ($env:FC_CHARS -split "`n")) { foreach ($e in $encs) ' +
    '{ if ($e.GetString($e.GetBytes($c)) -cne $c) { [char]::ConvertToUtf32($c, 0); break } } }';
  let output;
  try {
    output = childProcess.execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_CHARS: chars.join('\n'), FC_CODEPAGES: codePages ? codePages.join(',') : '', FC_WITH_OEM: withOem ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    throw new FcError(`Could not check the system code page, so tar.exe was not run. (${err.status ?? err.code})`);
  }
  return output.split(/\s+/).filter(Boolean).map((code) => String.fromCodePoint(Number(code)));
}

// tar.exe removes the trailing dot and space of a name but Node handles them literally, so passing a.txt. would bundle a.txt.
function trailingDotOrSpaceName(p) {
  return p.slice(path.parse(p).root.length).split(path.sep).find((part) => /[. ]$/.test(part));
}

// paths are looked at only as ANSI, and oemNames are looked at as OEM too.
function ensureTarCanUse(paths, oemNames = []) {
  if (!isWindows) return;
  const all = [...paths, ...oemNames];
  const trailing = all.find(trailingDotOrSpaceName);
  // It wraps the name in quotes so that the trailing space can be seen.
  if (trailing !== undefined) throw new FcError(`tar.exe cannot handle a name ending with a dot or space: ${JSON.stringify(trailingDotOrSpaceName(trailing))} (${trailing})`);
  let bad = unsupportedChars(paths.join(''), null, { withOem: false });
  let checked = paths;
  if (bad.length === 0) {
    bad = unsupportedChars(oemNames.join(''));
    checked = oemNames;
  }
  if (bad.length === 0) return;
  // There are also characters that look like spaces and Hangul jamo that came from macOS, so it shows the code and the path together with the letters.
  const codes = bad.map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}(${char})`);
  const where = checked.find((p) => bad.some((char) => p.includes(char)));
  throw new FcError(`The name contains characters tar.exe cannot handle: ${codes.join(' ')} (${where})`);
}

// args are the paths passed to tar.exe as arguments, and entries are the names to be written inside the archive (the source names and the names inside the folder to bundle).
// Device names inside a folder are handled as files by tar.exe, so it looks only at the arguments (#135). oemEntries is whether the format writes entry names in OEM (zip, cpio, and formats not checked).
function ensureTarArgs(args, entries = [], { oemEntries = false } = {}) {
  if (oemEntries) ensureTarCanUse(args, entries);
  else ensureTarCanUse([...args, ...entries]);
  rejectBareDeviceArgs(args, 'would be opened as a device by tar.exe and cannot be handled');
}

// The names inside the folder to bundle must also be readable by tar.exe, so they are checked together. Like tar, it follows the source and the junctions inside it.
function namesInside(src) {
  if (!fs.statSync(src).isDirectory()) return [];
  return fs.readdirSync(src, { recursive: true });
}

// tar.exe reads the TAR_READER_OPTIONS and TAR_WRITER_OPTIONS environment variables like --options.
// If mtree:checkfs is in them, it copies the local file at the contents= path of the mtree text into the extraction folder, so they are not passed on (#87).
// Windows environment variable names are case-insensitive.
const TAR_OPTION_ENV = new Set(['TAR_READER_OPTIONS', 'TAR_WRITER_OPTIONS']);

function tarEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !TAR_OPTION_ENV.has(isWindows ? name.toUpperCase() : name)));
}

// tar.exe (libarchive) looks for external compression programs (lz4, lzop, and so on) with SearchPath, and in that order the current folder comes before the PATH.
// So an lz4.exe planted in the folder where fctl was run could be executed (measured on build 26200: a fake lz4.exe in the current folder was executed, #242).
// It always runs tar.exe from the folder where tar.exe lives (System32). Every argument is an absolute path or relative to -C, so the interpretation does not change.
const TAR_CWD = isWindows ? path.dirname(TAR) : undefined;

// 0xC0000005: when tar.exe meets a name it cannot handle, it ends like this without any error message.
function runTar(args, options) {
  try {
    return childProcess.execFileSync(TAR, args, { ...options, env: tarEnv(), cwd: TAR_CWD });
  } catch (err) {
    if (err.status === 0xc0000005) throw new FcError(`tar.exe exited abnormally. A name it cannot handle may be present. (${err.status})`);
    const program = missingProgram(err.stderr);
    if (program !== null) {
      throw new FcError(`This archive is not handled by tar.exe, so it needs the external program ${program}, but it could not be run. Put ${program}.exe on PATH or use another archive format (.zip, .tar.gz, etc.).`);
    }
    throw err;
  }
}

// stderr when tar.exe could not find an external compression program (measured on build 26200). When extracting (including reading the list),
// `Can't initialize filter; unable to run program "lz4 -d -q"`, and when bundling, `Can't launch external program: lz4 -z ...` (#241).
// Compression is identified by content, not by name, so it cannot be known in advance from the extension; it is recognized from this message after a failure. It returns the program name.
// An entry error line (`<entry name>: <reason>`) prints the name as is and can imitate this message, so it is accepted only when the whole tar.exe line matches and
// the program is a known external compression program (first review: an entry name such as `../unable to run program "lz4 x"` hid another failure).
const MISSING_PROGRAM = [
  /^[ \t]*\S*tar(?:\.exe)?: Error opening archive: Can't initialize filter; unable to run program "(lz4|lzop|lrzip|grzip)(?: [^"\r\n]*)?"\r?$/m,
  /^[ \t]*\S*tar(?:\.exe)?: Can't launch external program: (lz4|lzop|lrzip|grzip)(?: [^\r\n]*)?\r?$/m,
];

function missingProgram(stderr) {
  const text = Buffer.isBuffer(stderr) ? stderr.toString('latin1') : String(stderr ?? '');
  for (const pattern of MISSING_PROGRAM) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

// It hands over any value in advance, so that tar.exe does not stall asking for a password on the console for a password-protected archive. It fails with the wrong password.
const NO_PASSWORD = isWindows ? ['--passphrase', 'fctl-no-password'] : [];

// It returns the entries in an archive as lines in tar -tv format. The first character is the kind (d folder, - file, h hard link, l link, and so on).
// RAR folder names do not get a trailing /, so the kind is not judged by name. It only reads, so a broken archive gives an error just like a real extraction.
// Names come out in the code page and Korean can be garbled, so only the count and the first character are trusted.
function archiveEntries(archive) {
  ensureTarArgs([path.resolve(archive)]);
  const listing = runTar(['-tvf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

// The list of entry names in an archive. They come out in the code page, so non-ASCII names cannot be trusted.
function archiveNames(archive) {
  ensureTarArgs([path.resolve(archive)]);
  const listing = runTar(['-tf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
  return listing.toString().split(/\r?\n/).filter((line) => line.trim() !== '');
}

// It reads an archive to the end with tar.exe. It does not raise an error and returns { error, status, stderr, entries }.
// A damage message also comes out with exit code 0 (Damaged tar archive), so the judgment uses stderr. error is a run failure or a limit exceeded (ENOBUFS, ETIMEDOUT).
function probeArchive(archive, { maxBuffer, timeout }) {
  ensureTarArgs([path.resolve(archive)]);
  const { error, status, stdout, stderr } = childProcess.spawnSync(TAR, ['-tf', path.resolve(archive), ...NO_PASSWORD], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer, timeout, env: tarEnv(), cwd: TAR_CWD });
  return { error, status, stderr: stderr ? stderr.toString('latin1') : '', entries: stdout ? stdout.toString('latin1').split(/\r?\n/).filter((line) => line.trim() !== '').length : 0 };
}

// The size column of a tar -tv line. bsdtar writes the kind and permissions, link count, owner, group, and size, in that order.
// For an item with an ACL or extended attributes, one more character such as + or @ is attached at the end of the permission column.
// If the owner name has a space or the item is a device entry (major, minor numbers), it cannot be read, so it does not extract in that case.
const LISTED_SIZE = /^\S{10,11}\s+\d+\s+\S+\s+\S+\s+(\d+)\s/;

// A file takes space in clusters, so it rounds the size up to the cluster size (at least 4KB) and adds.
const DISK_BLOCK = 4096n;

// Files and folders of size 0 also use a file system record (an NTFS MFT record of 1KB) for each entry.
const ENTRY_OVERHEAD = 1024n;

// At least this much must remain even after extracting. It is room for other programs that use the same disk and for the OneDrive sync.
const SPACE_RESERVE = 1024n ** 3n;

// The sum of the sizes written in the list (rounded up by block and with ENTRY_OVERHEAD added per entry). It is a value the archive wrote, so it can differ from the real one.
// Even a case that makes a large empty file only from a size= value, as in mtree text, shows up in the list with that size.
function listedSize(entries, block) {
  let total = 0n;
  for (const line of entries) {
    const match = LISTED_SIZE.exec(line);
    if (!match) throw new FcError(`Could not read the size from the archive listing, so it was not extracted: ${JSON.stringify(line.slice(0, 80))}`);
    total += ((BigInt(match[1]) + block - 1n) / block) * block + ENTRY_OVERHEAD;
  }
  return total;
}

// The free space and the cluster size of the volume that dir will go into. If it is a folder that does not exist yet, it looks at the parent folder that exists.
function freeSpace(dir) {
  let current = path.resolve(dir);
  while (!exists(current) && path.dirname(current) !== current) current = path.dirname(current);
  const stat = fs.statfsSync(current, { bigint: true });
  return { free: stat.bavail * stat.bsize, block: stat.bsize > DISK_BLOCK ? stat.bsize : DISK_BLOCK };
}

// If the extracted size is larger than the free space minus SPACE_RESERVE, it refuses before extracting (#77). It also does not extract if it cannot be confirmed.
// The returned value is the sum of the list sizes (bytes, BigInt).
function ensureRoomToExtract(dest, entries) {
  let space;
  try {
    space = freeSpace(dest);
  } catch (err) {
    throw new FcError(`Could not check the free disk space, so it was not extracted: ${dest} (${err.code ?? err.message})`);
  }
  const need = listedSize(entries, space.block);
  const { free } = space;
  if (need + SPACE_RESERVE > free) {
    throw new FcError(`Extracting would take about ${formatSize(Number(need))} and leave less than ${formatSize(Number(SPACE_RESERVE))} free on the disk, so it was not extracted. (free space ${formatSize(Number(free))})`);
  }
  return need;
}

// It finds the files of the archive that already exist in the extraction folder, which tar would overwrite (#311). Folders may merge, so only file entries count.
// Names in the list come out in the code page, so a non-ASCII letter or ? matches any non-ASCII letter or ? of an existing name (it may refuse too much, never too little).
function rejectExtractOverwrite(names, dest) {
  // A link to a folder is followed, as tar would extract through it.
  const isDir = (full) => fs.statSync(full, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!isDir(dest)) return;
  const fold = (name) => name.replace(/[^\x00-\x7f]|\?/g, '\u0080').toUpperCase();
  const clash = (dir, parts, shown) => {
    let existing;
    try {
      existing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const matches = existing.filter((entry) => fold(entry.name) === fold(parts[0]));
    if (parts.length === 1) return matches.length > 0 && !matches.every((entry) => isDir(path.join(dir, entry.name))) ? shown : undefined;
    for (const entry of matches) {
      if (!isDir(path.join(dir, entry.name))) continue;
      const found = clash(path.join(dir, entry.name), parts.slice(1), shown);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const raw of names) {
    if (/[\\/]$/.test(raw)) continue;
    const parts = raw.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
    if (parts.length === 0) continue;
    const found = clash(dest, parts, raw);
    if (found !== undefined) {
      const garbled = UNRELIABLE_NAME.test(raw) ? ' (non-ASCII names in the archive listing may look garbled because of the code page, so this may be a different file)' : '';
      throw new FcError(`The extraction folder already has a file of the same name, so nothing was extracted: ${found}${garbled}. Use --force to overwrite existing files.`);
    }
  }
}

// Only extract-all, which already made the same check, turns checkSpace off.
function unzip(archive, destDir, { dryRun = false, checkSpace = true, force = false, info } = {}) {
  ensureExists(archive);
  const dest = destDir || path.join(path.dirname(archive), path.parse(archive).name);
  rejectLongName(dest, 'The extraction folder');
  rejectLongTarDir(dest, 'The extraction folder');
  rejectNewDeviceName(dest);
  ensureTarArgs([path.resolve(archive), path.resolve(dest)]);
  let note = '';
  if (dryRun) ensureCanMakeDir(dest);
  if (dryRun || checkSpace) {
    const entries = archiveEntries(archive);
    const size = checkSpace ? ensureRoomToExtract(dest, entries) : null;
    const sizeNote = size === null ? '' : `, extracted size about ${formatSize(Number(size))}`;
    if (dryRun && force && exists(dest) && info) info.overwrites = true;
    if (dryRun) note = ` (${entries.length} items${sizeNote}${exists(dest) ? (force ? ', the destination folder already exists, so files with the same name are overwritten' : ', the destination folder already exists') : ''})`;
  }
  if (isWindows) rejectExtractShortNameClash(archiveNames(archive), dest);
  // tar overwrites existing files while extracting, so without --force it refuses before extracting anything (#311).
  if (!force) rejectExtractOverwrite(archiveNames(archive), dest);
  return perform(`Extract: ${archive} -> ${dest}${note}`, dryRun, () => {
    fs.mkdirSync(dest, { recursive: true });
    runTar(['-xf', path.resolve(archive), '-C', path.resolve(dest), ...NO_PASSWORD], { stdio: ['ignore', 'ignore', 'pipe'] });
  });
}

// -a decides the format by the extension, so the temporary file gets the same extension (including a layered extension such as .tar.gz).
// The temporary name is also used as an --exclude pattern, so it accepts only alphanumeric extensions with no pattern characters.
// tar.exe looks at extensions case-sensitively and makes X.ZIP and x.TAR.GZ an uncompressed tar. So the temporary file gets a lower-case extension.
// However, the compress formats .Z, .taZ, and .tZ are told apart by case (.z is an uncompressed tar, .taz is gzip, .tz is an uncompressed tar), so they are left as they are.
// The format tables (#362): the one place that says which extensions tar.exe reads as a format, as a compression layer, or as tar and compression together,
// and what the screens call them. FORMAT_EXT, COMPRESS_EXT, LAYER_EXT and KEEP_CASE_EXT are made from them, and src/ui/archive.js uses the same tables for its format preview,
// so a new extension added here shows up in both without a second edit.
// Extensions read as a format (FORMAT_EXT of #164, plus tar).
const FORMAT_LABELS = {
  tar: 'tar', zip: 'ZIP', '7z': '7z', cpio: 'cpio', iso: 'ISO 9660', ar: 'ar', shar: 'shar', xar: 'xar', warc: 'WARC', mtree: 'mtree',
};
// Extensions read as a compression layer. Only .Z (upper case) is compress; .z is not seen as compression.
const COMPRESS_LABELS = {
  gz: 'gzip', bz2: 'bzip2', xz: 'xz', zst: 'zstd', lzma: 'lzma', lz: 'lzip', lz4: 'lz4', lzo: 'lzop', lrz: 'lrzip', grz: 'grzip', uu: 'uuencode', Z: 'compress',
};
// Extensions that mean tar and compression together (.taz is gzip, .taZ and .tZ are compress, told apart by case).
const TAR_COMPRESS = {
  tgz: 'gzip', taz: 'gzip', tbz: 'bzip2', tbz2: 'bzip2', tz2: 'bzip2', txz: 'xz', tlz: 'lzma', tzst: 'zstd', tzo: 'lzop', taZ: 'compress', tZ: 'compress',
};
// The extensions told apart by case are the ones with an upper-case letter in the tables.
const KEEP_CASE_EXT = new Set([...Object.keys(COMPRESS_LABELS), ...Object.keys(TAR_COMPRESS)].filter((key) => key !== key.toLowerCase()));
const caseFree = (table) => Object.keys(table).filter((key) => !KEEP_CASE_EXT.has(key));

// Extensions that were confirmed on the English Windows of CI to be written by tar.exe without going through the OEM code page (in UTF-8 or UTF-16) (#173).
// It compares with the value archiveExt returns. .zip and .cpio (including .tar.zip and .tar.cpio) are written in OEM, and an extension that was not checked is also seen as written in OEM.
const ANSI_ENTRY_EXT = new Set(['.tar', '.tgz', '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.gz', '.taZ', '.7z', '.jar', '.iso', '.xar', '.mtree', '.warc']);

// The extensions that tar.exe reads as a format from an archive name, and the extensions that, when they follow, are read as compression (#164).
// Giving x.cpio.gz to tar.exe as it is puts a cpio inside gzip, so the temporary file must also get both extensions for the name and the content to be the same.
// An extension that is not read as a format, such as .jar, makes x.jar.gz also a tar inside gzip, the same as just adding .gz.
const FORMAT_EXT = new Set(Object.keys(FORMAT_LABELS).filter((key) => key !== 'tar'));

const COMPRESS_EXT = new RegExp(`^(?:${caseFree(COMPRESS_LABELS).join('|')})$`, 'i');

// tar.exe peels off compression extensions at the end layer by layer (#193, measured on build 26200: x.tar.gz.gz is a tar inside two layers of gzip, x.cpio.gz.xz is a cpio inside gzip inside xz,
// y.tgz.gz is a tar inside two layers of gzip, y.Z.gz is a compress inside gzip). So it moves
// all the compression extensions continuing from the end (including .tgz and the like, which mean tar and compression together) to the temporary file, so tar.exe decides the format from the original name (lower-cased) the same way. It does not imitate the peeling rules separately.
// Extensions accept only alphanumerics, so no --exclude pattern characters enter the temporary name.
const LAYER_EXT = new RegExp(`^(?:${[...caseFree(COMPRESS_LABELS), ...caseFree(TAR_COMPRESS)].join('|')})$`, 'i');

const isLayerExt = (part) => LAYER_EXT.test(part) || KEEP_CASE_EXT.has(part);

function archiveExt(archive) {
  const parts = path.basename(path.resolve(archive)).split('.');
  // parts[0] is the name, so it is not seen as an extension.
  const usable = (i) => i >= 1 && /^[a-z0-9]+$/i.test(parts[i]);
  const last = parts.length - 1;
  if (!usable(last)) return '';
  let start = last;
  while (usable(start - 1) && isLayerExt(parts[start]) && isLayerExt(parts[start - 1])) start -= 1;
  if (usable(start - 1)) {
    const before = parts[start - 1].toLowerCase();
    // For format plus compression (x.cpio.gz, #164) and an extension after tar (x.tar.gz, x.tar.zip), the earlier extension is also moved.
    const compressed = COMPRESS_EXT.test(parts[start]) || parts[start] === 'Z';
    if ((compressed && (FORMAT_EXT.has(before) || before === 'tar')) || (start === last && before === 'tar')) start -= 1;
  }
  return parts.slice(start).map((part) => `.${KEEP_CASE_EXT.has(part) ? part : part.toLowerCase()}`).join('');
}

// If the archive is inside the folder to bundle, tar also bundles the existing archive, so it must be set aside in advance.
// It can also be reached through a link inside the folder, so a folder that holds a link is also seen as containing it. A UNC alias is caught by file ID.
function archiveInsideSources(archive, sources) {
  const dir = realKey(path.dirname(path.resolve(archive)));
  return sources.some((src) => {
    if (!fs.statSync(src).isDirectory()) return false;
    if (isSameOrUnder(realKey(src), dir) || hasAncestorSameAs(src, archive)) return true;
    return fs.readdirSync(src, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink());
  });
}

// It restores the archive set aside to its original name and throws the original error. If it cannot restore it, it tells where it was set aside.
function restoreAside(archive, aside, err) {
  try {
    fs.renameSync(aside, archive);
  } catch (restoreErr) {
    throw new FcError(`Could not compress, and could not restore the existing archive either: ${archive} (${restoreErr.code}). The existing archive is at ${aside}.`);
  }
  throw err;
}

// It first bundles under a temporary name and, after success, swaps it with the existing archive. If it fails, the existing archive is left as it is.
// Only when the archive is inside the folder to bundle, it sets the existing archive aside and takes it out of the name before running tar. Otherwise it stays under its original name while tar runs.
function writeArchive(archive, sources) {
  const fresh = freshPath(archive, '.fctl-new', archiveExt(archive));
  const early = exists(archive) && archiveInsideSources(archive, sources);
  let aside = early ? asidePath(archive) : null;
  const args = ['-a', '-cf', fresh, '--exclude', path.basename(fresh)];
  if (aside) args.push('--exclude', path.basename(aside));
  for (const src of sources) {
    const full = path.resolve(src);
    const name = path.basename(full);
    // Without ./, tar interprets a name that starts with - or @ as an option or a directive.
    args.push('-C', path.dirname(full), /^[-@]/.test(name) ? `./${name}` : name);
  }
  if (aside) fs.renameSync(archive, aside);
  try {
    runTar(args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (aside) restoreAside(archive, aside, err);
    throw err;
  }
  if (!aside && exists(archive)) {
    aside = asidePath(archive);
    try {
      fs.renameSync(archive, aside);
    } catch (err) {
      fs.rmSync(fresh, { force: true });
      throw err;
    }
  }
  try {
    fs.renameSync(fresh, archive);
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (aside) restoreAside(archive, aside, err);
    throw err;
  }
  if (aside) {
    try {
      fs.rmSync(aside, { force: true });
    } catch (err) {
      throw new FcError(`Compressed, but could not delete the existing archive: ${aside} (${err.code})`);
    }
  }
}

// A name that looks like an 8.3 short name (LONGNA~1.TXT). Before ~ there are 1 to 6 characters, and ~ may appear in it (~$LONG~1.DOC). The extension is 0 to 3 characters.
const SHORT_NAME = /^([^.]{1,6})~(\d{1,6})(?:\.([^.]{1,3}))?$/i;

// It estimates generously whether name could be the 8.3 short name of another name other. Windows upper-cases the long name (removing spaces and dots, and turning
// +,;=[] into _) and cuts the name and extension by OEM code page bytes. If there are many of the same name or the name is short, it appends a hash after the first 1 to 2 bytes,
// and a letter not in OEM is dropped or becomes _. So it compares only the first letter and the front part of the extension, and if a non-ASCII letter is involved, it assumes they can overlap.
// It can also refuse names that do not really overlap. A name that contains ~N is rare, so that side is safe (#159).
// An ASCII name that is originally in 8.3 form (name of 1 to 8 characters, extension of 0 to 3 characters, at most one dot, and only characters that 8.3 uses as they are). For such names Windows
// does not make a separate short name regardless of case (measured with dir /x on build 26200: photo.jpg, PHOTO2.JPG, Photo3.Jpg, noext, ab~1.txt),
// so they do not overlap with ~N names (#205). A short name is made for a space, +,;=[], two dots, a leading or trailing dot, 9 or more characters, and a 4-character extension.
// A non-ASCII name (é.txt, a Hangul name) also made no short name when it fit 8.3 in OEM bytes, but it differs by code page, so it is generously assumed that they can overlap.
const PLAIN_8DOT3 = /^[A-Za-z0-9!#$%&'()\-@^_`{}~]{1,8}(?:\.[A-Za-z0-9!#$%&'()\-@^_`{}~]{1,3})?$/;

function couldBeShortNameOf(name, other) {
  const short = SHORT_NAME.exec(name);
  if (!short || name.toUpperCase() === other.toUpperCase()) return false;
  if (PLAIN_8DOT3.test(other)) return false;
  // It strips the leading dots and spaces and splits off the extension (..foo is FOO~1, .gitignore is GITIGN~1).
  const trimmed = other.replace(/^[ .]+/, '');
  const dot = trimmed.lastIndexOf('.');
  const rawBase = dot >= 0 ? trimmed.slice(0, dot) : trimmed;
  const rawExt = dot >= 0 ? trimmed.slice(dot + 1) : '';
  const clean = (text) => text.toUpperCase().replace(/[ .]/g, '').replace(/[+,;=[\]]/g, '_');
  // Some letters become ASCII when upper-cased (ﬁ -> FI), so whether it is ASCII is judged by the letters before changing.
  const nonAscii = (text) => /[^\x00-\x7f]/.test(text);
  // A letter not in OEM is dropped and the later letters move forward, so if one is anywhere in the name, it is assumed they can overlap.
  const base = nonAscii(rawBase) ? '\u0080' : clean(rawBase);
  const ext = nonAscii(rawExt) ? '\u0080' : clean(rawExt);
  // The short side's extension is the front part of the long name's extension. If there is no extension, the long name has none either.
  const shortExt = (short[3] ?? '').toUpperCase();
  const extMatches = nonAscii(ext) || nonAscii(shortExt) || (shortExt === '' ? ext === '' : [...shortExt].every((char, i) => char === '_' || ext[i] === char));
  if (!extMatches) return false;
  const head = short[1].toUpperCase()[0];
  return head === '_' || nonAscii(head) || nonAscii(base.slice(0, 6)) || base[0] === head;
}

// If the extraction volume makes short names, LONGNA~1.TXT and longname.txt in one folder become the same file depending on the extraction order, and one is overwritten (#159).
// If a source is given as a short name, tar.exe writes that short name as is as the entry name, so the top-level name is also looked at. It checks for each folder in the archive.
// inside is the result of namesInside for each source.
function rejectShortNameClash(sources, inside) {
  const top = sources.map((src) => path.basename(path.resolve(src)));
  // When they overlap at the top, it reports by the source path so you can see which source it is.
  const levels = new Map([['', top.map((name, i) => ({ name, shown: sources[i] }))]]);
  sources.forEach((src, i) => {
    for (const rel of inside[i]) {
      const dir = path.join(top[i], path.dirname(rel));
      if (!levels.has(dir)) levels.set(dir, []);
      levels.get(dir).push({ name: path.basename(rel), shown: path.join(dir, path.basename(rel)) });
    }
  });
  for (const items of levels.values()) {
    for (const item of items.filter(({ name }) => SHORT_NAME.test(name))) {
      const other = items.find(({ name }) => couldBeShortNameOf(item.name, name));
      if (other !== undefined) {
        throw new FcError(`Names that could collide through 8.3 short names are together, so they are not bundled. One could overwrite the other when extracting: ${item.shown}, ${other.shown}`);
      }
    }
  }
}

// When extracting, it prevents a ~N name in the archive from becoming another file through a short name (#188). names is the result of archiveNames, and dest is the extraction folder.
// 1) If it could overlap with another item in the same folder by short name, one is overwritten depending on the extraction order, so it refuses (the same estimate as rejectShortNameClash).
//    Windows is case-insensitive, so a/ and A/ are seen as the same folder.
// 2) If a ~N name reaches an item that already exists in the extraction folder as a short name, it would overwrite an existing file or mix into an existing folder, so it refuses.
//    ASCII names are judged by the short names that actually exist on the volume (if the name is not in the list but that path exists, it refuses). On a volume that does not make short names, it does not trigger.
// Names in the list come out in the code page, so a non-ASCII letter can become ?, a garbled letter, or another letter. Such letters are seen as a letter that can be anything,
// and such ~N names cannot be checked by path, so they are compared with existing names by estimate. Such a folder name counts as every existing non-ASCII folder at the same position.
const UNRELIABLE_NAME = /[^\x00-\x7f]|\?/;

function rejectExtractShortNameClash(names, dest) {
  const unknown = (name) => name.replace(/[^\x00-\x7f]|\?/g, '\u0080');
  // A short name that contains non-ASCII letters is made only from a long name that contains such letters (the short name of an ASCII long name is ASCII).
  const mayBe = (name, other) => (!UNRELIABLE_NAME.test(name) || UNRELIABLE_NAME.test(other)) && couldBeShortNameOf(unknown(name), unknown(other));
  const levels = new Map();
  for (const raw of names) {
    const parts = raw.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
    parts.forEach((part, i) => {
      const key = parts.slice(0, i).map((p) => p.toUpperCase()).join('/');
      if (!levels.has(key)) levels.set(key, { parts: parts.slice(0, i), items: new Map() });
      levels.get(key).items.set(part.toUpperCase(), part);
    });
  }
  const shown = (parts, name) => [...parts, name].join('/');
  // Non-ASCII names in the list look garbled, so it reports that they do (second review).
  const garbled = (...texts) => (texts.some((text) => UNRELIABLE_NAME.test(text)) ? ' (non-ASCII names in the archive listing may look garbled because of the code page)' : '');
  for (const { parts, items } of levels.values()) {
    const all = [...items.values()];
    const shorts = all.filter((name) => SHORT_NAME.test(name));
    for (const name of shorts) {
      const other = all.find((candidate) => candidate !== name && mayBe(name, candidate));
      if (other !== undefined) {
        throw new FcError(`The archive contains items that could collide through 8.3 short names, so it is not extracted. One could overwrite the other when extracting: ${shown(parts, name)}, ${shown(parts, other)}${garbled(shown(parts, name), other)}`);
      }
    }
    if (shorts.length === 0) continue;
    for (const place of existingPlaces(dest, parts)) {
      const existing = fs.readdirSync(place);
      const keys = new Set(existing.map((name) => name.toUpperCase()));
      for (const name of shorts) {
        let real;
        let note = '';
        if (UNRELIABLE_NAME.test(name)) {
          real = existing.find((candidate) => mayBe(name, candidate));
          if (real === undefined) continue;
          // The name cannot be confirmed, so an item whose name is exactly the same, as when extracting the same archive again, is also caught here.
          note = ` It might be an item with exactly the same name, but that cannot be confirmed.${garbled(name)}`;
        } else {
          if (keys.has(name.toUpperCase()) || !exists(path.join(place, name))) continue;
          real = existing.find((candidate) => couldBeShortNameOf(name, candidate)) ?? name;
          note = garbled(shown(parts, name));
        }
        throw new FcError(`${shown(parts, name)} in the archive may point to an item that already exists through an 8.3 short name, so it is not extracted. Extracting would overwrite or mix that item: ${path.join(place, real)}${note}`);
      }
    }
  }
}

// The existing folders that the archive's folder path parts can reach from the extraction folder dest. A name that cannot be trusted counts as every existing non-ASCII folder at that position.
function existingPlaces(dest, parts) {
  const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  let places = isDir(dest) ? [dest] : [];
  for (const part of parts) {
    const next = [];
    for (const place of places) {
      if (!UNRELIABLE_NAME.test(part)) {
        if (isDir(path.join(place, part))) next.push(path.join(place, part));
        continue;
      }
      for (const entry of fs.readdirSync(place, { withFileTypes: true })) {
        if (UNRELIABLE_NAME.test(entry.name) && isDir(path.join(place, entry.name))) next.push(path.join(place, entry.name));
      }
    }
    places = next;
  }
  return places;
}

// Which encoding entry names are written in is decided by the innermost format, and outer compression layers do not change it (#212). So from the layers of archiveExt
// it keeps only the innermost judgment (the first extension, and for a format or tar, up to one compression after it) and compares it with ANSI_ENTRY_EXT.
// .tar.gz.gz -> .tar.gz, .gz.xz -> .gz, .tgz.gz -> .tgz, .cpio.gz.xz -> .cpio.gz (not in the list, so it is seen as OEM).
function innerEntryExt(ext) {
  const parts = ext.split('.').filter(Boolean);
  if (parts.length === 0) return ext;
  const first = parts[0].toLowerCase();
  const keep = parts.length > 1 && (FORMAT_EXT.has(first) || first === 'tar') ? 2 : 1;
  return parts.slice(0, keep).map((part) => `.${part}`).join('');
}

// Compressions not built into tar.exe (bsdtar 3.8.9) that run an external program (measured on build 26200: "Can't launch external program: lz4 -z ...").
// If that program is not on the PATH, it ends in a raw failure, so it refuses in advance (#230). If it exists, it leaves the work to tar.exe.
// .tzo is an alias of .tar.lzo (first review).
const EXTERNAL_COMPRESSORS = { lz4: 'lz4', lzo: 'lzop', tzo: 'lzop', lrz: 'lrzip', grz: 'grzip' };

// tar.exe (libarchive filter_fork_windows.c) looks with SearchPath(NULL, name, ".exe"), so it runs only .exe. It does not look at .cmd and .bat of PATHEXT (first review).
// SearchPath also looks in the tar.exe folder, the system folder, and the current folder (fctl pins it to System32, #242), but it looks only at the PATH, so a program that is only there is generously refused.
// Relative PATH entries (., bin, and so on) are resolved by tar.exe relative to System32 and differ from fctl's current folder, so they are not looked at (#242 first review).
function findOnPath(program) {
  for (const raw of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, `${program}.exe`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // It skips places that do not exist or cannot be read.
    }
  }
  return null;
}

function rejectMissingCompressor(archive) {
  for (const part of archiveExt(archive).split('.').filter(Boolean)) {
    const program = EXTERNAL_COMPRESSORS[part.toLowerCase()];
    if (program !== undefined && findOnPath(program) === null) {
      throw new FcError(`A .${part} archive is not handled by tar.exe, so it needs the external program ${program}, but it was not found on PATH. Use another archive format (.gz, .xz, .zst, etc.) or install ${program}: ${archive}`);
    }
  }
}

// The limit of one segment of a file name (NTFS, in UTF-16 characters)
const MAX_NAME_LENGTH = 255;

// If even one segment of a path exceeds the limit, it cannot be created. zip failed at the final rename after bundling under a short temporary name, and unzip failed with a raw ENOENT when creating the extraction folder,
// and the preview looked like a success, so it refuses first, including in the preview (#228).
function rejectLongName(target, what) {
  const full = path.resolve(target);
  const long = full.split(/[\\/]/).slice(1).find((part) => part.length > MAX_NAME_LENGTH);
  if (long !== undefined) {
    throw new FcError(`The ${what} path has a name of ${long.length} characters, so it cannot be created (one name can be up to ${MAX_NAME_LENGTH} characters): ${long.slice(0, 40)}… (${target})`);
  }
}

// tar.exe moves into the folder given with -C, and if that path is longer than this, it fails raw with "could not chdir" (up to 258 UTF-16 characters works).
// It was measured both on this PC (LongPathsEnabled=0) and on CI with long paths turned on (GitHub windows-latest). The tar.exe manifest is longPathAware, but
// it does not apply to changing the working folder (second review). The extraction folder of unzip and the parent folder of the zip source are passed with -C, so it refuses in advance (#228).
const MAX_TAR_DIR = 258;

function rejectLongTarDir(dir, what) {
  const full = path.resolve(dir);
  if (full.length > MAX_TAR_DIR) {
    throw new FcError(`The ${what} path is ${full.length} characters, so tar.exe cannot change into that folder (up to ${MAX_TAR_DIR}). Specify a shorter path: ${dir}`);
  }
}

// zip bundles into a temporary file in the same folder (.fctl-new-<pid>-<time>-<number><extension layers>) and then renames it. If the extension layers are very long (all layers are moved since #193),
// the temporary name exceeds the limit and tar.exe fails with a raw error, so it refuses in advance (#213). It leaves a few characters as room for the number to grow.
const TEMP_SERIAL_RESERVE = 4;

// tar.exe can extract only up to this many compression layers. From 25 layers it bundles, but when reading it fails with "Input requires too many filters for decoding"
// (measured on build 26200, both gzip and xz). It is refused too, so as not to make an archive that cannot be extracted again (#213).
const MAX_TAR_LAYERS = 24;

function rejectLongTempName(archive) {
  const ext = archiveExt(archive);
  const layers = ext.split('.').filter((part) => part !== '' && isLayerExt(part)).length;
  if (layers > MAX_TAR_LAYERS) {
    throw new FcError(`The archive extension has ${layers} layers, so tar.exe cannot extract it again (up to ${MAX_TAR_LAYERS} layers). Shorten the extension and specify it again: ${archive}`);
  }
  const length = `.fctl-new-${process.pid}-${Date.now()}-0`.length + TEMP_SERIAL_RESERVE + ext.length;
  if (length > MAX_NAME_LENGTH) {
    throw new FcError(`The extension is too long (${ext.length} characters), so the temporary file name used while bundling exceeds ${MAX_NAME_LENGTH} characters. Shorten the extension and specify it again: ${archive}`);
  }
}

function zip(archive, sources, { force = false, dryRun = false, info } = {}) {
  ensureFree(archive, force);
  // Wrapping 7z in one more compression layer makes tar.exe unable to seek back and forth (Seek error), so it cannot be extracted (#164).
  if (archiveExt(archive).startsWith('.7z.')) throw new FcError(`A 7z archive cannot be wrapped in another archive. tar.exe cannot extract it: ${archive}`);
  rejectLongName(archive, 'archive file');
  rejectLongTempName(archive);
  rejectMissingCompressor(archive);
  rejectNewDeviceName(archive);
  sources.forEach(ensureExists);
  for (const src of sources) rejectLongTarDir(path.dirname(path.resolve(src)), "source's parent folder");
  [archive, ...sources].forEach(rejectStreamPath);
  // There is no name to pass to tar, and before that it would scan the whole drive, so it refuses first.
  const root = sources.find((src) => path.basename(path.resolve(src)) === '');
  if (root !== undefined) throw new FcError(`Cannot bundle a drive root: ${root}`);
  // If the archive itself is bundled, the archive set aside cannot be found, or the archive itself goes in instead of the original content.
  const self = sources.find((src) => realKey(src) === realKey(archive) || isSameFile(src, archive));
  if (self !== undefined) throw new FcError(`Cannot bundle the archive into itself: ${self}`);
  // Sources are bundled under their top-level name, so for sources with the same name, only one remains when extracted over each other from the archive. Windows is case-insensitive.
  const seen = new Map();
  for (const src of sources) {
    const name = path.basename(path.resolve(src));
    // toLowerCase makes ΑΣ and ασ, which are the same name on NTFS, different, so it compares in upper case (the same as flatten.js).
    const key = isWindows ? name.toUpperCase() : name;
    if (seen.has(key)) throw new FcError(`Sources with the same name cannot be bundled together. Only one would remain when extracting: ${seen.get(key)}, ${src}`);
    seen.set(key, src);
  }
  const inside = sources.map(namesInside);
  if (isWindows) rejectShortNameClash(sources, inside);
  ensureParentDir(archive);
  if (exists(archive) && fs.statSync(archive).isDirectory()) throw new FcError(`Cannot overwrite a folder: ${archive}`);
  const entries = [...sources.map((src) => path.basename(path.resolve(src))), ...inside.flat()];
  ensureTarArgs([path.resolve(archive), ...sources.map((src) => path.resolve(src))], entries, { oemEntries: !ANSI_ENTRY_EXT.has(innerEntryExt(archiveExt(archive))) });
  return perform(`Compress: ${sources.join(', ')} -> ${archive}${overwriteNote(archive, dryRun, info)}`, dryRun, () => writeArchive(archive, sources));
}

module.exports = {
  MAX_TAR_DIR,
  SPACE_RESERVE,
  TEMP_SERIAL_RESERVE,
  archiveEntries,
  archiveExt,
  archiveNames,
  COMPRESS_LABELS,
  couldBeShortNameOf,
  ensureRoomToExtract,
  FORMAT_LABELS,
  freeSpace,
  missingProgram,
  oemCodePage,
  probeArchive,
  rejectExtractShortNameClash,
  TAR_COMPRESS,
  unsupportedChars,
  unzip,
  zip,
};
