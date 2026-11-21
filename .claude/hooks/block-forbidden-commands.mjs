// Managed file. Edit it in sirloinbh/project-standards templates/common/.claude/hooks/
// Claude Code PreToolUse hook (#450, docs/agent-guardrails.md): blocks the prohibitions in AGENTS.md that a
// tool call can show, so they hold even when a session skips permission prompts (#418).
// - Bash / PowerShell: force push, push to main, package tag push, `git add` of secret files, `pr merge --delete-branch`,
//   and remote changes through the default (company) `gh` on Windows.
// - Edit / Write / NotebookEdit: direct edits of the `.claude/skills/` copies.
// It exits 2 with the reason and the right way on stderr. Node built-ins only. It is a guard against
// mistakes, not a security boundary: commands held in variables or script files are not seen.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { isMainModule, programName, splitCommands } from './block-package-installs.mjs';

const MAX_DEPTH = 6;
const PROTECTED_BRANCHES = new Set(['main', 'master']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
// Programs that run the rest of their words as a command.
const PREFIXES = new Set(['env', 'sudo', 'nohup', 'command', 'exec', 'time', 'xargs']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
// `gh` command groups whose verbs change GitHub, and the verbs in them that only read or act locally.
const GH_GROUPS = new Set([
  'pr', 'issue', 'repo', 'release', 'workflow', 'run', 'label', 'gist', 'secret', 'variable', 'project',
  'ruleset', 'cache', 'org', 'discussion', 'attestation',
]);
const GH_READ_VERBS = new Set(['list', 'ls', 'view', 'status', 'diff', 'checks', 'watch', 'download', 'checkout', 'clone', 'verify', 'browse']);

const BRANCH_RULE = 'Work on a branch and open a PR; never push to main or rewrite pushed history (AGENTS.md).';
const TAG_RULE = 'Package tags (<package>/v<version>) are pushed only by the user; the push publishes the package (AGENTS.md).';
const SECRET_RULE = '.env values, tokens, private keys, Terraform state, and backups are never committed (AGENTS.md). Commit .env.example instead.';
const GH_RULE = 'The default gh is the company account. Use the personal wrapper instead: `ghp ...` or `& "$env:LOCALAPPDATA\\sirloinbh-tools\\gh-project.ps1" ...` (docs/tools.md).';
const MERGE_RULE = 'Merge without --delete-branch. The repo setting deletes the remote branch; delete the local one with `git branch --delete` (std-git-writing).';
const SKILL_RULE = '.claude/skills/ holds copies. Edit the source (skills/ in app repos, templates/common/skills/ in project-standards; std-* skills only in project-standards) and copy it with `npm run skills:sync` or the same PR.';

/** True when a path names a file that must never be committed. `.env.example` and friends are fine. */
export function isSecretPath(file) {
  const base = file.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (/^\.env(\..+)?$/.test(base)) return !/\.(example|sample|template|defaults)$/.test(base);
  return /\.tfstate(\.backup)?$/.test(base) || /\.(pem|p12|pfx|dump)$/.test(base) || /private[-_.]?key/.test(base);
}

const isOption = (word) => /^-/.test(word);

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    return '';
  }
}

/** The branch a push refspec writes to: `HEAD:main` -> main, `refs/heads/main` -> main, `+x` -> x. */
function pushTarget(refspec, branch) {
  let target = refspec.replace(/^\+/, '');
  if (target.includes(':')) target = target.slice(target.indexOf(':') + 1);
  if (target === 'HEAD' || target === '@') target = branch;
  return target.replace(/^refs\/heads\//, '');
}

function checkPush(args, cwd) {
  const branch = () => currentBranch(cwd);
  const options = args.filter(isOption);
  if (options.some((o) => /^--(force|force-with-lease|force-if-includes)(=|$)/.test(o) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(o))) return `force push: ${BRANCH_RULE}`;
  if (options.some((o) => /^--(all|mirror|branches)$/.test(o))) return `push of every branch, main included: ${BRANCH_RULE}`;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(args[i])) i++;
    else if (!isOption(args[i])) positional.push(args[i]);
  }
  const refspecs = positional.slice(1);
  if (refspecs.some((r) => r.startsWith('+'))) return `force push: ${BRANCH_RULE}`;
  if (options.some((o) => /^--(tags|follow-tags)$/.test(o)) || refspecs.some((r) => /^(refs\/tags\/)?[a-z0-9][a-z0-9-]*\/v\d+\.\d+\.\d+/.test(r.split(':').pop()))) return `tag push: ${TAG_RULE}`;
  if (!refspecs.length) {
    const current = branch();
    return PROTECTED_BRANCHES.has(current) ? `push while on ${current}: ${BRANCH_RULE}` : null;
  }
  const needsBranch = refspecs.some((r) => /(^|:)(HEAD|@)$/.test(r.replace(/^\+/, '')));
  const current = needsBranch ? branch() : '';
  const hit = refspecs.map((r) => pushTarget(r, current)).find((t) => PROTECTED_BRANCHES.has(t));
  return hit ? `push to ${hit}: ${BRANCH_RULE}` : null;
}

