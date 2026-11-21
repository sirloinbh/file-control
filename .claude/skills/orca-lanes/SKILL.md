---
name: orca-lanes
description: Run a repo's open issue cards in parallel through Orca worktree "lanes". Creates N child Orca worktrees, splits the open issues among them with no file overlap, starts one Claude session per lane that runs the full commit → push → PR → review → merge → next-issue loop on its own, and keeps the current session as the coordinator that relays choices, reassigns idle lanes and closes finished cards. Use when the user asks to create lanes or worktrees, distribute issue cards, start parallel work, or automate the work loop in any sirloinbh project repository (for example "create several worktrees, split the issues, and let them work"). Args: optional lane count (default 4) and an optional issue filter.
---

<!-- Managed file. Edit it in sirloinbh/project-standards templates/common/skills/orca-lanes/ -->

# Orca lanes: parallel issue work with one coordinator

The current session is the **coordinator**. It never edits files or creates branches in the main checkout. It plans, writes the lane brief, starts the lanes, relays messages, asks the user for decisions, and closes finished cards. All implementation happens inside the lanes.

Follow the repo's own AGENTS.md/CLAUDE.md for the issue, branch, commit, PR, review and merge rules (std-backlog, std-git-writing, std-code-review, the `gh-project.ps1` wrapper, `pr merge --merge` without `--delete-branch`). This skill only adds the lane mechanics.

## 1. Survey (read-only)

1. `git status` in the main checkout; stop and tell the user if it is dirty in a way that matters.
2. Run `ListAgents` and `orca worktree list` to see existing lanes and sessions. Reuse an idle existing lane before creating a new one.
3. List open issues with labels (`issue list --state open --json number,title,labels`). Drop epics, `needs-user`, `[Manual]` and "user confirmation" items: those stay with the user.
4. For each remaining issue note the paths it will touch (read the issue body). Group issues into **areas that do not share files** (for example backend, deploy and workflows, scripts and config, UI, docs). Respect blockers: an issue goes after the issue it depends on, in the same lane when possible.

## 2. Plan the lanes

- Lane count: the user's number, else one lane per area, max 6 (each lane runs its own Claude session and tests, so check the PC memory; full test runs are serialized anyway).
- Write `<orca workspace>/<repo>/LANES.md` (outside the repo, next to the lane folders) with:
  - the coordinator session name (from `ListAgents`: "This session is <name>");
  - a table: lane | worktree path | issues in order | owned paths;
  - shared-file rules: generated outputs (take main's version and regenerate on conflict), append-only lists (keep both sides), single-key edits in shared config (name the key and the lane);
  - the **rules for every lane** below.
- Edit LANES.md with Write/Edit only (Bash writes into the Orca workspace folder may be sandboxed and not persist).
- Show the user the table in a few lines and go on; ask only if a real choice is open (AskUserQuestion, recommended option first).

### Rules for every lane (copy into LANES.md)

0. **Full automatic cycle.** For each issue, with no pause and no "go" between issues: branch from origin/main → implement + tests + change record → check → commit (stage files by name) → push → PR (template, `Closes #N`) → review 1–2 times → fix on the branch → merge origin/main into the branch, rerun the check, push → merge → clean up (`git switch --detach origin/main`, delete the local branch) → start the next issue at once.
1. Work assigned issues in order. Blocked → skip to the next and come back later.
2. Edit only owned paths. Anything else, or a file nobody owns: ask the coordinator first.
3. **User choices go to the coordinator**, never decided alone: `[lane-N] #<issue> needs a choice: <one line>`, options A/B/C with the recommendation first, then continue with work that does not depend on it. This covers design choices, `[Manual]`/`needs-user` steps, installs outside policy, real cloud/production changes (`terraform apply`, IAM, secrets), writes to production data, and anything under "check before merging".
4. After each merge send one line: `[lane-N] merged #<PR> (closes #<issue>); next #<issue>`. When nothing is left: post a handoff comment on the epic and send `[lane-N] done` with what is left and why.
5. One full test run at a time across lanes: take a lock folder with `if mkdir <ws>/.check-lock; then echo "lane-N $(date -Is)" > <ws>/.check-lock/owner; <full check>; rc=$?; rm -rf <ws>/.check-lock; fi`. Never remove a lock another lane owns unless its owner file is older than 20 minutes.
6. "Base branch was modified" on merge: merge origin/main again, rerun the check, push, retry. Report "merged" only after the PR state is MERGED.
7. Apps that deploy on merge: after each merge confirm the deployed commit = main and health is 200; on a failure stop and report. Never kill a hung deploy without telling the coordinator.
8. Never force-push, never push to main, never print or commit secrets, do not edit the main checkout or the coordinator's notes.

## 3. Create the lanes

For each lane N (skip ones that already exist):

```powershell
orca worktree create --name lane-N --base-branch origin/main --parent-worktree path:<main checkout>
orca terminal create --worktree name:lane-N --title lane-N --command "claude --model opusplan --dangerously-skip-permissions '<prompt>'"
```

- The prompt must contain **no apostrophes** (it sits inside single quotes in PowerShell). Keep it short: "You are lane-N of <repo>. Coordinator: <name>. Read <path>/LANES.md first and follow it. Your issues in order: #a, #b, #c. Start now and run the full cycle without pausing."
- Do not use `orca agent launch` (fails when Orca hits its terminal limit).
- After a minute run `ListAgents`; each lane appears as `lane-N-xx`. Note the names; send nothing until they appear.

## 4. Coordinate (the automated loop)

The lanes loop on their own (rule 0). The coordinator reacts to messages and keeps every lane busy:

- **Merged / progress lines**: relay to the user in one or two short lines in the language the user reads (English for sirloinbh repos). Verify claims that close something big (PR state, issue state) before telling the user.
- **Choice requests**: ask the user with AskUserQuestion (recommended first), then relay the answer to that lane. A lane may not accept a relayed approval for an outward action that needs the user's own confirmation; tell the user to confirm in that lane's terminal.
- **Overlap**: when two lanes need the same file or repo, name one owner and tell both. When a lane's session is gone (`ListAgents` no longer lists it), move its remaining work to an idle lane or restart it with a prompt that carries its pending state.
- **Idle lane** (`[lane-N] done` or idle in `ListAgents`): list open issues again, give it the next unassigned, unblocked card in its area (or a neighbouring area with no overlap), and update LANES.md. If no card is left, offer a short review-and-file round in its area (max 4 new issues, real problems only, check for duplicates first), or tell the user nothing is left.
- **Close finished cards** when asked or when a lane reports done: check boxes and sub-issue counts (`sub_issues_summary`), close epics whose sub-issues are all closed, and close issues whose work is verified, each with a one-line comment naming the PRs.
- If the coordinator session restarts, its name changes: update LANES.md and tell every lane.

Optional: if the user wants unattended checking, run `/loop` with a long self-paced interval that runs `ListAgents` and the open-issue list and reassigns idle lanes.

## 5. Wrap up

When the user asks to clean up (or all lanes are done):

1. For each lane to close: check `git status` and unpushed commits (`git log --branches --not --remotes`) in the lane and in any helper clones (`lane-N-apps/`); report anything unpushed before deleting.
2. Stop leftover processes holding lane folders (find them by command line), then `orca worktree rm --worktree path:<lane path> --force --delete-branch`.
3. Delete helper clone folders, run `git worktree prune`, delete merged local branches (`git branch --delete`; use `-D` only after confirming no unique commits with `git log origin/main..<branch>`).
4. Remote branch cleanup only in the repos the user names.
5. Leave lanes the user says are still working untouched.
