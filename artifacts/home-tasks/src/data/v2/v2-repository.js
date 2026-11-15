/**
 * v2-repository.js — Disconnected V2Repository (B1).
 *
 * Mirrors the V1Repository public interface so that higher-level domain
 * logic can be written against either implementation. In CP5C-B1 this
 * module is NOT imported by any production entry path; it is disconnected.
 * V2_ACTIVATION_ENABLED=false throughout.
 *
 * All writes go through `writeLockedMutation` (v2-mutation-writer.js) to
 * maintain the crash-safe journal and LIVE-STATE invariants. Reads go
 * directly to the hometask-v2 DATA key and are parsed with the supplied
 * parseFn.
 *
 * V2Repository does NOT perform activation. It expects:
 *   - ACTIVATION_KEYS.MARKER to be present (authority established)
 *   - ACTIVATION_KEYS.LIVE_STATE to be consistent with DATA
 *
 * Cross-context safety: every mutation requires an injected ExclusiveMutationLock
 * that implements lock.runExclusive(txId, async () => result). The lock is
 * acquired BEFORE reading DATA — the entire read → mutate → serialize → write
 * cycle executes inside the callback so that the domain model is always derived
 * from the committed post-lock storage state.  Stale pre-lock observations are
 * never used to produce new DATA, eliminating the lost-update hazard when two
 * independent contexts share the same backing store.
 *
 * The same-instance internal queue serialises concurrent callers within one JS
 * context and is supplementary to (not a substitute for) the exclusive lock.
 *
 * Missing lock → TypeError at construction time (fail-fast).
 */

import { ACTIVATION_KEYS } from '../../v2/activation-tx.js';
import { writeLockedMutation } from './v2-mutation-writer.js';
import { webCryptoDigest } from '../../v2/shadow-fingerprint.js';
import { ADAPTER_TIMEOUT_MS } from '../../v2/shadow-migrate.js';

const DEFAULT_SCHEDULER = {
  setTimeout:   (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id)     => globalThis.clearTimeout(id),
};

/* ── Adapter timeout wrapper ─────────────────────────────────────── */

async function withTimeout(promise, label, timeoutMs, scheduler) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  const p = Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const handle = scheduler.setTimeout(() => {
      p.catch(() => {});
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.then(
      v => { scheduler.clearTimeout(handle); resolve(v); },
      e => { scheduler.clearTimeout(handle); reject(e); },
    );
  });
}

async function aGet(adapter, key, timeoutMs, scheduler) {
  return withTimeout(Promise.resolve(adapter.getItem(key)),
    `getItem("${key}")`, timeoutMs, scheduler);
}

/* ── V2Repository ────────────────────────────────────────────────── */

export class V2Repository {
  /**
   * @param {object} opts
   * @param {{ getItem, setItem, removeItem }} opts.adapter   — storage adapter
   * @param {Function}  opts.parseFn        — parse raw JSON → domain model
   * @param {Function}  opts.serializeFn    — domain model → raw JSON string
   * @param {object}    opts.lock           — ExclusiveMutationLock (required)
   *                                          must implement runExclusive(txId, async fn)
   * @param {Function}  [opts.generateId]   — () → string|null  (injected for testability;
   *                                          defaults to () => null)
   * @param {Function}  [opts.digestFn]     — SHA-256 (injected for testability)
   * @param {number}    [opts.timeoutMs]
   * @param {object}    [opts.scheduler]
   */
  constructor({
    adapter, parseFn, serializeFn, lock,
    generateId, digestFn, timeoutMs, scheduler,
  } = {}) {
    if (!adapter)     throw new TypeError('V2Repository: adapter is required');
    if (!parseFn)     throw new TypeError('V2Repository: parseFn is required');
    if (!serializeFn) throw new TypeError('V2Repository: serializeFn is required');
    if (!lock || typeof lock.runExclusive !== 'function') {
      throw new TypeError(
        'V2Repository: lock (ExclusiveMutationLock with runExclusive) is required. ' +
        'A missing or malformed lock provider cannot guarantee cross-context safety.',
      );
    }

    this._adapter     = adapter;
    this._parseFn     = parseFn;
    this._serializeFn = serializeFn;
    this._lock        = lock;
    this._generateId  = generateId ?? (() => null);
    this._digestFn    = digestFn ?? webCryptoDigest;
    this._timeoutMs   = timeoutMs ?? ADAPTER_TIMEOUT_MS;
    this._scheduler   = scheduler ?? DEFAULT_SCHEDULER;

    /** Serialised mutation queue — prevents reordering within one context. */
    this._queue = Promise.resolve();
  }

