'use strict';

// The "arguments -> function call -> result object" part of each command. The CLI (bin/fctl.js) and the UI worker process (src/ui/worker.js) share it (#253).
const fc = require('./commands');
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

const KNOWN_FLAGS = new Set(['force', 'permanent', 'dry-run', 'help', 'remove-archives', 'include-lowercase', 'yes', 'min-height', 'min-bitrate']);
// Options that take a value (--name=value). The value goes in values.
const VALUE_FLAGS = new Set(['min-height', 'min-bitrate']);

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

function defaultReadStdin() {
  return require('node:fs').readFileSync(0, 'utf8');
}

function formatList(entries) {
  return entries
    .map((e) => `${e.type === 'dir' ? '[dir]' : '     '}  ${(e.size === null ? '' : fc.formatSize(e.size)).padStart(8)}  ${e.name}`)
    .join('\n');
}

// It runs argv and returns the result.
// - If help is wanted, { help: true }.
// - Otherwise { command, result, report, failure }. result is the value the function returned as is, report is the text the CLI prints,
//   and failure is the FcError for when part failed and the CLI must end as a failure (exit code 1) (if err.output exists, the report to print on standard output).
// An argument error or an exception during the run is thrown as is. An unknown command is an FcError whose err.unknownCommand is true.
// If progress(line) is given, long-running commands (flatten, remove-broken) pass on what they did, one line at a time, even before they finish (#67, #99).
// readStdin() is called when write and append have no content.
function execute(argv, { progress, readStdin = defaultReadStdin } = {}) {
  const { command, args, flags, unchecked, confirm, values } = parse(argv);
  const force = flags.has('force');
  const dryRun = flags.has('dry-run');

  rejectUnknownOptions(command, unchecked, flags);
  if (!command || flags.has('help')) return { help: true };
  // It is an option that deletes the originals, so other commands do not silently ignore it.
  if (flags.has('remove-archives') && command !== 'extract-all') throw new fc.FcError('--remove-archives can be used only with extract-all.');
  const removing = command === 'remove-broken' || command === 'remove-duplicates' || command === 'remove-low-quality';
  if (flags.has('yes') && !removing) throw new fc.FcError('--yes can be used only with remove-broken, remove-duplicates, and remove-low-quality.');
  if (flags.has('include-lowercase') && command !== 'normalize') throw new fc.FcError('--include-lowercase can be used only with normalize.');
  for (const name of VALUE_FLAGS) {
    if (flags.has(name) && command !== 'find-low-quality' && command !== 'remove-low-quality') throw new fc.FcError(`--${name} can be used only with find-low-quality and remove-low-quality.`);
  }

  const done = (result, report = result, failure = undefined) => ({ command, result, report, failure });
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
      }));
    case 'cat':
      need(args, 1, 'cat <file>');
      return done(fc.readFile(args[0]));
    case 'rename':
      need(args, 2, 'rename <path> <new-name>');
      return done(fc.rename(args[0], args[1], { force, dryRun }));
    case 'mv': {
      need(args, 2, 'mv <source...> <dest>');
      const lines = fc.move(args.slice(0, -1), args[args.length - 1], { force, dryRun });
      return done(lines, lines.join('\n'));
    }
    case 'cp': {
      need(args, 2, 'cp <source...> <dest>');
      const lines = fc.copy(args.slice(0, -1), args[args.length - 1], { force, dryRun });
      return done(lines, lines.join('\n'));
    }
    case 'rm': {
      need(args, 1, 'rm <path...>');
      const lines = fc.remove(args, { permanent: flags.has('permanent'), dryRun, permanentHint: true });
      return done(lines, lines.join('\n'));
    }
    case 'unzip':
      need(args, 1, 'unzip <archive> [folder]');
      return done(fc.unzip(args[0], args[1], { dryRun }));
    case 'zip':
      need(args, 2, 'zip <archive> <source...>');
      return done(fc.zip(args[0], args.slice(1), { force, dryRun }));
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
    case 'extract-all': {
      checkWholeTarget(command, args, flags);
      const result = extractArchives(args[0], { dryRun, removeArchives: flags.has('remove-archives') });
      // Skipped items are enough as a report. It ends as a failure only when there is an archive that could not be extracted.
      return failIf(result.failed.length > 0, result, formatExtractions(result));
    }
    case 'find-broken': {
      checkWholeTarget(command, args, flags);
      // Found files are enough as a report. It does not touch files, so --dry-run gives the same result.
      const result = findBroken(args[0]);
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
      // The low-quality standard values are passed on literally, the same as find-low-quality. Other commands were refused above.
      // Only remove-broken prints progress (#99). The other two commands do not accept it.
      const result = remover(args[0], { dryRun, confirm, minHeight: values.get('min-height'), minBitrate: values.get('min-bitrate'), onProgress: progress });
      const report = format(result);
      // Even on failure, the report of the files that were moved goes to standard output. Kept or skipped items are enough as a report.
      const fail = (message) => done(result, report, Object.assign(new fc.FcError(message), { output: report }));
      if (result.failed.length > 0) return fail(`${result.failed.length} files could not be sent to the Recycle Bin.`);
      if (result.mismatch) return fail('The list differs from when the confirmation value was made, so nothing was deleted. Check the new list.');
      if (flags.has('yes') && confirm === undefined && !dryRun && result.removals.length > 0) return fail('Give --yes the confirmation value shown in the list. Nothing was deleted.');
      return done(result, report);
    }
    case 'find-duplicates': {
      checkWholeTarget(command, args, flags);
      // Found groups are enough as a report. It does not touch files, so --dry-run gives the same result.
      const result = findDuplicateNames(args[0]);
      return done(result, formatDuplicateNames(result));
    }
    case 'find-low-quality': {
      checkWholeTarget(command, args, flags);
      // The value is passed literally and lowQualityCriteria checks it. If it is not an integer (abc, 1.5, an empty value), it refuses and states the value it received.
      // Found files are enough as a report. It does not touch files, so --dry-run gives the same result.
      const result = findLowQuality(args[0], { minHeight: values.get('min-height'), minBitrate: values.get('min-bitrate') });
      return done(result, formatLowQuality(result));
    }
    default:
      throw Object.assign(new fc.FcError(`Unknown command: ${command}`), { unknownCommand: true });
  }
}

module.exports = { execute, parse };
