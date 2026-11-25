---
name: std-backlog
description: Register requirements as small GitHub issue cards with priority and characteristic labels, link each one as a sub-issue under a per-area parent (epic) issue, and choose the next issue to implement after the previous PR is merged. Use when the user gives one or more requirements to register or plan, when a requirement is added mid-work, and when deciding what to start next. Applies to every sirloinbh project repository. The agent merges its own PR after the review loop in std-code-review.
---

<!-- Managed file. Edit it in sirloinbh/project-standards templates/common/skills/std-backlog/ -->

# Splitting issues, priorities, and choosing the next task

How to register requirements as GitHub issues (issue cards) and choose the next issue to implement. The implementation itself follows each repo's implementation skill and the work procedure in `AGENTS.md`. Do GitHub work through the `ghp` function or the `gh-project.ps1` wrapper, and first check that the account is `sirloinbh`. Issues are written in English ([std-git-writing](../std-git-writing/SKILL.md)).

## Rules

1. Split requirements into small units when registering them as issues.
2. Decide each issue's priority and attach it as a label (badge).
3. Decide each issue's characteristics and attach them as labels (badges).
4. When the previous requirement is implemented and its PR merged, raise the priority of any added requirement and do it first. If there is none, start the next issue by priority.
5. Link work issues as sub-issues under a per-area parent issue (`epic`) (section 6). After finishing a sub-issue, continue with the next sub-issue of the same parent in the same worktree, and close the parent when its last sub-issue closes (sections 5 and 6).

## 1. How to split

Split small, but not too small. One issue is **one purpose that one PR can review**. The issue list should be readable at a glance.

Split when:

- It is too large for one PR, for example 20 or more files change, or unrelated purposes are mixed.
- The repos differ. However, when the same work repeats across repos, keep **one tracking issue** in the central repo and list each repo as a checkbox. Create the real issue in each repo when work starts.
- There are steps the user must do themselves (creating an App, registering a secret, moving state, approving a package install). Group steps done at the same time into a `[Manual]` issue and label it `needs-user`.
- The direction itself depends on research results. Register a `type/research` issue first.

Combine when:

- Files, scripts, tests, and docs serve the same purpose. Example: schema validator + registry files + conflict check + generated docs.
- Research only needs confirming before implementation starts. Make it the first task of the implementation issue.
- A rule doc and the code that checks it fit in one PR review.
- Several docs of the same kind (rule docs, operations docs) belong together.

Write "Done when" as verifiable statements: tests, command results, files that exist.

Before registering, search the repo's open issues to avoid duplicates. If a similar issue exists, add to its tasks instead of creating a new one. Reuse an existing issue the user names. When merging issues, record the merged numbers under "Notes" of the surviving issue, comment on the closed issue which issue it went into, and close it as `not planned`.

## 2. Priority labels (exactly one)

| Label | When |
|---|---|
| `priority/P0` | Operations or security problems that must be stopped now, or requirements the user called urgent |
| `priority/P1` | Prerequisites for other issues, or cleaning up something already duplicated across repos |
| `priority/P2` | Setting security or operations standards |
| `priority/P3` | Shared work needed soon, or spreading a feature that exists in one repo only |
| `priority/P4` | Docs and rule cleanup, nice-to-have improvements |

If there is not enough to judge the priority, register it as P3 and say in the body that the basis is thin.

### Promoting added requirements

Requirements the user adds mid-work (`origin/added`) are registered **one level** above the level the table gives, capped at P1 (P4→P3, P3→P2, P2→P1, P1→P1). Never promote to P0; P0 is only for the urgent cases in the table.

- Promote once, at registration. Record the original level in the priority line under "Notes" (section 4), and do not promote again when choosing the next task.
- Within the same level, `origin/added` issues go before existing ones (section 5).

## 3. Characteristic labels

- `type/*` (exactly one): `feature` (new feature or managed item), `docs` (docs, rules), `security` (security standards, blocking, audits), `chore` (migration, cleanup, config change), `research` (research, no code change)
- `area/*` (one or more): `templates`, `tooling`, `compliance`, `registry`, `scaffold`, `ci`, `deploy`, `agent`, `app` (app features: screens, API, DB)
- When they apply: `needs-user` (includes a step the user does), `origin/added` (requirement added mid-work)
- Area parent issues get `epic` (section 6).

If a repo lacks a label, create it with the same name, color, and description as in sirloinbh/project-standards (`label create ... --force`). If a new kind of label is needed, open an issue in the central repo first.

## 4. Issue title and body

Titles and bodies follow the issue rules of [std-git-writing](../std-git-writing/SKILL.md) and the issue template (`.github/ISSUE_TEMPLATE/task.md` at the repo root).

- Write the body to a temporary UTF-8 file (no BOM) and register it with `--body-file`. Never include tokens or secrets.
- In the "Parent issue" line under "Notes", write the linked parent as `#number area name`. A parent issue itself has "None" (section 6).
- Under "Blocked by", write prerequisite issues as `#number short name`. Section 5 uses this section to choose the next task.
- In the priority line under "Notes", write the level and the reason. If promoted, include the original level: `Priority: P1 — prerequisite for other work (added requirement, promoted from P2)`

## 5. Choosing the next task

