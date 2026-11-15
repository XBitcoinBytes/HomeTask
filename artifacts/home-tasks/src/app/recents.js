/* Extracted mechanically from src/script.js lines 1108–1139 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── Recent Searches module ───────────────────────────────────── */
/**
 * Persists the last 5 search queries the user typed.
 * Stored in hometask-recent-searches-v1.
 * Rules: max 5, deduplicated case-insensitively, newest first.
 * Empty or result-less searches are NOT saved by the caller.
 */
const recentSearches = (() => {
  const KEY = 'hometask-recent-searches-v1';
  const MAX = 5;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function add(q) {
    const term = (q ?? '').trim();
    if (!term) return;
    const existing = load().filter(s => s.toLowerCase() !== term.toLowerCase());
    existing.unshift(term);
    try { localStorage.setItem(KEY, JSON.stringify(existing.slice(0, MAX))); } catch (_) {}
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (_) {}
  }

  return { load, add, clear };
})();

export { recentSearches };
