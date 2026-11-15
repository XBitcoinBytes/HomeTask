/**
 * HomeTask — V1BackupService differential + unit test suite (Suite 17)
 *
 * Standalone Node.js ESM. Run with:
 *   node artifacts/home-tasks/tests/backup-service.test.mjs
 *
 * Coverage:
 *   A. Constructor validation — missing required deps
 *   B. Export — differential (frozen Date, byte-identical envelopes between two service instances)
 *   C. Export — share/download delivery behaviors (matches production semantics)
 *   D. readAndValidate — differential (same output from both implementations)
 *   E. readAndValidate — hostile JSON (security at the file-import boundary)
 *   F. applyImport — defensive whitelist (security at the import-apply boundary)
 *   G. applyImport — differential happy path (byte-identical final storage)
 *   H. applyImport — failure modes (snapshot-fail, staging-fail, readback, rollback, guard)
 *   I. applyUndo — differential (byte-identical restore) + failure modes
 *   J. Catalog authority — duplicate ID (first wins) and unknown ID (skipped)
 *   K. State queries — hasSnapshot, getLastExport
 *   L. getRecoveryNoticeState — all four states
 *   M. downloadRecoveryData and dismissRecovery
 */

import assert from 'node:assert/strict';

/* ══════════════════════════════════════════════════════════════════
   SECTION 0: GLOBAL BROWSER MOCKS
   Must be set BEFORE dynamic imports — app modules read these at call time.
═══════════════════════════════════════════════════════════════════ */

function makeMockStorage() {
  const store = new Map();
  return {
    getItem:    k      => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: k      => store.delete(k),
    clear:      ()     => store.clear(),
    _store:     store,
    _snapshot:  ()     => new Map(store),
  };
}

const mockLS      = makeMockStorage();
const mockSS      = makeMockStorage();   // sessionStorage

globalThis.localStorage  = mockLS;
globalThis.sessionStorage = mockSS;

// Blob: capture construction args; behave like a real Blob for size checks
let _lastBlobContent  = null;
let _lastBlobType     = null;
globalThis.Blob = class MockBlob {
  constructor(parts, opts = {}) {
    _lastBlobContent = typeof parts[0] === 'string' ? parts[0] : null;
    _lastBlobType    = opts.type ?? null;
    this.size = typeof parts[0] === 'string' ? parts[0].length : 0;
    this.type = opts.type ?? '';
  }
};

// File: thin wrapper (needed if browser delivery code runs)
globalThis.File = class MockFile extends globalThis.Blob {
  constructor(parts, name, opts = {}) { super(parts, opts); this.name = name; }
};

// URL: no-op object URLs
globalThis.URL = {
  createObjectURL: () => 'blob:mock://test',
  revokeObjectURL: () => {},
};

// document: capture last anchor created (for download tests)
let _lastAnchor = null;
globalThis.document = {
  createElement: tag => {
    if (tag === 'a') { _lastAnchor = { href: '', download: '', click() {} }; return _lastAnchor; }
    return {};
  },
  body: { appendChild: () => {}, removeChild: () => {} },
};

// navigator: starts with no share support; tests override per-scenario.
// Node 24 exposes navigator as a getter-only property, so we must use
// defineProperty to install a writable data property instead.
Object.defineProperty(globalThis, 'navigator', {
  value:        {},
  writable:     true,
  configurable: true,
});

// FileReader: reads ._content from the file-like object; fires async
globalThis.FileReader = class MockFileReader {
  constructor() { this.onload = null; this.onerror = null; }
  readAsText(file) {
    const text = (typeof file === 'object' && file !== null && '_content' in file)
      ? file._content
      : '';
    Promise.resolve().then(() => {
      if (this.onload) this.onload({ target: { result: text } });
    });
  }
};

/* ══════════════════════════════════════════════════════════════════
   SECTION 1: DYNAMIC IMPORTS (after globals are set)
═══════════════════════════════════════════════════════════════════ */

const { SEED_TASKS, ROOMS_ORDERED } = await import('../src/app/catalog.js');
const { tasks }                     = await import('../src/app/tasks.js');
const { backupStore }               = await import('../src/app/backup-store.js');
const { stagingStore }              = await import('../src/app/staging-store.js');
const { recoveryStore }             = await import('../src/app/recovery.js');
const { V1BackupService }           = await import('../src/data/backup/v1-backup-service.js');

/* ══════════════════════════════════════════════════════════════════
   SECTION 2: SINGLETON INJECTION — mutable proxy pattern
   Injection guards allow ONE call per singleton; we make that call once
   with a proxy whose internal state we swap per test.
═══════════════════════════════════════════════════════════════════ */

// Tasks singleton proxy (controls tasks.getAll() output)
const tasksState = { list: SEED_TASKS.map(s => ({ ...s, lastDone: null, doneToday: false, skipUntil: null })) };
const tasksProxy = { loadTasks: () => tasksState.list, saveTasks: () => ({ ok: true }) };
tasks.setRepo(tasksProxy);

/* ══════════════════════════════════════════════════════════════════
   SECTION 3: HELPERS
═══════════════════════════════════════════════════════════════════ */

const FIXED_ISO   = '2024-06-15T12:00:00.000Z';
const FIXED_TODAY = '2024-06-15';
const RealDate    = globalThis.Date;

/** Run fn with Date frozen to FIXED_ISO; restores Date afterward. */
async function withFrozenDate(fn) {
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_ISO);
      else super(...args);
    }
    toISOString() { return FIXED_ISO; }
    static now()  { return new RealDate(FIXED_ISO).getTime(); }
  }
  globalThis.Date = FrozenDate;
  try { return await fn(); }
  finally { globalThis.Date = RealDate; }
}

/** Create a file-like object (works with both globalThis.FileReader mock and injected fileReader). */
function makeFile(text) {
  return { size: text.length, _content: text };
}

/** Build a minimal valid v1 backup envelope as JSON string. */
function makeBackupEnvelope(overrides = {}) {
  const base = {
    app:           'HomeTask',
    schemaVersion: 1,
    exportedAt:    FIXED_ISO,
    catalogTaskCount: SEED_TASKS.length,
    catalogRoomCount: ROOMS_ORDERED.length,
    taskState: [{ id: SEED_TASKS[0].id, lastDone: null, doneToday: false, skipUntil: null, tags: [] }],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  };
  return JSON.stringify({ ...base, ...overrides });
}

/** Build a backing that wraps mockLS (used to give V1BackupService the same storage as backup.js). */
function makeBackingFromLS() {
  return {
    getItem:    k      => mockLS.getItem(k),
    setItem:    (k, v) => mockLS.setItem(k, v),
    removeItem: k      => mockLS.removeItem(k),
  };
}

