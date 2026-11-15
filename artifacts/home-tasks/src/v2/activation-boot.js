/**
 * activation-boot.js — pure boot-decision module for CP5B.
 *
 * Contains:
 *   SAFE_V1_ACTIONS      — explicit allowlist of recovery actions that conclusively
 *                          establish v1 authority (must be paired with v2Active:false).
 *   ALL_RECOVERY_ACTIONS — SAFE_V1_ACTIONS + 'committed-verified' + 'ambiguous-state'.
 *                          Used by the parity test to prove coverage of every actual
 *                          recoverActivationStartup() return path.
 *   bootDecision()       — strictly fail-closed gate.
 *
 * Pure module: no localStorage, no DOM, no clock, no side effects.
 * Independently testable. Imported by script.js (runtime) and the test suite.
 *
 * IMPORTANT — SAFE_V1_ACTIONS drift rule:
 *   Every entry is derived from a specific return path in recoverActivationStartup().
 *   If a new recovery action is added to activation-tx.js it MUST be explicitly
 *   classified here (safe-v1) or in bootDecision() (v2-authoritative / ambiguous).
 *   The parity test in v2-activation-bridge.test.mjs enforces this at test time.
 */

/**
 * Explicit allowlist of every recoverActivationStartup() action that
 * conclusively establishes v1 as the authoritative data source.
 *
 * Derivation (source: activation-tx.js return statements):
 *   'none'                          — no staging; storage clean
 *   'cleaned-staged'                — txState:'staged' removed
 *   'cleaned-committed-no-marker'   — txState:'committed' removed
 *   'recovered-v2_written'          — `recovered-${txState}` for 'v2_written'
 *   'recovered-source_changed'      — `recovered-${txState}` for 'source_changed'
 *   'recovered-rollback_failed'     — `recovered-${txState}` for 'rollback_failed'
 *   'source-changed-on-recovery'    — concurrent v1 mutation detected
 *   'quarantined-malformed-staging' — malformed staging quarantined
 *   'retained-malformed-staging'    — quarantine failed; staging retained
 *   'quarantined-unsupported'       — future txVersion
 *   'quarantined-malformed-marker'  — malformed marker quarantined
 *
 * NOTE: 'quarantined-post-commit-failure' was removed in CP5C-B1 when
 * _handlePostCommitFailure was replaced by _recoverLiveState + LIVE-STATE
 * integrity checks. LIVE-STATE mismatch with no recovery → 'ambiguous-state'.
 *
 * All 11 entries carry v2Active:false. Any entry paired with v2Active:true → 'indeterminate'.
 *
 * @type {ReadonlySet<string>}
 */
export const SAFE_V1_ACTIONS = Object.freeze(new Set([
  'none',
  'cleaned-staged',
  'cleaned-committed-no-marker',
  'recovered-v2_written',
  'recovered-source_changed',
  'recovered-rollback_failed',
  'source-changed-on-recovery',
  'quarantined-malformed-staging',
  'retained-malformed-staging',
  'quarantined-unsupported',
  'quarantined-malformed-marker',
]));

/**
 * B1: every action that establishes v2 as the authoritative data source.
 * All carry v2Active:true. Any entry paired with v2Active:false → 'indeterminate'.
 *
 * Derivation (source: activation-tx.js return statements):
 *   'committed-verified'                 — LIVE-STATE matches DATA; normal committed path
 *   'legacy-committed'                   — pre-B1 fixture; sha256(DATA)==marker.v2DataDigest; LIVE-STATE gen 0 created
 *   'mutation-recovered-complete-step3'  — journal: DATA matches newDigest; LIVE-STATE written
 *   'mutation-recovered-revert-step2'    — journal: DATA matches prevDigest; LIVE-STATE reverted
 *   'mutation-recovered-restore-data'    — journal: DATA restored from prevRaw; LIVE-STATE written
 *
 * @type {ReadonlySet<string>}
 */
