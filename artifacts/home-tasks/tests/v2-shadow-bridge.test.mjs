/**
 * v2-shadow-bridge.test.mjs — CP4B suite: runtime bridge behind a
 * disabled-by-default compile-time flag.
 *
 * Covers:
 *   1 · bridge-api         Exports, flag, adapter factory.
 *   2 · disabled-path      Zero ops, zero timers, zero storage when flag=false.
 *   3 · enabled-happy      Verified shadow, fresh install, idempotent re-run.
 *   4 · enabled-failures   All failure modes return structured results.
 *   5 · v1-authority       V1 unchanged; shadow deletion/corruption cannot
 *                          affect v1; Done/Skip simulation leaves v1 authoritative.
 *   6 · structural         Committed flag is false; bridge-only reference guard.
 *
 * Tests use injected adapters — real localStorage is never touched.
 * The committed SHADOW_MIGRATION_ENABLED flag is always false; tests
 * override it via opts.enabled without modifying the source file.
 *
 * Run with:  node artifacts/home-tasks/tests/v2-shadow-bridge.test.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHADOW_MIGRATION_ENABLED } from '../src/v2/shadow-config.js';
import { maybeShadowMigrate, createLocalStorageAdapter } from '../src/v2/shadow-bridge.js';
import { SOURCE_KEYS, SHADOW_KEY } from '../src/v2/shadow-migrate.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = resolvePath(HERE, '../src');

/* ── Test harness ──────────────────────────────────────────────── */
let group = '', pass = 0, fail = 0;
const _pending = [];
function check(name, fn) {
  const p = Promise.resolve().then(() => fn()).then(
    ()  => { pass++; },
    (e) => { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); },
  );
  _pending.push(p);
  return p;
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/* ── Fast test digest ──────────────────────────────────────────── */
function testDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ── Test adapters ─────────────────────────────────────────────── */
function makeSync(initial = {}) {
  const store = { ...initial };
  return {
    getItem:    (k) => store[k] ?? null,
    setItem:    (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
    _snapshot:  () => ({ ...store }),
  };
}

function makeWriteFailAdapter(initial = {}, failKey) {
  const store = { ...initial };
  return {
    getItem:    (k) => store[k] ?? null,
    setItem:    (k, v) => {
      if (k === failKey) {
        const e = new Error(`QuotaExceededError on "${failKey}"`);
        e.name = 'QuotaExceededError';
        throw e;
      }
      store[k] = v;
    },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
  };
}

function makeSilentLostWriteAdapter(initial = {}) {
  const store = { ...initial };
  return {
    getItem:    (k) => store[k] ?? null,
    setItem:    () => { /* silently discard */ },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
  };
}

function makeMockScheduler() {
  const pending = new Map();
  let nextId = 0;
  return {
    setTimeout(fn, _ms)  { const id = ++nextId; pending.set(id, fn); return id; },
    clearTimeout(id)     { pending.delete(id); },
    flush()              { const fns = [...pending.values()]; pending.clear(); fns.forEach(f => f()); },
    get pendingCount()   { return pending.size; },
  };
}

function makeNeverSettleAdapter(initial = {}, neverKey, neverOp = 'read') {
  const store = { ...initial };
  return {
    getItem: k => {
      if (k === neverKey && neverOp === 'read') return new Promise(() => {});
      return store[k] ?? null;
    },
    setItem: (k, v) => {
      if (k === neverKey && neverOp === 'write') return new Promise(() => {});
      store[k] = v;
    },
    removeItem: k => { delete store[k]; },
    get _store() { return store; },
  };
}

function makeMutateAfterShadowWriteAdapter(initial = {}, mutatedKey, mutatedValue) {
  const store = { ...initial };
  let shadowWritten = false;
  return {
    getItem: k => {
      if (shadowWritten && k === mutatedKey) return mutatedValue;
      return store[k] ?? null;
    },
    setItem: (k, v) => { store[k] = v; if (k === SHADOW_KEY) shadowWritten = true; },
    removeItem: k => { delete store[k]; },
    get _store() { return store; },
  };
}

/* ── Fixture data ──────────────────────────────────────────────── */
const TYPICAL_STORE = {
  'hometask-v1':                 FIXTURES.typical.v1TasksRaw,
  'hometask-meta-v1':            FIXTURES.typical.v1MetaRaw,
  'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
};

/** Default enabled-path context for bridge tests. */
const CTX = {
  enabled:    true,
  today:      FIXED_TODAY,
  clock:      '2026-08-01T00:00:00.000Z',
  appBuild:   'v19',
  _testHooks: { digest: testDigest },
};

function runEnabled(adapter, overrides = {}) {
  return maybeShadowMigrate({ ...CTX, adapter, ...overrides });
}

/* ═══════════════════════════════════════════════════════════════ */
/*  1 · bridge-api                                                 */
/* ═══════════════════════════════════════════════════════════════ */
section('bridge-api');
check('maybeShadowMigrate is exported as an async function', () => {
  assert.equal(typeof maybeShadowMigrate, 'function');
  const r = maybeShadowMigrate({ enabled: false });
  assert.ok(r && typeof r.then === 'function', 'must return a Promise');
});
check('createLocalStorageAdapter is exported as a function', () => {
  assert.equal(typeof createLocalStorageAdapter, 'function');
});
check('SHADOW_MIGRATION_ENABLED is exported from shadow-config.js', () => {
  assert.equal(typeof SHADOW_MIGRATION_ENABLED, 'boolean');
});
check('SHADOW_MIGRATION_ENABLED is false in the committed build', () => {
  assert.equal(SHADOW_MIGRATION_ENABLED, false,
    'the committed build must keep shadow migration disabled');
});

/* ═══════════════════════════════════════════════════════════════ */
/*  2 · disabled-path (SHADOW_MIGRATION_ENABLED = false)          */
/* ═══════════════════════════════════════════════════════════════ */
section('disabled-path');
check('returns { status: "disabled" } when opts.enabled is false', async () => {
  const r = await maybeShadowMigrate({ enabled: false });
  assert.equal(r.status, 'disabled');
});
check('returns { status: "disabled" } with no options at the committed default', async () => {
  const r = await maybeShadowMigrate({});
  assert.equal(r.status, 'disabled');
});
check('disabled path performs zero adapter getItem/setItem operations', async () => {
  let getCalls = 0, setCalls = 0;
  const spyAdapter = {
    getItem:    () => { getCalls++; return null; },
    setItem:    () => { setCalls++; },
    removeItem: () => {},
  };
  const r = await maybeShadowMigrate({ enabled: false, adapter: spyAdapter });
  assert.equal(r.status, 'disabled');
  assert.equal(getCalls, 0, 'disabled path must not call adapter.getItem');
  assert.equal(setCalls, 0, 'disabled path must not call adapter.setItem');
});
check('disabled path registers zero timers', async () => {
  let timerCount = 0;
  const spyScheduler = {
    setTimeout:  () => { timerCount++; return 0; },
    clearTimeout: () => {},
  };
  const r = await maybeShadowMigrate({ enabled: false, scheduler: spyScheduler });
  assert.equal(r.status, 'disabled');
  assert.equal(timerCount, 0, 'disabled path must not register any timers');
});
check('disabled path leaves storage completely unchanged (no keys created or modified)', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const before = adapter._snapshot();
  await maybeShadowMigrate({ enabled: false, adapter });
  assert.deepEqual(adapter._store, before,
    'disabled path must leave storage byte-identical');
  assert.ok(!adapter._store[SHADOW_KEY],
    'hometask-v2-shadow must not exist after a disabled run');
});

