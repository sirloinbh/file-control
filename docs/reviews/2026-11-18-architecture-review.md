# Architecture review (2026-11-18)

Scope: a macro-level review of structure, dependencies, framework fit, unnecessary code, duplication, refactoring, and efficiency. It is not a line-level bug review.
Reviewed commit: the latest `origin/main` on 2026-11-18.
Not checked: the tool was not run, and the tests were not run. The large files were read by outline (exports, imports, function lists) plus selected parts, not line by line. A finding that needs confirming says so.

Ratings: Impact high / medium / low, Effort S / M / L. Paths are relative to this repo.

## Stack

- Node 22 or later, CommonJS, zero npm dependencies (a written rule in `CLAUDE.md`).
- Windows only: it calls PowerShell and `tar` through `child_process`.
- `src/` has about 11,400 lines in 45 files. `test/` has about 23,700 lines with `node:test`. CI runs on Windows with Node 22 and 24.
- The CLI (`bin/fctl.js`) and a local web UI (`src/ui/`, `node:http` on 127.0.0.1) share one dispatcher (`src/execute.js`). The UI runs commands in a forked worker.

## Findings

### 1. Structure

**D1. The three `remove-*` commands copy their safety rules. Impact medium-high, Effort M.**

- `src/removeBroken.js:36-102` and `src/removeLowQuality.js:27-93` are nearly the same code. Both hold the changed-file check, the path length limit, the 5-minute hold, the download marker, the hard-link rule, the fixed-disk check, and the permanent-delete check.
- `src/removeDuplicates.js:95-225` has its own variant of the same rules.
- The "confirm value, write the log, send in batches" driver is also written three times: `src/removeBroken.js:162-200`, `src/removeLowQuality.js:108-139`, and `src/removeDuplicates.js:248-282`.
- These are the rules that keep files from being lost. A comment already says "the same judgment as #100" (`src/removeLowQuality.js:79`). That means each fix is repeated by hand.
- `src/removeBroken.js` already acts as the base module. The other two import `holdReason`, `checkOne`, `recycleInBatches`, and `MAX_RECYCLE_SIZE` from it (`src/removeDuplicates.js:12`, `src/removeLowQuality.js:11`).
- Make that explicit with a `src/removal.js`:
  - `planSafeRemovals(candidates, access, options)` for the keep rules.
  - `runConfirmedRemoval(plan, label, logItems, hooks)` for the driver.
  - Each command keeps only "find the candidates" and "format the report".

**D2. `commands.js` is four modules in one file. Impact medium, Effort M.**

- It has 1,841 lines and 52 exports. It holds basic file operations (lines 15-565), the Recycle Bin with three embedded PowerShell scripts (lines 567-1200), and tar and zip handling (lines 1206-1841). Almost every other file imports it.
- Split it into `fsOps.js`, `recycle.js`, and `archive.js`. Let `commands.js` re-export them, so no caller changes.
- The PowerShell helpers `Long` and `Plain` are repeated in two scripts (`src/commands.js:752-753`, `923-924`). A shared prelude string removes that.

**D3. `flatten.js` doubles as the shared guard library. Impact medium, Effort S-M.**

- Ten modules import `LEFTOVER`, `SYSTEM_FOLDER`, `REPOSITORY_FOLDER`, `moveWithoutOverwrite`, or `rejectRepository` from the flatten feature: `src/broken.js:8`, `src/collapse.js:9`, `src/duplicates.js:7`, `src/extract.js:9`, `src/lowQuality.js:6`, `src/normalizeFiles.js:9`, `src/productName.js:10`, and the three remove files.
- Move the skip rules and the repository detection to `guards.js`. Move the move helper to `safeMove.js`.
- Likewise, `src/lowQuality.js:8` imports `describeVideo` from `src/duplicates.js`. A small `video.js` is the natural home for it.

**D4. Commands are described in three hand-kept places. Impact low, Effort M.**

