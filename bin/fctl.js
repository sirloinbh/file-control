#!/usr/bin/env node
'use strict';

const fc = require('../src/commands');
const { flatten, formatFlatten } = require('../src/flatten');
const { addProductNumbers, formatProductNumbers } = require('../src/productName');
const { extractArchives, formatExtractions } = require('../src/extract');
const { collapse, formatCollapse } = require('../src/collapse');
const { normalizeFiles, formatNormalize } = require('../src/normalizeFiles');
const { findBroken, formatBroken } = require('../src/broken');

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
  flatten <타겟>                하위 폴더의 파일을 타겟 바로 아래로 옮기고 빈 폴더를 휴지통으로 (덮어쓰지 않음)
  product-number <타겟>         영상 파일 이름 앞에 제품번호 넣기 (덮어쓰지 않음)
  normalize <타겟>              파일 이름의 제품번호를 대문자로 맨 앞에 (덮어쓰지 않음)
  collapse <타겟>               폴더 하나만 이어지는 구간(a/b/c/파일)을 맨 위 폴더로 접기
  extract-all <타겟>            압축 파일마다 새 폴더에 풀기 (--remove-archives를 주면 정상으로 풀린 원본을 휴지통으로)
  find-broken <타겟>            깨진 파일 찾기 (파일은 건드리지 않음)

