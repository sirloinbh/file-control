#!/usr/bin/env node
'use strict';

const { execute } = require('../src/execute');
const { helpCommandLines } = require('../src/commandTable');

const help = () => `fctl - File Control

Usage: fctl <command> [args] [options]

${helpCommandLines().join('\n')}

Options:
  --force       overwrite existing files (unzip: extract over existing files)
  --permanent   with rm, delete permanently instead of using the Recycle Bin; with mv --force, delete the replaced item permanently
  --dry-run     print what would change without touching anything
  --remove-archives  with extract-all, send successfully extracted archives to the Recycle Bin
  --yes=VALUE   with remove-broken, remove-duplicates, remove-low-quality, send to the Recycle Bin only if the list is unchanged
  --include-lowercase  with normalize, also treat lowercase words (abc-123) as numbers
  --min-height=PIXELS  with find-low-quality and remove-low-quality, below this short side is low quality (default: 360)
  --min-bitrate=KBPS   with find-low-quality and remove-low-quality, below this bitrate is low quality (default: not checked)
  --larger=SIZE, --smaller=SIZE  with find, only files above or below a size (500KB, 1MB, 1GB)
  --older=AGE, --newer=AGE       with find, only files last modified before or after an age (30d, 4w, 6m)
  --ext=a,b     with find, only these extensions
  --name=GLOB   with find, only file names matching a pattern (* and ?)
  --sort=size|date  with find, list the largest or newest first (default: by path)
  --by=kind|month  with sort-by, how to sort (kind: Videos, Images, ...; month: YYYY-MM of the modified time); with sort-docs, --by=month adds a month folder inside each type folder
  --recursive   with sort-by and sort-docs, also sort files in subfolders
  --list        with undo, show the recent runs of the change journal
  --run=ID      with undo, reverse the run with this id instead of the last one
  --depth=N     with du, how many folder levels to list (default: 1)
  --top=N       with du, how many folders to list, largest first (default: 20)
  --            treat all following arguments as names or content, not options
  -h, --help    show help`;

// Argument parsing and command execution are in src/execute.js (shared with the UI, #253). This file only decides the CLI output and failures.
// If progress(line) is given, long-running commands (flatten, remove-broken) pass on what they did, one line at a time, even before they finish (#67, #99).
function run(argv, { progress } = {}) {
  let outcome;
  try {
    outcome = execute(argv, { progress });
  } catch (err) {
    if (err.unknownCommand) err.message += `\n\n${help()}`;
    throw err;
  }
  if (outcome.help) return help();
  if (outcome.failure) throw outcome.failure;
  return outcome.report;
}

// ui is a server that never ends and keeps running, so it is started separately from run (which returns the result string) (#251).
if (require.main === module && process.argv[2] === 'ui') {
  require('../src/ui/server').runUi(process.argv.slice(3)).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else if (require.main === module) {
  try {
    // Progress lines go to standard error. The final report on standard output stays as it is, and even if it is interrupted midway, what was already done stays on the screen.
    const output = run(process.argv.slice(2), { progress: (line) => process.stderr.write(`Progress: ${line}\n`) });
    if (output) console.log(output);
  } catch (err) {
    if (err.output) console.log(err.output);
    const detail = err.stderr ? `\n${err.stderr.toString().trim()}` : '';
    console.error(`Error: ${err.message}${detail}`);
    process.exit(1);
  }
}

module.exports = { run };
