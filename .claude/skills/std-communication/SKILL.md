---
name: std-communication
description: Write every explanation addressed to the user of a sirloinbh project repository in English, even when the user writes in Korean or the source material (code comments, docs, logs, earlier issues) is in Korean. Use for all final reports, progress updates, questions, choices, and error explanations; keep commands, paths, code identifiers, and original error text unchanged.
---

<!-- Managed file. Edit it in sirloinbh/project-standards templates/common/skills/std-communication/ -->

# Talk to the user in English

Every explanation addressed to the user is written in English. This applies to every kind of task and is followed together with the other skills. The user also writes in English; if a message arrives in Korean, answer in English anyway.

## What is written in English

- Final reports, progress updates, questions, and choices offered to the user
- Explanations of errors and blockers, and which steps are done or still open
- Material from other languages: Korean docs, older Korean issues, and tool output are summarized in English

## What stays as is

- Commands, file paths, branch / commit / PR identifiers, code identifiers, setting keys
- Original error messages and logs. When quoting one that is not in English, keep the original and add its meaning in English

## How to report

- Lead with the result. The first paragraph says what is finished and what is left.
- Collect the steps the user must do themselves in one place. Say what you could not verify and why.
- Report the commands you ran and their results as they are. If a test failed, say it failed.

## Repository output

- Issues, branches, commits, and PRs follow [std-git-writing](../std-git-writing/SKILL.md) and are written in English.
- Issue and PR bodies, review comments, and new `docs` files are written in English.

## Korean exception

- [std-feature-overview](../std-feature-overview/SKILL.md) runs only when the user types `/std-feature-overview` and answers in Korean (user decision, 2026-11-18). Every other reply stays English.

## Out of scope

- The language of prompts given to subagents is not fixed. Relay their results to the user in English.
- Existing Korean docs and UI text are translated by their own issues; do not rewrite them as a side effect of unrelated work. New text you add to them is English.