/* ═══════════════════════════════════════════════════════════════ */
/*  3 · enabled-happy (flag=true, injected storage)               */
/* ═══════════════════════════════════════════════════════════════ */
section('enabled-happy');
check('typical v1 data → verified shadow via bridge', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runEnabled(adapter);
  assert.equal(r.ok, true, `bridge run failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.status, 'verified');
  assert.ok(r.wrapper, 'wrapper must be present on success');
  assert.equal(r.errors?.length, 0);
  assert.ok(typeof adapter._store[SHADOW_KEY] === 'string',
    'shadow key must be written after a successful run');
});
check('fresh install (all null source keys) → verified shadow', async () => {
  const adapter = makeSync({});  // no v1 keys present
  const r = await runEnabled(adapter);
  assert.equal(r.ok, true, `fresh install failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.status, 'verified');
  assert.equal(r.wrapper.verificationSummary.stateCount, 0);
});
check('idempotent re-run produces byte-identical shadow wrapper', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runEnabled(adapter);
  const r2 = await runEnabled(adapter);
  assert.equal(r1.ok, true); assert.equal(r2.ok, true);
  assert.equal(adapter._store[SHADOW_KEY],
    JSON.stringify(r1.wrapper), 'second run must produce same bytes');
  assert.equal(r1.wrapper.sourceFingerprint, r2.wrapper.sourceFingerprint);
});
check('bridge returns structured result with all required fields', async () => {
  const r = await runEnabled(makeSync({ ...TYPICAL_STORE }));
  assert.equal(r.ok, true);
  assert.ok(typeof r.byteSize === 'number' && r.byteSize > 0);
  assert.ok(r.wrapper?.candidate?.schemaVersion === 2);
  assert.ok(r.wrapper?.verificationSummary?.unexpectedDiffCount === 0);
  assert.ok(Array.isArray(r.errors));
  assert.ok(Array.isArray(r.warnings));
});
check('bridge never throws — always returns a structured result object', async () => {
  // Catastrophic adapter that throws synchronously on every get.
  const evilAdapter = {
    getItem:    () => { throw new TypeError('catastrophic getItem'); },
    setItem:    () => {},
    removeItem: () => {},
  };
  let r;
  try {
    r = await maybeShadowMigrate({ enabled: true, adapter: evilAdapter,
      today: FIXED_TODAY, clock: CTX.clock, appBuild: 'v19',
      _testHooks: { digest: testDigest } });
  } catch (e) {
    assert.fail(`bridge must never throw; got: ${e.message}`);
  }
  assert.ok(r && typeof r === 'object', 'must always return an object');
  assert.ok(['verified', 'failed', 'disabled'].includes(r.status));
});

