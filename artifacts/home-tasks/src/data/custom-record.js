/**
 * Pure custom-record boundary for v1 storage and backup import/export.
 *
 * Custom records are user-owned. Unlike seed records, their identity fields
 * and safe future fields must round-trip. The same strict boundary is used
 * for local reload and backup import so a record accepted in one path has the
 * same meaning in the other.
 */

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const KNOWN_CUSTOM_KEYS = new Set([
  'id', 'title', 'room', 'intervalDays', 'tags',
  'lastDone', 'doneToday', 'skipUntil', '_custom',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INVALID = Symbol('invalid-json-value');

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isDateOrNull(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  return !Number.isNaN(new Date(value + 'T00:00:00').getTime());
}

/**
 * Recursively copy a JSON value while rejecting objects that could alter
 * prototypes when copied. Parsed JSON only has ordinary values, but export
 * also handles in-memory objects, so the boundary is explicit.
 */
function copySafeJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
  if (Array.isArray(value)) {
    const out = [];
    for (const entry of value) {
      const copied = copySafeJson(entry);
      if (copied === INVALID) return INVALID;
      out.push(copied);
    }
    return out;
  }
  if (!isPlainObject(value)) return INVALID;

  const out = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) return INVALID;
    const copied = copySafeJson(value[key]);
    if (copied === INVALID) return INVALID;
    Object.defineProperty(out, key, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function sanitizeTags(tags) {
  return Array.isArray(tags)
    ? tags
        .filter(tag => typeof tag === 'string')
        .map(tag => tag.trim().slice(0, 50))
        .filter(Boolean)
    : [];
}

/**
 * Return a canonical custom record or null when the record is malformed,
 * unsafe, or collides with a seed identifier.
 *
 * Unknown fields are preserved only when their complete value tree is safely
 * JSON-serializable. Rejecting the whole record is deliberate: silently
 * dropping one unknown field would make a future feature's data disappear.
 */
function sanitizeCustomRecord(record, { today, seedIds }) {
  if (!isPlainObject(record) || record._custom !== true) return null;
  if (typeof record.id !== 'string' || !record.id.trim() || seedIds.has(record.id)) return null;
  if (typeof record.title !== 'string' || !record.title.trim()) return null;
  if (typeof record.room !== 'string' || !record.room.trim()) return null;
  if (typeof record.intervalDays !== 'number' ||
      !Number.isFinite(record.intervalDays) || record.intervalDays < 1) return null;
  if (!_isSupportedDate(record.lastDone) || !_isSupportedDate(record.skipUntil)) return null;
  if (record.doneToday !== undefined && typeof record.doneToday !== 'boolean') return null;

  const unknown = {};
  for (const key of Object.keys(record)) {
    if (KNOWN_CUSTOM_KEYS.has(key)) continue;
    if (UNSAFE_KEYS.has(key)) return null;
    const copied = copySafeJson(record[key]);
    if (copied === INVALID) return null;
    Object.defineProperty(unknown, key, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const lastDone = record.lastDone ?? null;
  return {
    id: record.id,
    title: record.title,
    room: record.room,
    intervalDays: Math.round(record.intervalDays),
    tags: sanitizeTags(record.tags),
    lastDone,
    doneToday: lastDone === today ? Boolean(record.doneToday) : false,
    skipUntil: record.skipUntil ?? null,
    _custom: true,
    ...unknown,
  };
}

function _isSupportedDate(value) {
  return isDateOrNull(value);
}

export { isPlainObject, sanitizeCustomRecord };