The agent merges its own PRs in every repo after the review loop (std-code-review section 8, user decision 2026-11-15, #591). Review, merge, and do the local cleanup, then choose the next task right away. Wait only when a PR's "Check before merging" has an item for the user. Choose the next task in this order.

1. Check that the previous PR is merged (`pr view <number> --json state,mergedAt`). If not, do not start the next issue, unless the user asked for parallel work.
2. Check for requirements the user added mid-work.
   - Requirements received in conversation but not yet registered are registered by this skill's splitting rules with `origin/added`, promoted one level by the rule in section 2.
   - Already registered `origin/added` issues are not promoted again.
3. Choose the issue to start.
   - Candidates are open issues whose "Blocked by" items are all done (prerequisite issues closed) and that have no user steps left. Parent issues (`epic`) are not candidates.
   - If a work issue has no parent, link it as in section 6 before starting.
   - **Continue the same parent first.** If the issue just finished was a sub-issue and its parent still has candidates, choose among them in the order below. Move to another parent only if it has a candidate with a smaller priority number.
   - Do the next sub-issue of the same parent **in the worktree (checkout) you just worked in**. After the post-merge cleanup (`git switch main`, `git pull --ff-only`, branch deletion), create a new branch from `origin/main` right there. Do not create a new worktree.
   - Among candidates, pick the smallest priority number. Within a level, pick `origin/added` first, then the smaller (earlier) number.
   - If a `needs-user` issue comes first, tell the user what to do. Meanwhile, continue with the next candidate that does not depend on it.
4. Tell the user in one line which issue you chose and why (priority, prerequisite status), then start with the implementation skill's procedure.
5. If there are no candidates, report what each remaining issue is blocked on and stop.

Do not enable auto-merge or a merge queue in place of the review loop. The one exception is the sync PRs of the 4 repos with `autoMergeSync: true` in `sync.config.json` (`shared-auth`, `shared-aws-infrastructure`, `file-control`, `develop-skill`): `scripts/sync.mjs` merges them itself once CI is green ([ADR-0030](https://github.com/sirloinbh/project-standards/blob/main/docs/adr/0030-sync-prs-merge-themselves.md)). Every other repo and every other PR keeps the review loop. A repo's `AGENTS.md` or `AGENTS.project.md` may add stricter rules, which win.

A big problem found during a review that is outside the PR's scope is registered as a new issue with sections 2 to 4 and 6 (labels, priority, parent epic link). Do not grow the PR.

## 6. Parent and sub-issues (grouping by area)

Link work issues as GitHub sub-issues under a per-area parent issue. One parent shows what is left in that area and its progress (m of n sub-issues done).

- **Area**: a group of work in the same feature area, command, or module within a repo. Examples from file-control: "Safe trash deletion", "Reliable archive create and extract". Do not group by priority, type, or timing; labels handle those.
- **Parent issue**: labeled `epic`. It is not implemented directly; it only groups sub-issues.
  - The body states the goal, the scope (which work belongs in the area), and related closed issues.
  - Its priority label matches the highest level among its open sub-issues; re-align it when sub-issues change. Its `type/*` and `area/*` are the most common among its sub-issues.
- **Two levels deep**: parent → work issue. Work issues do not have sub-issues of their own. Split a large work issue into siblings under the same parent (section 1).
- **One parent**: a work issue is linked to exactly one parent (GitHub allows only one). If it spans two areas, link it to the main one and mention the other under "Notes".
- **At registration**: link a new work issue to the matching open parent right away.
  - If no parent matches, create the parent first.
  - Also write the number in the "Parent issue" line under "Notes". Body text alone does not replace the link.
  - Follow-up issues split out of a review are handled the same way.
- **Closed parents**: reopen one only when the new work is within its goal. If the goal is already met, do not reopen it; link to the area's open parent or create a new one, and list the closed issue under "Related closed issues" of the new parent.
- **When to close**: when the last sub-issue closes, close the parent at the same time, before choosing the next task.
  - Before closing, confirm with `sub_issues_summary` that no sub-issue is open, and comment the result of comparing against the goal in the body.
  - If part of the goal is left, do not close it. Register the remaining work as sub-issues and continue.
  - Do not close a parent whose body says "keep open even when all sub-issues are closed", such as an area that continues every working day.
- **Automatic check and close (#1065)**: the daily compliance run (`scripts/compliance.mjs`) lists open work issues without a parent in the "Work issues without epic" column of `docs/compliance.md` and closes epics whose sub-issues are all closed, with a comment naming them. A body that says "keep open" or "do not close" keeps an epic open. The check does not replace linking at registration; fix every `✗` it reports.
- **Multi-repo tracking issues** (section 1) are not parents. Keep the central repo's checkbox tracking as is, and link each repo's real issues to that repo's area parent.
- **First adoption (once per repo)**: the first time you register issues or choose the next task in a repo after this rule is synced, group open work issues that have no parent by area.
  - Tell the user the grouping plan (area, parent, sub-issue numbers) once before proceeding.
  - After linking, check that every open work issue has a parent and report the result.

The link commands are for PowerShell. Sub-issues are attached by REST `id`, not by number.

```powershell
$id = ghp api repos/<owner>/<repo>/issues/<sub-number> --jq .id
ghp api -X POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues -F sub_issue_id=$id
# Move to another parent
ghp api -X POST repos/<owner>/<repo>/issues/<new-parent-number>/sub_issues -F sub_issue_id=$id -F replace_parent=true
# Detach
ghp api -X DELETE repos/<owner>/<repo>/issues/<parent-number>/sub_issue -F sub_issue_id=$id
# Check: prints the parent number. Without a parent, 404 "No parent issue found"
ghp api repos/<owner>/<repo>/issues/<sub-number>/parent --jq .number
# Parent progress
ghp api repos/<owner>/<repo>/issues/<parent-number> --jq .sub_issues_summary
```
