/**
 * v2-activation-bridge.test.mjs — CP5B suite.
 *
 * Covers:
 *   1 · boot-decision       Exhaustive decision table — every edge case
 *   2 · parity              ALL_RECOVERY_ACTIONS equals actions parsed from
 *                           activation-tx.js source (drift guard)
 *   3 · bridge-disabled     Zero reads/writes/timers/dynamic-imports
 *   4 · bridge-enabled      Every major recovery outcome via injected adapter
 *   5 · boot-wiring         app.init() called iff decision === 'boot-v1';
 *                           shadow diagnostic only after successful init
 *   6 · tasks-lazification  Structural: tasks.js has no eval-time storage.load()
 *   7 · abandoned-import    Import staging rollback then activation recovery
 *
 * Tests use injected adapters — real localStorage is never touched.
 * V2_ACTIVATION_ENABLED is always false; enabled-path tests use opts.enabled.
 *
 * Run with:  node artifacts/home-tasks/tests/v2-activation-bridge.test.mjs
 */

import assert            from 'node:assert/strict';
import { createHash }    from 'node:crypto';
import { readFileSync }  from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootDecision, SAFE_V1_ACTIONS, ALL_RECOVERY_ACTIONS, V2_ACTIVE_RECOVERY_ACTIONS }
  from '../src/v2/activation-boot.js';
import { maybeRecoverActivation }
  from '../src/v2/activation-bridge.js';
import { V2_ACTIVATION_ENABLED }
  from '../src/v2/activation-config.js';
import {
  recoverActivationStartup,
  saveActivationSnapshot,
  ACTIVATION_KEYS, ACTIVATION_SOURCE_KEYS, ACTIVATION_TX_VERSION,
  buildMarker,
}
  from '../src/v2/activation-tx.js';
import { createMemoryAdapter, createFailingAdapter }
  from '../src/v2/storage-adapter.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = resolvePath(HERE, '../src');

/* ── Test harness ─────────────────────────────────────────────── */
let group = '', pass = 0, fail = 0;
const _pending = [];
function check(name, fn) {
  const p = Promise.resolve().then(() => fn()).then(
    ()  => { pass++; },
    (e) => { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); },
  );
  _pending.push(p);
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/* ── Digest ───────────────────────────────────────────────────── */
function testDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ── Adapters ─────────────────────────────────────────────────── */
const TYPICAL_STORE = {
  'hometask-v1':                 FIXTURES.typical.v1TasksRaw,
  'hometask-meta-v1':            FIXTURES.typical.v1MetaRaw,
  'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
};

function makeAdapter(extra = {}) {
  return createMemoryAdapter({ ...TYPICAL_STORE, ...extra });
}

/** Spy adapter: records every read and write. */
function makeSpyAdapter(initial = {}) {
  const base = createMemoryAdapter(initial);
  const reads = [], writes = [];
  return {
    getItem(k)      { reads.push(k); return base.getItem(k); },
    setItem(k, v)   { writes.push({ op: 'set', key: k }); base.setItem(k, v); },
    removeItem(k)   { writes.push({ op: 'remove', key: k }); base.removeItem(k); },
    keys()          { return base.keys(); },
    snapshotAll()   { return base.snapshotAll(); },
    get reads()     { return reads; },
    get writes()    { return writes; },
  };
}

/** Scheduler that fires timeout callbacks synchronously (zero real time). */
function makeFireNowScheduler() {
  let nextId = 0;
  return {
    setTimeout(fn, _ms) { const id = ++nextId; fn(); return id; },
    clearTimeout(_id)   { /* fired already; no-op */ },
  };
}

/** Scheduler that records calls but never fires. */
function makeRecordScheduler() {
  const calls = [];
  return {
    setTimeout(fn, ms) { calls.push({ fn, ms }); return calls.length; },
    clearTimeout(_id)  { /* no-op */ },
    get callCount()    { return calls.length; },
  };
}

/** Adapter whose getItem never resolves (simulates I/O hang for timeout tests). */
function makeHangingAdapter() {
  return {
    getItem()    { return new Promise(() => {}); },
    setItem()    {},
    removeItem() {},
    keys()       { return []; },
    snapshotAll(){ return {}; },
  };
}

/* ── Pre-import activation-tx for enabled-path injection ─────── */
const activationTxMod = await import('../src/v2/activation-tx.js');

/** Standard injected loader for enabled-path bridge tests. */
const injectLoader = async (_spec) => activationTxMod;

/* ── Staging helpers ──────────────────────────────────────────── */
async function seedStagingRecord(adapter, txState) {
  await saveActivationSnapshot(adapter, '2026-08-09T00:00:00.000Z', 0);
  const record = {
    txVersion: ACTIVATION_TX_VERSION,
    txState,
    savedAt: '2026-08-09T00:00:00.000Z',
    sourceKeys: [...ACTIVATION_SOURCE_KEYS],
  };
  adapter.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify(record));
}

