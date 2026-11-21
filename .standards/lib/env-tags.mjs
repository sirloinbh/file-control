// Managed file. Edit it in sirloinbh/project-standards scripts/lib/
// .env.example tags (docs/env-conventions.md) and the SSM parameter rules (ADR-0014).
// Copied into app repositories as .standards/lib/env-tags.mjs: Node built-ins only.

const TAG = /@(desc|required|secret|used|ssm)(?:=([^\s@]+)|\s+([^@]*))?/g;

/** Parses .env.example: [{ key, value, desc, required, secret, used, ssm, section }]. */
export function parseEnvExample(text) {
  const entries = [];
  let comment = '';
  let section = 'central';
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '# --- project ---') {
      section = 'project';
      comment = '';
    } else if (line.startsWith('#')) comment = line.slice(1).trim();
    else if (/^[A-Z][A-Z0-9_]*=/.test(line)) {
      const [key, ...rest] = line.split('=');
      const meta = { desc: '', required: false, secret: false, used: [], ssm: null };
      for (const m of comment.matchAll(TAG)) {
        if (m[1] === 'desc') meta.desc = (m[3] ?? '').trim();
        if (m[1] === 'required') meta.required = true;
        if (m[1] === 'secret') meta.secret = true;
        if (m[1] === 'used') meta.used = (m[2] ?? m[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (m[1] === 'ssm') meta.ssm = (m[2] ?? m[3] ?? '').trim() || null;
      }
      // Without tags, guess secrecy from the name so a legacy file never leaks a password.
      if (!comment.includes('@') && /PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL/.test(key)) meta.secret = true;
      entries.push({ key, value: rest.join('='), ...meta, section });
      comment = '';
    } else comment = '';
  }
  return entries;
}

/** Shared keys live under /sirloinbh/shared/, one app's keys under /sirloinbh/<app>/ (ADR-0014). */
export const SSM_PATH = /^\/sirloinbh\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Why an @ssm= parameter is not allowed for this app, or null. */
export function ssmPathProblem(parameter, app) {
  const m = SSM_PATH.exec(parameter ?? '');
  if (!m) return `${parameter} is not /sirloinbh/shared/<name> or /sirloinbh/${app}/<name> (lowercase letters, digits, hyphens)`;
  if (m[1] !== 'shared' && m[1] !== app) return `${parameter} belongs to ${m[1]}; this app may read only /sirloinbh/shared/ and /sirloinbh/${app}/`;
  return null;
}

/** Problems with the @ssm= tags of one app's .env.example entries. */
export function ssmProblems(entries, app) {
  const problems = [];
  for (const e of entries.filter((x) => x.ssm)) {
    const path = ssmPathProblem(e.ssm, app);
    if (path) problems.push(`${e.key}: ${path}`);
    if (!e.secret) problems.push(`${e.key}: a key read from SSM must also have @secret`);
    if (e.value) problems.push(`${e.key}: a key read from SSM must have an empty example value`);
    if (e.key.startsWith('VITE_')) problems.push(`${e.key}: VITE_ values reach the browser, so they cannot come from SSM`);
  }
  return problems;
}
