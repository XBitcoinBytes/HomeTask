/**
 * v1-adapter.js — verified storage adapter for V1Repository.
 *
 * Distinguishes three read outcomes so callers can never confuse a
 * transient storage failure with a genuinely absent key:
 *
 *   { status:'ok',      value:string }    key present; value is the raw string
 *   { status:'missing' }                  key absent; getItem returned null
 *   { status:'error',   message:string }  getItem threw; treat as degraded
 *
 * setAndVerify write codes:
 *   { ok:true }
 *   { ok:false, code:'write_failed',                     message }
 *   { ok:false, code:'readback_mismatch_restored',        message }
 *   { ok:false, code:'readback_mismatch_restore_failed',  message, restoreError:string }
 *
 * Restore rules:
 *   - prevBytes is string → restore with setItem + verify readback.
 *   - prevBytes is null   → restore with removeItem + verify getItem returns null.
 *   - null is NEVER passed to setItem.
 *   - Restore failure is never ignored; a distinct code is returned.
 *
 * Pure module: no imports, no side effects.
 */

/**
 * Create a V1StorageAdapter wrapping an injected backing store.
 *
 * @param {{ getItem(key:string):string|null,
 *            setItem(key:string, value:string):void,
 *            removeItem(key:string):void }} backing
 *   Production: { getItem: k => localStorage.getItem(k),
 *                 setItem: (k,v) => localStorage.setItem(k,v),
 *                 removeItem: k => localStorage.removeItem(k) }
 *   Tests: Map-backed fake or createMemoryAdapter() from storage-adapter.js.
 *
 * @returns {{ tryRead, setAndVerify, removeItem }}
 */
export function createV1StorageAdapter(backing) {
  /**
   * Structured read — never converts a thrown error into a null result.
   *
   * @param {string} key
   * @returns {{ status:'ok', value:string }
   *          |{ status:'missing' }
   *          |{ status:'error', message:string }}
   */
  function tryRead(key) {
    let val;
    try {
      val = backing.getItem(key);
    } catch (e) {
      return { status: 'error', message: e?.message ?? String(e) };
    }
    if (val === null) return { status: 'missing' };
    return { status: 'ok', value: val };
  }

  /**
   * Write with immediate readback verification and null-safe restore on mismatch.
   *
   * Steps:
   *   1. Capture prevBytes before any write (for restore on mismatch).
   *   2. Attempt setItem. On throw → write_failed (storage unchanged).
   *   3. Immediate readback via getItem. On throw → treat as mismatch.
   *   4. If readBack === newValue → { ok:true }.
   *   5. Else → attempt restore, return distinct code.
   *
   * @param {string} key
   * @param {string} newValue  — must be a non-null string; caller is responsible
   * @returns {{ ok:true }
   *          |{ ok:false, code:'write_failed', message:string }
   *          |{ ok:false, code:'readback_mismatch_restored', message:string }
   *          |{ ok:false, code:'readback_mismatch_restore_failed',
   *             message:string, restoreError:string }}
   */
  function setAndVerify(key, newValue) {
    // Step 1: capture prevBytes for null-safe restore.
    const before = tryRead(key);
    // If the pre-write read itself threw, prevBytes is null (treated as absent).
    // This is safe: if we cannot confirm the prior value, we restore to absent.
    const prevBytes = before.status === 'ok' ? before.value : null;

    // Step 2: attempt write.
    try {
      backing.setItem(key, newValue);
    } catch (e) {
      return {
        ok:      false,
        code:    'write_failed',
        message: `setItem("${key}") failed: ${e?.message ?? String(e)}`,
      };
    }

    // Step 3: immediate readback.
    let readBack;
    try {
      readBack = backing.getItem(key);
    } catch (e) {
      return _restoreOnMismatch(
        key, prevBytes,
        `getItem readback threw on "${key}": ${e?.message ?? String(e)}`,
      );
    }

    // Step 4: confirm byte-identity.
    if (readBack === newValue) return { ok: true };

    // Step 5: mismatch — attempt restore.
    return _restoreOnMismatch(key, prevBytes, `readback mismatch on "${key}"`);
  }

  /**
   * Restore the previous value (null = key was absent) and verify.
   * Returns a distinct code depending on restore outcome.
   * @private
   */
  function _restoreOnMismatch(key, prevBytes, reason) {
    let restoreOk = false;
    let restoreError = null;

    try {
      if (prevBytes === null) {
        // Key was absent before the write — restore by removing.
        backing.removeItem(key);
        const check = backing.getItem(key);
        if (check !== null) {
          throw new Error(`removeItem("${key}") did not clear the key`);
        }
      } else {
        // Key had a value — restore byte-exactly.
        backing.setItem(key, prevBytes);
        const check = backing.getItem(key);
        if (check !== prevBytes) {
          throw new Error(`restore readback mismatch on "${key}"`);
        }
      }
      restoreOk = true;
    } catch (e) {
      restoreError = e?.message ?? String(e);
    }

    if (restoreOk) {
      return {
        ok:      false,
        code:    'readback_mismatch_restored',
        message: `${reason} — previous value restored.`,
      };
    }
    return {
      ok:           false,
      code:         'readback_mismatch_restore_failed',
      message:      `${reason} — restore also failed: ${restoreError}`,
      restoreError,
    };
  }

  /**
   * Remove a key from storage.
   *
   * @param {string} key
   * @returns {{ ok:true }|{ ok:false, message:string }}
   */
  function removeItem(key) {
    try {
      backing.removeItem(key);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  return { tryRead, setAndVerify, removeItem };
}
