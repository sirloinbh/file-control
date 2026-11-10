'use strict';

// 명령별 "인자 → 함수 호출 → 결과 객체" 부분. CLI(bin/fctl.js)와 UI 작업 프로세스(src/ui/worker.js)가 함께 쓴다(#253).
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
// 값을 받는 옵션(--이름=값). 값은 values에 둔다.
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
      if (rest.length === 0) throw new fc.FcError(`--${name}에는 값을 --${name}=값처럼 붙이세요.`);
      values.set(name, rest.join('='));
    }
    else if (arg.startsWith('--')) flags.add(arg.slice(2));
    else args.push(arg);
  }
  // 오타 검사는 -- 앞의 인자만 본다. 명령 이름은 빼고 넘긴다.
  const unchecked = args.slice(1);
  if (end !== -1) args.push(...argv.slice(end + 1));
  return { command: args.shift(), args, flags, unchecked, confirm, values };
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

function defaultReadStdin() {
  return require('node:fs').readFileSync(0, 'utf8');
}

function formatList(entries) {
  return entries
    .map((e) => `${e.type === 'dir' ? '[폴더]' : '      '}  ${(e.size === null ? '' : fc.formatSize(e.size)).padStart(8)}  ${e.name}`)
    .join('\n');
}

// argv를 실행해 결과를 돌려준다.
// - 도움말을 원하면 { help: true }.
// - 아니면 { command, result, report, failure }. result는 함수가 돌려준 값 그대로, report는 CLI가 출력할 글자,
//   failure는 일부가 실패해 CLI가 실패(종료 코드 1)로 끝내야 할 때의 FcError다(err.output이 있으면 표준 출력으로 낼 보고).
// 인자 오류나 실행 중 예외는 그대로 던진다. 모르는 명령은 err.unknownCommand가 true인 FcError다.
// progress(line)를 주면 오래 걸리는 명령(flatten, remove-broken)이 끝나기 전에도 한 일을 한 줄씩 넘긴다(#67, #99).
// readStdin()은 write·append에 내용이 없을 때 부른다.
function execute(argv, { progress, readStdin = defaultReadStdin } = {}) {
  const { command, args, flags, unchecked, confirm, values } = parse(argv);
  const force = flags.has('force');
  const dryRun = flags.has('dry-run');

  rejectUnknownOptions(command, unchecked, flags);
  if (!command || flags.has('help')) return { help: true };
  // 원본을 지우는 옵션이므로 다른 명령에서 말없이 무시하지 않는다.
  if (flags.has('remove-archives') && command !== 'extract-all') throw new fc.FcError('--remove-archives는 extract-all에서만 쓸 수 있습니다.');
  const removing = command === 'remove-broken' || command === 'remove-duplicates' || command === 'remove-low-quality';
  if (flags.has('yes') && !removing) throw new fc.FcError('--yes는 remove-broken, remove-duplicates, remove-low-quality에서만 쓸 수 있습니다.');
  if (flags.has('include-lowercase') && command !== 'normalize') throw new fc.FcError('--include-lowercase는 normalize에서만 쓸 수 있습니다.');
  for (const name of VALUE_FLAGS) {
    if (flags.has(name) && command !== 'find-low-quality' && command !== 'remove-low-quality') throw new fc.FcError(`--${name}는 find-low-quality, remove-low-quality에서만 쓸 수 있습니다.`);
  }

  const done = (result, report = result, failure = undefined) => ({ command, result, report, failure });
  // 일부가 실패하면 한 일까지 보여 주고 실패로 끝낸다.
  const failIf = (failed, result, report) => done(result, report, failed ? new fc.FcError(report) : undefined);

  switch (command) {
    case 'ls': {
      const entries = fc.list(args[0]);
      return done(entries, formatList(entries));
    }
    case 'mkdir':
      need(args, 1, 'mkdir <폴더>');
      return done(fc.makeDir(args[0], { dryRun }));
    case 'write':
    case 'append':
      need(args, 1, `${command} <파일> [내용]`);
      // 미리보기는 내용을 쓰지 않으므로 표준 입력을 기다리지 않는다.
      return done(fc.writeFile(args[0], args.length > 1 ? args.slice(1).join(' ') : dryRun ? '' : readStdin(), {
        append: command === 'append',
        force,
        dryRun,
      }));
    case 'cat':
      need(args, 1, 'cat <파일>');
      return done(fc.readFile(args[0]));
    case 'rename':
      need(args, 2, 'rename <경로> <새이름>');
      return done(fc.rename(args[0], args[1], { force, dryRun }));
    case 'mv': {
      need(args, 2, 'mv <원본...> <대상>');
      const lines = fc.move(args.slice(0, -1), args[args.length - 1], { force, dryRun });
      return done(lines, lines.join('\n'));
    }
    case 'cp': {
      need(args, 2, 'cp <원본...> <대상>');
      const lines = fc.copy(args.slice(0, -1), args[args.length - 1], { force, dryRun });
      return done(lines, lines.join('\n'));
    }
    case 'rm': {
      need(args, 1, 'rm <경로...>');
      const lines = fc.remove(args, { permanent: flags.has('permanent'), dryRun, permanentHint: true });
      return done(lines, lines.join('\n'));
    }
    case 'unzip':
      need(args, 1, 'unzip <압축파일> [폴더]');
      return done(fc.unzip(args[0], args[1], { dryRun }));
    case 'zip':
      need(args, 2, 'zip <압축파일> <원본...>');
      return done(fc.zip(args[0], args.slice(1), { force, dryRun }));
    case 'flatten': {
      checkWholeTarget(command, args, flags);
      const result = flatten(args[0], { dryRun, onProgress: progress });
      return failIf(result.failed.length > 0 || result.keptFolders.length > 0, result, formatFlatten(result));
    }
    case 'product-number': {
      checkWholeTarget(command, args, flags);
      const result = addProductNumbers(args[0], { dryRun });
      // 못 찾은 파일은 보고로 충분하다. 실패한 파일이 있을 때만 실패로 끝낸다.
      return failIf(result.failed.length > 0, result, formatProductNumbers(result));
    }
    case 'normalize': {
      checkWholeTarget(command, args, flags);
      const result = normalizeFiles(args[0], { dryRun, includeLowercase: flags.has('include-lowercase') });
      // 겹치거나 건너뛴 것은 보고로 충분하다. 실패한 파일이 있을 때만 실패로 끝낸다.
      return failIf(result.failed.length > 0, result, formatNormalize(result));
    }
    case 'collapse': {
      checkWholeTarget(command, args, flags);
      const result = collapse(args[0], { dryRun });
      // 건너뛴 것은 보고로 충분하다. 실패한 구간이 있을 때만 실패로 끝낸다.
      return failIf(result.failed.length > 0, result, formatCollapse(result));
    }
    case 'extract-all': {
      checkWholeTarget(command, args, flags);
      const result = extractArchives(args[0], { dryRun, removeArchives: flags.has('remove-archives') });
      // 건너뛴 것은 보고로 충분하다. 풀지 못한 압축 파일이 있을 때만 실패로 끝낸다.
      return failIf(result.failed.length > 0, result, formatExtractions(result));
    }
    case 'find-broken': {
      checkWholeTarget(command, args, flags);
      // 찾은 파일은 보고로 충분하다. 파일을 건드리지 않으므로 --dry-run은 결과가 같다.
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
      // 저화질 기준 값은 find-low-quality와 같게 글자 그대로 넘긴다. 다른 명령에서는 위에서 거부했다.
      // 진행 표시는 remove-broken만 낸다(#99). 다른 두 명령은 받지 않는다.
      const result = remover(args[0], { dryRun, confirm, minHeight: values.get('min-height'), minBitrate: values.get('min-bitrate'), onProgress: progress });
      const report = format(result);
      // 실패해도 옮긴 파일의 보고는 표준 출력으로 낸다. 남기거나 건너뛴 것은 보고로 충분하다.
      const fail = (message) => done(result, report, Object.assign(new fc.FcError(message), { output: report }));
      if (result.failed.length > 0) return fail(`휴지통으로 보내지 못한 파일이 ${result.failed.length}개 있습니다.`);
      if (result.mismatch) return fail('목록이 확인값을 만든 때와 달라 아무것도 지우지 않았습니다. 새 목록을 확인하세요.');
      if (flags.has('yes') && confirm === undefined && !dryRun && result.removals.length > 0) return fail('--yes에는 목록에 나온 확인값을 붙이세요. 아무것도 지우지 않았습니다.');
      return done(result, report);
    }
    case 'find-duplicates': {
      checkWholeTarget(command, args, flags);
      // 찾은 묶음은 보고로 충분하다. 파일을 건드리지 않으므로 --dry-run은 결과가 같다.
      const result = findDuplicateNames(args[0]);
      return done(result, formatDuplicateNames(result));
    }
    case 'find-low-quality': {
      checkWholeTarget(command, args, flags);
      // 값은 글자 그대로 넘겨 lowQualityCriteria가 검사한다. 정수가 아니면(abc, 1.5, 빈 값) 받은 값을 밝혀 거부한다.
      // 찾은 파일은 보고로 충분하다. 파일을 건드리지 않으므로 --dry-run은 결과가 같다.
      const result = findLowQuality(args[0], { minHeight: values.get('min-height'), minBitrate: values.get('min-bitrate') });
      return done(result, formatLowQuality(result));
    }
    default:
      throw Object.assign(new fc.FcError(`알 수 없는 명령: ${command}`), { unknownCommand: true });
  }
}

module.exports = { execute, parse };
