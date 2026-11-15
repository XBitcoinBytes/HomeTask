/**
 * v2-composition.test.mjs — Suite 24 (E1 + E1c correction).
 *
 * Synthetic composition tests for the V2 data layer:
 *   V2Repository, runV2LockedImport/Undo, recoverV2Startup,
 *   V2BackupService via the wiring factory (createV2BackupService),
 *   createV2BackupAdapter, disabled boot gate, and the deferred
 *   local synthetic undo/UI controller contract.
 * All tests are deterministic — deferred barriers and MockScheduler; no sleeps.
 *
 * Sections:
 *   A  ( 7) — V2Repository construction validation
 *   B  ( 8) — V2Repository.get() read path
 *   C  ( 8) — V2Repository.put() / update() write happy path
 *   D  ( 5) — Deferred async controller (internal queue)
 *   E  ( 7) — runV2LockedUndo undo path
 *   U  ( 5) — recoverV2Startup coordinator
 *   F  (11) — Shared-lock concurrency (FC1 ×4, FC2 ×1, FC3 ×6)
 *   G  (10) — Storage failure modes
 *   I  ( 4) — Static isolation sentinels (v2-repository.js)
 *   H  ( 8) — Recovery notice state + rollback failure
 *   J  ( 6) — Disabled-path boot gate + composition wiring
 *   K  ( 5) — exportBackup via adapter reads V2Repository DATA
 *   L  ( 7) — readAndValidate + applyImport round-trip (adapter arity bridge)
 *   M  ( 5) — applyUndo via adapter; V2Repository sees restored state
 *   N  ( 3) — SESSION_RECOVERED_KEY interrupted-session recovery notice
 *   R  ( 6) — Deferred local synthetic undo/UI controller contract
 *   P  ( 3) — Shared-lock contention: repo.put() vs adapter.applyImport()
 *
 * Total: 7+8+8+5+7+5+11+10+4+8+6+5+7+5+3+6+3 = 108 checks.
 *
 * Standalone Node ESM. No browser, no real localStorage, no live data.
 * Run with:  node artifacts/home-tasks/tests/v2-composition.test.mjs
 */

import assert           from 'node:assert/strict';
import { createHash }   from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { V2Repository }  from '../src/data/v2/v2-repository.js';
import {
  runV2LockedImport, runV2LockedUndo, recoverV2Startup,
} from '../src/data/backup/v2-locked-import.js';
import { V2BackupService, SESSION_RECOVERED_KEY } from '../src/data/backup/v2-backup-service.js';
import { createV2BackupService }  from '../src/data/backup/v2-backup-wiring.js';
import { createV2BackupAdapter }  from '../src/data/backup/v2-backup-service-adapter.js';
import { ACTIVATION_KEYS }        from '../src/v2/activation-tx.js';
import { V2_KEYS }                from '../src/v2/import-tx.js';
import { maybeRecoverActivation } from '../src/v2/activation-bridge.js';
import { bootDecision }           from '../src/v2/activation-boot.js';
import { buildBackup }            from '../src/v2/backup.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── Digest helpers ────────────────────────────────────────────────── */

function testDigest(bytes) {
  return Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
}
function hexOf(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
function makeLS(gen, dig) {
  return JSON.stringify({ generation: gen, digest: dig, schemaVersion: 2 });
}

/* ── Test constants ────────────────────────────────────────────────── */

const D0 = '{"prefs":{"viewMode":"today","roomFilter":""},"state":[],"schemaVersion":2}';
const D1 = '{"prefs":{"viewMode":"home","roomFilter":"kitchen"},"state":[{"taskId":"t1"}],"schemaVersion":2}';
const MARKER_BYTES = '{"markerVersion":1,"activatedAt":"2026-01-01T00:00:00.000Z"}';
const NOW          = '2026-08-13T10:00:00.000Z';
const FIXED_TODAY  = '2026-08-13';

/* ── Adapter factories ─────────────────────────────────────────────── */

function makeAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: k      => store.delete(k),
    _store: store,
  };
}

/** Counts every getItem/setItem/removeItem call via opCount(). */
function makeOpTrackingAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  let ops = 0;
  return {
    getItem:    k      => { ops++; return store.has(k) ? store.get(k) : null; },
    setItem:    (k, v) => { ops++; store.set(k, String(v)); },
    removeItem: k      => { ops++; store.delete(k); },
    _store:  store,
    opCount: () => ops,
  };
}

/** Throws on every write to ACTIVATION_KEYS.MUT_JOURNAL. */
function makeJournalFaultAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => {
      if (k === ACTIVATION_KEYS.MUT_JOURNAL) throw new Error('injected-journal-fault');
      store.set(k, String(v));
    },
    removeItem: k => store.delete(k),
    _store: store,
  };
}

/** Throws on the FIRST write to ACTIVATION_KEYS.DATA; allows the restore (second write). */
function makeFirstDataWriteFaultAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  let dataWrites = 0;
  return {
    getItem:    k      => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => {
      if (k === ACTIVATION_KEYS.DATA && ++dataWrites === 1) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      store.set(k, String(v));
    },
    removeItem: k => store.delete(k),
    _store: store,
  };
}

/** Throws on every write to ACTIVATION_KEYS.LIVE_STATE. */
function makeLSFaultAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => {
      if (k === ACTIVATION_KEYS.LIVE_STATE) throw new Error('injected-live-state-fault');
      store.set(k, String(v));
    },
    removeItem: k => store.delete(k),
    _store: store,
  };
}

/** Throws on every write to ACTIVATION_KEYS.DATA (blocks new write AND restore). */
function makeAllDataFaultAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => {
      if (k === ACTIVATION_KEYS.DATA) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: k => store.delete(k),
    _store: store,
  };
}

/* ── Lock classes ──────────────────────────────────────────────────── */

/** FIFO-queuing lock — same interface used throughout the test suites. */
class TestLock {
  constructor() { this._queue = Promise.resolve(); }
  runExclusive(_txId, fn) {
    const next = this._queue.then(async () => {
      try   { return { ok: true,  result: await fn() }; }
      catch (e) { return { ok: false, code: 'callback-threw', message: e?.message ?? String(e) }; }
    });
    this._queue = next.catch(() => {});
    return next;
  }
}

/** TracingLock — FIFO-queuing with max-concurrency instrumentation. */
class TracingLock {
  constructor() {
    this._queue = Promise.resolve();
    this._active = 0;
    this._maxActive = 0;
  }
  runExclusive(_txId, fn) {
    const next = this._queue.then(async () => {
      this._active++;
      if (this._active > this._maxActive) this._maxActive = this._active;
      try {
        const r = await fn();
        this._active--;
        return { ok: true, result: r };
      } catch (e) {
        this._active--;
        return { ok: false, code: 'callback-threw', message: e?.message ?? String(e) };
      }
    });
    this._queue = next.catch(() => {});
    return next;
  }
  getMaxConcurrency() { return this._maxActive; }
}

/** Deterministic mock scheduler — timers captured, fired only on flush(). */
class MockScheduler {
  constructor()        { this._pending = new Map(); this._seq = 0; }
  setTimeout(fn, _ms) { const id = ++this._seq; this._pending.set(id, fn); return id; }
  clearTimeout(id)    { this._pending.delete(id); }
  flush() {
    const fns = [...this._pending.values()];
    this._pending.clear();
    for (const fn of fns) fn();
  }
  get pendingCount() { return this._pending.size; }
}

function makeLock()    { return new TestLock(); }
function makeDeferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const nextTick = () => new Promise(r => process.nextTick(r));

/* ── Repository factory ────────────────────────────────────────────── */

function makeRepo(adapter, lock, overrides = {}) {
  return new V2Repository({
    adapter,
    parseFn:     JSON.parse,
    serializeFn: JSON.stringify,
    lock,
    digestFn:    testDigest,
    timeoutMs:   0,
    ...overrides,
  });
}

/* ── V2BackupService minimal factory (for getRecoveryNoticeState) ──── */

function makeMinimalSvc(adapter) {
  return V2BackupService({
    adapter,
    catalog:      { tasks: [], zones: [], catalogVersion: 1 },
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   { readAsText: () => Promise.resolve('{}') },
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: makeAdapter(),
    lock:         makeLock(),
    digestFn:     testDigest,
    timeoutMs:    0,
  });
}

/* ── Static analysis helper ────────────────────────────────────────── */

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/* ── Test harness ──────────────────────────────────────────────────── */

