'use strict';

// The "arguments -> function call -> result object" part of each command. The CLI (bin/fctl.js) and the UI worker process (src/ui/worker.js) share it (#253).
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./commands');
const { plural } = require('./plural');
const { flatten, formatFlatten } = require('./flatten');
const { addProductNumbers, formatProductNumbers } = require('./productName');
const { extractArchives, formatExtractions } = require('./extract');
const { collapse, formatCollapse } = require('./collapse');
const { normalizeFiles, formatNormalize } = require('./normalizeFiles');
const { findBroken, formatBroken } = require('./broken');
const { removeBroken, formatRemoveBroken } = require('./removeBroken');
const { findDuplicateNames, formatDuplicateNames } = require('./duplicates');
const { removeDuplicates, formatRemoveDuplicates } = require('./removeDuplicates');
const { findLowQuality, formatLowQuality } = require('./lowQuality');
const { removeLowQuality, formatRemoveLowQuality } = require('./removeLowQuality');
const { findFiles, formatFind } = require('./find');
const { folderSizes, formatDu } = require('./du');
const { sortBy, formatSort } = require('./sort');

const { VALUE_FLAGS, FIND_FLAGS, DU_FLAGS, misplacedFlagMessage } = require('./commandTable');
const journal = require('./journal');

const KNOWN_FLAGS = new Set(['force', 'permanent', 'dry-run', 'help', 'remove-archives', 'include-lowercase', 'yes', 'min-height', 'min-bitrate', 'by', 'recursive', 'larger', 'smaller', 'older', 'newer', 'ext', 'name', 'sort', 'depth', 'top']);

function parse(argv) {
  const flags = new Set();
  const args = [];
  let confirm;
  const values = new Map();
  const end = argv.indexOf('--');
  const options = end === -1 ? argv : argv.slice(0, end);
  for (const arg of options) {
    if (arg === '-h' || arg === '--help') flags.add('help');
    else if (arg.startsWith('--yes=')) {
      flags.add('yes');
      confirm = arg.slice('--yes='.length);
    }
    else if (arg.startsWith('--') && VALUE_FLAGS.has(arg.slice(2).split('=')[0])) {
      const [name, ...rest] = arg.slice(2).split('=');
      flags.add(name);
      if (rest.length === 0) throw new fc.FcError(`Attach a value to --${name}, like --${name}=VALUE.`);
      values.set(name, rest.join('='));
    }
    else if (arg.startsWith('--')) flags.add(arg.slice(2));
    else args.push(arg);
  }
  // The typo check looks only at the arguments before --. It is passed without the command name.
  const unchecked = args.slice(1);
  if (end !== -1) args.push(...argv.slice(end + 1));
  return { command: args.shift(), args, flags, unchecked, confirm, values };
}

// If --dry-run is mistyped, it is ignored and the command really runs, so an unknown option is refused before doing anything.
// The content of write and append may start with -, as in '- item', so only the file path is looked at.
function rejectUnknownOptions(command, args, flags) {
  const unknownFlag = [...flags].find((flag) => !KNOWN_FLAGS.has(flag));
  if (unknownFlag !== undefined) throw new fc.FcError(`Unknown option: --${unknownFlag}`);
  const names = command === 'write' || command === 'append' ? args.slice(0, 1) : args;
  // The en dash and the em dash are often a typo where -- was auto-converted, so they are refused too.
  const dashed = names.find((arg) => /^[-–—]/.test(arg));
  if (dashed !== undefined) throw new fc.FcError(`Unknown option: ${dashed} (write names that start with - as ./${dashed} or after --)`);
}

// An option that a command does not use is refused instead of silently ignored: the rules are in the command table (#314, #362).
// The whole-target commands refuse --force and --permanent in checkWholeTarget.
function rejectMisplacedFlags(command, flags) {
  const message = misplacedFlagMessage(command, flags);
  if (message !== undefined) throw new fc.FcError(message);
}

