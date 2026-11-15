/**
 * activation-bridge.js — runtime wiring for CP5B activation startup recovery.
 *
 * Responsibilities (exactly):
 *   1. Read the compile-time flag (activation-config.js).
 *   2. When disabled: return { status:'disabled' } immediately — zero side
 *      effects, zero storage reads or writes, zero timers, zero dynamic
 *      imports of activation-tx.js, zero console output.
 *   3. When enabled: dynamically import activation-tx.js, create (or accept
 *      an injected) storage adapter, supply all required context including the
 *      authoritative webCryptoDigest function, call recoverActivationStartup(),
 *      and return a structured result. Any exception is caught and returned as
 *      { status:'failed', error: string } — never rejects.
 *
 * Called by script.js BEFORE app.init() so that activation recovery completes
 * before any authoritative storage read (tasks.js lazification defers the
 * hometask-v1 read until app.init() calls tasks.getAll()).
 *
 * This module contains NO recovery logic. All domain logic is in activation-tx.js.
 *
 * opts._loadModule — injected by tests to:
 *   (a) prove the disabled path never invokes dynamic imports (trap function);
 *   (b) supply the pre-imported activation-tx module for enabled-path tests.
 *   Production code never passes _loadModule; the literal import() is used.
 */

import { V2_ACTIVATION_ENABLED } from './activation-config.js';
import { webCryptoDigest }       from './shadow-fingerprint.js';

/**
 * Create a minimal localStorage adapter for the recovery runner.
 *
 * Exposes only the operations required by the activation controller.
 * Tests inject a mock adapter via opts.adapter; this function is only
 * called in production when the flag is enabled.
 *
 * @returns {{ getItem: Function, setItem: Function, removeItem: Function, keys: Function }}
 */
export function createLocalStorageAdapter() {
  return {
    getItem:    (key)        => localStorage.getItem(key),
    setItem:    (key, value) => localStorage.setItem(key, value),
    removeItem: (key)        => localStorage.removeItem(key),
    keys:       ()           => Object.keys(localStorage),
  };
}

/**
 * Conditionally run activation startup recovery behind the compile-time flag.
 *
 * Disabled path (V2_ACTIVATION_ENABLED === false):
 *   Returns { status:'disabled' } synchronously-equivalent — no storage,
 *   no timers, no dynamic imports, no console output.
 *
 * Enabled path (V2_ACTIVATION_ENABLED === true):
 *   Dynamically imports activation-tx.js, creates or uses the supplied
 *   adapter, calls recoverActivationStartup() with the authoritative
 *   webCryptoDigest helper, and returns a structured { status, action,
 *   v2Active, detail } result. Any thrown exception is caught and returned
 *   as { status:'failed', error: string }. Never rejects.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.enabled]      Override compile-time flag (tests only).
 * @param {object}   [opts.adapter]      Injected storage adapter (tests only).
 * @param {string}   [opts.clock]        ISO timestamp (defaults to real clock).
 * @param {Function} [opts.digestFn]     Digest function (defaults to webCryptoDigest).
 * @param {number}   [opts.timeoutMs]    Per-operation timeout override.
 * @param {object}   [opts.scheduler]    Injected mock scheduler (tests only).
 * @param {Function} [opts._loadModule]  Dynamic-import trap (tests only).
 *
 * @returns {Promise<{ status:'disabled' } | { status:'ok', action:string, v2Active:boolean, detail:string|null } | { status:'failed', error:string }>}
 */
export async function maybeRecoverActivation(opts = {}) {
  const enabled = opts.enabled ?? V2_ACTIVATION_ENABLED;

  /* ── Disabled path: zero side effects ─────────────────────────── */
  if (!enabled) {
    return { status: 'disabled' };
  }

  /* ── Enabled path ──────────────────────────────────────────────── */
  // opts._loadModule is injected by tests to prove the disabled path never
  // calls dynamic import, and to supply a pre-imported module for isolation.
  // Production always uses the literal specifier so Vite can trace the chunk.
  try {
    const { recoverActivationStartup } = opts._loadModule
      ? await opts._loadModule('./activation-tx.js')
      : await import('./activation-tx.js');

    const adapter  = opts.adapter  ?? createLocalStorageAdapter();
    const clock    = opts.clock    ?? new Date().toISOString();
    const digestFn = opts.digestFn ?? webCryptoDigest;

    // Pass timeoutMs and scheduler as positional arguments.
    // When undefined, recoverActivationStartup() uses its own defaults
    // (ADAPTER_TIMEOUT_MS and DEFAULT_SCHEDULER from its module scope).
    const result = await recoverActivationStartup(
      adapter,
      clock,
      digestFn,
      opts.timeoutMs,   // undefined → function default applies
      opts.scheduler,   // undefined → function default applies
    );

    _logRecoveryResult(result);

    // Build return explicitly — never spread result to prevent internal
    // fields from overwriting the bridge's 'status' field.
    return {
      status:   'ok',
      action:   result.action,
      v2Active: result.v2Active,
      detail:   result.detail ?? null,
    };
  } catch (e) {
    console.error('[HomeTask] Activation recovery threw unexpectedly:', e?.message ?? e);
    return { status: 'failed', error: e?.message ?? String(e) };
  }
}

/* ── Internal log helper ───────────────────────────────────────── */

function _logRecoveryResult({ action, v2Active } = {}) {
  if (!action || action === 'none') return;  // clean state — silent
  const WARN_ACTIONS = new Set([
    'source-changed-on-recovery',
    'quarantined-malformed-staging',
    'retained-malformed-staging',
    'quarantined-malformed-marker',
    'quarantined-unsupported',
    'quarantined-post-commit-failure',
    'ambiguous-state',
  ]);
  if (v2Active) {
    console.info('[HomeTask] Activation: v2 committed and verified (', action, ')');
  } else if (WARN_ACTIONS.has(action)) {
    console.warn('[HomeTask] Activation recovery:', action);
  } else {
    console.info('[HomeTask] Activation recovery:', action);
  }
}