async function seedV2Written(adapter) {
  await saveActivationSnapshot(adapter, '2026-08-09T00:00:00.000Z', 0);
  // Write plausible v2 data so DATA key exists.
  adapter.setItem(ACTIVATION_KEYS.DATA, JSON.stringify({ schemaVersion: 2, tasks: [] }));
  const record = {
    txVersion: ACTIVATION_TX_VERSION,
    txState: 'v2_written',
    savedAt: '2026-08-09T00:00:00.000Z',
    sourceKeys: [...ACTIVATION_SOURCE_KEYS],
  };
  adapter.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify(record));
}

/**
 * Build a committed adapter: write v2 DATA + a valid MARKER.
 * Uses buildMarker which is exported from activation-tx.js.
 */
async function seedCommittedAdapter() {
  const adapter = makeAdapter();
  // Take a snapshot first.
  await saveActivationSnapshot(adapter, '2026-08-09T00:00:00.000Z', 0);
  // Write v2 data.
  const v2Data = JSON.stringify({ schemaVersion: 2, tasks: [], meta: {}, recents: [] });
  adapter.setItem(ACTIVATION_KEYS.DATA, v2Data);
  // Build and write a valid marker.
  const enc = new TextEncoder().encode(v2Data);
  const digest = await testDigest(enc);
  const marker = buildMarker({ v2DataStr: v2Data, v2DataDigest: digest,
    committedAt: '2026-08-09T00:00:00.000Z' });
  adapter.setItem(ACTIVATION_KEYS.MARKER, JSON.stringify(marker));
  return adapter;
}

/* ════════════════════════════════════════════════════════════════
   1 · boot-decision — exhaustive decision table
════════════════════════════════════════════════════════════════ */
section('boot-decision — null / undefined / non-object');

check('null → indeterminate', () => {
  assert.equal(bootDecision(null), 'indeterminate');
});
check('undefined → indeterminate', () => {
  assert.equal(bootDecision(undefined), 'indeterminate');
});
check('empty object {} → indeterminate', () => {
  assert.equal(bootDecision({}), 'indeterminate');
});
check('array [] → indeterminate', () => {
  assert.equal(bootDecision([]), 'indeterminate');
});
check('number 0 → indeterminate', () => {
  assert.equal(bootDecision(0), 'indeterminate');
});
check('string "disabled" → indeterminate', () => {
  assert.equal(bootDecision('disabled'), 'indeterminate');
});

section('boot-decision — unknown / missing status');

check('{ status:"unknown" } → indeterminate', () => {
  assert.equal(bootDecision({ status: 'unknown' }), 'indeterminate');
});
check('{ status:"failed", error:"oops" } → indeterminate', () => {
  assert.equal(bootDecision({ status: 'failed', error: 'oops' }), 'indeterminate');
});
check('{ v2Active:false } (no status) → indeterminate', () => {
  assert.equal(bootDecision({ v2Active: false }), 'indeterminate');
});
check('{ action:"none", v2Active:false } (no status) → indeterminate', () => {
  assert.equal(bootDecision({ action: 'none', v2Active: false }), 'indeterminate');
});

section('boot-decision — disabled path (exact / forged)');

check('exact { status:"disabled" } → boot-v1', () => {
  assert.equal(bootDecision({ status: 'disabled' }), 'boot-v1');
});
check('{ status:"disabled", v2Active:true } → indeterminate (forged authority)', () => {
  assert.equal(bootDecision({ status: 'disabled', v2Active: true }), 'indeterminate');
});
check('{ status:"disabled", v2Active:false } → indeterminate (extra authority field)', () => {
  assert.equal(bootDecision({ status: 'disabled', v2Active: false }), 'indeterminate');
});
check('{ status:"disabled", action:"none" } → indeterminate (extra authority field)', () => {
  assert.equal(bootDecision({ status: 'disabled', action: 'none' }), 'indeterminate');
});

section('boot-decision — committed-verified');

check('committed-verified + v2Active:true → v2-authoritative', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'committed-verified', v2Active: true }),
    'v2-authoritative');
});
check('committed-verified + v2Active:false → indeterminate (contradictory)', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'committed-verified', v2Active: false }),
    'indeterminate');
});
check('committed-verified + v2Active absent → indeterminate', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'committed-verified' }),
    'indeterminate');
});

section('boot-decision — ambiguous-state');

check('ambiguous-state + v2Active:false → ambiguous', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'ambiguous-state', v2Active: false }),
    'ambiguous');
});
check('ambiguous-state + v2Active:true → indeterminate (contradictory)', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'ambiguous-state', v2Active: true }),
    'indeterminate');
});
check('ambiguous-state + v2Active absent → indeterminate', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'ambiguous-state' }),
    'indeterminate');
});

