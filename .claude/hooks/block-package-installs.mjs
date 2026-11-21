// Managed file. Edit it in sirloinbh/project-standards templates/common/.claude/hooks/
// Claude Code and Codex PreToolUse hook (#162, #180, docs/agent-guardrails.md): reads the Bash
// or PowerShell command, splits it into simple commands, and exits 2 (block) when one of them
// installs, removes, or runs packages. It complements the Claude Code permissions.deny prefix
// rules and the Codex rules, which miss `npm --silent install`, `sh -c "npm i"`, and full paths
// such as `C:\nodejs\npm.cmd install`.
// Node built-ins only. It is a guard against mistakes, not a security boundary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The npm commands this hook acts on, with their aliases (npm 11). Matching is exact: abbreviations such as `npm upd`,
// camelCase names, and typo aliases are not resolved, because the hook only guards against mistakes (#703).
const NPM_COMMANDS = {
  install: 'install', i: 'install', add: 'install', in: 'install', ins: 'install', inst: 'install', insta: 'install', instal: 'install',
  ci: 'ci', 'clean-install': 'ci', ic: 'ci', 'install-clean': 'ci',
  'install-test': 'install-test', it: 'install-test', 'install-ci-test': 'install-ci-test', cit: 'install-ci-test', 'clean-install-test': 'install-ci-test', sit: 'install-ci-test',
  update: 'update', up: 'update', upgrade: 'update', u: 'update',
  uninstall: 'uninstall', un: 'uninstall', remove: 'uninstall', rm: 'uninstall', r: 'uninstall', unlink: 'uninstall',
  exec: 'exec', x: 'exec', init: 'init', create: 'init', innit: 'init', rebuild: 'rebuild', rb: 'rebuild',
  dedupe: 'dedupe', ddp: 'dedupe', link: 'link', ln: 'link', audit: 'audit',
};
// npm commands that install, remove, or run packages (`audit` only with `fix`). `ci` installs exactly what
// the lockfile pins (#375), and `install` (with its aliases) adds or changes packages (#629, user decision
// 2026-11-18). Both stay allowed unless an option turns install scripts on.
const NPM_BLOCKED = new Set(['install-test', 'install-ci-test', 'update', 'uninstall', 'exec', 'init', 'rebuild', 'dedupe', 'link']);
// Other package managers and runners are not used in these repositories: every call is blocked.
const RUNNERS = new Set(['npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bun', 'bunx', 'corepack']);
// npm options whose value is the next word, e.g. `npm -w app install`.
const NPM_VALUE_OPTIONS = new Set(['-w', '--workspace', '--prefix', '-C', '--loglevel', '--registry', '--cache', '--userconfig', '--globalconfig', '--tag', '--otp', '--scope', '--before', '--omit', '--include', '--install-strategy', '--script-shell', '--location', '-L', '--access', '--color']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell', 'powershell_ise']);
const MAX_DEPTH = 6;

/** The npm command a word names, or undefined when it is not one this hook acts on. */
export function npmCommand(word) {
  return Object.hasOwn(NPM_COMMANDS, word) ? NPM_COMMANDS[word] : undefined;
}

/**
 * Splits a Bash or PowerShell command into simple commands (arrays of words, quotes removed).
 * It understands both shells only as far as needed here: quotes, separators, comments,
 * here-documents and here-strings. Backslashes outside quotes are kept so Windows paths survive.
 */
export function splitCommands(text) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const pendingHeredocs = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') {
      endCommand();
      i++;
      // Skip the bodies of here-documents started on this line.
      for (const { delimiter, strip } of pendingHeredocs.splice(0)) {
        while (i < text.length) {
          const end = text.indexOf('\n', i);
          const line = text.slice(i, end === -1 ? text.length : end);
          i = end === -1 ? text.length : end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === delimiter) break;
        }
      }
      continue;
    }
    if (ch === "'" || (ch === '$' && next === "'")) {
      if (ch === '$') i++;
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end === -1 ? text.length : end);
      inWord = true;
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if ((text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) || (text[i] === '`' && i + 1 < text.length)) i++;
        word += text[i];
        i++;
      }
      inWord = true;
      i++;
      continue;
    }
    // PowerShell here-strings: @' ... '@ and @" ... "@ (the closing mark starts a line).
    if (ch === '@' && (next === "'" || next === '"') && /^[ \t]*\r?\n/.test(text.slice(i + 2))) {
      const close = text.indexOf(`\n${next}@`, i + 2);
      word += text.slice(text.indexOf('\n', i) + 1, close === -1 ? text.length : close);
      inWord = true;
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    if (ch === '#' && !inWord) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '<' && next === '<' && text[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      const strip = text[j] === '-';
      if (strip) j++;
      while (text[j] === ' ' || text[j] === '\t') j++;
      const match = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(text.slice(j));
      if (match) {
        pendingHeredocs.push({ delimiter: match[2], strip });
        i = j + match[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '$' && next === '(') {
      endCommand();
      i += 2;
      continue;
    }
    if (';&|(){}`<>\r'.includes(ch)) {
      endCommand();
      i++;
      continue;
    }
    if (ch === '\\' && (next === ' ' || next === '\t')) {
      word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  endCommand();
  return commands;
}

/** Lower-case program name without directory or Windows extension: `C:\nodejs\NPM.cmd` -> `npm`. */
export function programName(word) {
  const base = word.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(cmd|exe|ps1|bat|com)$/, '');
}

const isOption = (word) => /^-/.test(word);
const isAssignment = (word) => /^[A-Za-z_][A-Za-z0-9_-]*=/.test(word);

// Skips leading options; `withValue` lists options whose value is the next word.
function skipOptions(args, withValue = []) {
  let i = 0;
  while (i < args.length && isOption(args[i])) {
    if (args[i] === '--') return i + 1;
    if (withValue.includes(args[i])) i++;
    i++;
  }
  return i;
}

const LOCKFILE_INSTALL = 'npm ci';
const WITH_SCRIPTS = 'npm ci with install scripts';
// npm settings that undo .npmrc's ignore-scripts=true, as environment variables, however a shell sets them
// (`X=false`, `$env:X = "false"`, `Set-Item Env:X false`, `SetEnvironmentVariable('X','false')`). Names ignore case.
const SCRIPTS_ENV = /npm_config_(ignore[-_]scripts[\s'"},=]*(false|0|null|undefined)(?![\w-])|allow[-_]scripts\s*=|dangerously[-_]allow[-_]all[-_]scripts\s*=)/i;

// The same settings as options. npm also accepts any number of dashes, unambiguous prefixes, and repeated `no-` in any case.
function turnsScriptsOn(args) {
  return args.some((arg, i) => {
    if (!arg.startsWith('-')) return false;
    const [written, writtenValue] = arg.replace(/^-+/, '').split('=');
    let name = written;
    let negated = false;
    while (/^no-/i.test(name)) {
      name = name.slice(3);
      negated = !negated;
    }
    // Long enough not to catch other options such as `--all` or `-d`.
    if ((name.length >= 6 && 'allow-scripts'.startsWith(name)) || (name.length >= 3 && 'dangerously-allow-all-scripts'.startsWith(name))) return !negated;
    if (!name || !'ignore-scripts'.startsWith(name)) return false;
    const value = writtenValue ?? (args[i + 1] === 'false' ? 'false' : 'true');
    return (value === 'false') !== negated;
  });
}

function checkNpm(args, viaXargs) {
  // `--` before the command only ends the options: `npm -- install` still installs (#381).
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    if (!optionsEnded && args[i] === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && isOption(args[i])) {
      if (NPM_VALUE_OPTIONS.has(args[i])) i++;
      continue;
    }
    const command = npmCommand(args[i]);
    // The first word that is not an option decides. A word the hook does not act on (`run`, `test`, `ls`) allows the call.
    if (!command) return null;
    if (command === 'audit') return args.slice(i + 1).includes('fix') ? 'npm audit fix' : null;
    if (command === 'ci' || command === 'install') return turnsScriptsOn(args) ? WITH_SCRIPTS : LOCKFILE_INSTALL;
    return NPM_BLOCKED.has(command) ? `npm ${command}` : null;
  }
  // `xargs npm` takes the subcommand from its input, so the hook cannot see it.
  return viaXargs ? 'xargs npm' : null;
}

function powershellCommand(args) {
  const valueOptions = ['executionpolicy', 'ep', 'ex', 'workingdirectory', 'wd', 'windowstyle', 'w', 'outputformat', 'of', 'o', 'inputformat', 'if', 'configurationname', 'config', 'settingsfile', 'custompipename', 'psconsolefile', 'version', 'v'];
  for (let i = 0; i < args.length; i++) {
    const option = /^[-/]/.test(args[i]) ? args[i].slice(1).toLowerCase() : null;
    if (option === null) return args.slice(i).join(' ');
    if (option.startsWith('c') && 'command'.startsWith(option)) return args.slice(i + 1).join(' ');
    if (option === 'e' || option === 'ec' || (option.startsWith('en') && 'encodedcommand'.startsWith(option))) {
      try {
        return Buffer.from(args[i + 1] ?? '', 'base64').toString('utf16le');
      } catch {
        return '';
      }
    }
    if (option.startsWith('f') && 'file'.startsWith(option)) return '';
    if (valueOptions.includes(option) || valueOptions.some((name) => name.length > 3 && option.length >= 3 && name.startsWith(option))) i++;
  }
  return '';
}

function startProcess(args) {
  let file = '';
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (isOption(args[i])) {
      const option = args[i].slice(1).toLowerCase();
      if (option.length >= 2 && 'filepath'.startsWith(option)) file = args[++i] ?? '';
      else if ('argumentlist'.startsWith(option) || option === 'args' || option === 'al') rest.push(args[++i] ?? '');
      else if (!['wait', 'nonewwindow', 'passthru', 'usenewenvironment', 'loaduserprofile', 'nnw'].includes(option)) i++;
    } else if (!file) file = args[i];
    else rest.push(args[i]);
  }
  return file ? [file, ...rest.flatMap((arg) => arg.split(/[\s,]+/)).filter(Boolean)] : [];
}

/** Returns what was blocked (e.g. `npm install`) for one simple command, or null. */
function checkWords(words, depth, viaXargs = false) {
  let i = 0;
  while (i < words.length && isAssignment(words[i])) i++;
  if (i >= words.length) return null;
  const name = programName(words[i]);
  const unescaped = programName(words[i].replace(/\\/g, ''));
  const args = words.slice(i + 1);
  const program = [name, unescaped].find((n) => n === 'npm' || RUNNERS.has(n)) ?? name;

  if (program === 'npm') return checkNpm(args, viaXargs);
  if (RUNNERS.has(program)) return program;

  const nested = (command) => (command ? scan(command, depth + 1) : null);
  const wrapped = (rest, xargs = viaXargs) => checkWords(rest, depth, xargs);

  switch (program) {
    case 'env': {
      let j = 0;
      while (j < args.length && (isOption(args[j]) || isAssignment(args[j]))) {
        if (['-S', '--split-string'].includes(args[j])) return nested(args.slice(j + 1).join(' '));
        if (args[j] === '--') { j++; break; }
        if (['-u', '--unset', '-C', '--chdir'].includes(args[j])) j++;
        j++;
      }
      return wrapped(args.slice(j));
    }
    case 'sudo':
    case 'doas':
      return wrapped(args.slice(skipOptions(args, ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U'])));
    case 'timeout': {
      const j = skipOptions(args, ['-s', '--signal', '-k', '--kill-after']);
      return wrapped(args.slice(j + 1));
    }
    case 'nice':
    case 'ionice':
    case 'stdbuf':
      return wrapped(args.slice(skipOptions(args, ['-n', '--adjustment', '-c', '-i', '-o', '-e'])));
    case 'nohup':
    case 'time':
    case 'exec':
    case 'setsid':
    case 'builtin':
    case 'call':
    case 'cross-env':
    case 'cross-env-shell': {
      let j = skipOptions(args);
      while (j < args.length && isAssignment(args[j])) j++;
      return wrapped(args.slice(j));
    }
    case 'command':
      // `command -v npm` only looks the program up.
      return args.some((arg) => /^-[a-zA-Z]*[vV]/.test(arg)) ? null : wrapped(args.slice(skipOptions(args)));
    case 'xargs':
      return wrapped(args.slice(skipOptions(args, ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs'])), true);
    case 'volta':
      return args[0] === 'run' ? wrapped(args.slice(1 + skipOptions(args.slice(1), ['--node', '--npm', '--pnpm', '--yarn', '--env']))) : null;
    case 'wsl':
      return wrapped(args.slice(skipOptions(args, ['-d', '--distribution', '-u', '--user', '--cd'])));
    case 'node': {
      const j = skipOptions(args, ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type']);
      if (args.slice(0, j).some((arg) => /^(-e|-p|--eval|--print)$/.test(arg))) return null;
      const script = programName(args[j] ?? '');
      if (script === 'npm-cli.js') return checkNpm(args.slice(j + 1), viaXargs);
      if (script === 'npx-cli.js') return 'npx';
      return null;
    }
    case 'cmd': {
      const j = args.findIndex((arg) => /^\/[ckr]$/i.test(arg));
      return j === -1 ? null : nested(args.slice(j + 1).join(' '));
    }
    case 'eval':
    case 'iex':
    case 'invoke-expression':
      return nested(args.filter((arg) => !/^-command$/i.test(arg)).join(' '));
    case 'start-process':
    case 'saps':
    case 'start':
      return wrapped(startProcess(args));
    default:
      break;
  }
  if (SHELLS.has(program) || program === 'busybox') {
    const j = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
    return j === -1 ? null : nested(args[j + 1]);
  }
  if (POWERSHELLS.has(program)) return nested(powershellCommand(args));
  return null;
}

// The first blocked command, else `npm ci` when one runs, else null. A later command can still be blocked,
// so `npm ci` does not end the search.
function scan(command, depth) {
  if (depth > MAX_DEPTH) return null;
  const commands = splitCommands(command);
  let lockfileInstall = false;
  for (const words of commands) {
    const found = checkWords(words, depth);
    if (found === LOCKFILE_INSTALL) lockfileInstall = true;
    else if (found) return found;
  }
  if (!lockfileInstall) return null;
  return SCRIPTS_ENV.test(commands.flat().join(' ')) ? WITH_SCRIPTS : LOCKFILE_INSTALL;
}

/** Returns what was blocked in a full Bash or PowerShell command line, or null when it may run. */
export function findInstall(command) {
  const found = scan(command, 0);
  return found === LOCKFILE_INSTALL ? null : found;
}

/** Like findInstall, but `npm ci` counts too: tools that run a command in many repositories refuse it. */
export function findAnyInstall(command) {
  return scan(command, 0);
}

/**
 * Reads one PreToolUse event from stdin and exits 2 (reason on stderr) to block it.
 * Claude Code sends `Bash` or `PowerShell`; Codex sends `Bash` for every shell command,
 * also on Windows where the command is PowerShell (#180). Both use `tool_input.command`.
 */
export async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.stderr.write('The package install blocking hook could not read its input, so it blocked the command.\n');
    process.exit(2);
  }
  const command = event?.tool_input?.command;
  if (!['Bash', 'PowerShell'].includes(event?.tool_name) || typeof command !== 'string') process.exit(0);
  const found = findInstall(command);
  if (!found) process.exit(0);
  process.stderr.write(
    `Blocked because this is a package install, remove, or run command (${found}). Agents may run npm ci and npm install (with install scripts off), not update, uninstall, exec, or npx. ` +
      'If this is needed, ask the user. Details: docs/agent-guardrails.md (sirloinbh/project-standards)\n',
  );
  process.exit(2);
}

// Claude Code runs this file (`node <this file>`). Codex imports it and calls main() from
// `node -e` in .codex/hooks.json, because Codex has no project-directory placeholder (#180).
// Tests import the functions above.
/**
 * True when Node runs this file directly. Node loads the main module from its real path, while
 * Claude Code may start it through a junction or symlink (Orca's profile plugins folder, a repo
 * opened through a link), so compare real paths. A plain path compare made the hook exit 0
 * without reading the event (#526).
 */
export function isMainModule(argv1, moduleUrl) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(argv1).toLowerCase() === real(fileURLToPath(moduleUrl)).toLowerCase();
}

if (isMainModule(process.argv[1], import.meta.url)) await main();
