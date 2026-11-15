/* Extracted mechanically from src/script.js lines 1650–1705 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { addDays, todayStr } from './util.js';
import { SAFETY_TASK_IDS } from './catalog.js';
import { tasks } from './tasks.js';

/* ── Onboarding module ────────────────────────────────────────── */
/**
 * Smart Start — shown once to users who have no completion history.
 *
 * maybeShow() → Promise<{choice, overrides}|null>
 *   Resolves immediately with null if onboarding should be skipped.
 *   Otherwise shows the dialog and resolves when the user makes a choice.
 *
 * Safety tasks (SAFETY_TASK_IDS) are intentionally excluded from overrides
 * so they remain in the "Never done" (red/critical) state regardless of choice.
 */
const onboarding = (() => {
  const obDialog  = document.getElementById('onboarding-dialog');
  const obBalanced = document.getElementById('ob-balanced');
  const obCurrent  = document.getElementById('ob-current');

  /** Injected V1Repository — set once by app.init(repo) before first render. */
  let _repo = null;

  function setRepo(r) {
    if (!r || typeof r !== 'object')
      throw new Error('[HomeTask] onboarding.setRepo: invalid repository');
    if (_repo === null) { _repo = r; return; }
    if (_repo === r)   return;
    throw new Error('[HomeTask] onboarding.setRepo: repository already set — late authority swap rejected');
  }

  function maybeShow() {
    // Skip if already onboarded
    if (_repo.loadPrefs().onboarded) return Promise.resolve(null);
    // Skip if any task has history (existing user whose meta was lost)
    if (tasks.getAll().some(t => t.lastDone !== null)) return Promise.resolve(null);

    return new Promise(resolve => {
      obDialog.showModal();

      function handleChoice(choice) {
        const today     = todayStr();
        const nonSafety = tasks.getAll().filter(t => !SAFETY_TASK_IDS.has(t.id));
        let overrides;

        if (choice === 'balanced') {
          // Spread first due dates across the next 30 days
          const N = nonSafety.length;
          overrides = nonSafety.map((t, i) => ({
            id:        t.id,
            skipUntil: addDays(today, Math.floor(i * 30 / N)),
          }));
        } else {
          // 'current' — act as if everything was just done
          overrides = nonSafety.map(t => ({
            id:        t.id,
            skipUntil: addDays(today, t.intervalDays),
          }));
        }

        obDialog.close();
        resolve({ choice, overrides });
      }

      obBalanced.addEventListener('click', () => handleChoice('balanced'), { once: true });
      obCurrent.addEventListener('click',  () => handleChoice('current'),  { once: true });
    });
  }

  return { maybeShow, setRepo };
})();

export { onboarding };
