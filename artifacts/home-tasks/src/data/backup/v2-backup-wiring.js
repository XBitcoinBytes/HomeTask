/**
 * v2-backup-wiring.js — CP5C-C: V2BackupService assembly factory.
 *
 * A pure dependency-assembly factory.  The caller (the composition root)
 * supplies every runtime dependency; this module validates them and
 * forwards them to V2BackupService.
 *
 * No storage reads, no DOM access, no side effects.
 *
 * NOT imported by any production file while V2_ACTIVATION_ENABLED=false.
 * It is only meaningful to call when bootDecision() returns
 * 'v2-authoritative', which requires V2_ACTIVATION_ENABLED=true —
 * a future checkpoint.  The grep gate enforces the invariant:
 *
 *   grep -r 'v2-backup-wiring' src/app/ script.js sw.js index.html \
 *        src/v2/activation-config.js
 *   → must return zero results.
 */

import { V2BackupService } from './v2-backup-service.js';

/**
 * Construct and return a fully configured V2BackupService instance.
 *
 * Required dependencies:
 *   adapter      — localStorage-compatible { getItem, setItem, removeItem }
 *   catalog      — CATALOG from src/v2/catalog.data.js
 *   appBuild     — non-empty string identifying the current build
 *   delivery     — { canShare():bool, share(blob):Promise<void>, download(blob):void }
 *   fileReader   — { readAsText(file):Promise<string> }
 *   clock        — () => ISO-8601 string (current UTC timestamp)
 *   todayFn      — () => 'YYYY-MM-DD' string (local date)
 *   sessionStore — sessionStorage-compatible { getItem, setItem, removeItem }
 *   lock         — { runExclusive(txId, callback):Promise }
 *
 * Optional dependencies (V2BackupService supplies its own defaults):
 *   digestFn     — (bytes:string) => Promise<string> (hex SHA-256)
 *   timeoutMs    — lock-acquire timeout in ms
 *   scheduler    — custom microtask scheduler
 *
 * @throws {Error} '[HomeTask] createV2BackupService: …' for each missing/invalid dep.
 * @returns {ReturnType<typeof V2BackupService>}
 */
export function createV2BackupService({
  adapter,
  catalog,
  appBuild,
  delivery,
  fileReader,
  clock,
  todayFn,
  sessionStore,
  lock,
  digestFn,
  timeoutMs,
  scheduler,
} = {}) {
  /* ── Required-dep validation ─────────────────────────────────── */
  if (!adapter || typeof adapter.getItem !== 'function')
    throw new Error('[HomeTask] createV2BackupService: adapter required (must have getItem)');

  if (!catalog || typeof catalog !== 'object')
    throw new Error('[HomeTask] createV2BackupService: catalog required');
  if (!Array.isArray(catalog.tasks))
    throw new Error('[HomeTask] createV2BackupService: catalog.tasks[] required');
  if (!Array.isArray(catalog.zones))
    throw new Error('[HomeTask] createV2BackupService: catalog.zones[] required');
  if (typeof catalog.catalogVersion !== 'number')
    throw new Error('[HomeTask] createV2BackupService: catalog.catalogVersion must be a number');

  if (typeof appBuild !== 'string' || !appBuild)
    throw new Error('[HomeTask] createV2BackupService: appBuild must be a non-empty string');

  if (!delivery || typeof delivery.canShare !== 'function')
    throw new Error('[HomeTask] createV2BackupService: delivery required (must have canShare)');

  if (!fileReader || typeof fileReader.readAsText !== 'function')
    throw new Error('[HomeTask] createV2BackupService: fileReader required (must have readAsText)');

  if (typeof clock !== 'function')
    throw new Error('[HomeTask] createV2BackupService: clock must be a function');

  if (typeof todayFn !== 'function')
    throw new Error('[HomeTask] createV2BackupService: todayFn must be a function');

  if (!sessionStore || typeof sessionStore.getItem !== 'function')
    throw new Error('[HomeTask] createV2BackupService: sessionStore required (must have getItem)');

  if (!lock || typeof lock.runExclusive !== 'function')
    throw new Error('[HomeTask] createV2BackupService: lock required (must have runExclusive)');

  /* ── Assemble and return ─────────────────────────────────────── */
  // Optional deps are forwarded only when provided; V2BackupService applies
  // its own defaults (webCryptoDigest, ADAPTER_TIMEOUT_MS, DEFAULT_SCHEDULER)
  // when they are absent.
  return V2BackupService({
    adapter,
    catalog,
    appBuild,
    delivery,
    fileReader,
    clock,
    todayFn,
    sessionStore,
    lock,
    ...(digestFn  !== undefined && { digestFn }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(scheduler !== undefined && { scheduler }),
  });
}
