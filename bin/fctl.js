#!/usr/bin/env node
'use strict';

const { execute } = require('../src/execute');

const HELP = `fctl - File Control

Usage: fctl <command> [args] [options]

  ls [folder]                    list folder contents (default: current folder)
  mkdir <folder>                 create a folder (parent folders too)
  write <file> [content]         create a file (reads standard input if no content)
  append <file> [content]        append content to a file
  cat <file>                     show file contents
  rename <path> <new-name>       rename within the same folder
  mv <source...> <dest>          move (into the destination if it is a folder)
  cp <source...> <dest>          copy
  rm <path...>                   send to the Recycle Bin
  unzip <archive> [folder]       extract (default: a folder named after the archive)
  zip <archive> <source...>      compress (format set by the extension: .zip, .tar.gz, ...)
  flatten <target>               move files from subfolders directly under the target and send empty folders to the Recycle Bin (no overwriting)
  product-number <target>        prefix video file names with the product number (no overwriting)
  normalize <target>             put the product number in file names first, in uppercase (no overwriting)
  collapse <target>              collapse single-folder chains (a/b/c/file) into the top folder
  extract-all <target>           extract each archive into a new folder (with --remove-archives, send successfully extracted originals to the Recycle Bin)
  find-broken <target>           find broken files (does not touch files)
  remove-broken <target>         show broken files and a confirmation value (with --yes=VALUE, log them and send to the Recycle Bin)
  find-duplicates <target>       group videos with the same name, product number, or length (does not touch files)
  remove-duplicates <target>     show duplicate videos to delete and a confirmation value (with --yes=VALUE, log them and send to the Recycle Bin)
  find-low-quality <target>      find low-quality videos below the resolution or bitrate limit (does not touch files)
  remove-low-quality <target>    show low-quality videos to delete and a confirmation value (with --yes=VALUE, log them and send to the Recycle Bin)
  ui [--port=NUMBER] [--no-open]  start the local web UI (127.0.0.1, default port 8109, stop with Ctrl+C)

Options:
  --force       overwrite existing files
  --permanent   with rm, delete permanently instead of using the Recycle Bin
  --dry-run     print what would change without touching anything
  --remove-archives  with extract-all, send successfully extracted archives to the Recycle Bin
  --yes=VALUE   with remove-broken, remove-duplicates, remove-low-quality, send to the Recycle Bin only if the list is unchanged
  --include-lowercase  with normalize, also treat lowercase words (abc-123) as numbers
  --min-height=PIXELS  with find-low-quality and remove-low-quality, below this short side is low quality (default: 360)
  --min-bitrate=KBPS   with find-low-quality and remove-low-quality, below this bitrate is low quality (default: not checked)
  --            treat all following arguments as names or content, not options
  -h, --help    show help`;

// 인자 해석과 명령 실행은 src/execute.js에 있다(UI와 함께 쓴다, #253). 여기서는 CLI 출력과 실패만 정한다.
// progress(line)를 주면 오래 걸리는 명령(flatten, remove-broken)이 끝나기 전에도 한 일을 한 줄씩 넘긴다(#67, #99).
function run(argv, { progress } = {}) {
  let outcome;
  try {
    outcome = execute(argv, { progress });
  } catch (err) {
    if (err.unknownCommand) err.message += `\n\n${HELP}`;
    throw err;
  }
  if (outcome.help) return HELP;
  if (outcome.failure) throw outcome.failure;
  return outcome.report;
}

// ui는 끝나지 않고 계속 도는 서버라 run(결과 문자열을 돌려줌)과 따로 띄운다(#251).
if (require.main === module && process.argv[2] === 'ui') {
  require('../src/ui/server').runUi(process.argv.slice(3)).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else if (require.main === module) {
  try {
    // 진행 줄은 표준 오류로 낸다. 표준 출력의 마지막 보고는 그대로 두고, 중간에 끊겨도 이미 한 일이 화면에 남는다.
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