function checkGit(args, cwd) {
  let i = 0;
  let dir = cwd;
  while (i < args.length && isOption(args[i])) {
    if (args[i] === '-C') dir = path.resolve(dir ?? '.', args[i + 1] ?? '');
    i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'push') return checkPush(rest, dir);
  if (sub === 'add' || sub === 'stage') {
    const secret = rest.filter((a) => !isOption(a)).find(isSecretPath);
    return secret ? `git add ${secret}: ${SECRET_RULE}` : null;
  }
  return null;
}

/** Remote changes through plain `gh`, which is the company account on these Windows PCs. */
function checkGh(args, env) {
  if (/gh-personal/i.test(env.GH_CONFIG_DIR ?? '')) return null;
  const words = args.filter((a) => !isOption(a));
  const [group, verb] = words;
  let changes = false;
  if (group === 'api') {
    // gh api sends POST when fields are given; GraphQL reads are POST too, so only a mutation counts there.
    const at = args.findIndex((a) => /^(-X|--method)$/.test(a));
    const method = (at === -1 ? args.find((a) => /^(-X|--method=)./.test(a))?.replace(/^(-X|--method=)/, '') : args[at + 1])?.toUpperCase();
    if (verb === 'graphql') changes = args.some((a) => /\bmutation\b/.test(a));
    else if (method) changes = method !== 'GET';
    else changes = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
  } else if (GH_GROUPS.has(group)) {
    changes = Boolean(verb) && !GH_READ_VERBS.has(verb);
  }
  return changes ? `default gh ${[group, verb].filter(Boolean).join(' ')}: ${GH_RULE}` : null;
}

function checkMerge(words) {
  const at = words.findIndex((w, i) => w === 'pr' && words[i + 1] === 'merge');
  if (at === -1) return null;
  const flags = words.slice(at + 2);
  return flags.some((f) => /^(-d|--delete-branch(=true)?)$/.test(f)) ? `pr merge --delete-branch: ${MERGE_RULE}` : null;
}

function checkWords(words, ctx, depth) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  const assigned = Object.fromEntries(words.slice(0, i).map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]));
  const env = { ...ctx.env, ...assigned };
  const program = programName(words[i] ?? '');
  const args = words.slice(i + 1);
  const merge = checkMerge(words);
  if (merge) return merge;
  if (!program) return null;
  if (PREFIXES.has(program)) {
    let j = 0;
    while (j < args.length && (isOption(args[j]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[j]) || /^\d+$/.test(args[j]))) j++;
    return checkWords(args.slice(j), { ...ctx, env }, depth);
  }
  if (program === 'timeout') return checkWords(args.slice(args.findIndex((a) => !isOption(a)) + 1), { ...ctx, env }, depth);
  if (SHELLS.has(program)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    return c === -1 ? null : scan(args[c + 1] ?? '', ctx, depth + 1);
  }
  if (POWERSHELLS.has(program)) {
    const c = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return c === -1 ? null : scan(args.slice(c + 1).join(' '), ctx, depth + 1);
  }
  if (program === 'cmd') {
    const c = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return c === -1 ? null : scan(args.slice(c + 1).join(' '), ctx, depth + 1);
  }
  if (['eval', 'iex', 'invoke-expression'].includes(program)) return scan(args.join(' '), ctx, depth + 1);
  if (program === 'git') return checkGit(args, ctx.cwd);
  if (program === 'gh' && ctx.platform === 'win32') return checkGh(args, env);
  return null;
}

function scan(command, ctx, depth) {
  if (depth > MAX_DEPTH) return null;
  for (const words of splitCommands(command)) {
    const found = checkWords(words, ctx, depth);
    if (found) return found;
  }
  return null;
}

/** Why a Bash or PowerShell command line is blocked, or null when it may run. */
export function findForbiddenCommand(command, { cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  return scan(command, { cwd, env, platform }, 0);
}

/** Why an edit of this file is blocked, or null. Only files inside the project count. */
export function findForbiddenEdit(file, projectDir) {
  if (!file || !projectDir) return null;
  const relative = path.relative(path.resolve(projectDir), path.resolve(projectDir, file)).replace(/\\/g, '/');
  return /^\.claude\/skills\//i.test(relative) ? `edit of ${relative}: ${SKILL_RULE}` : null;
}

/** Reads one PreToolUse event from stdin and exits 2 (reason on stderr) to block it. */
export async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.stderr.write('The forbidden-command hook could not read its input, so the call was blocked.\n');
    process.exit(2);
  }
  const tool = event?.tool_name;
  const input_ = event?.tool_input ?? {};
  let found = null;
  if (['Bash', 'PowerShell'].includes(tool) && typeof input_.command === 'string') {
    found = findForbiddenCommand(input_.command, { cwd: event.cwd || process.cwd() });
  } else if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) {
    found = findForbiddenEdit(input_.file_path ?? input_.notebook_path, process.env.CLAUDE_PROJECT_DIR || event.cwd);
  }
  if (!found) process.exit(0);
  process.stderr.write(`Blocked by .claude/hooks/block-forbidden-commands.mjs (${found}) Details: docs/agent-guardrails.md in sirloinbh/project-standards.\n`);
  process.exit(2);
}

if (isMainModule(process.argv[1], import.meta.url)) await main();
