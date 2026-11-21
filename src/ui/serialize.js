'use strict';

// It turns a result object into a value that can be carried as JSON (#253).
// Error -> { name, message, code, ... }, Set -> array, Map -> [key, value] array, BigInt -> string, Buffer -> string (utf8),
// Date -> ISO string, undefined, functions, and symbols are dropped inside an object and left as null inside an array. If it meets the same object again, it leaves '[circular]'.
// Limits (#318): a deeper or larger value is cut with a marker instead of overflowing the stack on the error path.
const MAX_DEPTH = 50;
const MAX_NODES = 200000;

function toPlain(value, seen = new Set(), budget = { nodes: 0, depth: 0 }) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (seen.has(value)) return '[circular]';
  if (budget.depth >= MAX_DEPTH) return '[too deep]';
  if (++budget.nodes > MAX_NODES) return '[too large]';
  seen.add(value);
  budget.depth += 1;
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Error) {
      // It uses the class name so that subclasses that did not change name, like FcError, can also be told apart on the screen.
      const name = value.name === 'Error' && value.constructor && value.constructor.name ? value.constructor.name : value.name;
      const plain = { name, message: value.message };
      for (const key of Object.keys(value)) {
        const item = toPlain(value[key], seen, budget);
        if (item !== undefined) plain[key] = item;
      }
      return plain;
    }
    if (value instanceof Set) return [...value].map((item) => inArray(item, seen, budget));
    if (value instanceof Map) return [...value].map(([k, v]) => [inArray(k, seen, budget), inArray(v, seen, budget)]);
    if (Array.isArray(value)) return value.map((item) => inArray(item, seen, budget));
    const plain = {};
    for (const key of Object.keys(value)) {
      const item = toPlain(value[key], seen, budget);
      if (item !== undefined) plain[key] = item;
    }
    return plain;
  } finally {
    budget.depth -= 1;
    // An object that appears in several places (sharing, not a cycle) is carried as it is.
    seen.delete(value);
  }
}

function inArray(item, seen, budget) {
  const plain = toPlain(item, seen, budget);
  return plain === undefined ? null : plain;
}

module.exports = { toPlain, MAX_DEPTH, MAX_NODES };
