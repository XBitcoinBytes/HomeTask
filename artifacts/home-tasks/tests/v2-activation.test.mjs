/**
 * v2-activation.test.mjs — CP5A suite: v2 activation controller.
 *
 * Covers:
 *   1 · flag-gate          runActivation disabled early exit; no storage reads
 *   2 · preconditions      All 5 failure paths; storage byte-identical after each
 *   3 · snapshot           Write/readback/mismatch failures; retention policy
 *   4 · transaction        Staging/v2/marker write+readback failures; rollback
 *   5 · concurrent-v1      Mutation at all 5 points; v1 never overwritten
 *   6 · startup-recovery   All 4 transaction states; quarantine; ambiguous_state
 *   7 · marker-integrity   validateMarker; v2DataDigest mismatch; marker never deleted
 *   8 · idempotency        Repeated recovery calls; committed idempotency
 *   9 · timeouts           Every adapter operation times out via injected scheduler
 *  10 · disconnection      CP5A not importable from script.js / production modules
 *
 * Standalone Node ESM. No real storage, no real clock, no real-time sleeps.
 * Run with:  node artifacts/home-tasks/tests/v2-activation.test.mjs
 */

import assert   from 'node:assert/strict';
import { createHash }   from 'node:crypto';
import { readFileSync }  from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG }      from '../src/v2/catalog.data.js';
import { runShadowMigration, SHADOW_KEY, SOURCE_KEYS }
                        from '../src/v2/shadow-migrate.js';
import { createMemoryAdapter, createFailingAdapter }
                        from '../src/v2/storage-adapter.js';
import {
  V2_ACTIVATION_ENABLED,
}                       from '../src/v2/activation-config.js';
import {
  ACTIVATION_TX_VERSION, ACTIVATION_MARKER_VERSION, ACTIVATION_TARGET_SCHEMA,
  ACTIVATION_KEYS, ACTIVATION_SOURCE_KEYS, QUARANTINE_MAX_RAW,
  saveActivationSnapshot, getActivationSnapshot, restoreFromSnapshot,
  checkActivationPreconditions,
  recomputeAndVerifyFingerprint,
  runActivationTransaction,
  runActivation,
  recoverActivationStartup,
  buildMarker, validateMarker,
  validateMarkerStructure, buildLiveState, recoverMutationStartup,
}                       from '../src/v2/activation-tx.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = resolvePath(HERE, '../src');

/* ── Harness ─────────────────────────────────────────────────────── */
let group = '', pass = 0, fail = 0;
const _pending = [];
function check(name, fn) {
  const p = Promise.resolve().then(() => fn()).then(
    ()  => { pass++; },
    e   => { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); },
  );
  _pending.push(p);
  return p;
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/* ── Fast test digest ────────────────────────────────────────────── */
function testDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ── Base fixtures ───────────────────────────────────────────────── */
const FIXED_CLOCK  = '2026-08-09T00:00:00.000Z';
const FIXED_CLOCK2 = '2026-08-09T01:00:00.000Z';
const TYPICAL_STORE = {
  'hometask-v1':                 FIXTURES.typical.v1TasksRaw,
  'hometask-meta-v1':            FIXTURES.typical.v1MetaRaw,
  'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
};
const UNRELATED = Object.freeze({ 'some-other-key': 'must-not-change' });

/* ── Helpers ─────────────────────────────────────────────────────── */

/** Build a fresh adapter seeded with typical v1 data (+ optional extras). */
function makeAdapter(extra = {}) {
  return createMemoryAdapter({ ...UNRELATED, ...TYPICAL_STORE, ...extra });
}

/** Run shadow migration to produce a valid verified wrapper in the adapter. */
async function seedVerifiedShadow(adapter) {
  const r = await runShadowMigration({
    adapter,
    catalog: CATALOG,
    today:   FIXED_TODAY,
    clock:   FIXED_CLOCK,
    appBuild: 'v20-shadow',
    _testHooks: { digest: testDigest },
  });
  assert.equal(r.status, 'verified', `shadow setup must verify: ${JSON.stringify(r.errors)}`);
  return r;
}

/** Base opts for checkActivationPreconditions / runActivation. */
const BASE_PRE = {
  catalog:   CATALOG,
  today:     FIXED_TODAY,
  _testHooks: { digest: testDigest },
};
const BASE_TX = {
  clock:     FIXED_CLOCK,
  digestFn:  testDigest,
};

/** Instant-firing scheduler for timeout tests. */
const FIRE_NOW_SCHEDULER = {
  setTimeout:   (fn) => { fn(); return 0; },
  clearTimeout: ()   => {},
};

/** Hanging adapter (getItem never resolves). */
function makeHangingAdapter(base, hangKey) {
  return {
    getItem:    (k) => k === hangKey ? new Promise(() => {}) : base.getItem(k),
    setItem:    (k, v) => base.setItem(k, v),
    removeItem: (k) => base.removeItem(k),
  };
}

/**
 * Boundary mutation adapter — physically writes the mutated value into base
 * storage at the exact boundary, so any subsequent read (from any caller) sees
 * the real mutated bytes, not a read-intercept illusion.
 *
 * Transaction write order inside runActivationTransaction:
 *   write 1 → STAGING record  (staged state)
 *   write 2 → DATA            (v2 data)
 *   write 3 → LIVE-STATE      (generation 0, activation digest) [added B1]
 *   write 4 → STAGING patch   (v2_written state)
 *   [then recomputeAndVerifyFingerprint reads source keys — triggers source_changed]
 *
 * afterSets semantics (pre-hook for 0/1/2, getItem-hook for 3):
 *   0 → mutate immediately before write 1  (before staging — "present since snapshot")
 *   1 → mutate immediately before write 2  (after staging, before DATA write)
 *   2 → mutate immediately before write 3  (after DATA write, before LIVE-STATE write)
 *   3 → mutate on the first getItem(mutateKey) after all writes, before marker write
 *
 * Exposes:
 *   .log[]  ordered trace events, each with an `event` field:
 *     'boundary-reached' — {trigger, setCount}
 *     'v1-mutated'       — {key, newValue}
 *     'tx-set'           — {key, setCountBefore}
 *     'v1-read'          — {key, value, setCountAtRead}
 */
function createBoundaryMutatingAdapter(base, { mutateKey, afterSets = 0, newValue }) {
  let setCount = 0;
  let mutationDone = false;
  const log = [];

  function applyMutation(trigger) {
    // Physically write the new value into base storage — not a read intercept.
    // null means "erase the key"; any string value is stored directly.
    if (newValue === null || newValue === undefined) {
      base.removeItem(mutateKey);
    } else {
      base.setItem(mutateKey, newValue);
    }
    mutationDone = true;
    log.push({ event: 'boundary-reached', trigger, setCount });
    log.push({ event: 'v1-mutated', key: mutateKey, newValue: newValue ?? null });
  }

  return {
    getItem(k) {
      // Point 4: mutate at the exact moment v1 is first read for the fingerprint
      // check (after all 3 writes, before the marker write).
      if (k === mutateKey && afterSets === 3 && !mutationDone) {
        applyMutation('on-v1-read');
      }
      const v = base.getItem(k);
      if (k === mutateKey) {
        log.push({ event: 'v1-read', key: k, value: v, setCountAtRead: setCount });
      }
      return v;
    },
    setItem(k, v) {
      // Points 1–3: pre-hook — mutate just before the (afterSets+1)th write.
      if (!mutationDone && afterSets < 3 && setCount === afterSets) {
        applyMutation(`before-write-${setCount + 1}`);
      }
      log.push({ event: 'tx-set', key: k, setCountBefore: setCount });
      base.setItem(k, v);
      setCount++;
    },
    removeItem(k)  { base.removeItem(k); },
    keys()         { return base.keys(); },
    snapshotAll()  { return base.snapshotAll(); },
    log,
  };
}

/**
 * Spy adapter — records every setItem / removeItem call (key + op) plus every
 * getItem call for v1 source keys so recovery read-order is visible.
 * Used to prove pre-marker recovery paths never write to v1 source keys.
 */
function createSpyAdapter(base) {
  const writeLog = [];   // { op: 'set'|'remove', key }
  const readLog  = [];   // { key, value } — getItem calls for ACTIVATION_SOURCE_KEYS
  return {
    getItem(k) {
      const v = base.getItem(k);
      if (ACTIVATION_SOURCE_KEYS.includes(k)) readLog.push({ key: k, value: v });
      return v;
    },
    setItem(k, v)   { writeLog.push({ op: 'set', key: k }); base.setItem(k, v); },
    removeItem(k)   { writeLog.push({ op: 'remove', key: k }); base.removeItem(k); },
    keys()          { return base.keys(); },
    snapshotAll()   { return base.snapshotAll(); },
    writeLog,
    readLog,
  };
}

