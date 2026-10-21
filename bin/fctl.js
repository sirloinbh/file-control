#!/usr/bin/env node
'use strict';

const fc = require('../src/commands');

const HELP = `fctl - 파일 컨트롤

사용법: fctl <명령> [인자] [옵션]

  ls [폴더]                     폴더 내용 보기 (기본: 현재 폴더)
  mkdir <폴더>                  폴더 만들기 (중간 폴더도 함께)
  write <파일> [내용]           파일 만들기 (내용이 없으면 표준 입력에서 읽음)
  append <파일> [내용]          파일 끝에 내용 추가
  cat <파일>                    파일 내용 보기
  rename <경로> <새이름>        같은 폴더 안에서 이름 바꾸기
  mv <원본...> <대상>           옮기기 (대상이 폴더면 그 안으로)
  cp <원본...> <대상>           복사하기
  rm <경로...>                  휴지통으로 보내기
  unzip <압축파일> [폴더]       압축 풀기 (기본: 압축파일 이름의 폴더)
  zip <압축파일> <원본...>      압축하기 (.zip, .tar.gz 등 확장자로 형식 결정)

옵션:
  --force       이미 있는 파일을 덮어씀
  --permanent   rm에서 휴지통을 거치지 않고 영구 삭제
  -h, --help    도움말`;

function parse(argv) {
  const flags = new Set();
  const args = [];
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') flags.add('help');
    else if (arg.startsWith('--')) flags.add(arg.slice(2));
    else args.push(arg);
  }
  return { command: args.shift(), args, flags };
}

function need(args, count, usage) {
  if (args.length < count) throw new fc.FcError(`사용법: fctl ${usage}`);
}

function readStdin() {
  return require('node:fs').readFileSync(0, 'utf8');
}

function run(argv) {
  const { command, args, flags } = parse(argv);
  const force = flags.has('force');

  if (!command || flags.has('help')) return HELP;

  switch (command) {
    case 'ls':
      return fc
        .list(args[0])
        .map((e) => `${e.type === 'dir' ? '[폴더]' : '      '}  ${(e.size === null ? '' : fc.formatSize(e.size)).padStart(8)}  ${e.name}`)
        .join('\n');
    case 'mkdir':
      need(args, 1, 'mkdir <폴더>');
      return fc.makeDir(args[0]);
    case 'write':
    case 'append':
      need(args, 1, `${command} <파일> [내용]`);
      return fc.writeFile(args[0], args.length > 1 ? args.slice(1).join(' ') : readStdin(), {
        append: command === 'append',
        force,
      });
    case 'cat':
      need(args, 1, 'cat <파일>');
      return fc.readFile(args[0]);
    case 'rename':
      need(args, 2, 'rename <경로> <새이름>');
      return fc.rename(args[0], args[1], { force });
    case 'mv':
      need(args, 2, 'mv <원본...> <대상>');
      return fc.move(args.slice(0, -1), args[args.length - 1], { force }).join('\n');
    case 'cp':
      need(args, 2, 'cp <원본...> <대상>');
      return fc.copy(args.slice(0, -1), args[args.length - 1], { force }).join('\n');
    case 'rm':
      need(args, 1, 'rm <경로...>');
      return fc.remove(args, { permanent: flags.has('permanent') }).join('\n');
    case 'unzip':
      need(args, 1, 'unzip <압축파일> [폴더]');
      return fc.unzip(args[0], args[1]);
    case 'zip':
      need(args, 2, 'zip <압축파일> <원본...>');
      return fc.zip(args[0], args.slice(1), { force });
    default:
      throw new fc.FcError(`알 수 없는 명령: ${command}\n\n${HELP}`);
  }
}

if (require.main === module) {
  try {
    const output = run(process.argv.slice(2));
    if (output) console.log(output);
  } catch (err) {
    const detail = err.stderr ? `\n${err.stderr.toString().trim()}` : '';
    console.error(`오류: ${err.message}${detail}`);
    process.exit(1);
  }
}

module.exports = { run };
