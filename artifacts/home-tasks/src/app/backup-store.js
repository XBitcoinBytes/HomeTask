/* Extracted mechanically from src/script.js lines 1707–1829 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── App module ───────────────────────────────────────────────── */
/* ── Backup store ─────────────────────────────────────────────── */
/**
 * backupStore — manages the hometask-backup-v1 localStorage key.
 *
 * Structure:
 *   { lastExport: "YYYY-MM-DD" | null,
 *     snapshot:   { savedAt: "<ISO>",
 *                   keys: { "hometask-v1": "<raw>"|null,
 *                           "hometask-rooms-v1": "<raw>"|null,
 *                           "hometask-meta-v1": "<raw>"|null } } | absent }
 *
 * The snapshot captures the pre-import raw string for every IMPORT_KEY.
 * null means the key was absent before the import.  On undo, null values
 * cause the key to be removed rather than set to the string "null".
 *
 * Backward compatibility: old snapshots used { tasks, meta } strings;
 * getSnapshot() migrates them to the new keys map automatically.
 */
const backupStore = (() => {
  const KEY = 'hometask-backup-v1';

  // All HomeTask data keys that an import can change.
  const IMPORT_KEYS = ['hometask-v1', 'hometask-rooms-v1', 'hometask-meta-v1'];

  function _load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function _persist(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch { return false; }
  }

  function getLastExport() { return _load().lastExport ?? null; }

  function setLastExport(dateStr) {
    return _persist({ ..._load(), lastExport: dateStr });
  }

  /**
   * Snapshot current state of all IMPORT_KEYS before an import.
   * Captures null correctly: absent key → null (not '[]' or '{}').
   * Returns { ok: true } or { ok: false, error: string }.
   * Caller MUST abort the import if ok is false.
   */
  function saveSnapshot() {
    const keys = {};
    for (const k of IMPORT_KEYS) {
      try { keys[k] = localStorage.getItem(k); }   // null when absent
      catch { return { ok: false, error: 'read-failed:' + k }; }
    }
    const snap = { savedAt: new Date().toISOString(), keys };
    const ok   = _persist({ ..._load(), snapshot: snap });
    if (!ok) return { ok: false, error: 'write-failed' };
    // Verify the write actually reached storage
    const verify = _load();
    if (!verify.snapshot || verify.snapshot.savedAt !== snap.savedAt) {
      return { ok: false, error: 'verify-failed' };
    }
    return { ok: true };
  }

  /**
   * Return snapshot, migrating old { tasks, meta } format to { keys } map.
   */
  function getSnapshot() {
    const snap = _load().snapshot ?? null;
    if (!snap) return null;
    if (snap.keys) return snap;   // already new format
    // Migrate old format (tasks/meta string fields)
    return {
      savedAt: snap.savedAt ?? new Date().toISOString(),
      keys: {
        'hometask-v1':      snap.tasks ?? null,
        'hometask-rooms-v1': null,
        'hometask-meta-v1': snap.meta  ?? null,
      },
    };
  }

  /**
   * Restore all IMPORT_KEYS from snapshot byte-for-byte.
   * A null value in keys → removeItem (key was absent before import).
   * Returns { ok: true, restored: string[] } or { ok: false, error, restored }.
   * Snapshot is NOT cleared here — caller clears it only after verifying ok.
   */
  function applySnapshot(snap) {
    if (!snap || typeof snap.keys !== 'object') {
      return { ok: false, error: 'invalid-snapshot', restored: [] };
    }
    const restored = [];
    for (const k of IMPORT_KEYS) {
      const v = snap.keys[k];   // null → key was absent
      try {
        if (v === null) {
          localStorage.removeItem(k);
        } else {
          localStorage.setItem(k, v);
          if (localStorage.getItem(k) !== v) throw new Error('verify-mismatch');
        }
        restored.push(k);
      } catch (e) {
        return { ok: false, error: 'write-failed:' + k + ':' + (e?.name ?? ''), restored };
      }
    }
    return { ok: true, restored };
  }

  function clearSnapshot() {
    const d = _load();
    delete d.snapshot;
    _persist(d);
  }

  return {
    getLastExport, setLastExport,
    saveSnapshot, getSnapshot, applySnapshot, clearSnapshot,
    IMPORT_KEYS,
  };
})();


export { backupStore };