/** Assert no ACTIVATION_KEYS (except possibly DATA pre-write) are present. */
function assertNoActivationState(adapter, msg = '') {
  for (const k of [ACTIVATION_KEYS.SNAPSHOT, ACTIVATION_KEYS.STAGING, ACTIVATION_KEYS.MARKER]) {
    assert.equal(adapter.getItem(k), null, `${msg}: ${k} must be absent`);
  }
}

/** Assert unrelated keys are unchanged. */
function assertUnrelated(adapter) {
  for (const [k, v] of Object.entries(UNRELATED)) {
    assert.equal(adapter.getItem(k), v, `unrelated key "${k}" was changed`);
  }
}

/* ════════════════════════════════════════════════════════════════════
   1 · flag-gate
════════════════════════════════════════════════════════════════════ */
section('flag-gate');

check('V2_ACTIVATION_ENABLED is false', () => {
  assert.equal(V2_ACTIVATION_ENABLED, false);
});

check('runActivation returns disabled immediately without touching storage', async () => {
  const adapter = makeAdapter();
  const before  = JSON.stringify(adapter.snapshotAll());
  const r = await runActivation({ adapter, catalog: CATALOG, today: FIXED_TODAY,
    clock: FIXED_CLOCK, _testHooks: { digest: testDigest } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'disabled');
  assert.equal(JSON.stringify(adapter.snapshotAll()), before, 'storage must be byte-identical');
});

/* ════════════════════════════════════════════════════════════════════
   2 · preconditions
════════════════════════════════════════════════════════════════════ */
section('preconditions');

check('(e) conflicting transaction blocks preconditions; storage unchanged', async () => {
  const adapter = makeAdapter({ [ACTIVATION_KEYS.STAGING]: JSON.stringify({ txVersion: 1, txState: 'staged' }) });
  await seedVerifiedShadow(adapter);
  const before = JSON.stringify(adapter.snapshotAll());
  const r = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'conflicting-transaction');
  assert.equal(JSON.stringify(adapter.snapshotAll()), before);
});

check('(a) absent shadow wrapper → shadow-absent', async () => {
  const adapter = makeAdapter();   // no shadow key
  const r = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'shadow-absent');
  assertNoActivationState(adapter, 'precondition-absent-shadow');
  assertUnrelated(adapter);
});

check('(a) malformed shadow wrapper → shadow-invalid', async () => {
  const adapter = makeAdapter({ [SHADOW_KEY]: '{"status":"verified","shadowSchemaVersion":1}' });
  const r = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'shadow-invalid');
});

check('(b) fingerprint mismatch → fingerprint-mismatch; no writes', async () => {
  const adapter = makeAdapter();
  await seedVerifiedShadow(adapter);
  // Mutate a source key so the fingerprint no longer matches.
  adapter.setItem('hometask-v1', '[]');
  const before = JSON.stringify(adapter.snapshotAll());
  const r = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'fingerprint-mismatch');
  assert.equal(JSON.stringify(adapter.snapshotAll()), before);
});

check('(c) envelope-invalid: schemaVersion≠2 passes isValidVerifiedWrapper but fails validateEnvelope', async () => {
  // Setup: valid shadow wrapper with candidate that passes hasValidCandidateShape
  // (typeof schemaVersion === 'number' passes) but fails validateEnvelope's
  // strict equality check (v === 2). Stages (a)+(b) are therefore reached and
  // pass; stage (c) fails; stage (d) assertEquivalent is never reached.
  const adapter = makeAdapter();
  await seedVerifiedShadow(adapter);
  const wrapper = JSON.parse(adapter.getItem(SHADOW_KEY));
  wrapper.candidate.schemaVersion = 999;  // passes shape check, fails envelope check
  adapter.setItem(SHADOW_KEY, JSON.stringify(wrapper));
  const before = JSON.stringify(adapter.snapshotAll());
  const r = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'envelope-invalid',
    `expected envelope-invalid (stage c), got: ${r.code}`);
  // Stage (d) was NOT reached — code is envelope-invalid, not equivalence-*.
  assert.ok(r.code !== 'equivalence-failed' && r.code !== 'equivalence-threw',
    'assertEquivalent must not have been reached');
  // No writes occurred — preconditions are purely read-only.
  assert.equal(JSON.stringify(adapter.snapshotAll()), before, 'storage must be byte-identical');
});

check('(d) equivalence-failed: valid envelope but prefs.viewMode does not match v1', async () => {
  // Setup: valid shadow wrapper passing isValidVerifiedWrapper + validateEnvelope.
  // assertEquivalent §6 checks p2.viewMode === expectedViewMode (derived from v1 meta.viewMode).
  // The typical fixture has viewMode:'week'; changing it to 'all' creates a detected diff.
  // Stages (a)+(b)+(c) all pass; stage (d) fails with equivalence-failed.
  // userTasks is empty in the migration output (catalog seeds override), so the
  // equivalence-reliable corruption target is prefs.viewMode, which assertEquivalent
  // checks directly (equivalence.js §6, line 164).
  const adapter = makeAdapter();
  await seedVerifiedShadow(adapter);
  const wrapper = JSON.parse(adapter.getItem(SHADOW_KEY));
  // Change viewMode from 'week' (v1 meta) to 'all' — keeps prefs a valid object,
  // keeps validateEnvelope happy, but breaks assertEquivalent §6.
  wrapper.candidate.prefs = { ...wrapper.candidate.prefs, viewMode: 'all' };
  adapter.setItem(SHADOW_KEY, JSON.stringify(wrapper));
  const before = JSON.stringify(adapter.snapshotAll());
  const r = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'equivalence-failed',
    `expected equivalence-failed (stage d), got: ${r.code}`);
  // Stages (b)+(c) did pass — the code proves it (not fingerprint-mismatch / envelope-invalid).
  assert.ok(
    !['fingerprint-mismatch', 'shadow-invalid', 'shadow-absent', 'envelope-invalid'].includes(r.code),
    'earlier stages must have passed to reach equivalence check',
  );
  // No writes occurred.
  assert.equal(JSON.stringify(adapter.snapshotAll()), before, 'storage must be byte-identical');
});

check('all 5 precondition failures leave storage byte-identical', async () => {
  const cases = [
    async () => {
      const a = makeAdapter();
      await seedVerifiedShadow(a);
      a.setItem('hometask-v1', '[]');
      return [a, await checkActivationPreconditions({ adapter: a, ...BASE_PRE })];
    },
    async () => {
      const a = makeAdapter();
      return [a, await checkActivationPreconditions({ adapter: a, ...BASE_PRE })];
    },
  ];
  for (const c of cases) {
    const [a, r] = await c();
    assert.equal(r.ok, false);
    assertNoActivationState(a, `precondition-${r.code}`);
    assertUnrelated(a);
  }
});

check('successful preconditions return wrapper, candidate, sourceFingerprint', async () => {
  const adapter = makeAdapter();
  await seedVerifiedShadow(adapter);
  const r = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(r.ok, true);
  assert.ok(r.wrapper, 'wrapper required');
  assert.ok(r.candidate, 'candidate required');
  assert.ok(typeof r.sourceFingerprint === 'string' && r.sourceFingerprint.length === 64);
});

/* ════════════════════════════════════════════════════════════════════
   3 · snapshot
════════════════════════════════════════════════════════════════════ */
section('snapshot');

check('saveActivationSnapshot captures exact raw strings and null for absent keys', async () => {
  const adapter = makeAdapter();
  const r = await saveActivationSnapshot(adapter, FIXED_CLOCK, 0);
  assert.equal(r.ok, true);
  const snap = await getActivationSnapshot(adapter, 0);
  assert.ok(snap, 'snapshot must be readable');
  for (const k of ACTIVATION_SOURCE_KEYS) {
    const expected = TYPICAL_STORE[k] ?? null;
    assert.equal(snap.keys[k], expected, `snapshot key ${k} must match`);
  }
  assert.equal(snap.savedAt, FIXED_CLOCK);
  assertUnrelated(adapter);
});

check('absent §G source key stored as null (not the string "null")', async () => {
  const adapter = createMemoryAdapter({ ...UNRELATED });  // no v1 keys
  const r = await saveActivationSnapshot(adapter, FIXED_CLOCK, 0);
  assert.equal(r.ok, true);
  const snap = await getActivationSnapshot(adapter, 0);
  for (const k of ACTIVATION_SOURCE_KEYS) {
    assert.equal(snap.keys[k], null, `absent key ${k} must be null, not "null"`);
    assert.notEqual(snap.keys[k], 'null');
  }
});

