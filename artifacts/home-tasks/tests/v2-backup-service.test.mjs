/**
 * v2-backup-service.test.mjs — Suite 20: V2BackupService comprehensive tests.
 *
 * B2 Batch B gate coverage:
 *   Gate 1 — Export from v2 repository produces canonical backup semantics:
 *             9-field data envelope, no catalog-authoritative field leakage,
 *             schemaVersion:2 wrapper, lastExport persisted after delivery.
 *   Gate 2 — Import validates and stages entirely before authority-specific
 *             writes; unknown/retired IDs and user-defined records follow
 *             approved v2 Policy A.
 *   Gate 3 — Undo restores every affected key byte-for-exact via
 *             writeLockedMutation; snapshot cleared after success.
 *   Gate 4 — Interrupted import, quota/noop/lost-write/readback-mismatch/
 *             timeout, rollback failure, malformed storage, recovery evidence
 *             — all explicitly injected and named.
 *   Gate 5 — Data-loss tripwire covers the v2 service path.
 *   Gate 6 — No src module in the v2 backup service path bypasses the
 *             repository boundary with direct localStorage access (static check).
 *   Gate 7 — Lock-timeout: all new lock acquisitions (export-read, backup-write,
 *             has-snapshot, get-last-export) are covered with pending-lock +
 *             MockScheduler flush proving fail-closed behaviour.
 *   Gate 8 — Interleaving + parity: lastExport survives import merge-write;
 *             generation advances monotonically; export captures point-in-time DATA.
 *
 * Standalone Node.js ESM.  Run with:
 *   node artifacts/home-tasks/tests/v2-backup-service.test.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must mock Blob before importing the service (it uses Blob at call time, not import time,
// but node doesn't have it — use a minimal compatible mock).
globalThis.Blob = class MockBlob {
  constructor(parts = [], opts = {}) {
    const content = parts.map(p => (typeof p === 'string' ? p : String(p))).join('');
    this._content = content;
    this.size = content.length;
    this.type = opts.type ?? '';
  }
};

import { CATALOG } from '../src/v2/catalog.data.js';
import { migrate }   from '../src/v2/migrate.js';
import { buildBackup, parseAndValidateBackup } from '../src/v2/backup.js';
import { V2_KEYS, recoverStartup, IMPORT_KEYS } from '../src/v2/import-tx.js';
import { ACTIVATION_KEYS } from '../src/v2/activation-tx.js';
import { assertEquivalent } from '../src/v2/equivalence.js';
import { compose }  from '../src/v2/compose.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';
import { V2BackupService, SESSION_RECOVERED_KEY } from '../src/data/backup/v2-backup-service.js';
import { V1BackupService } from '../src/data/backup/v1-backup-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX  = { today: FIXED_TODAY, catalog: CATALOG, appBuild: 'v-test' };
const EXPORT_CTX = { exportedAt: '2026-07-31T10:00:00.000Z', catalogVersion: CATALOG.catalogVersion, appBuild: 'v-test' };
const NOW  = '2026-07-31T10:00:00.000Z';

/* ── Test harness ─────────────────────────────────────────────── */
let group = '', pass = 0, fail = 0;
const pending = [];
function check(name, fn) {
  const g = group;
  pending.push((async () => {
    try { await fn(); pass++; console.log(`  ✓ [${g}] ${name}`); }
    catch (e) { fail++; console.error(`  ✗ [${g}] ${name}\n    ${e.message}`); }
  })());
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/* ── Lock helpers ─────────────────────────────────────────────── */

/**
 * Serialising test lock: callbacks run one at a time in FIFO order.
 * runExclusive resolves { ok:true, result } | { ok:false, code:'callback-threw', message }.
 */
class TestLock {
  constructor() { this._queue = Promise.resolve(); }
  runExclusive(_txId, callback) {
    const next = this._queue.then(async () => {
      try {
        const result = await callback();
        return { ok: true, result };
      } catch (e) {
        return { ok: false, code: 'callback-threw', message: e?.message ?? String(e) };
      }
    });
    this._queue = next.catch(() => {});
    return next;
  }
}

/**
 * Deterministic fake scheduler: stores pending timers, never fires automatically.
 * Call flush() to fire all registered timers synchronously.
 */
class MockScheduler {
  constructor() { this._p = new Map(); this._n = 0; }
  setTimeout(fn, _ms) { const id = ++this._n; this._p.set(id, fn); return id; }
  clearTimeout(id)    { this._p.delete(id); }
  flush()             { const fns = [...this._p.values()]; this._p.clear(); for (const fn of fns) fn(); }
  get pendingCount()  { return this._p.size; }
}

/** Lock that never settles — forces withLockTimeout to wait for the scheduler. */
function makePendingLock() {
  return { runExclusive: () => new Promise(() => {}) };
}

/**
 * TracingLock — same serialising FIFO guarantee as TestLock, but records every
 * acquire/release event into a shared `log` array.
 * Entries: `'acquire:<tag>'` / `'release:<tag>'`
 * where tag = the txId string argument to runExclusive (fallback: `'lock-op'`).
 */
class TracingLock {
  constructor() { this._queue = Promise.resolve(); this.log = []; }
  runExclusive(txId, callback) {
    const tag  = typeof txId === 'string' ? txId : 'lock-op';
    const next = this._queue.then(async () => {
      this.log.push(`acquire:${tag}`);
      try {
        const result = await callback();
        this.log.push(`release:${tag}`);
        return { ok: true, result };
      } catch (e) {
        this.log.push(`release:${tag}`);
        return { ok: false, code: 'callback-threw', message: e?.message ?? String(e) };
      }
    });
    this._queue = next.catch(() => {});
    return next;
  }
}

/* ── Digest helpers ───────────────────────────────────────────── */

/** Synchronous SHA-256; wrapped in a Promise for the async digestFn interface. */
function testDigest(bytes) {
  return Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
}

/** Synchronous hex-encoded SHA-256 of a UTF-8 string. */
function hexOf(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/* ── LIVE-STATE seed helpers ──────────────────────────────────── */

/** Build a valid LIVE-STATE JSON string for the given generation + digest. */
function makeLS(generation, digest) {
  return JSON.stringify({ generation, digest, schemaVersion: 2 });
}

/* ── Storage adapters ─────────────────────────────────────────── */

/** Map-backed in-memory adapter. */
function makeAdapter(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => { store.set(k, String(v)); },
    removeItem: k      => { store.delete(k); },
    _store:     store,
    _snapshot:  ()     => new Map(store),
  };
}

/**
 * Wrap an adapter with fine-grained fault injection per key.
 * faults: { [key]: { setItem?: 'throw'|'noop'|'corrupt', getItem?: 'throw'|'null' } }
 *
 * 'throw'   — setItem/getItem throws (simulates quota error or timeout)
 * 'noop'    — setItem does nothing (lost-write / no-op)
 * 'corrupt' — setItem writes wrong bytes (readback-mismatch via bad data)
 * 'null'    — getItem always returns null
 */
function makeFaultyAdapter(base, faults) {
  return {
    getItem(k) {
      const f = faults[k];
      if (f?.getItem === 'throw') throw Object.assign(new Error('inject:getItem-fail:' + k), { name: 'StorageError' });
      if (f?.getItem === 'null') return null;
      return base.getItem(k);
    },
    setItem(k, v) {
      const f = faults[k];
      if (f?.setItem === 'throw') throw Object.assign(new Error('inject:quota-fail:' + k), { name: 'QuotaExceededError' });
      if (f?.setItem === 'noop') return;
      if (f?.setItem === 'corrupt') { base.setItem(k, '{"__corrupted":true}'); return; }
      base.setItem(k, v);
    },
    removeItem(k) { base.removeItem(k); },
    _base: base,
  };
}

/** Make a sessionStore mock backed by a Map. */
function makeSessionStore(init = {}) {
  const store = new Map(Object.entries(init));
  return {
    getItem:    k      => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => { store.set(k, String(v)); },
    removeItem: k      => { store.delete(k); },
    _store:     store,
  };
}

/** Capture delivery calls. */
function makeDelivery({ canShare = false, shareThrows = null, downloadThrows = false } = {}) {
  const calls = [];
  return {
    canShare(blob, filename) { calls.push({ op: 'canShare', filename }); return canShare; },
    async share(blob, filename) {
      calls.push({ op: 'share', filename, content: blob._content });
      if (shareThrows) throw shareThrows;
    },
    download(blob, filename) {
      calls.push({ op: 'download', filename, content: blob._content });
      if (downloadThrows) throw new Error('download-failed');
    },
    _calls: calls,
  };
}

/** Fake fileReader that reads ._content from the file-like object. */
function makeFileReader({ throws = false } = {}) {
  return {
    readAsText(fileLike) {
      if (throws) return Promise.reject(new Error('read-error'));
      const text = (fileLike && '_content' in fileLike)
        ? fileLike._content
        : (typeof fileLike?.text === 'function' ? null : '');
      return Promise.resolve(text ?? '');
    },
  };
}

/* ── Data helpers ─────────────────────────────────────────────── */

/** Build a valid v2 storage envelope from the 'typical' fixture. */
function typicalV2() {
  return migrate(FIXTURES.typical, CTX).v2;
}

/**
 * A minimal empty v2 envelope whose JSON serialisation is guaranteed to differ
 * from the 'typical' fixture import payload.  Used wherever a test needs a
 * distinct currentData so that noop/throw/timeout faults on DATA writes are
 * detectable via readback mismatch rather than coincidental equality.
 */
const PRIOR_EMPTY_STR = JSON.stringify({
  schemaVersion: 2, state: [], prefs: {}, userZones: [],
  userTasks: [], completionEvents: [], overrides: {}, recentSearches: [], meta: {},
});

/**
 * Seed adapter with DATA=v2 envelope and LIVE-STATE pointing to sha256(DATA).
 * Both are required by runV2LockedImport before any import can proceed.
 */
function seedV2(adapter, v2 = null) {
  const env     = v2 ?? typicalV2();
  const dataStr = JSON.stringify(env);
  adapter.setItem(V2_KEYS.DATA, dataStr);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(dataStr)));
  return env;
}

/** Build a minimal service with overrideable deps. */
function makeService(overrides = {}) {
  return V2BackupService({
    adapter:      makeAdapter(),
    catalog:      CATALOG,
    appBuild:     'v-test',
    delivery:     makeDelivery(),
    fileReader:   makeFileReader(),
    clock:        () => NOW,
    todayFn:      () => FIXED_TODAY,
    sessionStore: makeSessionStore(),
    lock:         new TestLock(),    // fresh serialising lock per service
    digestFn:     testDigest,        // synchronous-wrapped sha256 for determinism
    ...overrides,
  });
}

/** Build a v2 backup file-like from a fixture. */
function makeBackupFileLike(fixture = FIXTURES.typical) {
  const v2     = migrate(fixture, CTX).v2;
  const backup = buildBackup(v2, EXPORT_CTX);
  const json   = JSON.stringify(backup);
  return { size: json.length, _content: json };
}

