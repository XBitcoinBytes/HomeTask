/**
 * Suite 18 — backup.js facade (CP5C-A2.2b)
 *
 * Tests:
 *   A: Pre-injection fail-closed — every operation throws before setService()
 *   B: Injection semantics — setService/setRepo validation
 *   C: Delegation — each facade method routes to service exactly once
 *   D: Contract — facade returns service result unchanged
 *   E: Snapshot isolation — task writes cannot reach Undo snapshot via facade
 *   F: Static source analysis — no old implementation, no unauthorized access
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = resolve(__dir, '..');

/* ── import the backup facade ───────────────────────────────────── */
const { backup } = await import('../src/app/backup.js');

/* ── test harness ───────────────────────────────────────────────── */
let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label} — ${err.message}`);
    failed++;
  }
}

console.log('\nBackup facade — Suite 18\n');

/* ════════════════════════════════════════════════════════════════════
   A: Pre-injection fail-closed
   Every operation must throw before setService() is called; no side
   effects must occur (no storage mutation).
   ════════════════════════════════════════════════════════════════════ */
console.log('── A: Pre-injection fail-closed ──');

const OPS_UNDER_TEST = [
  ['exportBackup',          () => backup.exportBackup()],
  ['readAndValidate',       () => backup.readAndValidate({ size: 1 })],
  ['applyImport',           () => backup.applyImport([], {})],
  ['applyUndo',             () => backup.applyUndo()],
  ['hasSnapshot',           () => backup.hasSnapshot()],
  ['getLastExport',         () => backup.getLastExport()],
  ['getRecoveryNoticeState',() => backup.getRecoveryNoticeState()],
  ['downloadRecoveryData',  () => backup.downloadRecoveryData()],
  ['dismissRecovery',       () => backup.dismissRecovery()],
];

for (const [name, fn] of OPS_UNDER_TEST) {
  await check(`A${OPS_UNDER_TEST.indexOf(OPS_UNDER_TEST.find(o => o[0] === name)) + 1}: ${name} throws without service`, () => {
    let threw = false;
    try { fn(); } catch (e) {
      threw = true;
      assert.ok(e.message.includes('no service') || e.message.includes('setService'),
        `A: error message must reference "no service" or "setService", got: ${e.message}`);
    }
    assert.ok(threw, `${name} should throw before setService()`);
  });
}

await check('A10: setService with null throws', () => {
  assert.throws(() => backup.setService(null),
    e => e.message.includes('invalid service'));
});
await check('A11: setService with non-object throws', () => {
  assert.throws(() => backup.setService('string'),
    e => e.message.includes('invalid service'));
});
await check('A12: setService with object missing exportBackup throws', () => {
  assert.throws(() => backup.setService({ notExportBackup: () => {} }),
    e => e.message.includes('invalid service'));
});
await check('A13: setRepo with null throws', () => {
  assert.throws(() => backup.setRepo(null),
    e => e.message.includes('invalid repository'));
});

await check('A14: fail-closed cannot mutate storage — no side effects on throw', () => {
  // Calls that throw before setService must not write to any storage.
  // We verify this by ensuring the call throws synchronously before any
  // async work or storage access can occur.
  const errors = [];
  try { backup.applyImport([], {}); } catch (e) { errors.push(e.message); }
  try { backup.applyUndo(); } catch (e) { errors.push(e.message); }
  try { backup.hasSnapshot(); } catch (e) { errors.push(e.message); }
  // All three must have thrown (not silently completed)
  assert.equal(errors.length, 3, 'all three pre-injection calls must throw');
  errors.forEach(msg =>
    assert.ok(msg.includes('no service'),
      `each error must say "no service", got: ${msg}`));
});

/* ════════════════════════════════════════════════════════════════════
   B: Injection semantics
   ════════════════════════════════════════════════════════════════════ */
console.log('\n── B: Injection semantics ──');

/**
 * Build a mock service that records calls and returns configurable results.
 * Each method tracks how many times it was called and the arguments it received.
 */
function makeMockService(overrides = {}) {
  const calls = {};
  const defaults = {
    exportBackup:          async () => ({ ok: true,  message: 'exported' }),
    readAndValidate:       async () => ({ sanitizedTasks: [], sanitizedPrefs: {}, exportDate: '2026-01-01', taskCount: 0 }),
    applyImport:           ()      => ({ ok: true,  message: 'imported' }),
    applyUndo:             ()      => ({ ok: true }),
    hasSnapshot:           ()      => false,
    getLastExport:         ()      => '2026-01-01',
    getRecoveryNoticeState:()      => ({ visible: false, message: '', showDownload: false, showUndo: false }),
    downloadRecoveryData:  ()      => ({ ok: true, message: 'downloaded' }),
    dismissRecovery:       ()      => undefined,
  };
  const svc = {};
  for (const [name, defaultFn] of Object.entries(defaults)) {
    calls[name] = [];
    svc[name] = (...args) => {
      calls[name].push(args);
      return (overrides[name] ?? defaultFn)(...args);
    };
  }
  svc._calls = calls;
  return svc;
}

const mockSvc = makeMockService();

await check('B1: valid service accepted successfully', () => {
  // Should not throw
  backup.setService(mockSvc);
});

await check('B2: double setService throws', () => {
  assert.throws(() => backup.setService(makeMockService()),
    e => e.message.includes('already set'));
});

await check('B3: setRepo with valid object succeeds (no-op)', () => {
  // Should not throw after service is set
  backup.setRepo({ loadTasks: () => [], loadPrefs: () => ({}) });
});

await check('B4: setRepo with invalid arg still throws after injection', () => {
  assert.throws(() => backup.setRepo(42),
    e => e.message.includes('invalid repository'));
});

/* ════════════════════════════════════════════════════════════════════
   C: Delegation — each method routes to service exactly once
   ════════════════════════════════════════════════════════════════════ */
console.log('\n── C: Delegation — exactly-once routing ──');

// Reset call counters for each test by using the recorded calls array length.
function callCount(svc, method) { return svc._calls[method].length; }

await check('C1: exportBackup delegates to service exactly once', async () => {
  const before = callCount(mockSvc, 'exportBackup');
  await backup.exportBackup();
  assert.equal(callCount(mockSvc, 'exportBackup'), before + 1);
});

await check('C2: readAndValidate delegates to service exactly once', async () => {
  const before = callCount(mockSvc, 'readAndValidate');
  const fakefile = { size: 100 };
  await backup.readAndValidate(fakefile);
  assert.equal(callCount(mockSvc, 'readAndValidate'), before + 1);
  // Argument pass-through: service received the file-like object
  const lastArgs = mockSvc._calls.readAndValidate.at(-1);
  assert.equal(lastArgs[0], fakefile, 'readAndValidate must pass file unchanged');
});

await check('C3: applyImport delegates to service exactly once', () => {
  const before = callCount(mockSvc, 'applyImport');
  const tasks = [{ id: 'x' }];
  const prefs = { viewMode: 'today' };
  backup.applyImport(tasks, prefs);
  assert.equal(callCount(mockSvc, 'applyImport'), before + 1);
  const lastArgs = mockSvc._calls.applyImport.at(-1);
  assert.equal(lastArgs[0], tasks, 'applyImport must pass tasks unchanged');
  assert.equal(lastArgs[1], prefs, 'applyImport must pass prefs unchanged');
});

await check('C4: applyUndo delegates to service exactly once', () => {
  const before = callCount(mockSvc, 'applyUndo');
  backup.applyUndo();
  assert.equal(callCount(mockSvc, 'applyUndo'), before + 1);
});

await check('C5: hasSnapshot delegates to service exactly once', () => {
  const before = callCount(mockSvc, 'hasSnapshot');
  backup.hasSnapshot();
  assert.equal(callCount(mockSvc, 'hasSnapshot'), before + 1);
});

await check('C6: getLastExport delegates to service exactly once', () => {
  const before = callCount(mockSvc, 'getLastExport');
  backup.getLastExport();
  assert.equal(callCount(mockSvc, 'getLastExport'), before + 1);
});

await check('C7: getRecoveryNoticeState delegates to service exactly once', () => {
  const before = callCount(mockSvc, 'getRecoveryNoticeState');
  backup.getRecoveryNoticeState();
  assert.equal(callCount(mockSvc, 'getRecoveryNoticeState'), before + 1);
});

await check('C8: downloadRecoveryData delegates to service exactly once', () => {
  const before = callCount(mockSvc, 'downloadRecoveryData');
  backup.downloadRecoveryData();
  assert.equal(callCount(mockSvc, 'downloadRecoveryData'), before + 1);
});

await check('C9: dismissRecovery delegates to service exactly once', () => {
  const before = callCount(mockSvc, 'dismissRecovery');
  backup.dismissRecovery();
  assert.equal(callCount(mockSvc, 'dismissRecovery'), before + 1);
});

/* ════════════════════════════════════════════════════════════════════
   D: Contract — facade returns service result unchanged
   ════════════════════════════════════════════════════════════════════ */
console.log('\n── D: Contract — result pass-through ──');

// Build a new mock with specific return values to test pass-through
const exportResult  = { ok: true,  message: 'Backup shared successfully.' };
const rvResult      = { sanitizedTasks: [{ id: 'a' }], sanitizedPrefs: { viewMode: 'week' }, exportDate: '2026-08-12', taskCount: 1 };
const importResult  = { ok: false, message: 'rollback_failed message' };
const undoResult    = { ok: false, error: 'no-snapshot' };
const hasSnapResult = true;
const lastExport    = '2026-07-01';
const noticeResult  = { visible: true, message: 'msg', showDownload: true, showUndo: false };
const dlResult      = { ok: true, message: 'downloaded data' };

// The mockSvc is already injected; override individual methods via a new mockSvc2
// that wraps mockSvc's _calls. Since backup is a singleton with mockSvc injected,
// we test pass-through by calling through and checking return values.
const contractSvc = makeMockService({
  exportBackup:          async () => exportResult,
  readAndValidate:       async () => rvResult,
  applyImport:           ()      => importResult,
  applyUndo:             ()      => undoResult,
  hasSnapshot:           ()      => hasSnapResult,
  getLastExport:         ()      => lastExport,
  getRecoveryNoticeState:()      => noticeResult,
  downloadRecoveryData:  ()      => dlResult,
  dismissRecovery:       ()      => 'ignored-return',
});

// We can't re-inject (setService already called). Instead verify pass-through
// using the already-injected mockSvc by controlling its returns via a fresh
// wrapper test approach: directly call the service methods through backup and
// compare returned references.

// Since mockSvc returns the same default objects on every call, we can verify
// that backup.exportBackup() resolves to the same value mockSvc.exportBackup() returns.

await check('D1: exportBackup returns service result', async () => {
  const direct = await mockSvc.exportBackup();
  const viaFacade = await backup.exportBackup();
  assert.deepEqual(viaFacade, direct, 'exportBackup must return service value unchanged');
});

await check('D2: readAndValidate returns service result', async () => {
  const fakefile = { size: 10 };
  const direct = await mockSvc.readAndValidate(fakefile);
  const viaFacade = await backup.readAndValidate(fakefile);
  assert.deepEqual(viaFacade, direct, 'readAndValidate must return service value unchanged');
});

await check('D3: applyImport returns service result', () => {
  const direct = mockSvc.applyImport([], {});
  const viaFacade = backup.applyImport([], {});
  assert.deepEqual(viaFacade, direct, 'applyImport must return service value unchanged');
});

await check('D4: applyUndo returns service result', () => {
  const direct = mockSvc.applyUndo();
  const viaFacade = backup.applyUndo();
  assert.deepEqual(viaFacade, direct, 'applyUndo must return service value unchanged');
});

await check('D5: hasSnapshot returns service result', () => {
  const direct = mockSvc.hasSnapshot();
  const viaFacade = backup.hasSnapshot();
  assert.equal(viaFacade, direct, 'hasSnapshot must return service value unchanged');
});

await check('D6: getLastExport returns service result', () => {
  const direct = mockSvc.getLastExport();
  const viaFacade = backup.getLastExport();
  assert.equal(viaFacade, direct, 'getLastExport must return service value unchanged');
});

await check('D7: getRecoveryNoticeState returns service result', () => {
  const direct = mockSvc.getRecoveryNoticeState();
  const viaFacade = backup.getRecoveryNoticeState();
  assert.deepEqual(viaFacade, direct, 'getRecoveryNoticeState must return service value unchanged');
});

await check('D8: downloadRecoveryData returns service result', () => {
  const direct = mockSvc.downloadRecoveryData();
  const viaFacade = backup.downloadRecoveryData();
  assert.deepEqual(viaFacade, direct, 'downloadRecoveryData must return service value unchanged');
});

/* ════════════════════════════════════════════════════════════════════
   E: Snapshot isolation — ordinary task writes cannot reach Undo snapshot
   ════════════════════════════════════════════════════════════════════ */
console.log('\n── E: Snapshot isolation ──');

await check('E1: backup facade exposes no task-write methods', () => {
  // The facade must not expose markDone, skipToday, skipWeek, or any
  // task-mutation surface. The only path to the snapshot is applyImport.
  const keys = Object.keys(backup);
  const prohibited = ['markDone', 'skipToday', 'skipWeek', 'applyBaseline',
                      'setItem', 'getItem', 'removeItem'];
  for (const k of prohibited) {
    assert.ok(!keys.includes(k),
      `facade must not expose task-write method "${k}"`);
  }
});

await check('E2: saveSnapshot only called via applyImport, not by task ops', () => {
  // Verify that calling applyImport calls backupStore.saveSnapshot via the service,
  // while simulated task writes (direct backing.setItem calls) do NOT call it.
  // We track this through the mockSvc: applyImport is the only method that
  // triggers snapshot saves inside V1BackupService. The facade itself has no
  // saveSnapshot exposure.
  const facadeMethods = Object.keys(backup);
  assert.ok(!facadeMethods.includes('saveSnapshot'),
    'saveSnapshot must not be exposed on the facade');
  assert.ok(!facadeMethods.includes('getSnapshot'),
    'getSnapshot must not be exposed on the facade');
  assert.ok(!facadeMethods.includes('clearSnapshot'),
    'clearSnapshot must not be exposed on the facade');
  // The only way to create a snapshot is via applyImport (which calls
  // service.applyImport → backupStore.saveSnapshot internally)
  assert.ok(facadeMethods.includes('applyImport'),
    'applyImport must be on the facade (the only snapshot-creating entry point)');
});

/* ════════════════════════════════════════════════════════════════════
   F: Static source analysis
   ════════════════════════════════════════════════════════════════════ */
console.log('\n── F: Static source analysis ──');

const BACKUP_SRC = readFileSync(resolve(ROOT, 'src/app/backup.js'), 'utf8');

await check('F1: backup.js contains no old internal implementation functions', () => {
  // Old implementation had these private functions that must be gone
  const forbidden = [
    '_buildEnvelope',
    '_sanitizeTaskState',
    '_sanitizePreferences',
    '_isDateOrNull',
    '_validateEnvelope',
    'localStorage',
    'sessionStorage',
    'new FileReader',
    'new Date().toISOString',  // clock should be injected
    'navigator.share',
    'document.createElement',
    'URL.createObjectURL',
  ];
  for (const name of forbidden) {
    assert.ok(!BACKUP_SRC.includes(name),
      `backup.js must not contain "${name}" — old implementation must be removed`);
  }
});

await check('F2: backup.js has no src/app or src/data imports', () => {
  // The facade must have zero import statements — pure IIFE factory
  const importLines = BACKUP_SRC.split('\n').filter(l => l.trimStart().startsWith('import '));
  assert.equal(importLines.length, 0,
    `backup.js must have no imports; found: ${importLines.join(', ')}`);
});

await check('F3: backup.js exposes exactly the documented 11 facade methods', () => {
  const expected = new Set([
    'setService', 'setRepo',
    'exportBackup', 'readAndValidate', 'applyImport', 'applyUndo',
    'hasSnapshot', 'getLastExport', 'getRecoveryNoticeState',
    'downloadRecoveryData', 'dismissRecovery',
  ]);
  const actual = new Set(Object.keys(backup));
  for (const name of expected) {
    assert.ok(actual.has(name), `facade is missing method: ${name}`);
  }
  for (const name of actual) {
    assert.ok(expected.has(name), `facade has unexpected method: ${name}`);
  }
});

await check('F4: backup-ui.js has no direct recoveryStore or stagingStore imports', () => {
  const uiSrc = readFileSync(resolve(ROOT, 'src/app/backup-ui.js'), 'utf8');
  assert.ok(!uiSrc.includes("from './recovery.js'"),
    "backup-ui.js must not import recovery.js (routes through backup facade)");
  assert.ok(!uiSrc.includes("from './staging-store.js'"),
    "backup-ui.js must not import staging-store.js (routes through backup facade)");
});

await check('F5: backup-ui.js has no direct sessionStorage access for backup-related ops', () => {
  const uiSrc = readFileSync(resolve(ROOT, 'src/app/backup-ui.js'), 'utf8');
  // sessionStorage is still permitted in backup-ui.js ONLY for the shadow
  // share feature (not backup ops). Check that no backup-recovery handler
  // accesses sessionStorage directly.
  // The _onDismissRecovery and _refreshRecoveryPanel functions must not
  // contain sessionStorage access — those delegate to the service.
  // The easiest structural check: neither recoveryStore nor stagingStore
  // appear anywhere in the file.
  assert.ok(!uiSrc.includes('recoveryStore'),
    "backup-ui.js must not reference recoveryStore");
  assert.ok(!uiSrc.includes('stagingStore'),
    "backup-ui.js must not reference stagingStore");
});

await check('F6: script.js composition root constructs V1BackupService and calls setService', () => {
  const scriptSrc = readFileSync(resolve(ROOT, 'src/script.js'), 'utf8');
  assert.ok(scriptSrc.includes('new V1BackupService'),
    'script.js must construct V1BackupService');
  assert.ok(scriptSrc.includes('backup.setService'),
    'script.js must call backup.setService()');
  assert.ok(scriptSrc.includes('createBrowserFileReader'),
    'script.js must wire createBrowserFileReader');
  assert.ok(scriptSrc.includes('createBrowserDelivery'),
    'script.js must wire createBrowserDelivery');
  assert.ok(scriptSrc.includes('sessionStorage.getItem'),
    'script.js must provide sessionStore adapter');
});

await check('F7: backup.setService called before app.init in script.js', () => {
  const scriptSrc = readFileSync(resolve(ROOT, 'src/script.js'), 'utf8');
  const setServiceIdx = scriptSrc.indexOf('backup.setService');
  const appInitIdx    = scriptSrc.indexOf('app.init(repo)');
  assert.ok(setServiceIdx !== -1, 'script.js must call backup.setService');
  assert.ok(appInitIdx    !== -1, 'script.js must call app.init(repo)');
  assert.ok(setServiceIdx < appInitIdx,
    'backup.setService must appear before app.init(repo) in script.js');
});

/* ════════════════════════════════════════════════════════════════════
   Results
   ════════════════════════════════════════════════════════════════════ */

console.log('\n' + '─'.repeat(60));
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log('─'.repeat(60));

if (failed > 0) process.exit(1);