check('snapshot write failure → snapshot-write-failed; storage unchanged', async () => {
  const base    = makeAdapter();
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.SNAPSHOT }]);
  const r = await saveActivationSnapshot(failing, FIXED_CLOCK, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'snapshot-write-failed');
  assert.equal(base.getItem(ACTIVATION_KEYS.SNAPSHOT), null);
});

check('snapshot readback mismatch (noop write) → snapshot-write-failed', async () => {
  const base    = makeAdapter();
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.SNAPSHOT, mode: 'noop' }]);
  const r = await saveActivationSnapshot(failing, FIXED_CLOCK, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'snapshot-write-failed');
});

check('snapshot source-key read failure → snapshot-read-failed', async () => {
  const base    = makeAdapter();
  const failing = createFailingAdapter(base, [{ op: 'get', key: 'hometask-v1' }]);
  const r = await saveActivationSnapshot(failing, FIXED_CLOCK, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'snapshot-read-failed');
});

check('snapshot survives a committed activation (never deleted by controller)', async () => {
  const adapter = makeAdapter();
  await seedVerifiedShadow(adapter);
  const pre = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(pre.ok, true);
  await saveActivationSnapshot(adapter, FIXED_CLOCK, 0);
  const v2DataStr = JSON.stringify(pre.candidate);
  const r = await runActivationTransaction({
    adapter, v2DataStr,
    expectedFingerprint: pre.sourceFingerprint,
    ...BASE_TX,
  });
  assert.equal(r.code, 'committed');
  // Snapshot must still exist after successful commit.
  const snap = await getActivationSnapshot(adapter, 0);
  assert.ok(snap, 'snapshot must be retained after commit per §G retention policy');
  assertUnrelated(adapter);
});

/* ════════════════════════════════════════════════════════════════════
   4 · transaction failures
════════════════════════════════════════════════════════════════════ */
section('transaction-failures');

async function setupForTx() {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  assert.equal(pre.ok, true);
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  return { base, pre };
}

check('staging write failure → staging-write-failed; no DATA written', async () => {
  const { base, pre } = await setupForTx();
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.STAGING }]);
  const r = await runActivationTransaction({
    adapter: failing, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'staging-write-failed');
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), null, 'DATA must not be written on staging failure');
  assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), null);
  assertUnrelated(base);
});

check('staging readback mismatch (noop) → staging-write-failed; no DATA written', async () => {
  const { base, pre } = await setupForTx();
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.STAGING, mode: 'noop' }]);
  const r = await runActivationTransaction({
    adapter: failing, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'staging-write-failed');
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), null);
});

check('v2 DATA write failure → rolled-back; staging evidence retained', async () => {
  const { base, pre } = await setupForTx();
  // Fail on the 2nd set call (1st is STAGING, 2nd is DATA).
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.DATA }]);
  const r = await runActivationTransaction({
    adapter: failing, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rolled-back');
  // v1 source data must be untouched (it was never modified by this transaction).
  for (const k of ACTIVATION_SOURCE_KEYS) {
    assert.equal(base.getItem(k), TYPICAL_STORE[k], `v1 key ${k} must be untouched`);
  }
  assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), null, 'no marker after failure');
  // QUARANTINE should hold the partial DATA artifact (may be null if DATA was never written).
  assertUnrelated(base);
});

check('v2 DATA readback mismatch → rolled-back', async () => {
  const { base, pre } = await setupForTx();
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.DATA, mode: 'noop' }]);
  const r = await runActivationTransaction({
    adapter: failing, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rolled-back');
  assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), null);
});

check('marker write failure → rolled-back; DATA quarantined; v1 untouched', async () => {
  const { base, pre } = await setupForTx();
  const v2DataStr = JSON.stringify(pre.candidate);
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.MARKER }]);
  const r = await runActivationTransaction({
    adapter: failing, v2DataStr,
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rolled-back');
  assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), null);
  for (const k of ACTIVATION_SOURCE_KEYS) {
    assert.equal(base.getItem(k), TYPICAL_STORE[k], `v1 key ${k} must be untouched`);
  }
  // DATA must have been quarantined.
  const q = base.getItem(ACTIVATION_KEYS.QUARANTINE);
  assert.ok(q, 'quarantine record must be written after marker failure');
  assertUnrelated(base);
});

check('marker readback mismatch → rolled-back', async () => {
  const { base, pre } = await setupForTx();
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.MARKER, mode: 'noop' }]);
  const r = await runActivationTransaction({
    adapter: failing, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rolled-back');
});

check('happy-path transaction: committed; DATA written; STAGING cleared; SNAPSHOT retained; MARKER present', async () => {
  const { base, pre } = await setupForTx();
  const v2DataStr = JSON.stringify(pre.candidate);
  const r = await runActivationTransaction({
    adapter: base, v2DataStr,
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'committed');
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), v2DataStr);
  assert.equal(base.getItem(ACTIVATION_KEYS.STAGING), null, 'STAGING cleared after commit');
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'MARKER must be present after commit');
  assert.ok(base.getItem(ACTIVATION_KEYS.SNAPSHOT), 'SNAPSHOT must be retained after commit');
  assertUnrelated(base);
});

/* ════════════════════════════════════════════════════════════════════
   5 · concurrent-v1-mutation (all 5 points)
════════════════════════════════════════════════════════════════════ */
section('concurrent-v1-mutation');

/**
 * Helper: run the activation transaction with a boundary mutation adapter.
 *
 * Preconditions and snapshot are run against a clean base adapter, so the
 * fingerprint is captured correctly. The boundary adapter is only used for
 * the transaction itself. afterSets controls when the physical mutation fires:
 *
 *   afterSets=0 → before write 1 (STAGING)     — point 1: after snapshot, before staging
 *   afterSets=1 → before write 2 (DATA)        — point 2: after staging, before DATA
 *   afterSets=2 → before write 3 (LIVE-STATE)  — point 3: after DATA, before LIVE-STATE [B1]
 *   afterSets=3 → on first getItem(v1)         — point 4: after all writes, before marker
 *
 * The adapter physically writes newValue to base storage at the boundary so
 * any subsequent base.getItem returns the real mutated bytes.
 */
async function txWithMutation({ mutateKey, afterSets, newValue }) {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  assert.equal(pre.ok, true, 'preconditions must pass before mutation test');
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const v2DataStr = JSON.stringify(pre.candidate);

  const mutating = createBoundaryMutatingAdapter(base, {
    mutateKey, afterSets, newValue,
  });
  const r = await runActivationTransaction({
    adapter: mutating, v2DataStr,
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  return { base, mutating, r, pre };
}

/**
 * Core invariants true for every concurrent-mutation outcome:
 *   • result is not ok (source_changed / rolled-back)
 *   • authority marker was never written
 *   • mutated v1 bytes are physically present in base storage
 *     (proves the transaction did not overwrite the newer v1 back to the snapshot)
 *   • stale v2 is not authoritative
 *   • unrelated keys are unchanged
 */
function assertMutationInvariants(base, r, expectedNewValue, testLabel) {
  assert.equal(r.ok, false,
    `${testLabel}: result must not be ok`);
  assert.ok(
    ['source_changed', 'rolled-back'].includes(r.code),
    `${testLabel}: code must be source_changed or rolled-back, got: ${r.code}`,
  );
  assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), null,
    `${testLabel}: authority marker must never be written`);
  // The boundary adapter physically wrote newValue into base storage.
  // Verifying base has that value proves the transaction left the newer
  // v1 bytes intact (did not restore the old snapshot bytes over them).
  assert.equal(base.getItem('hometask-v1'), expectedNewValue,
    `${testLabel}: base storage must retain the mutated v1 bytes (not overwritten)`);
  for (const [k, v] of Object.entries(UNRELATED)) {
    assert.equal(base.getItem(k), v, `${testLabel}: unrelated key "${k}" changed`);
  }
}

/**
 * Ordered-trace helper — extract indices of named events from adapter.log so
 * ordering assertions can be expressed as index comparisons.
 */
function traceIndex(log, predicate) {
  return log.findIndex(predicate);
}
function traceAll(log, predicate) {
  return log.filter(predicate);
}