/** Build a v1 backup file-like. */
function makeV1BackupFileLike(fixture = FIXTURES.typical) {
  const tasks = JSON.parse(fixture.v1TasksRaw ?? '[]');
  const meta  = JSON.parse(fixture.v1MetaRaw  ?? '{}');
  const v1 = {
    app: 'HomeTask', schemaVersion: 1, exportedAt: NOW,
    catalogTaskCount: CATALOG.tasks.length, catalogRoomCount: CATALOG.zones.length,
    taskState: tasks.map(t => ({ id: t.id, lastDone: t.lastDone ?? null,
      doneToday: Boolean(t.doneToday), skipUntil: t.skipUntil ?? null, tags: t.tags ?? [] })),
    preferences: {
      viewMode: meta.viewMode ?? 'today', roomFilter: meta.roomFilter ?? '',
      onboarded: Boolean(meta.onboarded), choice: meta.choice ?? null,
      completedAt: meta.completedAt ?? null,
    },
  };
  const json = JSON.stringify(v1);
  return { size: json.length, _content: json };
}

/**
 * Create a self-contained V1BackupService environment with pure in-memory mocks
 * — no globalThis.localStorage required.
 *
 * Returns { svc, backing, backupStore, repo, exportCalled }
 * where exportCalled() is true iff delivery.download was invoked (export delivered).
 *
 * Default: backing seeded with empty tasks array and default prefs.
 * Pass { tasks, prefs } to override the initial backing state.
 */
function makeV1ServiceEnv({ tasks = [], prefs = {} } = {}) {
  const backing = makeAdapter();
  const DEFAULT_PREFS = {
    viewMode: 'today', roomFilter: '', onboarded: false, choice: null, completedAt: null,
  };
  backing.setItem('hometask-v1',      JSON.stringify(tasks));
  backing.setItem('hometask-meta-v1', JSON.stringify({ ...DEFAULT_PREFS, ...prefs }));

  let _lastExport = null;
  const repo = {
    loadTasks:     () => JSON.parse(backing.getItem('hometask-v1')      ?? '[]'),
    loadPrefs:     () => JSON.parse(backing.getItem('hometask-meta-v1') ?? '{}'),
    getLastExport: () => _lastExport,
    setLastExport: d  => { _lastExport = d; },
  };

  let _snapshot = null;
  const IMPORT_KEYS_V1 = ['hometask-v1', 'hometask-meta-v1'];
  const backupStore = {
    IMPORT_KEYS: IMPORT_KEYS_V1,
    saveSnapshot() {
      try {
        const snap = {};
        for (const k of IMPORT_KEYS_V1) snap[k] = backing.getItem(k);
        _snapshot = snap;
        return { ok: true };
      } catch (e) { return { ok: false, error: e?.message }; }
    },
    getSnapshot()      { return _snapshot; },
    applySnapshot(snap) {
      try {
        for (const [k, v] of Object.entries(snap)) {
          if (v === null) backing.removeItem(k);
          else backing.setItem(k, v);
        }
        return { ok: true, restored: Object.keys(snap) };
      } catch (e) { return { ok: false, error: e?.message }; }
    },
    clearSnapshot()    { _snapshot = null; },
  };

  let _stagingData = null;
  const stagingStore = {
    get()    { return _stagingData; },
    save(d)  { _stagingData = d; return true; },
    patch(d) { _stagingData = _stagingData ? { ..._stagingData, ...d } : d; },
    clear()  { _stagingData = null; },
  };

  const recoveryStore = {
    hasUndismissed() { return false; },
    get()            { return null; },
    markDownloaded() {},
    markDismissed()  {},
  };

  let _exportCalled = false;
  const delivery = {
    canShare:  ()  => false,
    share:     async () => {},
    download:  ()  => { _exportCalled = true; },
  };

  const svc = V1BackupService({
    catalogTasks:  CATALOG.tasks,
    catalogRooms:  CATALOG.zones.map(z => z.id),
    repo,
    backing,
    backupStore,
    stagingStore,
    recoveryStore,
    fileReader:   makeFileReader(),
    delivery,
    clock:        () => NOW,
    sessionStore: makeSessionStore(),
  });

  return { svc, backing, backupStore, repo, exportCalled: () => _exportCalled };
}

/* ═══════════════════════════════════════════════════════════════════
   A · Constructor validation
═══════════════════════════════════════════════════════════════════ */
section('A-constructor');

check('A1: throws when adapter is missing', () => {
  assert.throws(() => makeService({ adapter: null }),
    /adapter required/);
});
check('A2: throws when adapter lacks getItem', () => {
  assert.throws(() => makeService({ adapter: { setItem() {}, removeItem() {} } }),
    /adapter required/);
});
check('A3: throws when catalog tasks is not an array', () => {
  assert.throws(() => makeService({ catalog: { tasks: null, zones: [], catalogVersion: 1 } }),
    /catalog must have tasks/);
});
check('A4: throws when catalog.catalogVersion is missing', () => {
  assert.throws(() => makeService({ catalog: { tasks: [], zones: [], catalogVersion: 'x' } }),
    /catalogVersion/);
});
check('A5: throws when appBuild is empty', () => {
  assert.throws(() => makeService({ appBuild: '' }),
    /appBuild/);
});
check('A6: throws when clock is not a function', () => {
  assert.throws(() => makeService({ clock: 'not-a-function' }),
    /clock must be a function/);
});
check('A7: constructs successfully with valid deps', () => {
  const svc = makeService();
  assert.equal(typeof svc.exportBackup,          'function');
  assert.equal(typeof svc.readAndValidate,        'function');
  assert.equal(typeof svc.applyImport,            'function');
  assert.equal(typeof svc.applyUndo,              'function');
  assert.equal(typeof svc.hasSnapshot,            'function');
  assert.equal(typeof svc.getLastExport,          'function');
  assert.equal(typeof svc.getRecoveryNoticeState, 'function');
  assert.equal(typeof svc.downloadRecoveryData,   'function');
  assert.equal(typeof svc.dismissRecovery,        'function');
});
check('A8: throws when lock is missing or lacks runExclusive', () => {
  assert.throws(() => makeService({ lock: null }),
    /lock.*runExclusive/);
  assert.throws(() => makeService({ lock: {} }),
    /lock.*runExclusive/);
  assert.throws(() => makeService({ lock: { runExclusive: 'not-a-function' } }),
    /lock.*runExclusive/);
});

/* ═══════════════════════════════════════════════════════════════════
   B · Export semantics (Gate 1)
═══════════════════════════════════════════════════════════════════ */
section('B-export');

check('B1: export produces schemaVersion:2 wrapper with exactly the right top-level keys', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery });
  const result   = await svc.exportBackup();
  assert.equal(result.ok, true, result.message);
  const envelope = JSON.parse(delivery._calls.find(c => c.op === 'download').content);
  assert.equal(envelope.app, 'HomeTask');
  assert.equal(envelope.schemaVersion, 2);
  assert.deepEqual(Object.keys(envelope), ['app', 'schemaVersion', 'exportedAt', 'catalogVersion', 'appBuild', 'data']);
});

check('B2: data block has exactly the canonical 9 fields and no catalog leakage', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery });
  await svc.exportBackup();
  const envelope = JSON.parse(delivery._calls.find(c => c.op === 'download').content);
  const dataKeys = Object.keys(envelope.data);
  assert.deepEqual(dataKeys,
    ['schemaVersion', 'state', 'prefs', 'userZones', 'userTasks',
     'completionEvents', 'overrides', 'recentSearches', 'meta']);
  // No catalog-authoritative fields
  const json = JSON.stringify(envelope.data);
  for (const prohibited of ['"title"', '"room"', '"intervalDays"', '"safety"', '"zones"', '"tasks"', '"catalog"']) {
    if (prohibited === '"title"') {
      const stateRecs = envelope.data.state ?? [];
      for (const rec of stateRecs) {
        assert.ok(!('title' in rec), `state record must not carry title; found: ${JSON.stringify(rec)}`);
      }
    } else {
      assert.ok(!json.includes(prohibited) || prohibited === '"safety"',
        `data must not contain ${prohibited}`);
    }
  }
});

check('B3: state records contain only taskId/lastDone/doneToday/skipUntil/tags', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery });
  await svc.exportBackup();
  const envelope = JSON.parse(delivery._calls.find(c => c.op === 'download').content);
  const ALLOWED = new Set(['taskId', 'lastDone', 'doneToday', 'skipUntil', 'tags']);
  for (const rec of envelope.data.state) {
    for (const k of Object.keys(rec)) {
      assert.ok(ALLOWED.has(k), `state record has non-user-state key: ${k}`);
    }
  }
});

check('B4: export sets lastExport in BACKUP key after download delivery', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery, todayFn: () => '2026-07-31' });
  await svc.exportBackup();
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backup.lastExport, '2026-07-31');
});

check('B5: getLastExport returns null when no export yet', async () => {
  const svc = makeService({ adapter: makeAdapter() });
  assert.equal(await svc.getLastExport(), null);
});

check('B6: getLastExport returns stored date after successful export', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);
  const svc      = makeService({ adapter, delivery: makeDelivery({ canShare: false }), todayFn: () => '2026-07-31' });
  await svc.exportBackup();
  assert.equal(await svc.getLastExport(), '2026-07-31');
});

check('B7: export falls through to download when share fails with non-AbortError', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: true, shareThrows: new Error('network-error') });
  const svc      = makeService({ adapter, delivery });
  const result   = await svc.exportBackup();
  assert.equal(result.ok, true);
  const ops = delivery._calls.map(c => c.op);
  assert.ok(ops.includes('share'), 'share was attempted');
  assert.ok(ops.includes('download'), 'download fallback happened');
});

check('B8: export returns ok:false when share is aborted (no download attempted)', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: true, shareThrows: Object.assign(new Error('cancelled'), { name: 'AbortError' }) });
  const svc      = makeService({ adapter, delivery });
  const result   = await svc.exportBackup();
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('cancelled'), result.message);
  assert.equal(delivery._calls.filter(c => c.op === 'download').length, 0);
});

check('B9: export returns ok:false with helpful message when no v2 data in adapter', async () => {
  const svc    = makeService({ adapter: makeAdapter() });
  const result = await svc.exportBackup();
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('No v2 data'), result.message);
});

/* ═══════════════════════════════════════════════════════════════════
   C · readAndValidate (Gate 2 — validation before writes)
═══════════════════════════════════════════════════════════════════ */
section('C-readAndValidate');

check('C1: accepts a valid v2 backup and returns sanitized envelope + metadata', async () => {
  const svc    = makeService();
  const file   = makeBackupFileLike();
  const result = await svc.readAndValidate(file);
  assert.equal(result.source, 'v2');
  assert.equal(result.sanitized.schemaVersion, 2);
  assert.ok(typeof result.taskCount === 'number' && result.taskCount >= 0);
  assert.ok(Array.isArray(result.repairs));
  assert.ok(Array.isArray(result.warnings));
});

check('C2: accepts a v1 backup and returns sanitized v2 envelope (cross-version import)', async () => {
  const svc    = makeService();
  const file   = makeV1BackupFileLike();
  const result = await svc.readAndValidate(file);
  assert.equal(result.source, 'v1');
  assert.equal(result.sanitized.schemaVersion, 2);
  assert.ok(Array.isArray(result.sanitized.state));
});

