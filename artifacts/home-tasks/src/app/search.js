/* Extracted mechanically from src/script.js lines 1046–1106 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── Search module ────────────────────────────────────────────── */
const search = (() => {
  // Alias pairs — searching either word also finds results for the other.
  // Substring matching handles bath/bathroom naturally; aliases cover
  // cases where the words share no common substring (couch/sofa etc.).
  const _ALIASES = {
    'couch':    ['sofa'],
    'sofa':     ['couch'],
    'trash':    ['garbage'],
    'garbage':  ['trash'],
    'office':   ['study'],
    'study':    ['office'],
    'bath':     ['bathroom'],
    'bathroom': ['bath'],
  };

  /**
   * Expand a normalized query with alias terms.
   * 'couch' → ['couch', 'sofa']
   * 'bath room' → ['bath room', 'bath', 'room', 'bathroom']
   */
  function expandTerms(q) {
    const terms = new Set([q]);
    q.split(/\s+/).filter(Boolean).forEach(word => {
      (_ALIASES[word] ?? []).forEach(alias => terms.add(alias));
      // Simple singularization so "Bathrooms" finds "Bathroom" rooms
      if (word.length > 3 && word.endsWith('s')) {
        const singular = word.slice(0, -1);
        terms.add(singular);
        (_ALIASES[singular] ?? []).forEach(alias => terms.add(alias));
      }
    });
    return [...terms];
  }

  /**
   * Filter tasks by query and optional room.
   *
   * Query is case-insensitive and whitespace-normalized.
   * Room filter restricts to tasks in that specific room.
   * Alias expansion: "couch" also matches "sofa" and vice versa.
   * Matching fields: title, room, tags.
   */
  function filter(allTasks, query, roomFilter) {
    const q = (query ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return allTasks.filter(t => {
      if (roomFilter && t.room !== roomFilter) return false;
      if (!q) return true;
      const terms  = expandTerms(q);
      const titleL = t.title.toLowerCase();
      const roomL  = t.room.toLowerCase();
      return terms.some(term =>
        titleL.includes(term) ||
        roomL.includes(term)  ||
        t.tags.some(tag => tag.toLowerCase().includes(term))
      );
    });
  }

  return { filter, expandTerms };
})();

export { search };
