---
name: std-git-writing
description: Write GitHub issues, branch names, commit messages, and pull requests in plain English so a person can understand them at a glance, using the shared issue and PR templates. Use whenever creating or editing an issue, branch, commit, or PR in any sirloinbh project repository, together with std-backlog for labels and priorities.
---

<!-- Managed file. Edit it in sirloinbh/project-standards templates/common/skills/std-git-writing/ -->

# Writing issues, branches, commits, and PRs

What goes into Git and GitHub is a record people read again later. Someone seeing it for the first time should know what happened from the title alone, and know what to do after reading the body. Labels and priorities follow [std-backlog](../std-backlog/SKILL.md).

## 1. Principles

- **English only.** Titles, bodies, commit messages, and review comments are written in English. Older records written in Korean are translated by their own issue; do not mix languages in new text.
- **Lead with the result.** The first sentence says what was done or will be done. Do not open with background.
- **Use plain words.** Explain abbreviations and internal keys (`neverTouch`, `manifest`, ...) the first time they appear. Put file paths and commands in backticks.
- **One point per sentence.** Split multiple items into a list or table. Use checkboxes (`- [ ]`) for lists whose progress must be tracked.
- **Make it verifiable.** Instead of vague words like "improve" or "clean up", name the changed files, numbers, and command results.
- **Make the reader's job clear.** Collect what the user must do themselves at the top or under "Check before merging".
- **Style:** Issue and PR bodies use full sentences. Commit and PR titles use the imperative mood in lower case after the type ("add", "fix", "remove").
- Never write tokens, secrets, or sensitive parts of personal paths anywhere.

## 2. Issues

### Title

- No prefix (`feat:` etc.). One sentence that says **what the issue does**; the label carries the type.
- Start with a verb in the imperative: "Add ...", "Decide ...", "Move ...", "Fix ...". About 60 characters.
- Put multiple scopes in parentheses: `Add Docker build templates (2 Dockerfiles, nginx)`
- Issues the user must do themselves start with `[Manual]`: `[Manual] Create the GitHub App and share Actions settings`
- Issues tracking work in other repos start with the repo name: `workout-memo prep (port reassignment, AGENTS split)`
- Area parent issues (`epic`, std-backlog section 6) state the area and its goal: `Safe trash deletion`, `Reliable archive create and extract`

| Bad | Good |
|---|---|
| `feat: registry/projects.json, platform.json and schema` | `Add registry source files and conflict check` |
| `research: diff scripts/backup.ps1 between workout-memo and 7 apps` | (merge it into the implementation issue as its first task) |
| `Improvements` | `Add a sub-repo check script (standards-check)` |

### Body

Write the six sections of the issue template (`.github/ISSUE_TEMPLATE/task.md` at the repo root) in this order. Do not delete an empty section; write "None".

| Section | Contents |
|---|---|
| Summary | One sentence on what is different once the issue is done |
| Why | The current problem and the evidence (file or doc paths). 2–4 lines |
| Tasks | A checkbox list. One task per line, in order |
| Done when | A checkbox list of verifiable statements: tests, command results, files that exist |
| Blocked by | Number and short name, such as `- #50 template renderer`. "None" if nothing |
| Notes | Priority with a one-line reason (and the original level if promoted), parent issue (`#number area name`; "None" for an area parent itself), related docs, merged issues |

## 3. Branch names

- Format: `<type>/<issue-number>-<english-summary>`
- `type`: `feat` (feature), `fix` (bug), `docs` (docs), `chore` (config, cleanup, migration), `refactor` (structure without behavior change), `test` (tests only), `ci` (CI only)
- The summary is 2–5 lower-case words joined by hyphens: a noun phrase that says what the branch is about.

| Bad | Good |
|---|---|
| `feat/44` | `feat/44-registry-files` |
| `chore/95-fix` | `chore/95-workout-memo-port-reassign` |
| `feat/44-add-json-schema-validator-and-registry-and-versions-files` | `feat/44-registry-files` |