check('C3: rejects oversized file before reading content', async () => {
  const svc    = makeService();
  const huge   = { size: 2 * 1024 * 1024 + 1, _content: '{}' };
  await assert.rejects(() => svc.readAndValidate(huge), /too large/);
});

check('C4: rejects malformed JSON with user-facing message', async () => {
  const svc  = makeService();
  const file = { size: 10, _content: 'NOT-JSON{{' };
  await assert.rejects(() => svc.readAndValidate(file), /could not be read|not valid/i);
});

check('C5: rejects a non-HomeTask JSON file', async () => {
  const svc  = makeService();
  const json = JSON.stringify({ app: 'OtherApp', schemaVersion: 2 });
  const file = { size: json.length, _content: json };
  await assert.rejects(() => svc.readAndValidate(file));
});

check('C6: rejects when fileReader itself throws', async () => {
  const svc  = makeService({ fileReader: makeFileReader({ throws: true }) });
  const file = { size: 10, _content: '{}' };
  await assert.rejects(() => svc.readAndValidate(file), /Could not read this file/);
});

check('C7: sanitized result from v2 backup is accepted by applyImport without error', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);  // DATA + LIVE-STATE required by runV2LockedImport
  const svc     = makeService({ adapter });
  const file    = makeBackupFileLike();
  const { sanitized } = await svc.readAndValidate(file);
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, true, result.message);
});

check('C8: sanitized result from v1 backup is accepted by applyImport (cross-version gate)', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);  // DATA + LIVE-STATE required by runV2LockedImport
  const svc     = makeService({ adapter });
  const file    = makeV1BackupFileLike();
  const { sanitized } = await svc.readAndValidate(file);
  assert.equal(sanitized.schemaVersion, 2, 'v1 import must produce v2 envelope');
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, true, result.message);
});

check('C9: taskCount equals length of sanitized.state', async () => {
  const svc    = makeService();
  const file   = makeBackupFileLike();
  const result = await svc.readAndValidate(file);
  assert.equal(result.taskCount, result.sanitized.state.length);
});

check('C10: applyImport rejects non-object sanitized input (early-return; no lock acquired)', async () => {
  const svc    = makeService();
  assert.equal((await svc.applyImport(null)).ok,                false);
  assert.equal((await svc.applyImport([])).ok,                  false);
  assert.equal((await svc.applyImport('string')).ok,            false);
  assert.equal((await svc.applyImport({ schemaVersion: 1 })).ok, false, 'must require schemaVersion:2');
});

/* ═══════════════════════════════════════════════════════════════════
   D · applyImport — happy path (Gate 2)
═══════════════════════════════════════════════════════════════════ */
section('D-applyImport-happy');

check('D1: writes exactly the serialized envelope to DATA key', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, true);
  const stored  = adapter.getItem(V2_KEYS.DATA);
  assert.ok(stored !== null, 'DATA key must be written');
  const parsed  = JSON.parse(stored);
  assert.equal(parsed.schemaVersion, 2);
});

check('D2: staging record is absent (cleaned up) after successful import', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null, 'staging must be cleaned up');
});

check('D3: snapshot is preserved in BACKUP key after successful import (for undo)', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.ok(backup.snapshot, 'snapshot must be retained for undo');
});

check('D4: unrelated adapter keys are not touched during import', async () => {
  const UNRELATED = Object.freeze({ 'unrelated-app': 'do-not-touch', 'other': '42' });
  const adapter = makeAdapter(UNRELATED);
  seedV2(adapter);
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  for (const [k, v] of Object.entries(UNRELATED)) {
    assert.equal(adapter.getItem(k), v, `unrelated key ${k} must be unchanged`);
  }
});

check('D5: hasSnapshot returns true after import and false before', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter });
  assert.equal(await svc.hasSnapshot(), false, 'no snapshot before import');
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  assert.equal(await svc.hasSnapshot(), true, 'snapshot present after import');
});

check('D6: DATA key is round-trip parseable by parseAndValidateBackup', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  const stored  = adapter.getItem(V2_KEYS.DATA);
  const rebuilt = buildBackup(JSON.parse(stored), EXPORT_CTX);
  const check2  = parseAndValidateBackup(JSON.stringify(rebuilt), CTX);
  assert.equal(check2.ok, true, `reimport failed: ${JSON.stringify(check2.errors)}`);
});

/* ═══════════════════════════════════════════════════════════════════
   E · Import failure injection — explicit names (Gate 4)
═══════════════════════════════════════════════════════════════════ */
section('E-failure-injection');

check('E1 [snapshot-write-quota]: setItem(BACKUP) throws → code:snapshot-failed, DATA unchanged', async () => {
  const base    = makeAdapter();
  seedV2(base);  // DATA + LIVE-STATE so the lock path can proceed to the snapshot step
  const adapter = makeFaultyAdapter(base, { [V2_KEYS.BACKUP]: { setItem: 'throw' } });
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'snapshot-failed', `expected snapshot-failed, got: ${result.code}`);
  // DATA must be unchanged (fault fires before any DATA write)
  assert.equal(base.getItem(V2_KEYS.DATA), JSON.stringify(typicalV2()),
    'DATA must not be written when snapshot fails');
});

check('E2 [snapshot-write-noop]: setItem(BACKUP) noop → snapshot verify fails → code:snapshot-failed', async () => {
  const base    = makeAdapter();
  seedV2(base);
  const adapter = makeFaultyAdapter(base, { [V2_KEYS.BACKUP]: { setItem: 'noop' } });
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'snapshot-failed');
  assert.equal(base.getItem(V2_KEYS.DATA), JSON.stringify(typicalV2()),
    'DATA must not be written after snapshot failure');
});

check('E3 [staging-write-quota]: setItem(STAGING) throws → code:staging-failed, DATA unchanged', async () => {
  const base    = makeAdapter();
  seedV2(base);
  const adapter = makeFaultyAdapter(base, { [V2_KEYS.STAGING]: { setItem: 'throw' } });
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'staging-failed');
  assert.equal(base.getItem(V2_KEYS.DATA), JSON.stringify(typicalV2()), 'DATA must not be written');
});

check('E4 [staging-verify-noop]: setItem(STAGING) noop → verify mismatch → code:staging-failed', async () => {
  // aSetVerify: write noops → readback returns old value → verify-mismatch → stagingWrite returns false
  // runV2LockedImport: stagingWrite false → staging-failed (not staging-verify-failed from old path)
  const base    = makeAdapter();
  seedV2(base);
  const adapter = makeFaultyAdapter(base, { [V2_KEYS.STAGING]: { setItem: 'noop' } });
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'staging-failed',
    `expected staging-failed (locked path consolidates both staging failures), got: ${result.code}`);
  assert.equal(base.getItem(V2_KEYS.DATA), JSON.stringify(typicalV2()), 'DATA must not be written');
});

check('E5 [data-write-quota, rollback-succeeds]: setItem(DATA) throws once → rollback succeeds → code:rolled-back, DATA restored', async () => {
  const base = makeAdapter();
  const PRIOR_DATA = JSON.stringify({ schemaVersion: 2, state: [], prefs: {}, userZones: [],
    userTasks: [], completionEvents: [], overrides: {}, recentSearches: [], meta: {} });
  base.setItem(V2_KEYS.DATA, PRIOR_DATA);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRIOR_DATA)));  // required by locked path
  // Fault: only the first setItem(DATA) throws (commit); rollback write succeeds.
  let dataWriteCount = 0;
  const adapter = {
    getItem:    k => base.getItem(k),
    setItem(k, v) {
      if (k === V2_KEYS.DATA) {
        dataWriteCount++;
        if (dataWriteCount === 1) throw Object.assign(new Error('inject:quota:commit'), { name: 'QuotaExceededError' });
        base.setItem(k, v);  // rollback write succeeds
        return;
      }
      base.setItem(k, v);
    },
    removeItem: k => base.removeItem(k),
  };
  const svc = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rolled-back', `expected rolled-back, got: ${result.code}`);
  // DATA must be restored to the prior value by the rollback
  assert.equal(base.getItem(V2_KEYS.DATA), PRIOR_DATA, 'DATA must be rolled back to prior value');
});

check('E6 [data-write-noop/readback-mismatch]: setItem(DATA) noop → verify mismatch → rolled back', async () => {
  // PRIOR_EMPTY_STR differs from the import payload (TYPICAL) so the noop
  // is detectable via readback mismatch (PRIOR_EMPTY ≠ IMPORT_DATA).
  // Restore noop also: readback returns PRIOR_EMPTY = prevRaw → restoreWr.ok=true.
  // Journal removal is unimpeded → journalCleanupOk=true → surface code 'rolled-back'.
  const base    = makeAdapter();
  base.setItem(V2_KEYS.DATA, PRIOR_EMPTY_STR);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRIOR_EMPTY_STR)));
  const adapter = makeFaultyAdapter(base, { [V2_KEYS.DATA]: { setItem: 'noop' } });
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.ok(result.code === 'rolled-back' || result.code === 'rollback-failed',
    `expected rolled-back or rollback-failed, got: ${result.code}`);
});

check('E7 [timeout-simulated-quota]: setItem(DATA) throws TimeoutError → same rollback path as quota', async () => {
  const base    = makeAdapter();
  seedV2(base);
  const adapter = {
    ...makeFaultyAdapter(base, {}),
    getItem: k => base.getItem(k),
    setItem(k, v) {
      if (k === V2_KEYS.DATA) throw Object.assign(new Error('inject:timeout:' + k), { name: 'TimeoutError' });
      base.setItem(k, v);
    },
    removeItem: k => base.removeItem(k),
  };
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.ok(result.code === 'rolled-back' || result.code === 'rollback-failed',
    `expected rolled-back or rollback-failed, got: ${result.code}`);
});

check('E8 [rollback-failure]: DATA write throws (commit AND rollback) → code:rollback-failed, evidence retained', async () => {
  // For rollback-failed: snapshot must succeed, DATA commit write must fail,
  // AND the rollback write must also fail.
  const base2  = makeAdapter();
  const PRIOR  = JSON.stringify(typicalV2());
  base2.setItem(V2_KEYS.DATA, PRIOR);
  base2.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRIOR)));  // required by locked path
  const adapter = {
    getItem: k => base2.getItem(k),
    setItem(k, v) {
      if (k === V2_KEYS.DATA) {
        // ALL DATA writes fail — both commit attempt and rollback restoration
        throw Object.assign(new Error('inject:data-fail'), { name: 'QuotaExceededError' });
      }
      base2.setItem(k, v);
    },
    removeItem: k => base2.removeItem(k),
  };
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rollback-failed', `expected rollback-failed, got: ${result.code}`);
  // Staging must retain failure evidence (locked path sets txState:'failed', failCode:'rollback-failed')
  const staging = JSON.parse(base2.getItem(V2_KEYS.STAGING));
  assert.equal(staging?.txState, 'failed', 'staging must carry failure txState');
  assert.equal(staging?.failCode, 'rollback-failed', 'staging failCode must be rollback-failed');
});

check('E9 [blocked-rollback-failed-guard]: applyImport refused when prior rollback_failed staging exists', async () => {
  const adapter = makeAdapter();
  // Manually put rollback_failed staging record (checked at step 0a, before LIVE-STATE read)
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({ txVersion: 2, txState: 'rollback_failed',
    keysWritten: [], keysRestored: [], rollbackError: 'inject', failedAt: NOW }));
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result  = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'blocked-rollback-failed');
});

