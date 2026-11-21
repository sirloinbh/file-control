// Managed file. Edit it in sirloinbh/project-standards scripts/lib/
// Content hashes that ignore line endings, so a Windows checkout (CRLF) hashes the same as CI (LF).
import crypto from 'node:crypto';
import { PROJECT_MARKER } from './render.mjs';

/** Strips a UTF-8 BOM and converts CRLF to LF. */
export const normalize = (text) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

export const sha256 = (text) => crypto.createHash('sha256').update(normalize(text), 'utf8').digest('hex');

/** The central part of a section-managed file: everything up to and including the marker line. */
export function centralSection(text) {
  const normalized = normalize(text);
  const at = normalized.indexOf(PROJECT_MARKER);
  return at < 0 ? null : normalized.slice(0, at + PROJECT_MARKER.length);
}

/** Picks dotted fields from an object, e.g. ["engines.node", "packageManager"]. Missing fields are undefined. */
export function pickFields(object, fields) {
  return Object.fromEntries(
    fields.map((field) => [field, field.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object)]),
  );
}

// Stable JSON so key order in package.json does not change the comparison.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