section('boot-decision — ok + missing or unknown action');

check('{ status:"ok", v2Active:false } (no action) → indeterminate', () => {
  assert.equal(bootDecision({ status: 'ok', v2Active: false }), 'indeterminate');
});
check('{ status:"ok", action:null, v2Active:false } → indeterminate', () => {
  assert.equal(bootDecision({ status: 'ok', action: null, v2Active: false }), 'indeterminate');
});
check('{ status:"ok", action:"future-unknown-action", v2Active:false } → indeterminate', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'future-unknown-action', v2Active: false }),
    'indeterminate');
});
check('{ status:"ok", action:"future-unknown-action", v2Active:true } → indeterminate', () => {
  assert.equal(bootDecision({ status: 'ok', action: 'future-unknown-action', v2Active: true }),
    'indeterminate');
});

section('boot-decision — every safe-v1 action with v2Active:false → boot-v1');

for (const action of SAFE_V1_ACTIONS) {
  check(`action:"${action}" + v2Active:false → boot-v1`, () => {
    assert.equal(bootDecision({ status: 'ok', action, v2Active: false }), 'boot-v1');
  });
}

section('boot-decision — every safe-v1 action with v2Active:true → indeterminate');

for (const action of SAFE_V1_ACTIONS) {
  check(`action:"${action}" + v2Active:true → indeterminate`, () => {
    assert.equal(bootDecision({ status: 'ok', action, v2Active: true }), 'indeterminate');
  });
}

/* ════════════════════════════════════════════════════════════════
   2 · parity — ALL_RECOVERY_ACTIONS equals activation-tx.js source
════════════════════════════════════════════════════════════════ */
section('parity — activation-tx.js source vs ALL_RECOVERY_ACTIONS');

check('ALL_RECOVERY_ACTIONS exactly covers every return action in activation-tx.js', () => {
  const txSource = readFileSync(resolvePath(SRC, 'v2/activation-tx.js'), 'utf8');

  // Extract every literal action string: action: 'value' or action: "value"
  const literalRe = /\baction:\s*['"]([^'"]+)['"]/g;
  const extracted = new Set();
  let m;
  while ((m = literalRe.exec(txSource)) !== null) extracted.add(m[1]);

  // Handle the one template literal: action: `recovered-${staging.txState}`
  // The template literal is an inherent limit of static-string analysis.
  // We enumerate the 3 known expansion values and verify each corresponding
  // switch case label is present in the source file — any addition must be
  // classified here or it appears as an extra in the diff below.
  const templateIdx = txSource.indexOf('`recovered-${staging.txState}`');
  assert.ok(templateIdx !== -1,
    'Expected template literal `recovered-${staging.txState}` not found in activation-tx.js');

  // The case labels that fall through to the template literal return.
  const RECOVERED_TX_STATES = ['v2_written', 'source_changed', 'rollback_failed'];
  for (const state of RECOVERED_TX_STATES) {
    assert.ok(txSource.includes(`case '${state}':`),
      `case '${state}': must exist in activation-tx.js switch block`);
    extracted.add(`recovered-${state}`);
  }

  // Assert exact set equality — any new action in source will appear in `extra`.
  const extra   = [...extracted].filter(a => !ALL_RECOVERY_ACTIONS.has(a));
  const missing = [...ALL_RECOVERY_ACTIONS].filter(a => !extracted.has(a));

  assert.deepEqual(extra, [],
    `activation-tx.js has actions not in ALL_RECOVERY_ACTIONS — classify them: ${extra.join(', ')}`);
  assert.deepEqual(missing, [],
    `ALL_RECOVERY_ACTIONS has entries with no return path in activation-tx.js: ${missing.join(', ')}`);
  assert.equal(ALL_RECOVERY_ACTIONS.size, extracted.size);
});

check('SAFE_V1_ACTIONS ∪ V2_ACTIVE_RECOVERY_ACTIONS ∪ {ambiguous-state} === ALL_RECOVERY_ACTIONS', () => {
  // B1: V2_ACTIVE_RECOVERY_ACTIONS replaces the bare {'committed-verified'} literal to
  // cover legacy-committed and mutation-recovered-* paths added in CP5C-B1.
  const union = new Set([...SAFE_V1_ACTIONS, ...V2_ACTIVE_RECOVERY_ACTIONS, 'ambiguous-state']);
  assert.equal(union.size, ALL_RECOVERY_ACTIONS.size,
    `size mismatch: union=${union.size}, ALL_RECOVERY_ACTIONS=${ALL_RECOVERY_ACTIONS.size}`);
  for (const a of union)               assert.ok(ALL_RECOVERY_ACTIONS.has(a), `missing from ALL: ${a}`);
  for (const a of ALL_RECOVERY_ACTIONS) assert.ok(union.has(a), `extra in ALL: ${a}`);
});

