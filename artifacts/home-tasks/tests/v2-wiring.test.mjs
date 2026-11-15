/**
 * v2-wiring.test.mjs — CP5C-C: createV2BackupService factory (Suite 22).
 *
 * Tests:
 *   A: Constructor validation — throws the correct diagnostic for each
 *      missing/invalid required dep; accepts a fully valid config.
 *   B: Output contract — all 9 facade methods present; independence;
 *      optional deps can be omitted; no internal leakage.
 *   C: Functional smoke — factory-constructed service runs the full
 *      export → readAndValidate → applyImport → hasSnapshot → applyUndo
 *      lifecycle using all-synthetic mocks and fixtures.
 *   D: Static isolation — comment-stripped source contains no localStorage,
 *      no sessionStorage, no src/app/ imports, no V1 module imports, and
 *      no re-export of V2BackupService.
 *
 * Standalone Node ESM. No browser, no real localStorage, no live data.
 * Run with:  node artifacts/home-tasks/tests/v2-wiring.test.mjs
 */

import assert           from 'node:assert/strict';
import { createHash }   from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createV2BackupService } from '../src/data/backup/v2-backup-wiring.js';
import { CATALOG }               from '../src/v2/catalog.data.js';
import { migrate }               from '../src/v2/migrate.js';
import { buildBackup }           from '../src/v2/backup.js';
import { V2_KEYS }               from '../src/v2/import-tx.js';
import { ACTIVATION_KEYS }       from '../src/v2/activation-tx.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';

/* ── Test harness ──────────────────────────────────────────────── */
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

/* ── Shared constants ──────────────────────────────────────────── */
const NOW        = '2026-07-31T10:00:00.000Z';
const CTX        = { today: FIXED_TODAY, catalog: CATALOG, appBuild: 'v-test' };
const EXPORT_CTX = { exportedAt: NOW, catalogVersion: CATALOG.catalogVersion, appBuild: 'v-test' };

/* ── Synthetic-fixture helpers ─────────────────────────────────── */
function makeAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: k      => store.delete(k),
  };
}
function makeFileReader() {
  return { readAsText: f => Promise.resolve(f._content ?? '') };
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
    runExclusive(txId, cb) {
      const next = q.then(async () => {
        try   { return { ok: true,  result: await cb() }; }
        catch (e) { return { ok: false, code: 'callback-threw', message: e?.message ?? String(e) }; }
      });
      q = next.catch(() => {});
      return next;
    },
  };
}
function testDigest(bytes) {
  return Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
}
function hexOf(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
function makeLS(gen, dig) {
  return JSON.stringify({ generation: gen, digest: dig, schemaVersion: 2 });
}
function makeConfig(overrides = {}) {
  return {
    adapter:      makeAdapter(),
    catalog:      CATALOG,
    appBuild:     'v-test',
    delivery:     { canShare: () => false, share: async () => {}, download: () => {} },
    fileReader:   makeFileReader(),
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: makeSessionStore(),
    lock:         makeLock(),
    digestFn:     testDigest,
    ...overrides,
  };
}
function makeBackupFileLike() {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const backup = buildBackup(v2, EXPORT_CTX);
  const json   = JSON.stringify(backup);
  return { size: json.length, _content: json };
}

/** Asserts fn() throws an error whose message includes `pattern`. */
function assertThrows(fn, pattern, label) {
  let threw = false;
  try { fn(); }
  catch (e) {
    threw = true;
    if (!e.message.includes(pattern))
      throw new Error(
        `${label}: expected error to include '${pattern}', got: '${e.message}'`
      );
  }
  if (!threw) throw new Error(`${label}: expected a throw but none occurred`);
}

/* ══════════════════════════════════════════════════════════════════
   A: Constructor validation
   ══════════════════════════════════════════════════════════════════ */
section('A-constructor-validation');

await check('A1: missing adapter throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), adapter: null }),
    'adapter required', 'adapter null'
  );
});
await check('A2: null catalog throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), catalog: null }),
    'catalog required', 'catalog null'
  );
});
await check('A3: catalog.tasks not an array throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), catalog: { tasks: 'bad', zones: [], catalogVersion: 1 } }),
    'catalog.tasks', 'catalog.tasks non-array'
  );
});
await check('A4: catalog.zones not an array throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), catalog: { tasks: [], zones: 'bad', catalogVersion: 1 } }),
    'catalog.zones', 'catalog.zones non-array'
  );
});
await check('A5: catalog.catalogVersion not a number throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), catalog: { tasks: [], zones: [], catalogVersion: 'one' } }),
    'catalog.catalogVersion', 'catalog.catalogVersion string'
  );
});
await check('A6: empty-string appBuild throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), appBuild: '' }),
    'appBuild', 'appBuild empty string'
  );
});
await check('A7: missing delivery throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), delivery: null }),
    'delivery required', 'delivery null'
  );
});
await check('A8: missing fileReader throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), fileReader: null }),
    'fileReader required', 'fileReader null'
  );
});
await check('A9: clock not a function throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), clock: '2026-01-01T00:00:00.000Z' }),
    'clock', 'clock string'
  );
});
await check('A10: todayFn not a function throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), todayFn: null }),
    'todayFn', 'todayFn null'
  );
});
await check('A11: missing sessionStore throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), sessionStore: null }),
    'sessionStore required', 'sessionStore null'
  );
});
await check('A12: missing lock throws', async () => {
  assertThrows(
    () => createV2BackupService({ ...makeConfig(), lock: null }),
    'lock required', 'lock null'
  );
});
await check('A13: fully valid config constructs service without throwing', async () => {
  const svc = createV2BackupService(makeConfig());
  assert.ok(svc && typeof svc === 'object', 'must return an object');
});