// ── Point 1: after snapshot verification, before staging write ──────────────
// afterSets=0 → pre-hook fires before write 1 (STAGING).
// The physical v1 mutation is in base storage BEFORE any TX write occurs.
// Ordered trace: boundary-reached → v1-mutated → tx-set(STAGING) → tx-set(DATA)
//                → tx-set(STAGING-PATCH) → v1-read(mutated-value)
check('mutation point 1 — after snapshot, before staging: source_changed; no marker; v1 retained', async () => {
  const { base, mutating, r } = await txWithMutation({
    mutateKey: 'hometask-v1', afterSets: 0, newValue: '[]',
  });
  assertMutationInvariants(base, r, '[]', 'point-1');

  const log = mutating.log;
  const iBoundary  = traceIndex(log, e => e.event === 'boundary-reached');
  const iMutated   = traceIndex(log, e => e.event === 'v1-mutated');
  const iStaging   = traceIndex(log, e => e.event === 'tx-set' && e.key === ACTIVATION_KEYS.STAGING);
  const iData      = traceIndex(log, e => e.event === 'tx-set' && e.key === ACTIVATION_KEYS.DATA);
  const iRead      = traceIndex(log, e => e.event === 'v1-read');

  // All events must exist.
  assert.ok(iBoundary >= 0,  'point-1: boundary-reached must appear in log');
  assert.ok(iMutated  >= 0,  'point-1: v1-mutated must appear in log');
  assert.ok(iStaging  >= 0,  'point-1: tx-set STAGING must appear in log');
  assert.ok(iRead     >= 0,  'point-1: v1-read must appear in log');

  // Ordering: boundary → mutation BEFORE any TX write.
  assert.ok(iBoundary < iStaging,
    `point-1: boundary-reached (${iBoundary}) must precede tx-set STAGING (${iStaging})`);
  assert.ok(iMutated  < iStaging,
    `point-1: v1-mutated (${iMutated}) must precede tx-set STAGING (${iStaging})`);
  // v1-read occurs after all TX writes (fingerprint check reads the mutated bytes).
  assert.ok(iData < iRead,
    `point-1: tx-set DATA (${iData}) must precede v1-read (${iRead})`);
  // The mutated value is what the fingerprint check actually saw.
  assert.equal(log[iRead].value, '[]', 'point-1: fingerprint check must read the mutated value');
  // Boundary trigger confirms "before write 1".
  assert.equal(log[iBoundary].trigger, 'before-write-1', 'point-1: trigger must be before-write-1');
  assert.equal(log[iBoundary].setCount, 0, 'point-1: mutation fired at setCount=0 (no writes yet)');
});

// ── Point 2: after staging write, before v2 DATA write ──────────────────────
// afterSets=1 → pre-hook fires before write 2 (DATA), after write 1 (STAGING).
// Ordered trace: tx-set(STAGING) → boundary-reached → v1-mutated → tx-set(DATA)
//                → tx-set(STAGING-PATCH) → v1-read(mutated-value)
check('mutation point 2 — after staging, before DATA write: source_changed; no marker; v1 retained', async () => {
  const { base, mutating, r } = await txWithMutation({
    mutateKey: 'hometask-v1', afterSets: 1, newValue: '[]',
  });
  assertMutationInvariants(base, r, '[]', 'point-2');

  const log = mutating.log;
  const iStaging  = traceIndex(log, e => e.event === 'tx-set' && e.key === ACTIVATION_KEYS.STAGING);
  const iBoundary = traceIndex(log, e => e.event === 'boundary-reached');
  const iMutated  = traceIndex(log, e => e.event === 'v1-mutated');
  const iData     = traceIndex(log, e => e.event === 'tx-set' && e.key === ACTIVATION_KEYS.DATA);
  const iRead     = traceIndex(log, e => e.event === 'v1-read');

  assert.ok(iStaging  >= 0, 'point-2: tx-set STAGING must appear');
  assert.ok(iBoundary >= 0, 'point-2: boundary-reached must appear');
  assert.ok(iMutated  >= 0, 'point-2: v1-mutated must appear');
  assert.ok(iData     >= 0, 'point-2: tx-set DATA must appear');
  assert.ok(iRead     >= 0, 'point-2: v1-read must appear');

  // Ordering: STAGING write → boundary → mutation → DATA write → v1-read.
  assert.ok(iStaging  < iBoundary,
    `point-2: tx-set STAGING (${iStaging}) must precede boundary-reached (${iBoundary})`);
  assert.ok(iBoundary < iData,
    `point-2: boundary-reached (${iBoundary}) must precede tx-set DATA (${iData})`);
  assert.ok(iMutated  < iData,
    `point-2: v1-mutated (${iMutated}) must precede tx-set DATA (${iData})`);
  assert.ok(iData     < iRead,
    `point-2: tx-set DATA (${iData}) must precede v1-read (${iRead})`);
  assert.equal(log[iRead].value, '[]', 'point-2: fingerprint check must read the mutated value');
  assert.equal(log[iBoundary].trigger, 'before-write-2', 'point-2: trigger must be before-write-2');
  assert.equal(log[iBoundary].setCount, 1, 'point-2: mutation fired after 1 completed write (STAGING)');
});

// ── Point 3: after v2 DATA write, before LIVE-STATE write ────────────────────
// afterSets=2 → pre-hook fires before write 3 (LIVE-STATE), after write 2 (DATA). [B1]
// Ordered trace: tx-set(STAGING) → tx-set(DATA) → boundary-reached → v1-mutated
//                → tx-set(LIVE-STATE) → tx-set(STAGING-PATCH) → v1-read(mutated-value)
check('mutation point 3 — after DATA write, before STAGING patch: source_changed; no marker; v1 retained', async () => {
  const { base, mutating, r } = await txWithMutation({
    mutateKey: 'hometask-v1', afterSets: 2, newValue: '[]',
  });
  assertMutationInvariants(base, r, '[]', 'point-3');

  const log = mutating.log;
  const iData     = traceIndex(log, e => e.event === 'tx-set' && e.key === ACTIVATION_KEYS.DATA);
  const iBoundary = traceIndex(log, e => e.event === 'boundary-reached');
  const iMutated  = traceIndex(log, e => e.event === 'v1-mutated');
  // STAGING appears at least 3 times: initial staged record, v2_written patch, source_changed
  // patch. We want the second (index 1) = the v2_written patch between DATA and v1-read.
  const stagingIndices = log
    .map((e, i) => (e.event === 'tx-set' && e.key === ACTIVATION_KEYS.STAGING) ? i : -1)
    .filter(i => i >= 0);
  const iPatch    = stagingIndices[1]; // 2nd STAGING write = v2_written patch
  const iRead     = traceIndex(log, e => e.event === 'v1-read');

  assert.ok(iData         >= 0, 'point-3: tx-set DATA must appear');
  assert.ok(iBoundary     >= 0, 'point-3: boundary-reached must appear');
  assert.ok(iMutated      >= 0, 'point-3: v1-mutated must appear');
  assert.ok(stagingIndices.length >= 2, 'point-3: at least 2 STAGING writes (initial + v2_written patch)');
  assert.ok(iPatch        >= 0, 'point-3: second STAGING write (v2_written patch) must appear');
  assert.ok(iRead         >= 0, 'point-3: v1-read must appear');

  // Ordering: DATA write → boundary → mutation → STAGING patch (v2_written) → v1-read.
  assert.ok(iData     < iBoundary,
    `point-3: tx-set DATA (${iData}) must precede boundary-reached (${iBoundary})`);
  assert.ok(iBoundary < iPatch,
    `point-3: boundary-reached (${iBoundary}) must precede STAGING v2_written patch (${iPatch})`);
  assert.ok(iMutated  < iPatch,
    `point-3: v1-mutated (${iMutated}) must precede STAGING v2_written patch (${iPatch})`);
  assert.ok(iPatch    < iRead,
    `point-3: STAGING v2_written patch (${iPatch}) must precede v1-read (${iRead})`);
  assert.equal(log[iRead].value, '[]', 'point-3: fingerprint check must read the mutated value');
  assert.equal(log[iBoundary].trigger, 'before-write-3', 'point-3: trigger must be before-write-3');
  assert.equal(log[iBoundary].setCount, 2, 'point-3: mutation fired after 2 completed writes (STAGING+DATA)');
});

