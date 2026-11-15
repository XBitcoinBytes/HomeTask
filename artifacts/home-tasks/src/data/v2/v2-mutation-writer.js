/**
 * v2-mutation-writer.js — Crash-safe 4-step mutation writer for hometask-v2.
 *
 * Provides `writeMutation` for post-activation normal writes (Done/Skip/prefs).
 * The 4-step sequence maintains a crash-safe mutation journal so that startup
 * recovery can always restore or select the last known-good payload.
 *
 * Write sequence (all inside the exclusive lock callback):
 *   Step 1: Write+verify JOURNAL (phase:'prepared', prevDigest, prevRaw, newDigest, generation, transactionId?)
 *   Step 2: Write+verify DATA (hometask-v2)
 *   Step 3: Write+verify LIVE-STATE (generation, digest, schemaVersion) — LAST committed record
 *   Step 4: Clear JOURNAL (best-effort; stale journal is handled at next startup)
 *
 * Cross-context locking (ExclusiveMutationLock):
 *   Every call to writeMutation requires an injected lock provider satisfying:
 *     lock.runExclusive(transactionId, async () => result)
 *       → Promise<{ok:true, result}|{ok:false, code, message?}>
 *   The provider must hold exclusivity for the entire callback and release
 *   automatically on callback settle. All storage reads and writes occur
 *   inside the callback (post-lock reads only — no stale pre-lock state).
 *   Absent, malformed, denied, throwing, or timed-out providers all return
 *   concurrency-unavailable before touching any mutation key.
 *
 * Invariants (Correction 2):
 *   - If prevRaw exceeds MAX_JOURNAL_RAW bytes, abort with { ok:false, code:'journal-too-large' }
 *     BEFORE writing any journal or touching DATA/LIVE-STATE. Never store truncated prevRaw.
 *   - LIVE-STATE.digest always points to committed DATA bytes; never updated until DATA is
 *     verified. A startup that sees LIVE-STATE.digest == sha256(DATA) is always clean.
 *   - In ambiguous states (journal recovery), all original records are retained;
 *     only journal copies go to QUARANTINE (via activation-tx.js quarantineEvidence).
 *
 * Pure module: no localStorage, no DOM, no clock reads.
 * All impure inputs are injected.
 */

import {
  ACTIVATION_KEYS, ACTIVATION_TARGET_SCHEMA,
  buildLiveState, recoverMutationStartup,
} from '../../v2/activation-tx.js';
import { webCryptoDigest } from '../../v2/shadow-fingerprint.js';
import { ADAPTER_TIMEOUT_MS } from '../../v2/shadow-migrate.js';

/* ── Constants ───────────────────────────────────────────────────── */

/** Maximum bytes for prevRaw in a journal record.
 *  Per correction 2: if prevRaw exceeds this bound, abort before writing journal.
 *  A future compaction policy can handle growth. */
export const MAX_JOURNAL_RAW = 250 * 1024;

const DEFAULT_SCHEDULER = {
  setTimeout:   (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id)     => globalThis.clearTimeout(id),
};

/* ── Timeout helper (mirrors activation-tx.js) ───────────────────── */

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

/* ── Adapter helpers ─────────────────────────────────────────────── */

async function aGet(adapter, key, timeoutMs, scheduler) {
  return withTimeout(Promise.resolve(adapter.getItem(key)),
    `getItem("${key}")`, timeoutMs, scheduler);
}

async function aSet(adapter, key, value, timeoutMs, scheduler) {
  return withTimeout(Promise.resolve(adapter.setItem(key, value)),
    `setItem("${key}")`, timeoutMs, scheduler);
}

async function aRemove(adapter, key, timeoutMs, scheduler) {
  return withTimeout(Promise.resolve(adapter.removeItem(key)),
    `removeItem("${key}")`, timeoutMs, scheduler);
}

async function setAndVerify(adapter, key, value, timeoutMs, scheduler) {
  try { await aSet(adapter, key, value, timeoutMs, scheduler); }
  catch (e) { return { ok: false, error: `write-failed:${key}:${e?.message ?? e}` }; }
  let readBack;
  try { readBack = await aGet(adapter, key, timeoutMs, scheduler); }
  catch (e) { return { ok: false, error: `readback-failed:${key}:${e?.message ?? e}` }; }
  if (readBack !== value) return { ok: false, error: `readback-mismatch:${key}` };
  return { ok: true };
}

