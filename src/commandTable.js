'use strict';

// The one table of the commands (#362). The help text of bin/fctl.js is made from it, and the checks of src/execute.js that refuse an option on a command
// that does not use it (--force, --permanent, --remove-archives, --yes, --include-lowercase, --min-height, --min-bitrate) read it too,
// so a command is added in one place and the help and the checks cannot disagree.
// kind: 'basic' (the file commands, which refuse --force and --permanent when they do not use them), 'whole' (commands that handle a whole target) or 'ui'.
// The other fields say which options a command accepts: force, permanent, removeArchives, yes, includeLowercase, lowQuality (--min-height and --min-bitrate), sortBy (--by), recursive (--recursive).

const COMMANDS = [
  { name: 'ls', usage: 'ls [folder]', summary: 'list folder contents (default: current folder)', kind: 'basic' },
  { name: 'mkdir', usage: 'mkdir <folder>', summary: 'create a folder (parent folders too)', kind: 'basic' },
  { name: 'write', usage: 'write <file> [content]', summary: 'create a file (reads standard input if no content)', kind: 'basic', force: true },
  { name: 'append', usage: 'append <file> [content]', summary: 'append content to a file', kind: 'basic' },
  { name: 'cat', usage: 'cat <file>', summary: 'show file contents', kind: 'basic' },
  { name: 'rename', usage: 'rename <path> <new-name>', summary: 'rename within the same folder', kind: 'basic', force: true },
  { name: 'mv', usage: 'mv <source...> <dest>', summary: 'move (into the destination if it is a folder)', kind: 'basic', force: true, permanent: true },
  { name: 'cp', usage: 'cp <source...> <dest>', summary: 'copy', kind: 'basic', force: true },
  { name: 'rm', usage: 'rm <path...>', summary: 'send to the Recycle Bin', kind: 'basic', permanent: true },
  { name: 'unzip', usage: 'unzip <archive> [folder]', summary: 'extract (default: a folder named after the archive)', kind: 'basic', force: true },
  { name: 'zip', usage: 'zip <archive> <source...>', summary: 'compress (format set by the extension: .zip, .tar.gz, ...)', kind: 'basic', force: true },
  { name: 'flatten', usage: 'flatten <target>', summary: 'move files from subfolders directly under the target and send empty folders to the Recycle Bin (no overwriting)', kind: 'whole' },
  { name: 'product-number', usage: 'product-number <target>', summary: 'prefix video file names with the product number (no overwriting)', kind: 'whole' },
  { name: 'normalize', usage: 'normalize <target>', summary: 'put the product number in file names first, in uppercase (no overwriting)', kind: 'whole', includeLowercase: true },
  { name: 'collapse', usage: 'collapse <target>', summary: 'collapse single-folder chains (a/b/c/file) into the top folder', kind: 'whole' },
  { name: 'extract-all', usage: 'extract-all <target>', summary: 'extract each archive into a new folder (with --remove-archives, send successfully extracted originals to the Recycle Bin)', kind: 'whole', removeArchives: true },
  { name: 'find-broken', usage: 'find-broken <target>', summary: 'find broken files (does not touch files)', kind: 'whole' },
  { name: 'remove-broken', usage: 'remove-broken <target>', summary: 'show broken files and a confirmation value (with --yes=VALUE, log them and send to the Recycle Bin)', kind: 'whole', yes: true },
  { name: 'find-duplicates', usage: 'find-duplicates <target>', summary: 'group videos with the same name, product number, or length (does not touch files)', kind: 'whole' },
  { name: 'remove-duplicates', usage: 'remove-duplicates <target>', summary: 'show duplicate videos to delete and a confirmation value (with --yes=VALUE, log them and send to the Recycle Bin)', kind: 'whole', yes: true },
  { name: 'find-low-quality', usage: 'find-low-quality <target>', summary: 'find low-quality videos below the resolution or bitrate limit (does not touch files)', kind: 'whole', lowQuality: true },
  { name: 'remove-low-quality', usage: 'remove-low-quality <target>', summary: 'show low-quality videos to delete and a confirmation value (with --yes=VALUE, log them and send to the Recycle Bin)', kind: 'whole', yes: true, lowQuality: true },
  { name: 'find', usage: 'find <target> [--larger=SIZE] [--ext=a,b]', summary: 'list files by size, age, extension and name, with a total (does not touch files)', kind: 'whole', find: true },
  { name: 'sort-by', usage: 'sort-by <target> --by=kind|month', summary: 'move the files directly in the target into folders by kind (Videos, Images, ...) or by modified month (no overwriting; --recursive for subfolders too)', kind: 'whole', sortBy: true, recursive: true },
  { name: 'sort-docs', usage: 'sort-docs <target> [--by=month]', summary: 'move documents into folders by type (PDF, Word, Excel, Slides, HWP, Text); other files stay (no overwriting)', kind: 'whole', sortBy: true, recursive: true },
  { name: 'sort-photos', usage: 'sort-photos <target>', summary: 'move photos into YYYY/YYYY-MM folders by the date taken (modified time if none) and screenshots into Screenshots (no overwriting)', kind: 'whole', recursive: true },
  { name: 'du', usage: 'du <target> [--depth=1] [--top=20]', summary: 'show subfolder sizes and file counts, largest first, with a total (does not touch files)', kind: 'whole', du: true },
  { name: 'ui', usage: 'ui [--port=NUMBER] [--no-open]', summary: 'start the local web UI (127.0.0.1, default port 8109, stop with Ctrl+C)', kind: 'ui' },
];

