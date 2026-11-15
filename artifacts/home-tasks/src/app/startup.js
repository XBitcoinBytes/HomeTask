/* Extracted mechanically from src/script.js lines 516–629 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── Startup: interrupted-import detection ────────────────────── */
/**
 * Runs before any module reads localStorage.
 *
 * If an abandoned import staging key is found, determines whether the
 * import committed successfully (cleanup-only) or needs rollback:
 *
 *   txState === 'committed'       →  import finished; just remove staging
 *   txState === 'rollback_failed' →  retry rollback once; set sessionStorage flag
 *                                    regardless of retry outcome (no infinite loop)
 *   any other state               →  partial or no writes; roll back from snapshot
 *
 * Sets sessionStorage key 'hometask-recovered-staging' = '1' whenever a
 * rollback is attempted (success or failure) so backupUI can surface a notice.
 *
 * Also migrates the obsolete hometask-quarantine-v1 key (metadata-only,
 * no raw data) by removing it — it is superseded by hometask-recovery-v1.
 */
(function _checkAbandonedStaging() {
  const STAGING_KEY = 'hometask-import-staging-v1';
  const BACKUP_KEY  = 'hometask-backup-v1';
  const IMPORT_KEYS = ['hometask-v1', 'hometask-rooms-v1', 'hometask-meta-v1'];

  // Migrate old quarantine key (no raw data to preserve)
  try {
    if (localStorage.getItem('hometask-quarantine-v1')) {
      localStorage.removeItem('hometask-quarantine-v1');
    }
  } catch (_) {}

  let staging;
  try {
    const raw = localStorage.getItem(STAGING_KEY);
    if (!raw) return;
    staging = JSON.parse(raw);
  } catch {
    try { localStorage.removeItem(STAGING_KEY); } catch (_) {}
    console.warn('[HomeTask] Corrupt import staging key removed at startup.');
    return;
  }

  if (staging.txState === 'committed') {
    // Import fully committed; only staging cleanup was interrupted — safe
    try { localStorage.removeItem(STAGING_KEY); } catch (_) {}
    console.info('[HomeTask] Cleaned up completed import staging (interrupted cleanup).');
    return;
  }

  // Uncommitted or partial — must roll back to pre-import snapshot
  console.warn('[HomeTask] Interrupted import detected (txState: ' + staging.txState + '). Rolling back…');

  let snap = null;
  try {
    const raw    = localStorage.getItem(BACKUP_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    snap = parsed?.snapshot ?? null;
    // Migrate old snapshot format { tasks, meta } → new { keys } format
    if (snap && snap.tasks !== undefined && !snap.keys) {
      snap = {
        savedAt: snap.savedAt,
        keys: {
          'hometask-v1':      snap.tasks ?? null,
          'hometask-rooms-v1': null,
          'hometask-meta-v1': snap.meta  ?? null,
        },
      };
    }
  } catch { snap = null; }

  if (!snap?.keys) {
    try { localStorage.removeItem(STAGING_KEY); } catch (_) {}
    console.error('[HomeTask] No valid snapshot for interrupted-import rollback. Staging removed.');
    return;
  }

  let rollbackOk = true;
  for (const k of IMPORT_KEYS) {
    const v = snap.keys[k];   // null → key was absent before import
    try {
      if (v === null) {
        localStorage.removeItem(k);
      } else {
        localStorage.setItem(k, v);
        if (localStorage.getItem(k) !== v) throw new Error('verify-mismatch');
      }
    } catch (e) {
      console.error('[HomeTask] Rollback write failed for', k + ':', e.message);
      rollbackOk = false;
      break;
    }
  }

  if (rollbackOk) {
    try { localStorage.removeItem(STAGING_KEY); } catch (_) {}
    try { sessionStorage.setItem('hometask-recovered-staging', '1'); } catch (_) {}
    console.info('[HomeTask] Interrupted import rolled back — previous data restored.');
  } else {
    // Rollback failed — retain staging and snapshot for the next startup retry.
    // Set the sessionStorage flag so backupUI surfaces a notice immediately.
    try { sessionStorage.setItem('hometask-recovered-staging', '1'); } catch (_) {}
    // Re-mark txState as rollback_failed and record retry timestamp so the
    // next startup can distinguish a fresh failure from a previous attempt.
    try {
      const raw = localStorage.getItem(STAGING_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        s.txState      = 'rollback_failed';
        s.lastRetryAt  = new Date().toISOString();
        localStorage.setItem(STAGING_KEY, JSON.stringify(s));
      }
    } catch (_) {}
    console.error('[HomeTask] Could not complete rollback. Staging key retained for diagnostics.');
  }
}());

