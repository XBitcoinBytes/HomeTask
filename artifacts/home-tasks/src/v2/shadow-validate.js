/**
 * shadow-validate.js — canonical shadow-wrapper validation.
 *
 * Single source of truth for isValidVerifiedWrapper(), shared by:
 *   - shadow-migrate.js  (preservation check on existing shadow keys)
 *   - shadow-presenter.js (defense-in-depth before building shareable report)
 *
 * No imports. The fingerprint check is inlined; no external dependency is
 * required.
 *
 * Design constraint — candidate check (condition 5):
 *   This module uses a structural shape assertion rather than the full
 *   validateEnvelope() call. validateEnvelope() lives in migrate.js, which
 *   is only dynamically reachable (imported inside the shadow runner). Making
 *   migrate.js statically reachable would break the dynamic-import isolation
 *   that protects initial-load performance.
 *
 *   shadow-migrate.js still calls validateEnvelope() independently at step 4
 *   of each migration run, so every candidate that reaches a completed run has
 *   already passed full envelope validation. This module adds defense-in-depth
 *   without duplicating migrate.js's dependency.
 *
 * All six conditions mirror the original inline isValidVerifiedWrapper in
 * shadow-migrate.js. The only intentional difference is condition 5.
 */

/** Must match SHADOW_SCHEMA_VERSION in shadow-migrate.js. */
const SHADOW_SCHEMA_VERSION_EXPECTED = 1;
/** v2 schema number. */
const TARGET_SCHEMA_EXPECTED = 2;
/** 64 lowercase hex chars — SHA-256 digest. Inlined to avoid importing shadow-fingerprint.js. */
const CANONICAL_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Structural shape check for the canonical 9-field v2 envelope.
 * Does not call validateEnvelope() — see module comment.
 *
 * @param {unknown} c
 * @returns {boolean}
 */
function hasValidCandidateShape(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  return (
    Array.isArray(c.state)                                            &&
    Array.isArray(c.userZones)                                        &&
    Array.isArray(c.userTasks)                                        &&
    Array.isArray(c.completionEvents)                                 &&
    c.overrides !== null && typeof c.overrides === 'object' &&
      !Array.isArray(c.overrides)                                     &&
    Array.isArray(c.recentSearches)                                   &&
    c.prefs !== null && typeof c.prefs === 'object' &&
      !Array.isArray(c.prefs)                                         &&
    c.meta !== null && typeof c.meta === 'object' &&
      !Array.isArray(c.meta)                                          &&
    typeof c.schemaVersion === 'number'
  );
}

/**
 * Canonical wrapper validation — all six conditions must pass.
 *
 *   1. shadowSchemaVersion === SHADOW_SCHEMA_VERSION_EXPECTED (1)
 *   2. status === 'verified'
 *   3. sourceFingerprint is a 64-char lowercase hex SHA-256 digest
 *   4. targetSchema === TARGET_SCHEMA_EXPECTED (2)
 *   5. candidate has the expected 9-field envelope shape (structural check)
 *   6. verificationSummary.unexpectedDiffCount === 0 and
 *      verificationSummary.diffCategoryCodes is an empty array
 *
 * A wrapper claiming status:'verified' that fails any condition returns false.
 * Filtering, coercing, or partial acceptance are never performed.
 *
 * @param {unknown} w
 * @returns {boolean}
 */
export function isValidVerifiedWrapper(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return false;
  // 1. Schema version must match exactly.
  if (w.shadowSchemaVersion !== SHADOW_SCHEMA_VERSION_EXPECTED) return false;
  // 2. Status must be the literal string "verified".
  if (w.status !== 'verified') return false;
  // 3. sourceFingerprint must be a canonical 64-char lowercase hex digest.
  if (typeof w.sourceFingerprint !== 'string' ||
      !CANONICAL_FINGERPRINT_RE.test(w.sourceFingerprint)) return false;
  // 4. targetSchema must be TARGET_SCHEMA_EXPECTED.
  if (w.targetSchema !== TARGET_SCHEMA_EXPECTED) return false;
  // 5. candidate must have the expected 9-field envelope shape.
  if (!hasValidCandidateShape(w.candidate)) return false;
  // 6. verificationSummary must be consistent with a genuinely verified result.
  const vs = w.verificationSummary;
  if (!vs || typeof vs !== 'object' || Array.isArray(vs)) return false;
  if (vs.unexpectedDiffCount !== 0) return false;
  if (!Array.isArray(vs.diffCategoryCodes) || vs.diffCategoryCodes.length !== 0) return false;
  return true;
}