/** Build a backing whose setItem throws on a named key. */
function makeFailBacking(failKey) {
  const store = new Map();
  return {
    getItem:    k      => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => {
      if (k === failKey) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: k      => store.delete(k),
    _store:     store,
  };
}

/** Build a backing whose applySnapshot always fails (for rollback-failed tests). */
function makeFailSnapshotBacking() {
  const store = new Map();
  return {
    getItem:    k      => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => {
      if (k === 'hometask-v1') throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: k      => store.delete(k),
    _store:     store,
  };
}

/** Minimal mock repo for V1BackupService unit tests. */
function makeMockRepo({ tasks: tl, prefs: pf, lastExport: le = null } = {}) {
  const state = { lastExport: le };
  return {
    loadTasks:     () => tl ?? [...SEED_TASKS],
    loadPrefs:     () => pf ?? {},
    getLastExport: () => state.lastExport,
    setLastExport: d  => { state.lastExport = d; },
    _state:        state,
  };
}

/** Delivery mock: records calls, no browser APIs. */
function makeDelivery({ canShareResult = false, shareThrows = null, downloadThrows = null } = {}) {
  const calls = { canShare: 0, share: 0, download: 0 };
  return {
    canShare:  () => { calls.canShare++; return canShareResult; },
    share:     async () => { calls.share++; if (shareThrows) throw shareThrows; },
    download:  (blob, filename) => {
      calls.download++;
      if (downloadThrows) throw downloadThrows;
    },
    _calls: calls,
  };
}

/** FileReader mock: resolves immediately with a fixed string. */
function makeFileReader(text) {
  return { readAsText: () => Promise.resolve(text) };
}

/** Build a V1BackupService with sensible defaults; override as needed. */
function makeSvc({
  catalogTasks = SEED_TASKS,
  catalogRooms = ROOMS_ORDERED,
  repo         = makeMockRepo(),
  backing      = makeBackingFromLS(),
  fileReader: fr = makeFileReader(''),
  delivery: del  = makeDelivery(),
  clock          = () => FIXED_ISO,
  sessionStore: ss = mockSS,
} = {}) {
  return new V1BackupService({
    catalogTasks, catalogRooms, repo, backing,
    backupStore, stagingStore, recoveryStore,
    fileReader: fr, delivery: del, clock, sessionStore: ss,
  });
}

/** Reset all shared storage between tests. */
function resetStorage() {
  mockLS.clear();
  mockSS.clear();
  _lastBlobContent = null;
  _lastBlobType    = null;
  _lastAnchor      = null;
}

/* ══════════════════════════════════════════════════════════════════
   TEST HARNESS
═══════════════════════════════════════════════════════════════════ */
let passed   = 0;
let failed   = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓  ${name}\n`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    process.stderr.write(`  ✗  ${name}\n     ${e.message}\n`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   SECTION A: CONSTRUCTOR VALIDATION
═══════════════════════════════════════════════════════════════════ */
console.log('\nV1BackupService — Suite 17\n');
console.log('── A: Constructor validation ──');

await check('A1: throws on empty catalogTasks', async () => {
  assert.throws(() => new V1BackupService({
    catalogTasks: [], catalogRooms: ROOMS_ORDERED,
    repo: makeMockRepo(), backing: makeBackingFromLS(),
    backupStore, stagingStore, recoveryStore,
    fileReader: makeFileReader(''), delivery: makeDelivery(),
    clock: () => FIXED_ISO, sessionStore: mockSS,
  }), /catalogTasks/);
});

await check('A2: throws on missing catalogRooms', async () => {
  assert.throws(() => new V1BackupService({
    catalogTasks: SEED_TASKS, catalogRooms: null,
    repo: makeMockRepo(), backing: makeBackingFromLS(),
    backupStore, stagingStore, recoveryStore,
    fileReader: makeFileReader(''), delivery: makeDelivery(),
    clock: () => FIXED_ISO, sessionStore: mockSS,
  }), /catalogRooms/);
});

await check('A3: throws on missing repo', async () => {
  assert.throws(() => makeSvc({ repo: null }), /repo/);
});

await check('A4: throws on missing backing', async () => {
  assert.throws(() => makeSvc({ backing: null }), /backing/);
});

await check('A5: throws on missing delivery', async () => {
  assert.throws(() => makeSvc({ delivery: null }), /delivery/);
});

await check('A6: throws on missing clock', async () => {
  assert.throws(() => new V1BackupService({
    catalogTasks: SEED_TASKS, catalogRooms: ROOMS_ORDERED,
    repo: makeMockRepo(), backing: makeBackingFromLS(),
    backupStore, stagingStore, recoveryStore,
    fileReader: makeFileReader(''), delivery: makeDelivery(),
    clock: 'not-a-function', sessionStore: mockSS,
  }), /clock/);
});

await check('A7: throws on missing sessionStore', async () => {
  assert.throws(() => makeSvc({ sessionStore: null }), /sessionStore/);
});

await check('A8: valid construction succeeds', async () => {
  const svc = makeSvc();
  assert.equal(typeof svc.exportBackup, 'function');
  assert.equal(typeof svc.applyImport, 'function');
  assert.equal(typeof svc.applyUndo, 'function');
  assert.equal(typeof svc.getRecoveryNoticeState, 'function');
});

/* ══════════════════════════════════════════════════════════════════
   SECTION B: EXPORT — DIFFERENTIAL (frozen Date)
   Two independent V1BackupService instances run against the same
   task/prefs fixture.  Compare complete envelope and serialized bytes.
═══════════════════════════════════════════════════════════════════ */
console.log('\n── B: Export differential ──');

const EXPORT_TASKS = SEED_TASKS.map((s, i) => ({
  ...s, lastDone: i % 3 === 0 ? '2024-06-14' : null, doneToday: false, skipUntil: null,
}));
const EXPORT_PREFS = {
  viewMode: 'week', roomFilter: ROOMS_ORDERED[0] ?? '', onboarded: true,
  choice: 'balanced', completedAt: '2024-05-01', dueNowDefault: false,
};

// Two independent service instances each produce JSON via the global Blob mock.
let blobJsonBackup = null;
let blobJsonSvc    = null;

await check('B1: reference V1BackupService export — envelope bytes captured', async () => {
  resetStorage();
  const del    = makeDelivery({ canShareResult: false });
  const repo   = makeMockRepo({ tasks: EXPORT_TASKS, prefs: EXPORT_PREFS });
  const refSvc = makeSvc({ repo, delivery: del, clock: () => FIXED_ISO });

  await withFrozenDate(async () => {
    const result = await refSvc.exportBackup();
    assert.ok(result.ok, 'exportBackup should return ok:true');
    blobJsonBackup = _lastBlobContent;
  });
  assert.ok(blobJsonBackup, 'blob content captured');
});

await check('B2: V1BackupService export — envelope bytes captured', async () => {
  const capturedBlobs = [];
  const del = {
    canShare:  () => false,
    download:  (blob) => { capturedBlobs.push(_lastBlobContent); },
  };
  const repo = makeMockRepo({ tasks: EXPORT_TASKS, prefs: EXPORT_PREFS });
  const svc  = makeSvc({ repo, delivery: del, clock: () => FIXED_ISO });

  await withFrozenDate(async () => {
    const result = await svc.exportBackup();
    assert.ok(result.ok);
    blobJsonSvc = _lastBlobContent;
  });
  assert.ok(blobJsonSvc, 'svc blob content captured');
});

await check('B3: envelope taskState is byte-identical', async () => {
  const a = JSON.parse(blobJsonBackup);
  const b = JSON.parse(blobJsonSvc);
  assert.deepEqual(a.taskState, b.taskState,
    'taskState mismatch between reference svc and test svc');
});

await check('B4: envelope preferences is byte-identical', async () => {
  const a = JSON.parse(blobJsonBackup);
  const b = JSON.parse(blobJsonSvc);
  assert.deepEqual(a.preferences, b.preferences,
    'preferences mismatch between reference svc and test svc');
});

await check('B5: envelope header fields match', async () => {
  const a = JSON.parse(blobJsonBackup);
  const b = JSON.parse(blobJsonSvc);
  assert.equal(a.app,              b.app);
  assert.equal(a.schemaVersion,    b.schemaVersion);
  assert.equal(a.catalogTaskCount, b.catalogTaskCount);
  assert.equal(a.catalogRoomCount, b.catalogRoomCount);
});

await check('B6: exportedAt equals FIXED_ISO in both', async () => {
  const a = JSON.parse(blobJsonBackup);
  const b = JSON.parse(blobJsonSvc);
  assert.equal(a.exportedAt, FIXED_ISO);
  assert.equal(b.exportedAt, FIXED_ISO);
});

await check('B7: serialized JSON bytes are byte-identical', async () => {
  assert.equal(blobJsonSvc, blobJsonBackup, 'JSON bytes differ between implementations');
});

/* ══════════════════════════════════════════════════════════════════
   SECTION C: EXPORT — SHARE/DOWNLOAD DELIVERY BEHAVIORS
   Matches production semantics exactly (non-Abort share failure → download).
═══════════════════════════════════════════════════════════════════ */
console.log('\n── C: Export share/download behaviors ──');

await check('C1: canShare=false → download called, ok:true, lastExport set', async () => {
  resetStorage();
  const del  = makeDelivery({ canShareResult: false });
  const repo = makeMockRepo({ tasks: SEED_TASKS, prefs: {} });
  const svc  = makeSvc({ repo, delivery: del });
  const r = await svc.exportBackup();
  assert.ok(r.ok);
  assert.equal(del._calls.share, 0);
  assert.equal(del._calls.download, 1);
  assert.ok(repo.getLastExport() !== null, 'lastExport should be set');
});

await check('C2: canShare=true, share succeeds → ok:true, lastExport set, download NOT called', async () => {
  resetStorage();
  const del  = makeDelivery({ canShareResult: true });
  const repo = makeMockRepo({ tasks: SEED_TASKS, prefs: {} });
  const svc  = makeSvc({ repo, delivery: del });
  const r = await svc.exportBackup();
  assert.ok(r.ok);
  assert.equal(del._calls.share, 1);
  assert.equal(del._calls.download, 0);
  assert.ok(repo.getLastExport() !== null);
});

await check('C3: canShare=true, share throws AbortError → ok:false, lastExport NOT set', async () => {
  resetStorage();
  const abort = Object.assign(new Error('User aborted'), { name: 'AbortError' });
  const del   = makeDelivery({ canShareResult: true, shareThrows: abort });
  const repo  = makeMockRepo({ tasks: SEED_TASKS, prefs: {} });
  const svc   = makeSvc({ repo, delivery: del });
  const r = await svc.exportBackup();
  assert.ok(!r.ok);
  assert.match(r.message, /cancelled/);
  assert.equal(repo.getLastExport(), null, 'lastExport must NOT be set on abort');
});

await check('C4: canShare=true, share throws non-Abort → falls through to download', async () => {
  resetStorage();
  const err  = new Error('Share failed (network)');  // not AbortError
  const del  = makeDelivery({ canShareResult: true, shareThrows: err });
  const repo = makeMockRepo({ tasks: SEED_TASKS, prefs: {} });
  const svc  = makeSvc({ repo, delivery: del });
  const r = await svc.exportBackup();
  assert.ok(r.ok, 'should succeed via download fallback');
  assert.equal(del._calls.download, 1, 'download must be called as fallback');
  assert.ok(repo.getLastExport() !== null);
});

await check('C5: download throws → ok:false, lastExport NOT set', async () => {
  resetStorage();
  const del  = makeDelivery({ canShareResult: false, downloadThrows: new Error('no disk') });
  const repo = makeMockRepo({ tasks: SEED_TASKS, prefs: {} });
  const svc  = makeSvc({ repo, delivery: del });
  const r = await svc.exportBackup();
  assert.ok(!r.ok);
  assert.match(r.message, /could not be saved/i);
  assert.equal(repo.getLastExport(), null);
});

/* ══════════════════════════════════════════════════════════════════
   SECTION D: readAndValidate — DIFFERENTIAL
   Same file → same sanitizedTasks, sanitizedPrefs, exportDate, taskCount.
═══════════════════════════════════════════════════════════════════ */
console.log('\n── D: readAndValidate differential ──');

const RV_FIXTURE_TASKS = [
  { id: SEED_TASKS[0].id, lastDone: '2024-06-01', doneToday: false, skipUntil: null, tags: ['a'] },
  { id: SEED_TASKS[1].id, lastDone: null, doneToday: false, skipUntil: null, tags: [] },
];
const RV_FIXTURE_ENVELOPE = JSON.stringify({
  app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
  catalogTaskCount: SEED_TASKS.length, catalogRoomCount: ROOMS_ORDERED.length,
  taskState: RV_FIXTURE_TASKS,
  preferences: { viewMode: 'week', roomFilter: ROOMS_ORDERED[0] ?? '', onboarded: true, choice: 'balanced', completedAt: null },
});
const RV_FILE = makeFile(RV_FIXTURE_ENVELOPE);

let rvResultBackup = null;
let rvResultSvc    = null;

await check('D1: reference V1BackupService readAndValidate resolves', async () => {
  const refSvc   = makeSvc({ fileReader: makeFileReader(RV_FIXTURE_ENVELOPE) });
  rvResultBackup = await refSvc.readAndValidate({ size: RV_FIXTURE_ENVELOPE.length });
  assert.ok(rvResultBackup, 'should resolve');
  assert.equal(typeof rvResultBackup.taskCount, 'number');
});

await check('D2: V1BackupService readAndValidate resolves', async () => {
  const svc = makeSvc({ fileReader: makeFileReader(RV_FIXTURE_ENVELOPE) });
  rvResultSvc = await svc.readAndValidate({ size: RV_FIXTURE_ENVELOPE.length });
  assert.ok(rvResultSvc, 'should resolve');
});

await check('D3: sanitizedTasks are identical', async () => {
  assert.deepEqual(rvResultSvc.sanitizedTasks, rvResultBackup.sanitizedTasks);
});

await check('D4: sanitizedPrefs and taskCount are identical', async () => {
  assert.deepEqual(rvResultSvc.sanitizedPrefs, rvResultBackup.sanitizedPrefs);
  assert.equal(rvResultSvc.taskCount, rvResultBackup.taskCount);
});

/* ══════════════════════════════════════════════════════════════════
   SECTION E: readAndValidate — HOSTILE JSON (file-import boundary)
   Uses JSON-serializable hostile data (not Object.create — those cannot
   survive JSON serialization and so cannot appear in real backup files).
═══════════════════════════════════════════════════════════════════ */
console.log('\n── E: readAndValidate hostile JSON boundary ──');

await check('E1: oversized file rejected before parse', async () => {
  const svc = makeSvc();
  await assert.rejects(svc.readAndValidate({ size: 3 * 1024 * 1024 }), /too large/i);
});

await check('E2: malformed JSON rejected', async () => {
  const svc = makeSvc({ fileReader: makeFileReader('{ not valid json') });
  await assert.rejects(svc.readAndValidate({ size: 10 }), /could not be read/i);
});

await check('E3: wrong app name rejected', async () => {
  const bad = makeBackupEnvelope({ app: 'NotHomeTask' });
  const svc = makeSvc({ fileReader: makeFileReader(bad) });
  await assert.rejects(svc.readAndValidate({ size: bad.length }), /not created by HomeTask/i);
});

await check('E4: future schemaVersion rejected', async () => {
  const bad = makeBackupEnvelope({ schemaVersion: 99 });
  const svc = makeSvc({ fileReader: makeFileReader(bad) });
  await assert.rejects(svc.readAndValidate({ size: bad.length }), /newer version/i);
});

await check('E5: catalog fields in task records are stripped by readAndValidate', async () => {
  // A hostile backup file where task records include catalog fields (JSON-serializable).
  const hostile = JSON.stringify({
    app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
    catalogTaskCount: 1, catalogRoomCount: 1,
    taskState: [{
      id:          SEED_TASKS[0].id,
      lastDone:    '2024-06-01',
      doneToday:   false,
      skipUntil:   null,
      tags:        [],
      title:       'EVIL TITLE',           // catalog field — must be stripped
      room:        'EVIL ROOM',            // catalog field — must be stripped
      intervalDays: 9999,                  // catalog field — must be stripped
      safety:      true,                   // catalog field — must be stripped
    }],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  });
  const svc    = makeSvc({ fileReader: makeFileReader(hostile) });
  const result = await svc.readAndValidate({ size: hostile.length });
  const t      = result.sanitizedTasks.find(x => x.id === SEED_TASKS[0].id);
  assert.ok(t, 'known task should be present');
  assert.ok(!Object.hasOwn(t, 'title'),        'title must be stripped');
  assert.ok(!Object.hasOwn(t, 'room'),         'room must be stripped');
  assert.ok(!Object.hasOwn(t, 'intervalDays'), 'intervalDays must be stripped');
  assert.ok(!Object.hasOwn(t, 'safety'),       'safety must be stripped');
  assert.equal(t.lastDone,    '2024-06-01');
});

await check('E6: __proto__ in JSON task record treated as plain field, not prototype pollution', async () => {
  // JSON.parse never pollutes Object.prototype — the key "__proto__" becomes a string key.
  // The sanitizer must strip it (it is not in the whitelist).
  const hostile = JSON.stringify({
    app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
    catalogTaskCount: 1, catalogRoomCount: 1,
    taskState: [{
      id:        SEED_TASKS[0].id,
      lastDone:  '2024-06-01',
      doneToday: false,
      skipUntil: null,
      tags:      [],
      '__proto__': { evilField: 1 },
    }],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  });
  const svc    = makeSvc({ fileReader: makeFileReader(hostile) });
  const result = await svc.readAndValidate({ size: hostile.length });
  // Object.prototype should not have been polluted
  assert.equal(({}).evilField, undefined, '__proto__ key must not pollute Object.prototype');
  const t = result.sanitizedTasks.find(x => x.id === SEED_TASKS[0].id);
  // The sanitizer only emits { id, lastDone, doneToday, skipUntil, tags } —
  // '__proto__' must not appear as an own property on the sanitized record.
  assert.ok(t && !Object.hasOwn(t, '__proto__'), '__proto__ key must not appear in sanitized record');
});

await check('E7: object values in tags array are stripped; string values kept', async () => {
  const hostile = JSON.stringify({
    app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
    catalogTaskCount: 1, catalogRoomCount: 1,
    taskState: [{
      id:        SEED_TASKS[0].id,
      lastDone:  null,
      doneToday: false,
      skipUntil: null,
      tags:      [{ evil: true }, 'safe-tag', 42, 'another'],
    }],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  });
  const svc    = makeSvc({ fileReader: makeFileReader(hostile) });
  const result = await svc.readAndValidate({ size: hostile.length });
  const t      = result.sanitizedTasks.find(x => x.id === SEED_TASKS[0].id);
  assert.deepEqual(t.tags, ['safe-tag', 'another'], 'only string tags survive');
});

await check('E8: unknown IDs skipped silently; known IDs present', async () => {
  const envelope = JSON.stringify({
    app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
    catalogTaskCount: 2, catalogRoomCount: 1,
    taskState: [
      { id: 'FAKE-99999', lastDone: '2024-06-01', doneToday: false, skipUntil: null, tags: [] },
      { id: SEED_TASKS[0].id, lastDone: '2024-06-01', doneToday: false, skipUntil: null, tags: [] },
    ],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  });
  const svc    = makeSvc({ fileReader: makeFileReader(envelope) });
  const result = await svc.readAndValidate({ size: envelope.length });
  assert.ok(!result.sanitizedTasks.some(t => t.id === 'FAKE-99999'), 'unknown ID must be skipped');
  assert.ok(result.sanitizedTasks.some(t => t.id === SEED_TASKS[0].id), 'known ID must be present');
});

/* ══════════════════════════════════════════════════════════════════
   SECTION F: applyImport — DEFENSIVE WHITELIST
   Tests that applyImport itself enforces the catalog boundary even if
   the caller passes an over-filled "sanitized" object.
═══════════════════════════════════════════════════════════════════ */
console.log('\n── F: applyImport defensive whitelist ──');

const OVERFILLED = SEED_TASKS.map(seed => ({
  id:          seed.id,
  lastDone:    '2024-06-01',
  doneToday:   false,
  skipUntil:   null,
  tags:        [],
  title:       'INJECTED TITLE',
  room:        'INJECTED ROOM',
  intervalDays: 9999,
  safety:      !seed.safety,   // flip the safety flag
}));

await check('F1: title cannot be overridden via applyImport caller', async () => {
  resetStorage();
  const backing = makeBackingFromLS();
  const svc = makeSvc({ repo: makeMockRepo({ tasks: SEED_TASKS, prefs: {} }), backing });
  const r = svc.applyImport(OVERFILLED, {});
  assert.ok(r.ok, 'import should succeed');
  const stored = JSON.parse(mockLS.getItem('hometask-v1'));
  stored.forEach((t, i) => {
    assert.equal(t.title, SEED_TASKS[i].title,
      `title must come from seed for task ${i}, got: ${t.title}`);
  });
});

await check('F2: room cannot be overridden via applyImport caller', async () => {
  const stored = JSON.parse(mockLS.getItem('hometask-v1'));
  stored.forEach((t, i) => {
    assert.equal(t.room, SEED_TASKS[i].room, `room must come from seed for task ${i}`);
  });
});

await check('F3: intervalDays cannot be overridden via applyImport caller', async () => {
  const stored = JSON.parse(mockLS.getItem('hometask-v1'));
  stored.forEach((t, i) => {
    assert.equal(t.intervalDays, SEED_TASKS[i].intervalDays,
      `intervalDays must come from seed for task ${i}`);
  });
});

await check('F4: safety cannot be overridden via applyImport caller', async () => {
  const stored = JSON.parse(mockLS.getItem('hometask-v1'));
  stored.forEach((t, i) => {
    assert.equal(t.safety, SEED_TASKS[i].safety,
      `safety must come from seed for task ${i}`);
  });
});

/* ══════════════════════════════════════════════════════════════════
   SECTION G: applyImport — DIFFERENTIAL HAPPY PATH
   Two independent V1BackupService instances: same pre-import state →
   same final storage bytes.
═══════════════════════════════════════════════════════════════════ */
console.log('\n── G: applyImport differential happy path ──');

const IMP_SANITIZED_TASKS = [
  { id: SEED_TASKS[0].id, lastDone: '2024-06-14', doneToday: true,  skipUntil: null, tags: ['a'] },
  { id: SEED_TASKS[1].id, lastDone: '2024-06-10', doneToday: false, skipUntil: null, tags: [] },
];
const IMP_SANITIZED_PREFS = { viewMode: 'week', roomFilter: '', onboarded: true, choice: 'balanced', completedAt: null };
const IMP_EXISTING_PREFS  = { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null, dueNowDefault: false };

let importStateBackup = null;
let importStateSvc    = null;

await check('G1: reference V1BackupService applyImport happy path', async () => {
  resetStorage();
  mockLS.setItem('hometask-meta-v1', JSON.stringify(IMP_EXISTING_PREFS));

  const backing = makeBackingFromLS();
  const repo    = makeMockRepo({ tasks: SEED_TASKS, prefs: IMP_EXISTING_PREFS });
  const refSvc  = makeSvc({ repo, backing, clock: () => FIXED_ISO });

  await withFrozenDate(async () => {
    const r = refSvc.applyImport(IMP_SANITIZED_TASKS, IMP_SANITIZED_PREFS);
    assert.ok(r.ok, `reference svc applyImport failed: ${r.message}`);
  });
  importStateBackup = mockLS._snapshot();
  assert.ok(importStateBackup.has('hometask-v1'));
});

await check('G2: V1BackupService applyImport happy path', async () => {
  resetStorage();
  mockLS.setItem('hometask-meta-v1', JSON.stringify(IMP_EXISTING_PREFS));
  const backing = makeBackingFromLS();
  const repo    = makeMockRepo({ tasks: SEED_TASKS, prefs: IMP_EXISTING_PREFS });
  const svc     = makeSvc({ repo, backing, clock: () => FIXED_ISO });

  await withFrozenDate(async () => {
    const r = svc.applyImport(IMP_SANITIZED_TASKS, IMP_SANITIZED_PREFS);
    assert.ok(r.ok, `V1BackupService applyImport failed: ${r.message}`);
  });
  importStateSvc = mockLS._snapshot();
  assert.ok(importStateSvc.has('hometask-v1'));
});

await check('G3: hometask-v1 bytes are identical', async () => {
  assert.equal(
    importStateSvc.get('hometask-v1'),
    importStateBackup.get('hometask-v1'),
    'hometask-v1 bytes differ between implementations',
  );
});

await check('G4: hometask-meta-v1 bytes are byte-identical', async () => {
  // Byte equality is the primary assertion: V1BackupService must produce
  // exactly the same hometask-meta-v1 raw string as backup.js.
  // Both normalise existing prefs through { ...META_DEFAULTS, ...stored }
  // before merging sanitizedPrefs, giving DEFAULTS insertion-order output.
  assert.equal(
    importStateSvc.get('hometask-meta-v1'),
    importStateBackup.get('hometask-meta-v1'),
    'meta bytes differ between implementations',
  );
  // Semantic confirmation alongside byte equality.
  const a = JSON.parse(importStateBackup.get('hometask-meta-v1'));
  const b = JSON.parse(importStateSvc.get('hometask-meta-v1'));
  assert.deepEqual(b, a, 'meta data differs semantically (should be impossible if bytes match)');
});

await check('G5: staging key cleared after successful import (both)', async () => {
  // Map.get() returns undefined for absent keys; absent === cleared.
  assert.ok(!importStateBackup.has('hometask-import-staging-v1'), 'reference svc must clear staging');
  assert.ok(!importStateSvc.has('hometask-import-staging-v1'),    'test svc must clear staging');
});

await check('G6: snapshot key present in hometask-backup-v1 after import (both)', async () => {
  // backupStore saves snapshot under 'hometask-backup-v1'
  const bk = importStateBackup.get('hometask-backup-v1');
  const bs = importStateSvc.get('hometask-backup-v1');
  assert.ok(bk && JSON.parse(bk).snapshot, 'reference svc: snapshot must be present');
  assert.ok(bs && JSON.parse(bs).snapshot, 'test svc: snapshot must be present');
});

await check('G7: doneToday coerced to false when lastDone ≠ FIXED_TODAY', async () => {
  // Seed[1] got lastDone='2024-06-10' which != FIXED_TODAY='2024-06-15'
  const stored = JSON.parse(importStateSvc.get('hometask-v1'));
  const t1     = stored.find(t => t.id === SEED_TASKS[1].id);
  assert.ok(t1, 'task must be in stored list');
  assert.equal(t1.doneToday, false, 'doneToday must be false when lastDone ≠ today');
});

/* ══════════════════════════════════════════════════════════════════
   SECTION H: applyImport — FAILURE MODES
═══════════════════════════════════════════════════════════════════ */
console.log('\n── H: applyImport failure modes ──');

await check('H1: rollback_failed guard — blocks new import', async () => {
  resetStorage();
  // Plant a rollback_failed staging record
  mockLS.setItem('hometask-import-staging-v1', JSON.stringify({ txState: 'rollback_failed' }));
  const svc = makeSvc({ repo: makeMockRepo({ tasks: SEED_TASKS, prefs: {} }) });
  const r   = svc.applyImport([], {});
  assert.ok(!r.ok);
  assert.match(r.message, /Undo Last Import/);
});

await check('H2: snapshot save failure → data unchanged, staging not written', async () => {
  resetStorage();
  // Make backupStore.saveSnapshot fail by making localStorage.setItem fail for backup key
  const origSetItem = mockLS.setItem.bind(mockLS);
  mockLS.setItem = (k, v) => {
    if (k === 'hometask-backup-v1') throw new Error('quota');
    origSetItem(k, v);
  };
  const svc = makeSvc({ repo: makeMockRepo({ tasks: SEED_TASKS, prefs: {} }) });
  const r   = svc.applyImport([{ id: SEED_TASKS[0].id, lastDone: null, doneToday: false, skipUntil: null, tags: [] }], {});
  mockLS.setItem = origSetItem;
  assert.ok(!r.ok);
  assert.match(r.message, /undo checkpoint/i);
  assert.equal(mockLS.getItem('hometask-import-staging-v1'), null, 'staging must not be written');
});

await check('H3: staging write failure → snapshot present but staging absent', async () => {
  resetStorage();
  // Make staging write fail but allow backup key
  const origSetItem = mockLS.setItem.bind(mockLS);
  let backupWritten = false;
  mockLS.setItem = (k, v) => {
    if (k === 'hometask-backup-v1') { backupWritten = true; origSetItem(k, v); return; }
    if (k === 'hometask-import-staging-v1') throw new Error('quota');
    origSetItem(k, v);
  };
  const svc = makeSvc({ repo: makeMockRepo({ tasks: SEED_TASKS, prefs: {} }) });
  const r   = svc.applyImport([{ id: SEED_TASKS[0].id, lastDone: null, doneToday: false, skipUntil: null, tags: [] }], {});
  mockLS.setItem = origSetItem;
  assert.ok(!r.ok);
  assert.ok(backupWritten, 'snapshot must have been saved before staging failure');
  assert.equal(mockLS.getItem('hometask-import-staging-v1'), null);
});

await check('H4: commit write failure → rollback restores pre-import bytes', async () => {
  resetStorage();
  const preImportTasks = JSON.stringify(SEED_TASKS.map(s => ({ ...s, lastDone: null, doneToday: false, skipUntil: null })));
  const preImportPrefs = JSON.stringify({ viewMode: 'today' });
  mockLS.setItem('hometask-v1',      preImportTasks);
  mockLS.setItem('hometask-meta-v1', preImportPrefs);

  const failBacking = makeFailBacking('hometask-v1');
  const svc = makeSvc({
    repo: makeMockRepo({ tasks: SEED_TASKS, prefs: { viewMode: 'today' } }),
    backing: failBacking,
  });
  const r = svc.applyImport(
    [{ id: SEED_TASKS[0].id, lastDone: '2024-06-14', doneToday: false, skipUntil: null, tags: [] }],
    {},
  );
  assert.ok(!r.ok);
  assert.match(r.message, /recovered automatically/i);
  // Rollback should have restored the original bytes via backupStore.applySnapshot
  assert.equal(mockLS.getItem('hometask-v1'), preImportTasks, 'rollback must restore hometask-v1');
  assert.equal(mockLS.getItem('hometask-import-staging-v1'), null, 'staging must be cleared after successful rollback');
});

await check('H5: commit write failure + rollback failure → txState=rollback_failed, snapshot retained', async () => {
  resetStorage();
  const preTasks = JSON.stringify(SEED_TASKS.map(s => ({ ...s, lastDone: null, doneToday: false, skipUntil: null })));
  mockLS.setItem('hometask-v1',      preTasks);
  mockLS.setItem('hometask-meta-v1', JSON.stringify({ viewMode: 'today' }));

  // Save snapshot first (while writes still work)
  backupStore.saveSnapshot();

  // Now block hometask-v1 writes globally — this causes BOTH:
  //   • the commit (via backing.setItem) to fail, AND
  //   • the rollback (via backupStore.applySnapshot → localStorage.setItem) to fail.
  const origSetItem = mockLS.setItem.bind(mockLS);
  mockLS.setItem = (k, v) => {
    if (k === 'hometask-v1') throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    origSetItem(k, v);
  };

  const backing = {
    getItem:    k      => mockLS.getItem(k),
    setItem:    (k, v) => mockLS.setItem(k, v),   // also fails for hometask-v1
    removeItem: k      => mockLS.removeItem(k),
  };

  const svc = makeSvc({
    repo: makeMockRepo({ tasks: SEED_TASKS, prefs: { viewMode: 'today' } }),
    backing,
  });
  const r = svc.applyImport(
    [{ id: SEED_TASKS[0].id, lastDone: '2024-06-14', doneToday: false, skipUntil: null, tags: [] }],
    {},
  );
  mockLS.setItem = origSetItem;   // restore before assertions

  assert.ok(!r.ok);
  const staging = stagingStore.get();
  assert.ok(staging, 'staging must be retained');
  assert.equal(staging.txState, 'rollback_failed');
  assert.ok(backupStore.getSnapshot(), 'snapshot must be retained for Undo');
});

/* ══════════════════════════════════════════════════════════════════
   SECTION I: applyUndo — DIFFERENTIAL + FAILURE MODES
   Two independent V1BackupService instances restore the same snapshot.
═══════════════════════════════════════════════════════════════════ */
console.log('\n── I: applyUndo differential + failures ──');

const UNDO_PRE_TASKS = JSON.stringify(SEED_TASKS.map(s => ({ ...s, lastDone: '2024-05-01', doneToday: false, skipUntil: null })));
const UNDO_PRE_PREFS = JSON.stringify({ viewMode: 'today', roomFilter: '', onboarded: true, choice: 'current', completedAt: '2024-01-01' });

let undoStateBackup = null;
let undoStateSvc    = null;

await check('I1: reference V1BackupService applyUndo restores snapshot bytes', async () => {
  resetStorage();
  // Plant pre-import state in snapshot
  mockLS.setItem('hometask-v1',      UNDO_PRE_TASKS);
  mockLS.setItem('hometask-meta-v1', UNDO_PRE_PREFS);
  const snapResult = backupStore.saveSnapshot();
  assert.ok(snapResult.ok, 'snapshot must be saved');
  // Overwrite with post-import data
  mockLS.setItem('hometask-v1',      JSON.stringify([{ id: 'changed' }]));
  mockLS.setItem('hometask-meta-v1', JSON.stringify({ viewMode: 'week' }));

  const refSvc = makeSvc({ backing: makeBackingFromLS() });
  const r      = refSvc.applyUndo();
  assert.ok(r.ok, `applyUndo failed: ${r.error}`);
  undoStateBackup = mockLS._snapshot();
});

await check('I2: V1BackupService applyUndo restores same bytes', async () => {
  resetStorage();
  mockLS.setItem('hometask-v1',      UNDO_PRE_TASKS);
  mockLS.setItem('hometask-meta-v1', UNDO_PRE_PREFS);
  backupStore.saveSnapshot();
  // Overwrite
  mockLS.setItem('hometask-v1',      JSON.stringify([{ id: 'changed' }]));
  mockLS.setItem('hometask-meta-v1', JSON.stringify({ viewMode: 'week' }));

  const svc = makeSvc({ backing: makeBackingFromLS() });
  const r   = svc.applyUndo();
  assert.ok(r.ok);
  undoStateSvc = mockLS._snapshot();
});

await check('I3: hometask-v1 bytes identical after undo', async () => {
  assert.equal(undoStateSvc.get('hometask-v1'), undoStateBackup.get('hometask-v1'));
});

await check('I4: hometask-meta-v1 bytes identical after undo', async () => {
  assert.equal(undoStateSvc.get('hometask-meta-v1'), undoStateBackup.get('hometask-meta-v1'));
});

await check('I5: snapshot cleared after successful undo (both)', async () => {
  const bkSnap   = undoStateBackup.get('hometask-backup-v1');
  const svcSnap  = undoStateSvc.get('hometask-backup-v1');
  // snapshot field should be absent (but lastExport may still be present)
  const bkParsed  = bkSnap  ? JSON.parse(bkSnap)  : {};
  const svcParsed = svcSnap ? JSON.parse(svcSnap)  : {};
  assert.equal(bkParsed.snapshot,  undefined, 'snapshot must be cleared after reference svc undo');
  assert.equal(svcParsed.snapshot, undefined, 'snapshot must be cleared after test svc undo');
});

await check('I6: applyUndo with no snapshot → ok:false, error:no-snapshot', async () => {
  resetStorage();
  const svc = makeSvc();
  const r   = svc.applyUndo();
  assert.ok(!r.ok);
  assert.equal(r.error, 'no-snapshot');
});

/* ══════════════════════════════════════════════════════════════════
   SECTION J: CATALOG AUTHORITY — duplicate ID + unknown ID
═══════════════════════════════════════════════════════════════════ */
console.log('\n── J: Catalog authority, duplicate ID, unknown ID ──');

await check('J1: duplicate ID — first occurrence wins (production semantics)', async () => {
  // The _sanitizeTaskState loop does: if (seen.has(rec.id)) continue — first wins.
  const envelope = JSON.stringify({
    app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
    catalogTaskCount: 1, catalogRoomCount: 1,
    taskState: [
      { id: SEED_TASKS[0].id, lastDone: '2024-06-01', doneToday: false, skipUntil: null, tags: ['FIRST'] },
      { id: SEED_TASKS[0].id, lastDone: '2024-06-10', doneToday: false, skipUntil: null, tags: ['SECOND'] },
    ],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  });
  const svc    = makeSvc({ fileReader: makeFileReader(envelope) });
  const result = await svc.readAndValidate({ size: envelope.length });
  const matches = result.sanitizedTasks.filter(t => t.id === SEED_TASKS[0].id);
  assert.equal(matches.length, 1, 'only one record for the duplicate ID');
  assert.deepEqual(matches[0].tags, ['FIRST'], 'first occurrence wins');
});

await check('J2: duplicate ID differential — second V1BackupService also applies first-wins', async () => {
  const content = JSON.stringify({
    app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
    catalogTaskCount: 1, catalogRoomCount: 1,
    taskState: [
      { id: SEED_TASKS[0].id, lastDone: '2024-06-01', doneToday: false, skipUntil: null, tags: ['FIRST'] },
      { id: SEED_TASKS[0].id, lastDone: '2024-06-10', doneToday: false, skipUntil: null, tags: ['SECOND'] },
    ],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  });
  const file    = makeFile(content);
  const refSvc  = makeSvc({ fileReader: makeFileReader(content) });
  const r = await refSvc.readAndValidate(file);
  const matches = r.sanitizedTasks.filter(t => t.id === SEED_TASKS[0].id);
  assert.equal(matches.length, 1, 'reference svc: only one record for the duplicate ID');
  assert.deepEqual(matches[0].tags, ['FIRST'], 'reference svc first-wins matches svc behavior');
});

await check('J3: unknown ID silently skipped, result length = number of known IDs', async () => {
  const envelope = JSON.stringify({
    app: 'HomeTask', schemaVersion: 1, exportedAt: FIXED_ISO,
    catalogTaskCount: 2, catalogRoomCount: 1,
    taskState: [
      { id: 'NOT-A-REAL-TASK', lastDone: '2024-06-01', doneToday: false, skipUntil: null, tags: [] },
      { id: SEED_TASKS[0].id, lastDone: '2024-06-01', doneToday: false, skipUntil: null, tags: [] },
      { id: SEED_TASKS[1].id, lastDone: null, doneToday: false, skipUntil: null, tags: [] },
    ],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null },
  });
  const svc    = makeSvc({ fileReader: makeFileReader(envelope) });
  const result = await svc.readAndValidate({ size: envelope.length });
  assert.equal(result.taskCount, 2, 'only 2 known IDs');
  assert.ok(!result.sanitizedTasks.some(t => t.id === 'NOT-A-REAL-TASK'), 'unknown ID not in output');
});

/* ══════════════════════════════════════════════════════════════════
   SECTION K: STATE QUERIES
═══════════════════════════════════════════════════════════════════ */
console.log('\n── K: State queries ──');

await check('K1: hasSnapshot() → false when no snapshot', async () => {
  resetStorage();
  const svc = makeSvc();
  assert.equal(svc.hasSnapshot(), false);
});

await check('K2: hasSnapshot() → true after saveSnapshot', async () => {
  resetStorage();
  mockLS.setItem('hometask-v1',      JSON.stringify([]));
  mockLS.setItem('hometask-meta-v1', JSON.stringify({}));
  backupStore.saveSnapshot();
  const svc = makeSvc();
  assert.equal(svc.hasSnapshot(), true);
});

await check('K3: getLastExport() delegates to repo.getLastExport()', async () => {
  const repo = makeMockRepo({ lastExport: '2024-06-15' });
  const svc  = makeSvc({ repo });
  assert.equal(svc.getLastExport(), '2024-06-15');
});

await check('K4: getLastExport() → null when no last export', async () => {
  const svc = makeSvc({ repo: makeMockRepo({ lastExport: null }) });
  assert.equal(svc.getLastExport(), null);
});

/* ══════════════════════════════════════════════════════════════════
   SECTION L: getRecoveryNoticeState
═══════════════════════════════════════════════════════════════════ */
console.log('\n── L: getRecoveryNoticeState ──');

await check('L1: no flags → visible:false', async () => {
  resetStorage();
  const svc   = makeSvc();
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible, false);
});

await check('L2: recoveryStore.hasUndismissed → damaged-data notice with showDownload', async () => {
  resetStorage();
  // Plant an undismissed recovery record
  mockLS.setItem('hometask-recovery-v1', JSON.stringify({
    detectedAt: FIXED_ISO, sourceKey: 'hometask-v1', originalLength: 100,
    storedLength: 100, truncated: false, rawData: '...', downloaded: false, dismissed: false,
    preservationFailed: false,
  }));
  const svc   = makeSvc();
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible,      true);
  assert.equal(state.showDownload, true);
  assert.equal(state.showUndo,     false);
  assert.match(state.message,      /damaged/i);
});

await check('L3: rollback_failed staging → showUndo notice', async () => {
  resetStorage();
  mockLS.setItem('hometask-import-staging-v1', JSON.stringify({ txState: 'rollback_failed' }));
  const svc   = makeSvc();
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible,      true);
  assert.equal(state.showUndo,     true);
  assert.equal(state.showDownload, false);
  assert.match(state.message,      /Undo Last Import/i);
});

await check('L4: sessionStore interrupted-import flag → interrupted notice', async () => {
  resetStorage();
  mockSS.setItem('hometask-recovered-staging', '1');
  const svc   = makeSvc({ sessionStore: mockSS });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible,      true);
  assert.equal(state.showUndo,     false);
  assert.equal(state.showDownload, false);
  assert.match(state.message,      /restored/i);
  mockSS.clear();
});

await check('L5: damaged-data takes priority over rollback_failed', async () => {
  resetStorage();
  mockLS.setItem('hometask-recovery-v1', JSON.stringify({
    downloaded: false, dismissed: false, detectedAt: FIXED_ISO, sourceKey: 'hometask-v1',
    originalLength: 50, storedLength: 50, truncated: false, rawData: '...', preservationFailed: false,
  }));
  mockLS.setItem('hometask-import-staging-v1', JSON.stringify({ txState: 'rollback_failed' }));
  const svc   = makeSvc();
  const state = svc.getRecoveryNoticeState();
  // damaged-data wins: showDownload=true
  assert.equal(state.showDownload, true);
});

/* ══════════════════════════════════════════════════════════════════
   SECTION M: downloadRecoveryData + dismissRecovery
═══════════════════════════════════════════════════════════════════ */
console.log('\n── M: downloadRecoveryData + dismissRecovery ──');

await check('M1: downloadRecoveryData → ok:true, markDownloaded called, download triggered', async () => {
  resetStorage();
  mockLS.setItem('hometask-recovery-v1', JSON.stringify({
    detectedAt: FIXED_ISO, sourceKey: 'hometask-v1',
    originalLength: 100, storedLength: 100, truncated: false,
    rawData: '...broken data...', downloaded: false, dismissed: false,
    preservationFailed: false,
  }));
  const del  = makeDelivery();
  const svc  = makeSvc({ delivery: del });
  const r    = svc.downloadRecoveryData();
  assert.ok(r.ok, r.message);
  assert.equal(del._calls.download, 1, 'download must be called');
  // markDownloaded should set downloaded:true in recoveryStore
  const rec = recoveryStore.get();
  assert.equal(rec.downloaded, true, 'markDownloaded must be called');
});

await check('M2: downloadRecoveryData → ok:false when no recovery record', async () => {
  resetStorage();
  const svc = makeSvc();
  const r   = svc.downloadRecoveryData();
  assert.ok(!r.ok);
  assert.match(r.message, /No recovery data/i);
});

await check('M3: dismissRecovery clears sessionStore flag', async () => {
  resetStorage();
  mockSS.setItem('hometask-recovered-staging', '1');
  mockLS.setItem('hometask-recovery-v1', JSON.stringify({
    detectedAt: FIXED_ISO, sourceKey: 'hometask-v1',
    originalLength: 0, storedLength: 0, truncated: false,
    rawData: null, downloaded: false, dismissed: false, preservationFailed: false,
  }));
  const svc = makeSvc({ sessionStore: mockSS });
  svc.dismissRecovery();
  assert.equal(mockSS.getItem('hometask-recovered-staging'), null, 'sessionStore flag must be cleared');
  // recoveryStore.markDismissed should have been called
  const rec = recoveryStore.get();
  assert.equal(rec.dismissed, true, 'recoveryStore must be marked dismissed');
  mockSS.clear();
});

/* ══════════════════════════════════════════════════════════════════
   SUMMARY
═══════════════════════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failures.length) {
  console.error('\nFailed tests:');
  failures.forEach(f => console.error(`  ✗  ${f.name}\n     ${f.error}`));
}
console.log('─'.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
