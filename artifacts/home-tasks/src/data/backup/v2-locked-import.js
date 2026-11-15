/**
 * v2-locked-import.js — Lock-scoped import, undo, and startup recovery for v2.
 *
 * All transaction-state reads occur inside lock.runExclusive. Lock failure returns
 * concurrency-unavailable before any storage read or write.
 *
 *   runV2LockedImport  — snapshot + staging + writeLockedMutation inside one lock.
 *   runV2LockedUndo    — snapshot read + writeLockedMutation + snapshot clear inside one lock.
 *   recoverV2Startup   — coordinator: acquires lock once; calls recoverMutationStartup
 *                        then import-staging reconciliation, no nested locking.
 *
 * Monotonic generation rule:
 *   Normal path (writeLockedMutation): nextGen = LIVE-STATE.generation + 1 (read inside lock).
 *   Recovery path (recoverMutationStartup/Phase 1): writes LIVE-STATE directly, NOT via
 *   writeLockedMutation. Case A: generation = journal.generation. Case B/C: generation =
 *   max(0, journal.generation − 1). Both paths hold the coordinator lock; neither decreases
 *   generation below the last verifiably committed value.
 *
 * Pure module: no localStorage, no sessionStorage, no DOM, no clock reads.
 * All impure inputs are injected (adapter, lock, digestFn, clock/now, timeoutMs, scheduler).
 * Disconnected from production startup until C.
 */

import { ACTIVATION_KEYS, recoverMutationStartup }        from '../../v2/activation-tx.js';
import { writeLockedMutation, parseLiveState }             from '../v2/v2-mutation-writer.js';
import { V2_KEYS }                                         from '../../v2/import-tx.js';
import { webCryptoDigest }                                 from '../../v2/shadow-fingerprint.js';
import { ADAPTER_TIMEOUT_MS }                              from '../../v2/shadow-migrate.js';

/* ── Public constants ────────────────────────────────────────────── */

export const IMPORT_STAGING_TX_VERSION = 1;
/** Maximum bytes stored in a quarantine record's rawData field. */
export const IMPORT_STAGING_QUARANTINE_MAX_RAW = 250 * 1024;

/* ── Default scheduler ───────────────────────────────────────────── */

const DEFAULT_SCHEDULER = {
  setTimeout:   (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id)     => globalThis.clearTimeout(id),
};

/* ── Timeout helper ──────────────────────────────────────────────── */

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

/* ── Lock timeout wrapper (exported for focused testing) ─────────── */

/**
 * Call lock.runExclusive(txId, callback), racing it against a scheduler-injected
 * deadline.  If the lock's Promise does not settle within timeoutMs the outer
 * Promise RESOLVES with { ok:false, code:'lock-timeout' } — never rejects — so
 * both the import/undo and the coordinator route it through their normal
 * !lockResult.ok guard without a separate catch branch.
 *
 * The lock's Promise is given a no-op rejection handler the moment it is
 * created, so any late rejection after the timeout fires is swallowed rather
 * than becoming an unhandled-rejection event.  Late resolution after timeout is
 * also silently discarded (the outer Promise is already settled).
 *
 * Ghost-commit guard: FIFO-queuing lock providers (e.g. async-mutex) enqueue
 * the callback immediately and dispatch it only when the lock slot opens, which
 * may be after the outer promise has already resolved with lock-timeout.  The
 * `cancelled` flag is set to true before that resolve, and the `guardedCallback`
 * wrapper checks it at entry — ensuring the real mutation body is never entered
 * and zero storage writes occur in that late-dispatch race.
 *
 * timeoutMs ≤ 0 disables the race entirely and delegates straight through.
 *
 * @param {object}   lock        — runExclusive(txId, callback) required
 * @param {string}   txId
 * @param {Function} callback    — the real mutation body; never called if cancelled
 * @param {number}   timeoutMs   — 0 = disabled (pass-through)
 * @param {object}   scheduler   — { setTimeout, clearTimeout }
 * @returns {Promise<*>}         — lock result, or { ok:false, code:'lock-timeout' }
 */