/* ══════════════════════════════════════════════════════════════════
   B: Output contract
   ══════════════════════════════════════════════════════════════════ */
section('B-output-contract');

await check('B1: all 9 required facade methods are present as functions', async () => {
  const svc = createV2BackupService(makeConfig());
  const REQUIRED = [
    'exportBackup', 'readAndValidate', 'applyImport', 'applyUndo',
    'hasSnapshot', 'getLastExport', 'getRecoveryNoticeState',
    'downloadRecoveryData', 'dismissRecovery',
  ];
  for (const m of REQUIRED)
    assert.equal(typeof svc[m], 'function', `method ${m} must be a function`);
});
await check('B2: two factory calls return independent service instances', async () => {
  const svc1 = createV2BackupService(makeConfig());
  const svc2 = createV2BackupService(makeConfig());
  assert.notEqual(svc1, svc2, 'each call must return a distinct service object');
});
await check('B3: optional deps (timeoutMs, scheduler) can be omitted', async () => {
  const cfg = makeConfig();
  delete cfg.timeoutMs;
  delete cfg.scheduler;
  const svc = createV2BackupService(cfg);
  assert.equal(typeof svc.exportBackup, 'function',
    'service must construct without optional timeoutMs / scheduler');
});
await check('B4: factory output does not expose V2BackupService constructor', async () => {
  const svc = createV2BackupService(makeConfig());
  assert.ok(!('V2BackupService' in svc),
    'factory output must not have a V2BackupService property');
  assert.ok(typeof svc !== 'function',
    'factory output must not itself be a constructor function');
});

/* ══════════════════════════════════════════════════════════════════
   C: Functional smoke — full export→import→undo lifecycle
   ══════════════════════════════════════════════════════════════════ */
section('C-functional-smoke');

// Minimal valid v2 DATA envelope
const PRE_DATA = JSON.stringify({
  schemaVersion: 2,
  state: [],
  prefs: { viewMode: 'today', roomFilter: '', onboarded: false,
           choice: null, completedAt: null, roomFilterZoneId: '' },
  userZones: [], userTasks: [], completionEvents: {},
  overrides: {}, recentSearches: [], meta: null,
});

const smokeAdapter = makeAdapter();
smokeAdapter.setItem(V2_KEYS.DATA,            PRE_DATA);
smokeAdapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRE_DATA)));

let smokeDeliveryBlob = null;
const smokeSvc = createV2BackupService(makeConfig({
  adapter:  smokeAdapter,
  delivery: {
    canShare: () => false,
    share:    async () => {},
    download: blob => { smokeDeliveryBlob = blob; },
  },
}));

