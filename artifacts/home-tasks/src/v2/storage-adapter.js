/**
 * storage-adapter.js — injected storage adapters for the CP3 v2
 * transactional code.
 *
 * The production runtime NEVER imports this module during CP3; it exists
 * so every transaction/rollback/recovery path can be exercised against
 * isolated mock storage with deterministic failure injection.
 *
 * Adapter interface (localStorage-compatible subset + test helpers):
 *   getItem(key)    → string | null      (may throw when injected)
 *   setItem(key, v) → void               (may throw when injected)
 *   removeItem(key) → void               (may throw when injected)
 *   keys()          → string[]           (test helper, never fails)
 *   snapshotAll()   → { [key]: string }  (test helper, byte-exact copy)
 *
 * Pure module: no localStorage, no DOM, no clock.
 */

/** Plain in-memory adapter seeded with an optional { key: string } map. */
export function createMemoryAdapter(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key)      { return map.has(key) ? map.get(key) : null; },
    setItem(key, val) { map.set(key, String(val)); },
    removeItem(key)   { map.delete(key); },
    keys()            { return [...map.keys()]; },
    snapshotAll()     { return Object.fromEntries(map); },
  };
}

/**
 * Deterministic failure-injection wrapper.
 *
 * rules: array of { op: 'get'|'set'|'remove', key?, afterCalls?, mode?, times? }
 *   op         — which operation to affect
 *   key        — only this key (omit = any key)
 *   afterCalls — skip this many MATCHING calls before failing (default 0,
 *                i.e. fail from the first matching call)
 *   mode       — 'throw' (default; QuotaExceededError-like Error),
 *                'null'  (get returns null unexpectedly),
 *                'noop'  (set/remove silently do nothing — verify catches it)
 *   times      — how many matching calls fail (default Infinity)
 *
 * Failures are purely counter-based → byte-for-byte reproducible.
 */
export function createFailingAdapter(base, rules) {
  const counters = rules.map(() => 0);
  function apply(op, key, run, nullResult) {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r.op !== op) continue;
      if (r.key !== undefined && r.key !== key) continue;
      const n = counters[i]++;
      const after = r.afterCalls ?? 0;
      const times = r.times ?? Infinity;
      if (n < after || n >= after + times) continue;
      const mode = r.mode ?? 'throw';
      if (mode === 'throw') {
        const e = new Error(`injected ${op} failure on "${key}"`);
        e.name = 'QuotaExceededError';
        throw e;
      }
      if (mode === 'null' && op === 'get') return nullResult;
      if (mode === 'noop') return undefined;   // silently swallow the write
    }
    return run();
  }
  return {
    getItem:    key        => apply('get', key, () => base.getItem(key), null),
    setItem:    (key, val) => apply('set', key, () => base.setItem(key, val)),
    removeItem: key        => apply('remove', key, () => base.removeItem(key)),
    keys:        () => base.keys(),
    snapshotAll: () => base.snapshotAll(),
  };
}
