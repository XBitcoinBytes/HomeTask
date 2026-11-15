/**
 * shadow-presenter.js — pure presentation adapter for the shadow diagnostic.
 *
 * Converts a raw bridge result into a validated UI model:
 *   { phase: "running" | "verified" | "needs-review" | "idle",
 *     safeReport: null | <strict-allowlisted-report>,
 *     shareAllowed: boolean }
 *
 * Isolation rules:
 *   - Only this module inspects the raw bridge result and wrapper.
 *   - backup-ui.js receives only the { phase, safeReport, shareAllowed } model.
 *   - The full candidate object is never forwarded to the UI layer.
 *
 * Validation rules:
 *   - isValidVerifiedWrapper() is called first; any failure → needs-review.
 *   - Every field is validated individually; no silent filtering or repair.
 *   - If any field fails, the entire report is rejected → needs-review.
 *   - Counts are accepted only when finite, non-negative, safe integers.
 *   - Arrays are rejected if any entry is invalid OR if the array exceeds
 *     its maximum length (no truncation, no filtering).
 *   - Boolean fields must be actual booleans (not truthy/falsy values).
 */

import { isValidVerifiedWrapper } from './shadow-validate.js';

/* ── Allowlist constants ─────────────────────────────────────────── */

/** Max entries for sanitizedFieldCategories. */
const MAX_FIELD_CATEGORIES = 20;
/** Max entries for diffCategoryCodes. */
const MAX_DIFF_CODES = 30;
/** Approved category-code pattern for sanitizedFieldCategories. */
const SAFE_FIELD_CATEGORY = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
/** Approved code pattern for diffCategoryCodes. */
const SAFE_DIFF_CODE = /^[A-Z][A-Z0-9_:]{0,63}$/;
/** Expected schema version constants. */
const SOURCE_SCHEMA_EXPECTED         = 1;
const TARGET_SCHEMA_EXPECTED         = 2;
const SHADOW_SCHEMA_VERSION_EXPECTED = 1;

/* ── safeInt ─────────────────────────────────────────────────────── */

/**
 * Return v if it is a finite non-negative safe integer; otherwise null.
 * @param {unknown} v
 * @returns {number|null}
 */
function safeInt(v) {
  if (typeof v !== 'number')    return null;
  if (!Number.isFinite(v))      return null;
  if (!Number.isSafeInteger(v)) return null;
  if (v < 0)                    return null;
  return v;
}

/* ── buildSafeRepairs ────────────────────────────────────────────── */

/**
 * Build the strict allowlisted repairsFromMigration object.
 * Returns null if any field fails — no filtering, no repair.
 *
 * @param {unknown} r  — verificationSummary.repairsFromMigration
 * @returns {object|null}
 */
function buildSafeRepairs(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;

  // Boolean fields must be actual booleans (not truthy/falsy).
  if (typeof r.roomFilterResolved !== 'boolean') return null;
  if (typeof r.dueNowDefaultFold  !== 'boolean') return null;

  // sanitizedFieldCategories: array required; any invalid entry rejects all;
  // exceeding the maximum rejects (no truncation).
  if (!Array.isArray(r.sanitizedFieldCategories)) return null;
  if (r.sanitizedFieldCategories.length > MAX_FIELD_CATEGORIES) return null;
  for (const c of r.sanitizedFieldCategories) {
    if (typeof c !== 'string' || !SAFE_FIELD_CATEGORY.test(c)) return null;
  }

  // Scalar counts must be finite non-negative safe integers.
  const d = safeInt(r.droppedUnknownIdsCount);
  const m = safeInt(r.malformedCount);
  const n = safeInt(r.normalizedDoneTodayCount);
  const s = safeInt(r.sanitizedFieldsCount);
  if (d === null || m === null || n === null || s === null) return null;

  return {
    droppedUnknownIdsCount:   d,
    malformedCount:           m,
    normalizedDoneTodayCount: n,
    sanitizedFieldsCount:     s,
    sanitizedFieldCategories: r.sanitizedFieldCategories, // already validated above
    roomFilterResolved:       r.roomFilterResolved,
    dueNowDefaultFold:        r.dueNowDefaultFold,
  };
}

/* ── buildSafeReport ─────────────────────────────────────────────── */

/**
 * Build the strict allowlisted shareable report.
 * Called only after isValidVerifiedWrapper() passes.
 * Returns null if any field fails — no filtering, no repair.
 *
 * @param {object} bridgeResult  — raw result from maybeShadowMigrate()
 * @returns {object|null}
 */