await check('C1: getLastExport is null before first export', async () => {
  assert.equal(await smokeSvc.getLastExport(), null,
    'getLastExport must be null before any export');
});
await check('C2: exportBackup returns ok:true and triggers delivery download()', async () => {
  const result = await smokeSvc.exportBackup();
  assert.equal(result.ok, true, `exportBackup expected ok:true — got ${JSON.stringify(result)}`);
  assert.ok(smokeDeliveryBlob !== null, 'delivery.download() must be called with a blob');
});
await check('C3: getLastExport returns a YYYY-MM-DD string after export', async () => {
  const d = await smokeSvc.getLastExport();
  assert.ok(
    typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d),
    `getLastExport must be a YYYY-MM-DD string after export — got: ${d}`
  );
});

let sanitized;
await check('C4: readAndValidate accepts a v2 backup file and returns sanitized envelope', async () => {
  const result = await smokeSvc.readAndValidate(makeBackupFileLike());
  assert.ok(result.sanitized, `readAndValidate must return a sanitized envelope — got ${JSON.stringify(result)}`);
  sanitized = result.sanitized;
});
await check('C5: applyImport returns ok:true', async () => {
  const result = await smokeSvc.applyImport(sanitized);
  assert.equal(result.ok, true, `applyImport expected ok:true — got ${JSON.stringify(result)}`);
});
await check('C6: hasSnapshot is true after applyImport', async () => {
  assert.equal(await smokeSvc.hasSnapshot(), true,
    'hasSnapshot must be true after applyImport');
});
await check('C7: applyUndo returns ok:true', async () => {
  const result = await smokeSvc.applyUndo();
  assert.equal(result.ok, true, `applyUndo expected ok:true — got ${JSON.stringify(result)}`);
});
await check('C8: hasSnapshot is false after applyUndo', async () => {
  assert.equal(await smokeSvc.hasSnapshot(), false,
    'hasSnapshot must be false after applyUndo');
});
await check('C9: recovery methods callable without throwing when no recovery data present', async () => {
  const notice = await smokeSvc.getRecoveryNoticeState();
  assert.ok(notice !== undefined, 'getRecoveryNoticeState must return a value');
  await smokeSvc.downloadRecoveryData(); // no-op when no recovery data
  await smokeSvc.dismissRecovery();      // no-op when no recovery data
});

/* ══════════════════════════════════════════════════════════════════
   D: Static isolation — source-text analysis of v2-backup-wiring.js
   ══════════════════════════════════════════════════════════════════ */
section('D-static-isolation');

const __dir    = dirname(fileURLToPath(import.meta.url));
const WIRING_PATH = resolve(__dir, '..', 'src', 'data', 'backup', 'v2-backup-wiring.js');
const wiringRaw  = readFileSync(WIRING_PATH, 'utf8');

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/\/\/[^\n]*/g, '');        // line comments
}
const wiringStripped = stripComments(wiringRaw);

await check('D1: no direct localStorage access', async () => {
  const has =
    wiringStripped.includes('localStorage.')          ||
    wiringStripped.includes('localStorage[')          ||
    wiringStripped.includes('window.localStorage')    ||
    wiringStripped.includes('globalThis.localStorage');
  assert.ok(!has, 'v2-backup-wiring.js must not access localStorage directly');
});
await check('D2: no direct sessionStorage access', async () => {
  const has =
    wiringStripped.includes('sessionStorage.')           ||
    wiringStripped.includes('sessionStorage[')           ||
    wiringStripped.includes('window.sessionStorage')     ||
    wiringStripped.includes('globalThis.sessionStorage');
  assert.ok(!has, 'v2-backup-wiring.js must not access sessionStorage directly');
});
await check('D3: no imports from src/app/', async () => {
  const importLines = wiringStripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
  const appImports  = importLines.filter(
    line => /['"]([^'"]*\/app\/[^'"]*|\.\.\/app\/[^'"]*)['"]/.test(line)
  );
  assert.deepEqual(appImports, [],
    `must not import from src/app/: ${appImports.join('; ')}`);
});
await check('D4: no imports from V1 modules', async () => {
  const importLines = wiringStripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
  const v1Imports   = importLines.filter(line => line.includes('v1-'));
  assert.deepEqual(v1Imports, [],
    `must not import V1 modules: ${v1Imports.join('; ')}`);
});
await check('D5: no re-export of V2BackupService or export * from', async () => {
  assert.ok(
    !wiringStripped.includes('export { V2BackupService') &&
    !wiringStripped.includes('export * from'),
    'v2-backup-wiring.js must not re-export V2BackupService or use export *'
  );
});

/* ── Results ───────────────────────────────────────────────────── */
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
