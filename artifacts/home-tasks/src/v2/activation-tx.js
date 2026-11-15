/**
 * activation-tx.js — v2 activation transaction controller.
 *
 * Implements: snapshot_verified → staged → v2_written → committed
 * with startup recovery, concurrent-v1-mutation detection, and
 * comprehensive malformed-evidence quarantine.
 *
 * With V2_ACTIVATION_ENABLED = false, runActivation() returns
 * { ok: false, code: 'disabled' } immediately without touching storage.
 *
 * Pure module: no localStorage, no DOM, no clock reads.
 * All impure inputs are injected (adapter, catalog, today, clock, digestFn,
 * timeoutMs, scheduler).
 *
 * NOT connected to the production entry point during CP5A. recoverActivation-
 * Startup() is designed and structurally tested to be callable before any
 * authoritative storage read; production wiring is deferred to CP5B.
 */

import { V2_ACTIVATION_ENABLED }                               from './activation-config.js';
import { isValidVerifiedWrapper }                               from './shadow-validate.js';
import { buildFingerprint, fingerprintsMatch, webCryptoDigest,
         isCanonicalFingerprint }                               from './shadow-fingerprint.js';
import { validateEnvelope }                                     from './migrate.js';
import { assertEquivalent }                                     from './equivalence.js';
import { SHADOW_KEY, SOURCE_KEYS, ADAPTER_TIMEOUT_MS }         from './shadow-migrate.js';

/* ── Public constants ────────────────────────────────────────────── */

export const ACTIVATION_TX_VERSION  = 1;
export const ACTIVATION_MARKER_VERSION = 1;
export const ACTIVATION_TARGET_SCHEMA  = 2;
/** Maximum UTF-8 bytes stored in a quarantine record's rawData field. */
export const QUARANTINE_MAX_RAW     = 250 * 1024;

/**
 * Storage keys used exclusively by the activation controller.
 * None overlap with import-tx.js (V2_KEYS) or shadow-migrate.js keys.
 */
export const ACTIVATION_KEYS = Object.freeze({
  SNAPSHOT:    'hometask-v2-activation-snapshot',   // §G pre-activation v1 snapshot
  STAGING:     'hometask-v2-activation-staging',    // transaction state machine record
  MARKER:      'hometask-v2-activation-marker',     // authority marker — written LAST
  QUARANTINE:  'hometask-v2-activation-quarantine', // bounded evidence for malformed/aborted artifacts
  DATA:        'hometask-v2',                        // final v2 data (shared with import-tx DATA)
  LIVE_STATE:  'hometask-v2-live-state',            // live-integrity record: { generation, digest, schemaVersion }
  MUT_JOURNAL: 'hometask-v2-mutation-journal',      // crash-safe mutation journal: { phase, generation, prevDigest, prevRaw, newDigest }
});

/**
 * Exact §G v1 source key list for the pre-activation snapshot.
 * Callers cannot override this list — the approved set is fixed.
 */
export const ACTIVATION_SOURCE_KEYS = SOURCE_KEYS;   // Object.freeze([...]) in shadow-migrate.js

/* ── Timeout abstraction (mirrors shadow-migrate.js) ─────────────── */

const DEFAULT_SCHEDULER = {
  setTimeout:   (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id)     => globalThis.clearTimeout(id),
};

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

/* ── Async adapter helpers with timeout ──────────────────────────── */

async function aGet(adapter, key, timeoutMs, scheduler) {
  return withTimeout(
    Promise.resolve(adapter.getItem(key)),
    `getItem("${key}")`, timeoutMs, scheduler,
  );
}
async function aSet(adapter, key, value, timeoutMs, scheduler) {
  return withTimeout(
    Promise.resolve(adapter.setItem(key, value)),
    `setItem("${key}")`, timeoutMs, scheduler,
  );
}
async function aRemove(adapter, key, timeoutMs, scheduler) {
  return withTimeout(
    Promise.resolve(adapter.removeItem(key)),
    `removeItem("${key}")`, timeoutMs, scheduler,
  );
}

/**
 * Write a value and read it back within timeout; fail if they differ byte-for-byte.
 * Detects storage layers that silently truncate, transform, or lose writes.
 */
async function setAndVerify(adapter, key, value, timeoutMs, scheduler) {
  try { await aSet(adapter, key, value, timeoutMs, scheduler); }
  catch (e) { return { ok: false, error: `write-failed:${key}:${e?.message ?? e}` }; }
  let readBack;
  try { readBack = await aGet(adapter, key, timeoutMs, scheduler); }
  catch (e) { return { ok: false, error: `readback-failed:${key}:${e?.message ?? e}` }; }
  if (readBack !== value) return { ok: false, error: `readback-mismatch:${key}` };
  return { ok: true };
}

/* ── §G Snapshot ─────────────────────────────────────────────────── */

/**
 * Capture the exact §G v1 source keys into the activation snapshot.
 * Writes to ACTIVATION_KEYS.SNAPSHOT, reads back, and verifies byte-for-byte.
 * Aborts before touching authoritative storage on any failure.
 *
 * null is stored for absent keys — the string "null" is never written.
 *
 * @returns {Promise<{ ok: boolean, code?: string, detail?: string }>}
 */
export async function saveActivationSnapshot(adapter, clock, timeoutMs, scheduler) {
  const keys = {};
  for (const k of ACTIVATION_SOURCE_KEYS) {
    let v;
    try { v = await aGet(adapter, k, timeoutMs, scheduler); }
    catch (e) { return { ok: false, code: 'snapshot-read-failed', detail: `${k}:${e?.message ?? e}` }; }
    keys[k] = (typeof v === 'string') ? v : null;
  }
  const snap = { savedAt: clock, keys };
  const serialized = JSON.stringify(snap);
  const wr = await setAndVerify(adapter, ACTIVATION_KEYS.SNAPSHOT, serialized, timeoutMs, scheduler);
  if (!wr.ok) return { ok: false, code: 'snapshot-write-failed', detail: wr.error };
  return { ok: true };
}

/**
 * Read and parse the activation snapshot. Returns null on any failure.
 */
export async function getActivationSnapshot(adapter, timeoutMs, scheduler) {
  let raw;
  try { raw = await aGet(adapter, ACTIVATION_KEYS.SNAPSHOT, timeoutMs, scheduler); }
  catch { return null; }
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw);
    if (snap && typeof snap.keys === 'object' && !Array.isArray(snap.keys)) return snap;
    return null;
  } catch { return null; }
}