check('E10 [startup-recovery-committing]: recoverStartup rolls back a committing record', async () => {
  const base    = makeAdapter();
  // Snapshot: DATA was null (absent) before import
  const snapKeys = { [V2_KEYS.DATA]: null };
  base.setItem(V2_KEYS.BACKUP, JSON.stringify({ snapshot: { savedAt: NOW, keys: snapKeys } }));
  // Staging is in 'committing' state (mid-commit interrupted)
  const dataStr = JSON.stringify({ schemaVersion: 2, state: [], prefs: {}, userZones: [],
    userTasks: [], completionEvents: [], overrides: {}, recentSearches: [], meta: {} });
  base.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 2, txState: 'committing', startedAt: NOW, committedAt: null,
    keysToWrite: [V2_KEYS.DATA], keysWritten: [],
    data: { [V2_KEYS.DATA]: dataStr },
  }));
  base.setItem(V2_KEYS.DATA, dataStr);  // partial-commit: DATA was written before crash
  const recovery = recoverStartup(base, NOW);
  assert.equal(recovery.action, 'rolled-back', `expected rolled-back, got: ${recovery.action}`);
  assert.equal(base.getItem(V2_KEYS.DATA), null,    'DATA must be removed (snapshot had null)');
  assert.equal(base.getItem(V2_KEYS.STAGING), null, 'staging must be cleared');
});

check('E11 [startup-recovery-staged-no-snapshot]: staged-only record cleared safely', async () => {
  const base = makeAdapter();
  // Staging is 'staged' — no live key was written, no snapshot needed
  base.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 2, txState: 'staged', startedAt: NOW, keysToWrite: [V2_KEYS.DATA], keysWritten: [],
    data: { [V2_KEYS.DATA]: '{}' },
  }));
  const recovery = recoverStartup(base, NOW);
  assert.ok(recovery.action === 'rolled-back', `expected rolled-back, got ${recovery.action}`);
  assert.equal(base.getItem(V2_KEYS.STAGING), null, 'staging cleared for staged-only record');
  assert.equal(base.getItem(V2_KEYS.DATA), null, 'DATA not touched');
});

check('E12 [malformed-storage-staging]: malformed staging record is removed at startup', async () => {
  const base = makeAdapter();
  base.setItem(V2_KEYS.STAGING, 'NOT-VALID-JSON{{{');
  const recovery = recoverStartup(base, NOW);
  assert.equal(recovery.action, 'removed-malformed');
  assert.equal(base.getItem(V2_KEYS.STAGING), null);
});

// ── Gate 4 addendum: MUT_JOURNAL cleanup verification ────────────────────────
// These three tests prove that 'rolled-back' is NOT returned when journal
// cleanup fails (throw / no-op / readback-throws), even when DATA was restored.
// In all three: DATA commit fails, DATA restore succeeds (dataRestoreOk=true),
// but journalCleanupOk=false → surface code must be 'rollback-failed'.

check('E13 [journal-cleanup-throws]: DATA restore ok, MUT_JOURNAL removeItem throws → rollback-failed', async () => {
  // Arrange: PRIOR_EMPTY as current DATA (differs from import payload = TYPICAL).
  // First DATA write (commit) throws; second write (restore) succeeds.
  // MUT_JOURNAL removeItem throws → journalCleanupOk=false.
  const base = makeAdapter();
  base.setItem(V2_KEYS.DATA, PRIOR_EMPTY_STR);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRIOR_EMPTY_STR)));
  let dataWriteCount = 0;
  const adapter = {
    getItem:    k => base.getItem(k),
    setItem(k, v) {
      if (k === ACTIVATION_KEYS.DATA) {
        dataWriteCount++;
        if (dataWriteCount === 1)
          throw Object.assign(new Error('inject:quota:commit'), { name: 'QuotaExceededError' });
        base.setItem(k, v); // restore write succeeds
        return;
      }
      base.setItem(k, v);
    },
    removeItem(k) {
      if (k === ACTIVATION_KEYS.MUT_JOURNAL)
        throw Object.assign(new Error('inject:quota:journal-remove'), { name: 'QuotaExceededError' });
      base.removeItem(k);
    },
  };
  const svc = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rollback-failed',
    `expected rollback-failed (journal removal threw), got: ${result.code}`);
  // DATA must be at its prior value — DATA restore succeeded even though journal cleanup failed.
  assert.equal(base.getItem(V2_KEYS.DATA), PRIOR_EMPTY_STR,
    'DATA must equal prior value: restore succeeded before journal cleanup attempt');
  // Journal is retained (removeItem threw, so base still has it from wLM step 1).
  assert.ok(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL) !== null,
    'MUT_JOURNAL must be retained when removeItem threw');
  // Staging must record failure evidence.
  const staging = JSON.parse(base.getItem(V2_KEYS.STAGING));
  assert.equal(staging?.txState, 'failed');
  assert.equal(staging?.failCode, 'rollback-failed');
});

check('E14 [journal-cleanup-noop]: DATA restore ok, MUT_JOURNAL removeItem is silent no-op → rollback-failed', async () => {
  // removeItem for MUT_JOURNAL does nothing (silent lost-remove).
  // Readback after removal returns the journal string (not null) → journalCleanupOk=false.
  const base = makeAdapter();
  base.setItem(V2_KEYS.DATA, PRIOR_EMPTY_STR);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRIOR_EMPTY_STR)));
  let dataWriteCount = 0;
  const adapter = {
    getItem:    k => base.getItem(k),
    setItem(k, v) {
      if (k === ACTIVATION_KEYS.DATA) {
        dataWriteCount++;
        if (dataWriteCount === 1)
          throw Object.assign(new Error('inject:quota:commit'), { name: 'QuotaExceededError' });
        base.setItem(k, v);
        return;
      }
      base.setItem(k, v);
    },
    removeItem(k) {
      if (k === ACTIVATION_KEYS.MUT_JOURNAL) return; // noop — journal stays in store
      base.removeItem(k);
    },
  };
  const svc = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rollback-failed',
    `expected rollback-failed (journal noop), got: ${result.code}`);
  // Journal must still be present — removeItem was a noop.
  assert.ok(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL) !== null,
    'MUT_JOURNAL must be retained when removeItem was a silent no-op');
  // DATA still at prior value.
  assert.equal(base.getItem(V2_KEYS.DATA), PRIOR_EMPTY_STR);
  const staging = JSON.parse(base.getItem(V2_KEYS.STAGING));
  assert.equal(staging?.txState, 'failed');
  assert.equal(staging?.failCode, 'rollback-failed');
});

check('E15 [journal-verify-throws]: DATA restore ok, MUT_JOURNAL readback verification throws → rollback-failed', async () => {
  // removeItem succeeds (journal is physically gone from base), but the subsequent
  // getItem to verify absence throws — cannot confirm → journalCleanupOk=false.
  const base = makeAdapter();
  base.setItem(V2_KEYS.DATA, PRIOR_EMPTY_STR);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRIOR_EMPTY_STR)));
  let dataWriteCount = 0;
  let journalRemoved = false; // armed after removeItem(MUT_JOURNAL) fires
  const adapter = {
    getItem(k) {
      if (k === ACTIVATION_KEYS.MUT_JOURNAL && journalRemoved)
        throw Object.assign(new Error('inject:storage-error:journal-verify'), { name: 'StorageError' });
      return base.getItem(k);
    },
    setItem(k, v) {
      if (k === ACTIVATION_KEYS.DATA) {
        dataWriteCount++;
        if (dataWriteCount === 1)
          throw Object.assign(new Error('inject:quota:commit'), { name: 'QuotaExceededError' });
        base.setItem(k, v);
        return;
      }
      base.setItem(k, v);
    },
    removeItem(k) {
      if (k === ACTIVATION_KEYS.MUT_JOURNAL) journalRemoved = true;
      base.removeItem(k);
    },
  };
  const svc = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const result = await svc.applyImport(sanitized);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rollback-failed',
    `expected rollback-failed (journal readback threw), got: ${result.code}`);
  // Journal is physically gone from base (removeItem ran) — but wLM cannot confirm it.
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null,
    'MUT_JOURNAL physically removed — but wLM could not verify');
  // DATA at prior value.
  assert.equal(base.getItem(V2_KEYS.DATA), PRIOR_EMPTY_STR);
  const staging = JSON.parse(base.getItem(V2_KEYS.STAGING));
  assert.equal(staging?.txState, 'failed');
  assert.equal(staging?.failCode, 'rollback-failed');
});

/* ═══════════════════════════════════════════════════════════════════
   F · applyUndo — byte-exact restore (Gate 3)
═══════════════════════════════════════════════════════════════════ */
section('F-applyUndo');

check('F1: undo restores DATA key to its exact prior bytes', async () => {
  // ORIGINAL: a minimal hand-crafted v2 envelope; differs from the backup fixture.
  const adapter  = makeAdapter();
  const ORIGINAL = JSON.stringify({ schemaVersion: 2,
    state: [{ taskId: 'mb-floor', lastDone: '2026-01-01', doneToday: false, skipUntil: null, tags: [] }],
    prefs: { viewMode: 'today', choice: null, onboarded: false, completedAt: null, roomFilterZoneId: '' },
    userZones: [], userTasks: [], completionEvents: {}, overrides: {}, recentSearches: [], meta: null });
  adapter.setItem(V2_KEYS.DATA, ORIGINAL);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(ORIGINAL)));
  const svc = makeService({ adapter });
  // Import from typical fixture — state differs, so DATA bytes change
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  assert.notEqual(adapter.getItem(V2_KEYS.DATA), ORIGINAL, 'DATA must change after import');
  // Undo must restore ORIGINAL byte-exactly (via writeLockedMutation)
  const result = await svc.applyUndo();
  assert.equal(result.ok, true, result.message ?? '');
  assert.equal(adapter.getItem(V2_KEYS.DATA), ORIGINAL, 'DATA must be byte-identical to original');
});

check('F2: undo returns snapshot-stale when DATA has been mutated since import', async () => {
  // runV2LockedUndo checks sha256(currentDATA) === snapshot.targetDigest before restoring.
  // If DATA was mutated after import (e.g. concurrent write), undo returns snapshot-stale.
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  // Mutate DATA directly, bypassing the lock (simulates an out-of-band write after import)
  const mutated = JSON.stringify({
    ...sanitized,
    state: [{ taskId: 'injected-mutation', lastDone: null, doneToday: false, skipUntil: null, tags: [] }],
  });
  adapter.setItem(V2_KEYS.DATA, mutated);
  const result = await svc.applyUndo();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'snapshot-stale',
    `expected snapshot-stale (ownership check), got: ${result.code}`);
});

check('F3: undo clears the snapshot after success', async () => {
  const adapter   = makeAdapter();
  seedV2(adapter);
  const svc       = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  assert.equal(await svc.hasSnapshot(), true);
  await svc.applyUndo();
  assert.equal(await svc.hasSnapshot(), false, 'snapshot must be cleared after successful undo');
});