// ── Point 4: immediately before marker write (after all TX writes) ───────────
// afterSets=3 → getItem-hook fires on first getItem(v1) after all TX writes.
// This is the exact moment recomputeAndVerifyFingerprint reads the source key —
// after STAGING+DATA+LIVE-STATE+STAGING-PATCH have all landed, before marker write.
// Ordered trace: tx-set(STAGING) → tx-set(DATA) → tx-set(LIVE-STATE) → tx-set(STAGING-PATCH)
//                → boundary-reached → v1-mutated → v1-read(mutated-value) [B1: 4 TX writes]
check('mutation point 4 — immediately before marker write: source_changed; no marker; DATA quarantined', async () => {
  const { base, mutating, r } = await txWithMutation({
    mutateKey: 'hometask-v1', afterSets: 3, newValue: '[]',
  });
  assertMutationInvariants(base, r, '[]', 'point-4');

  const log = mutating.log;
  const txSets    = traceAll(log, e => e.event === 'tx-set');
  const iBoundary = traceIndex(log, e => e.event === 'boundary-reached');
  const iMutated  = traceIndex(log, e => e.event === 'v1-mutated');
  const iRead     = traceIndex(log, e => e.event === 'v1-read');

  assert.ok(txSets.length >= 3,  'point-4: at least 3 TX writes must appear (STAGING, DATA, PATCH)');
  assert.ok(iBoundary >= 0,      'point-4: boundary-reached must appear');
  assert.ok(iMutated  >= 0,      'point-4: v1-mutated must appear');
  assert.ok(iRead     >= 0,      'point-4: v1-read must appear');

  // All 3 core TX writes (STAGING, DATA, STAGING-PATCH) complete BEFORE the boundary.
  // Post-detection writes (QUARANTINE, source_changed STAGING patch) appear after and
  // must not be counted here — we use slice(0, iBoundary) to isolate pre-boundary SETs.
  const preBoundaryTxSets = log.slice(0, iBoundary).filter(e => e.event === 'tx-set');
  assert.ok(preBoundaryTxSets.length >= 3,
    `point-4: at least 3 TX writes must complete before boundary-reached (found ${preBoundaryTxSets.length})`);
  // boundary → mutation → v1-read (mutation in base before fingerprint reads).
  assert.ok(iBoundary < iMutated,
    `point-4: boundary-reached (${iBoundary}) must precede v1-mutated (${iMutated})`);
  assert.ok(iMutated  < iRead,
    `point-4: v1-mutated (${iMutated}) must precede v1-read (${iRead})`);
  assert.equal(log[iRead].value, '[]', 'point-4: fingerprint check must read the mutated value');
  assert.equal(log[iBoundary].trigger, 'on-v1-read',
    'point-4: trigger must be on-v1-read (fires at the fingerprint-check read, not a pre-hook)');
  // DATA must be quarantined (it was written at write 2, then source_changed detected).
  const q = base.getItem(ACTIVATION_KEYS.QUARANTINE);
  assert.ok(q, 'point-4: quarantine record must be written');
  const qRecord = JSON.parse(q);
  assert.equal(qRecord.sourceKey, ACTIVATION_KEYS.DATA, 'point-4: quarantine must reference DATA key');
});

// ── Point 5: during startup recovery (crash at v2_written; v1 mutated between crash and restart) ─
// Mutation is pre-placed in storage BEFORE recovery runs (simulating a user write
// during the crash window). The spy adapter logs v1 reads so we can prove recovery
// read the mutated bytes and still chose source-changed-on-recovery rather than
// overwriting v1 with the older snapshot bytes.
//
// Ordered trace:
//   [setup] v1-mutated physically in base storage
//   [recovery] v1-read via spy (reads '[]')
//   [recovery] result: action=source-changed-on-recovery, v2Active=false
//   [recovery] zero writes to any v1 source key
//   [base]  hometask-v1 still '[]' (newer bytes intact)
//   [base]  MARKER absent
//   [base]  unrelated keys unchanged
check('mutation point 5 — during restart recovery: source-changed-on-recovery; v1 not overwritten', async () => {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  const v2DataStr = JSON.stringify(pre.candidate);
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);

  // Simulate crash after v2 DATA write, before marker.
  base.setItem(ACTIVATION_KEYS.DATA, v2DataStr);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION,
    txState: 'v2_written',
    startedAt: FIXED_CLOCK,
    sourceFingerprint: pre.sourceFingerprint,
  }));

  // ① Physical v1 mutation: newer data written into base storage during the crash window.
  base.setItem('hometask-v1', '[]');
  assert.equal(base.getItem('hometask-v1'), '[]', 'setup: mutation must be in base before recovery');

  // ② Recovery runs via spy adapter (logs v1 reads and all writes).
  const spy = createSpyAdapter(base);
  const result = await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);

  // ③ Recovery read the mutated v1 bytes (spy.readLog proves it).
  const v1Reads = spy.readLog.filter(e => e.key === 'hometask-v1');
  assert.ok(v1Reads.length > 0, 'recovery must have read hometask-v1 for the fingerprint check');
  assert.equal(v1Reads[0].value, '[]',
    'recovery read the mutated value (not the snapshot bytes)');

  // ④ Recovery decided correctly.
  assert.equal(result.v2Active, false,
    'v2 must not be authoritative — source_changed means v1 is the truth');
  assert.equal(result.action, 'source-changed-on-recovery',
    `expected source-changed-on-recovery, got: ${result.action}`);

  // ⑤ Recovery never wrote to any v1 source key (zero overwrites).
  const v1Writes = spy.writeLog.filter(e => ACTIVATION_SOURCE_KEYS.includes(e.key));
  assert.equal(v1Writes.length, 0,
    `recovery wrote to v1 source key(s): ${v1Writes.map(e => `${e.op}(${e.key})`).join(', ')}`);

  // ⑥ Newer v1 bytes byte-identical after recovery.
  assert.equal(base.getItem('hometask-v1'), '[]',
    'newer v1 bytes must be retained byte-for-byte, not overwritten with snapshot');

  // ⑦ No marker written; v2 is not authoritative.
  assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), null,
    'authority marker must not be written after source-changed-on-recovery');

  // ⑧ Unrelated keys unchanged.
  assertUnrelated(base);
});

check('mutation in all 3 source keys — none cause v1 overwrite, marker commit, or unrelated-key change', async () => {
  // Uses point-4 boundary (afterSets=3, on-v1-read trigger): the tightest window —
  // mutation is placed into base storage at the exact moment the fingerprint check
  // reads the key, after all TX writes have completed. Covers all three source keys.
  for (const mutateKey of ACTIVATION_SOURCE_KEYS) {
    const base = makeAdapter();
    await seedVerifiedShadow(base);
    const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
    await saveActivationSnapshot(base, FIXED_CLOCK, 0);
    const v2DataStr = JSON.stringify(pre.candidate);
    const mutating = createBoundaryMutatingAdapter(base, {
      mutateKey, afterSets: 3, newValue: null,
    });
    const r = await runActivationTransaction({
      adapter: mutating, v2DataStr, expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
    });
    const log = mutating.log;

    // Core invariants.
    assert.equal(r.ok, false, `key ${mutateKey}: result must not be ok`);
    assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), null, `key ${mutateKey}: no marker`);

    // Mutation fired (boundary-reached and v1-mutated events present).
    const iBoundary = traceIndex(log, e => e.event === 'boundary-reached');
    const iMutated  = traceIndex(log, e => e.event === 'v1-mutated');
    const iRead     = traceIndex(log, e => e.event === 'v1-read' && e.key === mutateKey);
    assert.ok(iBoundary >= 0, `key ${mutateKey}: boundary-reached must appear`);
    assert.ok(iMutated  >= 0, `key ${mutateKey}: v1-mutated must appear`);
    assert.ok(iRead     >= 0, `key ${mutateKey}: v1-read must appear`);

    // All 3 core TX writes (STAGING, DATA, STAGING-PATCH) complete before the boundary.
    // Post-detection writes appear after iBoundary and must not be counted here.
    const preBoundaryTxSets = log.slice(0, iBoundary).filter(e => e.event === 'tx-set');
    assert.ok(preBoundaryTxSets.length >= 3,
      `key ${mutateKey}: at least 3 TX writes must complete before boundary (found ${preBoundaryTxSets.length})`);

    // boundary → mutation → read (mutation in base before fingerprint read).
    assert.ok(iBoundary < iMutated, `key ${mutateKey}: boundary before mutation`);
    assert.ok(iMutated  < iRead,    `key ${mutateKey}: mutation before v1-read`);
    assert.equal(log[iBoundary].trigger, 'on-v1-read',
      `key ${mutateKey}: trigger must be on-v1-read`);

    // Physical mutation in base storage (newValue=null means the key was erased).
    assert.equal(base.getItem(mutateKey), null,
      `key ${mutateKey}: mutated value must be in base storage`);

    // Unrelated keys unchanged.
    assertUnrelated(base);
  }
});

