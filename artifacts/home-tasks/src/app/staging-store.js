/* Extracted mechanically from src/script.js lines 1831–1887 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── Import staging store ─────────────────────────────────────── */
/**
 * Manages hometask-import-staging-v1 — atomic import transaction state.
 *
 * Staging object shape:
 *   {
 *     txState:     'staged' | 'committing' | 'committed',
 *     startedAt:   ISO string,
 *     committedAt: ISO string | null,
 *     keysToWrite: string[],
 *     keysWritten: string[],   — updated after each successful final write
 *     data:        { [key]: jsonString },
 *   }
 *
 * txState semantics (used by startup rollback to determine recovery action):
 *   'staged'          — data validated in memory and in staging; no final writes started
 *   'committing'      — final writes started (some keysWritten may be present)
 *   'committed'       — all final writes succeeded; only cleanup (removeItem) pending
 *   'rollback_failed' — mid-commit failure occurred AND automatic rollback also failed;
 *                       staging and snapshot are intentionally retained so startup can
 *                       retry rollback and/or the user can use Undo Last Import.
 *                       Extra fields: rollbackError, keysRestored[], failedAt, lastRetryAt?
 *
 * On startup, only 'committed' is safe to discard without rollback.
 * 'rollback_failed' triggers a single retry attempt per startup (no infinite loop).
 */
const stagingStore = (() => {
  const KEY = 'hometask-import-staging-v1';

  function get() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch { return false; }
  }

  function patch(updates) {
    try {
      const current = get();
      if (!current) return false;
      localStorage.setItem(KEY, JSON.stringify({ ...current, ...updates }));
      return true;
    } catch { return false; }
  }

  function clear() {
    try { localStorage.removeItem(KEY); return true; }
    catch { return false; }
  }

  return { KEY, get, save, patch, clear };
})();

export { stagingStore };