check('F4: undo leaves unrelated keys byte-identical', async () => {
  const UNRELATED = Object.freeze({ 'meta-key': 'do-not-touch', 'other': 'preserve-me' });
  const adapter   = makeAdapter(UNRELATED);
  seedV2(adapter);
  const svc       = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  await svc.applyUndo();
  for (const [k, v] of Object.entries(UNRELATED)) {
    assert.equal(adapter.getItem(k), v, `unrelated key "${k}" was touched by undo`);
  }
});

check('F5: applyUndo returns ok:false with code:no-snapshot when no snapshot exists', async () => {
  const svc    = makeService({ adapter: makeAdapter() });
  const result = await svc.applyUndo();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-snapshot');
});

check('F6: undo does not clear snapshot when rollback write fails', async () => {
  // Need prior DATA so the undo path calls setItem(DATA,...) not removeItem.
  // setItem(DATA) throws → writeLockedMutation fails → ok:false → snapshot retained.
  const base  = makeAdapter();
  const PRIOR = JSON.stringify(typicalV2());
  base.setItem(V2_KEYS.DATA, PRIOR);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRIOR)));
  const svc   = makeService({ adapter: base });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  assert.equal(await svc.hasSnapshot(), true, 'snapshot must exist after import');
  // Undo with faulty adapter: setItem(DATA) always throws → wLM commit+rollback both fail
  const faultyAdapter = makeFaultyAdapter(base, { [V2_KEYS.DATA]: { setItem: 'throw' } });
  const faulty        = makeService({ adapter: faultyAdapter });
  const result        = await faulty.applyUndo();
  assert.equal(result.ok, false, 'undo must fail when rollback write throws');
  // Snapshot must still be present in BACKUP key (not cleared, because wLM failed)
  const backup = JSON.parse(base.getItem(V2_KEYS.BACKUP));
  assert.ok(backup?.snapshot, 'snapshot must be retained after failed undo');
});

check('F7: hasSnapshot is false before any import, true after, false again after undo', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter });
  assert.equal(await svc.hasSnapshot(), false);
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  assert.equal(await svc.hasSnapshot(), true);
  await svc.applyUndo();
  assert.equal(await svc.hasSnapshot(), false);
});

/* ═══════════════════════════════════════════════════════════════════
   G · Snapshot invariants
═══════════════════════════════════════════════════════════════════ */
section('G-snapshot-invariants');

check('G1: snapshot keys array covers exactly IMPORT_KEYS', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  const backup  = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  const snapKeys = Object.keys(backup.snapshot.keys);
  assert.deepEqual(snapKeys.sort(), [...IMPORT_KEYS].sort());
});

check('G2: snapshot.savedAt matches the clock value at import time', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter, clock: () => NOW });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backup.snapshot.savedAt, NOW);
});

check('G3: export lastExport write does not overwrite the snapshot field in BACKUP key', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc     = makeService({ adapter, delivery: makeDelivery({ canShare: false }) });
  // First, create a snapshot via import
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);
  const snapBefore = JSON.parse(adapter.getItem(V2_KEYS.BACKUP)).snapshot;
  // Now export — which merge-writes lastExport into BACKUP
  await svc.exportBackup();
  const backupAfter = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.ok(backupAfter.lastExport, 'lastExport must be set');
  assert.deepEqual(backupAfter.snapshot, snapBefore, 'snapshot must not be overwritten by export');
});

check('G4: getLastExport returns null after BACKUP key is missing or malformed', async () => {
  const adapter = makeAdapter({ [V2_KEYS.BACKUP]: 'BAD-JSON' });
  const svc     = makeService({ adapter });
  assert.equal(await svc.getLastExport(), null, 'malformed BACKUP must not throw');
});

/* ═══════════════════════════════════════════════════════════════════
   H · getRecoveryNoticeState (Gate 4 — recovery evidence)
═══════════════════════════════════════════════════════════════════ */
section('H-recovery-notice');

check('H1: returns visible:false when no recovery, no rollback_failed, no interrupt', () => {
  const svc = makeService({ adapter: makeAdapter(), sessionStore: makeSessionStore() });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible, false);
  assert.equal(state.showDownload, false);
  assert.equal(state.showUndo, false);
});

check('H2: shows damaged-data notice with showDownload when undismissed recovery record exists', () => {
  const adapter = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ detectedAt: NOW, sourceKey: V2_KEYS.DATA,
      downloaded: false, dismissed: false, rawData: null, originalLength: 0,
      storedLength: 0, truncated: false, preservationFailed: false }),
  });
  const svc   = makeService({ adapter });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible, true);
  assert.equal(state.showDownload, true);
  assert.equal(state.showUndo, false);
  assert.ok(state.message.includes('damaged'), state.message);
});

check('H3: shows rollback_failed notice with showUndo when staging has rollback_failed', () => {
  const adapter = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({ txVersion: 2, txState: 'rollback_failed',
      rollbackError: 'inject', failedAt: NOW }),
  });
  const svc   = makeService({ adapter });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible, true);
  assert.equal(state.showUndo, true);
  assert.equal(state.showDownload, false);
});

check('H4: shows interrupted-import notice when session flag is set', () => {
  const svc   = makeService({
    adapter:      makeAdapter(),
    sessionStore: makeSessionStore({ [SESSION_RECOVERED_KEY]: '1' }),
  });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible, true);
  assert.equal(state.showDownload, false);
  assert.equal(state.showUndo, false);
  assert.ok(state.message.includes('incomplete import'), state.message);
});

check('H5: damaged-data takes priority over rollback_failed', () => {
  const adapter = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ downloaded: false, dismissed: false }),
    [V2_KEYS.STAGING]:  JSON.stringify({ txState: 'rollback_failed' }),
  });
  const svc   = makeService({ adapter });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.showDownload, true,  'damaged-data must win');
  assert.equal(state.showUndo,    false,  'rollback_failed must be suppressed');
});

check('H6: downloaded recovery record is NOT shown as undismissed', () => {
  const adapter = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ downloaded: true, dismissed: false }),
  });
  const svc   = makeService({ adapter });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible, false, 'downloaded record must not show notice');
});

check('H7 [V2-rollback-failed-format]: txState:failed + failCode:rollback-failed → visible:true showUndo:true', () => {
  // V2 locked-import shape: v2-locked-import.js writes txState:'failed', failCode:'rollback-failed'
  // after a rollback failure. getRecoveryNoticeState must recognize this shape.
  const adapter = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'failed', failCode: 'rollback-failed',
      transactionId: 'import:t:1', startedAt: NOW,
    }),
  });
  const svc   = makeService({ adapter });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible,      true,  'V2 rollback-failed must surface notice');
  assert.equal(state.showUndo,     true,  'V2 rollback-failed must set showUndo');
  assert.equal(state.showDownload, false, 'V2 rollback-failed must not set showDownload');
});

check('H8 [no-false-positive]: txState:failed with non-rollback-failed failCode → visible:false', () => {
  // txState:'failed' alone (other failCodes such as 'rolled-back' or 'journal-write-failed')
  // must NOT trigger the rollback-failed notice. The failCode guard is load-bearing.
  const adapter = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({
      txVersion: 1, txState: 'failed', failCode: 'rolled-back',
      transactionId: 'import:t:2', startedAt: NOW,
    }),
  });
  const svc   = makeService({ adapter });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.visible,  false, 'rolled-back failCode must not show notice');
  assert.equal(state.showUndo, false, 'rolled-back failCode must not set showUndo');
});

check('H9 [damaged-data-priority-V2]: damaged-data takes priority over V2 rollback-failed shape', () => {
  // Mirrors H5 for the V2 locked-import staging shape.
  // damaged-data (RECOVERY record) must win over V2-format rollback-failed.
  const adapter = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ downloaded: false, dismissed: false }),
    [V2_KEYS.STAGING]:  JSON.stringify({ txState: 'failed', failCode: 'rollback-failed' }),
  });
  const svc   = makeService({ adapter });
  const state = svc.getRecoveryNoticeState();
  assert.equal(state.showDownload, true,  'damaged-data must win');
  assert.equal(state.showUndo,     false, 'V2 rollback-failed must be suppressed');
});

/* ═══════════════════════════════════════════════════════════════════
   I · downloadRecoveryData + dismissRecovery (Gate 4)
═══════════════════════════════════════════════════════════════════ */
section('I-recovery-actions');

check('I1: downloadRecoveryData delivers a file and marks record downloaded', () => {
  const adapter  = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ detectedAt: NOW, sourceKey: V2_KEYS.DATA,
      originalLength: 5, storedLength: 5, truncated: false, rawData: 'hello',
      downloaded: false, dismissed: false, preservationFailed: false }),
  });
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery });
  const result   = svc.downloadRecoveryData();
  assert.equal(result.ok, true, result.message);
  assert.ok(delivery._calls.some(c => c.op === 'download'));
  const rec = JSON.parse(adapter.getItem(V2_KEYS.RECOVERY));
  assert.equal(rec.downloaded, true);
});

check('I2: downloadRecoveryData returns ok:false when no recovery record', () => {
  const svc    = makeService({ adapter: makeAdapter() });
  const result = svc.downloadRecoveryData();
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('No recovery data'), result.message);
});

check('I3: downloadRecoveryData payload includes _notice, detectedAt, rawData', () => {
  const adapter  = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ detectedAt: NOW, sourceKey: 'k',
      originalLength: 3, storedLength: 3, truncated: false, rawData: 'abc',
      downloaded: false, dismissed: false, preservationFailed: false }),
  });
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery });
  svc.downloadRecoveryData();
  const content = delivery._calls.find(c => c.op === 'download').content;
  const payload  = JSON.parse(content);
  assert.equal(payload._notice, 'This file is diagnostic data, not an importable backup.');
  assert.equal(payload.detectedAt, NOW);
  assert.equal(payload.rawData, 'abc');
});

check('I4: dismissRecovery marks record dismissed and clears session flag', () => {
  const adapter     = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ downloaded: false, dismissed: false }),
  });
  const sessionStore = makeSessionStore({ [SESSION_RECOVERED_KEY]: '1' });
  const svc          = makeService({ adapter, sessionStore });
  svc.dismissRecovery();
  const rec = JSON.parse(adapter.getItem(V2_KEYS.RECOVERY));
  assert.equal(rec.dismissed, true);
  assert.equal(sessionStore.getItem(SESSION_RECOVERED_KEY), null, 'session flag must be cleared');
});

check('I5: notice is gone after dismissRecovery', () => {
  const adapter     = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ downloaded: false, dismissed: false }),
  });
  const svc = makeService({ adapter });
  assert.equal(svc.getRecoveryNoticeState().visible, true);
  svc.dismissRecovery();
  assert.equal(svc.getRecoveryNoticeState().visible, false);
});

check('I6: notice is gone after downloadRecoveryData (downloaded=true suppresses it)', () => {
  const adapter  = makeAdapter({
    [V2_KEYS.RECOVERY]: JSON.stringify({ detectedAt: NOW, sourceKey: 'k',
      originalLength: 1, storedLength: 1, truncated: false, rawData: 'x',
      downloaded: false, dismissed: false, preservationFailed: false }),
  });
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery });
  assert.equal(svc.getRecoveryNoticeState().visible, true);
  svc.downloadRecoveryData();
  assert.equal(svc.getRecoveryNoticeState().visible, false);
});