/* ── Journal helpers ─────────────────────────────────────────────── */

/**
 * Build a journal record. prevRaw must be the exact current DATA bytes (or '' for
 * first write). Never store truncated prevRaw — caller must check size first.
 * transactionId is optional; included in the journal as crash-recovery evidence
 * (not consulted by the recovery logic — standard 9-row table applies).
 */
export function buildJournal(generation, prevDigest, prevRaw, newDigest, transactionId = null) {
  const j = { phase: 'prepared', generation, prevDigest, prevRaw, newDigest };
  if (transactionId !== null) j.transactionId = transactionId;
  return j;
}

/**
 * Parse and validate a journal record from raw storage string.
 * Returns null if absent, malformed, or has an unknown phase.
 */
export function parseJournal(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object' || j.phase !== 'prepared') return null;
  if (typeof j.generation !== 'number') return null;
  if (typeof j.prevDigest !== 'string') return null;
  if (typeof j.newDigest  !== 'string') return null;
  // prevRaw may be absent if first write (prevDigest is '')
  return j;
}

/* ── LIVE-STATE helpers ──────────────────────────────────────────── */

/**
 * Parse and validate a LIVE-STATE record from raw storage string.
 * Returns null if absent, malformed, or wrong schemaVersion.
 */
export function parseLiveState(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let ls;
  try { ls = JSON.parse(raw); } catch { return null; }
  if (!ls || typeof ls !== 'object') return null;
  if (typeof ls.generation !== 'number') return null;
  if (typeof ls.digest     !== 'string') return null;
  if (ls.schemaVersion !== ACTIVATION_TARGET_SCHEMA) return null;
  return ls;
}

/* ── Critical section (all mutation storage ops) ─────────────────── */

/**
 * Execute all mutation storage reads and writes for a single v2 payload
 * update. Must be called from inside an exclusive lock callback — all reads
 * are post-lock, reflecting the canonical committed state at that moment.
 *
 * Exported so that V2Repository can call it directly from inside its own
 * lock.runExclusive callback (avoiding double-lock acquisition). External
 * callers that do not manage their own lock must use writeMutation instead.
 *
 * @param {{ getItem, setItem, removeItem }} adapter
 * @param {string}      newRawV2      — serialised new payload (non-empty)
 * @param {string|null} transactionId — owner label for journal evidence
 * @param {Function}    digestFn      — SHA-256 digest
 * @param {number}      timeoutMs     — per-op timeout (0 = no timeout)
 * @param {object}      scheduler     — { setTimeout, clearTimeout }
 * @returns {Promise<{ok:true}|{ok:false,code:string,message:string}>}
 */