check('SAFE_V1_ACTIONS does not contain any V2_ACTIVE or ambiguous-state action', () => {
  assert.ok(!SAFE_V1_ACTIONS.has('ambiguous-state'));
  for (const a of V2_ACTIVE_RECOVERY_ACTIONS) {
    assert.ok(!SAFE_V1_ACTIONS.has(a), `SAFE_V1_ACTIONS must not contain v2-active action: ${a}`);
  }
});

check('V2_ACTIVE_RECOVERY_ACTIONS does not contain any SAFE_V1 or ambiguous-state action', () => {
  assert.ok(!V2_ACTIVE_RECOVERY_ACTIONS.has('ambiguous-state'));
  for (const a of SAFE_V1_ACTIONS) {
    assert.ok(!V2_ACTIVE_RECOVERY_ACTIONS.has(a), `V2_ACTIVE must not contain safe-v1 action: ${a}`);
  }
});

/* ════════════════════════════════════════════════════════════════
   3 · bridge-disabled — zero side effects
════════════════════════════════════════════════════════════════ */
section('bridge-disabled — zero side effects');

check('V2_ACTIVATION_ENABLED is false (committed flag)', () => {
  assert.equal(V2_ACTIVATION_ENABLED, false);
});

check('default call returns { status:"disabled" } exactly', async () => {
  const result = await maybeRecoverActivation();
  assert.deepEqual(result, { status: 'disabled' });
});

check('disabled path never calls _loadModule (zero dynamic imports)', async () => {
  let called = false;
  const trap = () => { called = true; return {}; };
  const result = await maybeRecoverActivation({ enabled: false, _loadModule: trap });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(called, false, 'disabled path must not invoke dynamic loader');
});

check('disabled path performs zero storage reads or writes', async () => {
  const spy = makeSpyAdapter();
  await maybeRecoverActivation({ enabled: false, adapter: spy });
  assert.equal(spy.reads.length,  0, 'no reads on disabled path');
  assert.equal(spy.writes.length, 0, 'no writes on disabled path');
});

check('disabled path registers zero timers', async () => {
  const sched = makeRecordScheduler();
  await maybeRecoverActivation({ enabled: false, scheduler: sched });
  assert.equal(sched.callCount, 0, 'no timers on disabled path');
});

/* ════════════════════════════════════════════════════════════════
   4 · bridge-enabled — recovery outcomes via injected adapter
════════════════════════════════════════════════════════════════ */
section('bridge-enabled — clean storage → none');

check('clean adapter → { status:"ok", action:"none", v2Active:false }', async () => {
  const adapter = makeAdapter();
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  assert.equal(result.status,   'ok');
  assert.equal(result.action,   'none');
  assert.equal(result.v2Active, false);
});

section('bridge-enabled — staged state → cleaned-staged');

check('staged adapter → { status:"ok", action:"cleaned-staged", v2Active:false }', async () => {
  const adapter = makeAdapter();
  await seedStagingRecord(adapter, 'staged');
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  assert.equal(result.status,   'ok');
  assert.equal(result.action,   'cleaned-staged');
  assert.equal(result.v2Active, false);
  // Staging key removed after cleanup.
  assert.equal(adapter.snapshotAll()[ACTIVATION_KEYS.STAGING], undefined);
});

section('bridge-enabled — v2_written, v1 matches snapshot → recovered-v2_written');

check('v2_written + v1 matches → { action:"recovered-v2_written", v2Active:false }', async () => {
  const adapter = makeAdapter();
  await seedV2Written(adapter);
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  assert.equal(result.status,   'ok');
  assert.equal(result.action,   'recovered-v2_written');
  assert.equal(result.v2Active, false);
  // DATA quarantined (DATA key removed).
  assert.equal(adapter.snapshotAll()[ACTIVATION_KEYS.DATA], undefined);
  // v1 source keys untouched.
  assert.equal(adapter.snapshotAll()['hometask-v1'], TYPICAL_STORE['hometask-v1']);
});

section('bridge-enabled — v2_written, v1 mutated → source-changed-on-recovery');

check('v2_written + v1 mutated → { action:"source-changed-on-recovery", v2Active:false }', async () => {
  const adapter = makeAdapter();
  await seedV2Written(adapter);
  // Mutate v1 after snapshot was taken — simulates concurrent write.
  adapter.setItem('hometask-v1', JSON.stringify([{ id: 'mutated', title: 'Mutated' }]));
  const mutatedV1 = adapter.snapshotAll()['hometask-v1'];
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  assert.equal(result.status,   'ok');
  assert.equal(result.action,   'source-changed-on-recovery');
  assert.equal(result.v2Active, false);
  // Newer v1 retained byte-for-byte.
  assert.equal(adapter.snapshotAll()['hometask-v1'], mutatedV1);
});