/* ═══════════════════════════════════════════════════════════════════
   J · Data-loss tripwire — v2 service path (Gate 5)
═══════════════════════════════════════════════════════════════════ */
section('J-tripwire-v2-service');

check('J1: full lifecycle (readAndValidate → applyImport → export → readAndValidate → applyImport) preserves all user state', async () => {
  const adapter  = makeAdapter();
  seedV2(adapter);  // initial DATA + LIVE-STATE required for the first import
  const delivery = makeDelivery({ canShare: false });
  const svc      = makeService({ adapter, delivery });

  // Round 1: import from v1 fixture
  const { sanitized: v2First } = await svc.readAndValidate(makeV1BackupFileLike(FIXTURES.typical));
  await svc.applyImport(v2First);

  // Export the imported data
  const delivery2 = makeDelivery({ canShare: false });
  const svc2      = makeService({ adapter, delivery: delivery2 });
  await svc2.exportBackup();
  const exportedJson = delivery2._calls.find(c => c.op === 'download').content;

  // Round 2: validate the exported file
  const filelike2 = { size: exportedJson.length, _content: exportedJson };
  const { sanitized: v2Final } = await svc2.readAndValidate(filelike2);

  // Field-by-field survival across export → reimport
  for (const field of ['state', 'prefs', 'userZones', 'userTasks', 'completionEvents', 'overrides', 'recentSearches', 'meta']) {
    assert.deepEqual(
      v2Final[field], v2First[field],
      `${field} changed across export→reimport: data loss!`
    );
  }
});

check('J2: v2-path import into empty store preserves equivalence with v1 fixture', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);  // initial DATA + LIVE-STATE for the import
  const svc     = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeV1BackupFileLike(FIXTURES.typical));
  await svc.applyImport(sanitized);
  const v2Stored = JSON.parse(adapter.getItem(V2_KEYS.DATA));

  // Compose with catalog and check equivalence against original v1 fixture
  const composed = compose(CATALOG, v2Stored);
  assert.ok(composed.tasks.length >= CATALOG.tasks.length, 'composed task list is not complete');

  const v1Raw = {
    tasks: JSON.parse(FIXTURES.typical.v1TasksRaw),
    meta:  JSON.parse(FIXTURES.typical.v1MetaRaw),
  };
  const diffs = assertEquivalent(CATALOG, v1Raw, v2Stored, FIXED_TODAY);
  assert.deepEqual(diffs, [], `equivalence diffs: ${JSON.stringify(diffs)}`);
});

check('J3: unrelated keys in adapter are byte-identical after full lifecycle', async () => {
  const UNRELATED = { 'other-app': 'keep-me', 'whatever': '{"nested":true}' };
  const adapter   = makeAdapter(UNRELATED);
  seedV2(adapter);  // initial DATA + LIVE-STATE for the import
  const svc       = makeService({ adapter, delivery: makeDelivery({ canShare: false }) });

  // import
  const { sanitized } = await svc.readAndValidate(makeV1BackupFileLike());
  await svc.applyImport(sanitized);

  // export (DATA is already present from import — no re-seeding needed)
  await svc.exportBackup();

  // undo
  await svc.applyUndo();

  for (const [k, v] of Object.entries(UNRELATED)) {
    assert.equal(adapter.getItem(k), v, `unrelated key "${k}" was modified`);
  }
});

check('J4: injected tag-loss defect is detected by field comparison', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);  // initial DATA + LIVE-STATE for the import
  const svc     = makeService({ adapter, delivery: makeDelivery({ canShare: false }) });

  const { sanitized: v2First } = await svc.readAndValidate(makeV1BackupFileLike(FIXTURES.typical));
  await svc.applyImport(v2First);

  // Corrupt the stored DATA to simulate tag loss
  const stored = JSON.parse(adapter.getItem(V2_KEYS.DATA));
  stored.state = stored.state.map(s => ({ ...s, tags: [] }));
  adapter.setItem(V2_KEYS.DATA, JSON.stringify(stored));

  const delivery2 = makeDelivery({ canShare: false });
  const svc2      = makeService({ adapter, delivery: delivery2 });
  await svc2.exportBackup();
  const exportedJson = delivery2._calls.find(c => c.op === 'download').content;

  const filelike2 = { size: exportedJson.length, _content: exportedJson };
  const { sanitized: v2Corrupted } = await svc2.readAndValidate(filelike2);

  // Detect the difference between v2First and v2Corrupted
  const lostTags = v2First.state.filter(s => s.tags?.length > 0);
  const tripWired = lostTags.some(orig => {
    const corrupted = v2Corrupted.state.find(s => s.taskId === orig.taskId);
    return corrupted && corrupted.tags.length === 0;
  });
  assert.ok(tripWired || lostTags.length === 0, 'tag loss not detected by tripwire (or no tagged tasks in fixture)');
});

/* ═══════════════════════════════════════════════════════════════════
   K · Direct-storage boundary (Gate 6)
═══════════════════════════════════════════════════════════════════ */
section('K-direct-storage-boundary');

check('K1: v2-backup-service.js contains no localStorage reference (comment-stripped)', () => {
  const src = readFileSync(
    join(HERE, '..', 'src', 'data', 'backup', 'v2-backup-service.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!stripped.includes('localStorage.') && !stripped.includes('localStorage[') &&
            !stripped.includes('window.localStorage') && !stripped.includes('globalThis.localStorage'),
    'v2-backup-service.js must not contain any localStorage access');
});

check('K2: v2-backup-service.js contains no sessionStorage reference (all v2 session state is injected)', () => {
  const src = readFileSync(
    join(HERE, '..', 'src', 'data', 'backup', 'v2-backup-service.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!stripped.includes('sessionStorage.') && !stripped.includes('sessionStorage['),
    'v2-backup-service.js must not contain any direct sessionStorage access');
});

/* ═══════════════════════════════════════════════════════════════════
   L · Lock-timeout coverage (Gate 7)
   Pending-lock + MockScheduler.flush() for each new lock acquisition.
═══════════════════════════════════════════════════════════════════ */
section('L-lock-timeout');

check('L1: import — pending lock + scheduler flush → concurrency-unavailable; DATA not modified', async () => {
  const sched   = new MockScheduler();
  const adapter = makeAdapter();
  seedV2(adapter);
  const dataBefore = adapter.getItem(V2_KEYS.DATA);
  const svc = makeService({ adapter, lock: makePendingLock(), scheduler: sched });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  const p = svc.applyImport(sanitized);
  assert.equal(sched.pendingCount, 1, 'lock-timeout timer must be registered');
  sched.flush();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  assert.equal(adapter.getItem(V2_KEYS.DATA), dataBefore, 'DATA not modified');
  assert.equal(adapter.getItem(V2_KEYS.BACKUP), null, 'BACKUP not touched');
  assert.equal(sched.pendingCount, 0);
});

check('L2: undo — pending lock + scheduler flush → concurrency-unavailable; BACKUP unchanged', async () => {
  const sched   = new MockScheduler();
  const adapter = makeAdapter();
  seedV2(adapter);
  // Seed a snapshot so undo has something to work with
  const currentData = adapter.getItem(V2_KEYS.DATA);
  const snap = { transactionId: 'tx-test', savedAt: NOW,
    sourceDigest: 'x', targetDigest: hexOf(currentData),
    keys: { [ACTIVATION_KEYS.DATA]: currentData } };
  adapter.setItem(V2_KEYS.BACKUP, JSON.stringify({ snapshot: snap }));
  const backupBefore = adapter.getItem(V2_KEYS.BACKUP);
  const svc = makeService({ adapter, lock: makePendingLock(), scheduler: sched });
  const p = svc.applyUndo();
  assert.equal(sched.pendingCount, 1, 'lock-timeout timer must be registered');
  sched.flush();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  assert.equal(adapter.getItem(V2_KEYS.BACKUP), backupBefore, 'BACKUP unchanged');
  assert.equal(sched.pendingCount, 0);
});

check('L3: export — read-lock pending + scheduler flush → ok:false; no delivery', async () => {
  const sched    = new MockScheduler();
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: false });
  const svc = makeService({ adapter, lock: makePendingLock(), scheduler: sched, delivery });
  const p = svc.exportBackup();
  assert.equal(sched.pendingCount, 1, 'export-read timer must be registered');
  sched.flush();
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(r.message.toLowerCase().includes('lock'), `expected lock message, got: ${r.message}`);
  assert.equal(delivery._calls.filter(c => c.op === 'download' || c.op === 'share').length, 0,
    'no delivery when read-lock times out');
  assert.equal(sched.pendingCount, 0);
});

check('L4: export — write-lock timeout → delivery ok; lastExport not written', async () => {
  // Lock that executes non-backup-write calls normally and hangs on backup-write.
  // The backup-write timer (registered by withLockTimeout) is flushed by MockScheduler.
  const sched   = new MockScheduler();
  const txIdLock = {
    runExclusive: async (txId, cb) => {
      if (txId === 'backup-write') return new Promise(() => {});  // hang
      try { const r = await cb(); return { ok: true, result: r }; }
      catch (e) { return { ok: false, code: 'error', message: e?.message ?? '' }; }
    },
  };
  const adapter  = makeAdapter();
  seedV2(adapter);
  const delivery = makeDelivery({ canShare: false });
  const svc = makeService({ adapter, lock: txIdLock, scheduler: sched, delivery });
  const p = svc.exportBackup();
  // Drain all Promise microtasks: export-read resolves → delivery → backup-write timer registered
  await new Promise(r => setImmediate(r));
  assert.equal(sched.pendingCount, 1, 'backup-write timeout timer must be registered');
  sched.flush();
  const r = await p;
  assert.equal(r.ok, true, 'delivery must succeed even when write-lock times out');
  assert.ok(delivery._calls.some(c => c.op === 'download'), 'delivery was performed');
  assert.equal(adapter.getItem(V2_KEYS.BACKUP), null, 'lastExport not written (write-lock timed out)');
  assert.equal(sched.pendingCount, 0);
});

check('L5: hasSnapshot — pending lock + scheduler flush → returns false (fail-closed)', async () => {
  const sched   = new MockScheduler();
  const adapter = makeAdapter();
  // Seed a snapshot so that false is a meaningful fail-closed result
  adapter.setItem(V2_KEYS.BACKUP, JSON.stringify({
    snapshot: { transactionId: 'x', savedAt: NOW,
      keys: { [ACTIVATION_KEYS.DATA]: JSON.stringify(typicalV2()) } },
  }));
  const svc = makeService({ adapter, lock: makePendingLock(), scheduler: sched });
  const p = svc.hasSnapshot();
  assert.equal(sched.pendingCount, 1, 'has-snapshot timer must be registered');
  sched.flush();
  const result = await p;
  assert.equal(result, false, 'hasSnapshot must return false (fail-closed) when lock times out');
  assert.equal(sched.pendingCount, 0);
});

check('L6: getLastExport — pending lock + scheduler flush → returns null (fail-closed)', async () => {
  const sched   = new MockScheduler();
  const adapter = makeAdapter();
  // Seed a lastExport so that null is a meaningful fail-closed result
  adapter.setItem(V2_KEYS.BACKUP, JSON.stringify({ lastExport: '2026-07-31' }));
  const svc = makeService({ adapter, lock: makePendingLock(), scheduler: sched });
  const p = svc.getLastExport();
  assert.equal(sched.pendingCount, 1, 'get-last-export timer must be registered');
  sched.flush();
  const result = await p;
  assert.equal(result, null, 'getLastExport must return null (fail-closed) when lock times out');
  assert.equal(sched.pendingCount, 0);
});

/* ═══════════════════════════════════════════════════════════════════
   M · Interleaving + parity (Gate 8)
   Serial lock ensures consistent BACKUP merge-writes and monotonic generation.
═══════════════════════════════════════════════════════════════════ */
section('M-interleaving-parity');

check('M1: export → import: lastExport and snapshot coexist in BACKUP after both operations', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc = makeService({ adapter, delivery: makeDelivery({ canShare: false }),
    todayFn: () => '2026-08-12' });

  await svc.exportBackup();
  // After export: BACKUP has lastExport but no snapshot
  const backupAfterExport = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backupAfterExport.lastExport, '2026-08-12');
  assert.ok(!backupAfterExport.snapshot, 'no snapshot before import');

  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);

  // After import: BACKUP must have both lastExport AND snapshot (merge-write preserved lastExport)
  const backupAfterImport = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backupAfterImport.lastExport, '2026-08-12', 'lastExport preserved by import merge-write');
  assert.ok(backupAfterImport.snapshot, 'snapshot present after import');
});

