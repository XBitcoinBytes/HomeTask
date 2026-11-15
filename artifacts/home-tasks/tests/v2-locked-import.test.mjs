/**
 * v2-locked-import.test.mjs — Suite 21 (Batch A)
 *
 * Covers runV2LockedImport, runV2LockedUndo, and recoverV2Startup.
 *
 * Sections:
 *   A  Lock enforcement — import (failure before any storage read)
 *   B  Lock enforcement — undo
 *   C  Import pre-condition guards (all inside lock)
 *   D  Import happy path
 *   E  Import failure paths
 *   F  Undo pre-condition guards
 *   G  Undo happy path
 *   H  Coordinator (recoverV2Startup)
 *   I  Static purity (no localStorage / sessionStorage)
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'src');

/* ── Imports ─────────────────────────────────────────────────────── */

const { runV2LockedImport, runV2LockedUndo, recoverV2Startup,
        withLockTimeout,
        IMPORT_STAGING_TX_VERSION, IMPORT_STAGING_QUARANTINE_MAX_RAW } =
  await import('../src/data/backup/v2-locked-import.js');

const { ACTIVATION_KEYS } = await import('../src/v2/activation-tx.js');
const { V2_KEYS }          = await import('../src/v2/import-tx.js');

/* ── Digest helpers ──────────────────────────────────────────────── */

