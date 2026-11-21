// Managed file. Edit it in sirloinbh/project-standards scripts/
// Scans a repository for npm supply-chain attack indicators (Shai-Hulud family):
// blocked packages in lockfiles, install scripts that call exfiltration hosts or run
// dropped files, and suspicious GitHub workflows. Read-only; it never runs package code.
// Copied into project repositories as .standards/ioc-scan.mjs with .standards/blocked-packages.json.
// Usage: node .standards/ioc-scan.mjs [--root <repository>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.local', 'dist', '.terraform']);

export function loadRules(here = path.dirname(fileURLToPath(import.meta.url))) {
  for (const candidate of [path.join(here, 'blocked-packages.json'), path.join(here, '../security/blocked-packages.json')]) {
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  }
  throw new Error('Could not find blocked-packages.json');
}

// Repository files named `name`, skipping installed dependencies and build output.
function findFiles(root, name, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findFiles(root, name, path.join(dir, entry.name), out);
    } else if (entry.name === name) out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
  }
  return out;
}

const packageNameOf = (lockKey) => lockKey.slice(lockKey.lastIndexOf('node_modules/') + 'node_modules/'.length);

function scriptFindings(where, scripts, rules) {
  const findings = [];
  for (const name of INSTALL_SCRIPTS) {
    const command = scripts?.[name];
    if (!command) continue;
    const host = rules.exfiltrationHosts.find((h) => command.includes(h));
    if (host) findings.push(`${where}: ${name} script calls a suspected exfiltration address (${host}): ${command}`);
    const dropped = rules.suspiciousInstallFiles.find((f) => new RegExp(`\\b${f.replace('.', '\\.')}\\b`).test(command));
    if (dropped) findings.push(`${where}: ${name} script runs a suspicious file (${dropped}): ${command}`);
  }
  return findings;
}

// Every node_modules folder in the repository (the root one and each workspace's), not those inside packages.
function findModulesDirs(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules') out.push(path.join(dir, entry.name));
    else if (!SKIP_DIRS.has(entry.name)) findModulesDirs(root, path.join(dir, entry.name), out);
  }
  return out;
}

// Reads the install scripts of the packages in one node_modules folder, and of their own nested node_modules.
function scanInstalled(root, modules, rules, errors, warnings) {
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirs = entry.name.startsWith('@') ? fs.readdirSync(path.join(modules, entry.name)).map((n) => `${entry.name}/${n}`) : [entry.name];
    for (const dir of dirs) {
      const where = path.relative(root, path.join(modules, dir)).split(path.sep).join('/');
      const manifest = path.join(modules, dir, 'package.json');
      if (fs.existsSync(manifest)) {
        try {
          errors.push(...scriptFindings(where, JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts, rules));
        } catch {
          warnings.push(`${where}/package.json could not be read`);
        }
      }
      const nested = path.join(modules, dir, 'node_modules');
      if (fs.existsSync(nested)) scanInstalled(root, nested, rules, errors, warnings);
    }
  }
}

/** Returns { errors, warnings } as human-readable strings. */
export function scan(root, rules = loadRules()) {
  const errors = [];
  const warnings = [];
  const blocked = new Map(rules.packages.map((p) => [p.name, p.reason]));

  for (const lockfile of findFiles(root, 'package-lock.json')) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
    const withScripts = [];
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (!key.includes('node_modules/')) continue;
      const name = packageNameOf(key);
      const scope = rules.scopes.find((s) => name.startsWith(`${s.scope}/`));
      if (blocked.has(name)) errors.push(`${lockfile}: package reported as compromised ${name}@${entry.version} — ${blocked.get(name)}`);
      else if (scope) errors.push(`${lockfile}: package in a scope reported as compromised ${name}@${entry.version} — ${scope.reason}`);
      if (entry.hasInstallScript) withScripts.push(`${name}@${entry.version}`);
    }
    if (withScripts.length) warnings.push(`${lockfile}: ${withScripts.length} dependencies have install scripts (they do not run with --ignore-scripts): ${[...new Set(withScripts)].join(', ')}`);
  }

  for (const file of findFiles(root, 'package.json')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    errors.push(...scriptFindings(file, pkg.scripts, rules));
  }

  // Installed packages: only their install scripts are read, never executed. Every node_modules folder counts: a
  // package npm could not hoist lands in a workspace's own node_modules (#864).
  for (const modules of findModulesDirs(root)) scanInstalled(root, modules, rules, errors, warnings);

  const workflows = path.join(root, '.github/workflows');
  if (fs.existsSync(workflows)) {
    for (const { name } of fs.readdirSync(workflows, { withFileTypes: true }).filter((e) => e.isFile())) {
      const file = `.github/workflows/${name}`;
      if (rules.suspiciousWorkflowNames.some((s) => name.toLowerCase().includes(s))) errors.push(`${file}: workflow has the same name as a known compromise`);
      const text = fs.readFileSync(path.join(workflows, name), 'utf8');
      const host = rules.exfiltrationHosts.find((h) => text.includes(h));
      if (host) errors.push(`${file}: contains a suspected exfiltration address (${host})`);
    }
  }
  return { errors, warnings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const flag = process.argv.indexOf('--root');
  const root = flag > 0 ? path.resolve(process.argv[flag + 1]) : path.basename(here) === '.standards' ? path.dirname(here) : process.cwd();
  try {
    const { errors, warnings } = scan(root);
    for (const w of warnings) console.log(`warning: ${w}`);
    for (const e of errors) console.error(`✗ ${e}`);
    if (errors.length) {
      console.error(`\nioc-scan: ${errors.length} suspicious item(s). Stop installing and running, tell the user, and check.`);
      process.exit(1);
    }
    console.log('ioc-scan: no suspicious items');
  } catch (error) {
    console.error(`ioc-scan: ${error.message}`);
    process.exit(2);
  }
}
