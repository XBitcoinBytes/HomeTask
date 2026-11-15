/* Extracted mechanically from src/script.js lines 631–731 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── Recovery store ───────────────────────────────────────────── */
/**
 * Manages hometask-recovery-v1 — preserves the actual raw content of
 * a damaged HomeTask storage key so the user can retrieve or diagnose it.
 *
 * Structure of the stored record:
 *   {
 *     detectedAt:        ISO string,
 *     sourceKey:         "hometask-v1" | "hometask-meta-v1",
 *     originalLength:    number   — byte length of the original damaged string,
 *     storedLength:      number   — actual bytes stored in rawData (≤ MAX_RAW),
 *     truncated:         boolean,
 *     rawData:           string | null  (null when preservation failed),
 *     downloaded:        boolean,
 *     dismissed:         boolean,
 *     preservationFailed: false | "quota-exceeded" | "existing-undownloaded" | "unknown",
 *   }
 *
 * Rules:
 *  • rawData is capped at MAX_RAW (250 KB) to limit quota impact.
 *  • An existing record that has not been downloaded AND not been dismissed
 *    is never silently overwritten (new corruption events are logged but skipped).
 *  • If the write itself fails (quota), failure metadata is stored without rawData.
 *  • The record is never treated as an importable backup.
 */
const recoveryStore = (() => {
  const KEY     = 'hometask-recovery-v1';
  const MAX_RAW = 250 * 1024;   // 250 KB cap on stored rawData

  function _load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _persist(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch { return false; }
  }

  /**
   * Attempt to preserve damaged storage content.
   *
   * @param {string} sourceKey  — the hometask-* key that was damaged
   * @param {string} rawStr     — the raw string that failed JSON.parse
   * @returns {{ saved: boolean, preservationFailed: string|false }}
   */
  function save(sourceKey, rawStr) {
    const existing = _load();
    // Never silently overwrite an existing record the user has not yet
    // downloaded and has not explicitly dismissed.
    if (existing && existing.downloaded !== true && existing.dismissed !== true) {
      console.warn('[HomeTask] Recovery: existing undownloaded record not overwritten.');
      return { saved: false, preservationFailed: 'existing-undownloaded' };
    }

    const originalLength = typeof rawStr === 'string' ? rawStr.length : 0;
    const truncated      = originalLength > MAX_RAW;
    const capped         = truncated ? rawStr.slice(0, MAX_RAW) : rawStr;

    const record = {
      detectedAt:         new Date().toISOString(),
      sourceKey,
      originalLength,
      storedLength:       capped.length,
      truncated,
      rawData:            capped,
      downloaded:         false,
      dismissed:          false,
      preservationFailed: false,
    };

    if (!_persist(record)) {
      // Quota exceeded — record failure metadata without rawData
      const failMeta = {
        detectedAt:         new Date().toISOString(),
        sourceKey,
        originalLength,
        storedLength:       0,
        truncated:          false,
        rawData:            null,
        downloaded:         false,
        dismissed:          false,
        preservationFailed: 'quota-exceeded',
      };
      try { localStorage.setItem(KEY, JSON.stringify(failMeta)); } catch (_) {}
      console.error('[HomeTask] Recovery: quota exceeded — raw damaged data could not be preserved.');
      return { saved: false, preservationFailed: 'quota-exceeded' };
    }
    return { saved: true, preservationFailed: false };
  }

  function get()            { return _load(); }
  function markDownloaded() { const d = _load(); if (d) _persist({ ...d, downloaded: true }); }
  function markDismissed()  { const d = _load(); if (d) _persist({ ...d, dismissed:  true }); }
  function hasUndismissed() { const d = _load(); return Boolean(d && !d.dismissed); }

  return { KEY, save, get, markDownloaded, markDismissed, hasUndismissed };
})();


export { recoveryStore };
