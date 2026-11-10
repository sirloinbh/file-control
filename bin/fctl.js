#!/usr/bin/env node
'use strict';

const { execute } = require('../src/execute');

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
  remove-broken <타겟>          깨진 파일 목록과 확인값 보기 (--yes=확인값을 주면 기록을 남기고 휴지통으로)
  find-duplicates <타겟>        이름·제품번호나 길이가 같은 영상 묶기 (파일은 건드리지 않음)
  remove-duplicates <타겟>      중복 영상 중 지울 파일 목록과 확인값 보기 (--yes=확인값을 주면 기록을 남기고 휴지통으로)
  find-low-quality <타겟>       해상도·비트레이트가 기준 미만인 저화질 영상 찾기 (파일은 건드리지 않음)
  remove-low-quality <타겟>     저화질 영상 중 지울 파일 목록과 확인값 보기 (--yes=확인값을 주면 기록을 남기고 휴지통으로)
  ui [--port=번호] [--no-open]  로컬 웹 화면 띄우기 (127.0.0.1, 기본 포트 8109, Ctrl+C로 끝냄)

옵션:
  --force       이미 있는 파일을 덮어씀
  --permanent   rm에서 휴지통을 거치지 않고 영구 삭제
  --dry-run     바뀔 내용만 출력하고 실제로는 건드리지 않음
  --remove-archives  extract-all에서 정상으로 풀린 압축 파일을 휴지통으로 보냄
  --yes=확인값  remove-broken, remove-duplicates, remove-low-quality에서 목록이 그대로일 때만 실제로 휴지통으로 보냄
  --include-lowercase  normalize에서 소문자 말(abc-123)도 번호로 보고 바꿈
  --min-height=화소    find-low-quality, remove-low-quality에서 화면의 짧은 쪽이 이 값 미만이면 저화질 (기본: 360)
  --min-bitrate=kbps   find-low-quality, remove-low-quality에서 비트레이트가 이 값 미만이면 저화질 (기본: 보지 않음)
  --            뒤의 인자는 모두 옵션이 아닌 이름·내용으로 봄
  -h, --help    도움말`;

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
    console.error(`오류: ${err.message}`);
    process.exit(1);
  });
} else if (require.main === module) {
  try {
    // 진행 줄은 표준 오류로 낸다. 표준 출력의 마지막 보고는 그대로 두고, 중간에 끊겨도 이미 한 일이 화면에 남는다.
    const output = run(process.argv.slice(2), { progress: (line) => process.stderr.write(`진행: ${line}\n`) });
    if (output) console.log(output);
  } catch (err) {
    if (err.output) console.log(err.output);
    const detail = err.stderr ? `\n${err.stderr.toString().trim()}` : '';
    console.error(`오류: ${err.message}${detail}`);
    process.exit(1);
  }
}

module.exports = { run };
