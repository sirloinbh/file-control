'use strict';

// The UI job process (#253). The server starts it with child_process.fork and sends { argv } once.
// The command waits synchronously for PowerShell and tar, so calling it inside the server would freeze the whole screen. So it runs here.
// Messages it sends:
//   { type: 'progress', line }                 what a long-running command did, one line at a time
//   { type: 'done', outcome }                  the result of execute() (converted so it can be carried as JSON)
//   { type: 'error', error }                   an argument error or an exception during the run
// After sending the result, it drops the connection and ends.
const fc = require('../commands');
const { execute } = require('../execute');
const { toPlain } = require('./serialize');

function runOnce(argv, send) {
  try {
    const outcome = execute(argv, {
      progress: (line) => send({ type: 'progress', line: String(line) }),
      // The screen has no standard input. Waiting would never end the job, so it refuses right away.
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