  /* ── Read ──────────────────────────────────────────────────────── */

  /**
   * Read and parse the current v2 data.
   * @returns {Promise<{ ok: true, data: * } | { ok: false, code: string, message: string }>}
   */
  async get() {
    let raw;
    try {
      raw = await aGet(this._adapter, ACTIVATION_KEYS.DATA, this._timeoutMs, this._scheduler);
    } catch (e) {
      return { ok: false, code: 'read-failed', message: `Failed to read DATA: ${e?.message ?? e}` };
    }
    if (typeof raw !== 'string' || raw.length === 0) {
      return { ok: false, code: 'data-absent', message: 'hometask-v2 DATA is absent or empty' };
    }
    let data;
    try {
      data = this._parseFn(raw);
    } catch (e) {
      return { ok: false, code: 'parse-failed', message: `Failed to parse DATA: ${e?.message ?? e}` };
    }
    return { ok: true, data };
  }

  /* ── Write ─────────────────────────────────────────────────────── */

  /**
   * Apply a mutation via callback `mutateFn(currentData) → newData`.
   *
   * The entire read → mutate → serialize → write cycle executes inside the
   * exclusive lock callback. This guarantees that:
   *   1. The domain model passed to mutateFn is the post-lock committed state,
   *      not a stale pre-lock observation.
   *   2. Two independent V2Repository instances sharing one backing store and
   *      one lock provider cannot produce a lost update.
   *
   * All calls are additionally serialised through the internal queue to
   * preserve per-instance call ordering within one JS context.
   *
   * @param {Function} mutateFn — receives current domain model; returns new domain model.
   *   May be async. Must not mutate the received object in place.
   * @returns {Promise<{
   *   ok: true
   * } | {
   *   ok: false,
   *   code: string,
   *   message: string
   * }>}
   */
  update(mutateFn) {
    const next = this._queue.then(() => this._applyMutation(mutateFn));
    this._queue = next.catch(() => {});
    return next;
  }

  /** @private */
  async _applyMutation(mutateFn) {
    const txId = this._generateId();

    // Acquire the exclusive lock before reading — the entire read-modify-write
    // cycle runs inside the callback so mutateFn always sees committed state.
    let lockResult;
    try {
      lockResult = await this._lock.runExclusive(txId, async () => {
        // 1. Post-lock read — domain model derived from committed storage state.
        const getResult = await this.get();
        if (!getResult.ok) return getResult;

        // 2. Apply mutation inside lock (no stale pre-lock view used).
        let newData;
        try {
          newData = await Promise.resolve(mutateFn(getResult.data));
        } catch (e) {
          return { ok: false, code: 'mutation-fn-threw', message: `mutateFn threw: ${e?.message ?? e}` };
        }

        // 3. Serialise.
        let newRaw;
        try {
          newRaw = this._serializeFn(newData);
        } catch (e) {
          return { ok: false, code: 'serialize-failed', message: `serializeFn threw: ${e?.message ?? e}` };
        }
        if (typeof newRaw !== 'string' || newRaw.length === 0) {
          return { ok: false, code: 'serialize-empty', message: 'serializeFn returned an empty string' };
        }

        // 4. Write via locked critical section (already inside exclusive lock).
        return writeLockedMutation(
          this._adapter, newRaw, txId,
          this._digestFn, this._timeoutMs, this._scheduler,
        );
      });
    } catch (e) {
      return {
        ok: false, code: 'concurrency-unavailable',
        message: `lock.runExclusive threw: ${e?.message ?? e}`,
      };
    }

    // Provider refused (denied, timeout, etc.) — lock never ran the callback.
    if (!lockResult || lockResult.ok !== true) {
      return {
        ok: false, code: 'concurrency-unavailable',
        message: lockResult?.message ??
                 `Lock denied (code: ${lockResult?.code ?? 'unknown'})`,
      };
    }

    // Unwrap the inner mutation result from the lock envelope.
    return lockResult.result;
  }

  /**
   * Convenience: overwrite entire v2 payload without a read-modify-write.
   * Used during import or reset operations.
   * Requires DATA to be present (get() must succeed inside the lock).
   *
   * @param {*} data — domain model to serialise and write.
   * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
   */
  put(data) {
    return this.update(() => data);
  }
}