/**
 * Restore snapshotted §G source keys byte-for-byte.
 * null/undefined → removeItem (never writes the string "null").
 * Does NOT delete the snapshot itself (retained per §G retention policy).
 *
 * PRECONDITION: caller must verify current v1 bytes match snapshot before
 * calling this — only call when byte-identity has been confirmed so that
 * newer concurrent v1 data is never overwritten.
 *
 * @returns {Promise<{ ok: boolean, error?: string, restored: string[] }>}
 */
export async function restoreFromSnapshot(adapter, snap, timeoutMs, scheduler) {
  if (!snap || typeof snap.keys !== 'object' || Array.isArray(snap.keys)) {
    return { ok: false, error: 'invalid-snapshot', restored: [] };
  }
  const restored = [];
  for (const [k, v] of Object.entries(snap.keys)) {
    try {
      if (v === null || v === undefined) {
        await aRemove(adapter, k, timeoutMs, scheduler);
        let check;
        try { check = await aGet(adapter, k, timeoutMs, scheduler); } catch { check = null; }
        if (check !== null) throw new Error('remove-verify-mismatch');
      } else {
        const wr = await setAndVerify(adapter, k, v, timeoutMs, scheduler);
        if (!wr.ok) throw new Error(wr.error);
      }
      restored.push(k);
    } catch (e) {
      return { ok: false, error: `restore-failed:${k}:${e?.message ?? e}`, restored };
    }
  }
  return { ok: true, restored };
}

/* ── Staging helpers ─────────────────────────────────────────────── */

async function stagingRead(adapter, timeoutMs, scheduler) {
  let raw;
  try { raw = await aGet(adapter, ACTIVATION_KEYS.STAGING, timeoutMs, scheduler); }
  catch { return null; }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
  } catch { return null; }
}

async function stagingWrite(adapter, record, timeoutMs, scheduler) {
  return setAndVerify(adapter, ACTIVATION_KEYS.STAGING, JSON.stringify(record), timeoutMs, scheduler);
}

async function stagingPatch(adapter, updates, timeoutMs, scheduler) {
  const cur = await stagingRead(adapter, timeoutMs, scheduler);
  const next = { ...(cur ?? {}), ...updates };
  return stagingWrite(adapter, next, timeoutMs, scheduler);
}

async function stagingClear(adapter, timeoutMs, scheduler) {
  try { await aRemove(adapter, ACTIVATION_KEYS.STAGING, timeoutMs, scheduler); return { ok: true }; }
  catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
}

/* ── Authority marker ────────────────────────────────────────────── */

/**
 * Build the authority marker payload (not yet written to storage).
 * v2DataDigest must be supplied by the caller (computed from stored v2 bytes).
 */
export function buildMarker({ activationId, sourceFingerprint, v2DataDigest, committedAt }) {
  return {
    markerVersion:     ACTIVATION_MARKER_VERSION,
    activationId,
    sourceFingerprint,
    v2DataDigest,
    targetSchema:      ACTIVATION_TARGET_SCHEMA,
    committedAt,
  };
}

/**
 * Structural validation for a marker object.
 * Does NOT verify v2DataDigest against stored bytes (that requires async I/O).
 */
function isWellFormedMarker(m) {
  return (
    m !== null && typeof m === 'object' && !Array.isArray(m) &&
    m.markerVersion   === ACTIVATION_MARKER_VERSION           &&
    typeof m.activationId === 'string' && m.activationId.length > 0 &&
    isCanonicalFingerprint(m.sourceFingerprint)                &&
    isCanonicalFingerprint(m.v2DataDigest)                     &&
    m.targetSchema    === ACTIVATION_TARGET_SCHEMA             &&
    typeof m.committedAt === 'string' && m.committedAt.length > 0
  );
}

/**
 * Read and parse the authority marker. Returns null on any I/O or parse failure.
 */
async function markerRead(adapter, timeoutMs, scheduler) {
  let raw;
  try { raw = await aGet(adapter, ACTIVATION_KEYS.MARKER, timeoutMs, scheduler); }
  catch { return null; }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
  } catch { return null; }
}

/**
 * Structural-only marker validation (synchronous, no I/O).
 * Checks all required fields, types, and constrained values.
 * Does NOT verify v2DataDigest against stored bytes — that is LIVE-STATE's job.
 * The marker's v2DataDigest is an activation-time certificate; routine startup
 * never re-verifies it against current DATA (mutations legitimately change DATA).
 *
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateMarkerStructure(marker) {
  if (!isWellFormedMarker(marker)) return { valid: false, reason: 'malformed-marker' };
  return { valid: true };
}

/**
 * Build a LIVE-STATE record. Pure; no I/O.
 * @param {number} generation — 0 at activation; increments with each successful mutation.
 * @param {string} digest     — SHA-256 hex of current hometask-v2 bytes.
 * @returns {{ generation: number, digest: string, schemaVersion: number }}
 */
export function buildLiveState(generation, digest) {
  return { generation, digest, schemaVersion: ACTIVATION_TARGET_SCHEMA };
}

/**
 * Fully validate the authority marker:
 * 1. Structural shape (all required fields, correct types/values)
 * 2. v2DataDigest matches a freshly computed digest of the stored v2 bytes
 *
 * NOTE: This combined check is used only at COMMIT TIME (inside runActivationTransaction)
 * to prove the initial v2 write was faithful. Routine startup uses validateMarkerStructure
 * only; live-data integrity is delegated to the LIVE-STATE record.
 *
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function validateMarker(marker, adapter, digestFn, timeoutMs, scheduler) {
  if (!isWellFormedMarker(marker)) {
    return { valid: false, reason: 'malformed-marker' };
  }
  // Recompute digest of stored v2 bytes and verify it matches the marker claim.
  let v2Raw;
  try { v2Raw = await aGet(adapter, ACTIVATION_KEYS.DATA, timeoutMs, scheduler); }
  catch (e) { return { valid: false, reason: `v2-read-failed:${e?.message ?? e}` }; }
  if (typeof v2Raw !== 'string' || v2Raw.length === 0) {
    return { valid: false, reason: 'v2-data-absent-or-empty' };
  }
  let liveDigest;
  try {
    const bytes = new TextEncoder().encode(v2Raw);
    liveDigest = await withTimeout(
      Promise.resolve(digestFn(bytes)),
      'v2DataDigest-verify', timeoutMs, scheduler,
    );
  } catch (e) { return { valid: false, reason: `digest-failed:${e?.message ?? e}` }; }
  if (!fingerprintsMatch(liveDigest, marker.v2DataDigest)) {
    return { valid: false, reason: 'v2DataDigest-mismatch' };
  }
  return { valid: true };
}

/* ── Quarantine ──────────────────────────────────────────────────── */

