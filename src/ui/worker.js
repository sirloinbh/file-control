'use strict';

// UI 작업 프로세스(#253). 서버가 child_process.fork로 띄우고 { argv }를 한 번 보낸다.
// 명령은 PowerShell·tar를 동기로 기다리므로 서버 안에서 부르면 화면 전체가 멈춘다. 그래서 여기서 실행한다.
// 보내는 메시지:
//   { type: 'progress', line }                 오래 걸리는 명령이 한 일을 한 줄씩
//   { type: 'done', outcome }                  execute()의 결과(JSON으로 옮길 수 있게 바꾼 것)
//   { type: 'error', error }                   인자 오류나 실행 중 예외
// 결과를 보낸 뒤 연결을 끊고 끝난다.
const fc = require('../commands');
const { execute } = require('../execute');
const { toPlain } = require('./serialize');

function runOnce(argv, send) {
  try {
    const outcome = execute(argv, {
      progress: (line) => send({ type: 'progress', line: String(line) }),
      // 화면에는 표준 입력이 없다. 기다리면 작업이 끝나지 않으므로 바로 거부한다.
      readStdin: () => {
        throw new fc.FcError('In the UI, also enter the file contents.');
      },
    });
    send({ type: 'done', outcome: toPlain(outcome) });
  } catch (err) {
    send({ type: 'error', error: toPlain(err instanceof Error ? err : new Error(String(err))) });
  }
}

if (require.main === module) {
  process.once('message', (message) => {
    const argv = message && Array.isArray(message.argv) ? message.argv.map(String) : null;
    const finish = () => process.disconnect();
    if (!argv) {
      process.send({ type: 'error', error: { name: 'FcError', message: 'No command to run.' } }, finish);
      return;
    }
    let last;
    runOnce(argv, (msg) => {
      last = msg;
      if (msg.type === 'progress') process.send(msg);
    });
    process.send(last, finish);
  });
}

module.exports = { runOnce };