export const V2_ACTIVE_RECOVERY_ACTIONS = Object.freeze(new Set([
  'committed-verified',
  'legacy-committed',
  'mutation-recovered-complete-step3',
  'mutation-recovered-revert-step2',
  'mutation-recovered-restore-data',
]));

/**
 * Complete set of every action recoverActivationStartup() can return.
 * = SAFE_V1_ACTIONS ∪ V2_ACTIVE_RECOVERY_ACTIONS ∪ { 'ambiguous-state' }
 *
 * The parity test reads activation-tx.js source, extracts every action string
 * (including template-literal expansions), and asserts exact set equality here.
 * A newly added recovery action that does not appear in this union causes the
 * parity test to fail until it is explicitly classified.
 *
 * @type {ReadonlySet<string>}
 */
export const ALL_RECOVERY_ACTIONS = Object.freeze(new Set([
  ...SAFE_V1_ACTIONS,
  ...V2_ACTIVE_RECOVERY_ACTIONS,
  'ambiguous-state',
]));

/**
 * Strictly fail-closed boot authority gate.
 *
 * Returns one of:
 *   'boot-v1'          — v1 authority conclusively established; safe to run app.init().
 *   'v2-authoritative' — v2 committed and verified; do NOT run writable v1 app (CP5C).
 *   'ambiguous'        — authority indeterminate; do NOT run writable v1 app.
 *   'indeterminate'    — unknown, malformed, forged, or contradictory input; do NOT run app.
 *
 * The ONLY paths to 'boot-v1':
 *   1. Exact disabled result:  { status:'disabled' } with no v2Active or action field.
 *   2. Exact ok result:        { status:'ok', action ∈ SAFE_V1_ACTIONS, v2Active === false }.
 *
 * Everything else — null, undefined, extra authority fields on disabled, unknown actions,
 * forged shapes, contradictory v2Active pairings — produces 'indeterminate'.
 *
 * With V2_ACTIVATION_ENABLED=false the bridge always returns { status:'disabled' }
 * and this function always returns 'boot-v1'. No user-visible change.
 *
 * @param {unknown} result
 * @returns {'boot-v1'|'v2-authoritative'|'ambiguous'|'indeterminate'}
 */
export function bootDecision(result) {
  // null, undefined, or non-object — cannot safely inspect fields
  if (result == null || typeof result !== 'object') return 'indeterminate';

  const { status, action, v2Active } = result;

  // ── Disabled path ────────────────────────────────────────────────
  // Only the exact disabled result { status:'disabled' } is permitted.
  // Any v2Active or action field is forged or contradictory → indeterminate.
  if (status === 'disabled') {
    if ('v2Active' in result || 'action' in result) return 'indeterminate';
    return 'boot-v1';
  }

  // ── All remaining paths require status:'ok' ──────────────────────
  if (status !== 'ok') return 'indeterminate';

  // v2-authoritative: any V2_ACTIVE_RECOVERY_ACTIONS action + v2Active:true.
  // These actions conclusively establish v2 authority (LIVE-STATE verified or
  // recovered). Any v2-active action paired with v2Active:false → indeterminate.
  if (V2_ACTIVE_RECOVERY_ACTIONS.has(action)) {
    return v2Active === true ? 'v2-authoritative' : 'indeterminate';
  }

  // Ambiguous: ONLY ambiguous-state + v2Active:false.
  // ambiguous-state + v2Active:true → indeterminate (contradictory).
  if (action === 'ambiguous-state') {
    return v2Active === false ? 'ambiguous' : 'indeterminate';
  }

  // Safe v1: action must be in the explicit allowlist AND v2Active must be exactly false.
  // Missing action, unknown action, or any allowlisted action with v2Active:true → indeterminate.
  if (v2Active === false && SAFE_V1_ACTIONS.has(action)) return 'boot-v1';

  return 'indeterminate';
}