/**
 * Write evidence to the quarantine key (bounded; QUARANTINE_MAX_RAW cap).
 * Verifies the write before removing the source. If quarantine write fails,
 * retains the original and returns { saved: false }.
 * Never discards the last recoverable copy.
 */
async function quarantineEvidence(adapter, sourceKey, reason, clock, timeoutMs, scheduler) {
  let raw = null;
  try { raw = await aGet(adapter, sourceKey, timeoutMs, scheduler); } catch { /* non-fatal */ }
  if (raw === null) return { saved: false, reason: 'source-absent' };

  const str = typeof raw === 'string' ? raw : '';
  const truncated = str.length > QUARANTINE_MAX_RAW;
  const capped = truncated ? str.slice(0, QUARANTINE_MAX_RAW) : str;
  const record = {
    quarantinedAt: clock, reason, sourceKey,
    originalLength: str.length, storedLength: capped.length,
    truncated, rawData: capped,
  };
  const serialized = JSON.stringify(record);
  const wr = await setAndVerify(adapter, ACTIVATION_KEYS.QUARANTINE, serialized, timeoutMs, scheduler);
  if (!wr.ok) {
    // Quarantine write failed — retain original, do not remove.
    return { saved: false, detail: wr.error };
  }
  // Quarantine verified — safe to remove the incomplete artifact.
  try { await aRemove(adapter, sourceKey, timeoutMs, scheduler); }
  catch { /* non-fatal — quarantine succeeded; source may remain */ }
  return { saved: true };
}

/* ── Concurrent-v1 fingerprint check ─────────────────────────────── */

/**
 * Recompute the §G source fingerprint from current storage and compare it
 * against expectedFingerprint.
 *
 * Called immediately before writing the authority marker. Must match:
 *   - the fingerprint captured before snapshot/migration (expectedFingerprint)
 *   - the shadow sourceFingerprint
 *   - the fingerprint recorded in staging
 *   - the fingerprint embedded in the proposed marker payload
 *
 * @returns {Promise<{ ok: boolean, code?: string, liveFingerprint?: string }>}
 */
export async function recomputeAndVerifyFingerprint(
  adapter, expectedFingerprint, digestFn, timeoutMs, scheduler,
) {
  const sourceSnapshot = {};
  for (const k of ACTIVATION_SOURCE_KEYS) {
    let v;
    try { v = await aGet(adapter, k, timeoutMs, scheduler); }
    catch (e) { return { ok: false, code: `source-read-failed:${k}:${e?.message ?? e}` }; }
    sourceSnapshot[k] = (typeof v === 'string') ? v : null;
  }
  let liveFingerprint;
  try {
    liveFingerprint = await withTimeout(
      Promise.resolve(buildFingerprint(sourceSnapshot, digestFn)),
      'pre-marker-fingerprint', timeoutMs, scheduler,
    );
  } catch (e) { return { ok: false, code: `fingerprint-failed:${e?.message ?? e}` }; }
  if (!fingerprintsMatch(liveFingerprint, expectedFingerprint)) {
    return { ok: false, code: 'source_changed', liveFingerprint };
  }
  return { ok: true, liveFingerprint };
}

/* ── Precondition checks ─────────────────────────────────────────── */

/**
 * Verify all 5 activation preconditions. Leaves storage byte-identical
 * on any failure — no writes performed here.
 *
 * (a) Existing shadow wrapper passes isValidVerifiedWrapper()
 * (b) wrapper.sourceFingerprint matches a fresh §G digest of current v1 data
 * (c) wrapper.candidate passes complete validateEnvelope()
 * (d) assertEquivalent() reports zero unexpected differences
 * (e) No conflicting activation transaction already in progress
 *
 * @returns {Promise<{ ok: true, wrapper, candidate, sourceFingerprint }
 *                  |{ ok: false, code: string, detail: string }>}
 */
export async function checkActivationPreconditions({
  adapter, catalog, today,
  shadowKey  = SHADOW_KEY,
  digestFn   = webCryptoDigest,
  timeoutMs  = ADAPTER_TIMEOUT_MS,
  scheduler  = DEFAULT_SCHEDULER,
}) {
  // (e) No conflicting transaction in progress
  const existing = await stagingRead(adapter, timeoutMs, scheduler);
  if (existing !== null && existing.txState !== 'committed') {
    return {
      ok: false, code: 'conflicting-transaction',
      detail: `existing activation in state: ${existing?.txState ?? 'unknown'}`,
    };
  }

  // (a) Shadow wrapper must pass canonical validation
  let shadowRaw;
  try { shadowRaw = await aGet(adapter, shadowKey, timeoutMs, scheduler); }
  catch (e) { return { ok: false, code: 'shadow-read-failed', detail: e?.message ?? String(e) }; }
  if (!shadowRaw) return { ok: false, code: 'shadow-absent', detail: 'no shadow wrapper found' };
  let wrapper;
  try { wrapper = JSON.parse(shadowRaw); } catch { wrapper = null; }
  if (!isValidVerifiedWrapper(wrapper)) {
    return { ok: false, code: 'shadow-invalid', detail: 'isValidVerifiedWrapper() failed' };
  }

  // Read v1 source keys for fingerprint
  const sourceSnapshot = {};
  for (const k of ACTIVATION_SOURCE_KEYS) {
    let v;
    try { v = await aGet(adapter, k, timeoutMs, scheduler); }
    catch (e) { return { ok: false, code: 'source-read-failed', detail: `${k}:${e?.message ?? e}` }; }
    sourceSnapshot[k] = (typeof v === 'string') ? v : null;
  }

  // (b) Fresh fingerprint must match shadow's recorded sourceFingerprint
  let freshFingerprint;
  try {
    freshFingerprint = await withTimeout(
      Promise.resolve(buildFingerprint(sourceSnapshot, digestFn)),
      'precondition-fingerprint', timeoutMs, scheduler,
    );
  } catch (e) { return { ok: false, code: 'fingerprint-failed', detail: e?.message ?? String(e) }; }
  if (!fingerprintsMatch(wrapper.sourceFingerprint, freshFingerprint)) {
    return { ok: false, code: 'fingerprint-mismatch', detail: 'shadow sourceFingerprint does not match current v1' };
  }

  // (c) Candidate must pass the complete canonical envelope validator
  const candidate = wrapper.candidate;
  const envResult = validateEnvelope(candidate);
  if (!envResult.ok) {
    return { ok: false, code: 'envelope-invalid', detail: `validateEnvelope: ${envResult.errors.join('; ')}` };
  }

  // (d) assertEquivalent must report zero unexpected differences
  const v1Raw = {
    tasks: (() => { try { return JSON.parse(sourceSnapshot['hometask-v1'] ?? 'null') ?? []; } catch { return []; } })(),
    meta:  (() => { try { return JSON.parse(sourceSnapshot['hometask-meta-v1'] ?? 'null') ?? {}; } catch { return {}; } })(),
  };
  let diffs;
  try { diffs = assertEquivalent(catalog, v1Raw, candidate, today); }
  catch (e) { return { ok: false, code: 'equivalence-threw', detail: e?.message ?? String(e) }; }
  if (diffs.length > 0) {
    return { ok: false, code: 'equivalence-failed', detail: `${diffs.length} unexpected diff(s)` };
  }

  return { ok: true, wrapper, candidate, sourceFingerprint: freshFingerprint };
}