function buildSafeReport(bridgeResult) {
  const w  = bridgeResult.wrapper;
  const vs = w?.verificationSummary;
  if (!w  || typeof w  !== 'object') return null;
  if (!vs || typeof vs !== 'object') return null;

  // ── Schema versions must equal expected constants ──
  if (w.sourceSchema        !== SOURCE_SCHEMA_EXPECTED)         return null;
  if (w.targetSchema        !== TARGET_SCHEMA_EXPECTED)         return null;
  if (w.shadowSchemaVersion !== SHADOW_SCHEMA_VERSION_EXPECTED) return null;

  // ── String scalars — bounded format ──
  if (typeof w.appBuild !== 'string' ||
      w.appBuild.length === 0 ||
      w.appBuild.length > 64) return null;
  if (typeof w.generatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(w.generatedAt)) return null;

  // ── Numeric scalars ──
  const catVersion = safeInt(w.catalogVersion);
  if (catVersion === null) return null;

  // ── unexpectedDiffCount must be 0 (verified run) — defense-in-depth ──
  if (vs.unexpectedDiffCount !== 0) return null;

  // ── Count fields from verificationSummary ──
  const stateCount           = safeInt(vs.stateCount);
  const userZoneCount        = safeInt(vs.userZoneCount);
  const userTaskCount        = safeInt(vs.userTaskCount);
  const completionEventCount = safeInt(vs.completionEventCount);
  const overrideCount        = safeInt(vs.overrideCount);
  const recentSearchCount    = safeInt(vs.recentSearchCount);
  const unexpectedDiffCount  = safeInt(vs.unexpectedDiffCount); // already checked === 0
  if ([stateCount, userZoneCount, userTaskCount, completionEventCount,
       overrideCount, recentSearchCount, unexpectedDiffCount].some(c => c === null)) return null;

  // ── diffCategoryCodes — strict, no filtering, no truncation ──
  if (!Array.isArray(vs.diffCategoryCodes)) return null;
  if (vs.diffCategoryCodes.length > MAX_DIFF_CODES) return null;
  for (const c of vs.diffCategoryCodes) {
    if (typeof c !== 'string' || !SAFE_DIFF_CODE.test(c)) return null;
  }
  // Deduplicate (entries are already individually validated).
  const diffCategoryCodes = [...new Set(vs.diffCategoryCodes)];

  // ── warnings must be an array; count only ──
  if (!Array.isArray(bridgeResult.warnings)) return null;
  const warningCount = safeInt(bridgeResult.warnings.length);
  if (warningCount === null) return null;

  // ── byteSize ──
  const byteSize = safeInt(bridgeResult.byteSize);
  if (byteSize === null) return null;

  // ── repairsFromMigration — field-by-field via buildSafeRepairs ──
  // repairsFromMigration is never copied wholesale; each field is validated
  // individually so a future migration change cannot silently add raw values.
  const repairsFromMigration = buildSafeRepairs(vs.repairsFromMigration);
  if (!repairsFromMigration) return null;

  return {
    _type:   'HomeTask Upgrade Check Report',
    _notice: 'This report contains migration counts and technical status only. ' +
             'It does not include task names, room names, task history, ' +
             'searches, or stored values.',
    build: w.appBuild, catalogVersion: catVersion,
    sourceSchema: w.sourceSchema, targetSchema: w.targetSchema,
    shadowSchemaVersion: w.shadowSchemaVersion,
    status: 'verified', generatedAt: w.generatedAt, byteSize,
    stateCount, userZoneCount, userTaskCount, completionEventCount,
    overrideCount, recentSearchCount, unexpectedDiffCount, warningCount,
    repairsFromMigration, diffCategoryCodes,
  };
}

/* ── buildPresentation ───────────────────────────────────────────── */

/**
 * Convert a raw bridge result into a validated UI presentation model.
 *
 * The full candidate object and raw wrapper are never included in the output.
 * A malformed or incomplete wrapper claiming status:'verified' never produces
 * phase:'verified' or enables sharing.
 *
 * @param {unknown} result  — raw result from maybeShadowMigrate()
 * @returns {{ phase: string, safeReport: object|null, shareAllowed: boolean }}
 */
export function buildPresentation(result) {
  if (!result || typeof result !== 'object') {
    return { phase: 'needs-review', safeReport: null, shareAllowed: false };
  }
  if (result.status === 'disabled') {
    return { phase: 'idle', safeReport: null, shareAllowed: false };
  }
  if (result.status !== 'verified') {
    return { phase: 'needs-review', safeReport: null, shareAllowed: false };
  }

  // ── Full wrapper validation (canonical checks) ──
  // A wrapper claiming status:'verified' that fails any of the six conditions
  // (schema version, fingerprint, candidate shape, diffCategoryCodes empty, etc.)
  // produces needs-review with sharing disabled. No exceptions.
  if (!isValidVerifiedWrapper(result.wrapper)) {
    return { phase: 'needs-review', safeReport: null, shareAllowed: false };
  }

  // ── Strict field-by-field allowlist ──
  // Any field that is absent, malformed, out of range, or the wrong type rejects
  // the entire report. No filtering, no truncation, no silent repair.
  const safeReport = buildSafeReport(result);
  if (!safeReport) {
    return { phase: 'needs-review', safeReport: null, shareAllowed: false };
  }

  return { phase: 'verified', safeReport, shareAllowed: true };
}
