# Claude Code instructions

Handle the file and folder work the user asks for in words (create, read, edit, rename, move, copy, delete, compress, extract) with this repo's `fctl`.

## Running

- Run it with `node bin/fctl.js <command>`. The command list is in `node bin/fctl.js --help` and [README.md](README.md).
- For work `fctl` cannot do (editing part of a file's content, searching by condition, and so on), use Claude Code's default tools, but follow the rules below the same way.
- When the user says "Downloads", "Desktop", or "Documents", check the real path with `ls` before using it, such as `C:\Users\kimbh\Downloads`, `C:\Users\kimbh\OneDrive\Desktop`, and `C:\Users\kimbh\OneDrive\문서` (`문서` is the Korean name of the Documents folder, kept because it is a real path).

## Rules

1. If you handle many files at once, or the target needs interpretation, first show the list of targets with `ls`, state the plan, and then run it.
2. Send deletions to the Recycle Bin (`rm`). Use `--permanent` and `--force` only when the user said so directly.
3. Before you delete or overwrite, check that the target is right, and if the user did not state it explicitly in this request, get confirmation before running.
4. Do not touch `C:\Windows`, `C:\Program Files`, or the hidden settings folders at the top of the user folder (`.ssh`, `AppData`, and so on) unless the user states them explicitly.
5. When the work is done, briefly report what actually changed (what went where). If any item failed, report it as it is.

## Development

- When you change a feature, fix the tests in `test/` together and check with `npm test`.
- Use only Node.js built-in modules, with no external packages.

## PR merge

- Do GitHub work with the personal account `sirloinbh`. Instead of the default `gh` setup (the company account), use `GH_CONFIG_DIR="$USERPROFILE/.config/gh-personal" gh ...`, and before any remote change check that `gh api user --jq .login` is `sirloinbh`.
- After you open a PR, it goes through automatic code review up to 2 times (review → follow-up commit → second review → follow-up commit).
  1. First review: a read-only review separated from the writing context (a separate agent, a review tool, and so on) looks at correctness, regressions, security, and missing tests, based on the issue's done criteria (the PR description if there is no linked issue) and the whole PR diff.
  2. If there is nothing to follow up, end the review and go straight to the CI check and the merge.
  3. If there is something to follow up, address only the comments that should be fixed within this PR's scope. Fix the related tests together, make an extra commit, and push.
  4. Second review: check that the first comments were addressed, the extra diff, and the final whole PR diff. Address the second comments in an extra commit, and do not do a third review; go on to CI. Limit the second follow-up commit to fixes within the scope of the comments, and split fixes beyond the scope into a new issue per item 5.
  5. A fix too big for this PR (a feature outside the requested scope, a design or data structure change, a fix across several modules, work that needs separate verification) is not fixed; split it into a new issue card (with the problem, scope, and done criteria). Leave the issue link in a PR comment and keep going with this PR.
  6. If, even after splitting, a defect that breaks `main` or a defect with a security or data corruption risk remains, do not merge and tell the user.
  7. Leave the result of each review round (the comments, the commits that addressed them, the issues split off, whether there was nothing to follow up) in a PR comment.
- After the review, if all the required CI checks on the final head pass, the agents (the main agent and local workers) merge without asking the user. Before merging, check that `npm test` passes on the last commit. If a new commit appears during review, do not merge with the earlier CI result.
  - The required checks are `test (node 22)` and `test (node 24)` (`.github/workflows/ci.yml`), set in the `main` branch protection. Judge with `gh pr checks <url> --required`, and merge only when both checks exist and pass. If a check that is not required failed, tell the user before merging.
  - Check that the SHA from `gh pr view <url> --json headRefOid` is the same as the SHA CI passed on and the `git rev-parse HEAD` where you ran `npm test` locally, and merge with that SHA.
  - Merge with a merge commit: `gh pr merge <url> --merge --match-head-commit <verified head SHA>`.
  - After the merge, check that the linked issue (`Closes #N`) is closed.
  - If a check failed or is still running, do not merge. If a PR has no required CI check at all, or lacks the checks above, do not auto-merge it and tell the user.
  - Do not bypass branch protection with `--admin` and the like, approve your own PR instead of a review, commit or push directly to `main`, or force-push.
  - This repo's `main` merge does not lead to a deploy (a local tool). If a deploy appears, fix this item so that the deploy result is checked after the merge.
- Merge consecutive PRs (PRs stacked with an earlier PR's branch as the base) in order, from the bottom.
  1. After merging the earlier PR, change the next PR's base to `main` (`gh pr edit <number> --base main`).
  2. After `git fetch origin`, merge `origin/main` into the next PR branch and resolve the conflicts. Conflicts that need a judgment about the code's intent get confirmation under the conflict rule below. Do not use a rebase that needs a force push.
  3. After resolving the conflicts, make `npm test` pass, push normally, then check the same merge conditions as above (required checks, SHA match, `--match-head-commit`) and merge. Repeat to the end of the stack.
  4. For a PR whose changes are all already in `main` and that has no difference left, do not merge it; leave the reason in a comment and close it. The linked issue is not closed automatically, so check whether another merge resolved it, and if it did, close it with a comment giving the reason.
- Delete the branch of a merged PR. However, if another open PR uses that branch as its base, change that PR's base to `main` first and then delete it (do not delete it first with `--delete-branch`).
- When resolving a conflict needs a judgment about the code's intent (when the changes on both sides produce different behavior), show the resolution and get confirmation.
- When done, briefly report the merged PRs (merge SHA), the closed PRs, and the conflict files you resolved.