/* ── Activation transaction ──────────────────────────────────────── */

/**
 * Run the full activation transaction. Assumes preconditions have passed
 * and the §G snapshot has been saved.
 *
 * State machine:
 *   staged → v2_written → committed (marker written last)
 *
 * Concurrent-v1-mutation invariant: v1 fingerprint is recomputed immediately
 * before writing the marker. If it no longer matches expectedFingerprint,
 * the transaction is aborted with code 'source_changed':
 *   - No marker is written or retained
 *   - The incomplete v2 DATA is quarantined
 *   - SNAPSHOT and STAGING are retained as diagnostic evidence
 *   - v1 is never rewritten (it was never modified by this transaction)
 *
 * @param {object} opts
 * @param {{ getItem, setItem, removeItem }} opts.adapter
 * @param {string} opts.v2DataStr          — serialized v2 envelope
 * @param {string} opts.expectedFingerprint — 64-char hex, from preconditions
 * @param {string} opts.clock              — injected ISO timestamp
 * @param {Function} opts.digestFn         — SHA-256 digest function
 * @param {number}  opts.timeoutMs
 * @param {object}  opts.scheduler
 * @returns {Promise<{ ok: boolean, code: string, message: string, diagnostic?: object }>}
 */
export async function runActivationTransaction({
  adapter, v2DataStr, expectedFingerprint, clock,
  digestFn  = webCryptoDigest,
  timeoutMs = ADAPTER_TIMEOUT_MS,
  scheduler = DEFAULT_SCHEDULER,
}) {
  if (typeof v2DataStr !== 'string' || v2DataStr.length === 0) {
    return { ok: false, code: 'invalid-input', message: 'v2DataStr must be a non-empty string.' };
  }

  // Step 1: Write staging record (state: 'staged') + byte-verify.
  // Abort without touching authoritative storage on failure.
  const stagingRecord = {
    txVersion:          ACTIVATION_TX_VERSION,
    txState:            'staged',
    startedAt:          clock,
    committedAt:        null,
    sourceFingerprint:  expectedFingerprint,
  };
  const stagingWr = await stagingWrite(adapter, stagingRecord, timeoutMs, scheduler);
  if (!stagingWr.ok) {
    return {
      ok: false, code: 'staging-write-failed',
      message: `Staging failed (${stagingWr.error}). Nothing was changed.`,
    };
  }

  // Step 2: Write hometask-v2 final data + byte-verify.
  const v2Wr = await setAndVerify(adapter, ACTIVATION_KEYS.DATA, v2DataStr, timeoutMs, scheduler);
  if (!v2Wr.ok) {
    return _rollbackTransaction(adapter, clock, `v2-write-failed:${v2Wr.error}`, timeoutMs, scheduler);
  }
  // Record progress — if this patch fails, startup recovery handles it.
  await stagingPatch(adapter, { txState: 'v2_written' }, timeoutMs, scheduler);

  // Step 2.5: Compute activation digest and write LIVE-STATE (generation 0).
  // Written AFTER DATA verification and BEFORE the authority marker.
  // v2DataStr bytes were verified stored byte-for-byte by setAndVerify above,
  // so sha256(v2DataStr) == sha256(stored DATA). Compute once; reuse as v2DataDigest.
  let activationDigest;
  try {
    const v2Bytes = new TextEncoder().encode(v2DataStr);
    activationDigest = await withTimeout(
      Promise.resolve(digestFn(v2Bytes)),
      'activation-digest', timeoutMs, scheduler,
    );
  } catch (e) {
    return _rollbackTransaction(adapter, clock, `activation-digest-failed:${e?.message ?? e}`, timeoutMs, scheduler);
  }
  const liveState0 = buildLiveState(0, activationDigest);
  const lsWr = await setAndVerify(
    adapter, ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(liveState0), timeoutMs, scheduler,
  );
  if (!lsWr.ok) {
    // Best-effort remove partially-written LIVE-STATE before rolling back.
    try { await aRemove(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler); } catch {}
    return _rollbackTransaction(adapter, clock, `live-state-write-failed:${lsWr.error}`, timeoutMs, scheduler);
  }

  // Step 3: Concurrent-v1-mutation invariant check.
  // Recompute the complete §G source fingerprint immediately before writing
  // the authority marker. It must still equal expectedFingerprint.
  const fpCheck = await recomputeAndVerifyFingerprint(
    adapter, expectedFingerprint, digestFn, timeoutMs, scheduler,
  );
  if (!fpCheck.ok) {
    // v1 changed (or fingerprint failed) — abort without writing a marker.
    // Quarantine the incomplete v2 DATA; retain SNAPSHOT + STAGING as evidence.
    // Remove orphaned LIVE-STATE (no marker → no authority backing).
    // Never rewrite v1 (it was never modified by this transaction).
    await quarantineEvidence(
      adapter, ACTIVATION_KEYS.DATA, fpCheck.code, clock, timeoutMs, scheduler,
    );
    try {
      const lsRaw = await aGet(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler);
      if (lsRaw !== null) await aRemove(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler);
    } catch {}
    await stagingPatch(
      adapter,
      { txState: 'source_changed', abortedAt: clock, abortReason: fpCheck.code },
      timeoutMs, scheduler,
    );
    return {
      ok: false, code: fpCheck.code,
      message: `Activation aborted: v1 source changed before marker commit (${fpCheck.code}). ` +
               `v1 data is authoritative and untouched. Evidence retained.`,
      diagnostic: { code: fpCheck.code, liveFingerprint: fpCheck.liveFingerprint },
    };
  }

  // Step 4: v2DataDigest = activationDigest (same SHA-256 computed in step 2.5).
  const v2DataDigest = activationDigest;

  // Step 5: Write authority marker LAST + byte-verify.
  // v1 remains authoritative until this succeeds.
  const activationId = `act-${clock}`;
  const marker = buildMarker({
    activationId,
    sourceFingerprint: expectedFingerprint,
    v2DataDigest,
    committedAt: clock,
  });
  const markerWr = await setAndVerify(
    adapter, ACTIVATION_KEYS.MARKER, JSON.stringify(marker), timeoutMs, scheduler,
  );
  if (!markerWr.ok) {
    return _rollbackTransaction(adapter, clock, `marker-write-failed:${markerWr.error}`, timeoutMs, scheduler);
  }

  // Committed — update staging and clean up STAGING (the only temporary record).
  await stagingPatch(adapter, { txState: 'committed', committedAt: clock }, timeoutMs, scheduler);
  await stagingClear(adapter, timeoutMs, scheduler);

  return { ok: true, code: 'committed', message: 'v2 activation committed successfully.' };
}