export async function writeLockedMutation(
  adapter, newRawV2, transactionId, digestFn, timeoutMs, scheduler,
) {
  // ── Post-lock re-read: DATA (canonical current state) ──────────
  let currentRaw = null;
  try { currentRaw = await aGet(adapter, ACTIVATION_KEYS.DATA, timeoutMs, scheduler); } catch {}
  const prevRaw      = (typeof currentRaw === 'string') ? currentRaw : '';
  const isFirstWrite = prevRaw === '';

  // Correction 2: abort before any journal write if prevRaw too large.
  // DATA and LIVE-STATE remain byte-identical.
  if (prevRaw.length > MAX_JOURNAL_RAW) {
    return {
      ok: false, code: 'journal-too-large',
      message: `Current v2 payload (${prevRaw.length} bytes) exceeds journal bound (${MAX_JOURNAL_RAW} bytes). ` +
               'Write aborted; DATA and LIVE-STATE are unchanged. A future compaction policy must reduce size.',
    };
  }

  // ── Post-lock re-read: LIVE-STATE (canonical generation) ───────
  let currentGeneration = -1;
  let lsRaw = null;
  try { lsRaw = await aGet(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler); } catch {}
  const ls = parseLiveState(lsRaw);
  if (ls) currentGeneration = ls.generation;

  const nextGeneration = currentGeneration + 1;

  // ── Compute digests ────────────────────────────────────────────
  let prevDigest = '';
  if (!isFirstWrite) {
    try {
      const bytes = new TextEncoder().encode(prevRaw);
      prevDigest = await withTimeout(
        Promise.resolve(digestFn(bytes)), 'prev-digest', timeoutMs, scheduler,
      );
    } catch (e) {
      return { ok: false, code: 'digest-failed', message: `prevDigest computation failed: ${e?.message ?? e}` };
    }
  }

  let newDigest;
  try {
    const bytes = new TextEncoder().encode(newRawV2);
    newDigest = await withTimeout(
      Promise.resolve(digestFn(bytes)), 'new-digest', timeoutMs, scheduler,
    );
  } catch (e) {
    return { ok: false, code: 'digest-failed', message: `newDigest computation failed: ${e?.message ?? e}` };
  }

  // ── Step 1: Write+verify JOURNAL ───────────────────────────────
  const journal    = buildJournal(nextGeneration, prevDigest, prevRaw, newDigest, transactionId);
  const journalWr  = await setAndVerify(
    adapter, ACTIVATION_KEYS.MUT_JOURNAL, JSON.stringify(journal), timeoutMs, scheduler,
  );
  if (!journalWr.ok) {
    // DATA and LIVE-STATE are unchanged — safe to return failure.
    return {
      ok: false, code: 'journal-write-failed',
      message: `Journal write failed (${journalWr.error}). DATA and LIVE-STATE are unchanged.`,
    };
  }

  // ── Step 2: Write+verify DATA ──────────────────────────────────
  const dataWr = await setAndVerify(
    adapter, ACTIVATION_KEYS.DATA, newRawV2, timeoutMs, scheduler,
  );
  if (!dataWr.ok) {
    // DATA write failed or produced a readback mismatch.
    // Attempt to restore DATA from prevRaw (captured post-lock above).
    // Track both sub-outcomes separately so callers can accurately classify the result:
    //   dataRestoreOk=true   — setAndVerify(DATA, prevRaw) passed (readback matched prevRaw)
    //   journalCleanupOk=true — removeItem(JOURNAL) + verified readback returned null
    // Both must be true for the caller to safely surface 'rolled-back'.
    // If either is false, the journal is retained as startup-recovery evidence.
    let dataRestoreOk    = false;
    let journalCleanupOk = false;

    if (!isFirstWrite && prevRaw.length > 0) {
      try {
        const restoreWr = await setAndVerify(
          adapter, ACTIVATION_KEYS.DATA, prevRaw, timeoutMs, scheduler,
        );
        if (restoreWr.ok) {
          dataRestoreOk = true;
          // Verified journal removal: removeItem must succeed AND readback must confirm null.
          // A silent no-op removeItem or a hanging/throwing removeItem leaves journalCleanupOk false.
          try {
            await aRemove(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler);
            const journalAfter = await aGet(
              adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler,
            );
            if (journalAfter === null || journalAfter === undefined) {
              journalCleanupOk = true;
            }
            // If readback returns a value: removeItem was a silent no-op; journalCleanupOk stays false.
          } catch {
            // aRemove threw (quota/timeout) or readback aGet threw — cannot verify journal absence.
            // journalCleanupOk stays false; journal may still be present for startup recovery.
          }
        }
        // If restore fails, journal is retained for startup recovery; both flags remain false.
      } catch {
        // Outer guard: unexpected throw from setAndVerify itself; both flags remain false.
      }
    }

    return {
      ok: false, code: 'data-write-failed',
      dataRestoreOk, journalCleanupOk,
      message: `DATA write failed (${dataWr.error}). ` + (
        dataRestoreOk && journalCleanupOk
          ? 'DATA restored to prior bytes; journal cleared.'
          : 'Journal retained for startup recovery — DATA may be inconsistent.'
      ),
    };
  }

  // ── Step 3: Write+verify LIVE-STATE (last committed record) ───
  const newLiveState  = buildLiveState(nextGeneration, newDigest);
  const liveStateWr   = await setAndVerify(
    adapter, ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(newLiveState), timeoutMs, scheduler,
  );
  if (!liveStateWr.ok) {
    // DATA already contains new bytes; LIVE-STATE still points to previous.
    // Journal retained for startup recovery (case A: DATA matches journal.newDigest).
    return {
      ok: false, code: 'live-state-write-failed',
      message: `LIVE-STATE write failed (${liveStateWr.error}). ` +
               'DATA is updated but LIVE-STATE is stale. Journal retained for startup recovery.',
    };
  }

  // ── Step 4: Clear JOURNAL (best-effort) ───────────────────────
  // If clear fails, the stale journal will be handled at next startup
  // (LIVE-STATE.digest == sha256(DATA) → detected as stale journal, cleared).
  try { await aRemove(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler); } catch {}

  return { ok: true };
}