section('bridge-enabled — exception → status:failed');

/*
 * NOTE: recoverActivationStartup() catches ALL adapter-level errors internally
 * and returns a structured { action, v2Active } result — it is designed to be
 * fail-safe, never reject. So a failing adapter produces status:'ok' (e.g.
 * action:'none') rather than status:'failed'.
 *
 * The bridge's status:'failed' path is only triggered by bridge-level failures:
 *   a) opts._loadModule() rejects (the dynamic-import guard)
 *   b) an exception that escapes the recoverActivationStartup call entirely
 *      (which does not happen in practice given its internal try/catches)
 *
 * We test both the _loadModule failure path and the graceful-adapter-failure path.
 */

check('_loadModule rejection → { status:"failed", error:string }', async () => {
  const result = await maybeRecoverActivation({
    enabled: true,
    adapter: makeAdapter(),
    digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z',
    _loadModule: async () => { throw new Error('module load failed'); },
  });
  assert.equal(result.status, 'failed');
  assert.ok(typeof result.error === 'string' && result.error.length > 0,
    'error must be a non-empty string');
  assert.ok(result.error.includes('module load failed'),
    `error should reference the load failure; got: ${result.error}`);
});

check('bridge never rejects — _loadModule failure is caught and returned', async () => {
  let threw = false;
  try {
    await maybeRecoverActivation({
      enabled: true,
      adapter: makeAdapter(),
      digestFn: testDigest,
      clock: '2026-08-09T00:00:00.000Z',
      _loadModule: async () => { throw new Error('boom'); },
    });
  } catch { threw = true; }
  assert.equal(threw, false, 'maybeRecoverActivation must never reject');
});

