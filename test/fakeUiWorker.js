'use strict';

// A fake job process used in jobs.test. It decides what to do by the first word of the argv received.
//   progress <n>   sends n progress lines and then sends the result
//   wait <file>    waits until file exists and then sends the result
//   crash          ends leaving only standard error, with no result
//   error          sends an error message
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