### Local branch management (git CLI)

Local branches are managed with the git CLI. The agent runs these commands itself and uses the same commands when guiding the user.

- **Start work:** Check the current branch and working tree with `git status`, then run `git fetch origin` and `git switch --create <branch> origin/main` in that order. Do not touch local main.
- **Clean up after merge:** Confirm the PR is merged (`pr view <number> --json state,mergedAt`), then run `git switch main`, `git pull --ff-only`, `git branch --delete <branch>`, and `git fetch --prune origin` in that order.
- **Stop and tell the user when any of these is true.** Do not switch or delete branches.
  - There are uncommitted changes.
  - The branch to delete is not merged.
  - Another session or worktree uses the branch to delete (check with `git worktree list`).
  - `git pull --ff-only` fails.
- **If `git branch --delete` is refused:** do not switch to `--force` or `-D`; report the reason.
- **Use long options:** the PowerShell tool's permission rules are case-insensitive and treat `-c`/`-d` like `-C`/`-D`. Write `--create` and `--delete`.
- **Folder locks:** if OneDrive or similar holds a file and git asks whether to retry, answer `n` and do not repeat the command. Check with `git branch --list <branch>` whether the branch was deleted and report the result.
- **Destructive commands:** `git branch -D`, `git reset --hard`, `git clean`, `git stash`, and `git rebase` may be run without asking the user (user decision on #418, 2026-11-08), because the permission files allow them. Use them only when the work needs them, and prefer the safe forms first. Never force-push or push directly to main.
- **Do not use `pr merge --delete-branch`.** The repo setting "Automatically delete head branches" removes the remote branch; the cleanup steps above remove the local one.

## 4. Commit messages

```
<type>: <what was done> (#issue-number)

- Why: one line on why the change is needed
- Change: 1–3 lines on the main changes

<co-author line: follow the runtime environment's instructions>
```

- The title is about 50 characters. `type` uses the same list as branches. Use the imperative in lower case: `feat: add registry conflict check (#44)`
- One commit holds one logical change. Commit the implementation, its tests, and its change record (`docs/changes/`) together.
- The body explains what the diff cannot show. Do not list files.
- Automated commits whose prefix tools rely on (the sync bot's `chore: sync central standards (project-standards@` and the compliance report commit) keep their format.

| Bad | Good |
|---|---|
| `update` | `fix: stop sync PRs from being opened twice (#63)` |
| `feat: work` | `feat: add registry conflict check (#44)` |

## 5. PRs

### Title

Same format as a commit title: `<type>: <what changed> (#issue-number)`. If one PR closes several issues, use the main issue number.

### Body

Write the sections of the PR template (`.github/pull_request_template.md` at the repo root) in this order.

| Section | Contents |
|---|---|
| What changed | One or two sentences. Reading only this should explain the PR |
| Why | The problem and the reason, with links to issues and docs |
| Main changes | A table of files (or groups of files) and what changed. Group rows past 10 |
| Verification | Commands actually run and a summary of results. Anything not run, with the reason |
| Check before merging | Checkboxes for what the user must decide or run. Anything decided differently from the requirements must be listed here |
| Impact | Effect on deployment, other repos, and local setup (.env etc.). "None" if nothing |
| `Closes #number` | One line per issue to close. At the end of the body, just before the co-author note |

- The agent merges its own PR after the review loop (std-code-review section 8, user decision 2026-11-15, #591), in every repo. Do not merge and ask instead when "Check before merging" has an item that needs the user's judgment.
- Reviewing a PR and answering review comments follow [std-code-review](../std-code-review/SKILL.md).
- When you add commits to a PR, update "Main changes" and `Closes` in the body too.

## 6. Checklist before posting

- [ ] Can someone tell what this is from the title alone?
- [ ] Is it written in English?
- [ ] Are abbreviations and internal keys explained the first time?
- [ ] Are the user's own steps collected in one place?
- [ ] Are "Done when" and "Verification" written as facts (command results, files)?
- [ ] Is it free of secrets?
