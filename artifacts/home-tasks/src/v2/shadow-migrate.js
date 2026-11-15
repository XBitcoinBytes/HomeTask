/**
 * shadow-migrate.js — pure, disconnected shadow-migration runner.
 *
 * Reads approved v1 source keys through an injected adapter, migrates to v2,
 * verifies semantic equivalence, and writes the shadow candidate to a
 * dedicated shadow key. No direct-storage access, no DOM, no live clock.
 *
 * Not connected to the production entry point. CP4A tests are the only
 * authorized callers. The runtime disconnection is enforced by the
 * import-order structural suite.
 *
 * All adapter and digest operations are wrapped with a deterministic timeout
 * using an injected scheduler abstraction so the timeout is testable without
 * real-time sleeps.
 */

import { migrate, validateEnvelope }  from './migrate.js';
import { assertEquivalent }           from './equivalence.js';
import {
  buildFingerprint,
  webCryptoDigest,
} from './shadow-fingerprint.js';
import { isValidVerifiedWrapper } from './shadow-validate.js';

/* ── Public constants ─────────────────────────────────────────────── */

export const SHADOW_KEY            = 'hometask-v2-shadow';
export const SHADOW_SCHEMA_VERSION = 1;
/** Size limit in UTF-8 bytes (not character count). */
export const SHADOW_SIZE_LIMIT     = 2 * 1024 * 1024;   // 2,097,152 UTF-8 bytes
/** Production-intended per-operation timeout (adapter + digest). Configurable. */
export const ADAPTER_TIMEOUT_MS    = 5_000;

/**
 * Ordered list of v1 source keys the runner is permitted to read.
 * Only these keys are read as migration input. Backup snapshots, staging
 * transactions, recovery records, and unrelated keys are never touched.
 */
export const SOURCE_KEYS = Object.freeze([
  'hometask-v1',
  'hometask-meta-v1',
  'hometask-recent-searches-v1',
]);

/* ── Timeout abstraction ──────────────────────────────────────────── */

const DEFAULT_SCHEDULER = {
  setTimeout:   (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id)     => globalThis.clearTimeout(id),
};

/**
 * Wrap a promise with a deterministic timeout.
 *
 * When the timeout fires before the promise settles, the original promise
 * is swallowed via .catch(() => {}) to prevent an unhandled-rejection event
 * if it later settles with a rejection after the timeout has already fired.
 *
 * @param {Promise<any>} promise
 * @param {string}       label      — used in the timeout error message
 * @param {number}       timeoutMs  — 0 or negative disables the timeout
 * @param {object}       scheduler  — { setTimeout, clearTimeout }
 */
async function withTimeout(promise, label, timeoutMs, scheduler) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  const p = Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const handle = scheduler.setTimeout(() => {
      p.catch(() => {});  // prevent unhandled rejection on late settle
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.then(
      v => { scheduler.clearTimeout(handle); resolve(v); },
      e => { scheduler.clearTimeout(handle); reject(e); },
    );
  });
}

/** Read one key through the adapter with timeout. */
async function adapterGet(adapter, key, timeoutMs, scheduler) {
  return withTimeout(
    Promise.resolve(adapter.getItem(key)),
    `adapter.getItem("${key}")`,
    timeoutMs, scheduler,
  );
}

/** Write one key through the adapter with timeout. */
async function adapterSet(adapter, key, value, timeoutMs, scheduler) {
  return withTimeout(
    Promise.resolve(adapter.setItem(key, value)),
    `adapter.setItem("${key}")`,
    timeoutMs, scheduler,
  );
}

/* ── Internal helpers ─────────────────────────────────────────────── */

