/* Extracted mechanically from src/script.js lines 733–803 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { todayStr } from './util.js';
import { SEED_TASKS } from './catalog.js';
import { recoveryStore } from './recovery.js';

/* ── Storage module ───────────────────────────────────────────── */
const storage = (() => {
  const KEY = 'hometask-v1';

  /**
   * Load tasks from localStorage.
   *
   * First use (key absent): seeds from SEED_TASKS.
   * Subsequent loads: merges saved user data (lastDone, skipUntil, tags,
   * doneToday) back onto the canonical SEED_TASKS shape so title/room/interval
   * corrections in SEED_TASKS are applied automatically.
   *
   * Migration from Phase 1: skipUntil field semantics changed from
   * "hide until this date" to "effective due date override." Both are
   * compatible — an old past-skipUntil is simply treated as a past due date.
   */
  function load() {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const seeded = SEED_TASKS.map(t => ({ ...t }));
      _write(seeded);
      console.info('[HomeTask] First use — seeded', seeded.length, 'tasks');
      return seeded;
    }

    let saved;
    try { saved = JSON.parse(raw); } catch {
      // Preserve the actual raw damaged string (capped at 250 KB) so the
      // user can retrieve it via Download Recovery Data in Backup & Restore.
      recoveryStore.save('hometask-v1', raw);
      console.error(
        '[HomeTask] Task storage is damaged — starting from catalog defaults. ' +
        'Open Backup & Restore for more information.'
      );
      saved = [];
    }

    const savedMap = new Map(saved.map(t => [t.id, t]));
    const today = todayStr();

    return SEED_TASKS.map(seed => {
      const s = savedMap.get(seed.id);
      if (!s) return { ...seed };

      // Explicit whitelist: ONLY user-state fields may come from storage.
      // Catalog fields (title, room, intervalDays, tags schema, safety
      // classification) always come from the seed — so a saved lowercase
      // title like "Clean baseboards" never overrides "Clean Baseboards",
      // and an outdated intervalDays is silently corrected on next load.
      return {
        ...seed,            // authoritative: id, title, room, intervalDays, tags default
        lastDone:  s.lastDone  ?? null,          // user-state: allowed to override
        doneToday: s.lastDone === today ? Boolean(s.doneToday) : false,
        skipUntil: s.skipUntil ?? null,          // user-state: allowed to override
        tags:      Array.isArray(s.tags) ? s.tags : [],
      };
    });
  }

  function save(taskList) { _write(taskList); }

  function _write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {
      console.error('[HomeTask] Failed to save task data:', e?.name ?? e);
    }
  }

  return { load, save };
})();

export { storage };