check('adapter throws on getItem → recoverActivationStartup handles internally → status:ok', async () => {
  // recoverActivationStartup has internal try/catch on all adapter operations.
  // A failing adapter produces a valid structured result, not status:'failed'.
  const failing = createFailingAdapter(makeAdapter(), [{ op: 'get', afterCalls: 0 }]);
  const result = await maybeRecoverActivation({
    enabled: true, adapter: failing, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  // Adapter failures are caught internally; the result is still 'ok'.
  assert.equal(result.status, 'ok', 'adapter failures are handled gracefully; status must be ok');
  assert.ok(typeof result.action   === 'string',  'action must be present');
  assert.ok(typeof result.v2Active === 'boolean', 'v2Active must be present');
});

section('bridge-enabled — timeout → graceful handling');

/*
 * recoverActivationStartup() wraps every adapter operation with withTimeout().
 * When the timeout fires, the per-operation await rejects (caught internally),
 * so the function recovers and returns a structured result rather than throwing.
 * Result is 'ok' with action:'none' (marker=null, staging=null → clean path).
 */
check('hanging adapter + fire-now scheduler → graceful ok result (not failed)', async () => {
  const result = await maybeRecoverActivation({
    enabled: true, adapter: makeHangingAdapter(), digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
    timeoutMs: 1, scheduler: makeFireNowScheduler(),
  });
  // Internal timeouts are caught; bridge returns ok rather than failed.
  assert.equal(result.status, 'ok',
    `expected graceful ok result on timeout; got: ${result.status} ${result.error ?? ''}`);
  assert.ok(typeof result.v2Active === 'boolean', 'v2Active must be a boolean');
});

section('bridge-enabled — result shape invariants');

check('status is always one of disabled|ok|failed (never undefined)', async () => {
  const result = await maybeRecoverActivation({ enabled: false });
  assert.ok(['disabled', 'ok', 'failed'].includes(result.status));
});

check('status:ok result has action (string), v2Active (boolean), detail (string|null)', async () => {
  const adapter = makeAdapter();
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  assert.equal(result.status, 'ok');
  assert.ok(typeof result.action   === 'string',  'action must be a string');
  assert.ok(typeof result.v2Active === 'boolean', 'v2Active must be a boolean');
  assert.ok(result.detail === null || typeof result.detail === 'string',
    'detail must be string or null');
});

check('bridge status field cannot be overwritten by internal result fields', async () => {
  // The bridge builds the return object explicitly; spreading result.action='status' etc
  // must not overwrite the outer status field.
  const adapter = makeAdapter();
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  // Only valid statuses are allowed — no internal field can write 'status'.
  assert.ok(['ok', 'disabled', 'failed'].includes(result.status));
});

/* ════════════════════════════════════════════════════════════════
   5 · boot-wiring — app.init() called iff decision === 'boot-v1'
════════════════════════════════════════════════════════════════ */
section('boot-wiring — app.init call discipline');

/**
 * Synthetic boot: replicates the _boot() pattern in script.js.
 * Returns { decision, initCalled, shadowCalled }.
 */
function syntheticBoot(recoveryResult) {
  const decision = bootDecision(recoveryResult);
  let initCalled = false, shadowCalled = false;
  if (decision === 'boot-v1') {
    initCalled = true;
    shadowCalled = true;   // startShadowDiagnostic runs after successful init
  }
  return { decision, initCalled, shadowCalled };
}

check('disabled result → boot-v1 → init called, shadow called', () => {
  const { decision, initCalled, shadowCalled } = syntheticBoot({ status: 'disabled' });
  assert.equal(decision, 'boot-v1');
  assert.equal(initCalled,   true);
  assert.equal(shadowCalled, true);
});

// All 12 safe-v1 actions should call init.
for (const action of SAFE_V1_ACTIONS) {
  check(`safe-v1 action "${action}" → boot-v1 → init called`, () => {
    const { decision, initCalled } = syntheticBoot({ status: 'ok', action, v2Active: false });
    assert.equal(decision,  'boot-v1');
    assert.equal(initCalled, true);
  });
}

check('committed-verified → v2-authoritative → init NOT called, shadow NOT called', () => {
  const { decision, initCalled, shadowCalled } =
    syntheticBoot({ status: 'ok', action: 'committed-verified', v2Active: true });
  assert.equal(decision, 'v2-authoritative');
  assert.equal(initCalled,   false);
  assert.equal(shadowCalled, false);
});

check('ambiguous-state → ambiguous → init NOT called', () => {
  const { decision, initCalled } =
    syntheticBoot({ status: 'ok', action: 'ambiguous-state', v2Active: false });
  assert.equal(decision, 'ambiguous');
  assert.equal(initCalled, false);
});

check('failed result → indeterminate → init NOT called', () => {
  const { decision, initCalled } =
    syntheticBoot({ status: 'failed', error: 'timeout' });
  assert.equal(decision, 'indeterminate');
  assert.equal(initCalled, false);
});

check('null result → indeterminate → init NOT called', () => {
  const { decision, initCalled } = syntheticBoot(null);
  assert.equal(decision, 'indeterminate');
  assert.equal(initCalled, false);
});

check('forged { status:"disabled", v2Active:true } → indeterminate → init NOT called', () => {
  const { decision, initCalled } =
    syntheticBoot({ status: 'disabled', v2Active: true });
  assert.equal(decision, 'indeterminate');
  assert.equal(initCalled, false);
});

check('all unsafe decisions produce initCalled:false (exhaustive)', () => {
  const unsafe = [
    { status: 'ok', action: 'committed-verified', v2Active: true },
    { status: 'ok', action: 'ambiguous-state',    v2Active: false },
    { status: 'failed', error: 'oops' },
    null,
    undefined,
    {},
    { status: 'disabled', v2Active: true },
    { status: 'disabled', action: 'none' },
    { status: 'ok', action: 'none', v2Active: true },
    { status: 'ok' },
  ];
  for (const r of unsafe) {
    const { initCalled, decision } = syntheticBoot(r);
    assert.equal(initCalled, false,
      `Expected initCalled:false for ${JSON.stringify(r)}, decision:${decision}`);
  }
});

check('shadow diagnostic NOT called when decision !== boot-v1', () => {
  const unsafeResults = [
    { status: 'ok', action: 'committed-verified', v2Active: true },
    { status: 'ok', action: 'ambiguous-state',    v2Active: false },
    { status: 'failed', error: 'oops' },
  ];
  for (const r of unsafeResults) {
    const { shadowCalled } = syntheticBoot(r);
    assert.equal(shadowCalled, false, `Shadow must not fire for: ${JSON.stringify(r)}`);
  }
});

/* Bridge integration boot-wiring: disabled path produces boot-v1 end-to-end. */
check('disabled bridge + bootDecision → boot-v1 (integration)', async () => {
  const result = await maybeRecoverActivation({ enabled: false });
  const decision = bootDecision(result);
  assert.equal(decision, 'boot-v1');
});

check('enabled bridge with clean storage + bootDecision → boot-v1 (integration)', async () => {
  const adapter = makeAdapter();
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });
  const decision = bootDecision(result);
  assert.equal(decision, 'boot-v1');
  const { initCalled } = syntheticBoot(result);
  assert.equal(initCalled, true);
});

