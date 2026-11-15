/* Extracted mechanically from src/script.js lines 34–90 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── Utility helpers ──────────────────────────────────────────── */

/** Returns today's date as "YYYY-MM-DD" in local time */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** Adds `n` days to a "YYYY-MM-DD" string, returns new "YYYY-MM-DD" */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/**
 * Signed days from `a` to `b` (both "YYYY-MM-DD").
 * Positive = b is in the future relative to a.
 * Negative = b is in the past relative to a.
 */
function daysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
  return Math.round(ms / 86_400_000);
}

/** "Jul 25" style */
function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Safe HTML escape */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/**
 * Single shared predicate for "completed today".
 *
 * Returns true ONLY when BOTH conditions hold in the local calendar timezone:
 *   • task.doneToday is strictly the boolean true
 *   • task.lastDone exactly equals today's "YYYY-MM-DD" local date string
 *
 * Every rendering path that decides the Done button's visual treatment
 * (initial card build AND in-place patchCard update) must call this
 * function rather than re-deriving the condition from status type,
 * button label, card class, a truthy lastDone string, or any other proxy.
 */
function isCompletedToday(task) {
  return task.doneToday === true && task.lastDone === todayStr();
}

export { todayStr, addDays, daysBetween, fmtDate, esc, isCompletedToday };