let passed = 0, failed = 0;
const failures = [];
let _group = '';
function section(name) { _group = name; console.log(`\n── ${name}\n`); }
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓  [${_group}] ${label}`);
  } catch (e) {
    failed++;
    failures.push({ label: `[${_group}] ${label}`, error: e.message });
    console.error(`  ✗  [${_group}] ${label}\n     ${e.message}`);
  }
}

/* ════════════════════════════════════════════════════════════════════
   A — V2Repository construction (7)
════════════════════════════════════════════════════════════════════ */
section('A-boot');

await check('A1: no opts → TypeError', async () => {
  assert.throws(() => new V2Repository(), TypeError);
});
await check('A2: adapter:null → TypeError', async () => {
  assert.throws(
    () => new V2Repository({ adapter: null, parseFn: JSON.parse, serializeFn: JSON.stringify, lock: makeLock() }),
    TypeError,
  );
});
await check('A3: parseFn:null → TypeError', async () => {
  assert.throws(
    () => new V2Repository({ adapter: makeAdapter(), parseFn: null, serializeFn: JSON.stringify, lock: makeLock() }),
    TypeError,
  );
});
await check('A4: serializeFn:null → TypeError', async () => {
  assert.throws(
    () => new V2Repository({ adapter: makeAdapter(), parseFn: JSON.parse, serializeFn: null, lock: makeLock() }),
    TypeError,
  );
});
await check('A5: lock:null → TypeError', async () => {
  assert.throws(
    () => new V2Repository({ adapter: makeAdapter(), parseFn: JSON.parse, serializeFn: JSON.stringify, lock: null }),
    TypeError,
  );
});
await check('A6: lock without runExclusive → TypeError', async () => {
  assert.throws(
    () => new V2Repository({ adapter: makeAdapter(), parseFn: JSON.parse, serializeFn: JSON.stringify, lock: {} }),
    TypeError,
  );
});
await check('A7: valid config → no throw; zero adapter reads/writes at construction', async () => {
  let gets = 0, sets = 0;
  const spy = {
    getItem:    () => { gets++; return null; },
    setItem:    () => { sets++; },
    removeItem: () => {},
  };
  new V2Repository({ adapter: spy, parseFn: JSON.parse, serializeFn: JSON.stringify, lock: makeLock(), digestFn: testDigest, timeoutMs: 0 });
  assert.equal(gets, 0, 'no reads at construction');
  assert.equal(sets, 0, 'no writes at construction');
});

/* ════════════════════════════════════════════════════════════════════
   B — V2Repository.get() read path (8)
════════════════════════════════════════════════════════════════════ */
section('B-get');

await check('B1: DATA present → ok:true; data matches JSON.parse(D0)', async () => {
  const r = await makeRepo(makeAdapter({ [ACTIVATION_KEYS.DATA]: D0 }), makeLock()).get();
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, JSON.parse(D0));
});
await check('B2: DATA absent (null) → ok:false, code:data-absent', async () => {
  const r = await makeRepo(makeAdapter(), makeLock()).get();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-absent');
});
await check('B3: DATA empty string → ok:false, code:data-absent', async () => {
  const r = await makeRepo(makeAdapter({ [ACTIVATION_KEYS.DATA]: '' }), makeLock()).get();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-absent');
});
await check('B4: DATA malformed JSON → ok:false, code:parse-failed', async () => {
  const r = await makeRepo(makeAdapter({ [ACTIVATION_KEYS.DATA]: '{bad json' }), makeLock()).get();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'parse-failed');
});
await check('B5: parseFn throws → ok:false, code:parse-failed; message includes thrown text', async () => {
  const repo = makeRepo(
    makeAdapter({ [ACTIVATION_KEYS.DATA]: D0 }),
    makeLock(),
    { parseFn: () => { throw new Error('parseFn-crash'); } },
  );
  const r = await repo.get();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'parse-failed');
  assert.ok(r.message.includes('parseFn-crash'), `message must include thrown text; got: ${r.message}`);
});
await check('B6: getItem throws → ok:false, code:read-failed', async () => {
  const throwAdp = { getItem: () => { throw new Error('storage-unavailable'); }, setItem: () => {}, removeItem: () => {} };
  const r = await makeRepo(throwAdp, makeLock()).get();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'read-failed');
});
await check('B7: get() performs zero writes; DATA byte-identical after call', async () => {
  const adp = makeAdapter({ [ACTIVATION_KEYS.DATA]: D0 });
  let writeCount = 0;
  const spyAdp = {
    getItem:    k      => adp.getItem(k),
    setItem:    (k, v) => { writeCount++; adp.setItem(k, v); },
    removeItem: k      => adp.removeItem(k),
  };
  await makeRepo(spyAdp, makeLock()).get();
  assert.equal(writeCount, 0, 'zero storage writes from get()');
  assert.equal(adp.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA byte-identical after get()');
});
await check('B8: result shape — ok:true has {ok,data}; ok:false has {ok,code,message}', async () => {
  const okR   = await makeRepo(makeAdapter({ [ACTIVATION_KEYS.DATA]: D0 }), makeLock()).get();
  const failR = await makeRepo(makeAdapter(), makeLock()).get();
  assert.ok('data'    in okR,   'ok:true must have data');
  assert.ok(!('code'  in okR),  'ok:true must not have code');
  assert.ok('code'    in failR, 'ok:false must have code');
  assert.ok('message' in failR, 'ok:false must have message');
  assert.ok(!('data'  in failR),'ok:false must not have data');
});

/* ════════════════════════════════════════════════════════════════════
   C — V2Repository write happy path (put / update) (8)
════════════════════════════════════════════════════════════════════ */
section('C-write');

// Shared adapter for C1–C6
const cAdp = makeAdapter({
  [ACTIVATION_KEYS.DATA]:       D0,
  [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  'c-sentinel':                 'unchanged',
});
const cRepo      = makeRepo(cAdp, makeLock());
const c1payload  = { label: 'c1-write', schemaVersion: 2 };
const c1Str      = JSON.stringify(c1payload);
const c1result   = await cRepo.put(c1payload);

await check('C1: put(payload) on seeded store → ok:true', async () => {
  assert.equal(c1result.ok, true);
});
await check('C2: DATA = JSON.stringify(payload) byte-exact after put', async () => {
  assert.equal(cAdp.getItem(ACTIVATION_KEYS.DATA), c1Str);
});
await check('C3: LIVE_STATE generation = preGen+1 = 1 after put', async () => {
  const ls = JSON.parse(cAdp.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 1);
});
await check('C4: LIVE_STATE.digest = sha256(DATA) after put', async () => {
  const ls = JSON.parse(cAdp.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.digest, hexOf(c1Str));
});
await check('C5: MUT_JOURNAL absent after successful put', async () => {
  assert.equal(cAdp.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null,
    'journal must be cleared after clean write');
});
await check('C6: unrelated sentinel key byte-identical after put', async () => {
  assert.equal(cAdp.getItem('c-sentinel'), 'unchanged');
});

// C7: sequential put(A) then put(B)
{
  const c7Adp = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const c7Repo = makeRepo(c7Adp, makeLock());
  const c7A    = JSON.stringify({ label: 'c7-A' });
  const c7B    = JSON.stringify({ label: 'c7-B' });
  await c7Repo.put(JSON.parse(c7A));
  await c7Repo.put(JSON.parse(c7B));

  await check('C7: put(A) then put(B) → generation=2; DATA=B-str byte-exact', async () => {
    const ls = JSON.parse(c7Adp.getItem(ACTIVATION_KEYS.LIVE_STATE));
    assert.equal(ls.generation, 2, 'generation must be 2');
    assert.equal(c7Adp.getItem(ACTIVATION_KEYS.DATA), c7B, 'DATA must be last written payload');
  });
}

// C8: update(fn) applies mutation correctly
{
  const c8Initial = JSON.stringify({ count: 5 });
  const c8Adp     = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       c8Initial,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(c8Initial)),
  });
  const c8Repo = makeRepo(c8Adp, makeLock());
  await c8Repo.update(data => ({ ...data, count: data.count + 1 }));

  await check('C8: update(fn) reads current data and applies mutation; DATA has count=6', async () => {
    const data = JSON.parse(c8Adp.getItem(ACTIVATION_KEYS.DATA));
    assert.equal(data.count, 6, `expected count=6; got ${data.count}`);
  });
}

/* ════════════════════════════════════════════════════════════════════
   D — Deferred async controller — internal queue (5)
════════════════════════════════════════════════════════════════════ */
section('D-async-controller');

// D1/D2: two concurrent update() calls on same repo; internal queue serializes
{
  const dInitial = JSON.stringify({ count: 0 });
  const dAdp     = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       dInitial,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(dInitial)),
  });
  const dRepo = makeRepo(dAdp, makeLock());
  let d2SecondSaw = -1;

  const [d1rA, d1rB] = await Promise.all([
    dRepo.update(data => ({ ...data, count: data.count + 1 })),
    dRepo.update(data => {
      d2SecondSaw = data.count;
      return { ...data, count: data.count + 1 };
    }),
  ]);

  await check('D1: two concurrent update() calls → both ok:true; count=2 (no lost update)', async () => {
    assert.equal(d1rA.ok, true, 'first call ok');
    assert.equal(d1rB.ok, true, 'second call ok');
    assert.equal(JSON.parse(dAdp.getItem(ACTIVATION_KEYS.DATA)).count, 2,
      'count must be 2 — both increments applied');
  });
  await check('D2: second update reads first\'s committed data (post-lock read count=1)', async () => {
    assert.equal(d2SecondSaw, 1,
      `second fn must receive count=1 (first committed); got ${d2SecondSaw}`);
  });
}

// D3/D4: mutateFn throws → mutation-fn-threw; queue recoverable
{
  const d34Initial = JSON.stringify({ count: 0 });
  const d34Adp     = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       d34Initial,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(d34Initial)),
  });
  const d34Repo = makeRepo(d34Adp, makeLock());
  const d3r     = await d34Repo.update(() => { throw new Error('mutateFn-crash'); });
  const d4r     = await d34Repo.update(() => ({ count: 99 }));

  await check('D3: mutateFn throws → ok:false, code:mutation-fn-threw', async () => {
    assert.equal(d3r.ok, false);
    assert.equal(d3r.code, 'mutation-fn-threw');
  });
  await check('D4: update after mutateFn failure → ok:true; internal queue not poisoned', async () => {
    assert.equal(d4r.ok, true);
    assert.equal(JSON.parse(d34Adp.getItem(ACTIVATION_KEYS.DATA)).count, 99);
  });
}

// D5: serializeFn returns empty string → serialize-empty
{
  const d5Adp  = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const d5Repo = makeRepo(d5Adp, makeLock(), { serializeFn: () => '' });
  const d5r    = await d5Repo.update(() => ({}));

  await check('D5: serializeFn returns empty string → ok:false, code:serialize-empty', async () => {
    assert.equal(d5r.ok, false);
    assert.equal(d5r.code, 'serialize-empty');
  });
}

/* ════════════════════════════════════════════════════════════════════
   E — runV2LockedUndo undo path (7)
════════════════════════════════════════════════════════════════════ */
section('E-undo');

// E1–E4, E7: import-then-undo shared scenario
{
  const eAdp  = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
    'e-sentinel':                 'e-unchanged',
  });
  const eLock = makeLock();

  await runV2LockedImport(eAdp, D1, eLock, NOW, testDigest, 0);
  const importGen  = JSON.parse(eAdp.getItem(ACTIVATION_KEYS.LIVE_STATE)).generation; // 1
  const undoResult = await runV2LockedUndo(eAdp, eLock, testDigest, 0);

  await check('E1: import then undo → ok:true; DATA restored to D0', async () => {
    assert.equal(undoResult.ok, true);
    assert.equal(eAdp.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA must be restored to D0');
  });
  await check('E2: undo advances generation (forward mutation; gen = importGen+1)', async () => {
    const ls = JSON.parse(eAdp.getItem(ACTIVATION_KEYS.LIVE_STATE));
    assert.equal(ls.generation, importGen + 1,
      `generation must be ${importGen + 1}; got ${ls.generation}`);
  });
  await check('E3: LIVE_STATE.digest = sha256(D0) after undo', async () => {
    const ls = JSON.parse(eAdp.getItem(ACTIVATION_KEYS.LIVE_STATE));
    assert.equal(ls.digest, hexOf(D0));
  });
  await check('E4: snapshot absent from BACKUP after undo (ownership-checked clear)', async () => {
    const backup = JSON.parse(eAdp.getItem(V2_KEYS.BACKUP) ?? '{}');
    assert.ok(!backup.snapshot, 'snapshot field must be cleared after undo');
  });
  await check('E7: sentinel key byte-identical through import + undo', async () => {
    assert.equal(eAdp.getItem('e-sentinel'), 'e-unchanged');
  });
}

// E5: no snapshot → no-snapshot
{
  const e5Adp = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const e5r = await runV2LockedUndo(e5Adp, makeLock(), testDigest, 0);
  await check('E5: no snapshot → ok:false, code:no-snapshot', async () => {
    assert.equal(e5r.ok, false);
    assert.equal(e5r.code, 'no-snapshot');
  });
}

// E6: stale snapshot (DATA tampered after import) → snapshot-stale
{
  const e6Adp  = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
  });
  const e6Lock = makeLock();
  await runV2LockedImport(e6Adp, D1, e6Lock, NOW, testDigest, 0); // imports D1; targetDigest=hexOf(D1)
  // Tamper DATA so sha256(DATA) ≠ snapshot.targetDigest
  e6Adp.setItem(ACTIVATION_KEYS.DATA,       D0);
  e6Adp.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(2, hexOf(D0)));
  const e6r = await runV2LockedUndo(e6Adp, e6Lock, testDigest, 0);
  await check('E6: stale snapshot (DATA tampered after import) → ok:false, code:snapshot-stale', async () => {
    assert.equal(e6r.ok, false);
    assert.equal(e6r.code, 'snapshot-stale');
  });
}

/* ════════════════════════════════════════════════════════════════════
   U — recoverV2Startup coordinator (5)
════════════════════════════════════════════════════════════════════ */
section('U-recovery-startup');

// U1: clean state → stagingAction:none, v2Active:true
{
  const u1Adp = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
  });
  const u1r = await recoverV2Startup(u1Adp, makeLock(), null, NOW, testDigest, 0);
  await check('U1: clean state → stagingAction:none, v2Active:true', async () => {
    assert.equal(u1r.v2Active,     true);
    assert.equal(u1r.stagingAction, 'none');
  });
}

// U2: staged + sha256(DATA)==targetDigest → cleared-committed; STAGING absent
{
  const u2Adp = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D1,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(1, hexOf(D1)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'staged', transactionId: 'u2-tx',
      startedAt: NOW, sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
    }),
  });
  const u2r = await recoverV2Startup(u2Adp, makeLock(), null, NOW, testDigest, 0);
  await check('U2: staged + DATA==targetDigest → cleared-committed; STAGING absent', async () => {
    assert.equal(u2r.stagingAction, 'cleared-committed');
    assert.equal(u2Adp.getItem(V2_KEYS.STAGING), null, 'STAGING must be cleared');
  });
}

// U3: staged + sha256(DATA)==sourceDigest → cleared-uncommitted; STAGING absent
{
  const u3Adp = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'staged', transactionId: 'u3-tx',
      startedAt: NOW, sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
    }),
  });
  const u3r = await recoverV2Startup(u3Adp, makeLock(), null, NOW, testDigest, 0);
  await check('U3: staged + DATA==sourceDigest → cleared-uncommitted; STAGING absent', async () => {
    assert.equal(u3r.stagingAction, 'cleared-uncommitted');
    assert.equal(u3Adp.getItem(V2_KEYS.STAGING), null, 'STAGING must be cleared');
  });
}

// U4: failed staging → retained-failed; STAGING still present
{
  const u4StagingRec = JSON.stringify({
    txVersion: 1, txState: 'failed', failCode: 'rollback-failed',
    transactionId: 'u4-tx', startedAt: NOW,
  });
  const u4Adp = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
    [V2_KEYS.STAGING]:            u4StagingRec,
  });
  const u4r = await recoverV2Startup(u4Adp, makeLock(), null, NOW, testDigest, 0);
  await check('U4: failed staging → retained-failed; STAGING still present', async () => {
    assert.equal(u4r.stagingAction, 'retained-failed');
    assert.ok(u4Adp.getItem(V2_KEYS.STAGING), 'STAGING must still be present');
  });
}

// U5: lock timeout → coordinator-lock-denied, v2Active:false
{
  const u5Sched = new MockScheduler();
  const u5Adp   = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
  });
  const pendingLock = { runExclusive: () => new Promise(() => {}) };
  const u5P = recoverV2Startup(u5Adp, pendingLock, null, NOW, testDigest, 100, u5Sched);
  u5Sched.flush();
  const u5r = await u5P;
  await check('U5: lock timeout → action:coordinator-lock-denied, v2Active:false', async () => {
    assert.equal(u5r.action,   'coordinator-lock-denied');
    assert.equal(u5r.v2Active, false);
  });
}

/* ════════════════════════════════════════════════════════════════════
   F — Shared-lock concurrency (11)
   FC1 (4): sequential deferred-barrier; both repos succeed
   FC2 (1): TracingLock max-concurrency === 1
   FC3 (6): timeout contention; FIFO drain; zero ghost writes
════════════════════════════════════════════════════════════════════ */
section('F-concurrency');

/* ── FC1: two repos, deferred-barrier holder, both succeed ─────────── */
{
  const lockFC1  = new TestLock();
  const adpFC1   = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const preGenFC1 = 0;
  const dataStrA  = JSON.stringify({ label: 'A', v: 1 });
  const dataStrB  = JSON.stringify({ label: 'B', v: 2 });

  const repoA = makeRepo(adpFC1, lockFC1, { generateId: () => 'repo-a' });
  const repoB = makeRepo(adpFC1, lockFC1, { generateId: () => 'repo-b' });

  // Hold the lock open so both repos queue behind the holder
  const deferFC1  = makeDeferred();
  const holderFC1 = lockFC1.runExclusive('fc1-holder', async () => { await deferFC1.promise; });

  const resultAP = repoA.update(() => JSON.parse(dataStrA)); // ignores current; writes A
  const resultBP = repoB.update(() => JSON.parse(dataStrB)); // ignores current; writes B
  await nextTick(); await nextTick(); // ensure both are queued behind the holder

  deferFC1.resolve();
  await holderFC1;
  const [resultA, resultB] = await Promise.all([resultAP, resultBP]);

  await check('F1 [FC1]: repoA returns ok:true (committed first)', async () => {
    assert.equal(resultA.ok, true);
  });
  await check('F2 [FC1]: repoB returns ok:true (committed after repoA released lock)', async () => {
    assert.equal(resultB.ok, true);
  });
  await check('F3 [FC1]: DATA = dataStrB byte-exact (last writer wins; no payload blend)', async () => {
    assert.equal(adpFC1.getItem(ACTIVATION_KEYS.DATA), dataStrB,
      'DATA must equal dataStrB exactly — no fragment of A mixed in');
  });
  await check('F4 [FC1]: LIVE_STATE generation = preGen+2 (advanced exactly twice)', async () => {
    const ls = JSON.parse(adpFC1.getItem(ACTIVATION_KEYS.LIVE_STATE));
    assert.equal(ls.generation, preGenFC1 + 2,
      `expected generation ${preGenFC1 + 2}; got ${ls.generation}`);
  });
}

/* ── FC2: TracingLock proves maxConcurrency === 1 ─────────────────── */
{
  const tLock = new TracingLock();
  const adpFC2 = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const rA2 = makeRepo(adpFC2, tLock, { generateId: () => 'tl-a' });
  const rB2 = makeRepo(adpFC2, tLock, { generateId: () => 'tl-b' });

  // Same holder pattern — guarantees both queue before the holder releases
  const deferFC2  = makeDeferred();
  const holderFC2 = tLock.runExclusive('fc2-holder', async () => { await deferFC2.promise; });
  const p2A = rA2.update(() => ({ label: 'x' }));
  const p2B = rB2.update(() => ({ label: 'y' }));
  await nextTick(); await nextTick();
  deferFC2.resolve();
  await holderFC2;
  await Promise.all([p2A, p2B]);

  await check('F5 [FC2]: TracingLock.getMaxConcurrency() === 1 (strict mutual exclusion across two repos)', async () => {
    assert.equal(tLock.getMaxConcurrency(), 1);
  });
}

/* ── FC3: FIFO drain after timeout; guardedCallback exits without writes ── */
{
  const schedFC3 = new MockScheduler();
  const lockFC3  = new TestLock();
  const adpFC3   = makeOpTrackingAdapter();
  // Seed via _store so opCount starts at zero (bypasses tracking wrappers)
  adpFC3._store.set(ACTIVATION_KEYS.DATA,       D0);
  adpFC3._store.set(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(D0)));

  // Phase 1: seize lock with a deferred-barrier holder; no adapter ops
  const deferFC3  = makeDeferred();
  const holderFC3 = lockFC3.runExclusive('fc3-holder', async () => { await deferFC3.promise; });

  // Phase 2: queue a timed-out import — withLockTimeout enqueues guardedCallback
  //          immediately; it cannot run while the holder is active
  const timedOutP = runV2LockedImport(adpFC3, D1, lockFC3, NOW, testDigest, 100, schedFC3);

  // Flush MockScheduler: timeout fires → outer promise resolves concurrency-unavailable
  // (before the holder has released the gate)
  schedFC3.flush();
  const rTimeout    = await timedOutP;
  const opsAtTimeout = adpFC3.opCount(); // should be 0 — callback never entered

  // Phase 3: release holder → FIFO queue advances to the guardedCallback
  deferFC3.resolve();
  await holderFC3;
  // Drain microtasks — give guardedCallback full opportunity to (wrongly) commit
  await nextTick(); await nextTick(); await nextTick();

  await check('F6 [FC3]: timed-out call returns ok:false', async () => {
    assert.equal(rTimeout.ok, false);
  });
  await check('F7 [FC3]: timed-out call returns code:concurrency-unavailable', async () => {
    assert.equal(rTimeout.code, 'concurrency-unavailable');
  });
  await check('F8 [FC3]: zero adapter ops before gate release (callback never entered during timeout)', async () => {
    assert.equal(opsAtTimeout, 0, `expected 0 ops at timeout; got ${opsAtTimeout}`);
  });
  await check('F9 [FC3]: zero additional ops after FIFO drain (guardedCallback exits without writes)', async () => {
    assert.equal(adpFC3.opCount(), opsAtTimeout,
      `guardedCallback must not produce additional ops; count was ${adpFC3.opCount()}`);
  });
  await check('F10 [FC3]: DATA = D0 byte-exact (no ghost commit of D1)', async () => {
    assert.equal(adpFC3._store.get(ACTIVATION_KEYS.DATA), D0,
      'DATA must remain D0 — no ghost commit from timed-out import');
  });
  await check('F11 [FC3]: LIVE_STATE generation unchanged = 0 (no ghost advance)', async () => {
    const ls = JSON.parse(adpFC3._store.get(ACTIVATION_KEYS.LIVE_STATE));
    assert.equal(ls.generation, 0, `generation must remain 0; got ${ls.generation}`);
  });
}

/* ════════════════════════════════════════════════════════════════════
   G — Storage failure modes (10)
════════════════════════════════════════════════════════════════════ */
section('G-storage-failures');

/* ── G1/G2: journal write fault ──────────────────────────────────── */
{
  const g12Adp  = makeJournalFaultAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const g12Repo = makeRepo(g12Adp, makeLock());
  const g12r    = await g12Repo.put({ v: 99 });

  await check('G1: journal write fault → ok:false, code:journal-write-failed', async () => {
    assert.equal(g12r.ok,   false);
    assert.equal(g12r.code, 'journal-write-failed');
  });
  await check('G2: journal write fault → DATA byte-identical to D0 (no DATA write attempted)', async () => {
    assert.equal(g12Adp.getItem(ACTIVATION_KEYS.DATA), D0);
  });
}

/* ── G3/G4: first DATA write fault; restore succeeds ───────────── */
{
  const g34Adp  = makeFirstDataWriteFaultAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const g34Repo = makeRepo(g34Adp, makeLock());
  const g34r    = await g34Repo.put({ v: 99 });

  await check('G3: first DATA write fault + restore ok → ok:false, code:data-write-failed', async () => {
    assert.equal(g34r.ok,   false);
    assert.equal(g34r.code, 'data-write-failed');
  });
  await check('G4: DATA restored to D0; dataRestoreOk:true', async () => {
    assert.equal(g34r.dataRestoreOk, true, 'dataRestoreOk must be true');
    assert.equal(g34Adp.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA must be restored to prevRaw');
  });
}

/* ── G5–G10: LIVE_STATE write fault via runV2LockedImport ────────── */
{
  const g5Adp = makeLSFaultAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
  });
  const g5r = await runV2LockedImport(g5Adp, D1, makeLock(), NOW, testDigest, 0);

  await check('G5: LIVE_STATE fault → ok:false, code:live-state-write-failed', async () => {
    assert.equal(g5r.ok,   false);
    assert.equal(g5r.code, 'live-state-write-failed');
  });
  await check('G6: LIVE_STATE fault → DATA = D1 (new bytes committed at wLM step 2)', async () => {
    assert.equal(g5Adp.getItem(ACTIVATION_KEYS.DATA), D1,
      'DATA must contain new payload bytes (wLM step 2 succeeded before step 3 failed)');
  });
  await check('G7: LIVE_STATE fault → LIVE_STATE = old bytes (step 3 failed; not updated)', async () => {
    assert.equal(g5Adp.getItem(ACTIVATION_KEYS.LIVE_STATE), makeLS(0, hexOf(D0)),
      'LIVE_STATE must still hold the pre-import generation and digest');
  });
  await check('G8: LIVE_STATE fault → MUT_JOURNAL retained (step 4 not reached; startup recovery evidence)', async () => {
    assert.ok(
      g5Adp.getItem(ACTIVATION_KEYS.MUT_JOURNAL) !== null,
      'journal must be retained for startup Case-A recovery',
    );
  });
  await check('G9: LIVE_STATE fault → V2_KEYS.STAGING.failCode = live-state-write-failed', async () => {
    const staging = JSON.parse(g5Adp.getItem(V2_KEYS.STAGING) ?? 'null');
    assert.equal(staging?.failCode, 'live-state-write-failed',
      `staging failCode must be 'live-state-write-failed'; got '${staging?.failCode}'`);
  });
  await check('G10: LIVE_STATE fault → V2_KEYS.BACKUP present (snapshot written at import step 1)', async () => {
    assert.ok(
      g5Adp.getItem(V2_KEYS.BACKUP) !== null,
      'backup snapshot must be written even when later steps fail',
    );
  });
}

/* ════════════════════════════════════════════════════════════════════
   I — Static isolation sentinels — v2-repository.js (4)
════════════════════════════════════════════════════════════════════ */
section('I-isolation');

{
  const repoSrc      = readFileSync(join(HERE, '..', 'src', 'data', 'v2', 'v2-repository.js'), 'utf8');
  const repoStripped = stripComments(repoSrc);

  await check('I1: v2-repository.js contains no localStorage reference', async () => {
    assert.ok(!repoStripped.includes('localStorage'),
      'v2-repository.js must not reference localStorage');
  });
  await check('I2: v2-repository.js contains no sessionStorage reference', async () => {
    assert.ok(!repoStripped.includes('sessionStorage'),
      'v2-repository.js must not reference sessionStorage');
  });
  await check('I3: v2-repository.js has no src/app/ imports (data-layer ownership boundary)', async () => {
    const importLines = repoStripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
    const appImports  = importLines.filter(l => /['"][^'"]*\/app\/[^'"]*['"]/.test(l));
    assert.deepEqual(appImports, [],
      `v2-repository.js must not import from src/app/: ${appImports.join('; ')}`);
  });
  await check('I4: v2-repository.js has no activation-config reference', async () => {
    assert.ok(!repoSrc.includes('activation-config'),
      'v2-repository.js must not reference activation-config');
  });
}

/* ════════════════════════════════════════════════════════════════════
   H — Recovery notice state + rollback failure (8)
════════════════════════════════════════════════════════════════════ */
section('H-recovery-notice');

await check('H1: clean state (no STAGING, no RECOVERY) → visible:false', async () => {
  const state = makeMinimalSvc(makeAdapter()).getRecoveryNoticeState();
  assert.equal(state.visible, false);
});
await check('H2: STAGING txState:staged (not a terminal failure) → visible:false', async () => {
  const adp = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'staged', transactionId: 'h2-tx', startedAt: NOW,
    }),
  });
  assert.equal(makeMinimalSvc(adp).getRecoveryNoticeState().visible, false);
});
await check('H3: STAGING txState:failed failCode:rollback-failed → visible:true, showUndo:true', async () => {
  const adp = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'failed', failCode: 'rollback-failed',
      transactionId: 'h3-tx', startedAt: NOW,
    }),
  });
  const state = makeMinimalSvc(adp).getRecoveryNoticeState();
  assert.equal(state.visible,  true,  'visible must be true');
  assert.equal(state.showUndo, true,  'showUndo must be true');
});
await check('H4: STAGING txState:failed failCode:live-state-write-failed → visible:false (not rollback-failed)', async () => {
  const adp = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'failed', failCode: 'live-state-write-failed',
      transactionId: 'h4-tx', startedAt: NOW,
    }),
  });
  assert.equal(makeMinimalSvc(adp).getRecoveryNoticeState().visible, false);
});

// H5–H7: double-DATA-fault scenario — runV2LockedImport produces rollback-failed
{
  const h5Adp = makeAllDataFaultAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
    [ACTIVATION_KEYS.MARKER]:     MARKER_BYTES,
  });
  const h5result  = await runV2LockedImport(h5Adp, D1, makeLock(), NOW, testDigest, 0);
  const h6staging = JSON.parse(h5Adp.getItem(V2_KEYS.STAGING) ?? 'null');
  const h7svc     = makeMinimalSvc(h5Adp);

  await check('H5: double-DATA-fault → result.ok:false, code:rollback-failed', async () => {
    assert.equal(h5result.ok,   false);
    assert.equal(h5result.code, 'rollback-failed');
  });
  await check('H6: after rollback failure → V2_KEYS.STAGING has txState:failed, failCode:rollback-failed', async () => {
    assert.equal(h6staging?.txState,  'failed',          `txState must be 'failed'; got '${h6staging?.txState}'`);
    assert.equal(h6staging?.failCode, 'rollback-failed', `failCode must be 'rollback-failed'; got '${h6staging?.failCode}'`);
  });
  await check('H7: getRecoveryNoticeState() after rollback failure → visible:true, showUndo:true', async () => {
    const state = h7svc.getRecoveryNoticeState();
    assert.equal(state.visible,  true, 'visible must be true');
    assert.equal(state.showUndo, true, 'showUndo must be true');
  });
}

// H8: RECOVERY key present (non-dismissed, non-downloaded) → damaged-data takes priority
await check('H8: RECOVERY key present (non-dismissed) → visible:true, showUndo:false, showDownload:true', async () => {
  const adp = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({
      rawData: '{}', detectedAt: NOW,
      source: V2_KEYS.STAGING, reason: 'malformed',
    }),
  });
  const state = makeMinimalSvc(adp).getRecoveryNoticeState();
  assert.equal(state.visible,      true,  'visible must be true');
  assert.equal(state.showUndo,     false, 'showUndo must be false (damaged-data takes priority)');
  assert.equal(state.showDownload, true,  'showDownload must be true');
});

/* ════════════════════════════════════════════════════════════════════
   J — Disabled-path boot gate + composition wiring (6)
   J1–J4: maybeRecoverActivation({enabled:false}) → {status:'disabled'},
           zero dynamic imports, bootDecision → 'boot-v1',
           forged extra field → 'indeterminate'
   J5–J6: createV2BackupService via wiring factory + createV2BackupAdapter;
           dual construction causes zero storage writes
════════════════════════════════════════════════════════════════════ */
section('J-boot-gate');

/* J1–J4: disabled bridge + bootDecision */
{
  let trapCalled = false;
  const trap     = async () => { trapCalled = true; return {}; };
  const jResult  = await maybeRecoverActivation({ enabled: false, _loadModule: trap });

  await check('J1: maybeRecoverActivation({enabled:false}) → {status:"disabled"} with exactly 1 key', async () => {
    assert.equal(jResult.status, 'disabled',
      `status must be 'disabled'; got '${jResult.status}'`);
    assert.equal(Object.keys(jResult).length, 1,
      `result must have exactly 1 key; got ${JSON.stringify(jResult)}`);
  });
  await check('J2: _loadModule trap never called (zero dynamic imports on disabled path)', async () => {
    assert.equal(trapCalled, false, 'trap must not be called when enabled:false');
  });
  await check('J3: bootDecision({status:"disabled"}) → "boot-v1"', async () => {
    assert.equal(bootDecision({ status: 'disabled' }), 'boot-v1');
  });
  await check('J4: bootDecision({status:"disabled", v2Active:false}) → "indeterminate" (forged extra field)', async () => {
    assert.equal(bootDecision({ status: 'disabled', v2Active: false }), 'indeterminate',
      'forged v2Active on disabled result must produce indeterminate');
  });
}

/* J5–J6: wiring factory construction; zero storage side-effects */
{
  const jAdpBase  = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  let jWriteCount = 0;
  const jSpyAdp   = {
    getItem:    k      => jAdpBase.getItem(k),
    setItem:    (k, v) => { jWriteCount++; jAdpBase.setItem(k, v); },
    removeItem: k      => jAdpBase.removeItem(k),
  };
  const NINE_METHODS = [
    'exportBackup', 'readAndValidate', 'applyImport', 'applyUndo',
    'hasSnapshot', 'getLastExport', 'getRecoveryNoticeState',
    'downloadRecoveryData', 'dismissRecovery',
  ];

  let jSvc, jWiredAdapter;
  await check('J5: createV2BackupService via wiring factory → no throw; exposes all 9 methods', async () => {
    jSvc = createV2BackupService({
      adapter:      jSpyAdp,
      catalog:      { tasks: [], zones: [], catalogVersion: 1 },
      appBuild:     'v-test',
      delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
      fileReader:   { readAsText: f => Promise.resolve(f._content ?? '') },
      clock:        () => NOW,
      todayFn:      () => FIXED_TODAY,
      sessionStore: makeAdapter(),
      lock:         makeLock(),
      digestFn:     testDigest,
      timeoutMs:    0,
    });
    for (const m of NINE_METHODS) {
      assert.equal(typeof jSvc[m], 'function', `wiring service must expose ${m}`);
    }
  });
  await check('J6: createV2BackupAdapter(svc) → no throw; all 9 methods; dual construction causes zero storage writes', async () => {
    jWiredAdapter = createV2BackupAdapter(jSvc);
    for (const m of NINE_METHODS) {
      assert.equal(typeof jWiredAdapter[m], 'function', `adapter must expose ${m}`);
    }
    assert.equal(jWriteCount, 0,
      `construction of wiring service + adapter must cause zero storage writes; got ${jWriteCount}`);
  });
}

/* ── MockBlob for Node.js (exportBackup builds a Blob; required for K+) ── */
globalThis.Blob = class MockBlob {
  constructor(parts = [], opts = {}) {
    this._content = parts.map(p => (typeof p === 'string' ? p : String(p))).join('');
    this.size     = this._content.length;
    this.type     = opts.type ?? '';
  }
};

/* ── Composition setup shared across K, L, M ───────────────────────── */
const compAdp  = makeAdapter({
  [ACTIVATION_KEYS.DATA]:       D0,
  [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
});
const compLock  = makeLock();
const compRepo  = makeRepo(compAdp, compLock);
let   compBlob  = null;
const compDelivery = {
  canShare: () => false,
  share:    async () => {},
  download: blob => { compBlob = blob; },
};
const compSvc = createV2BackupService({
  adapter:      compAdp,
  catalog:      { tasks: [], zones: [], catalogVersion: 1 },
  appBuild:     'v-test',
  delivery:     compDelivery,
  fileReader:   { readAsText: f => Promise.resolve(f._content ?? '') },
  clock:        () => NOW,
  todayFn:      () => FIXED_TODAY,
  sessionStore: makeAdapter(),
  lock:         compLock,       // ← shared with compRepo
  digestFn:     testDigest,
  timeoutMs:    0,
});
const compAdapter = createV2BackupAdapter(compSvc);

/* ════════════════════════════════════════════════════════════════════
   K — exportBackup via adapter reads V2Repository's committed DATA (5)
   K1: repo.put(kPayload) then adapter.exportBackup() → ok:true
   K2: blob contains kPayload-derived content
   K3: V2_KEYS.BACKUP has lastExport after export
   K4: exportBackup with no DATA → ok:false
   K5: adapter.getLastExport() returns date string from K1
════════════════════════════════════════════════════════════════════ */
section('K-export');

const kPayload    = JSON.parse(D0);
const kPayloadStr = JSON.stringify(kPayload);

const kPutResult = await compRepo.put(kPayload);
const kExpResult = await compAdapter.exportBackup();

await check('K1: repo.put(kPayload) then adapter.exportBackup() → ok:true (adapter reads V2Repository DATA)', async () => {
  assert.equal(kPutResult.ok, true,  `repo.put must succeed: ${JSON.stringify(kPutResult)}`);
  assert.equal(kExpResult.ok, true,  `exportBackup must succeed: ${kExpResult.message}`);
});
await check('K2: delivery blob contains kPayload-derived content (schemaVersion + state present)', async () => {
  assert.ok(compBlob !== null,                               'blob must be captured by delivery.download');
  assert.ok(typeof compBlob._content === 'string',           'blob._content must be a string');
  assert.ok(compBlob._content.includes('"schemaVersion"'),  'blob must include schemaVersion');
  assert.ok(compBlob._content.includes('"state"'),           'blob must include state field');
});
await check('K3: V2_KEYS.BACKUP has lastExport written after K1 export', async () => {
  const backup = JSON.parse(compAdp.getItem(V2_KEYS.BACKUP) ?? '{}');
  assert.ok(
    typeof backup.lastExport === 'string' && backup.lastExport.length > 0,
    `BACKUP.lastExport must be a non-empty string; got ${JSON.stringify(backup.lastExport)}`,
  );
});
await check('K4: adapter.exportBackup() with no DATA in adapter → ok:false', async () => {
  const emptyAdp = makeAdapter();
  const emptySvc = createV2BackupService({
    adapter:      emptyAdp,
    catalog:      { tasks: [], zones: [], catalogVersion: 1 },
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   { readAsText: f => Promise.resolve(f._content ?? '') },
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: makeAdapter(),
    lock:         makeLock(),
    digestFn:     testDigest,
    timeoutMs:    0,
  });
  const r = await createV2BackupAdapter(emptySvc).exportBackup();
  assert.equal(r.ok, false,
    `exportBackup with no DATA must return ok:false; got ${JSON.stringify(r)}`);
});
await check('K5: adapter.getLastExport() returns date string written by K1 export', async () => {
  const d = await compAdapter.getLastExport();
  assert.ok(typeof d === 'string' && d.length > 0,
    `getLastExport must return non-empty string; got ${JSON.stringify(d)}`);
});

/* ════════════════════════════════════════════════════════════════════
   L — readAndValidate + applyImport round-trip via adapter arity bridge (7)
   L1: readAndValidate(fileLike) → sanitized.schemaVersion===2
   L2: sanitizedTasks === sanitized (exact reference)
   L3: sanitizedPrefs deepEquals {}
   L4: applyImport(sanitizedTasks, sanitizedPrefs) → ok:true (exact backup-ui.js call)
   L5: ACTIVATION_KEYS.DATA === JSON.stringify(sanitized) after L4
   L6: repo.get() after L4 → ok:true
   L7: repo.get().data deepEquals sanitized (byte-compat across writer/reader)
════════════════════════════════════════════════════════════════════ */
section('L-readandvalidate-applyimport');

/* Build valid v2 backup file; catalogVersion:1 matches service catalog.
   readAndValidate requires all 9 canonical fields in the data envelope. */
const lv2Data = {
  schemaVersion: 2,
  state:             [],
  prefs:             { viewMode: 'today', roomFilter: '', onboarded: true },
  userZones:         [],
  userTasks:         [],
  completionEvents:  [],
  overrides:         {},
  recentSearches:    [],
  meta:              {},
};
const lEnvelope   = buildBackup(lv2Data, { exportedAt: NOW, catalogVersion: 1, appBuild: 'v-test' });
const lBackupJson = JSON.stringify(lEnvelope);
const lBackupFile = { size: lBackupJson.length, _content: lBackupJson };

/* Capture pre-import DATA for M2 — DATA = kPayloadStr at this point */
const mPreImportData = compAdp.getItem(ACTIVATION_KEYS.DATA);

const lValidated    = await compAdapter.readAndValidate(lBackupFile);
const lImportResult = await compAdapter.applyImport(lValidated.sanitizedTasks, lValidated.sanitizedPrefs);
const lRepoResult   = await compRepo.get();

await check('L1: adapter.readAndValidate(fileLike) → resolves; sanitized.schemaVersion===2', async () => {
  assert.equal(lValidated.sanitized.schemaVersion, 2,
    `sanitized.schemaVersion must be 2; got ${lValidated.sanitized?.schemaVersion}`);
});
await check('L2: result.sanitizedTasks === result.sanitized (exact object reference; arity-bridge carrier)', async () => {
  assert.strictEqual(lValidated.sanitizedTasks, lValidated.sanitized,
    'sanitizedTasks must be the exact same object reference as sanitized');
});
await check('L3: result.sanitizedPrefs deepEquals {} (inert carrier field)', async () => {
  assert.deepEqual(lValidated.sanitizedPrefs, {});
});
await check('L4: adapter.applyImport(sanitizedTasks, sanitizedPrefs) → ok:true (second arg silently dropped by adapter)', async () => {
  assert.equal(lImportResult.ok, true,
    `applyImport must succeed: ${lImportResult.message}`);
});
await check('L5: ACTIVATION_KEYS.DATA === JSON.stringify(sanitized) after L4', async () => {
  assert.equal(
    compAdp.getItem(ACTIVATION_KEYS.DATA),
    JSON.stringify(lValidated.sanitized),
    'DATA in adapter must equal JSON.stringify(sanitized) after applyImport',
  );
});
await check('L6: repo.get() on shared adapter after L4 → ok:true', async () => {
  assert.equal(lRepoResult.ok, true,
    `repo.get() must succeed after applyImport: ${lRepoResult.message ?? lRepoResult.code}`);
});
await check('L7: repo.get().data deepEquals sanitized (V2Repository reader and V2BackupService writer byte-compatible)', async () => {
  assert.deepEqual(lRepoResult.data, lValidated.sanitized,
    'repo.get().data must deepEqual the sanitized envelope from readAndValidate');
});

/* ════════════════════════════════════════════════════════════════════
   M — applyUndo via adapter; V2Repository sees restored state (5)
   M1: applyUndo() after L4's import → ok:true
   M2: ACTIVATION_KEYS.DATA restored to pre-import bytes (= kPayloadStr)
   M3: repo.get() after M1 → ok:true; data equals pre-import object
   M4: LIVE_STATE.generation = post-import generation + 1
   M5: applyUndo() with no snapshot (fresh service) → ok:false
════════════════════════════════════════════════════════════════════ */
section('M-applyundo');

const mPostImportGen = JSON.parse(compAdp.getItem(ACTIVATION_KEYS.LIVE_STATE)).generation;
const mUndoResult    = await compAdapter.applyUndo();
const mRepoResult    = await compRepo.get();

await check('M1: adapter.applyUndo() after L4\'s import → ok:true', async () => {
  assert.equal(mUndoResult.ok, true,
    `applyUndo must succeed: ${mUndoResult.message}`);
});
await check('M2: ACTIVATION_KEYS.DATA restored to pre-import bytes', async () => {
  assert.equal(
    compAdp.getItem(ACTIVATION_KEYS.DATA),
    mPreImportData,
    `DATA must be restored to pre-import bytes; currently: ${compAdp.getItem(ACTIVATION_KEYS.DATA)}`,
  );
});
await check('M3: repo.get() after undo → ok:true; data equals pre-import state', async () => {
  assert.equal(mRepoResult.ok, true,
    `repo.get() must succeed after undo: ${mRepoResult.message ?? mRepoResult.code}`);
  assert.deepEqual(mRepoResult.data, JSON.parse(mPreImportData),
    'repo.get().data must equal the pre-import data');
});
await check('M4: LIVE_STATE.generation = post-import generation + 1 (undo is a forward mutation)', async () => {
  const ls = JSON.parse(compAdp.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, mPostImportGen + 1,
    `generation must be ${mPostImportGen + 1}; got ${ls.generation}`);
});
await check('M5: adapter.applyUndo() with no snapshot (fresh service) → ok:false', async () => {
  const freshAdp = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const freshSvc = createV2BackupService({
    adapter:      freshAdp,
    catalog:      { tasks: [], zones: [], catalogVersion: 1 },
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   { readAsText: f => Promise.resolve(f._content ?? '') },
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: makeAdapter(),
    lock:         makeLock(),
    digestFn:     testDigest,
    timeoutMs:    0,
  });
  const r = await createV2BackupAdapter(freshSvc).applyUndo();
  assert.equal(r.ok, false,
    `applyUndo with no snapshot must return ok:false; got ${JSON.stringify(r)}`);
});

/* ════════════════════════════════════════════════════════════════════
   N — SESSION_RECOVERED_KEY interrupted-session recovery notice (3)
   N1: SESSION_RECOVERED_KEY='1', no staging, no recovery
       → visible:true, showDownload:false, showUndo:false
   N2: exact message string (verbatim from v2-backup-service.js:403)
   N3: priority guard — hadInterrupt + rollback-failed staging → rollback-failed wins
════════════════════════════════════════════════════════════════════ */
section('N-session-recovered-key');

/* N1/N2: hadInterrupt path only */
{
  const nSessionStore = makeAdapter({ [SESSION_RECOVERED_KEY]: '1' });
  const nSvc = createV2BackupService({
    adapter:      makeAdapter(),
    catalog:      { tasks: [], zones: [], catalogVersion: 1 },
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   { readAsText: () => Promise.resolve('{}') },
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: nSessionStore,
    lock:         makeLock(),
    digestFn:     testDigest,
    timeoutMs:    0,
  });
  const nState = nSvc.getRecoveryNoticeState();

  await check('N1: SESSION_RECOVERED_KEY="1", no staging, no recovery → visible:true, showDownload:false, showUndo:false', async () => {
    assert.equal(nState.visible,      true,  'visible must be true');
    assert.equal(nState.showDownload, false, 'showDownload must be false');
    assert.equal(nState.showUndo,     false, 'showUndo must be false');
  });
  await check('N2: exact interrupted-session message (verbatim from v2-backup-service.js:403)', async () => {
    assert.equal(
      nState.message,
      'HomeTask detected an incomplete import and restored your previous data safely.',
      `message mismatch; got: "${nState.message}"`,
    );
  });
}

/* N3: priority guard — hadInterrupt + rollback-failed → rollback-failed wins */
{
  const n3Session = makeAdapter({ [SESSION_RECOVERED_KEY]: '1' });
  const n3Adp     = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'failed', failCode: 'rollback-failed',
      transactionId: 'n3-tx', startedAt: NOW,
    }),
  });
  const n3Svc = createV2BackupService({
    adapter:      n3Adp,
    catalog:      { tasks: [], zones: [], catalogVersion: 1 },
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   { readAsText: () => Promise.resolve('{}') },
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: n3Session,
    lock:         makeLock(),
    digestFn:     testDigest,
    timeoutMs:    0,
  });
  const n3State = n3Svc.getRecoveryNoticeState();

  await check('N3: hadInterrupt + rollback-failed staging → rollback-failed wins (showUndo:true trumps hadInterrupt path)', async () => {
    assert.equal(n3State.visible,  true,
      'visible must be true');
    assert.equal(n3State.showUndo, true,
      'showUndo must be true — rollback-failed (priority 2) must take precedence over hadInterrupt (priority 3)');
  });
}

/* ════════════════════════════════════════════════════════════════════
   R — Deferred local synthetic undo/UI controller contract (6)
   R1: pending state while applyUndoFn is unresolved
   R2: success state after deferred resolves (ok:true)
   R3: error state on ok:false
   R4: cancel before execute → zero service calls; status==="cancelled"
   R5: settled-call idempotency → no second service invocation
   R6: structural: makeUndoController.toString() has no localStorage/sessionStorage
════════════════════════════════════════════════════════════════════ */
section('R-deferred-undo-controller');

/* Local synthetic controller — defined entirely in this test file.
   No src/ imports.  Wraps any applyUndoFn (async).                 */
function makeUndoController(applyUndoFn) {
  let status    = 'idle'; // 'idle' | 'pending' | 'success' | 'error' | 'cancelled'
  let callCount = 0;
  let settled   = false;

  async function execute() {
    if (settled || status === 'cancelled') return { skipped: true };
    status = 'pending';
    callCount++;
    const result = await applyUndoFn();
    status  = result.ok ? 'success' : 'error';
    settled = true;
    return result;
  }

  function cancel() {
    if (!settled && status === 'idle') status = 'cancelled';
  }

  return { execute, cancel, getStatus: () => status, getCallCount: () => callCount };
}

/* R1/R2: deferred applyUndoFn — observe pending then success */
{
  const r12Defer = makeDeferred();
  const r12Ctrl  = makeUndoController(async () => {
    await r12Defer.promise;
    return { ok: true, message: 'undo ok' };
  });
  const r12ExecP = r12Ctrl.execute();  // status='pending' set synchronously before first await
  await Promise.resolve();             // yield one microtask — applyUndoFn now suspended at deferred

  await check('R1: controller.getStatus()==="pending" while applyUndoFn is unresolved', async () => {
    assert.equal(r12Ctrl.getStatus(), 'pending',
      `status must be "pending" before deferred resolves; got "${r12Ctrl.getStatus()}"`);
  });

  r12Defer.resolve();
  await r12ExecP;

  await check('R2: after deferred resolves → getStatus()==="success"', async () => {
    assert.equal(r12Ctrl.getStatus(), 'success',
      `status must be "success" after ok:true result; got "${r12Ctrl.getStatus()}"`);
  });
}

/* R3: ok:false → status "error" */
{
  const r3Ctrl = makeUndoController(
    async () => ({ ok: false, code: 'no-snapshot', message: 'no snapshot' }),
  );
  await r3Ctrl.execute();

  await check('R3: applyUndoFn returns ok:false → controller.getStatus()==="error"', async () => {
    assert.equal(r3Ctrl.getStatus(), 'error',
      `status must be "error" on ok:false; got "${r3Ctrl.getStatus()}"`);
  });
}

/* R4: cancel before execute → zero service calls */
{
  let r4Calls = 0;
  const r4Ctrl = makeUndoController(async () => { r4Calls++; return { ok: true, message: '' }; });
  r4Ctrl.cancel();
  await r4Ctrl.execute();

  await check('R4: cancel() before execute() → zero service calls; getStatus()==="cancelled"', async () => {
    assert.equal(r4Calls, 0,
      `service must not be invoked after cancel; got ${r4Calls} call(s)`);
    assert.equal(r4Ctrl.getStatus(), 'cancelled',
      `status must be "cancelled"; got "${r4Ctrl.getStatus()}"`);
  });
}

/* R5: settled-call idempotency */
{
  let r5Calls = 0;
  const r5Ctrl = makeUndoController(async () => { r5Calls++; return { ok: true, message: '' }; });
  await r5Ctrl.execute();              // first call → success; r5Calls = 1
  const r5AfterFirst = r5Calls;
  await r5Ctrl.execute();              // second call → skipped (settled); r5Calls unchanged

  await check('R5: execute() after settled → no second service call; callCount unchanged', async () => {
    assert.equal(r5Calls, r5AfterFirst,
      `service callCount must remain ${r5AfterFirst} after second execute; got ${r5Calls}`);
    assert.equal(r5Ctrl.getCallCount(), 1,
      `controller.getCallCount() must be 1; got ${r5Ctrl.getCallCount()}`);
  });
}

/* R6: structural zero-storage guard */
await check('R6: makeUndoController.toString() contains no localStorage or sessionStorage', async () => {
  const src = makeUndoController.toString();
  assert.ok(!src.includes('localStorage'),
    'controller must not reference localStorage');
  assert.ok(!src.includes('sessionStorage'),
    'controller must not reference sessionStorage');
});

/* ════════════════════════════════════════════════════════════════════
   P — Shared-lock contention: repo.update(fn) vs adapter.applyImport() (3)
   Microtask barrier (nextTick after update() initiation) ensures repo.update's
   deferred lock enqueue (via _queue.then → _applyMutation → lock.runExclusive)
   lands as slot 1 BEFORE applyImport's synchronous lock.runExclusive (slot 2).
   FIFO drain: update reads current committed data (D0), commits mutation result
   (pPayloadA); applyImport then commits pPayloadB last.
   P1: holder held → repo.update(fn) initiated → nextTick → slot 1 enqueued →
       adapter.applyImport(B) initiated → slot 2 enqueued → holder released →
       update reads D0 prefs, writes pPayloadA; import writes pPayloadB (last) →
       both ok:true; mutateFn input proves D0 prefs read; DATA = JSON.stringify(B)
   P2: repo.get() → ok:true; data deepEquals pPayloadB (import is last writer)
   P3: LIVE_STATE.generation = preGen+2 (each write advances once)
════════════════════════════════════════════════════════════════════ */
section('P-shared-lock-contention');

{
  const pAdp  = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const pLock    = makeLock();
  const pRepo    = makeRepo(pAdp, pLock);
  const pSvc     = createV2BackupService({
    adapter:      pAdp,
    catalog:      { tasks: [], zones: [], catalogVersion: 1 },
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   { readAsText: f => Promise.resolve(f._content ?? '') },
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: makeAdapter(),
    lock:         pLock,   // ← shared with pRepo
    digestFn:     testDigest,
    timeoutMs:    0,
  });
  const pAdapter = createV2BackupAdapter(pSvc);
  const pPreGen  = JSON.parse(pAdp.getItem(ACTIVATION_KEYS.LIVE_STATE)).generation; // 0

  /* pPayloadB: constant payload written by applyImport (slot 2 — commits last). */
  const pPayloadB = { schemaVersion: 2, prefs: { viewMode: 'today', roomFilter: 'kitchen' }, state: [] };

  /* pMutateFn: genuinely data-dependent — reads the committed value received
     inside the exclusive lock, captures it for assertion, then derives the new
     value by overriding only viewMode and roomFilter from the current prefs.  */
  let pMutationInput;
  const pMutateFn = d => {
    pMutationInput = d;   // d = JSON.parse(current DATA) read post-lock inside lock
    return { ...d, prefs: { ...d.prefs, viewMode: 'home', roomFilter: 'utility' } };
  };

  /* Holder seizes lock; callers enqueue behind it in controlled order. */
  const pDefer  = makeDeferred();
  const pHolder = pLock.runExclusive('p-holder', () => pDefer.promise);
  await nextTick(); await nextTick(); // holder is now inside runExclusive

  const pRepoP = pRepo.update(pMutateFn);  // schedules _applyMutation via _queue.then;
                                            // lock NOT yet enqueued synchronously
  await nextTick();                         // drains _queue.then → _applyMutation calls
                                            // lock.runExclusive → slot 1 enqueued
  const pImportP = pAdapter.applyImport(pPayloadB); // synchronous path → lock.runExclusive
                                                     // → slot 2 enqueued
  await nextTick(); // ensure both fully behind holder

  pDefer.resolve();
  await pHolder;
  const [pRepoResult, pImportResult] = await Promise.all([pRepoP, pImportP]);

  await check('P1: repo.update(fn) slot 1 + adapter.applyImport(B) slot 2 → both ok:true; mutateFn received D0 prefs (read-modify-write proved); DATA = JSON.stringify(pPayloadB) (import commits last)', async () => {
    assert.equal(pRepoResult.ok,   true,
      `repo.update must succeed: ${JSON.stringify(pRepoResult)}`);
    assert.equal(pImportResult.ok, true,
      `applyImport must succeed: ${JSON.stringify(pImportResult)}`);
    // Prove the mutateFn read the committed D0 data (viewMode:'today', roomFilter:'')
    // rather than any stale or post-import value — this is the read-modify-write proof.
    assert.equal(pMutationInput.prefs.viewMode, 'today',
      `mutateFn must receive D0's viewMode 'today'; got '${pMutationInput?.prefs?.viewMode}'`);
    assert.equal(pMutationInput.prefs.roomFilter, '',
      `mutateFn must receive D0's roomFilter ''; got '${pMutationInput?.prefs?.roomFilter}'`);
    assert.equal(
      pAdp.getItem(ACTIVATION_KEYS.DATA),
      JSON.stringify(pPayloadB),
      'DATA must equal JSON.stringify(pPayloadB) — applyImport (slot 2) committed last',
    );
  });
  await check('P2: repo.get() after shared-lock drain → ok:true; data deepEquals pPayloadB (import is last writer)', async () => {
    const r = await pRepo.get();
    assert.equal(r.ok, true,
      `repo.get() must succeed: ${r.message ?? r.code}`);
    assert.deepEqual(r.data, pPayloadB,
      'repo.get().data must deepEqual pPayloadB');
  });
  await check('P3: LIVE_STATE.generation = preGen+2 (repo.update and applyImport each advance once)', async () => {
    const ls = JSON.parse(pAdp.getItem(ACTIVATION_KEYS.LIVE_STATE));
    assert.equal(ls.generation, pPreGen + 2,
      `generation must be ${pPreGen + 2}; got ${ls.generation}`);
  });
}

/* ── Results ─────────────────────────────────────────────────────── */
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  ✗  ${f.label}\n     ${f.error}`);
  process.exit(1);
}