/** Synchronous SHA-256; wrapped in Promise.resolve for the async digestFn interface. */
function testDigest(bytes) {
  return Promise.resolve(createHash('sha256').update(bytes).digest('hex'));
}
function hexOf(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/* ── Test lock ───────────────────────────────────────────────────── */

class TestLock {
  constructor() { this._queue = Promise.resolve(); }
  runExclusive(txId, callback) {
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

const throwingLock = {
  runExclusive: () => { throw new Error('lock-exploded'); },
};
const deniedLock = {
  runExclusive: async () => ({ ok: false, code: 'lock-denied', message: 'Denied by policy.' }),
};

/* ── Adapters ────────────────────────────────────────────────────── */

function makeAdapter(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem:    (k) => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _store:     store,
  };
}

/** Tracks how many times getItem is called — for lock-failure tests. */
function makeTrackingAdapter(initial = {}) {
  const store = new Map(Object.entries(initial));
  let getCalls = 0;
  return {
    getItem:    (k) => { getCalls++; return store.has(k) ? store.get(k) : null; },
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _store:     store,
    getCalls:   () => getCalls,
  };
}

/** setItem throws for a specific key (to simulate quota). */
function makeQuotaAdapter(failKey, initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem:    (k) => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => {
      if (k === failKey) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    _store:     store,
  };
}

/* ── State seeding ───────────────────────────────────────────────── */

const D0 = '{"prefs":{"viewMode":"today","roomFilter":""},"state":[],"schemaVersion":2}';
const D1 = '{"prefs":{"viewMode":"home","roomFilter":"kitchen"},"state":[{"taskId":"t1"}],"schemaVersion":2}';
const MARKER_BYTES = '{"markerVersion":1,"activatedAt":"2026-01-01T00:00:00.000Z"}';
const NOW = '2026-08-12T10:00:00.000Z';

function makeLS(generation, digest) {
  return JSON.stringify({ generation, digest, schemaVersion: 2 });
}
function makeJournal({ generation, prevDigest, prevRaw, newDigest }) {
  return JSON.stringify({ phase: 'prepared', generation, prevDigest, prevRaw, newDigest });
}

/** Seed adapter with DATA=data and LIVE-STATE pointing to sha256(data). */
function seedClean(adapter, data = D0, generation = 0) {
  const digest = hexOf(data);
  adapter.setItem(ACTIVATION_KEYS.DATA,       data);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(generation, digest));
  return digest;
}

/* ── Test harness ────────────────────────────────────────────────── */

let passed = 0, failed = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓  ${label}`);
  } catch (e) {
    failed++;
    failures.push({ label, error: e.message });
    console.error(`  ✗  ${label}\n     ${e.message}`);
  }
}

/* ════════════════════════════════════════════════════════════════════
   A — Lock enforcement: runV2LockedImport
════════════════════════════════════════════════════════════════════ */
console.log('\n── A-lock-import\n');

await check('A1: null lock → TypeError; no storage read', async () => {
  const adapter = makeTrackingAdapter();
  await assert.rejects(
    () => runV2LockedImport(adapter, D1, null, NOW, testDigest, 0),
    TypeError,
  );
  assert.equal(adapter.getCalls(), 0, 'getItem must not be called');
});

await check('A2: lock without runExclusive → TypeError; no storage read', async () => {
  const adapter = makeTrackingAdapter();
  await assert.rejects(
    () => runV2LockedImport(adapter, D1, {}, NOW, testDigest, 0),
    TypeError,
  );
  assert.equal(adapter.getCalls(), 0);
});

await check('A3: throwing lock → concurrency-unavailable; adapter.getItem never called', async () => {
  const adapter = makeTrackingAdapter();
  const r = await runV2LockedImport(adapter, D1, throwingLock, NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  assert.equal(adapter.getCalls(), 0, 'Lock threw before callback; no reads permitted');
});

await check('A4: denied lock → concurrency-unavailable; adapter.getItem never called', async () => {
  const adapter = makeTrackingAdapter();
  const r = await runV2LockedImport(adapter, D1, deniedLock, NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  assert.equal(adapter.getCalls(), 0, 'Denied lock never runs callback; no reads permitted');
});

await check('A5: empty dataStr → invalid-input before lock acquired', async () => {
  const adapter = makeTrackingAdapter();
  const r = await runV2LockedImport(adapter, '', throwingLock, NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-input');
  assert.equal(adapter.getCalls(), 0);
});

/* ════════════════════════════════════════════════════════════════════
   B — Lock enforcement: runV2LockedUndo
════════════════════════════════════════════════════════════════════ */
console.log('\n── B-lock-undo\n');

await check('B1: null lock → TypeError; no storage read', async () => {
  const adapter = makeTrackingAdapter();
  await assert.rejects(
    () => runV2LockedUndo(adapter, null, testDigest, 0),
    TypeError,
  );
  assert.equal(adapter.getCalls(), 0);
});

await check('B2: throwing lock → concurrency-unavailable; adapter.getItem never called', async () => {
  const adapter = makeTrackingAdapter();
  const r = await runV2LockedUndo(adapter, throwingLock, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  assert.equal(adapter.getCalls(), 0);
});

/* ════════════════════════════════════════════════════════════════════
   C — Import pre-condition guards (all verified to be inside lock)
════════════════════════════════════════════════════════════════════ */
console.log('\n── C-import-guards\n');

await check('C1: rollback_failed staging → blocked-rollback-failed; snapshot not written', async () => {
  const adapter = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({ txState: 'rollback_failed', transactionId: 'prior' }),
  });
  seedClean(adapter);
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'blocked-rollback-failed');
  // Snapshot must not have been written
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP) ?? 'null');
  assert.equal(backup?.snapshot ?? null, null, 'Snapshot must not be written when blocked');
});

await check('C2: LIVE-STATE absent → live-state-invalid; DATA unchanged', async () => {
  const adapter = makeAdapter({ [ACTIVATION_KEYS.DATA]: D0 });
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'live-state-invalid');
  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA must be unchanged');
});

await check('C3: LIVE-STATE malformed (wrong schemaVersion) → live-state-invalid', async () => {
  const adapter = makeAdapter({
    [ACTIVATION_KEYS.DATA]:       D0,
    [ACTIVATION_KEYS.LIVE_STATE]: JSON.stringify({ generation: 0, digest: hexOf(D0), schemaVersion: 1 }),
  });
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'live-state-invalid');
});

await check('C4: DATA absent → data-absent; snapshot not written', async () => {
  const adapter = makeAdapter({
    [ACTIVATION_KEYS.LIVE_STATE]: makeLS(0, hexOf(D0)),
  });
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-absent');
  assert.equal(adapter.getItem(V2_KEYS.BACKUP), null, 'Snapshot must not be written');
});

await check('C5: snapshot write quota → snapshot-failed; DATA unchanged; staging not written', async () => {
  const adapter = makeQuotaAdapter(V2_KEYS.BACKUP);
  seedClean(adapter);
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'snapshot-failed');
  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA unchanged');
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null, 'Staging not written');
});

await check('C6: staging write quota → staging-failed; DATA unchanged', async () => {
  const adapter = makeQuotaAdapter(V2_KEYS.STAGING);
  seedClean(adapter);
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'staging-failed');
  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA unchanged');
});

/* ════════════════════════════════════════════════════════════════════
   D — Import happy path
════════════════════════════════════════════════════════════════════ */
console.log('\n── D-import-happy\n');

await check('D1: full import → ok:true; DATA=D1; LIVE-STATE consistent; gen advances', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, true, r.message);
  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D1, 'DATA must equal imported bytes');
  const ls = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.digest, hexOf(D1), 'LIVE-STATE.digest must equal sha256(D1)');
  assert.equal(ls.generation, 1, 'generation must advance from 0 to 1');
  assert.equal(ls.schemaVersion, 2);
});

await check('D2: staging absent after successful import', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null, 'Staging must be cleared after success');
});

await check('D3: snapshot present with transactionId, sourceDigest, targetDigest', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  const snap = backup?.snapshot;
  assert.ok(snap, 'Snapshot must be present for undo');
  assert.equal(snap.sourceDigest, hexOf(D0), 'sourceDigest must equal sha256(D0)');
  assert.equal(snap.targetDigest, hexOf(D1), 'targetDigest must equal sha256(D1)');
  assert.ok(typeof snap.transactionId === 'string' && snap.transactionId.length > 0, 'transactionId must be present');
  assert.equal(snap.keys[ACTIVATION_KEYS.DATA], D0, 'snapshot must contain pre-import bytes');
});

await check('D4: journal absent after import (wLM cleared it at step 4)', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(adapter.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'Journal must be cleared');
});

await check('D5: lastExport preserved in backup key after import', async () => {
  const adapter = makeAdapter({
    [V2_KEYS.BACKUP]: JSON.stringify({ lastExport: '2026-01-01T00:00:00.000Z' }),
  });
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backup.lastExport, '2026-01-01T00:00:00.000Z', 'lastExport must survive snapshot write');
  assert.ok(backup.snapshot, 'Snapshot must also be present');
});

await check('D6: unrelated keys byte-identical after import', async () => {
  const adapter = makeAdapter({ 'hometask-unrelated': 'some-value' });
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(adapter.getItem('hometask-unrelated'), 'some-value');
});

await check('D7: MARKER byte-identical after import', async () => {
  const adapter = makeAdapter({ [ACTIVATION_KEYS.MARKER]: MARKER_BYTES });
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(adapter.getItem(ACTIVATION_KEYS.MARKER), MARKER_BYTES, 'MARKER must never be written');
});

/* ════════════════════════════════════════════════════════════════════
   E — Import failure paths (wLM failure → staging patched; no second rollback)
════════════════════════════════════════════════════════════════════ */
console.log('\n── E-import-failures\n');

await check('E1: wLM fails (DATA quota) → staging patched to failed; code forwarded; no custom rollback', async () => {
  // Fail on DATA write inside wLM to trigger data-write-failed
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  // Patch setItem to fail on DATA after snapshot+staging are written
  let dataCalls = 0;
  const origSet = adapter.setItem.bind(adapter);
  adapter.setItem = (k, v) => {
    if (k === ACTIVATION_KEYS.DATA) {
      dataCalls++;
      // Allow MUT_JOURNAL write (first), then fail DATA write
      if (dataCalls === 1) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    }
    origSet(k, v);
  };
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(r.ok, false, 'Must fail');
  // Staging should be patched to 'failed'
  const staging = JSON.parse(adapter.getItem(V2_KEYS.STAGING));
  assert.equal(staging?.txState, 'failed', 'Staging must be patched to failed');
  assert.ok(typeof staging?.failCode === 'string', 'failCode must be recorded');
  // DATA must be restored by wLM's own internal restore (not a custom rollback)
  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA must be restored to pre-import bytes');
});

await check('E2: failed wLM → failCode in staging matches returned code', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  let dataCalls = 0;
  const origSet = adapter.setItem.bind(adapter);
  adapter.setItem = (k, v) => {
    if (k === ACTIVATION_KEYS.DATA && ++dataCalls === 1)
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    origSet(k, v);
  };
  const r = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  const staging = JSON.parse(adapter.getItem(V2_KEYS.STAGING));
  assert.equal(staging?.failCode, r.code, 'failCode in staging must match returned code');
});

await check('E3: snapshot present even after failed import (retained for diagnosis)', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  let dataCalls = 0;
  const origSet = adapter.setItem.bind(adapter);
  adapter.setItem = (k, v) => {
    if (k === ACTIVATION_KEYS.DATA && ++dataCalls === 1)
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    origSet(k, v);
  };
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.ok(backup?.snapshot, 'Snapshot must be retained after failed import');
});

/* ════════════════════════════════════════════════════════════════════
   F — Undo pre-condition guards (all inside lock)
════════════════════════════════════════════════════════════════════ */
console.log('\n── F-undo-guards\n');

await check('F1: rollback_failed staging → blocked-rollback-failed in undo', async () => {
  const adapter = makeAdapter({
    [V2_KEYS.STAGING]: JSON.stringify({ txState: 'rollback_failed', transactionId: 'x' }),
  });
  seedClean(adapter);
  const r = await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'blocked-rollback-failed');
});

await check('F2: no snapshot → no-snapshot', async () => {
  const adapter = makeAdapter();
  seedClean(adapter);
  const r = await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-snapshot');
});

await check('F3: snapshot missing transactionId → snapshot-malformed', async () => {
  const adapter = makeAdapter({
    [V2_KEYS.BACKUP]: JSON.stringify({ snapshot: { savedAt: NOW, sourceDigest: hexOf(D0), keys: { [ACTIVATION_KEYS.DATA]: D0 } } }),
  });
  seedClean(adapter, D0, 0);
  // Make DATA = D1 so ownership check uses a targetDigest from the snapshot
  // (but targetDigest is missing so malformed fires first)
  const r = await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'snapshot-malformed');
});

await check('F4: snapshot.keys[DATA] === null → cannot-undo-to-absent-data', async () => {
  const snap = {
    transactionId: 'tx-1', savedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
    keys: { [ACTIVATION_KEYS.DATA]: null },
  };
  const adapter = makeAdapter({ [V2_KEYS.BACKUP]: JSON.stringify({ snapshot: snap }) });
  seedClean(adapter, D1, 1);
  const r = await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cannot-undo-to-absent-data');
});

await check('F5: LIVE-STATE absent → live-state-invalid in undo', async () => {
  const snap = {
    transactionId: 'tx-1', savedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
    keys: { [ACTIVATION_KEYS.DATA]: D0 },
  };
  const adapter = makeAdapter({
    [V2_KEYS.BACKUP]:          JSON.stringify({ snapshot: snap }),
    [ACTIVATION_KEYS.DATA]:    D1,
    // LIVE-STATE absent
  });
  const r = await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'live-state-invalid');
});

await check('F6: sha256(DATA) ≠ targetDigest → snapshot-stale', async () => {
  // DATA was mutated after the import
  const snap = {
    transactionId: 'tx-1', savedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
    keys: { [ACTIVATION_KEYS.DATA]: D0 },
  };
  const D_mutated = '{"prefs":{},"state":[{"taskId":"t2"}],"schemaVersion":2}';
  const adapter = makeAdapter({ [V2_KEYS.BACKUP]: JSON.stringify({ snapshot: snap }) });
  // DATA = D_mutated (differs from targetDigest = sha256(D1))
  seedClean(adapter, D_mutated, 2);
  const r = await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'snapshot-stale');
});

/* ════════════════════════════════════════════════════════════════════
   G — Undo happy path
════════════════════════════════════════════════════════════════════ */
console.log('\n── G-undo-happy\n');

await check('G1: undo after import → ok:true; DATA=D0; LIVE-STATE consistent; gen advances', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  // Import D1
  const ir = await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  assert.equal(ir.ok, true, `Import failed: ${ir.message}`);
  const genAfterImport = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE)).generation;

  // Undo
  const ur = await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(ur.ok, true, `Undo failed: ${ur.message}`);

  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D0, 'DATA must be restored to pre-import bytes');
  const ls = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.digest, hexOf(D0), 'LIVE-STATE.digest must equal sha256(D0)');
  assert.equal(ls.generation, genAfterImport + 1, 'Generation must advance (never revert)');
});

await check('G2: snapshot absent after successful undo', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP) ?? '{}');
  assert.equal(backup.snapshot ?? null, null, 'Snapshot must be cleared after successful undo');
});

await check('G3: lastExport preserved during undo', async () => {
  const adapter = makeAdapter({
    [V2_KEYS.BACKUP]: JSON.stringify({ lastExport: '2026-06-01T00:00:00.000Z' }),
  });
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  const backup = JSON.parse(adapter.getItem(V2_KEYS.BACKUP));
  assert.equal(backup.lastExport, '2026-06-01T00:00:00.000Z', 'lastExport must survive undo');
});

await check('G4: unrelated keys unchanged by undo', async () => {
  const adapter = makeAdapter({ 'some-other-key': 'untouched' });
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(adapter.getItem('some-other-key'), 'untouched');
});

await check('G5: MARKER unchanged by undo', async () => {
  const adapter = makeAdapter({ [ACTIVATION_KEYS.MARKER]: MARKER_BYTES });
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);
  await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);
  assert.equal(adapter.getItem(ACTIVATION_KEYS.MARKER), MARKER_BYTES);
});

await check('G6: serial import → undo → import; generation = initial + 3', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);  // gen 0→1
  await runV2LockedUndo(adapter, new TestLock(), testDigest, 0);              // gen 1→2
  await runV2LockedImport(adapter, D1, new TestLock(), NOW, testDigest, 0);  // gen 2→3
  const ls = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 3, 'Generation must advance monotonically');
});

/* ════════════════════════════════════════════════════════════════════
   H — Coordinator (recoverV2Startup)
════════════════════════════════════════════════════════════════════ */
console.log('\n── H-coordinator\n');

await check('H1: no staging, clean state → stagingAction=none; v2Active=true', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.v2Active, true);
  assert.equal(r.stagingAction, 'none');
});

await check('H2: staging staged + sha256(DATA)==targetDigest → cleared-committed; staging cleared', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D1, 1);  // DATA=D1; LIVE-STATE points to D1
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 1, txState: 'staged',
    transactionId: 'tx-h2', startedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
  }));
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.v2Active, true);
  assert.equal(r.stagingAction, 'cleared-committed');
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null, 'Staging must be cleared');
});

await check('H3: staging staged + sha256(DATA)==sourceDigest → cleared-uncommitted; staging cleared', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);  // DATA=D0; LIVE-STATE points to D0
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 1, txState: 'staged',
    transactionId: 'tx-h3', startedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
  }));
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.v2Active, true);
  assert.equal(r.stagingAction, 'cleared-uncommitted');
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null);
});

await check('H4: staging staged + sha256(DATA)==neither → retained-ambiguous', async () => {
  const D_other = '{"prefs":{},"state":[],"schemaVersion":2,"extra":true}';
  const adapter = makeAdapter();
  seedClean(adapter, D_other, 0);
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 1, txState: 'staged',
    transactionId: 'tx-h4', startedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
  }));
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.stagingAction, 'retained-ambiguous');
  assert.notEqual(adapter.getItem(V2_KEYS.STAGING), null, 'Staging must be retained');
});

await check('H5: staging failed → retained-failed; staging not cleared', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D1, 1);
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 1, txState: 'failed', failCode: 'data-write-failed',
    transactionId: 'tx-h5', startedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
  }));
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.stagingAction, 'retained-failed');
  assert.notEqual(adapter.getItem(V2_KEYS.STAGING), null, 'Staging must be retained');
});

await check('H6: malformed staging (invalid JSON) → quarantined-malformed; staging cleared; recovery written', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  adapter.setItem(V2_KEYS.STAGING, 'not-json{{broken');
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.stagingAction, 'quarantined-malformed');
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null, 'Staging must be cleared after quarantine');
  // Recovery record must be present and contain bounded rawData
  const recoveryRaw = adapter.getItem(V2_KEYS.RECOVERY);
  assert.ok(recoveryRaw, 'Recovery record must be written');
  const rec = JSON.parse(recoveryRaw);
  assert.equal(rec.source, V2_KEYS.STAGING);
  assert.ok(typeof rec.rawData === 'string', 'rawData must be present');
  assert.ok(rec.rawData.length <= IMPORT_STAGING_QUARANTINE_MAX_RAW, 'rawData must be bounded');
});

await check('H7: malformed staging + quarantine write fails → retained-malformed; staging NOT cleared', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  adapter.setItem(V2_KEYS.STAGING, 'bad-json{{');
  // Make recovery key write throw
  const origSet = adapter.setItem.bind(adapter);
  adapter.setItem = (k, v) => {
    if (k === V2_KEYS.RECOVERY) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    origSet(k, v);
  };
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.stagingAction, 'retained-malformed');
  // Original staging bytes must be retained
  const remainingStaging = adapter.getItem(V2_KEYS.STAGING);
  assert.ok(remainingStaging, 'Staging must be retained when quarantine fails');
  assert.ok(remainingStaging.startsWith('bad-json'), 'Original bytes retained');
});

await check('H8: v2Active=false (no marker, malformed LIVE-STATE) → stagingAction=skipped', async () => {
  // No marker, no LIVE-STATE → mutation recovery returns v2Active=false
  const adapter = makeAdapter({ [ACTIVATION_KEYS.DATA]: D0 });
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({ txState: 'staged' }));
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  assert.equal(r.v2Active, false);
  assert.equal(r.stagingAction, 'skipped');
  // Staging must not be touched
  assert.notEqual(adapter.getItem(V2_KEYS.STAGING), null);
});

await check('H9 [Case A]: crash after DATA write; LIVE-STATE stale; journal present → Phase 1 writes LIVE-STATE directly; Phase 2 cleared-committed', async () => {
  // This test covers clarification #2: mutation recovery writes LIVE-STATE directly.
  // Setup: DATA=D1 (committed), LIVE-STATE stale (sha256(D0)), journal present (Case A)
  const adapter = makeAdapter();
  const d0hash = hexOf(D0);
  const d1hash = hexOf(D1);
  adapter.setItem(ACTIVATION_KEYS.DATA,       D1);
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, d0hash));  // stale
  adapter.setItem(ACTIVATION_KEYS.MUT_JOURNAL, makeJournal({
    generation: 1, prevDigest: d0hash, prevRaw: D0, newDigest: d1hash,
  }));
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 1, txState: 'staged',
    transactionId: 'tx-h9', startedAt: NOW, sourceDigest: d0hash, targetDigest: d1hash,
  }));
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);

  // Phase 1 must have used Case A recovery
  assert.equal(r.action, 'mutation-recovered-complete-step3', `Phase 1 action: ${r.action}`);
  assert.equal(r.v2Active, true);

  // Phase 1 writes LIVE-STATE directly (not via writeLockedMutation)
  const ls = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.digest, d1hash, 'LIVE-STATE.digest must equal sha256(D1) after Case A recovery');
  assert.equal(ls.generation, 1, 'Generation must equal journal.generation (=1) after Case A');

  // DATA must be unchanged (D1)
  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D1);
  // Journal must be cleared by Phase 1
  assert.equal(adapter.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null);

  // Phase 2: sha256(DATA=D1) == targetDigest → cleared-committed
  assert.equal(r.stagingAction, 'cleared-committed');
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null);
});

await check('H10 [Case C]: DATA corrupted; journal with prevRaw → Phase 1 writes DATA+LIVE-STATE directly; Phase 2 cleared-uncommitted', async () => {
  // Clarification #2: mutation recovery may write DATA directly in the restore case.
  const d0hash = hexOf(D0);
  const d1hash = hexOf(D1);
  const D_corrupt = 'PARTIAL_WRITE_GARBAGE_BYTES';

  const adapter = makeAdapter();
  adapter.setItem(ACTIVATION_KEYS.DATA,       D_corrupt);    // corrupted DATA
  adapter.setItem(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, d0hash));  // stale
  adapter.setItem(ACTIVATION_KEYS.MUT_JOURNAL, makeJournal({
    generation: 1, prevDigest: d0hash, prevRaw: D0, newDigest: d1hash,
  }));
  adapter.setItem(V2_KEYS.STAGING, JSON.stringify({
    txVersion: 1, txState: 'staged',
    transactionId: 'tx-h10', startedAt: NOW, sourceDigest: d0hash, targetDigest: d1hash,
  }));
  const r = await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);

  // Phase 1: Case C — DATA matches neither → restore from prevRaw
  assert.equal(r.action, 'mutation-recovered-restore-data', `Phase 1 action was: ${r.action}`);
  assert.equal(r.v2Active, true);

  // DATA must be restored to D0 (prevRaw) by Phase 1 — mutation recovery writes DATA directly
  assert.equal(adapter.getItem(ACTIVATION_KEYS.DATA), D0, 'Phase 1 must have restored DATA to D0');

  // LIVE-STATE must reflect generation = max(0, journal.generation - 1) = 0
  const ls = JSON.parse(adapter.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.digest, d0hash, 'LIVE-STATE.digest must equal sha256(D0) after Case C');
  assert.equal(ls.generation, 0, 'Generation must be max(0, 1-1)=0 after Case C');

  // Phase 2: sha256(DATA=D0) == sourceDigest → cleared-uncommitted
  assert.equal(r.stagingAction, 'cleared-uncommitted');
  assert.equal(adapter.getItem(V2_KEYS.STAGING), null);
});

await check('H11: coordinator lock throws → coordinator-lock-failed; v2Active=false', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  const r = await recoverV2Startup(adapter, throwingLock, null, NOW, testDigest, 0);
  assert.equal(r.action, 'coordinator-lock-failed');
  assert.equal(r.v2Active, false);
  assert.equal(r.stagingAction, 'skipped');
});

await check('H12: coordinator lock denied → coordinator-lock-denied; v2Active=false', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  const r = await recoverV2Startup(adapter, deniedLock, null, NOW, testDigest, 0);
  assert.equal(r.action, 'coordinator-lock-denied');
  assert.equal(r.v2Active, false);
});

await check('H13: quarantine rawData bounded to IMPORT_STAGING_QUARANTINE_MAX_RAW', async () => {
  const adapter = makeAdapter();
  seedClean(adapter, D0, 0);
  // Oversized staging
  const oversized = 'x'.repeat(IMPORT_STAGING_QUARANTINE_MAX_RAW + 1000);
  adapter.setItem(V2_KEYS.STAGING, oversized);
  await recoverV2Startup(adapter, new TestLock(), null, NOW, testDigest, 0);
  const rec = JSON.parse(adapter.getItem(V2_KEYS.RECOVERY) ?? 'null');
  assert.ok(rec, 'Recovery record must be present');
  assert.ok(
    rec.rawData.length <= IMPORT_STAGING_QUARANTINE_MAX_RAW,
    `rawData must be bounded (got ${rec.rawData.length})`,
  );
});

/* ════════════════════════════════════════════════════════════════════
   I — Static purity (no localStorage / sessionStorage)
════════════════════════════════════════════════════════════════════ */
console.log('\n── I-static-purity\n');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

await check('I1: v2-locked-import.js contains no localStorage reference', () => {
  const src = stripComments(
    readFileSync(join(root, 'data/backup/v2-locked-import.js'), 'utf8'),
  );
  assert.ok(!src.includes('localStorage'), 'Must not reference localStorage');
});

await check('I2: v2-locked-import.js contains no sessionStorage reference', () => {
  const src = stripComments(
    readFileSync(join(root, 'data/backup/v2-locked-import.js'), 'utf8'),
  );
  assert.ok(!src.includes('sessionStorage'), 'Must not reference sessionStorage');
});

/* ════════════════════════════════════════════════════════════════════
   J — Lock-timeout via injected scheduler (no real sleep)
   Mechanism: withLockTimeout wraps lock.runExclusive in a scheduler race.
   When the provider's Promise never settles, the mock scheduler's timer is
   flushed deterministically, and withLockTimeout resolves {ok:false,
   code:'lock-timeout'}.  The outer function routes that as fail-closed before
   any storage read or write — provable by opCount delta = 0.
   Approved fail-closed results:
     import / undo → { ok:false, code:'concurrency-unavailable' }
     coordinator   → { action:'coordinator-lock-denied', v2Active:false, stagingAction:'skipped' }
   Also verifies: late provider settlement and late rejection after the timeout
   has fired are swallowed without additional adapter ops or unhandled rejections.
════════════════════════════════════════════════════════════════════ */
console.log('\n── J-lock-timeout\n');

/* ── Helpers shared by section J ─────────────────────────────────── */

/**
 * Tracks every getItem, setItem, and removeItem call.
 * opCount() returns the cumulative total across all three.
 */
function makeOpTrackingAdapter(initial = {}) {
  const store = new Map(Object.entries(initial));
  let ops = 0;
  return {
    getItem:    (k)    => { ops++; return store.has(k) ? store.get(k) : null; },
    setItem:    (k, v) => { ops++; store.set(k, String(v)); },
    removeItem: (k)    => { ops++; store.delete(k); },
    _store:     store,
    opCount:    ()     => ops,
  };
}

/**
 * Deterministic mock scheduler.  Timers are captured but not fired until
 * flush() is called.  Flushing clears all pending timers before invoking
 * their callbacks, so callbacks that register new timers don't trigger
 * recursion in the same flush pass.
 */
class MockScheduler {
  constructor()        { this._pending = new Map(); this._seq = 0; }
  setTimeout(fn, _ms) { const id = ++this._seq; this._pending.set(id, fn); return id; }
  clearTimeout(id)    { this._pending.delete(id); }
  flush() {
    const fns = [...this._pending.values()];
    this._pending.clear();          // clear before firing (prevents re-entrance loops)
    for (const fn of fns) fn();
  }
  get pendingCount()  { return this._pending.size; }
}

/**
 * Lock whose runExclusive Promise NEVER settles and NEVER calls the callback.
 * Models a provider blocked on a held mutex — the queue entry exists but
 * has not been dispatched yet.  Fresh per test to avoid shared state.
 */
function makePendingLock() {
  return { runExclusive: () => new Promise(() => {}) };
}

/**
 * Lock whose settlement timing is controlled by the test.
 * settle(value)  — resolves the runExclusive Promise with value (callback never called).
 * reject(error)  — rejects the runExclusive Promise (callback never called).
 * Returns { lock, settle, reject }.
 */
function makeControllableLock() {
  let _settle, _reject;
  const lock = {
    runExclusive: () => new Promise((res, rej) => { _settle = res; _reject = rej; }),
  };
  return { lock, settle: v => _settle(v), reject: e => _reject(e) };
}

/** Drain the microtask queue without real sleeping. */
const nextTick = () => new Promise(r => process.nextTick(r));

/* ── J1: import — hanging provider; timer flushed by mock scheduler ── */

await check('J1: import — pending lock + flushed scheduler → concurrency-unavailable; timer registered before flush; zero adapter ops; MARKER and DATA unchanged', async () => {
  const sched   = new MockScheduler();
  const adapter = makeOpTrackingAdapter({
    [ACTIVATION_KEYS.MARKER]: MARKER_BYTES,
    'unrelated-key':          'sentinel',
  });
  // Seed via _store to not inflate opCount before the call
  adapter._store.set(ACTIVATION_KEYS.DATA,       D0);
  adapter._store.set(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(D0)));
  const opsBefore = adapter.opCount(); // 0 — _store writes don't count

  // Start import against a lock that will never settle on its own
  const pending = runV2LockedImport(
    adapter, D1, makePendingLock(), NOW, testDigest, /*timeoutMs=*/100, sched,
  );

  // withLockTimeout registers the deadline timer synchronously before the
  // first await — verifiable without sleeping
  assert.equal(sched.pendingCount, 1, 'One lock-timeout timer must be registered');
  assert.equal(adapter.opCount(),  opsBefore, 'No adapter ops before flush — callback not entered');

  // Flush the timer: withLockTimeout resolves {ok:false,code:'lock-timeout'}
  sched.flush();
  const r = await pending;

  // Approved fail-closed result
  assert.equal(r.ok,   false);
  assert.equal(r.code, 'concurrency-unavailable');
  assert.ok(typeof r.message === 'string' && r.message.length > 0, 'message present');

  // Zero adapter ops — callback was never entered
  assert.equal(adapter.opCount(), opsBefore, 'Zero adapter ops after timeout');

  // All keys byte-identical to initial state
  assert.equal(adapter._store.get(ACTIVATION_KEYS.MARKER), MARKER_BYTES, 'MARKER unchanged');
  assert.equal(adapter._store.get('unrelated-key'),         'sentinel',   'unrelated key unchanged');
  assert.equal(adapter._store.get(ACTIVATION_KEYS.DATA),       D0,        'DATA unchanged');
  assert.equal(adapter._store.get(ACTIVATION_KEYS.LIVE_STATE), makeLS(0, hexOf(D0)), 'LIVE-STATE unchanged');

  // Timer consumed by flush; nothing stray pending
  assert.equal(sched.pendingCount, 0, 'No stray timers after resolution');
});

/* ── J2: undo — same mechanism ───────────────────────────────────── */

await check('J2: undo — pending lock + flushed scheduler → concurrency-unavailable; zero adapter ops; snapshot and MARKER unchanged', async () => {
  const sched   = new MockScheduler();
  const snap    = {
    transactionId: 'tx-j2', savedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
    keys: { [ACTIVATION_KEYS.DATA]: D0 },
  };
  const adapter = makeOpTrackingAdapter({
    [ACTIVATION_KEYS.MARKER]: MARKER_BYTES,
    'unrelated-key':          'sentinel',
  });
  adapter._store.set(ACTIVATION_KEYS.DATA,       D1);
  adapter._store.set(ACTIVATION_KEYS.LIVE_STATE, makeLS(1, hexOf(D1)));
  adapter._store.set(V2_KEYS.BACKUP,             JSON.stringify({ snapshot: snap }));
  const opsBefore = adapter.opCount();

  const pending = runV2LockedUndo(
    adapter, makePendingLock(), testDigest, /*timeoutMs=*/100, sched,
  );

  assert.equal(sched.pendingCount, 1, 'One lock-timeout timer registered');
  assert.equal(adapter.opCount(),  opsBefore, 'No adapter ops before flush');

  sched.flush();
  const r = await pending;

  assert.equal(r.ok,   false);
  assert.equal(r.code, 'concurrency-unavailable');

  assert.equal(adapter.opCount(), opsBefore, 'Zero adapter ops — callback never entered');

  assert.equal(adapter._store.get(ACTIVATION_KEYS.MARKER), MARKER_BYTES, 'MARKER unchanged');
  assert.equal(adapter._store.get('unrelated-key'),         'sentinel',   'unrelated key unchanged');
  assert.equal(adapter._store.get(ACTIVATION_KEYS.DATA), D1, 'DATA unchanged');

  // Snapshot untouched (no partial clear)
  const backup = JSON.parse(adapter._store.get(V2_KEYS.BACKUP));
  assert.equal(backup.snapshot?.transactionId, 'tx-j2', 'snapshot byte-identical');

  assert.equal(sched.pendingCount, 0);
});

/* ── J3: coordinator — same mechanism ────────────────────────────── */

await check('J3: coordinator — pending lock + flushed scheduler → coordinator-lock-denied; zero adapter ops; staging and MARKER unchanged', async () => {
  const sched   = new MockScheduler();
  const adapter = makeOpTrackingAdapter({
    [ACTIVATION_KEYS.MARKER]: MARKER_BYTES,
    'unrelated-key':          'sentinel',
  });
  adapter._store.set(ACTIVATION_KEYS.DATA,       D0);
  adapter._store.set(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(D0)));
  adapter._store.set(V2_KEYS.STAGING,            JSON.stringify({
    txVersion: 1, txState: 'staged',
    transactionId: 'tx-j3', startedAt: NOW,
    sourceDigest: hexOf(D0), targetDigest: hexOf(D1),
  }));
  const opsBefore = adapter.opCount();

  const pending = recoverV2Startup(
    adapter, makePendingLock(), null, NOW, testDigest, /*timeoutMs=*/100, sched,
  );

  assert.equal(sched.pendingCount, 1, 'One lock-timeout timer registered');
  assert.equal(adapter.opCount(),  opsBefore, 'No adapter ops before flush');

  sched.flush();
  const r = await pending;

  // Approved fail-closed result for coordinator
  assert.equal(r.action,       'coordinator-lock-denied');
  assert.equal(r.v2Active,     false);
  assert.equal(r.stagingAction,'skipped');

  assert.equal(adapter.opCount(), opsBefore, 'Zero adapter ops — callback never entered');

  assert.equal(adapter._store.get(ACTIVATION_KEYS.MARKER), MARKER_BYTES, 'MARKER unchanged');
  assert.equal(adapter._store.get('unrelated-key'),         'sentinel',   'unrelated key unchanged');
  assert.equal(adapter._store.get(ACTIVATION_KEYS.DATA), D0, 'DATA unchanged');

  // Staging bytes intact
  const stagingRaw = adapter._store.get(V2_KEYS.STAGING);
  assert.ok(stagingRaw, 'Staging must still be present');
  assert.equal(JSON.parse(stagingRaw).transactionId, 'tx-j3', 'Staging byte-identical');

  assert.equal(sched.pendingCount, 0);
});

/* ── J4: late provider settlement after timeout — swallowed ──────── */

await check('J4: late lock settlement after timeout is swallowed — no additional adapter ops, no unhandled rejection', async () => {
  const sched = new MockScheduler();
  const { lock, settle } = makeControllableLock();
  const adapter = makeOpTrackingAdapter({});
  adapter._store.set(ACTIVATION_KEYS.DATA,       D0);
  adapter._store.set(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(D0)));
  const opsBefore = adapter.opCount();

  const pending = runV2LockedImport(
    adapter, D1, lock, NOW, testDigest, /*timeoutMs=*/100, sched,
  );

  sched.flush();                  // fires timeout → withLockTimeout resolves lock-timeout
  const r = await pending;       // outer function returns concurrency-unavailable

  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  const opsAfterTimeout = adapter.opCount();
  assert.equal(opsAfterTimeout, opsBefore, 'Zero ops after timeout');

  // Now the provider finally settles (late) — callback was never called
  // The outer Promise is already settled; this settlement must be silently discarded
  settle({ ok: true, result: { ok: true, message: 'late-ok' } });

  // Drain microtasks — ensure no late writes or unhandled rejections surface
  await nextTick();
  await nextTick();

  assert.equal(adapter.opCount(), opsAfterTimeout,
    'Late provider settlement must not produce additional adapter ops');
});

/* ── J5: late provider rejection after timeout — swallowed ──────── */

await check('J5: late lock rejection after timeout is swallowed — no additional adapter ops, no unhandled rejection', async () => {
  const sched = new MockScheduler();
  const { lock, reject: rejectLock } = makeControllableLock();
  const adapter = makeOpTrackingAdapter({});
  adapter._store.set(ACTIVATION_KEYS.DATA,       D0);
  adapter._store.set(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(D0)));
  const opsBefore = adapter.opCount();

  const pending = runV2LockedImport(
    adapter, D1, lock, NOW, testDigest, /*timeoutMs=*/100, sched,
  );

  sched.flush();
  const r = await pending;

  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  const opsAfterTimeout = adapter.opCount();
  assert.equal(opsAfterTimeout, opsBefore, 'Zero ops after timeout');

  // Provider rejects late — the silent .catch(() => {}) on lockPromise
  // handles this before Node.js can fire an unhandledRejection event,
  // and the inner Promise's reject() call is a no-op (outer already resolved).
  rejectLock(new Error('provider-late-rejection'));

  await nextTick();
  await nextTick();

  assert.equal(adapter.opCount(), opsAfterTimeout,
    'Late provider rejection must not produce additional adapter ops');
  // If an unhandled rejection had fired, Node would print to stderr and the
  // process would exit non-zero — both detectable in CI without explicit
  // process.on('unhandledRejection') instrumentation.
});

/* ── J6: FIFO-queuing lock + deferred barrier — guarded callback exits without writes ── */

await check('J6: guarded callback — timed-out import queued behind FIFO holder exits without storage writes; DATA stays at legitimate winner only', async () => {
  const sched   = new MockScheduler();
  const lock    = new TestLock();
  const adapter = makeOpTrackingAdapter({});
  // Seed via _store so opCount starts at zero (bypasses the tracking wrappers)
  adapter._store.set(ACTIVATION_KEYS.DATA,       D0);
  adapter._store.set(ACTIVATION_KEYS.LIVE_STATE, makeLS(0, hexOf(D0)));
  adapter._store.set(ACTIVATION_KEYS.MARKER,     MARKER_BYTES);

  // Phase 1 — seize the lock with a deferred-barrier holder; no storage ops
  let _release;
  const gate    = new Promise(r => { _release = r; });
  const holderP = lock.runExclusive('holder', async () => { await gate; });

  // Phase 2 — queue the timed-out import behind the holder
  // (withLockTimeout enqueues guardedCallback immediately; it cannot run yet)
  const timedOutP = runV2LockedImport(
    adapter, D1, lock, NOW, testDigest, /*timeoutMs=*/100, sched,
  );

  // Flush the mock scheduler: withLockTimeout resolves lock-timeout right now,
  // before the holder has released the gate
  sched.flush();
  const rTimeout = await timedOutP;

  assert.equal(rTimeout.ok,   false,                     'timed-out call must fail');
  assert.equal(rTimeout.code, 'concurrency-unavailable', 'code must be concurrency-unavailable');
  const opsAtTimeout = adapter.opCount();
  assert.equal(opsAtTimeout, 0, 'zero adapter ops before gate release');

  // Phase 3 — release the gate; FIFO queue advances to the guarded callback
  _release();
  await holderP;

  // Drain the microtask queue so the guarded callback has a full opportunity
  // to run (and fail the test if it wrongly invokes the real mutation body)
  await nextTick();
  await nextTick();
  await nextTick();

  // Guarded callback must have returned without touching any storage key
  assert.equal(adapter.opCount(), opsAtTimeout,
    'guarded callback must perform zero storage ops after timeout fires');
  assert.equal(adapter._store.get(ACTIVATION_KEYS.DATA), D0,
    'DATA must remain D0 — no ghost commit from timed-out import');
  assert.equal(adapter._store.get(ACTIVATION_KEYS.LIVE_STATE), makeLS(0, hexOf(D0)),
    'LIVE-STATE must stay at generation 0 — no ghost advance');
  assert.equal(sched.pendingCount, 0, 'no stray timers');
});

/* ── Results ─────────────────────────────────────────────────────── */
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  ✗  ${f.label}\n     ${f.error}`);
  process.exit(1);
}