export function withLockTimeout(lock, txId, callback, timeoutMs, scheduler) {
  // `cancelled` is set to true the moment the timeout fires, before the outer
  // promise resolves.  `guardedCallback` checks it at the very start so that
  // a callback dispatched after the timeout (by a FIFO-queuing lock) exits
  // immediately with zero storage operations.
  let cancelled = false;
  const guardedCallback = async () => {
    if (cancelled) {
      return {
        ok:      false,
        code:    'lock-timeout',
        message: 'Lock acquired after timeout had already fired; operation skipped.',
      };
    }
    return callback();
  };

  const lockPromise = lock.runExclusive(txId, guardedCallback);

  if (!timeoutMs || timeoutMs <= 0) return lockPromise;

  // Attach a silent rejection handler immediately so any late rejection (after
  // the timeout has already fired and the outer Promise is settled) is handled
  // and never surfaces as an unhandled-rejection event.
  lockPromise.catch(() => {});

  return new Promise((resolve, reject) => {
    const handle = scheduler.setTimeout(() => {
      cancelled = true;   // guard must be set before resolving the outer promise
      resolve({ ok: false, code: 'lock-timeout', message: 'Lock acquisition timed out.' });
    }, timeoutMs);

    lockPromise.then(
      r => { scheduler.clearTimeout(handle); resolve(r); },
      e => { scheduler.clearTimeout(handle); reject(e); },
    );
  });
}

/* ── Lock guard ──────────────────────────────────────────────────── */

function checkLock(lock) {
  if (!lock || typeof lock.runExclusive !== 'function') {
    throw new TypeError(
      'v2-locked-import: a lock implementing runExclusive(txId, callback) is required.',
    );
  }
}

/* ── Digest helper ───────────────────────────────────────────────── */

async function computeDigest(raw, digestFn, label, timeoutMs, scheduler) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const bytes = new TextEncoder().encode(raw);
  return withTimeout(Promise.resolve(digestFn(bytes)), label, timeoutMs, scheduler);
}

/* ── Synchronous adapter helpers ─────────────────────────────────── */

function aGet(adapter, key) {
  try { return adapter.getItem(key); } catch { return null; }
}

