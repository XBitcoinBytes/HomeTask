/**
 * V2BackupService — authority-neutral backup orchestration for v2.
 *
 * No browser globals (except Blob, which is not prohibited).
 * No src/app imports. All catalog data, adapter, clock, and lock are injected.
 * V2_ACTIVATION_ENABLED is checked by the CALLER — this service assumes
 * v2 is active; it never reads V2_ACTIVATION_ENABLED itself.
 *
 * All storage operations go through the injected adapter — no direct
 * localStorage, no direct sessionStorage.
 *
 * Constructor parameters:
 *   adapter        — { getItem, setItem, removeItem } — v2 storage backing
 *   catalog        — { tasks:[], zones:[], catalogVersion:number } — injected,
 *                    never imported; used for validation context and export metadata.
 *   appBuild       — string (e.g. 'v22-f1') — for export ctx
 *   delivery       — { canShare(blob,filename):bool, share(blob,filename):Promise<void>,
 *                       download(blob,filename):void }
 *   fileReader     — { readAsText(fileLike): Promise<string> }
 *   clock          — ():string  ISO-8601 timestamp
 *   todayFn        — ():string  'YYYY-MM-DD' local date string
 *   sessionStore   — { getItem, setItem, removeItem }
 *   lock           — { runExclusive(txId, callback): Promise } — ExclusiveMutationLock;
 *                    runExclusive resolves { ok:true, result } | { ok:false, code, message }
 *   digestFn       — optional; SHA-256 digest function; defaults to webCryptoDigest
 *   timeoutMs      — optional; lock-acquire timeout in ms; defaults to ADAPTER_TIMEOUT_MS
 *   scheduler      — optional; { setTimeout, clearTimeout }; defaults to globalThis
 *
 * All BACKUP-key reads and writes are lock-scoped (export-read, export-write,
 * has-snapshot, get-last-export).  STAGING and RECOVERY keys are only ever
 * written by the locked import/undo paths or by the recovery-action methods,
 * which remain synchronous and do not touch DATA.
 */

import {
  V2_KEYS,
} from '../../v2/import-tx.js';

import {
  buildBackup,
  parseAndValidateBackup,
  MAX_FILE_BYTES,
} from '../../v2/backup.js';

import {
  runV2LockedImport,
  runV2LockedUndo,
  withLockTimeout,
} from './v2-locked-import.js';

import { webCryptoDigest } from '../../v2/shadow-fingerprint.js';
import { ADAPTER_TIMEOUT_MS } from '../../v2/shadow-migrate.js';

/**
 * Session-storage key written by the startup recovery path for v2 staging.
 * Distinct from the v1 key ('hometask-recovered-staging') so both can coexist.
 */
const SESSION_RECOVERED_KEY = 'hometask-recovered-staging-v2';

const DEFAULT_SCHEDULER = {
  setTimeout:   (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id)     => globalThis.clearTimeout(id),
};