/**
 * Roll back a failed transaction by quarantining v2 DATA and retaining
 * SNAPSHOT + STAGING as diagnostic evidence.
 *
 * IMPORTANT: v1 was never modified by this transaction, so this function
 * does NOT restore v1 from the snapshot. The snapshot is retained only
 * as evidence and for post-commitment manual recovery if ever needed.
 * @private
 */
async function _rollbackTransaction(adapter, clock, cause, timeoutMs, scheduler) {
  // Quarantine the incomplete v2 DATA artifact.
  await quarantineEvidence(adapter, ACTIVATION_KEYS.DATA, cause, clock, timeoutMs, scheduler);
  // Remove orphaned LIVE-STATE if present (no marker → LIVE-STATE has no authority backing).
  // Best-effort: if this fails the orphan will be cleaned up at next startup.
  try {
    const lsRaw = await aGet(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler);
    if (lsRaw !== null) await aRemove(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler);
  } catch {}
  // Mark staging with the rollback cause; retain for diagnostic inspection.
  await stagingPatch(
    adapter,
    { txState: 'rollback_failed', rollbackError: cause, failedAt: clock },
    timeoutMs, scheduler,
  );
  return {
    ok: false, code: 'rolled-back',
    message: `Activation failed (${cause}). v1 data is authoritative and untouched. Evidence retained.`,
    diagnostic: { cause },
  };
}

/* ── Top-level orchestrator ──────────────────────────────────────── */

/**
 * Run the full v2 activation sequence.
 *
 * With V2_ACTIVATION_ENABLED = false, returns { ok: false, code: 'disabled' }
 * immediately without reading any storage.
 *
 * Full sequence (when enabled):
 *   1. Check all 5 preconditions (no storage writes on any failure)
 *   2. Save §G snapshot (abort before authoritative writes on failure)
 *   3. Run activation transaction (staged → v2_written → committed)
 *
 * @param {object}   opts
 * @param {{ getItem, setItem, removeItem }} opts.adapter
 * @param {object}   opts.catalog
 * @param {string}   opts.today        — injected "YYYY-MM-DD"
 * @param {string}   opts.clock        — injected ISO timestamp
 * @param {string}   [opts.shadowKey]  — default: SHADOW_KEY
 * @param {number}   [opts.timeoutMs]  — default: ADAPTER_TIMEOUT_MS
 * @param {object}   [opts.scheduler]  — default: DEFAULT_SCHEDULER
 * @param {object}   [opts._testHooks={}]
 *   _testHooks.digest — replacement for webCryptoDigest (fast test digest)
 * @returns {Promise<{ ok: boolean, code: string, message: string, diagnostic?: object }>}
 */
export async function runActivation({
  adapter, catalog, today, clock,
  shadowKey  = SHADOW_KEY,
  timeoutMs  = ADAPTER_TIMEOUT_MS,
  scheduler  = DEFAULT_SCHEDULER,
  _testHooks = {},
}) {
  // Compile-time gate — no storage access when flag is false.
  if (!V2_ACTIVATION_ENABLED) {
    return { ok: false, code: 'disabled', message: 'v2 activation is disabled.' };
  }

  const digestFn = _testHooks.digest ?? webCryptoDigest;

  // Preconditions — all failures leave storage byte-identical.
  const pre = await checkActivationPreconditions({
    adapter, catalog, today, shadowKey, digestFn, timeoutMs, scheduler,
  });
  if (!pre.ok) return { ok: false, code: pre.code, message: `Precondition failed: ${pre.detail}` };

  // §G Snapshot — abort before any authoritative write on failure.
  const snapResult = await saveActivationSnapshot(adapter, clock, timeoutMs, scheduler);
  if (!snapResult.ok) {
    return { ok: false, code: snapResult.code, message: `Snapshot failed: ${snapResult.detail}` };
  }

  // Serialize the candidate.
  let v2DataStr;
  try { v2DataStr = JSON.stringify(pre.candidate); }
  catch (e) {
    return { ok: false, code: 'serialize-failed', message: `Serialization failed: ${e?.message ?? e}` };
  }

  return runActivationTransaction({
    adapter, v2DataStr,
    expectedFingerprint: pre.sourceFingerprint,
    clock, digestFn, timeoutMs, scheduler,
  });
}

/* ── Startup recovery ────────────────────────────────────────────── */

/**
 * Handle activation transaction state at startup. Designed and structurally
 * tested to be callable before any authoritative storage read. Production
 * wiring is deferred to CP5B.
 *
 * Idempotent: safe to call on every startup.
 * Never throws. Never writes the string "null" for absent values.
 *
 * Concurrent-v1-mutation recovery rules:
 *   - Before a valid authority marker exists, this transaction has NEVER
 *     modified v1. Therefore startup recovery MUST NOT rewrite v1 from
 *     the snapshot, regardless of transaction state.
 *   - A v1/snapshot mismatch before commitment is newer or concurrent v1
 *     data, not corruption. Treat it as source_changed.
 *   - After commitment, if marker/v2 validation fails AND current v1 differs
 *     from the snapshot: do not overwrite newer v1; retain all evidence;
 *     return ambiguous_state.
 *
 * @param {{ getItem, setItem, removeItem }} adapter
 * @param {string}   clock     — injected ISO timestamp
 * @param {Function} digestFn  — SHA-256 digest function (injected)
 * @param {number}   [timeoutMs]
 * @param {object}   [scheduler]
 * @returns {Promise<{
 *   action: string,
 *   v2Active: boolean,
 *   detail?: string,
 * }>}
 */
