/**
 * import-tx.js — v2 import transaction state machine over an injected
 * storage adapter, per docs/v2-backup-envelope.md §7.
 *
 * States: staged → committing → committed  (terminal: cleaned up)
 *                       ↓ failure
 *                 rolled back  |  rollback_failed (evidence retained)
 *
 * Every function takes the adapter and `now` (ISO string) explicitly.
 * Pure module: no localStorage, no DOM, no clock.
 * NOT connected to the production entry point during CP3.
 */

export const TX_VERSION = 2;
export const V2_KEYS = Object.freeze({
  DATA:     'hometask-v2',
  STAGING:  'hometask-import-staging-v2',
  BACKUP:   'hometask-backup-v2',      // { lastExport?, snapshot? }
  RECOVERY: 'hometask-recovery-v2',
});
/** The only live keys an import may write. */
export const IMPORT_KEYS = Object.freeze([V2_KEYS.DATA]);

/* ── Snapshot store (pre-import, byte-exact) ────────────────────────── */

export function saveSnapshot(adapter, now) {
  const keys = {};
  for (const k of IMPORT_KEYS) {
    try { keys[k] = adapter.getItem(k); }          // null when absent
    catch { return { ok: false, error: 'snapshot-read-failed:' + k }; }
  }
  const snap = { savedAt: now, keys };
  let existing = {};
  try {
    const raw = adapter.getItem(V2_KEYS.BACKUP);
    existing = raw ? JSON.parse(raw) : {};
  } catch { existing = {}; }
  try { adapter.setItem(V2_KEYS.BACKUP, JSON.stringify({ ...existing, snapshot: snap })); }
  catch { return { ok: false, error: 'snapshot-write-failed' }; }
  // Verify the write actually reached storage, byte-exactly.
  try {
    const back = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
    if (!back?.snapshot || back.snapshot.savedAt !== now ||
        JSON.stringify(back.snapshot.keys) !== JSON.stringify(keys)) {
      return { ok: false, error: 'snapshot-verify-failed' };
    }
  } catch { return { ok: false, error: 'snapshot-verify-failed' }; }
  return { ok: true };
}

export function getSnapshot(adapter) {
  try {
    const raw = adapter.getItem(V2_KEYS.BACKUP);
    const snap = raw ? JSON.parse(raw).snapshot ?? null : null;
    return snap && typeof snap.keys === 'object' ? snap : null;
  } catch { return null; }
}

/** Restore IMPORT_KEYS byte-for-byte; null → removeItem. Never clears the snapshot itself. */
export function applySnapshot(adapter, snap) {
  if (!snap || typeof snap.keys !== 'object') return { ok: false, error: 'invalid-snapshot', restored: [] };
  const restored = [];
  for (const k of IMPORT_KEYS) {
    const v = snap.keys[k];
    try {
      if (v === null || v === undefined) {
        adapter.removeItem(k);
        if (adapter.getItem(k) !== null) throw new Error('verify-mismatch');
      } else {
        adapter.setItem(k, v);
        if (adapter.getItem(k) !== v) throw new Error('verify-mismatch');
      }
      restored.push(k);
    } catch (e) {
      return { ok: false, error: 'rollback-write-failed:' + k + ':' + (e?.message ?? ''), restored };
    }
  }
  return { ok: true, restored };
}

export function clearSnapshot(adapter) {
  try {
    const raw = adapter.getItem(V2_KEYS.BACKUP);
    if (!raw) return true;
    const d = JSON.parse(raw);
    delete d.snapshot;
    adapter.setItem(V2_KEYS.BACKUP, JSON.stringify(d));
    return true;
  } catch { return false; }
}

/* ── Staging helpers ────────────────────────────────────────────────── */