check('failed bridge result + bootDecision → indeterminate (integration)', async () => {
  // Use _loadModule rejection to produce status:'failed' from the bridge.
  const result = await maybeRecoverActivation({
    enabled: true, adapter: makeAdapter(), digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z',
    _loadModule: async () => { throw new Error('injected load failure'); },
  });
  assert.equal(result.status, 'failed');
  const decision = bootDecision(result);
  assert.equal(decision, 'indeterminate');
  const { initCalled } = syntheticBoot(result);
  assert.equal(initCalled, false);
});

/* ════════════════════════════════════════════════════════════════
   6 · tasks-lazification — structural checks (no production API changes)
════════════════════════════════════════════════════════════════ */
section('tasks-lazification — structural');

const tasksSource = readFileSync(resolvePath(SRC, 'app/tasks.js'), 'utf8');

check('tasks.js contains _ensureLoaded function', () => {
  assert.ok(tasksSource.includes('function _ensureLoaded()'),
    'tasks.js must define _ensureLoaded()');
});

check('_repo.loadTasks() appears exactly once in tasks.js (inside _ensureLoaded only)', () => {
  // CP5C-A2.1: tasks.js now uses _repo.loadTasks() instead of storage.load().
  // storage.load() must be gone entirely; _repo.loadTasks() must be present once, inside _ensureLoaded.
  const storageMatches = [...tasksSource.matchAll(/storage\.load\(\)/g)];
  assert.equal(storageMatches.length, 0,
    `storage.load() must not appear in tasks.js after repo wiring; found ${storageMatches.length}`);
  const repoMatches = [...tasksSource.matchAll(/_repo\.loadTasks\(\)/g)];
  assert.equal(repoMatches.length, 1,
    `_repo.loadTasks() must appear exactly once; found ${repoMatches.length}`);
  // That one occurrence must be inside _ensureLoaded.
  const ensureIdx = tasksSource.indexOf('function _ensureLoaded()');
  const loadIdx   = tasksSource.indexOf('_repo.loadTasks()');
  assert.ok(ensureIdx !== -1, '_ensureLoaded not found');
  assert.ok(loadIdx > ensureIdx && loadIdx < ensureIdx + 120,
    '_repo.loadTasks() must appear within _ensureLoaded body');
});

check('"let _items = storage.load()" does NOT appear in tasks.js (eval-time read removed)', () => {
  assert.ok(!tasksSource.includes('let _items = storage.load()'),
    'eval-time storage.load() must not appear in tasks.js after lazification');
});

check('"let _items = null" DOES appear in tasks.js (lazy init present)', () => {
  assert.ok(tasksSource.includes('let _items = null'),
    'tasks.js must initialise _items to null');
});

check('every function that accesses _items calls _ensureLoaded() first', () => {
  // For each checked function, verify _ensureLoaded() appears as the first
  // non-comment statement in the function body.
  // CP5C-A2.1: _byId() was renamed to _find() during the repo wiring.
  const CHECKED = ['getAll', '_find', 'markDone', 'skipToday', 'skipWeek', 'applyBaseline'];
  for (const fn of CHECKED) {
    // Match the function declaration and capture up to the first statement.
    const fnRe = new RegExp(`function ${fn}\\s*\\([^)]*\\)\\s*\\{([^}]{1,200})`);
    const m = fnRe.exec(tasksSource);
    assert.ok(m, `function ${fn} not found in tasks.js`);
    const body = m[1].replace(/\/\/[^\n]*/g, '').trimStart();
    assert.ok(body.startsWith('_ensureLoaded()'),
      `${fn}() must call _ensureLoaded() as its first statement; got: ${body.slice(0, 60)}`);
  }
});

/* ════════════════════════════════════════════════════════════════
   7 · abandoned-import + activation-recovery
════════════════════════════════════════════════════════════════ */
section('abandoned-import + activation-recovery');

/**
 * Scenario:
 *   - Activation snapshot was taken against PRE_V1 bytes.
 *   - An import staging rollback fires at startup (A), restoring POST_V1 bytes
 *     (which differ from PRE_V1 — the rollback went to an older version).
 *   - Activation recovery (B) fingerprints POST_V1 (the current state).
 *   - Fingerprint mismatch → source-changed-on-recovery.
 *   - POST_V1 bytes retained; no authority marker written.
 */