function need(args, count, usage) {
  if (args.length < count) throw new fc.FcError(`Usage: fctl ${usage}`);
}

// The common check of commands that change a whole target.
function checkWholeTarget(command, args, flags) {
  need(args, 1, `${command} <target>`);
  // It is a command that cannot be undone. It refuses leftover arguments, so that only the front part of a path with unquoted spaces is taken and a wider folder is not handled.
  if (args.length > 1) throw new fc.FcError(`Only one target is accepted. Wrap paths that contain spaces in quotes: ${args.join(' ')}`);
  // C: means not the drive root but the current folder of that drive, so a folder different from the intended one could be handled.
  if (/^[A-Za-z]:(?![\\/])/.test(args[0])) throw new fc.FcError(`Write a path after the drive letter: ${args[0]}`);
  if (flags.has('force') || flags.has('permanent')) throw new fc.FcError(`${command} never overwrites or permanently deletes, so --force and --permanent cannot be used.`);
}

// Archives are made and extracted in src/archive.js, which does not know about the journal, so the command records the one "created" step after it succeeded.
// It also records after a failure when the output exists now but did not before, because tar may have written part of it. existed:true means it was there before.
function journaled(dryRun, output, source, action) {
  if (dryRun) return action();
  const existed = Boolean(fs.lstatSync(output, { throwIfNoEntry: false }));
  try {
    const result = action();
    journal.record('create', { path: output, source, existed });
    return result;
  } catch (err) {
    if (!existed && fs.lstatSync(output, { throwIfNoEntry: false })) journal.record('create', { path: output, source, existed, partial: true });
    throw err;
  }
}

function defaultReadStdin() {
  return require('node:fs').readFileSync(0, 'utf8');
}

function formatList(entries) {
  return entries
    .map((e) => {
      // A link keeps the 5-character tag column: [lnk], then the target. A link to a folder says (folder), a link to a file says (file), and a missing target says (broken) (#267).
      if (e.type === 'link') return `[lnk]  ${''.padStart(8)}  ${e.name} -> ${e.target ?? '?'} (${e.linkTo === 'dir' ? 'folder' : e.linkTo})`;
      return `${e.type === 'dir' ? '[dir]' : '     '}  ${(e.size === null ? '' : fc.formatSize(e.size)).padStart(8)}  ${e.name}`;
    })
    .join('\n');
}

// It runs argv and returns the result.
// - If help is wanted, { help: true }.
// - Otherwise { command, result, report, failure }. result is the value the function returned as is, report is the text the CLI prints,
//   and failure is the FcError for when part failed and the CLI must end as a failure (exit code 1) (if err.output exists, the report to print on standard output).
// An argument error or an exception during the run is thrown as is. An unknown command is an FcError whose err.unknownCommand is true.
// If progress(line) is given, long-running commands (flatten, remove-broken, find-broken, find-duplicates) pass on what they did, one line at a time, even before they finish (#67, #99, #326).
// readStdin() is called when write and append have no content.
function execute(argv, options = {}) {
  // The content of write and append can be large or secret, so the journal keeps only the file path.
  const redacted = argv[0] === 'write' || argv[0] === 'append' ? argv.slice(1, 2) : undefined;
  const run = journal.begin(argv[0] ?? '', argv.slice(1), { redacted });
  let outcome;
  try {
    outcome = executeCommand(argv, options);
  } catch (err) {
    journal.finish(run, err);
    throw err;
  }
  const written = journal.finish(run, outcome.failure);
  // The journal is a record, not the work, so a journal that could not be written is reported but does not turn a finished run into a failure.
  if (written?.error && typeof outcome.report === 'string') outcome.report += `
Warning: could not write the change journal (${written.error}).`;
  return outcome;
}

