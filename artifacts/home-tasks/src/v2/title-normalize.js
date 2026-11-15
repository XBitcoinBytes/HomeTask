/**
 * title-normalize.js — pure v2 mirror of the permanent HomeTask title policy.
 *
 * This is a structural copy of `normalizeTaskTitle` from src/app/catalog.js,
 * maintained here so src/v2 modules remain disconnected from the production
 * runtime during CP3. The two implementations must stay in sync; contract
 * tests in tests/v2-backup.test.mjs verify they agree on every policy case.
 *
 * Policy (identical to the production normalizer):
 *   • Trim leading/trailing whitespace; collapse repeated internal spaces.
 *   • For each whitespace-separated word: capitalize the first character and
 *     preserve ALL remaining characters exactly as they appear in the input.
 *     This means "cLEAN" becomes "CLEAN" (not "Clean"), and "DOG" stays "DOG".
 *     Only the FIRST character of each word is ever uppercased — the rest is
 *     untouched. Do not assume arbitrary mixed-case input becomes title case
 *     in the English sense; "cLEAN FLOOR" → "CLEAN FLOOR", not "Clean Floor".
 *   • Hyphenated words: each segment processed recursively
 *     (e.g. "mother-in-law" → "Mother-In-Law").
 *   • Apostrophes: first letter of the token is uppercased; rest preserved
 *     (e.g. "don't" → "Don't").
 *   • Recognized acronyms (HEPA, UV, AC, CO, CO2): returned fully upper-case
 *     regardless of position (these are checked BEFORE the first-char rule).
 *   • Numbers and mixed tokens: first character uppercased if alphabetic, rest
 *     preserved (e.g. "3m" → "3m" since '3' has no uppercase variant).
 *   • Returns '' for invalid, null, undefined, or whitespace-only input.
 *
 * IMPORTANT: Do not normalize arbitrary tags — tags have no approved Title
 * Case policy. Only call this on display-name fields (task titles, zone
 * titles, title overrides).
 *
 * Pure module: no storage, no DOM, no clock.
 */

const _TITLE_ACRONYMS = new Set(['HEPA', 'UV', 'AC', 'CO', 'CO2']);

function _normWord(word) {
  if (!word) return '';
  // Acronym check: compare upper-cased word; if it matches, return fully upper-case.
  if (_TITLE_ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
  // Hyphenated: capitalize each segment recursively.
  if (word.includes('-')) return word.split('-').map(_normWord).join('-');
  // Standard: capitalize first letter, leave ALL remaining characters as-is.
  // "cLEAN" → charAt(0).toUpperCase() + slice(1) = "C" + "LEAN" = "CLEAN"
  // "DOG"   → charAt(0).toUpperCase() + slice(1) = "D" + "OG"   = "DOG"
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Normalize a user-visible task or zone display name using the canonical policy.
 * Returns '' for any non-string or whitespace-only input.
 *
 * Important: this is NOT general English title case. It capitalizes only the
 * FIRST character of each word and preserves the rest verbatim. Callers must
 * not assume that "cLEAN FLOOR" becomes "Clean Floor" — the actual result is
 * "CLEAN FLOOR".
 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed.split(' ').map(_normWord).join(' ');
}
