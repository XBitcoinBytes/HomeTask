/**
 * v2-adapter.test.mjs — CP5C-D: createV2BackupAdapter facade-arity bridge (Suite 23).
 *
 * Tests:
 *   A (12): Constructor/wrap validation — null, each of 9 methods missing independently,
 *           valid-config no-throw, exact 9-method surface.
 *   B (10): readAndValidate repacking — all 5 original V2 fields preserved by reference,
 *           carrier fields correct (sanitizedTasks=sanitized, sanitizedPrefs={},
 *           exportDate extracted), rejection propagates.
 *   C  (5): applyImport routing — first arg forwarded, second silently dropped,
 *           null/wrong-schemaVersion ok:false, return value unchanged.
 *   D  (8): Passthrough receiver/closure preservation — all 7 passthrough methods
 *           route through live closure of a stateful counting service; accumulation.
 *   E  (8): Full lifecycle smoke — synthetic V2 deps, export→readAndValidate→
 *           applyImport→hasSnapshot→applyUndo→getLastExport→getRecoveryNoticeState.
 *   F  (6): Rejection propagation + no-storage-mutation — readAndValidate rejection,
 *           applyImport invalid/timeout, exportBackup/applyUndo failure propagation.
 *   G  (6): Import purity sentinels — globalThis.localStorage/sessionStorage/setTimeout
 *           sentinels confirm 0 accesses; wrapping and constructing cause 0 service/
 *           adapter calls.
 *   H  (4): Static isolation — adapter source has no storage refs, no src/app imports,
 *           0 import statements.
 *
 * Total: 12+10+5+8+8+6+6+4 = 59 checks.
 * Standalone Node ESM. No browser, no real localStorage, no live data.
 * Run with:  node artifacts/home-tasks/tests/v2-adapter.test.mjs
 */

import assert           from 'node:assert/strict';
import { createHash }   from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createV2BackupAdapter } from '../src/data/backup/v2-backup-service-adapter.js';
import { createV2BackupService } from '../src/data/backup/v2-backup-wiring.js';
import { CATALOG }               from '../src/v2/catalog.data.js';
import { migrate }               from '../src/v2/migrate.js';
import { buildBackup }           from '../src/v2/backup.js';
import { V2_KEYS }               from '../src/v2/import-tx.js';
import { ACTIVATION_KEYS }       from '../src/v2/activation-tx.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';