const named = (field) => COMMANDS.filter((command) => command[field]).map((command) => command.name);

// The command list of the help text: the usage padded to one column, then the summary.
function helpCommandLines() {
  // The column is 29 wide (as in the old hand-written help); the longest usage (ui) is wider and keeps just the two spaces.
  return COMMANDS.map((command) => `  ${command.usage.padEnd(29)}  ${command.summary}`);
}

const BASIC_COMMANDS = new Set(COMMANDS.filter((command) => command.kind === 'basic').map((command) => command.name));
const FORCE_COMMANDS = named('force');
const PERMANENT_COMMANDS = named('permanent');
const FIND_FLAGS = ['larger', 'smaller', 'older', 'newer', 'ext', 'name', 'sort'];
// Options that carry a value (--name=VALUE) and the command field that allows each one.
const DU_FLAGS = ['depth', 'top'];
const VALUE_FLAG_FIELDS = { 'min-height': 'lowQuality', 'min-bitrate': 'lowQuality', by: 'sortBy', ...Object.fromEntries(DU_FLAGS.map((flag) => [flag, 'du'])), ...Object.fromEntries(FIND_FLAGS.map((flag) => [flag, 'find'])) };
const VALUE_FLAGS = new Set(Object.keys(VALUE_FLAG_FIELDS));

// The rules in the order they are checked. It returns the message of the first option that does not belong to the command, otherwise undefined.
// Only the basic commands are looked at for --force and --permanent; the whole-target commands refuse both in checkWholeTarget of src/execute.js.
function misplacedFlagMessage(command, flags) {
  const only = (flag, commands, message) => (flags.has(flag) && !commands.includes(command) ? message : undefined);
  const basic = BASIC_COMMANDS.has(command);
  return [
    only('remove-archives', named('removeArchives'), '--remove-archives can be used only with extract-all.'),
    only('yes', named('yes'), '--yes can be used only with remove-broken, remove-duplicates, and remove-low-quality.'),
    // mv --permanent only decides what happens to the item that --force replaces, so without --force it does nothing.
    basic && command === 'mv' && flags.has('permanent') && !flags.has('force')
      ? 'mv --permanent only applies with --force (it deletes the replaced item permanently instead of sending it to the Recycle Bin).' : undefined,
    basic ? only('force', FORCE_COMMANDS, `${command} does not use --force. --force can be used with ${FORCE_COMMANDS.join(', ')}.`) : undefined,
    basic ? only('permanent', PERMANENT_COMMANDS, `${command} does not use --permanent. --permanent can be used with ${PERMANENT_COMMANDS.join(' and ')}.`) : undefined,
    only('include-lowercase', named('includeLowercase'), '--include-lowercase can be used only with normalize.'),
    ...Object.entries(VALUE_FLAG_FIELDS).map(([flag, field]) => only(flag, named(field), `--${flag} can be used only with ${named(field).join(' and ')}.`)),
    only('recursive', named('recursive'), `--recursive can be used only with ${named('recursive').join(', ')}.`),
  ].find((message) => message !== undefined);
}

module.exports = { COMMANDS, VALUE_FLAGS, FIND_FLAGS, DU_FLAGS, helpCommandLines, misplacedFlagMessage };
