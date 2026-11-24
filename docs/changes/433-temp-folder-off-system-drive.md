# #433 Move test temp files off the system drive

- Issue: https://github.com/sirloinbh/file-control/issues/433 (parent #432 Fast, isolated test runs)

## Purpose

`npm test` created its temp folders with `os.tmpdir()`, which is `%LOCALAPPDATA%\Temp` on `C:`. One run makes thousands of short-lived files there, and Microsoft Defender scans each one. A 3-minute Defender performance recording during a test run showed about 37 s of scan time, about 25 s of it for `node.exe`. The repo is on a Dev Drive (`D:`, ReFS), where Defender scans in performance mode, so the fix moves the run's temp files to the same drive as the repo.

## Changes

- `test/repoTemp.js` (new): a `--require` preload that sets `TEMP`, `TMP`, and `TMPDIR` to `../.file-control-test-tmp` (next to the repo) and keeps the original folder in `FC_SYSTEM_TEMP`. Every process of the run inherits the variables. `FC_TEST_SYSTEM_TEMP=1` turns it off. If the folder above the repo is not writable, the system temp folder stays.
- `package.json`: the `test` script loads `test/repoTemp.js` before `test/noRealRecycle.js`, so the guard's log file also lands in the new folder.
- `test/commands.test.js`, `test/flatten.test.js`: `tempDir()` takes a base folder. The 7 tests about 8.3 short names (names like `LONGER~1.TXT`) use `FC_SYSTEM_TEMP`, because ReFS does not make 8.3 names.

Why next to the repo and not inside it: `src/guards.js` `rejectProjectAncestor` refuses targets under a folder that holds `package.json`. A temp folder inside the repo made 9 tests fail with "a parent folder looks like a project folder".

## Verification

- `npm test` by default: 1,695 tests, 1,692 pass, 0 fail, 3 skipped.
- `npm test` with `FC_TEST_SYSTEM_TEMP=1`: 1,695 tests, 1,692 pass, 0 fail, 3 skipped (the same 3 skips).
- Before the 8.3 change, the default run had 1 failure and 5 extra skips, all 8.3 short-name tests.
- During a default run, no new `fc-*` folder appeared in `%LOCALAPPDATA%\Temp`, and `../.file-control-test-tmp` was empty afterwards.
- `node --require ./test/repoTemp.js` printed the new folder from `os.tmpdir()` in both the parent and a child Node process.

## Limits and follow-up

- No new Defender performance recording was taken after the change, so the scan-time saving is expected, not measured.
- The run creates `../.file-control-test-tmp` next to the checkout and leaves the empty folder there.
- The 7 short-name tests still write a few small files to the system temp folder.