function stagingGet(adapter) {
  try {
    const raw = adapter.getItem(V2_KEYS.STAGING);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function stagingSave(adapter, data) {
  try { adapter.setItem(V2_KEYS.STAGING, JSON.stringify(data)); return true; }
  catch { return false; }
}
function stagingPatch(adapter, updates) {
  const cur = stagingGet(adapter);
  if (!cur) return false;
  return stagingSave(adapter, { ...cur, ...updates });
}
function stagingClear(adapter) {
  try { adapter.removeItem(V2_KEYS.STAGING); return true; }
  catch { return false; }
}

/* ── The transaction ────────────────────────────────────────────────── */

/**
 * Run a full import transaction writing `dataStr` to hometask-v2.
 *
 * @param {object} adapter — injected storage adapter
 * @param {string} dataStr — the exact serialized envelope to commit
 * @param {string} now     — ISO timestamp (injected)
 * @returns {{ ok:true, message } | { ok:false, code, message, diagnostic? }}
 *
 * Failure codes map 1:1 to the rollback policy:
 *   snapshot-failed / staging-failed / staging-verify-failed → nothing changed
 *   rolled-back      → live data restored byte-exactly, snapshot retained
 *   rollback-failed  → rollback_failed evidence retained, snapshot retained
 */
export function runImportTransaction(adapter, dataStr, now) {
  if (typeof dataStr !== 'string' || dataStr.length === 0) {
    return { ok: false, code: 'invalid-input', message: 'Nothing to import.' };
  }

  // Refuse while unresolved rollback_failed evidence exists (never overwrite it).
  const existing = stagingGet(adapter);
  if (existing?.txState === 'rollback_failed') {
    return {
      ok: false, code: 'blocked-rollback-failed',
      message: 'A previous import could not be recovered automatically. Restore your previous data before importing again.',
    };
  }

  // 1 · Snapshot (save + verify) — abort touching nothing on failure.
  const snapResult = saveSnapshot(adapter, now);
  if (!snapResult.ok) {
    return { ok: false, code: 'snapshot-failed', message: 'The undo checkpoint could not be saved (' + snapResult.error + '). Your data has not been changed.' };
  }

  // 2 · Staging (write + byte-verify).
  const staging = {
    txVersion: TX_VERSION, txState: 'staged',
    startedAt: now, committedAt: null,
    keysToWrite: [...IMPORT_KEYS], keysWritten: [],
    data: { [V2_KEYS.DATA]: dataStr },
  };
  if (!stagingSave(adapter, staging)) {
    return { ok: false, code: 'staging-failed', message: 'Staging data could not be saved. Your data has not been changed.' };
  }
  const readBack = stagingGet(adapter);
  if (!readBack || readBack.txState !== 'staged' || readBack.data?.[V2_KEYS.DATA] !== dataStr) {
    stagingClear(adapter);
    return { ok: false, code: 'staging-verify-failed', message: 'Staging validation failed. Your data has not been changed.' };
  }

  // 3 · Committing: write each live key with byte-verify + progress record.
  stagingPatch(adapter, { txState: 'committing' });
  const keysWritten = [];
  for (const key of IMPORT_KEYS) {
    try {
      adapter.setItem(key, staging.data[key]);
      if (adapter.getItem(key) !== staging.data[key]) throw new Error('verify-mismatch');
      keysWritten.push(key);
      stagingPatch(adapter, { keysWritten: [...keysWritten] });   // progress update may itself fail — commit continues; startup recovery covers it
    } catch (e) {
      return rollBack(adapter, now, 'commit-write-failed:' + key + ':' + (e?.message ?? ''));
    }
  }

  // 4 · Committed → cleanup. Success may only be claimed when the staging
  // record verifiably ends as ABSENT or 'committed' — otherwise a leftover
  // 'committing' record would make the next startup roll back this valid
  // import. If neither can be persisted, roll back deliberately instead.
  stagingPatch(adapter, { txState: 'committed', committedAt: now });
  stagingClear(adapter);
  const finalStaging = stagingGet(adapter);
  if (finalStaging !== null && finalStaging.txState !== 'committed') {
    return rollBack(adapter, now, 'committed-marker-and-cleanup-failed');
  }
  return { ok: true, message: 'Backup restored.' };
}

function rollBack(adapter, now, cause) {
  const snap = getSnapshot(adapter);
  const rb = snap ? applySnapshot(adapter, snap) : { ok: false, error: 'no-snapshot', restored: [] };
  if (rb.ok) {
    stagingClear(adapter);       // rollback verified → staging safe to drop; snapshot retained for manual undo
    return { ok: false, code: 'rolled-back', message: 'The backup could not be fully restored (' + cause + '). Your previous data has been recovered automatically.' };
  }
  // Rollback failed — NEVER claim success; retain snapshot + staging evidence.
  stagingPatch(adapter, {
    txState: 'rollback_failed', rollbackError: rb.error,
    keysRestored: rb.restored, failedAt: now, cause,
  });
  return {
    ok: false, code: 'rollback-failed',
    message: 'The backup could not be fully restored and automatic recovery also failed (' + rb.error + '). Restore your previous data before importing again.',
    diagnostic: { cause, rollbackError: rb.error, keysRestored: rb.restored },
  };
}

/* ── Startup recovery ───────────────────────────────────────────────── */

/**
 * Handle a staging record found at startup. Idempotent: safe to run on
 * every startup; never overwrites best-known recovery evidence.
 *
 * @returns {{ action: 'none'|'cleaned-committed'|'removed-malformed'|
 *                     'rolled-back'|'rollback-retry-failed'|
 *                     'quarantined-unsupported', detail?:string }}
 */
export function recoverStartup(adapter, now) {
  let raw;
  try { raw = adapter.getItem(V2_KEYS.STAGING); }
  catch { return { action: 'none', detail: 'staging unreadable' }; }
  if (!raw) return { action: 'none' };

  let staging;
  try { staging = JSON.parse(raw); } catch { staging = null; }
  if (!staging || typeof staging !== 'object' || typeof staging.txState !== 'string') {
    stagingClear(adapter);
    return { action: 'removed-malformed' };
  }

  // Unsupported (future) transaction version: do not interpret, do not
  // destroy — leave the record and its evidence untouched.
  if (staging.txVersion !== undefined && staging.txVersion > TX_VERSION) {
    return { action: 'quarantined-unsupported', detail: `txVersion ${staging.txVersion}` };
  }

  if (staging.txState === 'committed') {
    // All writes verified before this state — only cleanup was interrupted.
    stagingClear(adapter);
    return { action: 'cleaned-committed' };
  }

  // staged / committing (0, some, or all keys written but unmarked) /
  // rollback_failed / anything unknown → the commit is not proven complete;
  // roll back to the pre-import snapshot.
  const snap = getSnapshot(adapter);
  if (!snap) {
    if (staging.txState === 'staged') {
      // No live key was written in 'staged'; discarding staging is safe.
      stagingClear(adapter);
      return { action: 'rolled-back', detail: 'staged-only, no snapshot needed' };
    }
    // Mid-commit with no snapshot: retain the staging evidence (it holds the
    // only copy of intent); mark it rather than deleting recovery data.
    if (staging.txState !== 'rollback_failed') {
      stagingPatch(adapter, { txState: 'rollback_failed', rollbackError: 'no-snapshot', failedAt: now });
    } else if (!stagingPatchRetry(adapter, staging, now)) {
      /* evidence preserved as-is */
    }
    return { action: 'rollback-retry-failed', detail: 'no-snapshot' };
  }

  const rb = applySnapshot(adapter, snap);
  if (rb.ok) {
    stagingClear(adapter);
    return { action: 'rolled-back' };
  }
  // Retry failed — record ONLY the retry timestamp; keep original evidence.
  if (staging.txState === 'rollback_failed') stagingPatchRetry(adapter, staging, now);
  else stagingPatch(adapter, { txState: 'rollback_failed', rollbackError: rb.error, keysRestored: rb.restored, failedAt: now });
  return { action: 'rollback-retry-failed', detail: rb.error };
}

function stagingPatchRetry(adapter, staging, now) {
  // Preserve first-failure evidence (rollbackError/failedAt/cause); only bump lastRetryAt.
  return stagingSave(adapter, { ...staging, lastRetryAt: now });
}

/* ── Recovery-data preservation (damaged-storage evidence) ──────────── */

export const RECOVERY_MAX_RAW = 250 * 1024;   // same cap as shipped v1

/**
 * Preserve damaged raw storage content under hometask-recovery-v2.
 * Same rules as the shipped v1 recovery store: 250 KB cap with truncation
 * metadata; an existing un-downloaded, un-dismissed record is NEVER
 * silently overwritten; on quota failure, failure metadata is stored
 * without rawData. The record is never treated as an importable backup.
 */
export function preserveRecovery(adapter, sourceKey, rawStr, now) {
  const str = typeof rawStr === 'string' ? rawStr : '';   // never throw on null/undefined evidence
  let existing = null;
  try {
    const raw = adapter.getItem(V2_KEYS.RECOVERY);
    existing = raw ? JSON.parse(raw) : null;
  } catch { existing = null; }
  if (existing && existing.downloaded !== true && existing.dismissed !== true) {
    return { saved: false, preservationFailed: 'existing-undownloaded' };
  }

  const originalLength = str.length;
  const truncated = originalLength > RECOVERY_MAX_RAW;
  const capped = truncated ? str.slice(0, RECOVERY_MAX_RAW) : str;
  const record = {
    detectedAt: now, sourceKey, originalLength,
    storedLength: capped.length, truncated, rawData: capped,
    downloaded: false, dismissed: false, preservationFailed: false,
  };
  try {
    adapter.setItem(V2_KEYS.RECOVERY, JSON.stringify(record));
    return { saved: true, preservationFailed: false };
  } catch {
    const failMeta = { ...record, storedLength: 0, truncated: false, rawData: null, preservationFailed: 'quota-exceeded' };
    try { adapter.setItem(V2_KEYS.RECOVERY, JSON.stringify(failMeta)); } catch { /* metadata also failed */ }
    return { saved: false, preservationFailed: 'quota-exceeded' };
  }
}