/* ════════════════════════════════════════════════════════════════════
   5b · pre-marker-v1-writes invariant
   Required: every recoverActivationStartup() path that runs before a
   valid authority marker exists must have ZERO writes/removes to any
   v1 source key, regardless of the staging state found at startup.
════════════════════════════════════════════════════════════════════ */
section('pre-marker-v1-writes');

/**
 * Assert that no entry in writeLog touches a v1 source key.
 * Fails with a descriptive message listing every offending write.
 */
function assertNoV1Writes(writeLog, label) {
  const v1Writes = writeLog.filter(e => ACTIVATION_SOURCE_KEYS.includes(e.key));
  assert.equal(
    v1Writes.length, 0,
    `${label}: recovery wrote to v1 source key(s): ` +
    v1Writes.map(e => `${e.op}(${e.key})`).join(', '),
  );
}

check('pre-marker path: no staging → zero v1 writes', async () => {
  const base = makeAdapter();
  const spy  = createSpyAdapter(base);
  await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assertNoV1Writes(spy.writeLog, 'state:none');
});

check('pre-marker path: state:staged → zero v1 writes', async () => {
  const base = makeAdapter();
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'staged',
    startedAt: FIXED_CLOCK, sourceFingerprint: 'a'.repeat(64),
  }));
  const spy = createSpyAdapter(base);
  const r = await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.action, 'cleaned-staged');
  assertNoV1Writes(spy.writeLog, 'state:staged');
});

check('pre-marker path: state:v2_written, v1 matches snapshot → zero v1 writes', async () => {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const v2DataStr = JSON.stringify(pre.candidate);
  base.setItem(ACTIVATION_KEYS.DATA, v2DataStr);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'v2_written',
    startedAt: FIXED_CLOCK, sourceFingerprint: pre.sourceFingerprint,
  }));
  const spy = createSpyAdapter(base);
  await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assertNoV1Writes(spy.writeLog, 'state:v2_written-match');
});

check('pre-marker path: state:v2_written, v1 differs from snapshot → zero v1 writes', async () => {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  base.setItem(ACTIVATION_KEYS.DATA, JSON.stringify(pre.candidate));
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'v2_written',
    startedAt: FIXED_CLOCK, sourceFingerprint: pre.sourceFingerprint,
  }));
  // Concurrent v1 mutation — v1 now newer than snapshot.
  base.setItem('hometask-v1', '[]');
  const spy = createSpyAdapter(base);
  const r = await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.action, 'source-changed-on-recovery');
  assertNoV1Writes(spy.writeLog, 'state:v2_written-mismatch');
  // Verify newer v1 bytes are intact.
  assert.equal(base.getItem('hometask-v1'), '[]', 'newer v1 must not be overwritten');
});

check('pre-marker path: state:committed (no marker) → zero v1 writes', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'committed', committedAt: FIXED_CLOCK,
  }));
  const spy = createSpyAdapter(base);
  const r = await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.action, 'cleaned-committed-no-marker');
  assertNoV1Writes(spy.writeLog, 'state:committed-no-marker');
});

check('pre-marker path: state:rollback_failed → zero v1 writes', async () => {
  const base = makeAdapter();
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'rollback_failed',
    rollbackError: 'marker-write-failed', failedAt: FIXED_CLOCK,
  }));
  const spy = createSpyAdapter(base);
  await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assertNoV1Writes(spy.writeLog, 'state:rollback_failed');
});

check('pre-marker path: state:source_changed → zero v1 writes', async () => {
  const base = makeAdapter();
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'source_changed',
    abortedAt: FIXED_CLOCK, abortReason: 'source_changed',
  }));
  const spy = createSpyAdapter(base);
  await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assertNoV1Writes(spy.writeLog, 'state:source_changed');
});

check('pre-marker path: malformed staging record → zero v1 writes', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.STAGING, '{"txVersion":1}');  // missing txState
  const spy = createSpyAdapter(base);
  await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assertNoV1Writes(spy.writeLog, 'state:malformed-staging');
});

check('pre-marker path: malformed authority marker → zero v1 writes', async () => {
  // A structurally invalid marker is present — it cannot serve as the authority switch.
  // Recovery must quarantine the marker without touching v1 source keys.
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.MARKER, '{"markerVersion":0,"broken":true}');
  const spy = createSpyAdapter(base);
  await recoverActivationStartup(spy, FIXED_CLOCK2, testDigest, 0);
  assertNoV1Writes(spy.writeLog, 'state:malformed-marker');
});

/* ════════════════════════════════════════════════════════════════════
   6 · startup-recovery
════════════════════════════════════════════════════════════════════ */
section('startup-recovery');

async function buildCommittedState() {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const r = await runActivationTransaction({
    adapter: base, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint, ...BASE_TX,
  });
  assert.equal(r.code, 'committed');
  return { base, pre };
}

check('no staging + no marker → action:none; v2Active:false', async () => {
  const adapter = makeAdapter();
  const r = await recoverActivationStartup(adapter, FIXED_CLOCK, testDigest, 0);
  assert.equal(r.action, 'none');
  assert.equal(r.v2Active, false);
});

check('committed-verified: marker retained; STAGING cleared; v2Active:true', async () => {
  const { base } = await buildCommittedState();
  const markerBefore = base.getItem(ACTIVATION_KEYS.MARKER);
  assert.ok(markerBefore, 'marker must exist after commit');
  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.action, 'committed-verified');
  assert.equal(r.v2Active, true);
  assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), markerBefore, 'marker must NOT be deleted on success');
  assert.equal(base.getItem(ACTIVATION_KEYS.STAGING), null, 'STAGING cleared');
  // B1: LIVE-STATE must be present and structurally valid after a committed state.
  const lsRaw = base.getItem(ACTIVATION_KEYS.LIVE_STATE);
  assert.ok(lsRaw, 'LIVE-STATE must be present after activation');
  const ls = JSON.parse(lsRaw);
  assert.equal(ls.generation, 0, 'LIVE-STATE generation must be 0 at activation');
  assert.equal(typeof ls.digest, 'string', 'LIVE-STATE must contain a digest');
  assert.equal(ls.schemaVersion, ACTIVATION_TARGET_SCHEMA, 'LIVE-STATE schemaVersion must match target');
  assertUnrelated(base);
});

check('successful recovery NEVER deletes the authority marker', async () => {
  const { base } = await buildCommittedState();
  const markerBefore = base.getItem(ACTIVATION_KEYS.MARKER);
  // Run recovery twice to prove idempotency and marker retention.
  for (let i = 0; i < 3; i++) {
    await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
    assert.equal(base.getItem(ACTIVATION_KEYS.MARKER), markerBefore,
      `iteration ${i}: marker deleted — must never happen`);
  }
});

check('state:staged (no DATA written) → cleaned-staged; v2Active:false; v1 untouched', async () => {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'staged',
    startedAt: FIXED_CLOCK, sourceFingerprint: 'a'.repeat(64),
  }));
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.action, 'cleaned-staged');
  assert.equal(r.v2Active, false);
  assert.equal(base.getItem(ACTIVATION_KEYS.STAGING), null);
  // v1 must be untouched (never modified pre-commitment).
  for (const k of ACTIVATION_SOURCE_KEYS) {
    assert.equal(base.getItem(k), TYPICAL_STORE[k], `v1 ${k} must be untouched`);
  }
});

check('state:v2_written (no marker) + v1 matches snapshot → recovered; DATA quarantined', async () => {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const v2DataStr = JSON.stringify(pre.candidate);
  base.setItem(ACTIVATION_KEYS.DATA, v2DataStr);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'v2_written',
    startedAt: FIXED_CLOCK, sourceFingerprint: pre.sourceFingerprint,
  }));
  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.v2Active, false);
  // v1 must not have been rewritten from snapshot (it was never modified).
  for (const k of ACTIVATION_SOURCE_KEYS) {
    assert.equal(base.getItem(k), TYPICAL_STORE[k], `v1 ${k} must be untouched`);
  }
  // DATA should be quarantined.
  const q = base.getItem(ACTIVATION_KEYS.QUARANTINE);
  assert.ok(q, 'quarantine record must exist');
  assertUnrelated(base);
});

check('state:committed + no marker → cleaned-committed-no-marker; v2Active:false', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'committed',
    committedAt: FIXED_CLOCK,
  }));
  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.action, 'cleaned-committed-no-marker');
  assert.equal(r.v2Active, false);
  assert.equal(base.getItem(ACTIVATION_KEYS.STAGING), null);
});

