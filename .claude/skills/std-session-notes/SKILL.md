---
name: std-session-notes
description: Keep progress, decisions, research results, and next steps in md files in the repository instead of relying on the chat session, the prompt cache, or automatic memory. Use before ending a session, before running /clear, when switching to another issue, and when starting a new session that must continue earlier work. Applies to every sirloinbh project repository.
---

<!-- Managed file. Edit it in sirloinbh/project-standards templates/common/skills/std-session-notes/ -->

# Keep session notes in md files

A session is not a record. A long session resends the whole conversation on every request, the cache expires, and `/clear` or a new PC or tool (Codex) starts with nothing. Anything the next session needs must be in a file in the repo, so one issue can be one session and a new session can continue by reading files.

## Where each kind of record goes

| Record | Where |
|---|---|
| What was done today and what to do next (resuming work) | `docs/daily/YYYY-MM-DD.md` (Asia/Seoul date), with a `Next steps` section |
| What an issue changed, and how it was verified | `docs/changes/<issue-number>-<slug>.md` |
| A decision with lasting effect | an ADR in `docs/adr/` if the repo has one, otherwise the issue comment plus the change record |
| A decision or answer from the user for one issue | an issue comment (link it from the change record) |
| Research results | `docs/research/<topic>.md` |
| Steps only the user can do | `docs/user-steps.md` if the repo has one, otherwise the `Next steps` section |

Do not leave these only in chat. Do not overwrite a past day's file with today's state; add a new day's file.

## Before ending a session or running /clear

Write or update the daily file so a new session can continue from it alone:

1. **Done**: what finished, with issue and PR numbers.
2. **In progress**: branch, worktree, open PR, and the exact state (for example "CI failing on X").
3. **Next steps**: the ordered next actions, and which need the user.
4. **Decisions and open questions**: what was decided (with the file or issue comment holding the details) and what is undecided.
5. **Read first**: the files a new session should open (change record, research file, issue number).

Commit the notes with the work, or in a small docs PR. Notes only in an uncommitted working tree are lost when the worktree is removed.

## Starting a session

Read the latest `docs/daily/` file and the `Read first` files before asking the user what to do. Continue from the `Next steps`. If the notes and the repo disagree, trust the repo and fix the notes.

## Automatic memory

Claude's automatic memory (`~/.claude/projects/.../memory/`) is per PC and invisible to Codex and other PCs. Do not store facts, decisions, or task state there. At most store a one-line pointer to the md file ("current next steps: `docs/daily/YYYY-MM-DD.md`"). If a memory entry holds a fact worth keeping, move it to the matching md file and leave a pointer.

## Do not record

Tokens, `.env` values, private keys, Terraform state, and backups never go into notes.