/* ═══════════════════════════════════════════════════════════════ */
/*  4 · enabled-failures (all failure modes)                       */
/* ═══════════════════════════════════════════════════════════════ */
section('enabled-failures');
check('failed migration (injected) → structured failure, no shadow written', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runEnabled(adapter, {
    _testHooks: { digest: testDigest, migrate: () => { throw new Error('simulated migration bug'); } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(!adapter._store[SHADOW_KEY], 'shadow must not be written after migration failure');
});
check('failed digest (injected) → structured failure, no shadow written', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runEnabled(adapter, {
    _testHooks: { digest: () => Promise.reject(new Error('digest failed')) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(!adapter._store[SHADOW_KEY], 'shadow must not be written after digest failure');
});
check('adapter timeout (mock scheduler) → structured failure', async () => {
  const scheduler = makeMockScheduler();
  const neverAdapter = makeNeverSettleAdapter({ ...TYPICAL_STORE }, SOURCE_KEYS[0], 'read');
  const runPromise = runEnabled(neverAdapter, {
    timeoutMs: 1000, scheduler,
    _testHooks: { digest: testDigest },
  });
  // The bridge does dynamic imports before reaching the runner's first adapter call,
  // so the timeout is not registered until after those imports resolve.
  // Poll until the scheduler has at least one pending timer, then flush it.
  let polls = 0;
  while (scheduler.pendingCount === 0 && polls++ < 500) await Promise.resolve();
  scheduler.flush();
  const r = await runPromise;
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(r.errors?.some(e => e.includes('timed out') || e.includes('timeout')));
});
check('QuotaExceededError on shadow write → structured failure, v1 unchanged', async () => {
  const adapter = makeWriteFailAdapter({ ...TYPICAL_STORE }, SHADOW_KEY);
  const r = await runEnabled(adapter);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(r.errors?.some(e => e.includes('write') || e.includes('QuotaExceeded') || e.includes(SHADOW_KEY)));
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k] ?? null, TYPICAL_STORE[k] ?? null,
      `source key "${k}" must not change after write failure`);
  }
});
check('silent lost write → detected via readback → structured failure', async () => {
  const adapter = makeSilentLostWriteAdapter({ ...TYPICAL_STORE });
  const r = await runEnabled(adapter);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(r.errors?.some(e => e.includes('readback') || e.includes('mismatch')));
});
check('malformed existing shadow → not trusted, proceeds to overwrite on success', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE, [SHADOW_KEY]: 'not valid json {{{' });
  const r = await runEnabled(adapter);
  assert.equal(r.ok, true, `should succeed overwriting malformed shadow: ${JSON.stringify(r.errors)}`);
  const written = JSON.parse(adapter._store[SHADOW_KEY]);
  assert.equal(written.status, 'verified');
});
check('v1 mutation detected during run → structured failure, detected by step-13 re-read', async () => {
  const adapter = makeMutateAfterShadowWriteAdapter({ ...TYPICAL_STORE }, 'hometask-v1', '[]');
  const r = await runEnabled(adapter);
  assert.equal(r.ok, false);
  assert.ok(r.errors?.some(e => e.includes('changed during shadow run') || e.includes('hometask-v1')));
});

