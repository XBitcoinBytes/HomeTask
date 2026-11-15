/**
 * workload.js — the single authoritative workload calculation.
 *
 * Every surface that reports "what needs attention now" (Home screen count,
 * Today header, progress indicator, empty states, skip-button visibility)
 * MUST derive from these functions so the numbers can never disagree.
 *
 * Pure module: no DOM, no storage — unit-testable in Node.
 */

/**
 * Classify all tasks into workload buckets.
 *
 * "Requires attention now" =
 *   critical (severely overdue / unresolved safety) +
 *   overdue +
 *   dueToday
 * Future tasks are never counted.
 *
 * @param {Array}    all             All tasks
 * @param {Function} statusFn        task → { type: 'done'|'critical'|'overdue'|'soon'|'future' }
 * @param {Function} effectiveDueFn  task → 'YYYY-MM-DD' | null
 * @param {string}   today           'YYYY-MM-DD'
 * @returns {{critical:number, overdue:number, dueToday:number, doneToday:number,
 *            laterWeek:number, future:number, attention:number}}
 */
export function computeWorkload(all, statusFn, effectiveDueFn, today) {
  let critical = 0, overdue = 0, dueToday = 0, doneToday = 0, laterWeek = 0, future = 0;
  for (const t of all) {
    const { type } = statusFn(t);
    if      (type === 'critical') critical++;
    else if (type === 'overdue')  overdue++;
    else if (type === 'done')     doneToday++;
    else if (type === 'soon') {
      if (effectiveDueFn(t) === today) dueToday++;
      else                              laterWeek++;
    }
    else future++;
  }
  return {
    critical, overdue, dueToday, doneToday, laterWeek, future,
    attention: critical + overdue + dueToday,
  };
}

/**
 * Should a task's Skip controls be visible right now?
 *
 * Skip Today / Skip Week appear only when the task currently requires
 * attention: due today, overdue, severely overdue, or an unresolved safety
 * task. Hidden for future tasks, tasks due later this week, and tasks
 * completed today.
 *
 * @param {string}  statusType  'done'|'critical'|'overdue'|'soon'|'future'
 * @param {boolean} dueIsToday  effectiveDue === today (only relevant for 'soon')
 */
export function isActionableNow(statusType, dueIsToday) {
  return statusType === 'critical' ||
         statusType === 'overdue'  ||
         (statusType === 'soon' && dueIsToday === true);
}

/**
 * Does a task belong in the Today view?
 * Today = attention set + tasks completed today. Never future tasks.
 */
export function belongsInToday(statusType, dueIsToday) {
  return statusType === 'done' || isActionableNow(statusType, dueIsToday);
}