- The `HELP` text (`bin/fctl.js:6-44`).
- The `switch` and the scattered "this flag only with that command" checks in `src/execute.js` (the block after `rejectUnknownOptions`).
- The README.
- One command table (name, usage, allowed flags, whole-target or not) could drive the help text and the flag checks. Do it only if the command list keeps growing.

### 2. Dependencies

Fine, with one note.

- The zero-dependency rule costs about 2,260 lines of binary parsers: `src/mkv.js`, `src/mp4.js`, `src/videoSps.js`, `src/sevenZip.js`, and `src/tarGzScan.js`. The tests for them are about as long.
- That is a deliberate choice for a tool that deletes personal files. It also avoids needing ffprobe on the PC. Keep it.

**D6. CI uses unpinned versions. Impact low, Effort S.**

- `.github/workflows/ci.yml:19` uses `windows-latest`, and line 26 uses `actions/setup-node@v4`. The other sirloinbh repos pin the runner image and the action commit SHA.

### 3. Framework and tool fit

Fine. These all use the platform sensibly:

- `node:test` with a preload guard.
- `node:http` for a local-only UI.
- A forked worker for long jobs.
- Batched PowerShell calls, because starting PowerShell per file costs 0.5 to 0.6 seconds (`src/removeBroken.js:204-232`).

### 4. Unnecessary code

I found no dead modules. Every file in `src/` is in the import graph from `bin/fctl.js` or `src/ui/server.js`.

### 5. Duplication

D1 is the main one. D2 has the small PowerShell repeat.

### 6. Refactoring plan

1. `src/removal.js` (D1). The tests for the three commands already exist and protect the move.
2. `guards.js` and `safeMove.js` out of `src/flatten.js` (D3).
3. Split `src/commands.js` behind re-exports (D2).
4. A command table (D4), optional.

Do them in this order. Step 1 removes the riskiest duplication. Steps 2 and 3 are pure moves with no behavior change.

### 7. Efficiency

**D5. The remove planners appear to walk the tree twice. Impact low-medium, Effort S.**

- `src/removeBroken.js:38-39` and `src/removeLowQuality.js:29-30` call `walk(access.target)` for the repository check. Then they call the finder, which walks the same target again.
- On a large video folder, that doubles the directory scan. Pass the entries in.
- I read the planners, not the inside of the finders. Confirm this first.

## Done well, keep

- The delete flow: plan first, confirm with a value bound to the exact list, write a log, then send to the Recycle Bin.
- The test preload that makes a real Recycle Bin call impossible (`test/noRealRecycle.js`).
- A 2:1 ratio of test lines to source lines.
- The UI depends on the core, never the other way round. It reuses `execute`, so the CLI and the UI cannot diverge.
- Long jobs run in a forked worker, so the UI server stays responsive.

## Cross-repo patterns that involve this repo

This repo is separate from the app portfolio. It does not receive the central sync from project-standards, and it shares no code with shared-auth, shared-ai, or shared-aws-infrastructure. No cross-repo duplication was found.

One small difference from the portfolio's habits: CI versions are not pinned (D6). The pinned values live in `versions.json` in project-standards. The fix belongs here, in `.github/workflows/ci.yml`, by copying those values.

## Recommendations for this repo, in priority order

| # | Recommendation | Finding | Impact | Effort |
|---|---|---|---|---|
| 1 | One `src/removal.js` for the safety rules and the confirm-log-batch driver of the three `remove-*` commands | D1 | medium-high | M |
| 2 | Pass the walked entries into the finders, so the remove planners scan the tree once (confirm first) | D5 | low-medium | S |
| 3 | Move the shared guards out of `src/flatten.js` into `guards.js` and `safeMove.js` | D3 | medium | S-M |
| 4 | Split `src/commands.js` into `fsOps.js`, `recycle.js`, and `archive.js` behind re-exports | D2 | medium | M |
| 5 | Pin the runner image and the action SHA in CI | D6 | low | S |
| 6 | One command table that drives the help text and the flag checks, if commands keep growing | D4 | low | M |