check('M2: generation advances monotonically through import → undo → import sequence', async () => {
  // Proves the locked path writes LIVE-STATE with generation+1 for each wLM operation.
  const adapter = makeAdapter();
  const INITIAL = JSON.stringify(typicalV2());
  adapter.setItem(V2_KEYS.DATA, INITIAL);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(INITIAL)));
  const svc = makeService({ adapter });
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());

  // Import #1: generation 0 → 1
  await svc.applyImport(sanitized);
  const ls1 = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls1.generation, 1, 'generation after import #1');

  // Undo: generation 1 → 2 (wLM advances generation even for restore)
  await svc.applyUndo();
  const ls2 = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls2.generation, 2, 'generation after undo');

  // Import #2: generation 2 → 3
  await svc.applyImport(sanitized);
  const ls3 = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls3.generation, 3, 'generation after import #2');
});

check('M3: import → export → undo: DATA restored, snapshot cleared, lastExport preserved', async () => {
  const adapter = makeAdapter();
  seedV2(adapter);
  const svc = makeService({ adapter, delivery: makeDelivery({ canShare: false }),
    todayFn: () => '2026-08-12' });

  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);

  // Capture the pre-import bytes (snapshot.keys[DATA]) for later comparison
  const backupAfterImport = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  const priorData = backupAfterImport.snapshot.keys[ACTIVATION_KEYS.DATA];

  // Export: merge-writes lastExport alongside the existing snapshot
  await svc.exportBackup();
  const backupAfterExport = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backupAfterExport.lastExport, '2026-08-12', 'lastExport written after export');
  assert.ok(backupAfterExport.snapshot, 'snapshot still present after export');

  // Undo: restores DATA, clears snapshot (merge-deletes it), leaves lastExport intact
  await svc.applyUndo();

  assert.equal(adapter.getItem(V2_KEYS.DATA), priorData, 'DATA restored to pre-import state');
  const backupAfterUndo = JSON.parse(adapter.getItem(V2_KEYS.BACKUP) ?? '{}');
  assert.ok(!backupAfterUndo.snapshot, 'snapshot cleared after undo');
  assert.equal(backupAfterUndo.lastExport, '2026-08-12', 'lastExport preserved after undo');
});

check('M4: export captures DATA point-in-time; subsequent import does not affect delivered bytes', async () => {
  // Export #1 captures EMPTY state. Import then writes TYPICAL state. Export #2 captures TYPICAL.
  // This proves the lock-read in exportBackup delivers a consistent snapshot of DATA at call time.
  const adapter  = makeAdapter();
  const EMPTY    = JSON.stringify({
    schemaVersion: 2, state: [], prefs: { viewMode: 'today', roomFilter: '', onboarded: false,
      choice: null, completedAt: null, roomFilterZoneId: '' },
    userZones: [], userTasks: [], completionEvents: {}, overrides: {}, recentSearches: [], meta: null,
  });
  adapter.setItem(V2_KEYS.DATA, EMPTY);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(EMPTY)));

  const delivery1 = makeDelivery({ canShare: false });
  const svc       = makeService({ adapter, delivery: delivery1 });

  // Export #1: captures EMPTY state
  await svc.exportBackup();
  const exported1 = JSON.parse(delivery1._calls.find(c => c.op === 'download').content);

  // Import: changes DATA to typical fixture state
  const { sanitized } = await svc.readAndValidate(makeBackupFileLike());
  await svc.applyImport(sanitized);

  // Export #2: captures post-import (typical) state
  const delivery2 = makeDelivery({ canShare: false });
  const svc2      = makeService({ adapter, delivery: delivery2 });
  await svc2.exportBackup();
  const exported2 = JSON.parse(delivery2._calls.find(c => c.op === 'download').content);

  // Export #1 must contain the pre-import empty state
  assert.deepEqual(exported1.data.state, [],
    'export #1 must contain point-in-time empty state');
  // Export #2 must contain the imported typical state (differs from empty)
  assert.notDeepEqual(exported1.data.state, exported2.data.state,
    'export #2 must differ from export #1 (proving point-in-time capture)');
  assert.ok(exported2.data.state.length > 0, 'export #2 must have task state from imported fixture');
});

check('M5: concurrent export+import — export delivers pre-import bytes; import commits after export-read; lock order [export-read…, import-ts…, backup-write]', async () => {
  const adapter = makeAdapter();

  // PRE_IMPORT: minimal well-formed empty DATA that will be fully replaced by the import
  const PRE_IMPORT = JSON.stringify({
    schemaVersion: 2, state: [], prefs: {
      viewMode: 'today', roomFilter: '', onboarded: false,
      choice: null, completedAt: null, roomFilterZoneId: '',
    },
    userZones: [], userTasks: [], completionEvents: {}, overrides: {}, recentSearches: [], meta: null,
  });
  adapter.setItem(V2_KEYS.DATA, PRE_IMPORT);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRE_IMPORT)));

  const tracingLock = new TracingLock();
  let deliveredContent = null;

  // Async delivery: share() reads blob content then yields a full task boundary
  // (setImmediate) so all queued microtasks — including the import lock callback —
  // run to completion before backup-write is acquired.
  const asyncDelivery = {
    canShare:  ()           => true,
    share:     async (blob) => {
      // V2BackupService passes a native Blob to share(); read via blob.text().
      deliveredContent = typeof blob.text === 'function' ? await blob.text() : blob._content;
      await new Promise(r => setImmediate(r)); // task boundary — import drains here
    },
    download:  ()           => {},
  };

  const svc = makeService({ adapter, lock: tracingLock, delivery: asyncDelivery });

  // Chain readAndValidate→applyImport before the first await so that the import
  // lock is queued before setImmediate fires. exportBackup and importP start
  // racing together at the Promise.all suspension.
  const exportP = svc.exportBackup();
  const importP = svc.readAndValidate(makeBackupFileLike())
    .then(({ sanitized }) => svc.applyImport(sanitized));

  await Promise.all([exportP, importP]);

  // 1. Delivered bytes must reflect the PRE_IMPORT empty state
  assert.ok(deliveredContent !== null && deliveredContent !== undefined,
    'export must have delivered content');
  const delivered = JSON.parse(deliveredContent);
  assert.deepEqual(delivered.data.state, [],
    'delivered bytes must be the pre-import empty state');

  // 2. Live DATA must now contain the post-import typical state
  const liveData = JSON.parse(adapter.getItem(V2_KEYS.DATA));
  assert.ok(liveData.state.length > 0, 'live DATA must be post-import typical state');

  // 3. Snapshot DATA bytes must equal PRE_IMPORT (snapshot taken at import time)
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backup.snapshot.keys[ACTIVATION_KEYS.DATA], PRE_IMPORT,
    'snapshot must capture the pre-import DATA bytes');

  // 4. lastExport must be written (backup-write ran after import committed)
  assert.ok(backup.lastExport, 'lastExport must be written after export');

  // 5. Lock order: export-read enclosed → import (any middle tag) → backup-write.
  //    runV2LockedImport prefixes the clock txId internally, so we locate the
  //    import acquire/release by position rather than by exact tag value.
  const log = tracingLock.log;
  const erAcq = log.indexOf('acquire:export-read');
  const erRel = log.indexOf('release:export-read');
  const bwAcq = log.indexOf('acquire:backup-write');
  const bwRel = log.indexOf('release:backup-write');
  // Import acquire is the first 'acquire:...' entry after export-read releases
  const imAcq = log.findIndex((e, i) => i > erRel && e.startsWith('acquire:') && !e.endsWith('backup-write'));
  // Import release is the first 'release:...' entry after import acquires
  const imRel = imAcq >= 0
    ? log.findIndex((e, i) => i > imAcq && e.startsWith('release:') && !e.endsWith('backup-write'))
    : -1;

  assert.ok(erAcq >= 0 && erAcq < erRel, 'export-read: acquire before release');
  assert.ok(imAcq >  erRel,              'import must start after export-read releases');
  assert.ok(imRel >= 0 && imRel < bwAcq,'import must finish before backup-write starts');
  assert.ok(bwAcq <  bwRel,             'backup-write: acquire before release');
});

