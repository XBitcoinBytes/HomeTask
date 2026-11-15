/**
 * v2-backup-service-adapter.js — CP5C-D: facade-arity bridge for V2BackupService.
 *
 * Wraps a pre-constructed V2BackupService instance and presents the
 * two-argument interface that the existing backup facade (src/app/backup.js)
 * and backup-ui.js already expect, resolving both interface mismatches:
 *
 *   1. readAndValidate return-shape mismatch:
 *      V2 returns { sanitized, source, taskCount, repairs, warnings }.
 *      The adapter ADDS facade-compat carrier fields while preserving
 *      every original field by reference:
 *
 *        sanitizedTasks: result.sanitized   ← full v2 envelope in carrier field
 *        sanitizedPrefs: {}                 ← inert; adapter's applyImport ignores it
 *        exportDate:     sanitized?.meta?.exportedAt ?? null
 *
 *      No original field is dropped.  Future fields added to V2BackupService's
 *      result are forwarded automatically via the spread-and-override pattern.
 *
 *   2. applyImport arity mismatch:
 *      backup-ui.js calls applyImport(sanitizedTasks, sanitizedPrefs).
 *      After repacking, _pending.sanitizedTasks IS the full v2 envelope
 *      (schemaVersion:2).  The adapter forwards only the first arg to
 *      V2BackupService.applyImport(sanitized); the second is silently dropped.
 *
 * All 7 remaining methods are NAMED WRAPPER FUNCTIONS that invoke the
 * underlying service through the live closure.  No direct method-reference
 * assignment is used — this guarantees that the service's internal closure
 * state is never detached or lost regardless of how the adapter is called.
 *
 * NOT imported by any production file while V2_ACTIVATION_ENABLED=false.
 * Zero static imports — the caller supplies a pre-constructed V2BackupService.
 * No storage reads, no DOM access, no timers.
 */

const REQUIRED_METHODS = [
  'exportBackup',
  'readAndValidate',
  'applyImport',
  'applyUndo',
  'hasSnapshot',
  'getLastExport',
  'getRecoveryNoticeState',
  'downloadRecoveryData',
  'dismissRecovery',
];

/**
 * Wrap a pre-constructed V2BackupService instance with the facade-compatible
 * two-arg interface expected by backup.js and backup-ui.js.
 *
 * @param {object} v2Svc — pre-constructed V2BackupService instance
 * @returns {object} — object exposing exactly the 9 facade methods
 * @throws {Error} '[HomeTask] createV2BackupAdapter: …' for null/missing/invalid service
 */
export function createV2BackupAdapter(v2Svc) {
  if (v2Svc === null || v2Svc === undefined || typeof v2Svc !== 'object') {
    throw new Error('[HomeTask] createV2BackupAdapter: v2Svc must be a non-null object');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof v2Svc[method] !== 'function') {
      throw new Error(
        `[HomeTask] createV2BackupAdapter: v2Svc.${method} must be a function`,
      );
    }
  }

  /* ── Adapted: readAndValidate ─────────────────────────────────────────
   * Returns all original V2 fields (by reference) PLUS the three
   * facade-compat fields.  sanitizedTasks carries the full v2 envelope so
   * that backup-ui.js's `_pending.sanitizedTasks` is the envelope that
   * applyImport below will forward to V2BackupService.
   * ──────────────────────────────────────────────────────────────────── */
  function readAndValidate(fileLike) {
    return v2Svc.readAndValidate(fileLike).then(function(result) {
      const exportDate =
        result.sanitized != null &&
        result.sanitized.meta != null &&
        result.sanitized.meta.exportedAt != null
          ? result.sanitized.meta.exportedAt
          : null;
      return {
        // Original V2 fields — preserved by reference, never dropped
        sanitized:      result.sanitized,
        source:         result.source,
        taskCount:      result.taskCount,
        repairs:        result.repairs,
        warnings:       result.warnings,
        // Facade-compat carrier fields
        sanitizedTasks: result.sanitized,
        sanitizedPrefs: {},
        exportDate,
      };
    });
  }

  /* ── Adapted: applyImport ─────────────────────────────────────────────
   * Accepts (sanitizedTasks, sanitizedPrefs) for backup-ui.js compat.
   * After readAndValidate repacking, sanitizedTasks IS the full v2 envelope.
   * V2BackupService validates sanitized.schemaVersion === 2 on receipt.
   * sanitizedPrefs is accepted but silently dropped — it is the inert empty
   * object set by readAndValidate above; all prefs are inside the envelope.
   * ──────────────────────────────────────────────────────────────────── */
  function applyImport(sanitizedTasks, _sanitizedPrefs) {
    return v2Svc.applyImport(sanitizedTasks);
  }

  /* ── Passthrough wrappers (named functions, live-closure routing) ───── */
  function exportBackup()           { return v2Svc.exportBackup(); }
  function applyUndo()              { return v2Svc.applyUndo(); }
  function hasSnapshot()            { return v2Svc.hasSnapshot(); }
  function getLastExport()          { return v2Svc.getLastExport(); }
  function getRecoveryNoticeState() { return v2Svc.getRecoveryNoticeState(); }
  function downloadRecoveryData()   { return v2Svc.downloadRecoveryData(); }
  function dismissRecovery()        { return v2Svc.dismissRecovery(); }

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
