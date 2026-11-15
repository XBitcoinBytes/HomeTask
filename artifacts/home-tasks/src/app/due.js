/* Extracted mechanically from src/script.js lines 496–514 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { addDays } from './util.js';

/* ── Effective due date ───────────────────────────────────────── */
/**
 * Compute the effective due date for a task as a "YYYY-MM-DD" string,
 * or null if the task has never been done and has no skip override.
 *
 * Priority:
 *   1. task.skipUntil  — explicit scheduling override (set by Skip actions)
 *   2. task.lastDone + task.intervalDays — natural next-due from last completion
 *   3. null — task has never been done
 *
 * NOTE: skipUntil is the new effective due date, not a "hide until" flag.
 * A past skipUntil means the task was deferred but the deferred date has
 * now passed → it is overdue from that date.
 */
function computeEffectiveDue(task) {
  if (task.skipUntil) return task.skipUntil;
  if (task.lastDone)  return addDays(task.lastDone, task.intervalDays);
  return null;
}

export { computeEffectiveDue };
