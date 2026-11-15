/* Extracted mechanically from src/script.js lines 805–866 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { recoveryStore } from './recovery.js';

/* ── Meta module ──────────────────────────────────────────────── */
/**
 * Persists app-level preferences and onboarding state.
 *
 * Shape: {
 *   onboarded:     boolean   — true after Smart Start choice is made
 *   choice:        string|null — 'balanced' | 'current'
 *   completedAt:   string|null — YYYY-MM-DD when onboarding was completed
 *   dueNowDefault: boolean   — persisted toggle state
 *   roomFilter:    string    — persisted room filter ('' = All rooms)
 * }
 */
const meta = (() => {
  const KEY = 'hometask-meta-v1';
  const DEFAULTS = {
    onboarded:     false,
    choice:        null,
    completedAt:   null,
    dueNowDefault: false,    // kept for migration only
    viewMode:      'today',  // 'today' | 'week' | 'all'
    roomFilter:    '',
  };

  function load() {
    let raw;
    try {
      raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      const saved   = JSON.parse(raw);
      const merged  = { ...DEFAULTS, ...saved };
      // Migrate dueNowDefault → viewMode for users without a saved viewMode
      // true  → 'week'  (user was seeing "due now" — keep a filtered view)
      // false → 'all'   (user had explicitly turned the filter off — honour it)
      // absent/undefined → 'today' (new user, best default)
      if (!saved.viewMode) {
        if (saved.dueNowDefault === true)       merged.viewMode = 'week';
        else if (saved.dueNowDefault === false)  merged.viewMode = 'all';
        else                                     merged.viewMode = 'today';
      }
      return merged;
    } catch {
      // Preserve damaged meta content for recovery
      if (raw) recoveryStore.save('hometask-meta-v1', raw);
      return { ...DEFAULTS };
    }
  }

  function save(patch) {
    try {
      const current = load();
      localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }));
    } catch (e) {
      console.error('[HomeTask] Failed to save preferences:', e?.name ?? e);
    }
  }

  function exportJSON() {
    return JSON.stringify(load(), null, 2);
  }

  return { load, save, exportJSON };
})();

export { meta };
