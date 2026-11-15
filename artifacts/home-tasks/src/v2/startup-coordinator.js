/**
 * startup-coordinator.js — E2 boundary for deferred V2Repository construction.
 *
 * This module is loaded only after activation recovery has conclusively
 * established v2 authority. The disabled path returns before loading this
 * module, and this function returns before loading V2Repository when the
 * compile-time activation flag is false.
 */

import { V2_ACTIVATION_ENABLED } from './activation-config.js';

/**
 * Create the production cross-context lock only for an enabled v2 boot.
 * No fallback lock is allowed: a missing Web Locks API must fail closed rather
 * than weaken the mutation contract.
 */
export function createBrowserV2Lock() {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') {
    throw new Error('V2 startup requires the Web Locks API');
  }

  return {
    async runExclusive(_txId, callback) {
      try {
        return await locks.request(
          'hometask-v2-mutation',
          { mode: 'exclusive' },
          async () => {
            try {
              return { ok: true, result: await callback() };
            } catch (error) {
              return {
                ok: false,
                code: 'callback-threw',
                message: error?.message ?? String(error),
              };
            }
          },
        );
      } catch (error) {
        return {
          ok: false,
          code: 'lock-failed',
          message: error?.message ?? String(error),
        };
      }
    },
  };
}

/**
 * Construct V2Repository only on the explicitly enabled path.
 *
 * The returned repository is intentionally not connected to the v1 UI or
 * backup facade in E2. Disabled callers receive the exact inert result before
 * any import, backing access, lock creation, timer, or repository construction.
 */
export async function maybeCreateV2Repository(opts = {}) {
  const enabled = opts.enabled ?? V2_ACTIVATION_ENABLED;
  if (!enabled) return { status: 'disabled' };

  const backing = opts.backing;
  if (!backing || typeof backing.getItem !== 'function' ||
      typeof backing.setItem !== 'function' || typeof backing.removeItem !== 'function') {
    return { status: 'failed', error: 'V2 startup requires a storage backing' };
  }

  let lock;
  try {
    lock = opts.lock ?? createBrowserV2Lock();
  } catch (error) {
    return { status: 'failed', error: error?.message ?? String(error) };
  }

  try {
    const loadModule = opts._loadModule
      ?? (specifier => import(specifier));
    const { V2Repository } = await loadModule('../data/v2/v2-repository.js');
    const repo = new V2Repository({
      adapter:     backing,
      parseFn:     JSON.parse,
      serializeFn: JSON.stringify,
      lock,
      digestFn:    opts.digestFn,
      timeoutMs:   opts.timeoutMs,
      scheduler:   opts.scheduler,
    });
    return { status: 'ready', repo };
  } catch (error) {
    return { status: 'failed', error: error?.message ?? String(error) };
  }
}