function V2BackupService({
  adapter,
  catalog,
  appBuild,
  delivery,
  fileReader,
  clock,
  todayFn,
  sessionStore,
  lock,
  digestFn  = webCryptoDigest,
  timeoutMs = ADAPTER_TIMEOUT_MS,
  scheduler = DEFAULT_SCHEDULER,
}) {
  /* ── Construction validation ─────────────────────────────────── */
  if (!adapter || typeof adapter.getItem !== 'function')
    throw new Error('[HomeTask] V2BackupService: adapter required');
  if (!catalog || !Array.isArray(catalog.tasks) || !Array.isArray(catalog.zones))
    throw new Error('[HomeTask] V2BackupService: catalog must have tasks[] and zones[]');
  if (typeof catalog.catalogVersion !== 'number')
    throw new Error('[HomeTask] V2BackupService: catalog.catalogVersion must be a number');
  if (typeof appBuild !== 'string' || !appBuild)
    throw new Error('[HomeTask] V2BackupService: appBuild must be a non-empty string');
  if (!delivery || typeof delivery.canShare !== 'function')
    throw new Error('[HomeTask] V2BackupService: delivery required');
  if (!fileReader || typeof fileReader.readAsText !== 'function')
    throw new Error('[HomeTask] V2BackupService: fileReader required');
  if (typeof clock !== 'function')
    throw new Error('[HomeTask] V2BackupService: clock must be a function');
  if (typeof todayFn !== 'function')
    throw new Error('[HomeTask] V2BackupService: todayFn must be a function');
  if (!sessionStore || typeof sessionStore.getItem !== 'function')
    throw new Error('[HomeTask] V2BackupService: sessionStore required');
  if (!lock || typeof lock.runExclusive !== 'function')
    throw new Error('[HomeTask] V2BackupService: lock with runExclusive(txId, callback) required');

  /* ── Private STAGING / RECOVERY helpers (outside lock) ───────── */

  /** Read staging record (hometask-import-staging-v2) without throwing. */
  function _readStaging() {
    try {
      const raw = adapter.getItem(V2_KEYS.STAGING);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /** Read recovery record (hometask-recovery-v2) without throwing. */
  function _readRecovery() {
    try {
      const raw = adapter.getItem(V2_KEYS.RECOVERY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /** Patch and write recovery record without throwing. */
  function _patchRecovery(patch) {
    try {
      const rec = _readRecovery();
      if (!rec) return;
      adapter.setItem(V2_KEYS.RECOVERY, JSON.stringify({ ...rec, ...patch }));
    } catch { /* non-fatal */ }
  }

  /* ── Lock-scoped BACKUP helper ───────────────────────────────── */

  /**
   * Merge `patch` into the BACKUP key inside the lock.
   * Best-effort: if the lock times out or the write fails the operation is
   * silently skipped — backup metadata (lastExport) is non-fatal.
   */
  async function _lockedMergeBackup(patch) {
    await withLockTimeout(lock, 'backup-write', async () => {
      try {
        let existing = {};
        try {
          const r = adapter.getItem(V2_KEYS.BACKUP);
          existing = r ? JSON.parse(r) : {};
        } catch { /* malformed — start fresh */ }
        adapter.setItem(V2_KEYS.BACKUP, JSON.stringify({ ...existing, ...patch }));
      } catch { /* non-fatal: quota or serialization error */ }
    }, timeoutMs, scheduler);
  }

  /* ── Export ──────────────────────────────────────────────────── */

  /**
   * Build and deliver a schemaVersion-2 backup file.
   *
   * Lock protocol:
   *   Lock #1 (export-read)   — capture DATA bytes atomically; fail-closed on timeout.
   *   (delivery happens outside the lock)
   *   Lock #2 (backup-write)  — merge-write lastExport into BACKUP; best-effort on timeout.
   *
   * Delivery order mirrors V1BackupService exactly:
   *   1. If delivery.canShare(blob, filename) → try share
   *      a. AbortError → ok:false, "Share was cancelled…"
   *      b. Non-Abort error → fall through to download
   *   2. delivery.download(blob, filename)
   *      a. Success → setLastExport (lock #2); ok:true
   *      b. Failure → ok:false
   *
   * lastExport is written only after confirmed delivery.
   */
  async function exportBackup() {
    // ── Lock #1: capture DATA point-in-time ─────────────────────
    const readLock = await withLockTimeout(lock, 'export-read', async () => {
      return adapter.getItem(V2_KEYS.DATA);
    }, timeoutMs, scheduler);

    if (!readLock?.ok) {
      return { ok: false, message: 'Export could not acquire the data lock. Please try again.' };
    }
    const raw = readLock.result;
    if (!raw) {
      return { ok: false, message: 'No v2 data is available to export.' };
    }

    let v2Data;
    try { v2Data = JSON.parse(raw); }
    catch {
      return { ok: false, message: 'The v2 data could not be read. Please try again.' };
    }

    const now    = clock();
    const today  = todayFn();
    const ctx    = { exportedAt: now, catalogVersion: catalog.catalogVersion, appBuild };
    let envelope;
    try { envelope = buildBackup(v2Data, ctx); }
    catch (e) {
      return { ok: false, message: 'The backup could not be built: ' + (e?.message ?? 'unknown error') };
    }

    const json     = JSON.stringify(envelope, null, 2);
    const filename = `HomeTask-backup-${today}.json`;
    const blob     = new Blob([json], { type: 'application/json' });

    // ── Deliver outside lock ─────────────────────────────────────
    let deliveryResult = null;

    if (delivery.canShare(blob, filename)) {
      try {
        await delivery.share(blob, filename);
        deliveryResult = { ok: true, message: 'Backup shared successfully.' };
      } catch (e) {
        if (e.name === 'AbortError') {
          return { ok: false, message: 'Share was cancelled. Your data was not saved.' };
        }
        // Non-Abort share failure — fall through to download
      }
    }

    if (!deliveryResult) {
      try {
        delivery.download(blob, filename);
        deliveryResult = { ok: true, message: `Backup saved as "${filename}".` };
      } catch {
        return { ok: false, message: 'The backup could not be saved. Please try again.' };
      }
    }

    // ── Lock #2: merge-write lastExport (best-effort) ────────────
    await _lockedMergeBackup({ lastExport: today });

    return deliveryResult;
  }

  /* ── File reading & validation ────────────────────────────────── */

  /**
   * Read a file-like object, validate it, and return sanitized v2 data.
   *
   * Accepts both schemaVersion:1 and schemaVersion:2 HomeTask backups.
   * Schema-v1 backups are upgraded via the approved migrate() path inside
   * parseAndValidateBackup(); the caller receives a canonical v2 envelope
   * regardless of the source version.
   *
   * Resolves with { sanitized, source, taskCount, repairs, warnings }
   * or rejects with a user-facing Error.
   *
   * @param {object} fileLike — must have { size:number } + fileReader reads it
   * @returns {Promise<{ sanitized, source, taskCount, repairs, warnings }>}
   */
  function readAndValidate(fileLike) {
    return new Promise((resolve, reject) => {
      if (!fileLike || typeof fileLike.size !== 'number' || fileLike.size > MAX_FILE_BYTES) {
        reject(new Error('This file is too large to be a HomeTask backup (maximum 2 MB).'));
        return;
      }

      fileReader.readAsText(fileLike).then(text => {
        const ctx    = { today: todayFn(), catalog, appBuild };
        const result = parseAndValidateBackup(text, ctx);

        if (!result.ok) {
          reject(new Error(result.errors?.[0] ?? 'The backup file is not valid.'));
          return;
        }

        resolve({
          sanitized: result.sanitized,
          source:    result.source,
          taskCount: Array.isArray(result.sanitized?.state) ? result.sanitized.state.length : 0,
          repairs:   result.repairs ?? [],
          warnings:  result.warnings ?? [],
        });
      }).catch(() => {
        reject(new Error('Could not read this file. Please try again.'));
      });
    });
  }

  /* ── Import ───────────────────────────────────────────────────── */

  /**
   * Apply a validated, sanitized v2 envelope atomically inside the lock.
   *
   * Delegates entirely to runV2LockedImport (v2-locked-import.js) which
   * implements the 4-step crash-safe locked-commit sequence.
   *
   * @param {object} sanitized — canonical v2 storage envelope from readAndValidate
   * @returns {Promise<{ok:boolean, code?:string, message:string}>}
   */
  async function applyImport(sanitized) {
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
      return { ok: false, code: 'invalid-input', message: 'Nothing to import.' };
    }
    if (sanitized.schemaVersion !== 2) {
      return { ok: false, code: 'invalid-input', message: 'Import requires a v2 storage envelope.' };
    }

    let dataStr;
    try { dataStr = JSON.stringify(sanitized); }
    catch {
      return { ok: false, code: 'invalid-input', message: 'The import data could not be serialized.' };
    }

    return runV2LockedImport(adapter, dataStr, lock, clock(), digestFn, timeoutMs, scheduler);
  }

  /* ── Undo ─────────────────────────────────────────────────────── */

  /**
   * Restore the pre-import snapshot (Undo Last Import) inside the lock.
   *
   * Delegates to runV2LockedUndo (v2-locked-import.js) which:
   *   • verifies the snapshot exists and is not stale (sha256 ownership check)
   *   • calls writeLockedMutation with the snapshot bytes (generation advances)
   *   • clears the snapshot from BACKUP on success
   *
   * Returns { ok:true, message } or { ok:false, code, message }.
   * Caller is responsible for page reload on ok:true.
   *
   * @returns {Promise<{ok:boolean, code?:string, message:string}>}
   */
  async function applyUndo() {
    return runV2LockedUndo(adapter, lock, digestFn, timeoutMs, scheduler);
  }

  /* ── State queries (lock-scoped BACKUP reads) ─────────────────── */

  /**
   * Returns true when a snapshot exists in BACKUP (lock-scoped read).
   * Returns false on lock timeout or any error (fail-closed).
   *
   * @returns {Promise<boolean>}
   */
  async function hasSnapshot() {
    const r = await withLockTimeout(lock, 'has-snapshot', async () => {
      try {
        const raw  = adapter.getItem(V2_KEYS.BACKUP);
        const snap = raw ? (JSON.parse(raw).snapshot ?? null) : null;
        return !!(snap && typeof snap.keys === 'object');
      } catch { return false; }
    }, timeoutMs, scheduler);
    if (!r?.ok) return false;
    return !!r.result;
  }

  /**
   * Returns the lastExport date string from BACKUP, or null.
   * Acquires the lock; returns null on timeout or any error.
   *
   * @returns {Promise<string|null>}
   */
  async function getLastExport() {
    const r = await withLockTimeout(lock, 'get-last-export', async () => {
      try {
        const raw = adapter.getItem(V2_KEYS.BACKUP);
        return raw ? (JSON.parse(raw).lastExport ?? null) : null;
      } catch { return null; }
    }, timeoutMs, scheduler);
    if (!r?.ok) return null;
    return r.result ?? null;
  }

  /* ── Recovery notice state ────────────────────────────────────── */

  /**
   * Compute the recovery notice state for the Backup UI.
   *
   * Priority: damaged-data > rollback_failed > interrupted-import notice.
   * Reads STAGING and RECOVERY only — does not acquire the mutation lock.
   *
   * Recognizes two rollback-failure staging shapes:
   *   Legacy / V1 shape:       { txState: 'rollback_failed' }
   *   V2 locked-import shape:  { txState: 'failed', failCode: 'rollback-failed' }
   *
   * Returns: { visible, message, showDownload, showUndo }
   */
  function getRecoveryNoticeState() {
    const rec               = _readRecovery();
    const hasRecovery       = !!(rec && !rec.downloaded && !rec.dismissed);
    const staging           = _readStaging();
    const hasRollbackFailed =
      staging?.txState === 'rollback_failed' ||
      (staging?.txState === 'failed' && staging?.failCode === 'rollback-failed');
    const hadInterrupt      = sessionStore.getItem(SESSION_RECOVERED_KEY) === '1';

    if (hasRecovery) {
      return {
        visible:      true,
        message:      'HomeTask found damaged saved data and reopened safely. ' +
                      'Some history may need to be restored from a backup.',
        showDownload: true,
        showUndo:     false,
      };
    }
    if (hasRollbackFailed) {
      return {
        visible:      true,
        message:      'An import could not be applied or recovered automatically. ' +
                      'Use "Undo Last Import" to restore your previous data.',
        showDownload: false,
        showUndo:     true,
      };
    }
    if (hadInterrupt) {
      return {
        visible:      true,
        message:      'HomeTask detected an incomplete import and restored your previous data safely.',
        showDownload: false,
        showUndo:     false,
      };
    }
    return { visible: false, message: '', showDownload: false, showUndo: false };
  }

  /* ── Recovery actions ─────────────────────────────────────────── */

  /**
   * Build and deliver the diagnostic recovery-data file.
   * Download only (no share) — matches V1BackupService behavior.
   */
  function downloadRecoveryData() {
    const record = _readRecovery();
    if (!record) return { ok: false, message: 'No recovery data available.' };
    const today    = todayFn();
    const filename = `HomeTask-recovery-${today}.json`;
    const payload  = {
      _type:              'HomeTask Recovery Data',
      _notice:            'This file is diagnostic data, not an importable backup.',
      detectedAt:         record.detectedAt,
      sourceKey:          record.sourceKey,
      originalLength:     record.originalLength,
      storedLength:       record.storedLength,
      truncated:          record.truncated,
      preservationFailed: record.preservationFailed,
      rawData:            record.rawData,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    try {
      delivery.download(blob, filename);
      _patchRecovery({ downloaded: true });
      return { ok: true, message: `Recovery data saved as "${filename}".` };
    } catch {
      return { ok: false, message: 'Could not download recovery data. Please try again.' };
    }
  }

  /**
   * Dismiss the recovery notice.
   * Marks the recovery record dismissed AND clears the sessionStorage interrupt flag.
   */
  function dismissRecovery() {
    _patchRecovery({ dismissed: true });
    try { sessionStore.removeItem(SESSION_RECOVERED_KEY); } catch (_) {}
  }

  /* ── Public interface ─────────────────────────────────────────── */
  return {
    exportBackup,
    readAndValidate,
    applyImport,
    applyUndo,
    hasSnapshot,
    getLastExport,
    getRecoveryNoticeState,
    downloadRecoveryData,
    dismissRecovery,
  };
}

export { V2BackupService, SESSION_RECOVERED_KEY };
