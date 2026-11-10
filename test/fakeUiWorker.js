'use strict';

// jobs.test에서 쓰는 가짜 작업 프로세스. 받은 argv의 첫 말로 할 일을 정한다.
//   progress <n>   진행 줄 n개를 보내고 결과를 보낸다
//   wait <file>    file이 생길 때까지 기다린 뒤 결과를 보낸다
//   crash          결과 없이 표준 오류만 남기고 끝난다
//   error          오류 메시지를 보낸다
const fs = require('node:fs');

process.once('message', ({ argv }) => {
  const [mode, value] = argv;
  const finish = (msg) => process.send(msg, () => process.disconnect());
  if (mode === 'progress') {
    for (let i = 1; i <= Number(value); i++) process.send({ type: 'progress', line: `줄 ${i}` });
    finish({ type: 'done', outcome: { command: 'progress', result: { count: Number(value) }, report: '끝' } });
  } else if (mode === 'wait') {
    const timer = setInterval(() => {
      if (!fs.existsSync(value)) return;
      clearInterval(timer);
      finish({ type: 'done', outcome: { command: 'wait', result: null, report: '기다림 끝' } });
    }, 20);
  } else if (mode === 'crash') {
    process.stderr.write('망가짐\n', () => process.exit(3));
  } else {
    finish({ type: 'error', error: { name: 'FcError', message: '일부러 낸 오류' } });
  }
});