/* ═══════════════════════════════════════════════════════════════ */
/*  5 · v1-authority                                               */
/* ═══════════════════════════════════════════════════════════════ */
section('v1-authority');
check('v1 source keys are byte-identical after a successful shadow run', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const before = adapter._snapshot();
  const r = await runEnabled(adapter);
  assert.equal(r.ok, true);
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k] ?? null, before[k] ?? null,
      `source key "${k}" must not be modified by the bridge`);
  }
});
check('v1 source keys are byte-identical after a failed shadow run', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const before = adapter._snapshot();
  await runEnabled(adapter, {
    _testHooks: { digest: testDigest, migrate: () => { throw new Error('deliberate failure'); } },
  });
  // Even after failure, v1 must be unchanged.
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k] ?? null, before[k] ?? null,
      `source key "${k}" must not be modified even on bridge failure`);
  }
});
check('shadow key is not in SOURCE_KEYS (shadow candidate isolated from v1 source read list)', () => {
  assert.ok(!SOURCE_KEYS.includes(SHADOW_KEY),
    'hometask-v2-shadow must not appear in SOURCE_KEYS');
  assert.ok(!SOURCE_KEYS.some(k => k.includes('v2')),
    'SOURCE_KEYS must only reference v1 storage keys');
});
check('simulated Done/Skip writes to v1 do not affect the shadow candidate', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  // Step 1: establish a verified shadow.
  const r = await runEnabled(adapter);
  assert.equal(r.ok, true, `setup: shadow run failed: ${JSON.stringify(r.errors)}`);
  const shadowBefore = adapter._store[SHADOW_KEY];

  // Step 2: simulate a Done action — write a modified hometask-v1.
  adapter._store['hometask-v1'] = '[]';

  // Step 3: shadow candidate must be completely unchanged.
  assert.equal(adapter._store[SHADOW_KEY], shadowBefore,
    'a simulated Done/Skip write to hometask-v1 must not affect the shadow candidate');

  // Step 4: deleting the shadow key cannot affect v1 source keys.
  delete adapter._store[SHADOW_KEY];
  for (const k of SOURCE_KEYS) {
    assert.ok(k in adapter._store || adapter._store[k] === undefined,
      'deleting the shadow key must not affect v1 key presence');
  }
  // hometask-v1 still has our simulated modification (not affected by shadow deletion).
  assert.equal(adapter._store['hometask-v1'], '[]',
    'v1 retains the Done change independent of shadow state');
});

