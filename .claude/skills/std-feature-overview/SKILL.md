---
name: std-feature-overview
description: Explain what a sirloinbh project repository does and recommend features worth adding, written in Korean. Runs only when the user types /std-feature-overview; read-only, never starts on its own.
disable-model-invocation: true
---

<!-- Managed file. Edit it in sirloinbh/project-standards templates/common/skills/std-feature-overview/ -->

# Feature overview (Korean)

The user runs `/std-feature-overview` (optionally `/std-feature-overview <repo>` for a multi-repo project) to get two things in one answer: a detailed explanation of the features, and recommendations for new ones. This skill is the Korean exception to [std-communication](../std-communication/SKILL.md) (user decision, 2026-11-18): write the whole answer in Korean, but keep code, paths, commands, and identifiers as they are.

## Rules

- Read-only: do not create an issue, branch, commit, or file.
- Run it only when the user types the command, not for an ordinary question.

## Part 1: Features

1. Read `README.md`, `AGENTS.md`, `AGENTS.project.md` (if present), the source tree, routes or commands, and configuration. With an argument, scope this to that repo or project.
2. Describe each feature: what it does, where it lives (`path:line`), and how it is used or deployed.

## Part 2: Recommended features

1. Check the repo's open issues first (`gh issue list --state open`, with the `ghp` wrapper from AGENTS.md).
2. List 3 to 7 ideas. For each: why it helps, rough size (S / M / L), and what it depends on.
3. If an open issue already covers an idea, mark it with the issue number instead of repeating it.

## Ending

Offer to register the ideas the user picks as issues with [std-backlog](../std-backlog/SKILL.md). Register them only when the user says so, and write those issues in English as [std-git-writing](../std-git-writing/SKILL.md) says.
