---
name: std-implementation
description: Follow the issue, numbered branch, implementation with docs, tests, and PR workflow for changes to a sirloinbh project repository. Use for code, configuration, documentation, and skill edits; exclude read-only questions and recommendations. After the PR is created, review it yourself, then merge it once checks pass.
---

<!-- Managed file. Edit it in sirloinbh/project-standards templates/common/skills/std-implementation/ -->

# Implementation procedure

This skill applies to changes in the `sirloinbh/file-control` repo. First read the project root `AGENTS.md` (and `AGENTS.project.md` if present) and the related docs. Follow the steps below and deliver a verified PR as the result.

Skills used together:

- [std-backlog](../std-backlog/SKILL.md): splitting issues, priority and characteristic labels, choosing the next task
- [std-git-writing](../std-git-writing/SKILL.md): how to write issues, branches, commits, and PRs, plus templates
- [std-testing](../std-testing/SKILL.md): writing and running tests (app repos)

## Decisions: proceed with the default

Do not stop to ask the user to choose when a sensible default exists. Pick the default, continue, and record the choice so the user can reverse it later. Several worktrees often run at once, and every question stalls one of them.

- Proceed without asking when there is a conventional default, the code or existing docs settle the choice, or the choice is easy to reverse (naming, file placement, wording, ordering, which of two equivalent approaches).
- Ask first only for decisions that are truly the user's: irreversible actions, costly actions, actions that become public, actions that conflict with the requirements, `terraform apply` and other real AWS or production changes (merging a PR is not applying it), steps the issue marks as user-only (`[Manual]`, `needs-user`), package installs outside pre-approved scope, and anything the issue marks as "user confirmation". Keep working on the other parts of the task while waiting.
- Write each choice made without asking in the PR "Check before merging" section as a line such as "Chose X over Y because Z. Say so if you want Y." Add the same line to the `docs/changes/` record.
- If an item in "Check before merging" needs the user's answer before merging, say so in the PR and do not merge.

## 1. Register the issue

- Check the GitHub remote URL and `gh api user --jq .login`. The expected account is `sirloinbh`. If it is a different account, make no remote changes until authentication is fixed.
- Reuse an issue the user named, or one already registered for the same request. Check existing results before retrying so you do not create duplicate issues.
- Write a new issue with the splitting and label rules of std-backlog and the issue template of std-git-writing. An issue card means a GitHub Issue. Do not create or link a Projects board unless one was specified.
- Write the body to a temporary UTF-8 file and register it with `--body-file`. Do not include tokens or secrets.
- Keep the real issue number and URL that were issued. If registration fails, do not invent a number or start code changes first.

## 2. Create a branch from the issue number

- Check the working tree and current branch. If there are changes from other work, keep them and do not mix tasks.
- The default target branch is `main`. Do not start new work from an unrelated unmerged branch. In a clean working tree, fetch the remote main and branch from it.
- Name the branch by the std-git-writing rule (`<type>/<number>-<english-summary>`).
- If a branch for the same issue already exists, check its state and continue on it.
- Make changes and commits on this branch. Do not commit or push directly to `main`.

## 3. Implement and record docs per commit

- In app repos, read std-testing and write or update the related tests together. Add a regression test for a bug fix. Put the implementation, tests, and docs in the same commit, and run the related tests before committing.
- Implement only the requested scope. For development foundation cleanup, also read std-foundation.
- Create `docs/changes/<number>-<slug>.md` and record the issue link, purpose, changes, verification, and limits or follow-up work.
- **In each work commit, also record that commit's changes and verification in docs.** You may accumulate entries in one issue document.
- Record why the change was made and the observed results. Do not claim a check or deployment is done if it was not run.
- Write commit messages in the std-git-writing format (`<type>: <what was done> (#number)`).
- Before staging, check the diff for secrets, and stage only the related files by name.

## 4. Test, then create the PR

- Before creating or updating a PR, run the related tests and required checks on the final change. Follow the project `AGENTS.md` for the required commands and the DB integration test conditions.
- Fix failures, and record in docs and the PR, separately, any checks that could not run, skipped DB tests, and unfinished browser verification. If a needed verification is blocked, create the PR as a draft.
- Push only the work branch. The PR target is this repo's `main`.
- If a PR for the same head branch exists, update it instead of creating a new one.
- Write the PR title and body with the std-git-writing PR template. Pass the body as a UTF-8 file.
- Check the GitHub Actions results and resolve related failures. Report checks that are still running as running.

## 5. Review and merge

User decision, 2026-11-15 (#591): in every repo, the agent reviews its own PR and merges it. This includes infra repos and app repos where merging `main` deploys to production.

1. **Review your own PR** with [std-code-review](../std-code-review/SKILL.md) section 8. Do 1 or 2 rounds, and more only while blocking findings remain. Fix findings with new commits on the same branch between rounds.
2. **File issues for big problems outside the PR's scope** instead of growing the PR (std-code-review section 8, std-backlog).
3. **Merge** with `pr merge --merge` after the review passes and the required checks on the final head are green. Do not use `--delete-branch`, squash, `--admin`, or force-push, and never push to `main` directly.
4. **Clean up locally** with the std-git-writing steps (`git switch main`, `git pull --ff-only`, `git branch --delete <branch>`, `git fetch --prune origin`).

- Do not merge, and ask the user, when the PR's "Check before merging" has an item that needs the user's own decision, or when a check is failing or still running.
- Merging is not applying. `terraform apply`, server changes, and other real AWS or production changes still need the user's OK. If merging `main` deploys by itself, say so in the PR body.
- A repo's `AGENTS.md` or `AGENTS.project.md` may add stricter rules for that repo; those win.
- Let the issue close when the PR is merged.

## Authentication and failure handling

Do not ask again, without need, for issue, push, and PR permissions already given. Respect the execution permissions the tool requires and GitHub authentication. On failure, restart from the step that was completed, and if the result of a remote creation is unclear, look it up before retrying. Do not work around an account or authentication problem with another account.