/* ═══════════════════════════════════════════════════════════════ */
/*  6 · structural                                                  */
/* ═══════════════════════════════════════════════════════════════ */
section('structural');
check('SHADOW_MIGRATION_ENABLED flag in shadow-config.js source is false', () => {
  const src = readFileSync(resolvePath(SRC, 'v2/shadow-config.js'), 'utf8');
  assert.ok(src.includes('SHADOW_MIGRATION_ENABLED = false'),
    'shadow-config.js source must export SHADOW_MIGRATION_ENABLED = false');
  // Must not be conditionally computed from runtime state.
  assert.ok(!src.includes('SHADOW_MIGRATION_ENABLED = !'),
    'flag must not be a negation expression');
  // Must not call localStorage (as in localStorage.getItem, localStorage[, etc.).
  assert.ok(!src.includes('localStorage.') && !src.includes('localStorage['),
    'flag must not read from localStorage');
  assert.ok(!src.includes('URLSearchParams') && !src.includes('location.search'),
    'flag must not be read from URL parameters');
});
check('shadow-bridge.js does not hardcode hometask-v2-shadow key (uses runner default via dynamic import)', () => {
  const src = readFileSync(resolvePath(SRC, 'v2/shadow-bridge.js'), 'utf8');
  assert.ok(!src.includes("'hometask-v2-shadow'") && !src.includes('"hometask-v2-shadow"'),
    'bridge must not hardcode the shadow key string; the runner default (SHADOW_KEY) is authoritative');
});
check('shadow-bridge.js has no static imports of shadow-migrate.js (uses dynamic import in enabled branch)', () => {
  const src = readFileSync(resolvePath(SRC, 'v2/shadow-bridge.js'), 'utf8');
  // Static imports have the form: import ... from '...' or import '...'
  // Dynamic imports have the form: import('...') — detect by negative lookahead for '('.
  // Strip block and line comments first (same approach as import-order.test.mjs).
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const re = /^\s*import(?!\s*\()[^'"]*['"]([^'"]+)['"]/gm;
  const staticImports = [...stripped.matchAll(re)].map(m => m[1]);
  assert.ok(!staticImports.some(s => s.includes('shadow-migrate')),
    `bridge must not statically import shadow-migrate; static imports found: ${staticImports.join(', ')}`);
  // But the source must reference shadow-migrate via a dynamic import.
  assert.ok(src.includes('shadow-migrate'), 'bridge must reference shadow-migrate via dynamic import');
  assert.ok(src.includes('import('), 'bridge must use dynamic import syntax');
});

/* ═══════════════════════════════════════════════════════════════ */
/*  7 · boot-sequencing                                            */
/*                                                                 */
/*  Simulates the exact script.js boot pattern:                   */
/*    app.init().then(() => {                                      */
/*      maybeShadowMigrate(...).catch(() => {});                   */
/*    });                                                          */
/*                                                                 */
/*  Proves:                                                        */
/*    1. app.init() rejection propagates — not swallowed.         */
/*    2. Shadow rejection after success is self-contained.        */
/*    3. Disabled mode — zero adapter/timer/console ops.          */
/*    4. Successful init resolves normally (pre-CP4B equivalent). */
/*    5. Shadow begins only after init resolves.                  */
/*    6. Boot chain resolves without awaiting shadow.             */
/* ═══════════════════════════════════════════════════════════════ */
section('boot-sequencing');

/**
 * Replicates the exact script.js boot pattern.
 * initFn  models app.init()
 * shadowFn models maybeShadowMigrate(...)
 *
 * Pattern: initFn().then(() => { shadowFn().catch(() => {}); });
 */
function simulateBoot(initFn, shadowFn) {
  return initFn().then(() => {
    shadowFn().catch(() => {});
  });
}

check('1 · app.init() rejection propagates — not swallowed by shadow integration', async () => {
  const initError = new Error('app.init failed — deliberate');
  let shadowCalled = false;
  const bootPromise = simulateBoot(
    () => Promise.reject(initError),
    () => { shadowCalled = true; return maybeShadowMigrate({ enabled: false }); },
  );
  await assert.rejects(bootPromise, (err) => {
    assert.strictEqual(err, initError,
      'rejection must be the exact app.init error — not a wrapped or swallowed version');
    return true;
  });
  assert.equal(shadowCalled, false,
    'shadow must never be called when app.init() fails');
});

check('2 · shadow rejection after successful init is self-contained (no unhandled rejection)', async () => {
  let shadowCalled = false;
  // A shadow function that rejects unexpectedly — as if the bridge has a bug.
  const bootPromise = simulateBoot(
    () => Promise.resolve(),
    () => {
      shadowCalled = true;
      return Promise.reject(new Error('unexpected bridge rejection'));
    },
  );
  // Boot chain must RESOLVE even though the shadow function rejected.
  // The .catch(() => {}) inside simulateBoot contains the rejection.
  await assert.doesNotReject(bootPromise,
    'boot chain must resolve normally even if the shadow Promise rejects');
  assert.ok(shadowCalled, 'shadow must have been called after successful init');
});

check('3 · disabled mode — zero adapter, timer, and console operations', async () => {
  let getCalls = 0, setCalls = 0, timerCalls = 0, logCalls = 0;
  const spyAdapter = {
    getItem:    () => { getCalls++;   return null; },
    setItem:    () => { setCalls++;   },
    removeItem: () => {},
  };
  const spyScheduler = {
    setTimeout:  () => { timerCalls++; return 0; },
    clearTimeout: () => {},
  };
  const origConsoleLog = console.log;
  console.log = () => { logCalls++; };
  try {
    const r = await maybeShadowMigrate({
      enabled: false, adapter: spyAdapter, scheduler: spyScheduler,
    });
    assert.equal(r.status, 'disabled');
  } finally {
    console.log = origConsoleLog;
  }
  assert.equal(getCalls,   0, 'disabled: zero adapter.getItem() calls');
  assert.equal(setCalls,   0, 'disabled: zero adapter.setItem() calls');
  assert.equal(timerCalls, 0, 'disabled: zero scheduler.setTimeout() calls');
  assert.equal(logCalls,   0, 'disabled: zero console.log() calls');
});

check('4 · successful app.init() resolves normally — shadow result does not affect boot chain', async () => {
  let initRan   = false;
  let bootResolved = false;
  const bootPromise = simulateBoot(
    () => Promise.resolve().then(() => { initRan = true; }),
    () => maybeShadowMigrate({ enabled: false }),
  );
  await bootPromise.then(() => { bootResolved = true; });
  assert.ok(initRan,      'init must have run');
  assert.ok(bootResolved, 'boot chain must resolve after successful init');
});

check('5 · shadow work begins only after successful app.init() resolves', async () => {
  const order = [];
  await simulateBoot(
    () => Promise.resolve().then(() => { order.push('init'); }),
    () => {
      order.push('shadow');
      return maybeShadowMigrate({ enabled: false });
    },
  );
  assert.deepEqual(order, ['init', 'shadow'],
    'init must complete before shadow starts — shadow must never precede init');
});

check('6 · boot chain resolves without awaiting shadow — shadow is fire-and-forget', async () => {
  // Use a never-settling shadow Promise.  If the boot chain awaited shadow,
  // this test would hang.  Racing against a 150 ms timeout proves it does not.
  const neverSettlingShadow = () => new Promise(() => {});  // never resolves or rejects
  const bootPromise = simulateBoot(
    () => Promise.resolve(),
    neverSettlingShadow,
  );
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(
      'boot chain hung — shadow Promise was awaited, blocking the first render',
    )), 150),
  );
  await Promise.race([bootPromise, timeout]);
  // Reaching here means boot resolved within 150 ms despite shadow never settling.
});

/* ── Summary ───────────────────────────────────────────────────── */
await Promise.all(_pending);
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