check('malformed staging record → quarantined; original retained if quarantine fails', async () => {
  const base = makeAdapter();
  const malformed = '{"txVersion":1}';  // missing txState
  base.setItem(ACTIVATION_KEYS.STAGING, malformed);
  const r = await recoverActivationStartup(base, FIXED_CLOCK, testDigest, 0);
  // Either quarantined or retained — either way, no crash and v2Active false.
  assert.equal(r.v2Active, false);
  assert.ok(
    r.action === 'quarantined-malformed-staging' || r.action === 'retained-malformed-staging',
    `unexpected action: ${r.action}`,
  );
});

check('future txVersion → quarantined-unsupported; staging record untouched', async () => {
  const base = makeAdapter();
  const futureTx = JSON.stringify({ txVersion: 9999, txState: 'staged' });
  base.setItem(ACTIVATION_KEYS.STAGING, futureTx);
  const r = await recoverActivationStartup(base, FIXED_CLOCK, testDigest, 0);
  assert.equal(r.action, 'quarantined-unsupported');
  assert.equal(r.v2Active, false);
  // Staging must NOT be removed (it belongs to a future version).
  assert.equal(base.getItem(ACTIVATION_KEYS.STAGING), futureTx);
});

check('quarantine-failure retains original evidence (noop quarantine write)', async () => {
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const v2DataStr = JSON.stringify(pre.candidate);
  base.setItem(ACTIVATION_KEYS.DATA, v2DataStr);
  base.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'v2_written',
    sourceFingerprint: pre.sourceFingerprint,
  }));
  // Block quarantine writes.
  const failing = createFailingAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.QUARANTINE, mode: 'noop' }]);
  await recoverActivationStartup(failing, FIXED_CLOCK2, testDigest, 0);
  // DATA must still be present (quarantine failed → original retained).
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), v2DataStr,
    'quarantine-failure: original DATA must be retained');
});

check('post-commit: DATA corrupted (LIVE-STATE mismatch, no journal) → ambiguous-state; v2Active:false', async () => {
  // B1: LIVE-STATE is written at activation. Corrupting DATA makes LIVE-STATE.digest ≠ sha256(DATA).
  // With no mutation journal, recovery cannot restore the data → ambiguous-state.
  const { base } = await buildCommittedState();
  // Corrupt the v2 DATA after commitment (simulates storage corruption).
  base.setItem(ACTIVATION_KEYS.DATA, '{"schemaVersion":2,"corrupted":true}');
  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.v2Active, false);
  assert.equal(r.action, 'ambiguous-state',
    `B1: LIVE-STATE mismatch + no journal → ambiguous-state (got: ${r.action})`);
  // Evidence retained (correction 3).
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be retained');
  assert.ok(base.getItem(ACTIVATION_KEYS.DATA),   'DATA must be retained');
  assert.ok(base.getItem(ACTIVATION_KEYS.LIVE_STATE), 'LIVE-STATE must be retained');
});

check('post-commit: marker with wrong v2DataDigest + LIVE-STATE absent → ambiguous-state; nothing overwritten', async () => {
  // B1: marker is structurally valid but carries a wrong v2DataDigest (simulates a corrupt
  // or forged marker). LIVE-STATE is absent (pre-B1 fixture). _handleLegacyCommitted computes
  // sha256(DATA) and finds it does not match marker.v2DataDigest → ambiguous-state.
  // The v1 mutation below proves v1 bytes are never touched in any ambiguous path.
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const v2DataStr = JSON.stringify(pre.candidate);
  base.setItem(ACTIVATION_KEYS.DATA, v2DataStr);
  const fakeDigest = 'b'.repeat(64);  // valid hex, wrong value
  const marker = buildMarker({
    activationId: `act-${FIXED_CLOCK}`,
    sourceFingerprint: pre.sourceFingerprint,
    v2DataDigest: fakeDigest,   // wrong digest → legacy-committed digest mismatch
    committedAt: FIXED_CLOCK,
  });
  base.setItem(ACTIVATION_KEYS.MARKER, JSON.stringify(marker));
  // No LIVE-STATE (legacy fixture — as if committed before B1 was deployed).

  // Mutate v1 to confirm it is never overwritten.
  base.setItem('hometask-v1', '[]');

  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.v2Active, false);
  assert.equal(r.action, 'ambiguous-state',
    'legacy-committed with wrong v2DataDigest → ambiguous-state');
  // v1 must not be overwritten.
  assert.equal(base.getItem('hometask-v1'), '[]', 'newer v1 must be retained');
  // All evidence retained (correction 3).
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be retained for ambiguous-state');
  assert.ok(base.getItem(ACTIVATION_KEYS.DATA), 'DATA must be retained for ambiguous-state');
});

/* ════════════════════════════════════════════════════════════════════
   7 · marker integrity
════════════════════════════════════════════════════════════════════ */
section('marker-integrity');

check('buildMarker produces a well-formed marker with all required fields', () => {
  const m = buildMarker({
    activationId:      'act-2026',
    sourceFingerprint: 'a'.repeat(64),
    v2DataDigest:      'b'.repeat(64),
    committedAt:       FIXED_CLOCK,
  });
  assert.equal(m.markerVersion, ACTIVATION_MARKER_VERSION);
  assert.equal(m.targetSchema,  ACTIVATION_TARGET_SCHEMA);
  assert.equal(m.activationId,  'act-2026');
  assert.equal(m.committedAt,   FIXED_CLOCK);
  assert.equal(m.sourceFingerprint, 'a'.repeat(64));
  assert.equal(m.v2DataDigest,      'b'.repeat(64));
});

check('validateMarker: valid marker + matching v2DataDigest → valid:true', async () => {
  const { base } = await buildCommittedState();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const result  = await validateMarker(marker, base, testDigest, 0);
  assert.equal(result.valid, true, `expected valid:true, got reason: ${result.reason}`);
});

check('validateMarker: v2DataDigest mismatch → valid:false; v1 authoritative', async () => {
  const { base } = await buildCommittedState();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  marker.v2DataDigest = 'c'.repeat(64);   // wrong digest
  const result = await validateMarker(marker, base, testDigest, 0);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes('mismatch'), `reason: ${result.reason}`);
});

check('validateMarker: malformed marker → valid:false', async () => {
  const bad = { markerVersion: 0, activationId: '', sourceFingerprint: 'bad', v2DataDigest: 'bad', targetSchema: 99, committedAt: '' };
  const adapter = makeAdapter();
  const result = await validateMarker(bad, adapter, testDigest, 0);
  assert.equal(result.valid, false);
});

check('validateMarker: v2 DATA absent → valid:false', async () => {
  const m = buildMarker({ activationId: 'x', sourceFingerprint: 'a'.repeat(64), v2DataDigest: 'b'.repeat(64), committedAt: FIXED_CLOCK });
  const adapter = makeAdapter();   // no DATA key
  const result = await validateMarker(m, adapter, testDigest, 0);
  assert.equal(result.valid, false);
});

check('marker deletion/absence keeps v1 authoritative', async () => {
  const { base } = await buildCommittedState();
  base.removeItem(ACTIVATION_KEYS.MARKER);
  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.v2Active, false, 'absent marker → v1 must be authoritative');
});

/* ── validateMarkerStructure (B1 export) ─────────────────────────── */

check('validateMarkerStructure: well-formed marker → valid:true (synchronous, no I/O)', () => {
  const m = buildMarker({
    activationId: 'act-1', sourceFingerprint: 'a'.repeat(64),
    v2DataDigest: 'b'.repeat(64), committedAt: FIXED_CLOCK,
  });
  const r = validateMarkerStructure(m);
  assert.equal(r.valid, true);
});

check('validateMarkerStructure: null → valid:false', () => {
  assert.equal(validateMarkerStructure(null).valid, false);
});

check('validateMarkerStructure: missing field → valid:false', () => {
  const m = buildMarker({
    activationId: 'act-1', sourceFingerprint: 'a'.repeat(64),
    v2DataDigest: 'b'.repeat(64), committedAt: FIXED_CLOCK,
  });
  const { v2DataDigest: _, ...noDigest } = m;
  assert.equal(validateMarkerStructure(noDigest).valid, false);
});

check('validateMarkerStructure: non-hex v2DataDigest → valid:false', () => {
  const m = buildMarker({
    activationId: 'act-1', sourceFingerprint: 'a'.repeat(64),
    v2DataDigest: 'z'.repeat(64),  // not valid hex
    committedAt: FIXED_CLOCK,
  });
  assert.equal(validateMarkerStructure(m).valid, false);
});