옵션:
  --force       이미 있는 파일을 덮어씀
  --permanent   rm에서 휴지통을 거치지 않고 영구 삭제
  --dry-run     바뀔 내용만 출력하고 실제로는 건드리지 않음
  --remove-archives  extract-all에서 정상으로 풀린 압축 파일을 휴지통으로 보냄
  --include-lowercase  normalize에서 소문자 말(abc-123)도 번호로 보고 바꿈
  --            뒤의 인자는 모두 옵션이 아닌 이름·내용으로 봄
  -h, --help    도움말`;

const KNOWN_FLAGS = new Set(['force', 'permanent', 'dry-run', 'help', 'remove-archives', 'include-lowercase']);

function parse(argv) {
  const flags = new Set();
  const args = [];
  const end = argv.indexOf('--');
  const options = end === -1 ? argv : argv.slice(0, end);
  for (const arg of options) {
    if (arg === '-h' || arg === '--help') flags.add('help');
    else if (arg.startsWith('--')) flags.add(arg.slice(2));
    else args.push(arg);
  }
  // 오타 검사는 -- 앞의 인자만 본다. 명령 이름은 빼고 넘긴다.
  const unchecked = args.slice(1);
  if (end !== -1) args.push(...argv.slice(end + 1));
  return { command: args.shift(), args, flags, unchecked };
}

// --dry-run을 잘못 치면 무시되어 실제로 실행되므로, 모르는 옵션은 아무것도 하기 전에 거부한다.
// write·append의 내용은 '- 항목'처럼 -로 시작할 수 있으니 파일 경로만 본다.
function rejectUnknownOptions(command, args, flags) {
  const unknownFlag = [...flags].find((flag) => !KNOWN_FLAGS.has(flag));
  if (unknownFlag !== undefined) throw new fc.FcError(`알 수 없는 옵션: --${unknownFlag}`);
  const names = command === 'write' || command === 'append' ? args.slice(0, 1) : args;
  // –(en 대시)와 —(em 대시)는 --가 자동 변환된 오타일 때가 많아 함께 거부한다.
  const dashed = names.find((arg) => /^[-–—]/.test(arg));
  if (dashed !== undefined) throw new fc.FcError(`알 수 없는 옵션: ${dashed} (-로 시작하는 이름은 ./${dashed}처럼 쓰거나 -- 뒤에 쓰세요)`);
}

function need(args, count, usage) {
  if (args.length < count) throw new fc.FcError(`사용법: fctl ${usage}`);
}

// 타겟 전체를 바꾸는 명령의 공통 검사.
function checkWholeTarget(command, args, flags) {
  need(args, 1, `${command} <타겟>`);
  // 되돌릴 수 없는 명령이다. 따옴표 없는 공백 경로의 앞부분만 받아 더 넓은 폴더를 다루지 않게 남는 인자를 거부한다.
  if (args.length > 1) throw new fc.FcError(`타겟은 하나만 받습니다. 공백이 든 경로는 따옴표로 감싸세요: ${args.join(' ')}`);
  // C:는 드라이브 루트가 아니라 그 드라이브의 현재 폴더를 뜻해서, 뜻과 다른 폴더를 다룰 수 있다.
  if (/^[A-Za-z]:(?![\\/])/.test(args[0])) throw new fc.FcError(`드라이브 문자 뒤에 경로를 쓰세요: ${args[0]}`);
  if (flags.has('force') || flags.has('permanent')) throw new fc.FcError(`${command}은 덮어쓰거나 영구 삭제하지 않으므로 --force, --permanent를 쓸 수 없습니다.`);
}

function readStdin() {
  return require('node:fs').readFileSync(0, 'utf8');
}

function run(argv) {
  const { command, args, flags, unchecked } = parse(argv);
  const force = flags.has('force');
  const dryRun = flags.has('dry-run');

  rejectUnknownOptions(command, unchecked, flags);
  if (!command || flags.has('help')) return HELP;
  // 원본을 지우는 옵션이므로 다른 명령에서 말없이 무시하지 않는다.
  if (flags.has('remove-archives') && command !== 'extract-all') throw new fc.FcError('--remove-archives는 extract-all에서만 쓸 수 있습니다.');
  if (flags.has('include-lowercase') && command !== 'normalize') throw new fc.FcError('--include-lowercase는 normalize에서만 쓸 수 있습니다.');

  switch (command) {
    case 'ls':
      return fc
        .list(args[0])
        .map((e) => `${e.type === 'dir' ? '[폴더]' : '      '}  ${(e.size === null ? '' : fc.formatSize(e.size)).padStart(8)}  ${e.name}`)
        .join('\n');
    case 'mkdir':
      need(args, 1, 'mkdir <폴더>');
      return fc.makeDir(args[0], { dryRun });
    case 'write':
    case 'append':
      need(args, 1, `${command} <파일> [내용]`);
      // 미리보기는 내용을 쓰지 않으므로 표준 입력을 기다리지 않는다.
      return fc.writeFile(args[0], args.length > 1 ? args.slice(1).join(' ') : dryRun ? '' : readStdin(), {
        append: command === 'append',
        force,
        dryRun,
      });
    case 'cat':
      need(args, 1, 'cat <파일>');
      return fc.readFile(args[0]);
    case 'rename':
      need(args, 2, 'rename <경로> <새이름>');
      return fc.rename(args[0], args[1], { force, dryRun });
    case 'mv':
      need(args, 2, 'mv <원본...> <대상>');
      return fc.move(args.slice(0, -1), args[args.length - 1], { force, dryRun }).join('\n');
    case 'cp':
      need(args, 2, 'cp <원본...> <대상>');
      return fc.copy(args.slice(0, -1), args[args.length - 1], { force, dryRun }).join('\n');
    case 'rm':
      need(args, 1, 'rm <경로...>');
      return fc.remove(args, { permanent: flags.has('permanent'), dryRun }).join('\n');
    case 'unzip':
      need(args, 1, 'unzip <압축파일> [폴더]');
      return fc.unzip(args[0], args[1], { dryRun });
    case 'zip':
      need(args, 2, 'zip <압축파일> <원본...>');
      return fc.zip(args[0], args.slice(1), { force, dryRun });
    case 'flatten': {
      checkWholeTarget(command, args, flags);
      const result = flatten(args[0], { dryRun });
      const report = formatFlatten(result);
      // 일부가 실패하면 옮긴 내용까지 보여 주고 실패로 끝낸다.
      if (result.failed.length > 0 || result.keptFolders.length > 0) throw new fc.FcError(report);
      return report;
    }
    case 'product-number': {
      checkWholeTarget(command, args, flags);
      const result = addProductNumbers(args[0], { dryRun });
      const report = formatProductNumbers(result);
      // 못 찾은 파일은 보고로 충분하다. 실패한 파일이 있을 때만 실패로 끝낸다.
      if (result.failed.length > 0) throw new fc.FcError(report);
      return report;
    }
    case 'normalize': {
      checkWholeTarget(command, args, flags);
      const result = normalizeFiles(args[0], { dryRun, includeLowercase: flags.has('include-lowercase') });
      const report = formatNormalize(result);
      // 겹치거나 건너뛴 것은 보고로 충분하다. 실패한 파일이 있을 때만 실패로 끝낸다.
      if (result.failed.length > 0) throw new fc.FcError(report);
      return report;
    }
    case 'collapse': {
      checkWholeTarget(command, args, flags);
      const result = collapse(args[0], { dryRun });
      const report = formatCollapse(result);
      // 건너뛴 것은 보고로 충분하다. 실패한 구간이 있을 때만 실패로 끝낸다.
      if (result.failed.length > 0) throw new fc.FcError(report);
      return report;
    }
    case 'extract-all': {
      checkWholeTarget(command, args, flags);
      const result = extractArchives(args[0], { dryRun, removeArchives: flags.has('remove-archives') });
      const report = formatExtractions(result);
      // 건너뛴 것은 보고로 충분하다. 풀지 못한 압축 파일이 있을 때만 실패로 끝낸다.
      if (result.failed.length > 0) throw new fc.FcError(report);
      return report;
    }
    case 'find-broken': {
      checkWholeTarget(command, args, flags);
      // 찾은 파일은 보고로 충분하다. 파일을 건드리지 않으므로 --dry-run은 결과가 같다.
      return formatBroken(findBroken(args[0]));
    }
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