export async function recoverActivationStartup(
  adapter, clock, digestFn,
  timeoutMs = ADAPTER_TIMEOUT_MS,
  scheduler = DEFAULT_SCHEDULER,
) {
  // ── Check the authority marker — the sole final authority switch.
  const marker = await markerRead(adapter, timeoutMs, scheduler);
  if (marker !== null) {
    if (!isWellFormedMarker(marker)) {
      // Malformed marker — quarantine, do not treat as authority.
      await quarantineEvidence(adapter, ACTIVATION_KEYS.MARKER, 'malformed-marker', clock, timeoutMs, scheduler);
      await stagingPatch(adapter, { txState: 'rollback_failed', rollbackError: 'malformed-marker', failedAt: clock }, timeoutMs, scheduler);
      return { action: 'quarantined-malformed-marker', v2Active: false, detail: 'marker failed structural validation' };
    }

    // Structurally valid marker — delegate to LIVE-STATE integrity check.
    // The marker's v2DataDigest is an activation-time certificate; routine startup
    // does NOT re-verify it against live DATA. LIVE-STATE is the live integrity record.
    return _recoverLiveState(adapter, marker, clock, digestFn, timeoutMs, scheduler);
  }

  // ── No marker — v1 is authoritative (this transaction never touched v1).
  const staging = await stagingRead(adapter, timeoutMs, scheduler);
  if (!staging) {
    return { action: 'none', v2Active: false };
  }

  // Malformed staging record — quarantine then remove.
  if (typeof staging.txState !== 'string') {
    return _quarantineStagingRecord(adapter, staging, 'malformed-txState', clock, timeoutMs, scheduler);
  }

  // Unsupported future transaction version — quarantine, do not interpret.
  if (typeof staging.txVersion === 'number' && staging.txVersion > ACTIVATION_TX_VERSION) {
    return {
      action: 'quarantined-unsupported', v2Active: false,
      detail: `txVersion ${staging.txVersion}`,
    };
  }

  switch (staging.txState) {
    case 'committed':
      // All writes verified; only staging cleanup and marker write were interrupted.
      // v1 is authoritative (no marker). Discard STAGING only.
      await stagingClear(adapter, timeoutMs, scheduler);
      return { action: 'cleaned-committed-no-marker', v2Active: false };

    case 'staged':
      // No v2 DATA was written. Discard STAGING only; v1 untouched.
      await stagingClear(adapter, timeoutMs, scheduler);
      return { action: 'cleaned-staged', v2Active: false };

    case 'v2_written':
    case 'source_changed':
    case 'rollback_failed': {
      // v2 DATA (and possibly LIVE-STATE) may exist. v1 was never modified.
      // Before touching DATA, verify that current v1 bytes still match the snapshot.
      // If they do not match, concurrent mutation occurred — do NOT overwrite newer v1.
      const v1MatchesSnapshot = await _verifyV1MatchesSnapshot(adapter, timeoutMs, scheduler);
      if (v1MatchesSnapshot === 'mismatch') {
        // Concurrent mutation: quarantine DATA, retain SNAPSHOT + STAGING evidence.
        await quarantineEvidence(adapter, ACTIVATION_KEYS.DATA, 'source_changed-on-recovery', clock, timeoutMs, scheduler);
        await stagingPatch(adapter, { txState: 'source_changed', detectedAt: clock }, timeoutMs, scheduler);
        return { action: 'source-changed-on-recovery', v2Active: false, detail: 'v1 differs from snapshot; newer v1 retained' };
      }
      // v1 matches snapshot (or snapshot absent — treat as safe): quarantine
      // incomplete DATA, remove orphaned LIVE-STATE, discard STAGING.
      await quarantineEvidence(adapter, ACTIVATION_KEYS.DATA, staging.txState, clock, timeoutMs, scheduler);
      try {
        const lsRaw = await aGet(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler);
        if (lsRaw !== null) await aRemove(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler);
      } catch {}
      await stagingClear(adapter, timeoutMs, scheduler);
      return { action: `recovered-${staging.txState}`, v2Active: false };
    }

    default:
      return _quarantineStagingRecord(adapter, staging, `unknown-state:${staging.txState}`, clock, timeoutMs, scheduler);
  }
}

/**
 * Compare all §G source keys against the snapshot.
 * Returns 'match', 'mismatch', or 'no-snapshot'.
 * @private
 */
async function _verifyV1MatchesSnapshot(adapter, timeoutMs, scheduler) {
  const snap = await getActivationSnapshot(adapter, timeoutMs, scheduler);
  if (!snap) return 'no-snapshot';
  for (const k of ACTIVATION_SOURCE_KEYS) {
    let cur;
    try { cur = await aGet(adapter, k, timeoutMs, scheduler); } catch { return 'mismatch'; }
    const snapVal = snap.keys[k] ?? null;
    const curVal  = (typeof cur === 'string') ? cur : null;
    if (curVal !== snapVal) return 'mismatch';
  }
  return 'match';
}

/**
 * LIVE-STATE integrity check called when the authority marker is structurally valid.
 * Handles three cases:
 *   1. LIVE-STATE present and matches DATA → v2 authoritative.
 *   2. LIVE-STATE absent → legacy-committed path (verify via marker.v2DataDigest).
 *   3. LIVE-STATE mismatch → mutation journal recovery.
 * @private
 */