function executeCommand(argv, { progress, readStdin = defaultReadStdin }) {
  const { command, args, flags, unchecked, confirm, values } = parse(argv);
  const force = flags.has('force');
  const dryRun = flags.has('dry-run');

  rejectUnknownOptions(command, unchecked, flags);
  if (!command || flags.has('help')) return { help: true };
  // --remove-archives deletes the originals, so it and the other options are refused on commands that do not use them.
  rejectMisplacedFlags(command, flags);

  // The dry run of write, rename, mv, cp, zip and unzip sets info.overwrites when it would overwrite or replace something, so a screen reads the flag, not the words of the report (#361).
  const info = { overwrites: false };
  const done = (result, report = result, failure = undefined) => ({ command, result, report, failure, ...(info.overwrites ? { overwrites: true } : {}) });
  // If part fails, it shows what was done and ends as a failure.
  const failIf = (failed, result, report) => done(result, report, failed ? new fc.FcError(report) : undefined);

  switch (command) {
    case 'ls': {
      const entries = fc.list(args[0]);
      return done(entries, formatList(entries));
    }
    case 'mkdir':
      need(args, 1, 'mkdir <folder>');
      return done(fc.makeDir(args[0], { dryRun }));
    case 'write':
    case 'append':
      need(args, 1, `${command} <file> [content]`);
      // In a preview, no content is written, so it does not wait for standard input.
      return done(fc.writeFile(args[0], args.length > 1 ? args.slice(1).join(' ') : dryRun ? '' : readStdin(), {
        append: command === 'append',
        force,
        dryRun,
        info,
      }));
    case 'cat':
      need(args, 1, 'cat <file>');
      return done(fc.readFile(args[0]));
    case 'rename':
      need(args, 2, 'rename <path> <new-name>');
      return done(fc.rename(args[0], args[1], { force, dryRun, info }));
    case 'mv': {
      need(args, 2, 'mv <source...> <dest>');
      const lines = fc.move(args.slice(0, -1), args[args.length - 1], { force, dryRun, permanent: flags.has('permanent'), info });
      return done(lines, lines.join('\n'));
    }
    case 'cp': {
      need(args, 2, 'cp <source...> <dest>');
      const lines = fc.copy(args.slice(0, -1), args[args.length - 1], { force, dryRun, info });
      return done(lines, lines.join('\n'));
    }
    case 'rm': {
      need(args, 1, 'rm <path...>');
      const lines = fc.remove(args, { permanent: flags.has('permanent'), dryRun, permanentHint: true });
      return done(lines, lines.join('\n'));
    }
    case 'unzip':
      need(args, 1, 'unzip <archive> [folder]');
      return done(journaled(dryRun, args[1] || path.join(path.dirname(args[0]), path.parse(args[0]).name), args[0], () => fc.unzip(args[0], args[1], { dryRun, force, info })));
    case 'zip':
      need(args, 2, 'zip <archive> <source...>');
      return done(journaled(dryRun, args[0], args.slice(1).join(', '), () => fc.zip(args[0], args.slice(1), { force, dryRun, info })));
    case 'flatten': {
      checkWholeTarget(command, args, flags);
      const result = flatten(args[0], { dryRun, onProgress: progress });
      return failIf(result.failed.length > 0 || result.keptFolders.length > 0, result, formatFlatten(result));
    }
    case 'product-number': {
      checkWholeTarget(command, args, flags);
      const result = addProductNumbers(args[0], { dryRun });
      // Files not found are enough as a report. It ends as a failure only when there is a failed file.
      return failIf(result.failed.length > 0, result, formatProductNumbers(result));
    }
    case 'normalize': {
      checkWholeTarget(command, args, flags);
      const result = normalizeFiles(args[0], { dryRun, includeLowercase: flags.has('include-lowercase') });
      // Overlapping or skipped items are enough as a report. It ends as a failure only when there is a failed file.
      return failIf(result.failed.length > 0, result, formatNormalize(result));
    }
    case 'collapse': {
      checkWholeTarget(command, args, flags);
      const result = collapse(args[0], { dryRun });
      // Skipped items are enough as a report. It ends as a failure only when there is a failed stretch.
      return failIf(result.failed.length > 0, result, formatCollapse(result));
    }
    case 'sort-by': {
      checkWholeTarget(command, args, flags);
      const result = sortBy(args[0], { by: values.get('by'), dryRun, recursive: flags.has('recursive') });
      // Skipped files are enough as a report. It ends as a failure only when there is a file that could not be moved.
      return failIf(result.failed.length > 0, result, formatSort(result));
    }
    case 'extract-all': {
      checkWholeTarget(command, args, flags);
      const result = extractArchives(args[0], { dryRun, removeArchives: flags.has('remove-archives') });
      // Skipped items are enough as a report. It ends as a failure only when there is an archive that could not be extracted.
      return failIf(result.failed.length > 0, result, formatExtractions(result));
    }
    case 'find-broken': {
      checkWholeTarget(command, args, flags);
      // Found files are enough as a report. It does not touch files, so --dry-run gives the same result.
      const result = findBroken(args[0], { onProgress: progress });
      return done(result, formatBroken(result));
    }
    case 'remove-broken':
    case 'remove-duplicates':
    case 'remove-low-quality': {
      checkWholeTarget(command, args, flags);
      const [remover, format] = {
        'remove-broken': [removeBroken, formatRemoveBroken],
        'remove-duplicates': [removeDuplicates, formatRemoveDuplicates],
        'remove-low-quality': [removeLowQuality, formatRemoveLowQuality],
      }[command];
      // A bare --yes would only be reported after the remover ran, so it is refused first (the preview with --dry-run may carry it).
      if (flags.has('yes') && confirm === undefined && !dryRun) throw new fc.FcError(`Give --yes the confirmation value shown in the list: --yes=VALUE. Run ${command} without --yes to see the list and the value. Nothing was deleted.`);
      // The low-quality standard values are passed on literally, the same as find-low-quality. Other commands were refused above.
      // Only remove-broken prints progress (#99). The other two commands do not accept it.
      const result = remover(args[0], { dryRun, confirm, minHeight: values.get('min-height'), minBitrate: values.get('min-bitrate'), onProgress: progress });
      const report = format(result);
      // Even on failure, the report of the files that were moved goes to standard output. Kept or skipped items are enough as a report.
      const fail = (message) => done(result, report, Object.assign(new fc.FcError(message), { output: report }));
      if (result.failed.length > 0) return fail(`${plural(result.failed.length, 'file')} could not be sent to the Recycle Bin.`);
      if (result.mismatch) return fail('The list differs from when the confirmation value was made, so nothing was deleted. Check the new list.');
      return done(result, report);
    }
    case 'find-duplicates': {
      checkWholeTarget(command, args, flags);
      // Found groups are enough as a report. It does not touch files, so --dry-run gives the same result.
      const result = findDuplicateNames(args[0], { onProgress: progress });
      return done(result, formatDuplicateNames(result));
    }
    case 'find-low-quality': {
      checkWholeTarget(command, args, flags);
      // The value is passed literally and lowQualityCriteria checks it. If it is not an integer (abc, 1.5, an empty value), it refuses and states the value it received.
      // Found files are enough as a report. It does not touch files, so --dry-run gives the same result.
      const result = findLowQuality(args[0], { minHeight: values.get('min-height'), minBitrate: values.get('min-bitrate') });
      return done(result, formatLowQuality(result));
    }
    case 'find': {
      checkWholeTarget(command, args, flags);
      // It does not touch files, so --dry-run gives the same result.
      const result = findFiles(args[0], Object.fromEntries([...values].filter(([name]) => FIND_FLAGS.includes(name))));
      return done(result, formatFind(result));
    }
    case 'du': {
      checkWholeTarget(command, args, flags);
      // It does not touch files, so --dry-run gives the same result.
      const result = folderSizes(args[0], Object.fromEntries([...values].filter(([name]) => DU_FLAGS.includes(name))));
      return done(result, formatDu(result));
    }
    default:
      throw Object.assign(new fc.FcError(`Unknown command: ${command}`), { unknownCommand: true });
  }
}

module.exports = { execute, parse };