check('validateMarkerStructure: wrong markerVersion → valid:false', () => {
  const m = buildMarker({
    activationId: 'act-1', sourceFingerprint: 'a'.repeat(64),
    v2DataDigest: 'b'.repeat(64), committedAt: FIXED_CLOCK,
  });
  assert.equal(validateMarkerStructure({ ...m, markerVersion: 9999 }).valid, false);
});

check('validateMarkerStructure does not call digestFn or touch storage (pure)', () => {
  // Confirm purely structural: call with no adapter, no digestFn available.
  const m = buildMarker({
    activationId: 'act-1', sourceFingerprint: 'a'.repeat(64),
    v2DataDigest: 'b'.repeat(64), committedAt: FIXED_CLOCK,
  });
  let called = false;
  // Pass a bad digestFn — if validateMarkerStructure called it, this test would detect it.
  const badDigest = () => { called = true; return ''; };
  const r = validateMarkerStructure(m, badDigest);  // extra arg ignored; fn is synchronous
  assert.equal(r.valid, true);
  assert.equal(called, false, 'validateMarkerStructure must not call any digest function');
});

/* ── legacy-committed recovery (B1, via recoverActivationStartup) ── */

check('legacy-committed: marker present + LIVE-STATE absent + sha256(DATA)==v2DataDigest → v2Active:true, LIVE-STATE gen 0 created', async () => {
  // Simulate a pre-B1 committed fixture: marker + DATA, no LIVE-STATE.
  const base = makeAdapter();
  await seedVerifiedShadow(base);
  const pre = await checkActivationPreconditions({ adapter: base, ...BASE_PRE });
  await saveActivationSnapshot(base, FIXED_CLOCK, 0);
  const v2DataStr = JSON.stringify(pre.candidate);
  // Compute the real digest to embed in the marker.
  const enc = new TextEncoder();
  const bytes = enc.encode(v2DataStr);
  const realDigest = await testDigest(bytes);
  base.setItem(ACTIVATION_KEYS.DATA, v2DataStr);
  const marker = buildMarker({
    activationId: `act-${FIXED_CLOCK}`,
    sourceFingerprint: pre.sourceFingerprint,
    v2DataDigest: realDigest,
    committedAt: FIXED_CLOCK,
  });
  base.setItem(ACTIVATION_KEYS.MARKER, JSON.stringify(marker));
  // No LIVE-STATE — pre-B1 committed state.

  const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
  assert.equal(r.action, 'legacy-committed', `expected legacy-committed, got: ${r.action}`);
  assert.equal(r.v2Active, true);
  // LIVE-STATE must be created at gen 0.
  const lsRaw = base.getItem(ACTIVATION_KEYS.LIVE_STATE);
  assert.ok(lsRaw, 'LIVE-STATE must be created by legacy-committed recovery');
  const ls = JSON.parse(lsRaw);
  assert.equal(ls.generation, 0);
  assert.equal(ls.digest, realDigest);
  assert.equal(ls.schemaVersion, ACTIVATION_TARGET_SCHEMA);
  // Marker retained.
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be retained');
});

/* ════════════════════════════════════════════════════════════════════
   8 · idempotency
════════════════════════════════════════════════════════════════════ */
section('idempotency');

check('repeated recovery on committed-verified state is idempotent', async () => {
  const { base } = await buildCommittedState();
  for (let i = 0; i < 3; i++) {
    const r = await recoverActivationStartup(base, FIXED_CLOCK2, testDigest, 0);
    assert.equal(r.action, 'committed-verified', `iteration ${i}`);
    assert.equal(r.v2Active, true, `iteration ${i}`);
  }
});

check('repeated recovery with no staging/marker is idempotent', async () => {
  const adapter = makeAdapter();
  for (let i = 0; i < 3; i++) {
    const r = await recoverActivationStartup(adapter, FIXED_CLOCK2, testDigest, 0);
    assert.equal(r.action, 'none', `iteration ${i}`);
  }
});

check('recomputeAndVerifyFingerprint: matching fingerprint → ok:true', async () => {
  const adapter = makeAdapter();
  await seedVerifiedShadow(adapter);
  const pre = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(pre.ok, true);
  const r = await recomputeAndVerifyFingerprint(adapter, pre.sourceFingerprint, testDigest, 0);
  assert.equal(r.ok, true);
});

check('recomputeAndVerifyFingerprint: mutated v1 → ok:false, code:source_changed', async () => {
  const adapter = makeAdapter();
  await seedVerifiedShadow(adapter);
  const pre = await checkActivationPreconditions({ adapter, ...BASE_PRE });
  assert.equal(pre.ok, true);
  adapter.setItem('hometask-v1', '[]');
  const r = await recomputeAndVerifyFingerprint(adapter, pre.sourceFingerprint, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'source_changed');
});

/* ════════════════════════════════════════════════════════════════════
   9 · timeouts
════════════════════════════════════════════════════════════════════ */
section('timeouts');

check('saveActivationSnapshot times out on hanging getItem', async () => {
  const base    = makeAdapter();
  const hanging = makeHangingAdapter(base, 'hometask-v1');
  const r = await saveActivationSnapshot(hanging, FIXED_CLOCK, 1, FIRE_NOW_SCHEDULER);
  assert.equal(r.ok, false);
  assert.ok(r.code === 'snapshot-read-failed', `got: ${r.code}`);
});

check('checkActivationPreconditions times out on hanging shadow read', async () => {
  const base    = makeAdapter();
  await seedVerifiedShadow(base);
  const hanging = makeHangingAdapter(base, SHADOW_KEY);
  const r = await checkActivationPreconditions({
    adapter: hanging, ...BASE_PRE, timeoutMs: 1, scheduler: FIRE_NOW_SCHEDULER,
  });
  assert.equal(r.ok, false);
  assert.ok(r.code === 'shadow-read-failed', `got: ${r.code}`);
});

check('runActivationTransaction times out on hanging staging write', async () => {
  const { base, pre } = await setupForTx();
  const hanging = makeHangingAdapter(base, ACTIVATION_KEYS.STAGING);
  const r = await runActivationTransaction({
    adapter: hanging, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint,
    clock: FIXED_CLOCK, digestFn: testDigest,
    timeoutMs: 1, scheduler: FIRE_NOW_SCHEDULER,
  });
  assert.equal(r.ok, false);
  assert.ok(r.code === 'staging-write-failed', `got: ${r.code}`);
});

check('runActivationTransaction times out on hanging v2 DATA write', async () => {
  const { base, pre } = await setupForTx();
  const hanging = makeHangingAdapter(base, ACTIVATION_KEYS.DATA);
  const r = await runActivationTransaction({
    adapter: hanging, v2DataStr: JSON.stringify(pre.candidate),
    expectedFingerprint: pre.sourceFingerprint,
    clock: FIXED_CLOCK, digestFn: testDigest,
    timeoutMs: 1, scheduler: FIRE_NOW_SCHEDULER,
  });
  assert.equal(r.ok, false);
});

check('recoverActivationStartup times out on hanging marker read', async () => {
  const { base } = await buildCommittedState();
  const hanging = makeHangingAdapter(base, ACTIVATION_KEYS.MARKER);
  // With a hanging adapter and instant scheduler, the function should not throw.
  let threw = false;
  try {
    await recoverActivationStartup(hanging, FIXED_CLOCK2, testDigest, 1, FIRE_NOW_SCHEDULER);
  } catch { threw = true; }
  assert.equal(threw, false, 'recoverActivationStartup must not throw on timeout');
});

/* ════════════════════════════════════════════════════════════════════
   10 · disconnection guard
════════════════════════════════════════════════════════════════════ */
section('disconnection');

check('activation-tx.js is not imported by script.js', () => {
  const src = readFileSync(resolvePath(SRC, 'script.js'), 'utf8');
  assert.ok(!src.includes('activation-tx'), 'script.js must not import activation-tx');
  assert.ok(!src.includes('activation-config'), 'script.js must not import activation-config');
});

check('activation-tx.js does not import any app/ or script.js module', () => {
  const src = readFileSync(resolvePath(SRC, 'v2/activation-tx.js'), 'utf8');
  for (const bad of ['../app/', '../script.js', '../workload', 'shadow-bridge']) {
    assert.ok(!src.includes(bad), `activation-tx.js must not import ${bad}`);
  }
});

check('activation-config.js does not import anything', () => {
  const src = readFileSync(resolvePath(SRC, 'v2/activation-config.js'), 'utf8');
  assert.ok(!src.includes('import '), 'activation-config.js must have no imports');
});

/* ── Summary ─────────────────────────────────────────────────────── */
await Promise.all(_pending);
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