async function _recoverLiveState(adapter, marker, clock, digestFn, timeoutMs, scheduler) {
  let lsRaw = null;
  try { lsRaw = await aGet(adapter, ACTIVATION_KEYS.LIVE_STATE, timeoutMs, scheduler); } catch {}

  if (lsRaw === null) {
    // LIVE-STATE absent — legacy committed fixture (pre-B1) or activation
    // crashed after LIVE-STATE write but before MARKER (impossible if marker present).
    // Verify DATA against marker.v2DataDigest before accepting.
    return _handleLegacyCommitted(adapter, marker, clock, digestFn, timeoutMs, scheduler);
  }

  // Parse LIVE-STATE record.
  let liveState = null;
  try {
    const parsed = JSON.parse(lsRaw);
    if (parsed && typeof parsed === 'object' && typeof parsed.generation === 'number' &&
        typeof parsed.digest === 'string' && parsed.schemaVersion === ACTIVATION_TARGET_SCHEMA) {
      liveState = parsed;
    }
  } catch {}

  if (liveState === null) {
    // Malformed LIVE-STATE — try journal recovery.
    return _recoverWithJournal(adapter, null, null, null, clock, digestFn, timeoutMs, scheduler);
  }

  // Read current DATA and compute its digest.
  let dataRaw = null;
  try { dataRaw = await aGet(adapter, ACTIVATION_KEYS.DATA, timeoutMs, scheduler); } catch {}

  let dataDigest = null;
  if (typeof dataRaw === 'string' && dataRaw.length > 0) {
    try {
      const bytes = new TextEncoder().encode(dataRaw);
      dataDigest = await withTimeout(Promise.resolve(digestFn(bytes)), 'ls-verify-digest', timeoutMs, scheduler);
    } catch {}
  }

  if (dataDigest !== null && dataDigest === liveState.digest) {
    // DATA matches LIVE-STATE — v2 is authoritative.
    // Best-effort: clean up any stale mutation journal (case 2: mutation completed normally
    // but journal clear at step 4 was interrupted; presence of a journal with correct state
    // is safe to remove since LIVE-STATE is already committed).
    try {
      const journalRaw = await aGet(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler);
      if (journalRaw !== null) await aRemove(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler);
    } catch {}
    await stagingClear(adapter, timeoutMs, scheduler);
    return { action: 'committed-verified', v2Active: true };
  }

  // Mismatch or DATA absent — try journal recovery.
  return _recoverWithJournal(adapter, liveState, dataRaw, dataDigest, clock, digestFn, timeoutMs, scheduler);
}

/**
 * Legacy-committed recovery: marker present but LIVE-STATE absent (pre-B1 fixture).
 * Compute sha256(DATA) and require exact equality with marker.v2DataDigest.
 * Any mismatch → ambiguous; never bootstrap without proof.
 * @private
 */
async function _handleLegacyCommitted(adapter, marker, clock, digestFn, timeoutMs, scheduler) {
  // If no marker, there is nothing to certify against — v1 is authoritative.
  if (!marker || !marker.v2DataDigest) {
    return { action: 'none', v2Active: false };
  }

  let dataRaw = null;
  try { dataRaw = await aGet(adapter, ACTIVATION_KEYS.DATA, timeoutMs, scheduler); } catch {}

  if (typeof dataRaw !== 'string' || dataRaw.length === 0) {
    await stagingPatch(adapter,
      { txState: 'ambiguous_state', detectedAt: clock, reason: 'legacy-committed:data-absent' },
      timeoutMs, scheduler);
    return { action: 'ambiguous-state', v2Active: false, detail: 'legacy-committed: DATA absent; cannot verify' };
  }

  let liveDigest = null;
  try {
    const bytes = new TextEncoder().encode(dataRaw);
    liveDigest = await withTimeout(Promise.resolve(digestFn(bytes)), 'legacy-digest', timeoutMs, scheduler);
  } catch {
    await stagingPatch(adapter,
      { txState: 'ambiguous_state', detectedAt: clock, reason: 'legacy-committed:digest-failed' },
      timeoutMs, scheduler);
    return { action: 'ambiguous-state', v2Active: false, detail: 'legacy-committed: digest computation failed' };
  }

  if (!fingerprintsMatch(liveDigest, marker.v2DataDigest)) {
    // DATA does not match activation-time proof → ambiguous; never bootstrap.
    await stagingPatch(adapter,
      { txState: 'ambiguous_state', detectedAt: clock, reason: 'legacy-committed:digest-mismatch' },
      timeoutMs, scheduler);
    return {
      action: 'ambiguous-state', v2Active: false,
      detail: 'legacy-committed: DATA digest does not match marker.v2DataDigest; manual review required',
    };
  }

  // Match → create LIVE-STATE gen 0 to upgrade this legacy fixture.
  const liveState = buildLiveState(0, liveDigest);
  const lsWr = await setAndVerify(
    adapter, ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(liveState), timeoutMs, scheduler,
  );
  await stagingClear(adapter, timeoutMs, scheduler);
  // If LIVE-STATE creation fails, DATA is still verified; v2 is authoritative for
  // this boot. Next startup will hit legacy path again and retry the upgrade.
  return {
    action: 'legacy-committed', v2Active: true,
    detail: lsWr.ok ? undefined : 'LIVE-STATE creation failed; will retry next startup',
  };
}

/**
 * Mutation-journal recovery. Called when LIVE-STATE is malformed, absent, or
 * mismatches current DATA. Attempts to resolve the inconsistency and restore
 * v2 to a known-good state.
 *
 * Recovery table (rows correspond to plan):
 *   Journal absent + LIVE-STATE mismatch  → ambiguous (no recovery evidence)
 *   Journal malformed                     → ambiguous (retain all)
 *   DATA matches journal.newDigest        → complete step-3 (write LIVE-STATE, clear journal)
 *   DATA matches journal.prevDigest       → revert step-2 (restore LIVE-STATE to prev, clear journal)
 *   DATA matches neither + prevRaw present → restore DATA, then complete step-3
 *   DATA matches neither, no prevRaw      → ambiguous (retain all; correction 2: no truncated allowed)
 *
 * Correction 3: in ambiguous states, retain all original evidence. Only quarantine
 * malformed journals (copies go to QUARANTINE; original journal is then removed).
 * DATA and LIVE-STATE are never removed in ambiguous cases.
 *
 * @private
 */
