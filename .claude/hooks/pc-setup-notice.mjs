// Managed file. Edit it in sirloinbh/project-standards templates/common/.claude/hooks/
// Claude Code SessionStart hook (#368, docs/agent-guardrails.md): this PC's global instructions
// live outside every repository, so `git pull` cannot update them. While they still hold the old
// Fork branch rule, tell the user how to apply the current rule. It prints nothing once applied.
// Node built-ins only. It only reads, and any error ends quietly so a session is never blocked.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const FILES = [path.join('.claude', 'CLAUDE.md'), path.join('.codex', 'AGENTS.md')];
const STEPS = 'In the project-standards folder, run git switch main, git pull --ff-only, powershell -NoProfile -ExecutionPolicy Bypass -File tools\\install.ps1, and node tools\\check-git-permissions.mjs, in that order (docs/user-steps.md chapter 16, #361).';

function hasForkRule(file) {
  try {
    return /^## .*Fork/m.test(readFileSync(path.join(homedir(), file), 'utf8'));
  } catch {
    return false;
  }
}

try {
  const stale = FILES.filter(hasForkRule).map((file) => `~/${file.replaceAll('\\', '/')}`);
  if (stale.length > 0) {
    const notice = `The git CLI branch rules are not yet applied on this PC (the Fork rule is still in ${stale.join(', ')}). ${STEPS}`;
    const additionalContext = `${notice} Before starting other work, tell the user this, and follow this repo's std-git-writing skill over the Fork rule in the global instructions.`;
    console.log(JSON.stringify({ systemMessage: notice, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  }
} catch {
  // Never block a session over a reminder.
}
