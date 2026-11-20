// Managed file. Edit it in sirloinbh/project-standards scripts/lib/
// Builds and checks .standards/manifest.json: the record of which files the central
// repository manages in a target repository and what their content must be.
import { canonical, centralSection, pickFields, sha256 } from './hash.mjs';

export const MANIFEST_PATH = '.standards/manifest.json';
export const MODES = ['full', 'section', 'fields'];

/**
 * files: [{ path, mode: "full", content }, { path, mode: "section", content }, { path, mode: "fields", fields: { "engines.node": "24.21.0" } }]
 */
export function buildManifest({ centralSha, profile, project, files, packages = {}, registry = null }) {
  const entries = {};
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!MODES.includes(f.mode)) throw new Error(`${f.path}: unknown mode "${f.mode}"`);
    if (entries[f.path]) throw new Error(`${f.path}: listed twice`);
    // `source` tells people where to make the change in the central repository.
    const source = f.source ? { source: f.source } : {};
    if (f.mode === 'full') entries[f.path] = { mode: 'full', sha256: sha256(f.content), ...source };
    if (f.mode === 'section') {
      const central = centralSection(f.content);
      if (central === null) throw new Error(`${f.path}: section-managed file has no project marker`);
      entries[f.path] = { mode: 'section', sha256: sha256(central), ...source };
    }
    if (f.mode === 'fields') entries[f.path] = { mode: 'fields', fields: f.fields, ...source };
  }
  return { centralSha, profile, project, files: entries, packages, registry };
}

/**
 * Compares one manifest entry with the target's current file text (null when the file is missing).
 * Returns null when it matches, otherwise a short reason.
 */
export function checkEntry(entry, text) {
  if (text === null || text === undefined) return 'missing';
  if (entry.mode === 'full') return sha256(text) === entry.sha256 ? null : 'changed';
  if (entry.mode === 'section') {
    const central = centralSection(text);
    if (central === null) return 'project marker removed';
    return sha256(central) === entry.sha256 ? null : 'central section changed';
  }
  if (entry.mode === 'fields') {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return 'not valid JSON';
    }
    const actual = pickFields(json, Object.keys(entry.fields));
    const wrong = Object.keys(entry.fields).filter((k) => canonical(actual[k]) !== canonical(entry.fields[k]));
    return wrong.length ? `field(s) changed: ${wrong.join(', ')}` : null;
  }
  return `unknown mode "${entry.mode}"`;
}

/** Checks every entry. `readFile(path)` returns the text or null. Returns [{ path, reason }]. */
export function checkManifest(manifest, readFile) {
  return Object.entries(manifest.files)
    .map(([path, entry]) => ({ path, reason: checkEntry(entry, readFile(path)) }))
    .filter((r) => r.reason !== null);
}
