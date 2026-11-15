/* Extracted mechanically from src/script.js lines 941–1044 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { daysBetween, fmtDate, todayStr } from './util.js';
import { SAFETY_TASK_IDS } from './catalog.js';
import { computeEffectiveDue } from './due.js';

/* ── Status module ────────────────────────────────────────────── */
const statusOf = (() => {
  /**
   * Compute the display status for a task.
   *
   * Returns { type, label, badgeClass, cardClass }
   *
   * Types and corresponding colors:
   *   'done'     → green   (completed today)
   *   'future'   → white   (due more than 7 days away)
   *   'soon'     → yellow  (due today or within 7 days)
   *   'overdue'  → orange  (past due, not severely)
   *   'critical' → red     (severely overdue OR safety task due/overdue)
   *
   * Severe overdue threshold = max(7, task.intervalDays).
   * Safety tasks (SAFETY_TASK_IDS) → red as soon as due (daysUntil ≤ 0).
   * Never-done tasks (no lastDone, no skipUntil) → always critical.
   */
  function compute(task) {
    const today    = todayStr();
    const isSafety = SAFETY_TASK_IDS.has(task.id);

    /* ── Done today ── */
    if (task.doneToday === true && task.lastDone === today) {
      return {
        type:       'done',
        label:      '✓ Done today',
        badgeClass: 's-done',
        cardClass:  'state-done',
      };
    }

    const effectiveDue = computeEffectiveDue(task);

    /* ── Never done with no skip override ── */
    if (!effectiveDue) {
      return {
        type:       'critical',
        label:      isSafety ? '⚠ Never done · Safety' : 'Never done',
        badgeClass: 's-critical',
        cardClass:  'state-critical',
      };
    }

    // Positive = due date is in the future; negative = overdue
    const daysUntil = daysBetween(today, effectiveDue);

    /* ── Due more than 7 days away ── */
    if (daysUntil > 7) {
      return {
        type:       'future',
        label:      `Due ${fmtDate(effectiveDue)}`,
        badgeClass: 's-future',
        cardClass:  'state-future',
      };
    }

    /* ── Due today or within 7 days ── */
    if (daysUntil >= 0) {
      const dueLabel = daysUntil === 0 ? 'Due today' : `Due in ${daysUntil}d`;

      // Safety tasks go red the moment they are due
      if (isSafety) {
        return {
          type:       'critical',
          label:      daysUntil === 0 ? '⚠ Due today · Safety' : `⚠ ${dueLabel} · Safety`,
          badgeClass: 's-critical',
          cardClass:  'state-critical',
        };
      }

      return {
        type:       'soon',
        label:      dueLabel,
        badgeClass: 's-soon',
        cardClass:  'state-soon',
      };
    }

    /* ── Overdue (daysUntil < 0) ── */
    const daysOverdue     = -daysUntil;
    const severeThreshold = Math.max(7, task.intervalDays);

    if (isSafety || daysOverdue >= severeThreshold) {
      return {
        type:       'critical',
        label:      isSafety
                      ? `⚠ ${daysOverdue}d overdue · Safety`
                      : `${daysOverdue}d overdue`,
        badgeClass: 's-critical',
        cardClass:  'state-critical',
      };
    }

    return {
      type:       'overdue',
      label:      `${daysOverdue}d overdue`,
      badgeClass: 's-overdue',
      cardClass:  'state-overdue',
    };
  }

  return { compute };
})();

export { statusOf };
