/**
 * v2-tx.test.mjs — CP3 suite 2: transaction state machine, startup
 * recovery, failure-injection matrix, rollback-failure policy, and
 * recovery-data preservation boundaries.
 *
 * Every test runs against an isolated in-memory adapter with deterministic
 * failure injection. No real storage, no clock (NOW is injected).
 * Run with:  node artifacts/home-tasks/tests/v2-tx.test.mjs
 */

import assert from 'node:assert/strict';
import { createMemoryAdapter, createFailingAdapter } from '../src/v2/storage-adapter.js';
import {
  runImportTransaction, recoverStartup, preserveRecovery,
  saveSnapshot, getSnapshot, applySnapshot, clearSnapshot,
  V2_KEYS, IMPORT_KEYS, TX_VERSION, RECOVERY_MAX_RAW,
} from '../src/v2/import-tx.js';

const NOW = '2026-08-01T00:00:00.000Z';
const LATER = '2026-08-02T00:00:00.000Z';
const OLD_DATA = JSON.stringify({ schemaVersion: 2, marker: 'OLD' });
const NEW_DATA = JSON.stringify({ schemaVersion: 2, marker: 'NEW' });
const UNRELATED = Object.freeze({
  'some-other-app-key': 'untouchable',
  'hometask-recovery-v2': JSON.stringify({ downloaded: true, dismissed: true, rawData: 'evidence' }),
});

let group = '', pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); }
}
function section(name) { group = name; console.log(`\n── ${name}`); }

function freshStore(withOld = true) {
  return createMemoryAdapter({ ...UNRELATED, ...(withOld ? { [V2_KEYS.DATA]: OLD_DATA } : {}) });
}
function assertUnrelatedUntouched(adapter) {
  for (const [k, v] of Object.entries(UNRELATED)) {
    assert.equal(adapter.getItem(k), v, `unrelated key ${k} changed`);
  }
}
function assertLiveIs(adapter, expected) {
  assert.equal(adapter.getItem(V2_KEYS.DATA), expected);
}

/* ════ 1 · Happy path ════ */
section('happy-path');
check('full transaction: staged → committing → committed → cleaned', () => {
  const a = freshStore();
  const r = runImportTransaction(a, NEW_DATA, NOW);
  assert.equal(r.ok, true);
  assertLiveIs(a, NEW_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null, 'staging removed after verification');
  const snap = getSnapshot(a);
  assert.ok(snap, 'snapshot retained for manual undo');
  assert.equal(snap.keys[V2_KEYS.DATA], OLD_DATA, 'snapshot is byte-exact pre-import state');
  assertUnrelatedUntouched(a);
});
check('import into empty store: snapshot records absence as null; undo removes key', () => {
  const a = freshStore(false);
  const r = runImportTransaction(a, NEW_DATA, NOW);
  assert.equal(r.ok, true);
  const snap = getSnapshot(a);
  assert.equal(snap.keys[V2_KEYS.DATA], null);
  const rb = applySnapshot(a, snap);
  assert.equal(rb.ok, true);
  assert.equal(a.getItem(V2_KEYS.DATA), null, 'undo removed the key rather than writing "null"');
});
check('snapshot save+verify round-trip; clearSnapshot removes only the snapshot', () => {
  const a = freshStore();
  a.setItem(V2_KEYS.BACKUP, JSON.stringify({ lastExport: '2026-07-20' }));
  assert.equal(saveSnapshot(a, NOW).ok, true);
  assert.ok(getSnapshot(a));
  clearSnapshot(a);
  assert.equal(getSnapshot(a), null);
  assert.equal(JSON.parse(a.getItem(V2_KEYS.BACKUP)).lastExport, '2026-07-20', 'sibling fields preserved');
});
check('invalid input refused before any storage effect', () => {
  const a = freshStore();
  const before = JSON.stringify(a.snapshotAll());
  assert.equal(runImportTransaction(a, '', NOW).ok, false);
  assert.equal(JSON.stringify(a.snapshotAll()), before);
});

