// Deterministic primitives: code-unit ordering, canonical JSON, hashing, safe sums.
import { createHash } from 'node:crypto';

/** Lexicographic comparison by UTF-16 code unit; never locale-dependent. */
export function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with recursively sorted object keys; arrays keep their order. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function stableId(prefix, parts) {
  return `${prefix}-${sha256Hex(parts.join('\u0000')).slice(0, 16)}`;
}

/**
 * Sum integer minutes. Returns { value, overflow }. When any addend or partial sum
 * leaves the safe-integer range, value is null and overflow is true (never clamped).
 */
export function sumMinutes(values) {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) return { value: null, overflow: true };
    total += v;
    if (!Number.isSafeInteger(total)) return { value: null, overflow: true };
  }
  return { value: total, overflow: false };
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