async function _recoverWithJournal(adapter, liveState, dataRaw, dataDigest, clock, digestFn, timeoutMs, scheduler) {
  // Read DATA if not already provided.
  if (dataRaw === undefined || dataRaw === null) {
    try { dataRaw = await aGet(adapter, ACTIVATION_KEYS.DATA, timeoutMs, scheduler); } catch { dataRaw = null; }
  }
  if ((dataDigest === undefined || dataDigest === null) && typeof dataRaw === 'string' && dataRaw.length > 0) {
    try {
      const bytes = new TextEncoder().encode(dataRaw);
      dataDigest = await withTimeout(Promise.resolve(digestFn(bytes)), 'journal-data-digest', timeoutMs, scheduler);
    } catch { dataDigest = null; }
  }

  // Read mutation journal.
  let journalRaw = null;
  try { journalRaw = await aGet(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler); } catch {}

  if (journalRaw === null) {
    // No journal — cannot recover.
    await stagingPatch(adapter,
      { txState: 'ambiguous_state', detectedAt: clock, reason: 'live-state-mismatch:no-journal' },
      timeoutMs, scheduler);
    return { action: 'ambiguous-state', v2Active: false, detail: 'LIVE-STATE mismatch and no mutation journal; manual review required' };
  }

  // Parse journal.
  let journal = null;
  try {
    const parsed = JSON.parse(journalRaw);
    if (parsed && typeof parsed === 'object' && parsed.phase === 'prepared' &&
        typeof parsed.generation === 'number' && typeof parsed.newDigest === 'string' &&
        typeof parsed.prevDigest === 'string') {
      journal = parsed;
    }
  } catch {}

  if (journal === null) {
    // Malformed journal — quarantine copy, then retain original if quarantine fails.
    await quarantineEvidence(adapter, ACTIVATION_KEYS.MUT_JOURNAL, 'malformed-journal', clock, timeoutMs, scheduler);
    await stagingPatch(adapter,
      { txState: 'ambiguous_state', detectedAt: clock, reason: 'malformed-journal' },
      timeoutMs, scheduler);
    return { action: 'ambiguous-state', v2Active: false, detail: 'malformed mutation journal; manual review required' };
  }

  const { generation, prevDigest, prevRaw, newDigest } = journal;

  // Case A: DATA matches intended new bytes (crash after step 2, before step 3).
  if (dataDigest !== null && dataDigest === newDigest) {
    const newLs = buildLiveState(generation, newDigest);
    const lsWr = await setAndVerify(adapter, ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(newLs), timeoutMs, scheduler);
    if (!lsWr.ok) {
      await stagingPatch(adapter,
        { txState: 'ambiguous_state', detectedAt: clock, reason: 'journal-recovery:live-state-write-failed' },
        timeoutMs, scheduler);
      return { action: 'ambiguous-state', v2Active: false, detail: 'journal recovery: LIVE-STATE write failed' };
    }
    try { await aRemove(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler); } catch {}
    await stagingClear(adapter, timeoutMs, scheduler);
    return { action: 'mutation-recovered-complete-step3', v2Active: true };
  }

  // Case B: DATA matches previous known-good bytes (crash after step 1, step 2 no-op).
  if (dataDigest !== null && dataDigest === prevDigest) {
    const prevGen = Math.max(0, generation - 1);
    const prevLs = buildLiveState(prevGen, prevDigest);
    const lsWr = await setAndVerify(adapter, ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(prevLs), timeoutMs, scheduler);
    if (!lsWr.ok) {
      await stagingPatch(adapter,
        { txState: 'ambiguous_state', detectedAt: clock, reason: 'journal-recovery:live-state-write-failed' },
        timeoutMs, scheduler);
      return { action: 'ambiguous-state', v2Active: false, detail: 'journal recovery: LIVE-STATE write failed' };
    }
    try { await aRemove(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler); } catch {}
    await stagingClear(adapter, timeoutMs, scheduler);
    return { action: 'mutation-recovered-revert-step2', v2Active: true };
  }

  // Case C: DATA matches neither — try restore from prevRaw.
  // Per correction 2: no prevRawTruncated is ever stored; if prevRaw is absent,
  // the mutation was aborted before JOURNAL write (capacity guard), so this
  // case should not arise from a legitimate journal. Retain all evidence.
  if (typeof prevRaw === 'string' && prevRaw.length > 0) {
    // Verify prevRaw is internally consistent with prevDigest.
    let restoreDigest = null;
    try {
      const bytes = new TextEncoder().encode(prevRaw);
      restoreDigest = await withTimeout(Promise.resolve(digestFn(bytes)), 'restore-digest', timeoutMs, scheduler);
    } catch {}
    if (restoreDigest === prevDigest) {
      const restoreWr = await setAndVerify(adapter, ACTIVATION_KEYS.DATA, prevRaw, timeoutMs, scheduler);
      if (restoreWr.ok) {
        const prevGen = Math.max(0, generation - 1);
        const prevLs = buildLiveState(prevGen, prevDigest);
        const lsWr = await setAndVerify(adapter, ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(prevLs), timeoutMs, scheduler);
        if (lsWr.ok) {
          try { await aRemove(adapter, ACTIVATION_KEYS.MUT_JOURNAL, timeoutMs, scheduler); } catch {}
          await stagingClear(adapter, timeoutMs, scheduler);
          return { action: 'mutation-recovered-restore-data', v2Active: true };
        }
      }
    }
  }

  // No recovery path succeeded — retain all evidence (correction 3).
  // Never remove DATA, LIVE-STATE, or JOURNAL in ambiguous state.
  await stagingPatch(adapter,
    { txState: 'ambiguous_state', detectedAt: clock, reason: 'journal-recovery-exhausted' },
    timeoutMs, scheduler);
  return { action: 'ambiguous-state', v2Active: false, detail: 'mutation journal recovery exhausted; all evidence retained; manual review required' };
}

/**
 * Exported entry-point for mutation startup recovery (LIVE-STATE + journal).
 * Called after marker structural validation in recoverActivationStartup.
 * Also exported for focused testing of the mutation-writer recovery paths.
 *
 * @param {{ getItem, setItem, removeItem }} adapter
 * @param {object|null} marker   — structurally-validated marker (or null for tests)
 * @param {string}      clock
 * @param {Function}    digestFn
 * @param {number}      [timeoutMs]
 * @param {object}      [scheduler]
 * @returns {Promise<{ action: string, v2Active: boolean, detail?: string }>}
 */
export async function recoverMutationStartup(
  adapter, marker, clock, digestFn,
  timeoutMs = ADAPTER_TIMEOUT_MS,
  scheduler  = DEFAULT_SCHEDULER,
) {
  if (marker !== null && isWellFormedMarker(marker)) {
    return _recoverLiveState(adapter, marker, clock, digestFn, timeoutMs, scheduler);
  }
  // No marker (test usage) — go straight to LIVE-STATE/journal check.
  return _recoverLiveState(adapter, null, clock, digestFn, timeoutMs, scheduler);
}

/**
 * Quarantine a malformed staging record, then remove it.
 * If quarantine fails, retain original.
 * @private
 */
async function _quarantineStagingRecord(adapter, _staging, reason, clock, timeoutMs, scheduler) {
  const q = await quarantineEvidence(adapter, ACTIVATION_KEYS.STAGING, reason, clock, timeoutMs, scheduler);
  if (!q.saved) {
    // Quarantine failed — retain original staging evidence.
    return { action: 'retained-malformed-staging', v2Active: false, detail: `quarantine-failed: ${q.detail ?? ''}` };
  }
  return { action: 'quarantined-malformed-staging', v2Active: false, detail: reason };
}
