// Managed file. Edit it in sirloinbh/project-standards scripts/
// Checks a project repository against the central standard recorded in .standards/manifest.json.
// Copied into each repository as .standards/check.mjs (with .standards/lib/), so it uses only
// Node built-ins and its sibling lib/ files.
// Usage: node .standards/check.mjs [--root <repository>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvExample, ssmProblems } from './lib/env-tags.mjs';
import { checkManifest, MANIFEST_PATH } from './lib/manifest.mjs';

const CENTRAL = 'sirloinbh/project-standards';
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

const REASONS = {
  missing: 'file is missing',
  changed: 'content differs from the central source',
  'central section changed': 'the central section above `# --- project ---` changed',
  'project marker removed': 'the `# --- project ---` line was removed',
  'not valid JSON': 'not valid JSON',
};
const reasonText = (reason) => REASONS[reason] ?? reason.replace(/^field\(s\) changed: /, 'managed fields differ: ');

// Where each registry value appears in an app repository. A file that does not exist is skipped;
// a file that exists but no longer contains the pattern is reported as a warning.
export function portRules({ ports, db, host = null }) {
  return [
    // The server proxy forwards <subdomain>.<domain> to this nginx (#254). Manifests synced before #254 have no host.
    ...(host ? [{ file: 'frontend/nginx.conf', label: 'server_name', pattern: /^\s*server_name\s+([^\s;]+)/gm, expected: host }] : []),
    { file: 'compose.yaml', label: 'web port', pattern: /(\d{4,5})\}?:80\b/g, expected: ports.web },
    { file: 'compose.yaml', label: 'host DB port', pattern: /(\d{4,5})\}?:5432\b/g, expected: ports.db },
    { file: 'compose.yaml', label: 'API port', pattern: /\bPORT:\s*['"]?(\d{4,5})/g, expected: ports.api },
    { file: 'frontend/vite.config.ts', label: 'Vite port', pattern: /\bport:\s*(\d{4,5})/g, expected: ports.vite },
    { file: 'frontend/vite.config.ts', label: 'API proxy port', pattern: /127\.0\.0\.1:(\d{4,5})/g, expected: ports.api },
    { file: 'frontend/nginx.conf', label: 'API proxy port', pattern: /proxy_pass\s+http:\/\/api:(\d{4,5})/g, expected: ports.api },
    { file: 'backend/Dockerfile', label: 'API port (EXPOSE)', pattern: /^EXPOSE\s+(\d{4,5})/gm, expected: ports.api },
    { file: 'backend/src/server.ts', label: 'API default port', pattern: /PORT\s*\?\?\s*(\d{4,5})/g, expected: ports.api },
    { file: '.env.example', label: 'API port', pattern: /^PORT=(\d{4,5})/gm, expected: ports.api },
    { file: '.env.example', label: 'DB port', pattern: /^DATABASE_URL=.*@localhost:(\d{4,5})\//gm, expected: ports.db },
    { file: '.env.example', label: 'DB name', pattern: /^POSTGRES_DB=(\S+)/gm, expected: db.name },
    { file: '.env.example', label: 'DB name in DATABASE_URL', pattern: /^DATABASE_URL=.*\/([a-z0-9_]+)\s*$/gm, expected: db.name },
    { file: 'playwright.config.ts', label: 'e2e API port', contains: ports.e2eApi },
    { file: 'playwright.config.ts', label: 'e2e web port', contains: ports.e2eWeb },
  ];
}

function checkRegistry(registry, read, problems, warnings) {
  for (const rule of portRules(registry)) {
    const text = read(rule.file);
    if (text === null) continue;
    if (rule.contains !== undefined) {
      if (!new RegExp(`\\b${rule.contains}\\b`).test(text)) problems.push({ group: 'registry value', path: rule.file, message: `${rule.label} ${rule.contains} is missing` });
      continue;
    }
    const found = [...text.matchAll(rule.pattern)].map((m) => m[1]);
    if (!found.length) {
      warnings.push(`${rule.file}: ${rule.label} not found. If the format changed, update the central check rule.`);
      continue;
    }
    for (const value of new Set(found)) {
      if (value !== String(rule.expected)) problems.push({ group: 'registry value', path: rule.file, message: `${rule.label} is ${value}. The registry value is ${rule.expected}` });
    }
  }
  const vite = read('frontend/vite.config.ts');
  if (vite !== null && !/strictPort:\s*true/.test(vite)) warnings.push('frontend/vite.config.ts: strictPort: true is missing, so Vite moves to another port when the port is taken.');
}

// The managed Dockerfiles read the package token from the BuildKit secret "npm_token", so every
// compose build must pass it and the secret must come from NODE_AUTH_TOKEN (design.md 5.1).
export function checkComposeSecrets(text) {
  const problems = [];
  const builds = (text.match(/^\s+build:/gm) ?? []).length;
  const passed = (text.match(/secrets:\s*\[\s*npm_token\s*\]/g) ?? []).length + (text.match(/secrets:\s*\n\s+-\s*npm_token\b/g) ?? []).length;
  if (!/^secrets:\s*\n\s+npm_token:\s*\n\s+environment:\s*['"]?NODE_AUTH_TOKEN['"]?\s*$/m.test(text)) problems.push('top-level secrets.npm_token.environment: NODE_AUTH_TOKEN is missing');
  if (passed < builds) problems.push(`only ${passed} of ${builds} builds pass secrets: [npm_token]`);
  return problems;
}

// The deploy script (templates/deploy/deploy/remote-deploy.sh.tmpl) tags images by commit to roll back, reads
// the web port from WEB_BIND/WEB_PORT, and runs migrations with the root db:migrate. Local DBs apply
// migrations through the same runner, so compose must not also mount them into initdb (#695).
export function checkComposeDeploy(text, { dbName = null, scripts = {} } = {}) {
  const problems = [];
  const name = dbName ?? '[a-z0-9_-]+';
  for (const part of ['backend', 'frontend']) {
    if (!new RegExp(`^\\s*image:\\s*['"]?${name}-${part}:\\$\\{IMAGE_TAG(:-[^}]*)?\\}`, 'm').test(text)) {
      problems.push(`image ${dbName ?? '<db>'}-${part}:\${IMAGE_TAG} is missing, so the deploy script cannot roll back to the previous image`);
    }
  }
  if (!/\$\{WEB_BIND(:-[^}]*)?\}:\$\{WEB_PORT(:-[^}]*)?\}:80\b/.test(text)) problems.push('the web port must be published as ${WEB_BIND}:${WEB_PORT}:80, which the deploy script sets in .env');
  if (/docker-entrypoint-initdb\.d/.test(text)) problems.push('database/migrations must not be mounted into docker-entrypoint-initdb.d; the migration runner applies and records them');
  if (/(?<!\$)\$POSTGRES_(USER|DB)\b/.test(text)) problems.push('the healthcheck must write $$POSTGRES_USER and $$POSTGRES_DB so the container, not compose, expands them');
  if (!scripts['db:migrate']) problems.push('package.json has no root db:migrate script, which the deploy and CI run');
  return problems;
}

/**
 * Warnings for compose.yaml that do not fail the check (#875): the `api` service has no `healthcheck`, so
 * `docker compose up -d --wait` and web's `depends_on` cannot tell when the API is ready. Returns warning strings.
 */
export function checkComposeWarnings(text) {
  const api = text.match(/^ {2}api:[ \t]*\r?\n((?: {3,}.*\r?\n|[ \t]*\r?\n)*)/m);
  if (api && !/^ {4}healthcheck:/m.test(api[1])) return ['compose.yaml: the api service has no healthcheck, so `docker compose up -d --wait` cannot tell when the API is ready. Add one on /api/health (scaffold/app/compose.yaml in project-standards has an example).'];
  return [];
}

/**
 * Managed helpers that a repo-owned file must use (#906). Sync updates the managed file, but the repo-owned file
 * that calls it does not change, so a helper can sit unused for weeks (#866 added `listenHost`, and 5 of 8 apps still
 * passed a literal '0.0.0.0' a day later, #898). Each rule says which managed file offers the helper, which repo-owned
 * file must use it, and how to tell from `sources` ([{ file, text }] of backend/src without tests).
 * `applies(sources, manifestFiles)` is true only where the helper exists in this repo and the owned file is present;
 * `check(sources)` returns problem texts. To add a rule: add an entry here and a passing and a failing case to
 * scripts/test/standards-check.test.mjs (docs/changes/906-adoption-rules.md).
 */
const backendFile = (sources, file) => sources.find((s) => s.file === file);
const notStandard = (sources) => sources.filter((s) => !s.file.startsWith('backend/src/standard/'));
export const ADOPTION_RULES = [
  {
    id: 'listen-host',
    helper: 'listenHost',
    managedFile: 'backend/src/standard/auth.ts',
    ownedFile: 'backend/src/server.ts',
    applies: (sources, managed) => Boolean(managed['backend/src/standard/auth.ts'] && backendFile(sources, 'backend/src/server.ts')),
    check: (sources) =>
      /\blistenHost\(/.test(backendFile(sources, 'backend/src/server.ts').text)
        ? []
        : ["backend/src/server.ts: listen on `listenHost(auth !== undefined)` from standard/auth.ts instead of a literal host, so a run without the shared sign-in stays on 127.0.0.1 (project-standards#866, #898)."],
  },
  {
    id: 'create-pool',
    helper: 'createPool',
    managedFile: 'backend/src/standard/db.ts',
    // The files of the running server; one-off scripts (imports, exports) that open their own pool are not asked.
    ownedFile: 'backend/src/server.ts, pool.ts or db.ts (the file that calls new Pool)',
    applies: (sources, managed) => Boolean(managed['backend/src/standard/db.ts']),
    check: (sources) =>
      notStandard(sources)
        .filter((s) => /^backend\/src\/(server|pool|db)\.ts$/.test(s.file) && /\bnew Pool\(/.test(s.text) && !/\bcreatePool\(/.test(s.text))
        .map((s) => `${s.file}: wrap the pool with createPool(new Pool(...)) from standard/db.ts, so an idle-client error is logged and does not crash the process (ADR-0025).`),
  },
  {
    id: 'tool-routes',
    helper: 'registerToolRoutes',
    managedFile: 'backend/src/standard/tools.ts',
    ownedFile: 'backend/src/app.ts, backend/src/server.ts',
    applies: (sources, managed) => Boolean(managed['backend/src/standard/tools.ts'] && backendFile(sources, 'backend/src/ai-tools.ts') && backendFile(sources, 'backend/src/app.ts')),
    check: (sources) => {
      const warnings = [];
      const app = backendFile(sources, 'backend/src/app.ts').text;
      if (!/\bregisterToolRoutes\(/.test(app)) warnings.push('backend/src/app.ts: ai-tools.ts exists but registerToolRoutes(app, { app, tools, pool, publicKey, requireBinding: true }) is not called, so shared-ai cannot reach the tools (docs/ai-tools.md).');
      else if (!/\brequireBinding:\s*true\b/.test(app)) warnings.push('backend/src/app.ts: registerToolRoutes needs requireBinding: true, so a call token must name its tool and cannot be replayed (project-standards#670, #822).');
      const server = backendFile(sources, 'backend/src/server.ts');
      if (server && !/\bAI_TOOLS_PUBLIC_KEY\b/.test(server.text)) warnings.push('backend/src/server.ts: pass toolsPublicKey: process.env.AI_TOOLS_PUBLIC_KEY to createApp, or the AI tool routes stay off (docs/ai-tools.md).');
      return warnings;
    },
  },
];

/** Warnings for the adoption rules that apply to this repo. `managed` is manifest.files. */
export function checkAdoption(sources, managed = {}) {
  return ADOPTION_RULES.filter((rule) => rule.applies(sources, managed)).flatMap((rule) => rule.check(sources));
}

// API rules from docs/directory-rules.md "API". Warnings only: the apps grew different layouts
// (routes/ modules or Routers in src/), so these look for the rules, not for one file layout.
// sources: [{ file: 'backend/src/…', text }] without tests. Returns warning strings.
const API_SEGMENT = /^(:\w+|\*\w*|[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)?)$/;
export function checkApi(sources) {
  const warnings = [];
  const app = sources.find((s) => s.file === 'backend/src/app.ts');
  if (!app) return warnings;
  const at = (source, index) => `${source.file}:${source.text.slice(0, index).split('\n').length}`;
  if (!sources.some((s) => /\bapp\.get\(\s*['"`]\/api\/health['"`]/.test(s.text))) warnings.push('backend/src: GET /api/health is missing. Every app has a health check API that verifies the DB connection.');
  if (!/\bapp\.use\(\s*(errorHandler\b|createErrorHandler\(|\(\s*err\b)/.test(app.text)) warnings.push('backend/src/app.ts: the error middleware (app.use(errorHandler)) is missing, so errors are not returned as { error }.');
  const logAt = app.text.search(/\bapp\.use\(\s*requestLog\b/);
  if (logAt < 0) warnings.push('backend/src/app.ts: app.use(requestLog) is missing, so requests get no request ID or JSON log line (docs/logging.md).');
  else {
    // Routes mounted before requestLog get no request ID. The health check may come first (study-log), so it is not counted.
    const early = [...app.text.slice(0, logAt).matchAll(/\bapp\.(?:post|put|patch|delete|use)\(\s*['"`]\/(?:api|internal)(?:\/|['"`])/g)];
    if (early.length > 0) warnings.push(`${at(app, early[0].index)}: app.use(requestLog) must be mounted before the routes, or they get no request ID or JSON log line (docs/logging.md).`);
  }
  if (!/\bapp\.use\(\s*['"`]\/api['"`]\s*,/.test(app.text)) warnings.push("backend/src/app.ts: app.use('/api', notFound), which answers unknown /api paths with 404 { error }, is missing.");
  for (const source of sources) {
    for (const m of source.text.matchAll(/\bapp\.(get|post|put|patch|delete|use)\(\s*['"]([^'"]+)['"]/g)) {
      const route = m[2];
      // /internal/tools is the AI tool endpoint for shared-ai (ADR-0017); nginx forwards only /api.
      if (!/^\/(api|internal)(\/|$)/.test(route)) {
        warnings.push(`${at(source, m.index)}: API route ${route} must start with /api.`);
        continue;
      }
      const bad = route.split('/').filter(Boolean).find((segment) => !API_SEGMENT.test(segment));
      if (bad) warnings.push(`${at(source, m.index)}: In API route ${route}, "${bad}" must use lowercase English and hyphens.`);
    }
    for (const m of source.text.matchAll(/\.status\(\s*([45]\d\d)\s*\)\s*\.json\(\s*\{\s*(\w+)\s*:/g)) {
      if (m[2] !== 'error') warnings.push(`${at(source, m.index)}: ${m[1]} response uses { ${m[2]} }. Error responses use { error: '<Korean message>' }.`);
    }
    for (const m of source.text.matchAll(/\breq\.(body|query)\.\w+/g)) {
      warnings.push(`${at(source, m.index)}: ${m[0]} is read without validation. Validate req.${m[1]} with a Zod schema parse() first.`);
    }
  }
  return warnings;
}

// End index of the parenthesized group whose "(" is just before `start`.
function closeParen(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    i++;
  }
  return i;
}

// A zod array with no length limit lets one large request raise an issue per element until memory runs out
// (GHSA-mrhx-c7xc-m3w5, #326). Follows the method chain after `.array(...)` across lines for .max()/.length().
export function checkZodArrays(sources) {
  const warnings = [];
  for (const source of sources) {
    if (!/from ['"]zod(\/v[34])?['"]/.test(source.text)) continue;
    for (const m of source.text.matchAll(/\.array\(/g)) {
      let i = closeParen(source.text, m.index + m[0].length);
      const chain = [];
      for (let next; (next = source.text.slice(i).match(/^\s*\.(\w+)\(/)); ) {
        chain.push(next[1]);
        i = closeParen(source.text, i + next[0].length);
      }
      const line = source.text.slice(0, m.index).split('\n').length;
      const limit = chain.findIndex((name) => name === 'max' || name === 'length');
      if (limit < 0) {
        warnings.push(`${source.file}:${line}: array schema has no length limit. Add .max(<count>) (zod security advisory GHSA-mrhx-c7xc-m3w5).`);
      } else if (chain.slice(0, limit).some((name) => ['refine', 'superRefine', 'check'].includes(name))) {
        // zod 4.6.7 rejects before reading elements only when the length checks come first (#386).
        warnings.push(`${source.file}:${line}: the array .${chain[limit]}() comes after .refine, so it rejects only after reading every element. Move the length limit earlier (zod security advisory GHSA-mrhx-c7xc-m3w5).`);
      }
    }
  }
  return warnings;
}

// Frontend file names are lowercase words joined by hyphens; dots only separate kinds (docs/conventions/code.md, #312).
const FILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;
export function checkFileNames(files) {
  const bad = files.filter((rel) => /\.(ts|tsx)$/.test(rel) && !FILE_NAME.test(rel.split('/').pop()));
  if (!bad.length) return [];
  const shown = bad.slice(0, 5).join(', ');
  return [`frontend/src: file names use lowercase and hyphens (docs/conventions/code.md). ${bad.length} found: ${shown}${bad.length > 5 ? ' and more' : ''}`];
}

function frontendFiles(root) {
  const dir = path.join(root, 'frontend/src');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).split(path.sep).join('/'))
    .filter((rel) => !rel.split('/').includes('node_modules') && fs.statSync(path.join(dir, rel)).isFile())
    .sort()
    .map((rel) => `frontend/src/${rel}`);
}

function apiSources(root) {
  const dir = path.join(root, 'backend/src');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).split(path.sep).join('/'))
    .filter((rel) => rel.endsWith('.ts') && !/\.(test|d)\.ts$/.test(rel) && !rel.split('/').includes('node_modules'))
    .sort()
    .map((rel) => ({ file: `backend/src/${rel}`, text: fs.readFileSync(path.join(dir, rel), 'utf8') }));
}

function checkPackages(packages, read, problems) {
  for (const [name, version] of Object.entries(packages ?? {})) {
    if (version === null) continue;
    const text = read(`node_modules/${name}/package.json`);
    if (text === null) {
      problems.push({ group: 'shared package', path: name, message: `not installed (expected version ${version}). Run npm ci first` });
      continue;
    }
    const pkg = JSON.parse(text);
    if (pkg.version !== version) problems.push({ group: 'shared package', path: name, message: `installed version ${pkg.version}, expected version ${version}` });
    const scripts = INSTALL_SCRIPTS.filter((s) => pkg.scripts?.[s]);
    if (scripts.length) problems.push({ group: 'shared package', path: name, message: `has install scripts: ${scripts.join(', ')}` });
    if (Object.keys(pkg.dependencies ?? {}).length) problems.push({ group: 'shared package', path: name, message: 'dependencies is not empty' });
  }
}

/** Names of dependencies whose version is a ^ or ~ range; every app version must be exact (#701). */
export function rangeVersions(pkg) {
  return ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((section) =>
    Object.entries(pkg[section] ?? {}).filter(([, v]) => /^[\^~]/.test(v)).map(([name, v]) => `${section}.${name} ${v}`));
}

/** Returns { problems: [{ group, path, message }], warnings: [string], manifest }. */
export function runCheck(root) {
  const read = (rel) => {
    const file = path.join(root, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const manifestText = read(MANIFEST_PATH);
  if (manifestText === null) throw new Error(`${MANIFEST_PATH} is missing. This repository is not synced with the central standard yet.`);
  const manifest = JSON.parse(manifestText);
  const problems = [];
  const warnings = [];
  for (const { path: file, reason } of checkManifest(manifest, read)) {
    const source = manifest.files[file].source;
    problems.push({ group: 'managed file', path: file, message: `${reasonText(reason)}${source ? ` (central source: ${source})` : ''}` });
  }
  checkPackages(manifest.packages, read, problems);
  if (manifest.registry) checkRegistry(manifest.registry, read, problems, warnings);
  for (const file of ['package.json', 'frontend/package.json', 'backend/package.json']) {
    const text = read(file);
    for (const range of text === null ? [] : rangeVersions(JSON.parse(text))) problems.push({ group: 'version range', path: file, message: `${range} must be an exact version` });
  }
  // @ssm= tags name the SSM parameter the deploy script reads for a key (ADR-0014).
  const envExample = read('.env.example');
  if (envExample !== null && manifest.project) {
    for (const message of ssmProblems(parseEnvExample(envExample), manifest.project)) problems.push({ group: 'SSM key', path: '.env.example', message });
  }
  const backend = apiSources(root);
  warnings.push(...checkApi(backend));
  warnings.push(...checkAdoption(backend, manifest.files));
  warnings.push(...checkZodArrays(backend));
  warnings.push(...checkFileNames(frontendFiles(root)));
  const compose = read('compose.yaml');
  if (compose !== null && (manifest.files['frontend/Dockerfile'] || manifest.files['backend/Dockerfile'])) {
    for (const message of checkComposeSecrets(compose)) problems.push({ group: 'build secret', path: 'compose.yaml', message });
  }
  if (compose !== null && manifest.profile === 'app') {
    let scripts = {};
    try {
      scripts = JSON.parse(read('package.json') ?? '{}').scripts ?? {};
    } catch {
      // an unreadable package.json is reported by the managed file check
    }
    for (const message of checkComposeDeploy(compose, { dbName: manifest.registry?.db?.name ?? null, scripts })) problems.push({ group: 'deploy contract', path: 'compose.yaml', message });
    warnings.push(...checkComposeWarnings(compose));
  }
  return { problems, warnings, manifest };
}

export function formatReport({ problems, warnings, manifest }) {
  const lines = [];
  for (const w of warnings) lines.push(`warning: ${w}`);
  if (!problems.length) {
    lines.push(`standards-check: passed (central ${CENTRAL}@${String(manifest.centralSha).slice(0, 7)})`);
    return lines.join('\n');
  }
  lines.push(`standards-check: ${problems.length} difference(s) from the central standard`);
  for (const group of [...new Set(problems.map((p) => p.group))]) {
    lines.push('', `[${group}]`);
    for (const p of problems.filter((x) => x.group === group)) lines.push(`  ✗ ${p.path} — ${p.message}`);
  }
  lines.push(
    '',
    'How to fix:',
    `  1. Fix centrally managed files, versions, and ports in ${CENTRAL}, not in this repository.`,
    `       ghp issue create -R ${CENTRAL} --title "<what to change>"`,
    '       (in project-standards) git switch -c fix/<issue-number>-<short-slug>',
    '       Edit the "central source" file listed above, then open a PR. After it merges, a sync PR opens in this repository.',
    '  2. If only this project must differ, open a PR that adds the path and reason to allowedDifferences in the central registry/projects.json.',
    '  3. If this repository has an open sync PR (chore/standards-sync-*), merging it first may fix this.',
  );
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const flag = process.argv.indexOf('--root');
  const root = flag > 0 ? path.resolve(process.argv[flag + 1]) : path.basename(here) === '.standards' ? path.dirname(here) : process.cwd();
  try {
    const result = runCheck(root);
    const report = formatReport(result);
    if (result.problems.length) {
      console.error(report);
      process.exit(1);
    }
    console.log(report);
  } catch (error) {
    console.error(`standards-check: ${error.message}`);
    process.exit(2);
  }
}
