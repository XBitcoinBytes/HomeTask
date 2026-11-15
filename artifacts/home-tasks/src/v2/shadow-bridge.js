/**
 * shadow-bridge.js — runtime wiring for the CP4A shadow-migration runner.
 *
 * Responsibilities (exactly):
 *   1. Read the compile-time flag (shadow-config.js).
 *   2. When disabled: return { status: 'disabled' } immediately — zero
 *      side effects, zero storage reads, zero timers, zero console output.
 *   3. When enabled: dynamically import the CP4A runner and catalog,
 *      create (or accept an injected) storage adapter, supply all required
 *      context, capture the structured privacy-safe result, and ensure no
 *      rejected Promise escapes the bridge.
 *
 * This module contains NO migration logic.  Domain migration, equivalence,
 * fingerprint, and shadow-wrapper logic remain in src/v2/shadow-migrate.js
 * and its dependencies.
 *
 * The committed value of SHADOW_MIGRATION_ENABLED is false.
 * Enabling it requires a reviewed source-code change to shadow-config.js.
 * No visible UI is added by this module.
 *
 * Called by script.js via:
 *   app.init().then(() => {
 *     maybeShadowMigrate({ appBuild: APP_BUILD }).catch(() => {});
 *   });
 * The shadow .catch() is self-contained inside the .then() callback so
 * that an app.init() failure (if any) is NOT masked.  The boot chain
 * resolves without awaiting the shadow Promise, so shadow work is
 * fire-and-forget and never blocks startup or the first render.
 */

import { SHADOW_MIGRATION_ENABLED } from './shadow-config.js';

/* ── Production localStorage adapter ─────────────────────────────── */

/**
 * Create a minimal localStorage adapter for the shadow runner.
 *
 * Contract:
 *   - Returns the exact stored string or null (localStorage semantics).
 *   - Propagates native localStorage exceptions to the runner for
 *     structured handling (QuotaExceededError, SecurityError, etc.).
 *   - Never enumerates, clears, or mutates broad storage.
 *   - Never calls localStorage.clear().
 *   - Never removes v1 keys or unrelated keys.
 *   - removeItem throws — the shadow runner only reads and writes its
 *     own key; remove is never called in the migration protocol.
 *
 * Tests inject a mock adapter via opts.adapter; this function is only
 * called in a production browser context when the flag is enabled.
 *
 * @returns {{ getItem: Function, setItem: Function, removeItem: Function }}
 */
export function createLocalStorageAdapter() {
  return {
    getItem:    (key) => localStorage.getItem(key),
    setItem:    (key, value) => localStorage.setItem(key, value),
    removeItem: () => {
      throw new Error(
        'shadow bridge: removeItem is not permitted — ' +
        'the shadow runner only reads source keys and writes the shadow key',
      );
    },
  };
}

/* ── Bridge entry point ──────────────────────────────────────────── */

/**
 * Conditionally run the shadow migration behind the compile-time flag.
 *
 * Disabled path (SHADOW_MIGRATION_ENABLED === false):
 *   Returns { status: 'disabled' } with zero side effects.
 *   No v2 module is imported, no storage is touched, no timers are
 *   registered, no console output is emitted.
 *
 * Enabled path (SHADOW_MIGRATION_ENABLED === true):
 *   Dynamically imports the runner and catalog, creates or uses the
 *   supplied adapter, runs the migration, and returns the runner's
 *   structured result.  Any thrown exception is caught and returned as
 *   { status: 'failed', error: string } — no exception escapes.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.enabled]     Override compile-time flag (tests only).
 * @param {object}  [opts.adapter]     Injected storage adapter (tests only).
 *                                     Production path calls createLocalStorageAdapter().
 * @param {string}  [opts.today]       'YYYY-MM-DD' (defaults to real clock).
 * @param {string}  [opts.clock]       ISO timestamp  (defaults to real clock).
 * @param {string}  [opts.appBuild]    Application build string (passed by script.js).
 * @param {number}  [opts.timeoutMs]   Per-operation timeout override.
 * @param {object}  [opts.scheduler]   Injected mock scheduler (tests only).
 * @param {object}  [opts._testHooks]  Passed to runner._testHooks (tests only).
 * @param {Function} [opts._loadModule] Dynamic-import trap (tests only).
 *
 * @returns {Promise<{
 *   status: 'disabled'|'verified'|'failed',
 *   ok?: boolean,
 *   [key: string]: unknown
 * }>}
 */
export async function maybeShadowMigrate(opts = {}) {
  const enabled = opts.enabled ?? SHADOW_MIGRATION_ENABLED;

  /* ── Disabled path: zero side effects ────────────────────────── */
  if (!enabled) {
    return { status: 'disabled' };
  }

  /* ── Enabled path ────────────────────────────────────────────── */
  try {
    // Dynamic imports — only executed when the flag is enabled.
    // Disabled builds never evaluate shadow-migrate.js or its dependencies.
    const loadModule = opts._loadModule ?? (specifier => import(specifier));
    const [
      { runShadowMigration, ADAPTER_TIMEOUT_MS },
      { CATALOG },
    ] = await Promise.all([
      loadModule('./shadow-migrate.js'),
      loadModule('./catalog.data.js'),
    ]);

    // Use the injected adapter (tests) or create a real localStorage adapter.
    const adapter = opts.adapter ?? createLocalStorageAdapter();

    // today and clock default to the real wall clock; tests inject fixed values.
    const now   = new Date();
    const today = opts.today ?? [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    const clock = opts.clock ?? now.toISOString();

    const result = await runShadowMigration({
      adapter,
      catalog:    CATALOG,
      today,
      clock,
      appBuild:   opts.appBuild ?? 'unknown',
      timeoutMs:  opts.timeoutMs ?? ADAPTER_TIMEOUT_MS,
      scheduler:  opts.scheduler,
      _testHooks: opts._testHooks ?? {},
    });

    return result;
  } catch (e) {
    // No exception may escape the bridge.
    return { status: 'failed', error: e?.message ?? String(e) };
  }
}