check('rollback changes v1 → activation sees mismatch → source-changed-on-recovery', async () => {
  const PRE_V1  = FIXTURES.typical.v1TasksRaw;      // bytes when snapshot was taken
  const POST_V1 = FIXTURES.partial.v1TasksRaw;      // bytes after import rollback

  // Build adapter with PRE_V1 in place when snapshot was taken.
  const adapter = createMemoryAdapter({
    'hometask-v1':                 PRE_V1,
    'hometask-meta-v1':            FIXTURES.typical.v1MetaRaw,
    'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
  });

  // Take the activation snapshot (captures PRE_V1).
  await saveActivationSnapshot(adapter, '2026-08-09T00:00:00.000Z', 0);

  // Write plausible v2 DATA and staging record (v2_written state).
  adapter.setItem(ACTIVATION_KEYS.DATA, JSON.stringify({ schemaVersion: 2, tasks: [] }));
  adapter.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION,
    txState: 'v2_written',
    savedAt: '2026-08-09T00:00:00.000Z',
    sourceKeys: [...ACTIVATION_SOURCE_KEYS],
  }));

  // Simulate startup.js IIFE rollback: v1 is now POST_V1 (different from snapshot).
  adapter.setItem('hometask-v1', POST_V1);

  // Run activation recovery (step B).
  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });

  assert.equal(result.status,   'ok');
  assert.equal(result.action,   'source-changed-on-recovery');
  assert.equal(result.v2Active, false);
});

check('post-rollback v1 bytes retained byte-for-byte', async () => {
  const PRE_V1  = FIXTURES.typical.v1TasksRaw;
  const POST_V1 = FIXTURES.partial.v1TasksRaw;

  const adapter = createMemoryAdapter({
    'hometask-v1': PRE_V1,
    'hometask-meta-v1': FIXTURES.typical.v1MetaRaw,
    'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
  });
  await saveActivationSnapshot(adapter, '2026-08-09T00:00:00.000Z', 0);
  adapter.setItem(ACTIVATION_KEYS.DATA, '{"schemaVersion":2}');
  adapter.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'v2_written',
    savedAt: '2026-08-09T00:00:00.000Z', sourceKeys: [...ACTIVATION_SOURCE_KEYS],
  }));
  adapter.setItem('hometask-v1', POST_V1);  // simulate rollback

  await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });

  // POST_V1 must be retained byte-for-byte.
  assert.equal(adapter.snapshotAll()['hometask-v1'], POST_V1);
});

check('authority marker is NOT written after source-changed-on-recovery', async () => {
  const adapter = createMemoryAdapter({
    'hometask-v1': FIXTURES.typical.v1TasksRaw,
    'hometask-meta-v1': FIXTURES.typical.v1MetaRaw,
    'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
  });
  await saveActivationSnapshot(adapter, '2026-08-09T00:00:00.000Z', 0);
  adapter.setItem(ACTIVATION_KEYS.DATA, '{"schemaVersion":2}');
  adapter.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'v2_written',
    savedAt: '2026-08-09T00:00:00.000Z', sourceKeys: [...ACTIVATION_SOURCE_KEYS],
  }));
  // Rollback makes v1 differ from snapshot.
  adapter.setItem('hometask-v1', FIXTURES.empty.v1TasksRaw);

  await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });

  assert.equal(adapter.snapshotAll()[ACTIVATION_KEYS.MARKER], undefined,
    'MARKER must not be written on source-changed-on-recovery');
});

check('boot decision after source-changed-on-recovery → boot-v1 (v1 authoritative)', async () => {
  const adapter = createMemoryAdapter({
    'hometask-v1': FIXTURES.typical.v1TasksRaw,
    'hometask-meta-v1': FIXTURES.typical.v1MetaRaw,
    'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
  });
  await saveActivationSnapshot(adapter, '2026-08-09T00:00:00.000Z', 0);
  adapter.setItem(ACTIVATION_KEYS.DATA, '{"schemaVersion":2}');
  adapter.setItem(ACTIVATION_KEYS.STAGING, JSON.stringify({
    txVersion: ACTIVATION_TX_VERSION, txState: 'v2_written',
    savedAt: '2026-08-09T00:00:00.000Z', sourceKeys: [...ACTIVATION_SOURCE_KEYS],
  }));
  adapter.setItem('hometask-v1', FIXTURES.partial.v1TasksRaw);

  const result = await maybeRecoverActivation({
    enabled: true, adapter, digestFn: testDigest,
    clock: '2026-08-09T00:00:00.000Z', _loadModule: injectLoader,
  });

  assert.equal(bootDecision(result), 'boot-v1');
});

check('no activation keys created on disabled path (V2_ACTIVATION_ENABLED=false)', async () => {
  const spy = makeSpyAdapter({});
  await maybeRecoverActivation({ enabled: false, adapter: spy });
  const activationKeys = Object.values(ACTIVATION_KEYS);
  const writtenActivation = spy.writes.filter(w => activationKeys.includes(w.key));
  assert.equal(writtenActivation.length, 0,
    `activation keys written on disabled path: ${writtenActivation.map(w=>w.key).join(', ')}`);
  // Verify via snapshotAll too.
  const snap = spy.snapshotAll();
  for (const k of activationKeys) {
    assert.equal(snap[k], undefined, `${k} must not exist after disabled-path run`);
  }
});

/* ── Summary ──────────────────────────────────────────────────── */
await Promise.all(_pending);
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