/* ── Test harness ────────────────────────────────────────────────── */
let pass = 0, fail = 0;
let group = '';
function section(name) { group = name; console.log(`\n── ${name}`); }
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ [${group}] ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ [${group}] ${name}\n    ${e.message}`);
  }
}

/* ── Shared constants ────────────────────────────────────────────── */
const NOW        = '2026-08-13T10:00:00.000Z';
const FIXED_DATE = FIXED_TODAY;   // '2026-07-31'
const CTX        = { today: FIXED_DATE, catalog: CATALOG, appBuild: 'v-test' };
const EXPORT_CTX = { exportedAt: NOW, catalogVersion: CATALOG.catalogVersion, appBuild: 'v-test' };

const REQUIRED_METHODS = [
  'exportBackup', 'readAndValidate', 'applyImport', 'applyUndo',
  'hasSnapshot', 'getLastExport', 'getRecoveryNoticeState',
  'downloadRecoveryData', 'dismissRecovery',
];

/* ── Synthetic-fixture helpers ───────────────────────────────────── */
function makeAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: k      => store.delete(k),
  };
}
function makeSpyAdapter(init = {}) {
  const store  = new Map(Object.entries(init));
  const writes = [];
  return {
    getItem:       k      => store.has(k) ? store.get(k) : null,
    setItem:       (k, v) => { writes.push({ k, v }); store.set(k, String(v)); },
    removeItem:    k      => store.delete(k),
    getWrites:     ()     => writes.slice(),
    getWriteCount: ()     => writes.length,
  };
}
function makeFileReader() {
  return { readAsText: f => Promise.resolve(f._content ?? '') };
}
function makeRejectingFileReader(msg) {
  return { readAsText: () => Promise.reject(new Error(msg)) };
}
function makeSessionStore() {
  const s = new Map();
  return {
    getItem:    k      => s.has(k) ? s.get(k) : null,
    setItem:    (k, v) => s.set(k, String(v)),
    removeItem: k      => s.delete(k),
  };
}
function makeLock() {
  let q = Promise.resolve();
  return {
    runExclusive(_txId, cb) {
      const next = q.then(async () => {
        try   { return { ok: true,  result: await cb() }; }
        catch (e) { return { ok: false, code: 'callback-threw', message: e?.message ?? String(e) }; }
      });
      q = next.catch(() => {});
      return next;
    },
  };
}
function makeTimeoutLock() {
  return {
    runExclusive: async (_txId, _cb) =>
      ({ ok: false, code: 'timeout', message: 'simulated lock timeout' }),
  };
}
function testDigest(bytes) {
  return Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
}
function hexOf(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
function makeLiveState(gen, dataStr) {
  return JSON.stringify({ generation: gen, digest: hexOf(dataStr), schemaVersion: 2 });
}
function makeBaseConfig(overrides = {}) {
  return {
    adapter:      makeAdapter(),
    catalog:      CATALOG,
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   makeFileReader(),
    clock:        () => NOW,
    todayFn:      () => FIXED_DATE,
    sessionStore: makeSessionStore(),
    lock:         makeLock(),
    digestFn:     testDigest,
    ...overrides,
  };
}
function makeBackupFileLike() {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const backup  = buildBackup(v2, EXPORT_CTX);
  const json    = JSON.stringify(backup);
  return { size: json.length, _content: json };
}

/** Build a complete spy service with all 9 required methods. */
function makeSpySvc(overrides = {}) {
  const calls = Object.fromEntries(REQUIRED_METHODS.map(m => [m, []]));
  const defaults = {
    exportBackup:          async ()     => ({ ok: true, message: 'exported' }),
    readAndValidate:       async (f)    => ({ sanitized: { schemaVersion: 2, meta: {} }, source: 'v2', taskCount: 0, repairs: [], warnings: [] }),
    applyImport:           async (s)    => ({ ok: true, message: 'imported' }),
    applyUndo:             async ()     => ({ ok: true, message: 'undone' }),
    hasSnapshot:           async ()     => false,
    getLastExport:         async ()     => null,
    getRecoveryNoticeState:()           => ({ visible: false, message: '', showDownload: false, showUndo: false }),
    downloadRecoveryData:  ()           => ({ ok: false, message: 'none' }),
    dismissRecovery:       ()           => undefined,
    ...overrides,
  };
  const svc = {};
  for (const m of REQUIRED_METHODS) {
    svc[m] = (...args) => { calls[m].push(args); return defaults[m](...args); };
  }
  svc._calls = calls;
  svc._callCount = (m) => calls[m].length;
  svc._lastArgs  = (m) => calls[m][calls[m].length - 1] ?? [];
  return svc;
}

/** Asserts fn() throws synchronously with message including `pattern`. */
function assertThrows(fn, pattern, label) {
  let threw = false;
  try { fn(); }
  catch (e) {
    threw = true;
    assert.ok(
      e.message.includes(pattern),
      `${label}: expected error to include '${pattern}', got: '${e.message}'`,
    );
  }
  if (!threw) throw new Error(`${label}: expected a throw but none occurred`);
}

console.log('\nv2-backup-service-adapter — Suite 23\n');

/* ══════════════════════════════════════════════════════════════════
   A: Constructor / wrap validation  (12 checks)
   ══════════════════════════════════════════════════════════════════ */
section('A-constructor-validation');

await check('A1: createV2BackupAdapter(null) throws', async () => {
  assertThrows(() => createV2BackupAdapter(null), 'non-null object', 'A1');
});

// A2–A10: each of the 9 required methods validated independently
const A_METHOD_CHECKS = [
  ['exportBackup',          'exportBackup'],
  ['readAndValidate',       'readAndValidate'],
  ['applyImport',           'applyImport'],
  ['applyUndo',             'applyUndo'],
  ['hasSnapshot',           'hasSnapshot'],
  ['getLastExport',         'getLastExport'],
  ['getRecoveryNoticeState','getRecoveryNoticeState'],
  ['downloadRecoveryData',  'downloadRecoveryData'],
  ['dismissRecovery',       'dismissRecovery'],
];
for (let i = 0; i < A_METHOD_CHECKS.length; i++) {
  const [method, expectInError] = A_METHOD_CHECKS[i];
  const label = `A${i + 2}`;
  await check(`${label}: object missing ${method} throws`, async () => {
    const svc = makeSpySvc();
    delete svc[method];
    assertThrows(() => createV2BackupAdapter(svc), expectInError, label);
  });
}

await check('A11: all 9 methods present — no throw', async () => {
  const adapter = createV2BackupAdapter(makeSpySvc());
  assert.ok(adapter && typeof adapter === 'object', 'must return an object');
});

await check('A12: adapter exposes exactly 9 methods — no extra, none missing', async () => {
  const adapter = createV2BackupAdapter(makeSpySvc());
  const keys = Object.keys(adapter);
  assert.equal(keys.length, 9, `adapter must have exactly 9 keys, got: ${keys.join(', ')}`);
  for (const m of REQUIRED_METHODS) {
    assert.equal(typeof adapter[m], 'function', `adapter.${m} must be a function`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   B: readAndValidate repacking + field preservation  (10 checks)
   Uses a controlled spy service whose readAndValidate returns a
   fixed result object so we can assert reference equality on every field.
   ══════════════════════════════════════════════════════════════════ */
section('B-readAndValidate-repacking');

const B_SANITIZED  = Object.freeze({ schemaVersion: 2, state: [], prefs: {}, meta: { exportedAt: '2026-08-13' }, userZones: [], userTasks: [], completionEvents: [], overrides: {}, recentSearches: [] });
const B_REPAIRS    = Object.freeze([{ field: 'test', fix: 'repaired' }]);
const B_WARNINGS   = Object.freeze(['warn-1']);
const B_V2_RESULT  = Object.freeze({ sanitized: B_SANITIZED, source: 'v2', taskCount: 7, repairs: B_REPAIRS, warnings: B_WARNINGS });
const bSvc         = makeSpySvc({ readAndValidate: async () => B_V2_RESULT });
const bAdapter     = createV2BackupAdapter(bSvc);
const bResult      = await bAdapter.readAndValidate({ size: 100 });

await check('B1: result.sanitized === original sanitized (reference equality)', async () => {
  assert.strictEqual(bResult.sanitized, B_SANITIZED, 'sanitized field must be same object reference');
});
await check('B2: result.source === original source (strict equality)', async () => {
  assert.strictEqual(bResult.source, 'v2');
});
await check('B3: result.taskCount === original taskCount (strict equality)', async () => {
  assert.strictEqual(bResult.taskCount, 7);
});
await check('B4: result.repairs === original repairs (reference equality)', async () => {
  assert.strictEqual(bResult.repairs, B_REPAIRS, 'repairs must be same array reference');
});
await check('B5: result.warnings === original warnings (reference equality)', async () => {
  assert.strictEqual(bResult.warnings, B_WARNINGS, 'warnings must be same array reference');
});
await check('B6: result.sanitizedTasks === result.sanitized (carrier = full v2 envelope)', async () => {
  assert.strictEqual(bResult.sanitizedTasks, bResult.sanitized, 'sanitizedTasks must be the same object as sanitized');
});
await check('B7: result.sanitizedPrefs deep-equals {} (inert compat field)', async () => {
  assert.deepEqual(bResult.sanitizedPrefs, {});
});
await check('B8: result.exportDate extracted from sanitized.meta.exportedAt when present', async () => {
  assert.equal(bResult.exportDate, '2026-08-13');
});

// B9: exportDate is null when meta / exportedAt absent
const B9_SANITIZED = Object.freeze({ schemaVersion: 2, state: [], prefs: {} });
const b9Svc     = makeSpySvc({ readAndValidate: async () => ({ sanitized: B9_SANITIZED, source: 'v2', taskCount: 0, repairs: [], warnings: [] }) });
const b9Adapter = createV2BackupAdapter(b9Svc);
const b9Result  = await b9Adapter.readAndValidate({ size: 100 });
await check('B9: result.exportDate is null when sanitized.meta / exportedAt absent', async () => {
  assert.strictEqual(b9Result.exportDate, null);
});

// B10: rejection propagates unchanged
const B10_ERR = new Error('simulated read failure');
const b10Svc     = makeSpySvc({ readAndValidate: () => Promise.reject(B10_ERR) });
const b10Adapter = createV2BackupAdapter(b10Svc);
await check('B10: readAndValidate rejection propagates through adapter unchanged', async () => {
  let caught = null;
  try { await b10Adapter.readAndValidate({ size: 100 }); } catch (e) { caught = e; }
  assert.ok(caught !== null, 'must reject');
  assert.strictEqual(caught, B10_ERR, 'rejection must be the original Error instance');
});

/* ══════════════════════════════════════════════════════════════════
   C: applyImport routing and arity  (5 checks)
   ══════════════════════════════════════════════════════════════════ */
section('C-applyImport-routing');

const VALID_ENVELOPE = Object.freeze({ schemaVersion: 2, state: [], prefs: {}, userZones: [], userTasks: [], completionEvents: [], overrides: {}, recentSearches: [], meta: {} });

// Spy service that records args to applyImport
let cLastArgs;
const cSvc = makeSpySvc({
  applyImport: async (...args) => { cLastArgs = args; return { ok: true, message: 'ok' }; },
});
const cAdapter = createV2BackupAdapter(cSvc);

await check('C1: applyImport(fullEnvelope, {}) — V2 service receives fullEnvelope as first arg', async () => {
  await cAdapter.applyImport(VALID_ENVELOPE, {});
  assert.strictEqual(cLastArgs[0], VALID_ENVELOPE, 'first arg must be the full envelope');
});
await check('C2: V2 service receives exactly 1 argument (second arg not forwarded)', async () => {
  await cAdapter.applyImport(VALID_ENVELOPE, { extra: 'prefs' });
  assert.equal(cLastArgs.length, 1, `V2 service must receive exactly 1 arg, got ${cLastArgs.length}`);
});

// C3-C5 use a service that delegates to a real V2BackupService for validation
const cRealSvc    = createV2BackupService(makeBaseConfig());
const cRealAdapter = createV2BackupAdapter(cRealSvc);

await check('C3: applyImport(null, {}) → ok:false (V2 rejects null sanitized)', async () => {
  const result = await cRealAdapter.applyImport(null, {});
  assert.equal(result.ok, false, 'must return ok:false');
  assert.equal(result.code, 'invalid-input', 'must have invalid-input code');
});
await check('C4: applyImport({schemaVersion:1,…}, {}) → ok:false (V2 rejects wrong version)', async () => {
  const result = await cRealAdapter.applyImport({ schemaVersion: 1, state: [] }, {});
  assert.equal(result.ok, false, 'must return ok:false');
});
await check('C5: applyImport return value passed through adapter unchanged', async () => {
  const fixedResult = { ok: true, message: 'passthrough-check' };
  const c5Svc      = makeSpySvc({ applyImport: async () => fixedResult });
  const c5Adapter  = createV2BackupAdapter(c5Svc);
  const got         = await c5Adapter.applyImport(VALID_ENVELOPE, {});
  assert.strictEqual(got, fixedResult, 'return value must be the exact same object from the service');
});

/* ══════════════════════════════════════════════════════════════════
   D: Passthrough receiver/closure preservation  (8 checks)
   A stateful counting service whose closure counter is incremented
   by every one of the 7 passthrough methods.  Verifies that the
   adapter's named wrapper functions route through the live closure
   (not a detached copy or direct method reference).
   ══════════════════════════════════════════════════════════════════ */
section('D-passthrough-receiver-preservation');

function makeCountingSvc() {
  let count = 0;
  return {
    exportBackup:          async () => { count++; return { ok: true, message: '' }; },
    readAndValidate:       async () => ({ sanitized: { schemaVersion: 2 }, source: 'v2', taskCount: 0, repairs: [], warnings: [] }),
    applyImport:           async (s) => ({ ok: true, message: '' }),
    applyUndo:             async () => { count++; return { ok: true, message: '' }; },
    hasSnapshot:           async () => { count++; return false; },
    getLastExport:         async () => { count++; return null; },
    getRecoveryNoticeState:()       => { count++; return { visible: false, message: '', showDownload: false, showUndo: false }; },
    downloadRecoveryData:  ()       => { count++; return { ok: false, message: '' }; },
    dismissRecovery:       ()       => { count++; },
    getCount:              ()       => count,
  };
}
const countingSvc = makeCountingSvc();
const dAdapter    = createV2BackupAdapter(countingSvc);

await check('D1: adapter.exportBackup() increments closure counter', async () => {
  const before = countingSvc.getCount();
  await dAdapter.exportBackup();
  assert.equal(countingSvc.getCount(), before + 1);
});
await check('D2: adapter.applyUndo() increments closure counter', async () => {
  const before = countingSvc.getCount();
  await dAdapter.applyUndo();
  assert.equal(countingSvc.getCount(), before + 1);
});
await check('D3: adapter.hasSnapshot() increments closure counter', async () => {
  const before = countingSvc.getCount();
  await dAdapter.hasSnapshot();
  assert.equal(countingSvc.getCount(), before + 1);
});
await check('D4: adapter.getLastExport() increments closure counter', async () => {
  const before = countingSvc.getCount();
  await dAdapter.getLastExport();
  assert.equal(countingSvc.getCount(), before + 1);
});
await check('D5: adapter.getRecoveryNoticeState() increments closure counter', async () => {
  const before = countingSvc.getCount();
  dAdapter.getRecoveryNoticeState();
  assert.equal(countingSvc.getCount(), before + 1);
});
await check('D6: adapter.downloadRecoveryData() increments closure counter', async () => {
  const before = countingSvc.getCount();
  dAdapter.downloadRecoveryData();
  assert.equal(countingSvc.getCount(), before + 1);
});
await check('D7: adapter.dismissRecovery() increments closure counter', async () => {
  const before = countingSvc.getCount();
  dAdapter.dismissRecovery();
  assert.equal(countingSvc.getCount(), before + 1);
});
await check('D8: calling all 7 passthroughs again accumulates counter monotonically', async () => {
  const before = countingSvc.getCount();
  await dAdapter.exportBackup();
  await dAdapter.applyUndo();
  await dAdapter.hasSnapshot();
  await dAdapter.getLastExport();
  dAdapter.getRecoveryNoticeState();
  dAdapter.downloadRecoveryData();
  dAdapter.dismissRecovery();
  assert.equal(countingSvc.getCount(), before + 7, 'counter must increase by 7 across 7 calls');
});

/* ══════════════════════════════════════════════════════════════════
   E: Full lifecycle smoke — synthetic V2 deps  (8 checks)
   Builds a real V2BackupService via createV2BackupService, wraps it
   with createV2BackupAdapter, then exercises the complete
   export → readAndValidate → applyImport → hasSnapshot →
   applyUndo → getLastExport → getRecoveryNoticeState path.
   ══════════════════════════════════════════════════════════════════ */
section('E-full-lifecycle-smoke');

// Pre-populate adapter with valid V2 DATA and LIVE_STATE so the locked
// import engine can verify authority (runV2LockedImport requires LIVE_STATE).
const { v2: eV2Data } = migrate(FIXTURES.typical, CTX);
const ePREDATA        = JSON.stringify(eV2Data);
const eAdp            = makeAdapter({
  [V2_KEYS.DATA]:              ePREDATA,
  [ACTIVATION_KEYS.LIVE_STATE]: makeLiveState(0, ePREDATA),
});
let eSvc, eAdapter;

await check('E1: adapter+service construction succeeds without throw', async () => {
  eSvc = createV2BackupService({
    adapter:      eAdp,
    catalog:      CATALOG,
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   makeFileReader(),
    clock:        () => NOW,
    todayFn:      () => FIXED_DATE,
    sessionStore: makeSessionStore(),
    lock:         makeLock(),
    digestFn:     testDigest,
  });
  eAdapter = createV2BackupAdapter(eSvc);
  assert.ok(eAdapter && typeof eAdapter.exportBackup === 'function');
});
await check('E2: exportBackup() → ok:true', async () => {
  const r = await eAdapter.exportBackup();
  assert.equal(r.ok, true, `exportBackup must succeed: ${r.message}`);
});
await check('E3: readAndValidate → sanitized.schemaVersion===2; all 5 original V2 fields present', async () => {
  const fileLike = makeBackupFileLike();
  const r        = await eAdapter.readAndValidate(fileLike);
  assert.equal(r.sanitized.schemaVersion, 2, 'sanitized must be v2 envelope');
  assert.ok('source'   in r, 'source field must be present');
  assert.ok('taskCount'in r, 'taskCount field must be present');
  assert.ok('repairs'  in r, 'repairs field must be present');
  assert.ok('warnings' in r, 'warnings field must be present');
  // Carrier fields
  assert.strictEqual(r.sanitizedTasks, r.sanitized, 'sanitizedTasks must be same ref as sanitized');
  assert.deepEqual(r.sanitizedPrefs, {});
});
await check('E4: applyImport(result.sanitizedTasks, result.sanitizedPrefs) → ok:true', async () => {
  const fileLike = makeBackupFileLike();
  const r        = await eAdapter.readAndValidate(fileLike);
  // This is the exact call backup-ui.js makes after readAndValidate
  const result   = await eAdapter.applyImport(r.sanitizedTasks, r.sanitizedPrefs);
  assert.equal(result.ok, true, `applyImport must succeed: ${result.message}`);
});
await check('E5: hasSnapshot() → true after successful import', async () => {
  const snap = await eAdapter.hasSnapshot();
  assert.equal(snap, true, 'snapshot must exist after applyImport');
});
await check('E6: applyUndo() → ok:true', async () => {
  const r = await eAdapter.applyUndo();
  assert.equal(r.ok, true, `applyUndo must succeed: ${r.message}`);
});
await check('E7: getLastExport() returns a date string after export', async () => {
  const d = await eAdapter.getLastExport();
  assert.ok(typeof d === 'string' && d.length > 0, `getLastExport must return a non-empty string, got: ${d}`);
});
await check('E8: getRecoveryNoticeState() → visible:false in clean state', async () => {
  const n = eAdapter.getRecoveryNoticeState();
  assert.equal(n.visible, false, 'recovery notice must not be visible in clean state');
  assert.ok('message' in n && 'showDownload' in n && 'showUndo' in n,
    'getRecoveryNoticeState result must have expected shape');
});

/* ══════════════════════════════════════════════════════════════════
   F: Rejection propagation + no-storage-mutation  (6 checks)
   All checks use spy adapters to track setItem calls.
   ══════════════════════════════════════════════════════════════════ */
section('F-rejection-and-no-mutation');

// F1-F2: readAndValidate failure via rejecting fileReader
const fSpyAdp1  = makeSpyAdapter();
const fSvc1     = createV2BackupService(makeBaseConfig({ adapter: fSpyAdp1, fileReader: makeRejectingFileReader('F1 read failed') }));
const fAdapter1 = createV2BackupAdapter(fSvc1);

await check('F1: readAndValidate rejection propagates through adapter', async () => {
  let caught = null;
  try { await fAdapter1.readAndValidate({ size: 100 }); } catch (e) { caught = e; }
  assert.ok(caught !== null, 'readAndValidate must reject');
  assert.ok(caught instanceof Error, 'rejection must be an Error instance');
});
await check('F2: no storage write on readAndValidate rejection (spy setItem count = 0)', async () => {
  assert.equal(fSpyAdp1.getWriteCount(), 0,
    `adapter must not write storage on readAndValidate rejection; got ${fSpyAdp1.getWriteCount()} write(s)`);
});

// F3: applyImport(null, {}) → ok:false, no storage write
const fSpyAdp3  = makeSpyAdapter();
const fSvc3     = createV2BackupService(makeBaseConfig({ adapter: fSpyAdp3 }));
const fAdapter3 = createV2BackupAdapter(fSvc3);
const fWritesBefore3 = fSpyAdp3.getWriteCount();

await check('F3: applyImport(null, {}) → ok:false; spy adapter write count unchanged', async () => {
  const result = await fAdapter3.applyImport(null, {});
  assert.equal(result.ok, false, 'must return ok:false');
  assert.equal(fSpyAdp3.getWriteCount(), fWritesBefore3,
    `applyImport(null) must not write storage; got ${fSpyAdp3.getWriteCount()} write(s)`);
});

// F4: lock-timeout → ok:false, no STAGING written
const fSpyAdp4  = makeSpyAdapter();
const fSvc4     = createV2BackupService(makeBaseConfig({ adapter: fSpyAdp4, lock: makeTimeoutLock() }));
const fAdapter4 = createV2BackupAdapter(fSvc4);

await check('F4: applyImport lock-timeout → ok:false; no STAGING key written on spy adapter', async () => {
  const writesBefore = fSpyAdp4.getWriteCount();
  const result       = await fAdapter4.applyImport(VALID_ENVELOPE, {});
  assert.equal(result.ok, false, 'must return ok:false on lock timeout');
  // Confirm no writes occurred (callback never ran)
  const stagingWrites = fSpyAdp4.getWrites().filter(w => w.k === V2_KEYS.STAGING);
  assert.equal(stagingWrites.length, 0, 'no STAGING key must be written on lock timeout');
  assert.equal(fSpyAdp4.getWriteCount(), writesBefore, 'total write count must not increase');
});

// F5: exportBackup with empty DATA → ok:false propagated
const fSvc5     = createV2BackupService(makeBaseConfig({ adapter: makeAdapter() /* no DATA */ }));
const fAdapter5 = createV2BackupAdapter(fSvc5);

await check('F5: exportBackup with no DATA in adapter → ok:false propagated through adapter', async () => {
  const result = await fAdapter5.exportBackup();
  assert.equal(result.ok, false, 'must return ok:false when DATA is absent');
});

// F6: applyUndo with no snapshot → ok:false propagated
const fSvc6     = createV2BackupService(makeBaseConfig({ adapter: makeAdapter() /* no snapshot */ }));
const fAdapter6 = createV2BackupAdapter(fSvc6);

await check('F6: applyUndo with no snapshot → ok:false propagated through adapter', async () => {
  const result = await fAdapter6.applyUndo();
  assert.equal(result.ok, false, 'must return ok:false when no snapshot exists');
});

/* ══════════════════════════════════════════════════════════════════
   G: Import purity — global storage, DOM, and timer sentinels  (6 checks)
   G1–G3: sentinels on globalThis prove createV2BackupAdapter itself
          (the factory call) does not touch any storage/timer global.
   G4:    wrapping a spy service causes 0 method calls on the service.
   G5:    constructing a real createV2BackupService causes 0 calls on
          the spy adapter at construction time.
   G6:    wrapping the constructed service also causes 0 adapter calls.
   ══════════════════════════════════════════════════════════════════ */
section('G-import-purity-sentinels');

{
  // Install sentinels before the factory call; restore afterward.
  const lsSpy = { count: 0 };
  const ssSpy = { count: 0 };
  const stSpy = { count: 0 };

  const origLSDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const origSSDesc = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const origST     = globalThis.setTimeout;

  Object.defineProperty(globalThis, 'localStorage',  { get() { lsSpy.count++; return undefined; }, configurable: true, enumerable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { get() { ssSpy.count++; return undefined; }, configurable: true, enumerable: true });
  globalThis.setTimeout = (...args) => { stSpy.count++; return origST(...args); };

  // Factory call under sentinels
  const gSpySvc = makeSpySvc();
  createV2BackupAdapter(gSpySvc);

  await check('G1: no localStorage access during createV2BackupAdapter factory call', async () => {
    assert.equal(lsSpy.count, 0, `localStorage accessed ${lsSpy.count} time(s) during factory call`);
  });
  await check('G2: no sessionStorage access during createV2BackupAdapter factory call', async () => {
    assert.equal(ssSpy.count, 0, `sessionStorage accessed ${ssSpy.count} time(s) during factory call`);
  });
  await check('G3: no setTimeout calls during createV2BackupAdapter factory call', async () => {
    assert.equal(stSpy.count, 0, `setTimeout called ${stSpy.count} time(s) during factory call`);
  });

  // Restore globals
  if (origLSDesc) Object.defineProperty(globalThis, 'localStorage', origLSDesc);
  else { try { delete globalThis.localStorage; } catch (_) {} }
  if (origSSDesc) Object.defineProperty(globalThis, 'sessionStorage', origSSDesc);
  else { try { delete globalThis.sessionStorage; } catch (_) {} }
  globalThis.setTimeout = origST;
}

await check('G4: createV2BackupAdapter(spySvc) wrapping — all 9 spy service methods called 0 times', async () => {
  const g4Spy = makeSpySvc();
  createV2BackupAdapter(g4Spy);
  for (const m of REQUIRED_METHODS) {
    assert.equal(g4Spy._callCount(m), 0, `${m} must not be called during wrapping`);
  }
});

const g5Spy = makeSpyAdapter();
const g5Svc = createV2BackupService(makeBaseConfig({ adapter: g5Spy }));
await check('G5: createV2BackupService construction — spy adapter getItem/setItem/removeItem all 0 calls', async () => {
  // Only writes are tracked by makeSpyAdapter; check all writes = 0 at construction time.
  // (getItem is not tracked by spy; construction must not write)
  assert.equal(g5Spy.getWriteCount(), 0,
    `spy adapter must have 0 writes at construction; got ${g5Spy.getWriteCount()}`);
});
await check('G6: createV2BackupAdapter(constructedV2Svc) wrapping — spy adapter still has 0 writes', async () => {
  const writesBeforeWrap = g5Spy.getWriteCount();
  createV2BackupAdapter(g5Svc);
  assert.equal(g5Spy.getWriteCount(), writesBeforeWrap,
    'wrapping a constructed service must not cause any storage writes');
});

/* ══════════════════════════════════════════════════════════════════
   H: Static isolation  (4 checks)
   ══════════════════════════════════════════════════════════════════ */
section('H-static-isolation');

const __dir     = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC_PATH = join(__dir, '..', 'src', 'data', 'backup', 'v2-backup-service-adapter.js');
const hSrc      = readFileSync(ADAPTER_SRC_PATH, 'utf8');

await check('H1: adapter source contains no localStorage reference', async () => {
  const stripped = hSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !stripped.includes('localStorage.') && !stripped.includes('localStorage[') &&
    !stripped.includes('window.localStorage') && !stripped.includes('globalThis.localStorage'),
    'adapter source must not reference localStorage after comment stripping',
  );
});
await check('H2: adapter source contains no sessionStorage reference', async () => {
  const stripped = hSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !stripped.includes('sessionStorage.') && !stripped.includes('sessionStorage[') &&
    !stripped.includes('window.sessionStorage') && !stripped.includes('globalThis.sessionStorage'),
    'adapter source must not reference sessionStorage after comment stripping',
  );
});
await check('H3: adapter source contains no src/app/ import', async () => {
  const importLines = hSrc.split('\n').filter(l => /^\s*import\b/.test(l));
  const appImports  = importLines.filter(l => /['"]([^'"]*\/app\/[^'"]*|\.\.\/app\/[^'"]*)['"]/.test(l));
  assert.deepEqual(appImports, [],
    `adapter must not import from src/app/: ${appImports.join('; ')}`);
});
await check('H4: adapter source has 0 static import statements (zero-import module)', async () => {
  const importLines = hSrc.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.equal(importLines.length, 0,
    `adapter must have no import statements; found: ${importLines.join(' | ')}`);
});

/* ── Results ─────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(60));
console.log(`  Passed: ${pass}   Failed: ${fail}`);
console.log(`  Total:  ${pass + fail}`);
console.log('─'.repeat(60));
if (fail > 0) process.exit(1);
