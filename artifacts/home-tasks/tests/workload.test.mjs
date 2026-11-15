/* ================================================================
   workload.test.mjs — count-agreement + skip-visibility regression
   tests for the shared workload module (src/workload.js).

   Guards against:
   - The Home screen count and the Today view disagreeing.
   - Future tasks leaking into the "needs attention" count or Today.
   - Skip buttons appearing on future / later-this-week / done tasks.

   Run:  node artifacts/home-tasks/tests/workload.test.mjs
   Exits non-zero on any failure (CI-friendly).
   ================================================================ */

import { computeWorkload, isActionableNow, belongsInToday } from '../src/workload.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ FAIL: ${name}`); }
}

const TODAY = '2026-07-31';

/* Synthetic catalog covering every status type */
const mk = (id, type, due) => ({ id, type, due });
const CATALOG = [
  mk('t1', 'critical', '2026-07-01'),
  mk('t2', 'critical', '2026-07-10'),
  mk('t3', 'overdue',  '2026-07-28'),
  mk('t4', 'overdue',  '2026-07-29'),
  mk('t5', 'overdue',  '2026-07-30'),
  mk('t6', 'soon',     TODAY),          // due today → attention
  mk('t7', 'soon',     TODAY),          // due today → attention
  mk('t8', 'soon',     '2026-08-02'),   // later this week → NOT attention
  mk('t9', 'soon',     '2026-08-04'),   // later this week → NOT attention
  mk('t10', 'done',    TODAY),
  mk('t11', 'done',    TODAY),
  mk('t12', 'future',  '2026-09-15'),
  mk('t13', 'future',  '2026-10-01'),
];
const statusFn       = t => ({ type: t.type });
const effectiveDueFn = t => t.due;

console.log('\n— computeWorkload bucket counts —');
const wl = computeWorkload(CATALOG, statusFn, effectiveDueFn, TODAY);
check('critical = 2',   wl.critical  === 2);
check('overdue = 3',    wl.overdue   === 3);
check('dueToday = 2',   wl.dueToday  === 2);
check('doneToday = 2',  wl.doneToday === 2);
check('laterWeek = 2',  wl.laterWeek === 2);
check('future = 2',     wl.future    === 2);
check('attention = critical+overdue+dueToday = 7', wl.attention === 7);
check('future tasks never counted in attention',
      wl.attention === 7 && !CATALOG.some(t =>
        t.type === 'future' &&
        isActionableNow(t.type, effectiveDueFn(t) === TODAY)));

console.log('\n— Home ↔ Today count agreement —');
// The Today view membership predicate and the Home attention count must
// agree: attention === (Today-visible tasks that are not done).
const todayVisible = CATALOG.filter(t =>
  belongsInToday(t.type, effectiveDueFn(t) === TODAY));
check('Today shows attention + doneToday tasks',
      todayVisible.length === wl.attention + wl.doneToday);
check('Home count === Today non-done count',
      wl.attention === todayVisible.filter(t => t.type !== 'done').length);
check('Today never includes future tasks',
      !todayVisible.some(t => t.type === 'future'));
check('Today never includes later-this-week tasks',
      !todayVisible.some(t => t.type === 'soon' && t.due !== TODAY));

console.log('\n— Skip-control visibility (isActionableNow) —');
check('critical → skips visible',        isActionableNow('critical', false) === true);
check('overdue → skips visible',         isActionableNow('overdue',  false) === true);
check('soon + due today → visible',      isActionableNow('soon', true)      === true);
check('soon + due later → hidden',       isActionableNow('soon', false)     === false);
check('done today → hidden',             isActionableNow('done', true)      === false);
check('future → hidden',                 isActionableNow('future', false)   === false);

console.log('\n— Edge cases —');
const empty = computeWorkload([], statusFn, effectiveDueFn, TODAY);
check('empty catalog → attention 0', empty.attention === 0);
const allDone = computeWorkload(
  [mk('a', 'done', TODAY), mk('b', 'done', TODAY)], statusFn, effectiveDueFn, TODAY);
check('all done → attention 0, doneToday 2',
      allDone.attention === 0 && allDone.doneToday === 2);
const allFuture = computeWorkload(
  [mk('a', 'future', '2027-01-01')], statusFn, effectiveDueFn, TODAY);
check('all future → attention 0 (caught-up state)', allFuture.attention === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