/** Write + byte-exact readback verify. Returns { ok, error? }. */
function aSetVerify(adapter, key, value) {
  try {
    adapter.setItem(key, value);
    const rb = adapter.getItem(key);
    if (rb !== value) return { ok: false, error: `readback-mismatch:${key}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `write-failed:${key}:${e?.message ?? e}` };
  }
}

function aRemove(adapter, key) {
  try { adapter.removeItem(key); } catch {}
}

/* ── Backup-key merge helpers (lock-scoped; caller holds the lock) ── */

function backupRead(adapter) {
  try {
    const raw = aGet(adapter, V2_KEYS.BACKUP);
    return (raw ? JSON.parse(raw) : {}) ?? {};
  } catch { return {}; }
}

/**
 * Read the backup record, set one field, write + byte-exact verify.
 * Preserves all other fields (lastExport survives snapshot write, etc.).
 * Returns { ok } | { ok:false, error }.
 */
function backupMerge(adapter, field, value) {
  const current  = backupRead(adapter);
  const merged   = { ...current, [field]: value };
  return aSetVerify(adapter, V2_KEYS.BACKUP, JSON.stringify(merged));
}

/**
 * Read the backup record, delete one field, write + byte-exact verify.
 * Returns { ok } | { ok:false, error }.
 */
function backupDeleteField(adapter, field) {
  const current = backupRead(adapter);
  if (!(field in current)) return { ok: true };
  const merged = { ...current };
  delete merged[field];
  return aSetVerify(adapter, V2_KEYS.BACKUP, JSON.stringify(merged));
}

/* ── Import staging helpers ──────────────────────────────────────── */

function stagingRead(adapter) {
  try {
    const raw = aGet(adapter, V2_KEYS.STAGING);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Write + byte-exact verify. Returns true on success. */
function stagingWrite(adapter, record) {
  const serialized = JSON.stringify(record);
  return aSetVerify(adapter, V2_KEYS.STAGING, serialized).ok;
}

function stagingPatch(adapter, updates) {
  const cur = stagingRead(adapter);
  if (!cur) return false;
  return stagingWrite(adapter, { ...cur, ...updates });
}

function stagingClear(adapter) { aRemove(adapter, V2_KEYS.STAGING); }

/* ── txId generation ─────────────────────────────────────────────── */

let _txCounter = 0;
function makeTxId(prefix, seed) {
  return `${prefix}:${seed}:${++_txCounter}`;
}

/* ── Malformed staging quarantine ────────────────────────────────── */

/**
 * Write a bounded copy of rawBytes to hometask-recovery-v2 + byte-exact verify.
 * Returns { ok:true } on success.
 * On any failure returns { ok:false, error } — caller MUST retain original staging bytes.
 * @private
 */
function _quarantineImportStaging(adapter, rawBytes, reason, clock) {
  const bounded = (typeof rawBytes === 'string')
    ? rawBytes.slice(0, IMPORT_STAGING_QUARANTINE_MAX_RAW)
    : '';
  const record = JSON.stringify({
    source: V2_KEYS.STAGING, reason, detectedAt: clock, rawData: bounded,
  });
  const wr = aSetVerify(adapter, V2_KEYS.RECOVERY, record);
  return wr.ok ? { ok: true } : { ok: false, error: wr.error };
}

/* ═══════════════════════════════════════════════════════════════════
   runV2LockedImport
═══════════════════════════════════════════════════════════════════ */

/**
 * Execute a v2 import inside one exclusive lock callback.
 *
 * Write sequence (all inside lock.runExclusive):
 *   0. Read staging (rollback guard), LIVE-STATE, DATA — fail closed if invalid.
 *   1. Snapshot: merge-write into hometask-backup-v2.snapshot + verify.
 *   2. Staging: write + verify hometask-import-staging-v2 (txState:'staged').
 *   3. writeLockedMutation — sole journal+DATA+LIVE-STATE engine (called inside held lock).
 *   4s. Clear staging (ownership-checked: transactionId match). Snapshot retained for undo.
 *   On wLM failure: patch staging to 'failed'; return ok:false. No second rollback.
 *
 * @param {{ getItem, setItem, removeItem }} adapter
 * @param {string}   dataStr    — serialised v2 envelope to import (non-empty)
 * @param {object}   lock       — ExclusiveMutationLock with runExclusive(txId, callback)
 * @param {string}   now        — ISO timestamp (injected; used for snapshot.savedAt)
 * @param {Function} [digestFn]
 * @param {number}   [timeoutMs]
 * @param {object}   [scheduler]
 * @returns {Promise<{ok:true,message:string}|{ok:false,code:string,message:string}>}
 */
export async function runV2LockedImport(
  adapter, dataStr, lock, now,
  digestFn  = webCryptoDigest,
  timeoutMs = ADAPTER_TIMEOUT_MS,
  scheduler = DEFAULT_SCHEDULER,
) {
  if (typeof dataStr !== 'string' || dataStr.length === 0) {
    return { ok: false, code: 'invalid-input', message: 'dataStr must be a non-empty string.' };
  }
  checkLock(lock); // TypeError before any lock or storage interaction

  const txId = makeTxId('import', now);

  let lockResult;
  try {
    lockResult = await withLockTimeout(lock, txId, async () => {

      // ── 0a: rollback_failed guard (first read inside lock) ──────
      const existingStaging = stagingRead(adapter);
      if (existingStaging?.txState === 'rollback_failed') {
        return { ok: false, code: 'blocked-rollback-failed',
          message: 'A previous import could not be recovered automatically. Restore your data before importing again.' };
      }

      // ── 0b: validate LIVE-STATE ─────────────────────────────────
      const lsRaw = aGet(adapter, ACTIVATION_KEYS.LIVE_STATE);
      if (!parseLiveState(lsRaw)) {
        return { ok: false, code: 'live-state-invalid',
          message: 'LIVE-STATE is absent or malformed. Cannot import without a verified v2 authority state.' };
      }

      // ── 0c: validate DATA ───────────────────────────────────────
      const currentData = aGet(adapter, ACTIVATION_KEYS.DATA);
      if (typeof currentData !== 'string' || currentData.length === 0) {
        return { ok: false, code: 'data-absent',
          message: 'v2 DATA is absent or empty. Cannot import without an established data record.' };
      }

      // ── 0d: compute digests ─────────────────────────────────────
      let sourceDigest, targetDigest;
      try {
        [sourceDigest, targetDigest] = await Promise.all([
          computeDigest(currentData, digestFn, 'source-digest', timeoutMs, scheduler),
          computeDigest(dataStr,     digestFn, 'target-digest', timeoutMs, scheduler),
        ]);
      } catch (e) {
        return { ok: false, code: 'digest-failed',
          message: `Digest computation failed: ${e?.message ?? e}` };
      }

      // ── 1: snapshot (merge-write; preserves lastExport) ─────────
      const snapshot = {
        transactionId: txId, savedAt: now, sourceDigest, targetDigest,
        keys: { [ACTIVATION_KEYS.DATA]: currentData },
      };
      const snapWr = backupMerge(adapter, 'snapshot', snapshot);
      if (!snapWr.ok) {
        return { ok: false, code: 'snapshot-failed',
          message: `Snapshot could not be saved (${snapWr.error}). Your data has not been changed.` };
      }

      // ── 2: staging (write + verify) ─────────────────────────────
      const stagingRecord = {
        txVersion: IMPORT_STAGING_TX_VERSION,
        txState: 'staged',
        transactionId: txId, startedAt: now, sourceDigest, targetDigest,
      };
      if (!stagingWrite(adapter, stagingRecord)) {
        return { ok: false, code: 'staging-failed',
          message: 'Import staging could not be saved. Your data has not been changed.' };
      }

      // ── 3: writeLockedMutation — sole journal+DATA+LIVE-STATE engine ──
      // Called from inside the already-held lock; no nested lock acquisition.
      const wlmResult = await writeLockedMutation(
        adapter, dataStr, txId, digestFn, timeoutMs, scheduler,
      );

      if (!wlmResult.ok) {
        if (wlmResult.code === 'data-write-failed') {
          // 'rolled-back' only when wLM confirmed both: DATA readback matched prevRaw
          // AND journal removal was verified absent (readback returned null).
          // Any other combination → 'rollback-failed' with journal retained for startup recovery.
          const surfaceCode = (wlmResult.dataRestoreOk && wlmResult.journalCleanupOk)
            ? 'rolled-back'
            : 'rollback-failed';
          stagingPatch(adapter, { txState: 'failed', failCode: surfaceCode });
          return {
            ok: false, code: surfaceCode,
            message: (wlmResult.dataRestoreOk && wlmResult.journalCleanupOk)
              ? 'Import failed; your previous data has been restored automatically.'
              : 'Import failed and automatic recovery was incomplete. ' +
                'Diagnostic evidence is preserved for startup recovery.',
          };
        }
        // All other wLM failure codes: forward unchanged; snapshot evidence retained.
        stagingPatch(adapter, { txState: 'failed', failCode: wlmResult.code });
        return { ok: false, code: wlmResult.code, message: wlmResult.message };
      }

      // ── 4s: clear staging (ownership-checked) ───────────────────
      const stagingAfter = stagingRead(adapter);
      if (stagingAfter?.transactionId === txId) {
        stagingClear(adapter);
      }
      // Snapshot retained for undo.

      return { ok: true, message: 'Backup restored.' };
    }, timeoutMs, scheduler);
  } catch (e) {
    return { ok: false, code: 'concurrency-unavailable',
      message: `lock.runExclusive threw: ${e?.message ?? e}` };
  }

  if (!lockResult || !lockResult.ok) {
    return { ok: false, code: 'concurrency-unavailable',
      message: lockResult?.message ?? `Lock denied (code: ${lockResult?.code ?? 'unknown'})` };
  }
  return lockResult.result;
}

/* ═══════════════════════════════════════════════════════════════════
   runV2LockedUndo
═══════════════════════════════════════════════════════════════════ */

/**
 * Undo the last import: restore DATA to snapshot bytes as a forward mutation.
 * All reads and writes inside lock.runExclusive.
 *
 * LIVE-STATE.generation advances (never reverts). The restored DATA bytes are
 * byte-for-byte identical to those in the snapshot, but the generation and
 * LIVE-STATE record reflect the new commit, not the pre-import commit.
 *
 * Snapshot is cleared only when its transactionId still matches the value read
 * at step 0b (ownership check; inside the held lock — no TOCTOU possible).
 *
 * @param {{ getItem, setItem, removeItem }} adapter
 * @param {object}   lock
 * @param {Function} [digestFn]
 * @param {number}   [timeoutMs]
 * @param {object}   [scheduler]
 * @returns {Promise<{ok:true,message:string}|{ok:false,code:string,message:string}>}
 */
export async function runV2LockedUndo(
  adapter, lock,
  digestFn  = webCryptoDigest,
  timeoutMs = ADAPTER_TIMEOUT_MS,
  scheduler = DEFAULT_SCHEDULER,
) {
  checkLock(lock);

  const undoTxId = makeTxId('undo', String(Date.now()));

  let lockResult;
  try {
    lockResult = await withLockTimeout(lock, undoTxId, async () => {

      // ── 0a: rollback_failed guard ────────────────────────────────
      const existingStaging = stagingRead(adapter);
      if (existingStaging?.txState === 'rollback_failed') {
        return { ok: false, code: 'blocked-rollback-failed',
          message: 'A previous import could not be recovered. Restore your data before undoing.' };
      }

      // ── 0b: read snapshot (inside lock) ─────────────────────────
      const backupRecord = backupRead(adapter);
      const snap = backupRecord.snapshot ?? null;
      if (!snap) {
        return { ok: false, code: 'no-snapshot', message: 'No import snapshot available to undo.' };
      }

      // ── 0c: validate snapshot ────────────────────────────────────
      if (typeof snap.transactionId !== 'string' ||
          typeof snap.sourceDigest  !== 'string' ||
          typeof snap.targetDigest  !== 'string' ||
          typeof snap.keys          !== 'object') {
        return { ok: false, code: 'snapshot-malformed', message: 'Snapshot record is malformed.' };
      }
      const snapData = snap.keys[ACTIVATION_KEYS.DATA];
      if (snapData === null || snapData === undefined) {
        return { ok: false, code: 'cannot-undo-to-absent-data',
          message: 'Snapshot captured an absent DATA state; undo is not possible.' };
      }

      // ── 0d: validate LIVE-STATE ──────────────────────────────────
      const lsRaw = aGet(adapter, ACTIVATION_KEYS.LIVE_STATE);
      if (!parseLiveState(lsRaw)) {
        return { ok: false, code: 'live-state-invalid',
          message: 'LIVE-STATE is absent or malformed. Cannot undo.' };
      }

      // ── 0e: ownership check ──────────────────────────────────────
      // Current DATA must still equal the imported bytes (snapshot.targetDigest).
      // If DATA was mutated after the import, undo is no longer safe/available.
      const currentData = aGet(adapter, ACTIVATION_KEYS.DATA);
      let currentDigest;
      try {
        currentDigest = await computeDigest(
          currentData ?? '', digestFn, 'ownership-digest', timeoutMs, scheduler,
        );
      } catch (e) {
        return { ok: false, code: 'digest-failed', message: `Digest failed: ${e?.message ?? e}` };
      }
      if (currentDigest !== snap.targetDigest) {
        return { ok: false, code: 'snapshot-stale',
          message: 'DATA has changed since the import was captured; undo is no longer available.' };
      }

      // ── 1: writeLockedMutation with historical bytes (forward mutation) ──
      // Generation advances to LIVE-STATE.generation + 1 (post-lock read inside wLM).
      const wlmResult = await writeLockedMutation(
        adapter, snapData, undoTxId, digestFn, timeoutMs, scheduler,
      );
      if (!wlmResult.ok) {
        // Journal evidence retained; snapshot retained for potential retry.
        return { ok: false, code: wlmResult.code, message: wlmResult.message };
      }

      // ── 2: clear snapshot (ownership-checked, merge-delete + verify) ─
      const backupNow = backupRead(adapter);
      if (backupNow.snapshot?.transactionId === snap.transactionId) {
        backupDeleteField(adapter, 'snapshot'); // best-effort; orphan harmless
      }

      return { ok: true, message: 'Import undone.' };
    }, timeoutMs, scheduler);
  } catch (e) {
    return { ok: false, code: 'concurrency-unavailable',
      message: `lock.runExclusive threw: ${e?.message ?? e}` };
  }

  if (!lockResult || !lockResult.ok) {
    return { ok: false, code: 'concurrency-unavailable',
      message: lockResult?.message ?? `Lock denied (code: ${lockResult?.code ?? 'unknown'})` };
  }
  return lockResult.result;
}

/* ═══════════════════════════════════════════════════════════════════
   recoverV2Startup — coordinator
═══════════════════════════════════════════════════════════════════ */

/**
 * Startup recovery coordinator.
 *
 * Acquires the shared lock ONCE. Inside a single callback (no nested locking):
 *   Phase 1 — recoverMutationStartup (no lock param; no nested lock).
 *              May write LIVE-STATE, DATA (restore case), and MUT_JOURNAL directly.
 *   Phase 2 — import-staging reconciliation (same lock callback).
 *              Clears/quarantines hometask-import-staging-v2 as appropriate.
 *
 * Malformed staging: quarantine (bounded write + byte-exact verify) then clear.
 * If quarantine fails, original staging bytes are retained.
 *
 * Recovery order: mutation recovery always runs first; import staging
 * reconciliation runs second, after DATA+LIVE-STATE are consistent.
 *
 * Disconnected from production startup until C.
 *
 * @param {{ getItem, setItem, removeItem }} adapter
 * @param {object}      lock
 * @param {object|null} marker   — structurally-validated activation marker (or null)
 * @param {string}      clock    — ISO timestamp (injected)
 * @param {Function}    [digestFn]
 * @param {number}      [timeoutMs]
 * @param {object}      [scheduler]
 * @returns {Promise<{ action:string, v2Active:boolean, stagingAction:string, detail?:string }>}
 */
export async function recoverV2Startup(
  adapter, lock, marker, clock,
  digestFn  = webCryptoDigest,
  timeoutMs = ADAPTER_TIMEOUT_MS,
  scheduler = DEFAULT_SCHEDULER,
) {
  checkLock(lock);

  let lockResult;
  try {
    lockResult = await withLockTimeout(lock, 'startup-recovery', async () => {

      // Phase 1: mutation recovery.
      // recoverMutationStartup has no lock parameter and makes no lock calls.
      // It may write LIVE-STATE, DATA (Case C restore), and MUT_JOURNAL (clear) directly.
      const mutResult = await recoverMutationStartup(
        adapter, marker, clock, digestFn, timeoutMs, scheduler,
      );

      if (!mutResult.v2Active) {
        return { ...mutResult, stagingAction: 'skipped' };
      }

      // Phase 2: import-staging reconciliation (same lock callback).
      const stagingRaw = aGet(adapter, V2_KEYS.STAGING);
      if (!stagingRaw) {
        return { ...mutResult, stagingAction: 'none' };
      }

      let staging = null;
      try { staging = JSON.parse(stagingRaw); } catch {}

      if (!staging || typeof staging !== 'object') {
        // Malformed: bounded quarantine + byte-exact readback; failure retains original.
        const qr = _quarantineImportStaging(adapter, stagingRaw, 'malformed', clock);
        if (qr.ok) {
          stagingClear(adapter);
          return { ...mutResult, stagingAction: 'quarantined-malformed' };
        }
        return { ...mutResult, stagingAction: 'retained-malformed', detail: qr.error };
      }

      if (staging.txState === 'staged') {
        // Phase 1 has made DATA+LIVE-STATE consistent.
        // Compare sha256(DATA) to staging.targetDigest / staging.sourceDigest.
        const dataRaw = aGet(adapter, ACTIVATION_KEYS.DATA);
        let dataHash = null;
        try {
          dataHash = await computeDigest(
            dataRaw ?? '', digestFn, 'phase2-data-digest', timeoutMs, scheduler,
          );
        } catch {}

        if (dataHash && dataHash === staging.targetDigest) {
          // wLM committed (staging-clear crashed); clear now.
          stagingClear(adapter);
          return { ...mutResult, stagingAction: 'cleared-committed' };
        }
        if (dataHash && dataHash === staging.sourceDigest) {
          // wLM did not commit or was journal-reverted; clear staging.
          stagingClear(adapter);
          return { ...mutResult, stagingAction: 'cleared-uncommitted' };
        }
        // DATA matches neither after Phase 1 resolved consistency — unexpected; retain.
        return { ...mutResult, stagingAction: 'retained-ambiguous' };
      }

      if (staging.txState === 'failed') {
        return { ...mutResult, stagingAction: 'retained-failed' };
      }

      // Unknown txState: quarantine + clear (same bounded+verify+retain pattern).
      const qr = _quarantineImportStaging(
        adapter, stagingRaw, `unknown-state:${staging.txState}`, clock,
      );
      if (qr.ok) {
        stagingClear(adapter);
        return { ...mutResult, stagingAction: 'quarantined-unknown' };
      }
      return { ...mutResult, stagingAction: 'retained-unknown', detail: qr.error };
    }, timeoutMs, scheduler);
  } catch (e) {
    return {
      action: 'coordinator-lock-failed', v2Active: false, stagingAction: 'skipped',
      detail: e?.message ?? String(e),
    };
  }

  if (!lockResult || !lockResult.ok) {
    return {
      action: 'coordinator-lock-denied', v2Active: false, stagingAction: 'skipped',
      detail: lockResult?.message ?? `code: ${lockResult?.code ?? 'unknown'}`,
    };
  }
  return lockResult.result;
}