/* ── Core: writeMutation ─────────────────────────────────────────── */

/**
 * Write a new v2 payload using the 4-step crash-safe sequence.
 *
 * Requires an injected ExclusiveMutationLock provider:
 *   lock.runExclusive(transactionId, async () => mutationResult)
 *     → Promise<{ok:true, result}|{ok:false, code, message?}>
 *
 * The provider must acquire exclusivity before invoking the callback and
 * release on callback settle. All storage reads/writes execute inside the
 * callback (post-lock reads only). Absent, malformed, denied, throwing, or
 * timed-out providers return concurrency-unavailable before any storage op.
 *
 * @param {{ getItem, setItem, removeItem }} adapter
 * @param {string}   newRawV2     — the complete new hometask-v2 serialization
 * @param {object}   opts
 * @param {object}   opts.lock          — ExclusiveMutationLock (required)
 * @param {string|null} [opts.transactionId] — owner label for journal evidence
 * @param {Function} [opts.digestFn]    — SHA-256 digest function (default: webCryptoDigest)
 * @param {number}   [opts.timeoutMs]   — per-operation timeout (ms)
 * @param {object}   [opts.scheduler]   — { setTimeout, clearTimeout }
 *
 * @returns {Promise<{
 *   ok: true
 * } | {
 *   ok: false,
 *   code: 'invalid-input'|'concurrency-unavailable'|'journal-too-large'|
 *         'journal-write-failed'|'data-write-failed'|'live-state-write-failed'|string,
 *   message: string
 * }>}
 */
export async function writeMutation(adapter, newRawV2, {
  digestFn      = webCryptoDigest,
  timeoutMs     = ADAPTER_TIMEOUT_MS,
  scheduler     = DEFAULT_SCHEDULER,
  lock          = undefined,
  transactionId = null,
} = {}) {

  // ── Input validation (before any lock or storage interaction) ──
  if (typeof newRawV2 !== 'string' || newRawV2.length === 0) {
    return { ok: false, code: 'invalid-input', message: 'newRawV2 must be a non-empty string' };
  }

  // ── Lock required — absent or malformed: fail closed ──────────
  // This check fires before any storage read or write.
  if (lock == null || typeof lock.runExclusive !== 'function') {
    return {
      ok: false, code: 'concurrency-unavailable',
      message: 'No ExclusiveMutationLock provider injected (lock.runExclusive is required). ' +
               'Zero mutation-key writes performed.',
    };
  }

  // ── Run all storage work inside the exclusive callback ─────────
  // If runExclusive throws (provider error, timeout, etc.) → concurrency-unavailable.
  // If runExclusive returns {ok:false} (denied, quota, etc.) → concurrency-unavailable.
  // The callback itself returns the mutation result.
  let lockResult;
  try {
    lockResult = await lock.runExclusive(
      transactionId,
      () => writeLockedMutation(
        adapter, newRawV2, transactionId, digestFn, timeoutMs, scheduler,
      ),
    );
  } catch (e) {
    return {
      ok: false, code: 'concurrency-unavailable',
      message: `lock.runExclusive threw: ${e?.message ?? e}. Zero mutation-key writes performed.`,
    };
  }

  // Provider refused (denied, busy, timeout — lock never ran the callback).
  if (!lockResult || lockResult.ok !== true) {
    return {
      ok: false, code: 'concurrency-unavailable',
      message: lockResult?.message ??
               `Lock denied (code: ${lockResult?.code ?? 'unknown'}). Zero mutation-key writes performed.`,
    };
  }

  // Unwrap and return the inner mutation result.
  return lockResult.result;
}
