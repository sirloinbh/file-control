'use strict';

// Puts the test run's temp files in a folder next to the repo (../file-control-test-tmp) instead of the system temp folder.
// The tests create many short-lived files (media, journals, logs) through os.tmpdir(). In the system temp folder
// on C:, antivirus real-time scanning checks each one, which made a test run cost about 25 seconds of scan time.
// Next to the repo they land on the same drive as the code (a Dev Drive here, where scanning runs in performance mode).
// It is next to the repo, not inside it, because src/guards.js refuses targets under a folder that holds package.json.
// For the same reason the folder above the repo must not hold package.json (or an .exe together with a .dll).
// The name has no leading dot: src/protectedPaths.js treats a dot folder directly under the user folder as a settings
// folder, which would refuse the temp targets of a checkout that sits directly under the user folder.
//
// `npm test` loads it with --require before noRealRecycle.js. It only changes environment variables, and every process
// the run starts inherits them, so os.tmpdir() points at the same folder in the test file processes too.
// FC_TEST_SYSTEM_TEMP=1 keeps the system temp folder.
//
// The original folder stays in FC_SYSTEM_TEMP. Tests that need 8.3 short names use it, because a Dev Drive (ReFS)
// does not make short names, and those tests would be skipped there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// FC_TEST_TMP marks a process whose parent already moved the temp folder, so child processes do nothing here.
// A value left exported in the shell has the same effect and skips the move.
if (process.env.FC_TEST_SYSTEM_TEMP !== '1' && !process.env.FC_TEST_TMP) {
  const dir = path.resolve(__dirname, '..', '..', 'file-control-test-tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    process.env.FC_SYSTEM_TEMP = os.tmpdir();
    process.env.FC_TEST_TMP = dir;
    // os.tmpdir() reads TEMP / TMP on Windows and TMPDIR elsewhere.
    process.env.TEMP = dir;
    process.env.TMP = dir;
    process.env.TMPDIR = dir;
  } catch {
    // The folder above the repo is not writable: keep the system temp folder.
  }
}