/* ════ 2 · Failure-injection matrix ════
   For each injected failure: expected recovery state, live-data
   byte-identity, rollback outcome, snapshot/staging retention, app
   continuity, calm diagnostic, unrelated-key integrity. ════ */
section('failure-matrix');

function run(rules, { store = freshStore() } = {}) {
  const a = createFailingAdapter(store, rules);
  const result = runImportTransaction(a, NEW_DATA, NOW);
  return { a: store, result };   // inspect via un-failing base adapter
}
const calm = r => { assert.equal(typeof r.message, 'string'); assert.ok(!/undefined|NaN|\[object/.test(r.message)); };

check('snapshot read failure → nothing changed', () => {
  const { a, result } = run([{ op: 'get', key: V2_KEYS.DATA }]);
  assert.equal(result.code, 'snapshot-failed');
  assertLiveIs(a, OLD_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertUnrelatedUntouched(a); calm(result);
});
check('snapshot write failure → nothing changed', () => {
  const { a, result } = run([{ op: 'set', key: V2_KEYS.BACKUP }]);
  assert.equal(result.code, 'snapshot-failed');
  assertLiveIs(a, OLD_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertUnrelatedUntouched(a); calm(result);
});
check('snapshot verification failure (write silently lost) → nothing changed', () => {
  const { a, result } = run([{ op: 'set', key: V2_KEYS.BACKUP, mode: 'noop' }]);
  assert.equal(result.code, 'snapshot-failed');
  assert.match(result.message, /has not been changed/);
  assertLiveIs(a, OLD_DATA); assertUnrelatedUntouched(a); calm(result);
});
check('staging write failure → nothing changed, snapshot saved but harmless', () => {
  const { a, result } = run([{ op: 'set', key: V2_KEYS.STAGING }]);
  assert.equal(result.code, 'staging-failed');
  assertLiveIs(a, OLD_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertUnrelatedUntouched(a); calm(result);
});
check('staging verification failure (readback null) → staging cleared, nothing changed', () => {
  const { a, result } = run([{ op: 'get', key: V2_KEYS.STAGING, mode: 'null' }]);
  assert.equal(result.code, 'staging-verify-failed');
  assertLiveIs(a, OLD_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertUnrelatedUntouched(a); calm(result);
});
check('quota exhaustion before commit (staging write throws quota) → nothing changed', () => {
  const { a, result } = run([{ op: 'set', key: V2_KEYS.STAGING, mode: 'throw' }]);
  assert.equal(result.code, 'staging-failed');
  assertLiveIs(a, OLD_DATA); assertUnrelatedUntouched(a); calm(result);
});
check('first live-key write failure → rolled back byte-identically, snapshot retained', () => {
  const { a, result } = run([{ op: 'set', key: V2_KEYS.DATA, times: 1 }]);   // commit write fails once; rollback write succeeds
  assert.equal(result.code, 'rolled-back');
  assertLiveIs(a, OLD_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null, 'staging cleared after verified rollback');
  assert.ok(getSnapshot(a), 'snapshot retained for manual undo');
  assertUnrelatedUntouched(a); calm(result);
});
check('every later live-key write position also rolls back (single-key set: verified via commit-verify)', () => {
  // IMPORT_KEYS has one key in v2; the "later position" equivalent is the
  // write succeeding but verification failing (silent loss mid-commit).
  assert.equal(IMPORT_KEYS.length, 1);
  const { a, result } = run([{ op: 'set', key: V2_KEYS.DATA, mode: 'noop' }]);
  assert.equal(result.code, 'rolled-back');
  assertLiveIs(a, OLD_DATA); assert.ok(getSnapshot(a)); assertUnrelatedUntouched(a); calm(result);
});
check('commit verification mismatch (readback null) → rolled back', () => {
  const { a, result } = run([{ op: 'get', key: V2_KEYS.DATA, afterCalls: 1, mode: 'null', times: 1 }]);
  assert.equal(result.code, 'rolled-back');
  assertLiveIs(a, OLD_DATA); assertUnrelatedUntouched(a); calm(result);
});
check('transaction-progress update failure does not corrupt the commit', () => {
  // keysWritten patch fails (staging set fails AFTER the initial staged
  // write and the committing patch): commit itself still completes.
  const { a, result } = run([{ op: 'set', key: V2_KEYS.STAGING, afterCalls: 2 }]);
  assert.equal(result.ok, true);
  assertLiveIs(a, NEW_DATA);
  // cleanup uses removeItem, unaffected — staging must be gone
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertUnrelatedUntouched(a);
});
check('rollback write failure → rollback_failed, snapshot + staging evidence retained', () => {
  const { a, result } = run([
    { op: 'set', key: V2_KEYS.DATA },            // every data write fails: commit AND rollback
  ]);
  assert.equal(result.code, 'rollback-failed');
  assert.ok(result.diagnostic && typeof result.diagnostic.rollbackError === 'string', 'structured diagnostic');
  const st = JSON.parse(a.getItem(V2_KEYS.STAGING));
  assert.equal(st.txState, 'rollback_failed');
  assert.equal(st.txVersion, TX_VERSION);
  assert.ok(getSnapshot(a), 'snapshot preserved');
  assert.ok(st.data[V2_KEYS.DATA], 'staging evidence preserved');
  assert.match(result.message, /could not be fully restored/);   // never claims success
  assertUnrelatedUntouched(a); calm(result);
});
check('rollback verification failure (readback never matches) → rollback_failed', () => {
  // get#0 = snapshot read (real); get#1 = commit verify (null → mismatch →
  // rollback); get#2 = rollback verify (null → verify-mismatch → failed).
  const { a, result } = run([
    { op: 'get', key: V2_KEYS.DATA, afterCalls: 1, mode: 'null' },
  ]);
  assert.equal(result.code, 'rollback-failed');
  assert.equal(JSON.parse(a.getItem(V2_KEYS.STAGING)).txState, 'rollback_failed');
  assert.ok(getSnapshot(a)); assertUnrelatedUntouched(a); calm(result);
});
check('staging cleanup failure after committed → data live, startup finishes cleanup', () => {
  const { a, result } = run([{ op: 'remove', key: V2_KEYS.STAGING }]);
  assert.equal(result.ok, true, 'cleanup failure must not fail the import');
  assertLiveIs(a, NEW_DATA);
  assert.equal(JSON.parse(a.getItem(V2_KEYS.STAGING)).txState, 'committed');
  const rec = recoverStartup(a, LATER);
  assert.equal(rec.action, 'cleaned-committed');
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertLiveIs(a, NEW_DATA); assertUnrelatedUntouched(a);
});
check('committed marker fails but cleanup succeeds → success, no leftover staging', () => {
  // set calls on STAGING: #0 staged save, #1 committing patch, #2 progress
  // patch, #3 committed patch (fails); removeItem cleanup still works.
  const { a, result } = run([{ op: 'set', key: V2_KEYS.STAGING, afterCalls: 3 }]);
  assert.equal(result.ok, true);
  assertLiveIs(a, NEW_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null, 'no committing evidence left behind');
  assertUnrelatedUntouched(a);
});
check('committed marker AND cleanup both fail → deliberate rollback, startup cannot revert a "success"', () => {
  // If staging would verifiably remain 'committing', success must NOT be
  // claimed — the transaction rolls back instead, so a later startup
  // cannot silently undo an import the user was told succeeded.
  const { a, result } = run([
    { op: 'set', key: V2_KEYS.STAGING, afterCalls: 3 },   // committed patch fails (and later staging writes)
    { op: 'remove', key: V2_KEYS.STAGING },                // cleanup fails too
  ]);
  assert.equal(result.ok, false, 'must not claim success with committing evidence left');
  assert.equal(result.code, 'rolled-back');
  assertLiveIs(a, OLD_DATA, 'live data returned to pre-import state');
  assert.ok(getSnapshot(a), 'snapshot retained');
  // Startup afterwards must be a no-op or safe: whatever staging remains
  // resolves WITHOUT changing live data away from the rolled-back state.
  recoverStartup(a, LATER);
  assertLiveIs(a, OLD_DATA);
  assertUnrelatedUntouched(a); calm(result);
});
check('storage throwing on read/write/remove never propagates as an exception', () => {
  for (const op of ['get', 'set', 'remove']) {
    const store = freshStore();
    const a = createFailingAdapter(store, [{ op }]);   // fail EVERY call of that op
    let result;
    assert.doesNotThrow(() => { result = runImportTransaction(a, NEW_DATA, NOW); });
    calm(result);
    if (op === 'remove') {
      // removeItem is only used for staging cleanup — a cleanup failure
      // must NOT fail the import; startup recovery finishes it later.
      assert.equal(result.ok, true);
      assert.equal(JSON.parse(store.getItem(V2_KEYS.STAGING)).txState, 'committed');
    } else {
      assert.equal(result.ok, false);
    }
    assertUnrelatedUntouched(store);
  }
});
check('new import is blocked while rollback_failed evidence exists (evidence never overwritten)', () => {
  const { a } = run([{ op: 'set', key: V2_KEYS.DATA }]);
  const evidence = a.getItem(V2_KEYS.STAGING);
  const r2 = runImportTransaction(a, JSON.stringify({ marker: 'THIRD' }), LATER);
  assert.equal(r2.code, 'blocked-rollback-failed');
  assert.equal(a.getItem(V2_KEYS.STAGING), evidence, 'evidence byte-identical');
  calm(r2);
});

/* ════ 3 · Startup recovery states ════ */
section('startup-recovery');
function stagedRecord(txState, extra = {}) {
  return JSON.stringify({
    txVersion: TX_VERSION, txState, startedAt: NOW, committedAt: null,
    keysToWrite: [...IMPORT_KEYS], keysWritten: [],
    data: { [V2_KEYS.DATA]: NEW_DATA }, ...extra,
  });
}
function storeWithSnapshotAndStaging(txState, extra = {}, live = NEW_DATA) {
  const a = freshStore();
  saveSnapshot(a, NOW);                       // snapshot of OLD_DATA
  if (live !== undefined) a.setItem(V2_KEYS.DATA, live);
  a.setItem(V2_KEYS.STAGING, stagedRecord(txState, extra));
  return a;
}
check('no staging → action none, store untouched', () => {
  const a = freshStore();
  const before = JSON.stringify(a.snapshotAll());
  assert.deepEqual(recoverStartup(a, LATER), { action: 'none' });
  assert.equal(JSON.stringify(a.snapshotAll()), before);
});
check('interrupted at staged (no keys written) → rolled back to snapshot', () => {
  const a = storeWithSnapshotAndStaging('staged', {}, OLD_DATA);
  const r = recoverStartup(a, LATER);
  assert.equal(r.action, 'rolled-back');
  assertLiveIs(a, OLD_DATA);
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertUnrelatedUntouched(a);
});
check('interrupted committing with NO keys written → rolled back', () => {
  const a = storeWithSnapshotAndStaging('committing', { keysWritten: [] }, OLD_DATA);
  const r = recoverStartup(a, LATER);
  assert.equal(r.action, 'rolled-back');
  assertLiveIs(a, OLD_DATA);
});
check('interrupted committing with SOME/ALL keys written but unmarked → rolled back', () => {
  const a = storeWithSnapshotAndStaging('committing', { keysWritten: [...IMPORT_KEYS] }, NEW_DATA);
  const r = recoverStartup(a, LATER);
  assert.equal(r.action, 'rolled-back');
  assertLiveIs(a, OLD_DATA, 'unproven commit must be reverted');
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
});
check('leftover committed transaction → cleanup only, live data kept', () => {
  const a = storeWithSnapshotAndStaging('committed', { committedAt: NOW }, NEW_DATA);
  const r = recoverStartup(a, LATER);
  assert.equal(r.action, 'cleaned-committed');
  assertLiveIs(a, NEW_DATA);
});
check('malformed transaction state → removed without touching live data', () => {
  const a = freshStore();
  a.setItem(V2_KEYS.STAGING, '{broken json');
  assert.equal(recoverStartup(a, LATER).action, 'removed-malformed');
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertLiveIs(a, OLD_DATA);
  const b = freshStore();
  b.setItem(V2_KEYS.STAGING, JSON.stringify({ noTxState: true }));
  assert.equal(recoverStartup(b, LATER).action, 'removed-malformed');
});
check('unsupported (future) transaction version → left untouched, not interpreted', () => {
  const a = storeWithSnapshotAndStaging('committing', { txVersion: TX_VERSION + 1 }, NEW_DATA);
  const before = a.getItem(V2_KEYS.STAGING);
  const r = recoverStartup(a, LATER);
  assert.equal(r.action, 'quarantined-unsupported');
  assert.equal(a.getItem(V2_KEYS.STAGING), before, 'record preserved byte-identically');
  assertLiveIs(a, NEW_DATA, 'live data not touched');
});
check('staged with no snapshot → staging discarded safely (no live writes happened)', () => {
  const a = freshStore();
  a.setItem(V2_KEYS.STAGING, stagedRecord('staged'));
  const r = recoverStartup(a, LATER);
  assert.equal(r.action, 'rolled-back');
  assert.equal(a.getItem(V2_KEYS.STAGING), null);
  assertLiveIs(a, OLD_DATA);
});
check('committing with no snapshot → marked rollback_failed, evidence retained', () => {
  const a = freshStore();
  a.setItem(V2_KEYS.STAGING, stagedRecord('committing'));
  const r = recoverStartup(a, LATER);
  assert.equal(r.action, 'rollback-retry-failed');
  const st = JSON.parse(a.getItem(V2_KEYS.STAGING));
  assert.equal(st.txState, 'rollback_failed');
  assert.ok(st.data[V2_KEYS.DATA], 'intent evidence retained');
});

/* ════ 4 · rollback_failed across repeated startups ════ */
section('rollback-failed-startups');
check('repeated startups: idempotent retries, evidence never overwritten', () => {
  // Produce a genuine rollback_failed via injection.
  const store = freshStore();
  const failing = createFailingAdapter(store, [{ op: 'set', key: V2_KEYS.DATA }]);
  assert.equal(runImportTransaction(failing, NEW_DATA, NOW).code, 'rollback-failed');
  const first = JSON.parse(store.getItem(V2_KEYS.STAGING));
  assert.equal(first.txState, 'rollback_failed');

  // Startup 1: rollback still failing (same injected fault persists).
  const stillFailing = createFailingAdapter(store, [{ op: 'set', key: V2_KEYS.DATA }]);
  assert.equal(recoverStartup(stillFailing, LATER).action, 'rollback-retry-failed');
  const afterRetry = JSON.parse(store.getItem(V2_KEYS.STAGING));
  assert.equal(afterRetry.rollbackError, first.rollbackError, 'original evidence preserved');
  assert.equal(afterRetry.failedAt, first.failedAt, 'first-failure timestamp preserved');
  assert.equal(afterRetry.lastRetryAt, LATER, 'only retry timestamp advances');

  // Startup 2: identical retry — byte-identical except lastRetryAt (idempotent).
  const LATER2 = '2026-08-03T00:00:00.000Z';
  assert.equal(recoverStartup(createFailingAdapter(store, [{ op: 'set', key: V2_KEYS.DATA }]), LATER2).action, 'rollback-retry-failed');
  const afterRetry2 = JSON.parse(store.getItem(V2_KEYS.STAGING));
  assert.deepEqual({ ...afterRetry2, lastRetryAt: null }, { ...afterRetry, lastRetryAt: null });

  // Startup 3: fault healed → rollback finally succeeds, evidence cleared.
  assert.equal(recoverStartup(store, '2026-08-04T00:00:00.000Z').action, 'rolled-back');
  assert.equal(store.getItem(V2_KEYS.DATA), OLD_DATA);
  assert.equal(store.getItem(V2_KEYS.STAGING), null);
  assert.ok(getSnapshot(store), 'snapshot still available for the user');
  assertUnrelatedUntouched(store);
});

/* ════ 5 · Recovery-data preservation boundaries ════ */
section('recovery-preservation');
check('damaged data preserved with cap + truncation metadata', () => {
  const a = createMemoryAdapter();
  const big = 'x'.repeat(RECOVERY_MAX_RAW + 500);
  const r = preserveRecovery(a, V2_KEYS.DATA, big, NOW);
  assert.deepEqual(r, { saved: true, preservationFailed: false });
  const rec = JSON.parse(a.getItem(V2_KEYS.RECOVERY));
  assert.equal(rec.truncated, true);
  assert.equal(rec.originalLength, RECOVERY_MAX_RAW + 500);
  assert.equal(rec.storedLength, RECOVERY_MAX_RAW);
  assert.equal(rec.rawData.length, RECOVERY_MAX_RAW);
});
check('existing un-downloaded record is never silently overwritten', () => {
  const a = createMemoryAdapter();
  preserveRecovery(a, V2_KEYS.DATA, 'first-evidence', NOW);
  const before = a.getItem(V2_KEYS.RECOVERY);
  const r = preserveRecovery(a, V2_KEYS.DATA, 'second-evidence', LATER);
  assert.deepEqual(r, { saved: false, preservationFailed: 'existing-undownloaded' });
  assert.equal(a.getItem(V2_KEYS.RECOVERY), before, 'byte-identical');
});
check('downloaded or dismissed record may be replaced', () => {
  const a = createMemoryAdapter();
  preserveRecovery(a, V2_KEYS.DATA, 'first', NOW);
  const rec = JSON.parse(a.getItem(V2_KEYS.RECOVERY));
  a.setItem(V2_KEYS.RECOVERY, JSON.stringify({ ...rec, downloaded: true }));
  const r = preserveRecovery(a, V2_KEYS.DATA, 'second', LATER);
  assert.equal(r.saved, true);
  assert.equal(JSON.parse(a.getItem(V2_KEYS.RECOVERY)).rawData, 'second');
});
check('storage-full: failure metadata stored without rawData', () => {
  const base = createMemoryAdapter();
  const a = createFailingAdapter(base, [{ op: 'set', key: V2_KEYS.RECOVERY, times: 1 }]);
  const r = preserveRecovery(a, V2_KEYS.DATA, 'evidence', NOW);
  assert.deepEqual(r, { saved: false, preservationFailed: 'quota-exceeded' });
  const rec = JSON.parse(base.getItem(V2_KEYS.RECOVERY));
  assert.equal(rec.rawData, null);
  assert.equal(rec.preservationFailed, 'quota-exceeded');
  assert.equal(rec.storedLength, 0);
});
check('preserveRecovery never throws on null/undefined raw input', () => {
  const a = createMemoryAdapter();
  for (const bad of [null, undefined, 42]) {
    let r;
    assert.doesNotThrow(() => { r = preserveRecovery(a, V2_KEYS.DATA, bad, NOW); });
    assert.equal(r.saved, true);
    const rec = JSON.parse(a.getItem(V2_KEYS.RECOVERY));
    assert.equal(rec.originalLength, 0);
    assert.equal(rec.rawData, '');
    a.removeItem(V2_KEYS.RECOVERY);
  }
});
check('recovery preservation failure is total (both writes fail) → calm result, no throw', () => {
  const base = createMemoryAdapter();
  const a = createFailingAdapter(base, [{ op: 'set', key: V2_KEYS.RECOVERY }]);
  let r;
  assert.doesNotThrow(() => { r = preserveRecovery(a, V2_KEYS.DATA, 'evidence', NOW); });
  assert.equal(r.saved, false);
  assert.equal(base.getItem(V2_KEYS.RECOVERY), null);
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