function tryParseWrapper(raw) {
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function tryParseJson(raw) {
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Extract privacy-safe repair category codes from a migrate() report.
 * Strips all task IDs, values, and household content.
 */
function privacySafeRepairs(report) {
  const categories = [...new Set(
    (report.sanitizedFields ?? []).map(f => {
      const dot = f.indexOf('.');
      return dot >= 0 ? f.slice(dot + 1) : f;
    })
  )].sort();
  return {
    droppedUnknownIdsCount:    (report.droppedUnknownIds   ?? []).length,
    malformedCount:            (report.malformed            ?? []).length,
    normalizedDoneTodayCount:  (report.normalizedDoneToday ?? []).length,
    sanitizedFieldsCount:      (report.sanitizedFields      ?? []).length,
    sanitizedFieldCategories:  categories,
    roomFilterResolved:        report.roomFilterResolved != null,
    dueNowDefaultFold:         report.dueNowDefaultFold != null,
  };
}

/** Map a raw assertEquivalent() diff string to an UPPER_SNAKE_CASE code. */
function categorizeDiff(diff) {
  if (diff.startsWith('task ID sets differ'))       return 'TASK_ID_SET_MISMATCH';
  if (diff.includes('.tags differ'))                return 'TAGS_MISMATCH';
  if (diff.startsWith('workload:'))                 return 'WORKLOAD_MISMATCH';
  if (diff.endsWith('view membership differs')) {
    const view = diff.split(' ')[0];
    return `VIEW_MEMBERSHIP_MISMATCH:${view.toUpperCase()}`;
  }
  if (diff.startsWith('zone titles/order differ'))  return 'ZONE_ORDER_MISMATCH';
  if (diff.includes('task lists differ'))           return 'ROOM_TASK_LIST_MISMATCH';
  if (diff.startsWith('preferences'))               return 'PREFERENCE_MISMATCH';
  const m = diff.match(/\.\w+: v1=/);
  if (m) return `FIELD_VALUE_MISMATCH:${m[0].slice(1, -5).toUpperCase()}`;
  return 'UNKNOWN_DIFF';
}

/**
 * Build the privacy-safe verificationSummary embedded in the shadow wrapper.
 * Contains NO task IDs, titles, tags, dates, search terms, or raw values.
 */
function buildVerificationSummary(v2, migrateReport, diffs) {
  return {
    stateCount:            (v2.state            ?? []).length,
    userZoneCount:         (v2.userZones         ?? []).length,
    userTaskCount:         (v2.userTasks         ?? []).length,
    completionEventCount:  (v2.completionEvents  ?? []).length,
    overrideCount:         Object.keys(v2.overrides ?? {}).length,
    recentSearchCount:     (v2.recentSearches    ?? []).length,
    repairsFromMigration:  privacySafeRepairs(migrateReport),
    unexpectedDiffCount:   diffs.length,
    diffCategoryCodes:     [...new Set(diffs.map(categorizeDiff))].sort(),
  };
}

/* ── Main runner ──────────────────────────────────────────────────── */

/**
 * Run a shadow migration and write the result to the injected shadow key.
 *
 * @param {object} opts
 * @param {{ getItem, setItem, removeItem }} opts.adapter
 *   Storage adapter. All operations may be synchronous or Promise-returning.
 * @param {object}   opts.catalog      — canonical catalog (from catalog.data.js)
 * @param {string}   opts.today        — injected "YYYY-MM-DD" (never clock-read)
 * @param {string}   opts.clock        — injected ISO timestamp for generatedAt
 * @param {string}   opts.appBuild     — application build string
 * @param {string[]} [opts.sourceKeys] — override the default SOURCE_KEYS list
 * @param {string}   [opts.shadowKey]  — override the default SHADOW_KEY
 * @param {string[]} [opts.witnessKeys=[]]              — keys verified unchanged
 * @param {number}   [opts.timeoutMs=ADAPTER_TIMEOUT_MS] — per-operation timeout ms
 * @param {object}   [opts.scheduler=DEFAULT_SCHEDULER]  — { setTimeout, clearTimeout }
 * @param {object}   [opts._testHooks={}]
 *   _testHooks.migrate — replacement for migrate() (deliberate failure injection)
 *   _testHooks.digest  — replacement for webCryptoDigest() (fast test digest)
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'verified'|'failed',
 *   wrapper?: object,
 *   byteSize?: number,
 *   errors: string[],
 *   warnings: string[],
 *   preservedExistingVerified?: boolean,
 * }>}
 */
export async function runShadowMigration({
  adapter,
  catalog,
  today,
  clock,
  appBuild,
  sourceKeys   = SOURCE_KEYS,
  shadowKey    = SHADOW_KEY,
  witnessKeys  = [],
  timeoutMs    = ADAPTER_TIMEOUT_MS,
  scheduler    = DEFAULT_SCHEDULER,
  _testHooks   = {},
}) {
  const errors   = [];
  const warnings = [];

  /* ── Validate injection points ──────────────────────────────────── */
  if (!adapter || typeof adapter.getItem !== 'function')
    return { ok: false, status: 'failed', errors: ['adapter.getItem is required'], warnings, preservedExistingVerified: false };
  if (!catalog)
    return { ok: false, status: 'failed', errors: ['catalog is required'], warnings, preservedExistingVerified: false };
  if (typeof today !== 'string')
    return { ok: false, status: 'failed', errors: ['today must be an injected "YYYY-MM-DD" string'], warnings, preservedExistingVerified: false };
  if (typeof clock !== 'string')
    return { ok: false, status: 'failed', errors: ['clock must be an injected ISO timestamp string'], warnings, preservedExistingVerified: false };

  const migrateImpl = _testHooks.migrate ?? migrate;
  const digestFn    = _testHooks.digest  ?? webCryptoDigest;

  /* ── Step 1: Read source values; preserve exact pre-run bytes ────── */
  const sourceSnapshot = {};
  for (const k of sourceKeys) {
    let val;
    try { val = await adapterGet(adapter, k, timeoutMs, scheduler); }
    catch (e) {
      return { ok: false, status: 'failed',
        errors: [`read failure for source key "${k}": ${e?.message ?? e}`],
        warnings, preservedExistingVerified: false };
    }
    sourceSnapshot[k] = (typeof val === 'string') ? val : null;
  }

  /* ── Step 1b: Snapshot witness keys (non-fatal on error) ─────────── */
  const witnessSnapshot = {};
  for (const k of witnessKeys) {
    try { witnessSnapshot[k] = await adapterGet(adapter, k, timeoutMs, scheduler) ?? null; }
    catch { witnessSnapshot[k] = null; }
  }

  /* ── Step 2: Compute SHA-256 source-integrity digest ─────────────── */
  let sourceFingerprint;
  try {
    sourceFingerprint = await withTimeout(
      buildFingerprint(sourceSnapshot, digestFn),
      'source digest',
      timeoutMs, scheduler,
    );
  } catch (e) {
    return { ok: false, status: 'failed',
      errors: [`source digest failed: ${e?.message ?? e}`],
      warnings, preservedExistingVerified: false };
  }

  /* ── Step 2b: Early exit — preserve existing verified wrapper if source unchanged ── */
  // If a canonically valid verified wrapper already exists and its sourceFingerprint
  // matches the current source digest, v1 data is byte-identical to the last run.
  // Re-running migration would produce an identical candidate but a new generatedAt,
  // breaking the CP4A guarantee that two consecutive no-action loads leave shadow bytes
  // unchanged.  Return the existing raw bytes without writing.
  try {
    const existingRaw     = await adapterGet(adapter, shadowKey, timeoutMs, scheduler);
    const existingWrapper = tryParseWrapper(existingRaw);
    if (
      isValidVerifiedWrapper(existingWrapper) &&
      existingWrapper.sourceFingerprint === sourceFingerprint
    ) {
      const byteLen = new TextEncoder().encode(existingRaw).byteLength;
      return { ok: true, status: 'verified', wrapper: existingWrapper,
        byteSize: byteLen, errors, warnings, preservedExistingVerified: true };
    }
  } catch { /* read error is non-fatal — fall through to full run */ }

  /* ── Step 3: Run the pure v1→v2 migration ────────────────────────── */
  let v2, migrateReport;
  try {
    const res = migrateImpl(
      {
        v1TasksRaw:   sourceSnapshot['hometask-v1']                ?? null,
        v1MetaRaw:    sourceSnapshot['hometask-meta-v1']            ?? null,
        v1RecentsRaw: sourceSnapshot['hometask-recent-searches-v1'] ?? null,
        lastExport:   null,
      },
      { today, catalog, appBuild },
    );
    v2 = res.v2; migrateReport = res.report;
  } catch (e) {
    return { ok: false, status: 'failed',
      errors: [`migration threw: ${e?.message ?? e}`],
      warnings, preservedExistingVerified: false };
  }

  /* ── Step 4: Validate the canonical 9-field v2 envelope ─────────── */
  const envResult = validateEnvelope(v2);
  if (!envResult.ok) {
    return { ok: false, status: 'failed',
      errors: [`envelope validation failed: ${envResult.errors.join('; ')}`],
      warnings, preservedExistingVerified: false };
  }

  /* ── Steps 5 + 6: Compose both worlds and run assertEquivalent() ─── */
  const v1Raw = {
    tasks: tryParseJson(sourceSnapshot['hometask-v1']) ?? [],
    meta:  tryParseJson(sourceSnapshot['hometask-meta-v1']) ?? {},
  };
  let diffs;
  try {
    diffs = assertEquivalent(catalog, v1Raw, v2, today);
  } catch (e) {
    return { ok: false, status: 'failed',
      errors: [`assertEquivalent threw: ${e?.message ?? e}`],
      warnings, preservedExistingVerified: false };
  }

  /* ── Step 7: Documented repairs vs unexpected differences ─────────── */
  const hasUnexpectedDiffs = diffs.length > 0;
  if (hasUnexpectedDiffs) {
    errors.push(
      `equivalence check failed (${diffs.length} unexpected difference(s)); categories: ${
        [...new Set(diffs.map(categorizeDiff))].sort().join(', ')
      }`,
    );
  }

  /* ── Step 8: Verified only when equivalence passes ───────────────── */
  const verified = !hasUnexpectedDiffs;
  const status   = verified ? 'verified' : 'failed';

  /* ── Steps 9 + 10: Serialize and enforce UTF-8 byte size limit ───── */
  const verificationSummary = buildVerificationSummary(v2, migrateReport, diffs);
  const wrapper = {
    shadowSchemaVersion: SHADOW_SCHEMA_VERSION,
    sourceSchema:        1,
    targetSchema:        2,
    generatedAt:         clock,
    appBuild,
    catalogVersion:      catalog.catalogVersion,
    sourceFingerprint,
    candidate:           v2,
    verificationSummary,
    status,
  };

  let serialized;
  try { serialized = JSON.stringify(wrapper); }
  catch (e) {
    return { ok: false, status: 'failed',
      errors: [`shadow serialization failed: ${e?.message ?? e}`],
      warnings, preservedExistingVerified: false };
  }

  // Enforce limit in UTF-8 bytes (not character count — Unicode chars may be multi-byte).
  const byteLen = new TextEncoder().encode(serialized).byteLength;
  if (byteLen > SHADOW_SIZE_LIMIT) {
    return { ok: false, status: 'failed',
      errors: [`shadow candidate exceeds ${SHADOW_SIZE_LIMIT}-byte size limit (got ${byteLen} bytes, ${serialized.length} chars)`],
      warnings, preservedExistingVerified: false };
  }

  /* ── Check existing shadow before write ─────────────────────────── */
  // A failed run must not overwrite a previously verified shadow candidate.
  // Full structural validation is required — a malformed wrapper claiming
  // status: "verified" is never treated as protected.
  let existingIsVerified = false;
  try {
    const existingRaw     = await adapterGet(adapter, shadowKey, timeoutMs, scheduler);
    const existingWrapper = tryParseWrapper(existingRaw);
    existingIsVerified    = isValidVerifiedWrapper(existingWrapper);
  } catch { /* read error on existing shadow is non-fatal */ }

  if (!verified && existingIsVerified) {
    return { ok: false, status: 'failed',
      errors: [...errors, 'existing verified shadow preserved; failed run does not overwrite it'],
      warnings, preservedExistingVerified: true };
  }

  /* ── Step 11: Write shadow wrapper ──────────────────────────────── */
  try { await adapterSet(adapter, shadowKey, serialized, timeoutMs, scheduler); }
  catch (e) {
    return { ok: false, status: 'failed',
      errors: [...errors, `shadow write failed: ${e?.message ?? e}`],
      warnings, preservedExistingVerified: existingIsVerified };
  }

  /* ── Step 12: Read back and verify exact bytes ───────────────────── */
  let readBack;
  try { readBack = await adapterGet(adapter, shadowKey, timeoutMs, scheduler); }
  catch (e) {
    return { ok: false, status: 'failed',
      errors: [...errors, `shadow readback failed: ${e?.message ?? e}`],
      warnings, preservedExistingVerified: existingIsVerified };
  }
  if (readBack !== serialized) {
    const readBackBytes = typeof readBack === 'string'
      ? new TextEncoder().encode(readBack).byteLength : 'non-string';
    return { ok: false, status: 'failed',
      errors: [...errors, `shadow readback mismatch: written ${byteLen} bytes (${serialized.length} chars), read back ${readBackBytes}`],
      warnings, preservedExistingVerified: existingIsVerified };
  }

  /* ── Step 13: Re-read every source key; prove byte-identity ─────── */
  for (const k of sourceKeys) {
    let reRead;
    try { reRead = await adapterGet(adapter, k, timeoutMs, scheduler); }
    catch (e) {
      warnings.push(`source key "${k}" could not be re-read after write: ${e?.message ?? e}`);
      continue;
    }
    if ((typeof reRead === 'string' ? reRead : null) !== sourceSnapshot[k]) {
      errors.push(`source key "${k}" changed during shadow run — migration may not reflect current state`);
    }
  }

  /* ── Step 14: Confirm unrelated (witness) keys unchanged ─────────── */
  for (const k of witnessKeys) {
    let reRead;
    try { reRead = await adapterGet(adapter, k, timeoutMs, scheduler); }
    catch { continue; }
    if ((typeof reRead === 'string' ? reRead : null) !== witnessSnapshot[k]) {
      warnings.push(`witness key "${k}" changed during shadow run (expected unchanged)`);
    }
  }

  const sourceMutated = errors.some(e => e.includes('changed during shadow run'));
  if (sourceMutated) {
    return { ok: false, status: 'failed', errors, warnings,
      byteSize: byteLen, preservedExistingVerified: existingIsVerified };
  }

  if (!verified) {
    return { ok: false, status: 'failed', errors, warnings,
      byteSize: byteLen, preservedExistingVerified: existingIsVerified };
  }

  return { ok: true, status: 'verified', wrapper,
    byteSize: byteLen, errors, warnings, preservedExistingVerified: false };
}
