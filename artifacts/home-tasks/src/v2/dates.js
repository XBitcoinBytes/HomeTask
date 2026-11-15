/**
 * dates.js — pure local-date helpers for the v2 modules.
 *
 * Exact ports of the v1 helpers in script.js (same semantics, same
 * "YYYY-MM-DD" local-date convention). No clock access anywhere in this
 * module: "today" is always an injected argument at call sites.
 */

/** Adds `n` days to a "YYYY-MM-DD" string, returns new "YYYY-MM-DD". */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** Signed days from `a` to `b`. Positive = b is in a's future. */
export function daysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
  return Math.round(ms / 86_400_000);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is `v` a plausible "YYYY-MM-DD" string? */
export function isDateStr(v) {
  return typeof v === 'string' && DATE_RE.test(v) &&
    !Number.isNaN(new Date(v + 'T00:00:00').getTime());
}