check('M6: concurrent export+undo — export delivers post-import bytes; undo restores prior state; lock order [export-read…, undo…, backup-write]', async () => {
  const adapter = makeAdapter();

  // PRE_IMPORT: minimal well-formed empty DATA
  const PRE_IMPORT = JSON.stringify({
    schemaVersion: 2, state: [], prefs: {
      viewMode: 'today', roomFilter: '', onboarded: false,
      choice: null, completedAt: null, roomFilterZoneId: '',
    },
    userZones: [], userTasks: [], completionEvents: {}, overrides: {}, recentSearches: [], meta: null,
  });
  adapter.setItem(V2_KEYS.DATA, PRE_IMPORT);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(PRE_IMPORT)));

  // Serial import to create snapshot — undo will restore from it
  {
    const setupSvc = makeService({ adapter });
    const { sanitized } = await setupSvc.readAndValidate(makeBackupFileLike());
    await setupSvc.applyImport(sanitized);
  }
  // Now: DATA = typical fixture state, BACKUP.snapshot.keys[DATA] = PRE_IMPORT

  const tracingLock = new TracingLock();
  let deliveredContent = null;

  const asyncDelivery = {
    canShare:  ()           => true,
    share:     async (blob) => {
      // V2BackupService passes a native Blob to share(); read via blob.text().
      deliveredContent = typeof blob.text === 'function' ? await blob.text() : blob._content;
      await new Promise(r => setImmediate(r)); // task boundary — undo drains here
    },
    download:  ()           => {},
  };

  const svc = makeService({ adapter, lock: tracingLock, delivery: asyncDelivery });

  // Export first (captures post-import typical DATA), then queue undo
  const exportP = svc.exportBackup();
  const undoP   = svc.applyUndo();

  await Promise.all([exportP, undoP]);

  // 1. Delivered bytes must contain the post-import typical state
  assert.ok(deliveredContent !== null, 'export must have delivered content');
  const delivered = JSON.parse(deliveredContent);
  assert.ok(delivered.data.state.length > 0,
    'delivered bytes must be the post-import typical state');

  // 2. Live DATA must be restored to PRE_IMPORT (undo committed)
  assert.equal(adapter.getItem(V2_KEYS.DATA), PRE_IMPORT,
    'live DATA must be restored to pre-import state after undo');

  // 3. Snapshot must be cleared (undo completed)
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP) ?? '{}');
  assert.ok(!backup.snapshot, 'snapshot must be cleared after undo');

  // 4. lastExport written (backup-write ran after undo committed)
  assert.ok(backup.lastExport, 'lastExport must be written after export');

  // 5. Lock order: export-read enclosed → undo (any middle tag) → backup-write.
  //    runV2LockedUndo prefixes the txId internally, so we locate undo by position.
  const log = tracingLock.log;
  const erAcq = log.indexOf('acquire:export-read');
  const erRel = log.indexOf('release:export-read');
  const bwAcq = log.indexOf('acquire:backup-write');
  const bwRel = log.indexOf('release:backup-write');
  // Undo acquire is the first 'acquire:...' entry after export-read releases
  const unAcq = log.findIndex((e, i) => i > erRel && e.startsWith('acquire:') && !e.endsWith('backup-write'));
  // Undo release is the first 'release:...' entry after undo acquires
  const unRel = unAcq >= 0
    ? log.findIndex((e, i) => i > unAcq && e.startsWith('release:') && !e.endsWith('backup-write'))
    : -1;

  assert.ok(erAcq >= 0 && erAcq < erRel, 'export-read: acquire before release');
  assert.ok(unAcq >  erRel,              'undo must start after export-read releases');
  assert.ok(unRel >= 0 && unRel < bwAcq,'undo must finish before backup-write starts');
  assert.ok(bwAcq <  bwRel,             'backup-write: acquire before release');
});

/* ═══════════════════════════════════════════════════════════════════
   P · V1BackupService / V2BackupService production-parity (Gate 9)

   Invariant: V2BackupService provides the same behavioural guarantees as
   V1BackupService for equivalent backup-workflow operations, adapted to
   v2 storage layout.

   Intentional structural differences (each with a mapped invariant):
     • Snapshot format — V1 stores per-key bytes (hometask-v1, hometask-meta-v1)
                         V2 stores a unified DATA key
       Mapped invariant: both applyUndo() restore all import-affected storage
       bytes to their exact pre-import values.
     • getLastExport — V1 is synchronous (repo.getLastExport())
                       V2 is async / lock-scoped (await svc.getLastExport())
       Mapped invariant: both return null before any export, a YYYY-MM-DD
       date-string after a successful export.
     • Mutation lock — V1 has none; V2 uses an injected lock.
       Mapped invariant: serial (non-concurrent) call sequences produce
       identical outcomes in both services.
     • Import argument shape — V1 applyImport(sanitizedTasks, sanitizedPrefs)
                               V2 applyImport(sanitizedEnvelope{schemaVersion:2})
       Mapped invariant: both accept the same v1 backup file through their
       respective readAndValidate → applyImport pipelines, both returning ok:true.
═══════════════════════════════════════════════════════════════════ */
section('P-v1-v2-parity');

check('P1: export parity — both V1BackupService and V2BackupService return ok:true and confirm delivery', async () => {
  // V1: empty backing (no user tasks)
  const v1env   = makeV1ServiceEnv();
  // V2: seeded with typical DATA so export has content
  const v2adp   = makeAdapter();
  seedV2(v2adp);
  const v2svc   = makeService({ adapter: v2adp, delivery: makeDelivery({ canShare: false }) });

  const v1result = await v1env.svc.exportBackup();
  const v2result = await v2svc.exportBackup();

  assert.ok(v1result.ok, `V1 exportBackup must return ok:true (got: ${v1result.message})`);
  assert.ok(v2result.ok, `V2 exportBackup must return ok:true (got: ${v2result.message})`);
  assert.ok(v1env.exportCalled(), 'V1 delivery.download must have been invoked');
});

check('P2: import parity — both services accept a v1 backup file via readAndValidate→applyImport and return ok:true', async () => {
  // V1: readAndValidate resolves { sanitizedTasks, sanitizedPrefs, … }
  const v1env = makeV1ServiceEnv();
  const { sanitizedTasks, sanitizedPrefs } = await v1env.svc.readAndValidate(makeV1BackupFileLike());
  const v1import = v1env.svc.applyImport(sanitizedTasks, sanitizedPrefs);

  // V2: readAndValidate resolves { sanitized } (migrated to schemaVersion:2 internally)
  const v2adp = makeAdapter();
  seedV2(v2adp);
  const v2svc = makeService({ adapter: v2adp });
  const { sanitized } = await v2svc.readAndValidate(makeV1BackupFileLike());
  const v2import = await v2svc.applyImport(sanitized);

  assert.ok(v1import.ok, `V1 applyImport must return ok:true (got: ${v1import.message})`);
  assert.ok(v2import.ok, `V2 applyImport must return ok:true (got: ${v2import.message})`);
});

check('P3: snapshot structure difference (intentional) — V1 stores per-key bytes; V2 stores unified DATA — both restore all import-affected bytes on undo', async () => {
  // ── V1 ──
  const V1_PRE_TASKS = JSON.stringify([]);   // empty tasks pre-import
  const v1env = makeV1ServiceEnv();           // backing['hometask-v1'] = '[]'
  const { sanitizedTasks, sanitizedPrefs } = await v1env.svc.readAndValidate(makeV1BackupFileLike());
  v1env.svc.applyImport(sanitizedTasks, sanitizedPrefs);

  const v1Snap = v1env.backupStore.getSnapshot();
  assert.ok(v1Snap !== null, 'V1 must have a snapshot after import');
  assert.deepEqual(Object.keys(v1Snap).sort(), ['hometask-meta-v1', 'hometask-v1'],
    'V1 snapshot must store per-key bytes for both import keys');

  v1env.svc.applyUndo();
  assert.equal(v1env.backing.getItem('hometask-v1'), V1_PRE_TASKS,
    'V1 undo must restore hometask-v1 to pre-import bytes');

  // ── V2 ──
  const v2adp = makeAdapter();
  const v2pre = seedV2(v2adp);               // DATA = typical v2 fixture bytes
  const V2_PRE_DATA = JSON.stringify(v2pre);  // capture pre-import DATA string
  const v2svc = makeService({ adapter: v2adp });
  const { sanitized } = await v2svc.readAndValidate(makeV1BackupFileLike());
  await v2svc.applyImport(sanitized);

  const v2backup = JSON.parse(v2adp.getItem(V2_KEYS.BACKUP));
  assert.ok(v2backup.snapshot?.keys, 'V2 must have a snapshot with keys map after import');
  assert.ok(ACTIVATION_KEYS.DATA in v2backup.snapshot.keys,
    'V2 snapshot must store the unified DATA key');

  await v2svc.applyUndo();
  assert.equal(v2adp.getItem(V2_KEYS.DATA), V2_PRE_DATA,
    'V2 undo must restore DATA to pre-import bytes');
});

check('P4: undo parity — both services return ok:true and clear snapshot', async () => {
  // V1
  const v1env = makeV1ServiceEnv();
  const { sanitizedTasks, sanitizedPrefs } = await v1env.svc.readAndValidate(makeV1BackupFileLike());
  v1env.svc.applyImport(sanitizedTasks, sanitizedPrefs);
  const v1undo = v1env.svc.applyUndo();

  // V2
  const v2adp = makeAdapter();
  seedV2(v2adp);
  const v2svc = makeService({ adapter: v2adp });
  const { sanitized } = await v2svc.readAndValidate(makeV1BackupFileLike());
  await v2svc.applyImport(sanitized);
  const v2undo = await v2svc.applyUndo();

  assert.ok(v1undo.ok, `V1 applyUndo must return ok:true (got: ${v1undo.error})`);
  assert.ok(v2undo.ok, `V2 applyUndo must return ok:true (got: ${v2undo.message})`);
  assert.ok(!v1env.svc.hasSnapshot(), 'V1 snapshot must be cleared after undo');
  assert.ok(!await v2svc.hasSnapshot(), 'V2 snapshot must be cleared after undo');
});

check('P5: hasSnapshot lifecycle — both V1 (synchronous) and V2 (async) track false→true→false', async () => {
  // V1
  const v1env = makeV1ServiceEnv();
  assert.ok(!v1env.svc.hasSnapshot(), 'V1: hasSnapshot false before import');
  const { sanitizedTasks, sanitizedPrefs } = await v1env.svc.readAndValidate(makeV1BackupFileLike());
  v1env.svc.applyImport(sanitizedTasks, sanitizedPrefs);
  assert.ok(v1env.svc.hasSnapshot(),  'V1: hasSnapshot true after import');
  v1env.svc.applyUndo();
  assert.ok(!v1env.svc.hasSnapshot(), 'V1: hasSnapshot false after undo');

  // V2
  const v2adp = makeAdapter();
  seedV2(v2adp);
  const v2svc = makeService({ adapter: v2adp });
  assert.ok(!await v2svc.hasSnapshot(), 'V2: hasSnapshot false before import');
  const { sanitized } = await v2svc.readAndValidate(makeV1BackupFileLike());
  await v2svc.applyImport(sanitized);
  assert.ok(await v2svc.hasSnapshot(),  'V2: hasSnapshot true after import');
  await v2svc.applyUndo();
  assert.ok(!await v2svc.hasSnapshot(), 'V2: hasSnapshot false after undo');
});

check('P6: getLastExport parity — V1 (synchronous) and V2 (async) both return null before export, YYYY-MM-DD date-string after', async () => {
  // V1
  const v1env = makeV1ServiceEnv();
  assert.equal(v1env.svc.getLastExport(), null, 'V1: getLastExport null before export');
  await v1env.svc.exportBackup();
  const v1After = v1env.svc.getLastExport();
  assert.ok(typeof v1After === 'string', `V1: getLastExport must be a string after export (got: ${v1After})`);
  assert.match(v1After, /^\d{4}-\d{2}-\d{2}$/, 'V1: getLastExport must be YYYY-MM-DD');

  // V2
  const v2adp = makeAdapter();
  seedV2(v2adp);
  const v2svc = makeService({ adapter: v2adp, delivery: makeDelivery({ canShare: false }) });
  assert.equal(await v2svc.getLastExport(), null, 'V2: getLastExport null before export');
  await v2svc.exportBackup();
  const v2After = await v2svc.getLastExport();
  assert.ok(typeof v2After === 'string', `V2: getLastExport must be a string after export (got: ${v2After})`);
  assert.match(v2After, /^\d{4}-\d{2}-\d{2}$/, 'V2: getLastExport must be YYYY-MM-DD');
});

/* ─── Run ─────────────────────────────────────────────────────── */
await Promise.all(pending);
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
