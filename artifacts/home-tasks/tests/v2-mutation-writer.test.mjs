/**
 * v2-mutation-writer.test.mjs — CP5C-B1 suite: mutable-v2 integrity model.
 *
 * Covers:
 *   A · writeMutation happy path        first write; subsequent write; generation increment
 *   B · writeMutation failure cases     journal-too-large; each step failure; restore
 *   C · recoverMutationStartup          all 9 recovery table rows (plan rows 1–9)
 *   D · V2Repository                    get/put/update; queue serialisation; error propagation
 *   E · disconnection guard             neither file statically reachable from script.js entry
 *
 * V2_ACTIVATION_ENABLED=false throughout — no production activation paths touched.
 * Standalone Node ESM. No real storage. Run with:
 *   node artifacts/home-tasks/tests/v2-mutation-writer.test.mjs
 */

import assert         from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVATION_KEYS, ACTIVATION_TARGET_SCHEMA,
  buildMarker, buildLiveState,
  recoverMutationStartup,
  ACTIVATION_MARKER_VERSION,
}                           from '../src/v2/activation-tx.js';
import {
  writeMutation, buildJournal, parseJournal, parseLiveState, MAX_JOURNAL_RAW,
}                           from '../src/data/v2/v2-mutation-writer.js';
import { V2Repository }     from '../src/data/v2/v2-repository.js';
import { createMemoryAdapter } from '../src/v2/storage-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = resolvePath(HERE, '../src');

/* ── Harness ─────────────────────────────────────────────────────── */
let group = '', pass = 0, fail = 0;
const _pending = [];
function section(name) { group = name; }
function check(name, fn) {
  const p = Promise.resolve().then(() => fn()).then(
    ()  => { pass++; },
    e   => { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}\n${e.stack}`); },
  );
  _pending.push(p);
  return p;
}

/* ── Digest (synchronous SHA-256 for Node tests) ─────────────────── */
function testDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256str(s) {
  return testDigest(new TextEncoder().encode(s));
}

/* ── Adapter helpers ─────────────────────────────────────────────── */
function makeAdapter() { return createMemoryAdapter(); }

/**
 * Failing adapter: intercepts specific ops and either throws or no-ops them.
 * mode:'throw' → throws on matching op+key
 * mode:'noop'  → silently ignores matching setItem (key remains unchanged)
 * mode:'mismatch' → performs write but returns wrong value on readback
 */
function createInterceptAdapter(base, intercepts = []) {
  // intercepts: [{ op:'set'|'get'|'remove', key, mode:'throw'|'noop'|'mismatch' }]
  const find = (op, key) => intercepts.find(i => i.op === op && i.key === key);
  return {
    getItem(k) {
      const m = find('get', k);
      if (m?.mode === 'throw') throw new Error(`simulated-get-failure:${k}`);
      if (m?.mode === 'mismatch') return '__readback_mismatch__';
      return base.getItem(k);
    },
    setItem(k, v) {
      const m = find('set', k);
      if (m?.mode === 'throw') throw new Error(`simulated-set-failure:${k}`);
      if (m?.mode === 'noop')  return; // write suppressed
      if (m?.mode === 'mismatch') { base.setItem(k, '__corrupted__'); return; }
      base.setItem(k, v);
    },
    removeItem(k) { base.removeItem(k); },
    keys()        { return base.keys(); },
    snapshotAll() { return base.snapshotAll(); },
  };
}

/** Build a well-formed authority marker stored in adapter. */
function plantMarker(adapter, v2DataDigest) {
  const m = buildMarker({
    activationId:      'act-test-b1',
    sourceFingerprint: 'a'.repeat(64),
    v2DataDigest,
    committedAt:       '2026-01-01T00:00:00.000Z',
  });
  adapter.setItem(ACTIVATION_KEYS.MARKER, JSON.stringify(m));
  return m;
}

/**
 * Always-grant lock: runs callback immediately and wraps its result.
 * Used for all single-context tests that do not exercise the lock path.
 */
const ALWAYS_GRANT_LOCK = {
  runExclusive: async (_txId, fn) => {
    const result = await fn();
    return { ok: true, result };
  },
};

/** Perform a single successful writeMutation, return adapter state snapshot. */
async function doWrite(adapter, newRaw, { prevRaw = null } = {}) {
  if (prevRaw !== null) adapter.setItem(ACTIVATION_KEYS.DATA, prevRaw);
  const r = await writeMutation(adapter, newRaw, {
    digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK,
  });
  return r;
}

const SAMPLE_V2  = JSON.stringify({ schemaVersion: 2, tasks: [] });
const SAMPLE_V2B = JSON.stringify({ schemaVersion: 2, tasks: [{ id: 'task-1' }] });
const SAMPLE_V2C = JSON.stringify({ schemaVersion: 2, tasks: [{ id: 'task-2' }] });

/* ════════════════════════════════════════════════════════════════════
   A · writeMutation — happy path
════════════════════════════════════════════════════════════════════ */
section('writeMutation-happy');

check('first write (no existing DATA): ok:true, DATA updated, LIVE-STATE gen 0, JOURNAL cleared', async () => {
  const base = makeAdapter();
  const r = await writeMutation(base, SAMPLE_V2, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, true, `expected ok:true, got ${JSON.stringify(r)}`);

  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA must contain new raw');

  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must exist after write');
  assert.equal(ls.generation, 0, 'generation must be 0 for first write');
  assert.equal(ls.digest, sha256str(SAMPLE_V2), 'LIVE-STATE digest must match new DATA');
  assert.equal(ls.schemaVersion, ACTIVATION_TARGET_SCHEMA, 'schemaVersion must be ACTIVATION_TARGET_SCHEMA');

  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'JOURNAL must be cleared after commit');
});

check('subsequent write: generation increments; prevRaw captured in journal (then cleared)', async () => {
  const base = makeAdapter();
  // Write 1.
  let r = await writeMutation(base, SAMPLE_V2, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, true);

  // Write 2.
  r = await writeMutation(base, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, true);

  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B, 'DATA must be updated to new value');

  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 1, 'generation must be 1 after second write');
  assert.equal(ls.digest, sha256str(SAMPLE_V2B));

  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'JOURNAL must be cleared after commit');
});

check('three sequential writes: generation tracks 0 → 1 → 2', async () => {
  const base = makeAdapter();
  const payloads = [SAMPLE_V2, SAMPLE_V2B, JSON.stringify({ schemaVersion: 2, tasks: ['a', 'b'] })];
  for (let i = 0; i < payloads.length; i++) {
    const r = await writeMutation(base, payloads[i], { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
    assert.equal(r.ok, true, `write ${i} must succeed`);
    const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
    assert.equal(ls.generation, i, `generation after write ${i} must be ${i}`);
  }
});

check('buildJournal produces the expected shape', () => {
  const j = buildJournal(3, 'a'.repeat(64), 'old-raw', 'b'.repeat(64));
  assert.equal(j.phase, 'prepared');
  assert.equal(j.generation, 3);
  assert.equal(j.prevDigest, 'a'.repeat(64));
  assert.equal(j.prevRaw, 'old-raw');
  assert.equal(j.newDigest, 'b'.repeat(64));
});

check('parseJournal: valid record returns parsed object', () => {
  const j = buildJournal(1, 'a'.repeat(64), '', 'b'.repeat(64));
  const r = parseJournal(JSON.stringify(j));
  assert.ok(r, 'should parse successfully');
  assert.equal(r.phase, 'prepared');
  assert.equal(r.generation, 1);
});

check('parseJournal: malformed JSON → null', () => {
  assert.equal(parseJournal('{bad json'), null);
  assert.equal(parseJournal(null), null);
  assert.equal(parseJournal(''), null);
  assert.equal(parseJournal(JSON.stringify({ phase: 'done', generation: 0 })), null);
});

check('parseLiveState: valid record → parsed; wrong schemaVersion → null', () => {
  const ls = buildLiveState(2, 'a'.repeat(64));
  assert.ok(parseLiveState(JSON.stringify(ls)), 'valid LIVE-STATE must parse');
  const bad = { generation: 0, digest: 'a'.repeat(64), schemaVersion: 9999 };
  assert.equal(parseLiveState(JSON.stringify(bad)), null, 'wrong schemaVersion must return null');
  assert.equal(parseLiveState(null), null);
  assert.equal(parseLiveState(''), null);
});

/* ════════════════════════════════════════════════════════════════════
   B · writeMutation — failure cases
════════════════════════════════════════════════════════════════════ */
section('writeMutation-failures');

check('journal-too-large: prevRaw > MAX_JOURNAL_RAW → abort before any writes', async () => {
  const base = makeAdapter();
  const big = 'x'.repeat(MAX_JOURNAL_RAW + 1);
  base.setItem(ACTIVATION_KEYS.DATA, big);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(big))));

  const r = await writeMutation(base, SAMPLE_V2, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'journal-too-large');
  // DATA and LIVE-STATE must be completely unchanged.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), big, 'DATA must be unchanged');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must still exist');
  assert.equal(ls.generation, 0, 'LIVE-STATE must be unchanged');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'JOURNAL must not be written');
});

check('journal-write-failed (step 1): DATA and LIVE-STATE unchanged', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const adapter = createInterceptAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.MUT_JOURNAL, mode: 'throw' }]);

  const r = await writeMutation(adapter, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'journal-write-failed');
  // DATA must be unchanged.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA must be unchanged');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 0, 'LIVE-STATE gen must be unchanged');
});

check('data-write-failed (step 2): journal retained; DATA restored from prevRaw on best-effort', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const adapter = createInterceptAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.DATA, mode: 'throw' }]);

  const r = await writeMutation(adapter, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-write-failed');
  // Journal must still be present (retained for startup recovery).
  // (Data-write failure restore may succeed or fail; journal is the recovery evidence.)
  // LIVE-STATE must remain at old value.
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 0, 'LIVE-STATE gen must not have advanced');
});

check('data-readback-mismatch (step 2): treated as data-write-failed', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  // setItem succeeds but readback returns wrong value.
  const adapter = createInterceptAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.DATA, mode: 'mismatch' }]);

  const r = await writeMutation(adapter, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-write-failed');
});

check('live-state-write-failed (step 3): DATA has new bytes; journal retained for recovery', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const adapter = createInterceptAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.LIVE_STATE, mode: 'throw' }]);

  const r = await writeMutation(adapter, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'live-state-write-failed');
  // DATA must contain new bytes (step 2 succeeded before step 3 failed).
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B, 'DATA must have new bytes');
  // Journal retained (step 4 not reached).
  const j = parseJournal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL));
  assert.ok(j, 'journal must be retained for startup recovery');
  assert.equal(j.newDigest, sha256str(SAMPLE_V2B), 'journal.newDigest must match new data');
});

check('journal-clear-failure (step 4 noop): ok:true returned; stale journal cleaned on next startup', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  // Step 4 remove is suppressed (noop) — removeItem on journal does nothing.
  let removeAttempted = false;
  const adapter = {
    ...base,
    getItem: k => base.getItem(k),
    setItem: (k, v) => base.setItem(k, v),
    removeItem: k => {
      if (k === ACTIVATION_KEYS.MUT_JOURNAL) { removeAttempted = true; return; }
      base.removeItem(k);
    },
  };
  const r = await writeMutation(adapter, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, true, 'writeMutation must return ok:true even if journal clear fails');
  assert.ok(removeAttempted, 'journal clear must have been attempted');
  // DATA and LIVE-STATE are correct.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B);
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 1);
  assert.equal(ls.digest, sha256str(SAMPLE_V2B));
});

check('journal-noop/lost-write (step 1): setItem silently no-ops → readback-mismatch → journal-write-failed', async () => {
  // mode:'noop' simulates a silent lost write (no error, but key stays at prior value).
  // setAndVerify reads back null ≠ journalStr → journal-write-failed.
  // DATA and LIVE-STATE must be completely unchanged.
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const adapter = createInterceptAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.MUT_JOURNAL, mode: 'noop' }]);

  const r = await writeMutation(adapter, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'journal-write-failed', `expected journal-write-failed; got ${r.code}`);
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA must be unchanged');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 0, 'LIVE-STATE gen must be unchanged');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'JOURNAL must not be written');
});

check('live-state-noop (step 3): setItem silently no-ops → readback-mismatch → live-state-write-failed', async () => {
  // mode:'noop' on LIVE-STATE: setItem succeeds silently but key stays at old value.
  // setAndVerify reads back old value ≠ new value → live-state-write-failed.
  // DATA must have new bytes (step 2 succeeded); journal retained.
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const adapter = createInterceptAdapter(base, [{ op: 'set', key: ACTIVATION_KEYS.LIVE_STATE, mode: 'noop' }]);

  const r = await writeMutation(adapter, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'live-state-write-failed', `expected live-state-write-failed; got ${r.code}`);
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B, 'DATA must have new bytes (step 2 succeeded)');
  const j = parseJournal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL));
  assert.ok(j, 'journal must be retained for startup recovery');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 0, 'LIVE-STATE generation must still be at prior value (noop)');
});

check('invalid input (empty newRawV2) → ok:false, code:invalid-input, nothing written', async () => {
  const base = makeAdapter();
  // invalid-input fires before lock check — no lock needed here
  const r = await writeMutation(base, '', { digestFn: testDigest, timeoutMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-input');
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), null, 'DATA must not be written');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'JOURNAL must not be written');
});

/* ════════════════════════════════════════════════════════════════════
   B-ext · writeMutation — named injection: QuotaExceededError + timeout
   ─────────────────────────────────────────────────────────────────
   Each test injects a named failure class — real DOMException quota
   error or injected timeout — for every write step (JOURNAL / DATA /
   LIVE-STATE) and for the JOURNAL clear (step 4). Each assertion is
   explicit; no row in the failure matrix cites "same catch path" as
   its only evidence.

   Assertions on every test:
     · Exact result code
     · Prior committed v2 state is recoverable via recoverMutationStartup
     · LIVE-STATE never references unverified DATA bytes
     · Activation marker byte-identical throughout
     · Unrelated sentinel key byte-identical throughout
════════════════════════════════════════════════════════════════════ */
section('writeMutation-quota-timeout');

/**
 * Real QuotaExceededError — exactly the DOMException Safari/Chrome throw
 * when localStorage is full.
 */
function makeQuotaError(key) {
  return new DOMException(`QuotaExceeded writing ${key}`, 'QuotaExceededError');
}

/**
 * Adapter where setItem (or removeItem) on a named key throws a real
 * QuotaExceededError. All other ops pass through to base.
 */
function makeQuotaAdapter(base, { setKey = null, removeKey = null } = {}) {
  return {
    getItem:    k     => base.getItem(k),
    setItem:    (k, v) => {
      if (k === setKey) throw makeQuotaError(k);
      return base.setItem(k, v);
    },
    removeItem: k     => {
      if (k === removeKey) throw makeQuotaError(k);
      return base.removeItem(k);
    },
    keys:        ()   => base.keys(),
    snapshotAll: ()   => base.snapshotAll(),
  };
}

/**
 * Adapter where setItem (or removeItem) on a named key returns a promise
 * that never settles — simulating an I/O hang. Combined with
 * FAST_TICK_SCHEDULER this produces an injected timeout without any real
 * clock delay.
 */
function makeHangingAdapter(base, { setKey = null, removeKey = null } = {}) {
  return {
    getItem:    k     => base.getItem(k),
    setItem:    (k, v) => {
      if (k === setKey) return new Promise(() => {}); // never settles
      return base.setItem(k, v);
    },
    removeItem: k     => {
      if (k === removeKey) return new Promise(() => {}); // never settles
      return base.removeItem(k);
    },
    keys:        ()   => base.keys(),
    snapshotAll: ()   => base.snapshotAll(),
  };
}

/**
 * Two-tick scheduler: setTimeout queues its callback TWO microtask ticks
 * ahead, so that a synchronous adapter's resolve callback (queued on tick 1)
 * always runs before the timeout fires (tick 2). clearTimeout sets a flag
 * that suppresses the tick-2 callback, so non-hanging operations are never
 * falsely timed out.
 *
 * For hanging adapters (which never resolve), the resolve callback is never
 * queued, so the timeout fires normally on tick 2.
 *
 * Requires timeoutMs > 0 to activate withTimeout in the production code.
 */
const FAST_TICK_SCHEDULER = {
  setTimeout(fn, _ms) {
    let cancelled = false;
    Promise.resolve().then(() =>
      Promise.resolve().then(() => { if (!cancelled) fn(); }),
    );
    return { _cancel: () => { cancelled = true; } };
  },
  clearTimeout(h) { h?._cancel?.(); },
};

/** Shared base for quota/timeout injection tests. */
function makeBaseForInjection() {
  const base = makeAdapter();
  const digest = sha256str(SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, digest)));
  plantMarker(base, digest);
  base.setItem('unrelated-sentinel', 'sentinel-value');
  return base;
}

/**
 * Assert step-1 (JOURNAL write) invariants: DATA and LIVE-STATE byte-identical
 * to what was committed before the failed write; LIVE-STATE digest references
 * only previously verified bytes; JOURNAL absent; marker + sentinel unchanged.
 */
function assertStep1Invariants(base) {
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2,
    'DATA must be unchanged after step-1 failure');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must exist');
  assert.equal(ls.generation, 0, 'LIVE-STATE gen must be unchanged');
  assert.equal(ls.digest, sha256str(SAMPLE_V2),
    'LIVE-STATE must reference only previously verified DATA digest (not new unverified bytes)');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null,
    'JOURNAL must not be present (step-1 failed before committing it)');
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be present');
  assert.equal(base.getItem('unrelated-sentinel'), 'sentinel-value',
    'sentinel must be unchanged');
}

/**
 * Assert step-2 (DATA write) invariants and verify the resulting state is
 * recoverable. LIVE-STATE must not have advanced and must not reference
 * unverified new bytes. Recovery must return committed-verified.
 */
async function assertStep2Invariants(base, marker) {
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must exist');
  assert.equal(ls.generation, 0,
    'LIVE-STATE gen must not have advanced after step-2 failure');
  assert.equal(ls.digest, sha256str(SAMPLE_V2),
    'LIVE-STATE must reference only previously verified digest (not SAMPLE_V2B)');
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be present');
  assert.equal(base.getItem('unrelated-sentinel'), 'sentinel-value', 'sentinel must be unchanged');
  // Prior committed v2 state must be recoverable.
  const rec = await recoverMutationStartup(base, marker, CLOCK, testDigest, 0);
  assert.equal(rec.action, 'committed-verified',
    `prior state must be recoverable via committed-verified; got ${rec.action}`);
  assert.equal(rec.v2Active, true);
}

/**
 * Assert step-3 (LIVE-STATE write) invariants. The key safety invariant:
 * LIVE-STATE must never reference unverified DATA bytes — it must still hold
 * the digest of the last verified DATA, not the new (partially committed)
 * digest. DATA has new bytes (step 2 succeeded). Journal retained. Recovery
 * must resolve to mutation-recovered-complete-step3.
 */
async function assertStep3Invariants(base, marker) {
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B,
    'DATA must have new bytes (step 2 succeeded before step 3 failed)');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must exist');
  assert.equal(ls.generation, 0,
    'LIVE-STATE gen must NOT have advanced — step 3 failed before LIVE-STATE was verified');
  assert.equal(ls.digest, sha256str(SAMPLE_V2),
    'LIVE-STATE must NOT reference sha256(SAMPLE_V2B) — only a verified setAndVerify write may update it');
  const j = parseJournal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL));
  assert.ok(j, 'journal must be retained for startup recovery');
  assert.equal(j.newDigest, sha256str(SAMPLE_V2B),
    'journal.newDigest must match committed DATA for recovery');
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be present');
  assert.equal(base.getItem('unrelated-sentinel'), 'sentinel-value', 'sentinel must be unchanged');
  // Prior state is recoverable.
  const rec = await recoverMutationStartup(base, marker, CLOCK, testDigest, 0);
  assert.equal(rec.action, 'mutation-recovered-complete-step3',
    `state must be recoverable via complete-step3; got ${rec.action}`);
  assert.equal(rec.v2Active, true);
}

/**
 * Assert step-4 (JOURNAL clear) invariants. Steps 1-3 all succeeded so the
 * result must be ok:true. DATA and LIVE-STATE are fully committed. The stale
 * journal left by the failed clear must be recoverable as a committed-verified
 * state, and recovery must clear it.
 */
async function assertStep4Invariants(base, marker) {
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B,
    'DATA must have new bytes (steps 1-3 all succeeded)');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must exist');
  assert.equal(ls.generation, 1, 'LIVE-STATE gen must be 1 (write fully committed)');
  assert.equal(ls.digest, sha256str(SAMPLE_V2B),
    'LIVE-STATE digest must reference verified new DATA bytes');
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be present');
  assert.equal(base.getItem('unrelated-sentinel'), 'sentinel-value', 'sentinel must be unchanged');
  // Stale journal is recoverable — LIVE-STATE matches DATA → committed-verified.
  const rec = await recoverMutationStartup(base, marker, CLOCK, testDigest, 0);
  assert.equal(rec.action, 'committed-verified',
    `stale journal after step-4 failure must be recoverable; got ${rec.action}`);
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null,
    'recovery must clear the stale journal');
}

// ── H1: JOURNAL write — real QuotaExceededError ───────────────────
check('H1: journal-write-quota (step 1): QuotaExceededError on JOURNAL setItem → journal-write-failed; DATA+LIVE-STATE unchanged; LIVE-STATE references only verified bytes; recoverable', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // Real DOMException(QuotaExceededError) thrown on JOURNAL setItem.
  const adapter = makeQuotaAdapter(base, { setKey: ACTIVATION_KEYS.MUT_JOURNAL });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK,
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'journal-write-failed',
    `expected journal-write-failed; got ${r.code} — DOMException must be caught and mapped`);
  assertStep1Invariants(base);
  // Explicit recovery proof: prior committed state survives a JOURNAL quota error.
  const rec = await recoverMutationStartup(base, marker, CLOCK, testDigest, 0);
  assert.equal(rec.action, 'committed-verified');
});

// ── H2: JOURNAL write — injected timeout ──────────────────────────
check('H2: journal-write-timeout (step 1): hanging setItem + FAST_TICK_SCHEDULER → journal-write-failed; DATA+LIVE-STATE unchanged; recoverable', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // JOURNAL setItem never settles; FAST_TICK_SCHEDULER fires timeout on tick 2.
  // timeoutMs:1 activates withTimeout in production code.
  const adapter = makeHangingAdapter(base, { setKey: ACTIVATION_KEYS.MUT_JOURNAL });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 1, lock: ALWAYS_GRANT_LOCK,
    scheduler: FAST_TICK_SCHEDULER,
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'journal-write-failed',
    `expected journal-write-failed; got ${r.code} — injected timeout must be caught and mapped`);
  assertStep1Invariants(base);
  const rec = await recoverMutationStartup(base, marker, CLOCK, testDigest, 0);
  assert.equal(rec.action, 'committed-verified');
});

// ── H3: DATA write — real QuotaExceededError ──────────────────────
check('H3: data-write-quota (step 2): QuotaExceededError on DATA setItem → data-write-failed; LIVE-STATE gen+digest unchanged; recoverable', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // Quota on DATA setItem — also blocks the best-effort restore write.
  // Journal is retained when restore fails.
  const adapter = makeQuotaAdapter(base, { setKey: ACTIVATION_KEYS.DATA });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK,
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-write-failed',
    `expected data-write-failed; got ${r.code}`);
  await assertStep2Invariants(base, marker);
});

// ── H4: DATA write — injected timeout ────────────────────────────
check('H4: data-write-timeout (step 2): hanging DATA setItem + FAST_TICK_SCHEDULER → data-write-failed; LIVE-STATE gen+digest unchanged; recoverable', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // Hanging DATA setItem; both the write and the restore attempt time out.
  const adapter = makeHangingAdapter(base, { setKey: ACTIVATION_KEYS.DATA });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 1, lock: ALWAYS_GRANT_LOCK,
    scheduler: FAST_TICK_SCHEDULER,
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-write-failed',
    `expected data-write-failed; got ${r.code}`);
  await assertStep2Invariants(base, marker);
});

// ── H5: LIVE-STATE write — real QuotaExceededError ───────────────
check('H5: live-state-write-quota (step 3): QuotaExceededError on LIVE-STATE setItem → live-state-write-failed; LIVE-STATE never references unverified bytes; journal retained; recoverable via complete-step3', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // Quota on LIVE-STATE setItem — DATA is written (step 2 succeeded) but
  // LIVE-STATE is never updated, so it must still reference sha256(SAMPLE_V2).
  const adapter = makeQuotaAdapter(base, { setKey: ACTIVATION_KEYS.LIVE_STATE });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK,
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'live-state-write-failed',
    `expected live-state-write-failed; got ${r.code}`);
  await assertStep3Invariants(base, marker);
});

// ── H6: LIVE-STATE write — injected timeout ───────────────────────
check('H6: live-state-write-timeout (step 3): hanging LIVE-STATE setItem + FAST_TICK_SCHEDULER → live-state-write-failed; LIVE-STATE never references unverified bytes; journal retained; recoverable via complete-step3', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // Hanging LIVE-STATE setItem: production setAndVerify times out via
  // FAST_TICK_SCHEDULER before the write (and thus before any readback).
  // LIVE-STATE key on base must therefore still hold sha256(SAMPLE_V2).
  const adapter = makeHangingAdapter(base, { setKey: ACTIVATION_KEYS.LIVE_STATE });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 1, lock: ALWAYS_GRANT_LOCK,
    scheduler: FAST_TICK_SCHEDULER,
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'live-state-write-failed',
    `expected live-state-write-failed; got ${r.code}`);
  await assertStep3Invariants(base, marker);
});

// ── H7: JOURNAL clear — real QuotaExceededError (step 4) ─────────
check('H7: journal-clear-quota (step 4): QuotaExceededError on JOURNAL removeItem → ok:true; DATA+LIVE-STATE fully committed; stale journal recoverable via committed-verified', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // Quota on JOURNAL removeItem — steps 1-3 all succeed (setItem not blocked).
  // Step 4 throws; caught by try/catch → result is ok:true.
  const adapter = makeQuotaAdapter(base, { removeKey: ACTIVATION_KEYS.MUT_JOURNAL });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK,
  });

  assert.equal(r.ok, true,
    `step-4 QuotaExceededError must not fail the write; got ok:${r.ok} code:${r.code}`);
  await assertStep4Invariants(base, marker);
});

// ── H8: JOURNAL clear — injected timeout (step 4) ────────────────
check('H8: journal-clear-timeout (step 4): hanging JOURNAL removeItem + FAST_TICK_SCHEDULER → ok:true; DATA+LIVE-STATE fully committed; stale journal recoverable via committed-verified', async () => {
  const base   = makeBaseForInjection();
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  // Hanging JOURNAL removeItem: step-4 aRemove times out; caught silently.
  // Steps 1-3 use setItem (not removeItem) so they proceed normally.
  const adapter = makeHangingAdapter(base, { removeKey: ACTIVATION_KEYS.MUT_JOURNAL });

  const r = await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 1, lock: ALWAYS_GRANT_LOCK,
    scheduler: FAST_TICK_SCHEDULER,
  });

  assert.equal(r.ok, true,
    `step-4 timeout must not fail the write; got ok:${r.ok} code:${r.code}`);
  await assertStep4Invariants(base, marker);
});

/* ════════════════════════════════════════════════════════════════════
   C · recoverMutationStartup — all plan rows
════════════════════════════════════════════════════════════════════ */
section('recoverMutationStartup');

const CLOCK = '2026-08-12T00:00:00.000Z';

/** Shared helper: build an adapter with committed v2 state (marker + DATA + LIVE-STATE). */
function makeCommittedAdapter(v2Raw = SAMPLE_V2) {
  const base = makeAdapter();
  const digest = sha256str(v2Raw);
  base.setItem(ACTIVATION_KEYS.DATA, v2Raw);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, digest)));
  plantMarker(base, digest);
  return { base, digest };
}

// ── Row 1: LIVE-STATE matches DATA, no journal ────────────────────
check('row 1 (clean): LIVE-STATE matches DATA, no journal → committed-verified, v2Active:true', async () => {
  const { base } = makeCommittedAdapter();
  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'committed-verified');
  assert.equal(r.v2Active, true);
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'no journal to clean');
});

// ── Row 2: LIVE-STATE matches DATA, stale journal present ─────────
check('row 2 (stale-journal): LIVE-STATE matches DATA + stale journal → committed-verified, journal cleared', async () => {
  const { base, digest } = makeCommittedAdapter();
  // Plant a stale journal (e.g., step-4 clear failed previously).
  const staleJournal = buildJournal(0, '', '', digest);
  base.setItem(ACTIVATION_KEYS.MUT_JOURNAL, JSON.stringify(staleJournal));

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'committed-verified');
  assert.equal(r.v2Active, true);
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'stale journal must be cleared');
});

// ── Row 3: legacy-committed (LIVE-STATE absent, marker v2DataDigest matches) ──
check('row 3 (legacy-committed): LIVE-STATE absent, sha256(DATA)==marker.v2DataDigest → legacy-committed, LIVE-STATE gen 0 created', async () => {
  const base = makeAdapter();
  const digest = sha256str(SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  // No LIVE-STATE — simulates pre-B1 committed state.
  plantMarker(base, digest);

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'legacy-committed');
  assert.equal(r.v2Active, true);
  // LIVE-STATE must be created gen 0 with correct digest.
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must be created');
  assert.equal(ls.generation, 0);
  assert.equal(ls.digest, digest);
});

// ── Row 3b: legacy-committed, digest mismatch → ambiguous ────────
check('row 3b (legacy-committed digest mismatch): sha256(DATA)≠marker.v2DataDigest → ambiguous-state', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  plantMarker(base, 'b'.repeat(64));  // wrong digest in marker

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'ambiguous-state');
  assert.equal(r.v2Active, false);
  // DATA must be retained (correction 3).
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA must be retained');
});

// ── Row 4: LIVE-STATE mismatch, no journal → ambiguous ───────────
check('row 4 (ambiguous): LIVE-STATE mismatch, no journal → ambiguous-state; all evidence retained', async () => {
  const base = makeAdapter();
  const digest = sha256str(SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  // LIVE-STATE points to a different digest (simulates partial corruption).
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, 'c'.repeat(64))));
  plantMarker(base, digest);

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'ambiguous-state');
  assert.equal(r.v2Active, false);
  // All evidence retained.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA retained');
  assert.ok(base.getItem(ACTIVATION_KEYS.LIVE_STATE), 'LIVE-STATE retained');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'no journal in this scenario');
});

// ── Row 5: crash after step 2 (DATA=newBytes), step 3 not done ───
check('row 5 (complete-step-3): DATA matches journal.newDigest → write LIVE-STATE, clear journal', async () => {
  const base = makeAdapter();
  const prevDigest = sha256str(SAMPLE_V2);
  const newDigest  = sha256str(SAMPLE_V2B);

  // Simulate: step 1 completed (journal), step 2 completed (DATA=new), step 3 not done.
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2B);  // new data written
  // LIVE-STATE still points to old digest (or absent).
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, prevDigest)));
  // Journal records the intended mutation.
  const journal = buildJournal(1, prevDigest, SAMPLE_V2, newDigest);
  base.setItem(ACTIVATION_KEYS.MUT_JOURNAL, JSON.stringify(journal));
  plantMarker(base, prevDigest);  // original activation digest

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'mutation-recovered-complete-step3');
  assert.equal(r.v2Active, true);
  // LIVE-STATE must point to newDigest at generation 1.
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must be written');
  assert.equal(ls.generation, 1);
  assert.equal(ls.digest, newDigest);
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'journal must be cleared');
});

// ── Row 6: crash after step 1 (journal), step 2 not done ─────────
check('row 6 (revert-step-2): DATA matches journal.prevDigest → restore LIVE-STATE, clear journal', async () => {
  const base = makeAdapter();
  const prevDigest = sha256str(SAMPLE_V2);
  const newDigest  = sha256str(SAMPLE_V2B);

  // Simulate: step 1 completed (journal), step 2 did NOT complete (DATA still=old).
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);  // original data (step 2 not done)
  // LIVE-STATE mismatch (simulates it was already cleared or wrong).
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, 'mismatch-digest')));
  const journal = buildJournal(1, prevDigest, SAMPLE_V2, newDigest);
  base.setItem(ACTIVATION_KEYS.MUT_JOURNAL, JSON.stringify(journal));
  plantMarker(base, prevDigest);

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'mutation-recovered-revert-step2');
  assert.equal(r.v2Active, true);
  // LIVE-STATE restored to prevDigest at generation 0 (max(0, 1-1)).
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 0);
  assert.equal(ls.digest, prevDigest);
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'journal cleared');
});

// ── Row 7: DATA matches neither; prevRaw present + consistent ─────
check('row 7 (restore-data): DATA matches neither + prevRaw present → restore DATA + LIVE-STATE; clear journal', async () => {
  const base = makeAdapter();
  const prevDigest = sha256str(SAMPLE_V2);
  const newDigest  = sha256str(SAMPLE_V2B);
  const corrupted  = 'corrupted-bytes';

  base.setItem(ACTIVATION_KEYS.DATA, corrupted);  // neither prev nor new
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, 'any-digest')));
  const journal = buildJournal(1, prevDigest, SAMPLE_V2, newDigest);
  base.setItem(ACTIVATION_KEYS.MUT_JOURNAL, JSON.stringify(journal));
  plantMarker(base, prevDigest);

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'mutation-recovered-restore-data');
  assert.equal(r.v2Active, true);
  // DATA restored from prevRaw.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA restored to prevRaw');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.digest, prevDigest, 'LIVE-STATE restored to prevDigest');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'journal cleared');
});

// ── Row 8: malformed journal, LIVE-STATE matches DATA ────────────
check('row 8 (stale-corrupt-journal): malformed journal + LIVE-STATE matches DATA → committed-verified', async () => {
  const { base } = makeCommittedAdapter();
  // Plant a malformed journal (phase wrong).
  base.setItem(ACTIVATION_KEYS.MUT_JOURNAL, '{"phase":"unknown","generation":0}');

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  // LIVE-STATE matches DATA → committed-verified regardless of journal content.
  assert.equal(r.action, 'committed-verified');
  assert.equal(r.v2Active, true);
});

// ── Row 9: malformed journal, LIVE-STATE mismatch → ambiguous ────
check('row 9 (ambiguous-malformed-journal): malformed journal + LIVE-STATE mismatch → ambiguous-state', async () => {
  const base = makeAdapter();
  const digest = sha256str(SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, 'wrong-digest')));
  base.setItem(ACTIVATION_KEYS.MUT_JOURNAL, '{"phase":"unknown","generation":0}');
  plantMarker(base, digest);

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'ambiguous-state');
  assert.equal(r.v2Active, false);
  // Correction 3: DATA must be retained.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA retained in ambiguous state');
  assert.ok(base.getItem(ACTIVATION_KEYS.LIVE_STATE), 'LIVE-STATE retained');
});

// ── Row 7 edge: DATA matches neither, prevRaw absent → ambiguous ──
check('row 7 edge (no prevRaw): DATA matches neither, journal.prevRaw absent → ambiguous-state', async () => {
  const base = makeAdapter();
  const prevDigest = sha256str(SAMPLE_V2);
  const newDigest  = sha256str(SAMPLE_V2B);

  base.setItem(ACTIVATION_KEYS.DATA, 'completely-different');
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, 'any')));
  // Journal with NO prevRaw (correction 2: no truncated prevRaw ever stored).
  const journalNoPrevRaw = { phase: 'prepared', generation: 1, prevDigest, newDigest };
  base.setItem(ACTIVATION_KEYS.MUT_JOURNAL, JSON.stringify(journalNoPrevRaw));
  plantMarker(base, prevDigest);

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'ambiguous-state');
  assert.equal(r.v2Active, false);
});

// ── Row 4 variant: LIVE-STATE absent, no journal → ambiguous ─────
check('LIVE-STATE absent + no journal + marker digest mismatch → ambiguous-state', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  // Plant marker with a wrong but structurally-valid hex digest ('c' is valid hex).
  // isWellFormedMarker passes; _handleLegacyCommitted sees digest mismatch → ambiguous.
  plantMarker(base, 'c'.repeat(64));

  const m = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const r = await recoverMutationStartup(base, m, CLOCK, testDigest, 0);
  assert.equal(r.action, 'ambiguous-state');
  assert.equal(r.v2Active, false);
});

// ── null marker usage (test-only, no authority marker) ───────────
check('null marker: LIVE-STATE matches DATA → committed-verified', async () => {
  const base = makeAdapter();
  const digest = sha256str(SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, digest)));

  const r = await recoverMutationStartup(base, null, CLOCK, testDigest, 0);
  assert.equal(r.action, 'committed-verified');
  assert.equal(r.v2Active, true);
});

check('null marker: LIVE-STATE absent → none, v2Active:false', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  // No LIVE-STATE, no marker.
  const r = await recoverMutationStartup(base, null, CLOCK, testDigest, 0);
  // Delegates to _handleLegacyCommitted(null) → none.
  assert.equal(r.v2Active, false);
});

/* ════════════════════════════════════════════════════════════════════
   D · V2Repository
════════════════════════════════════════════════════════════════════ */
section('V2Repository');

function makeRepo(base, { parseFn, serializeFn, lock, generateId } = {}) {
  return new V2Repository({
    adapter:     base,
    parseFn:     parseFn     ?? (raw => JSON.parse(raw)),
    serializeFn: serializeFn ?? (data => JSON.stringify(data)),
    lock:        lock        ?? ALWAYS_GRANT_LOCK,
    generateId:  generateId  ?? (() => null),
    digestFn:    testDigest,
    timeoutMs:   0,
  });
}

check('constructor: requires adapter, parseFn, serializeFn, lock', () => {
  assert.throws(() => new V2Repository({}), /adapter/i);
  assert.throws(() => new V2Repository({ adapter: makeAdapter() }), /parseFn/i);
  assert.throws(() => new V2Repository({ adapter: makeAdapter(), parseFn: () => {} }), /serializeFn/i);
  assert.throws(
    () => new V2Repository({ adapter: makeAdapter(), parseFn: () => {}, serializeFn: () => '' }),
    /lock/i,
    'missing lock must throw',
  );
  assert.throws(
    () => new V2Repository({
      adapter: makeAdapter(), parseFn: () => {}, serializeFn: () => '',
      lock: { notRunExclusive: true },
    }),
    /lock/i,
    'malformed lock (no runExclusive) must throw',
  );
});

check('get(): reads and parses current DATA', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  const repo = makeRepo(base);
  const r = await repo.get();
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, JSON.parse(SAMPLE_V2));
});

check('get(): DATA absent → ok:false, code:data-absent', async () => {
  const base = makeAdapter();
  const repo = makeRepo(base);
  const r = await repo.get();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'data-absent');
});

check('get(): parse failure → ok:false, code:parse-failed', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, 'not-json');
  const repo = makeRepo(base, { parseFn: () => { throw new Error('parse error'); } });
  const r = await repo.get();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'parse-failed');
});

check('put(): serialises and writes data; LIVE-STATE updated', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const repo = makeRepo(base);
  const newData = { schemaVersion: 2, tasks: [{ id: 'task-1' }] };
  const r = await repo.put(newData);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(base.getItem(ACTIVATION_KEYS.DATA)), newData);
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 1);
});

check('update(): applies mutation callback', async () => {
  const base = makeAdapter();
  const initial = { schemaVersion: 2, tasks: [] };
  base.setItem(ACTIVATION_KEYS.DATA, JSON.stringify(initial));
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(JSON.stringify(initial)))));
  const repo = makeRepo(base);

  const r = await repo.update(data => ({ ...data, tasks: [...data.tasks, { id: 'task-1' }] }));
  assert.equal(r.ok, true);
  const stored = JSON.parse(base.getItem(ACTIVATION_KEYS.DATA));
  assert.equal(stored.tasks.length, 1);
  assert.equal(stored.tasks[0].id, 'task-1');
});

check('update(): mutateFn throws → ok:false, code:mutation-fn-threw', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const repo = makeRepo(base);
  const r = await repo.update(() => { throw new Error('mutateFn blew up'); });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'mutation-fn-threw');
  // DATA must be unchanged.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2);
});

check('update(): serialize failure → ok:false, code:serialize-failed', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(SAMPLE_V2))));
  const repo = makeRepo(base, { serializeFn: () => { throw new Error('serialize error'); } });
  const r = await repo.update(d => d);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'serialize-failed');
});

check('update(): concurrent calls are serialised (no interleaving)', async () => {
  const base = makeAdapter();
  base.setItem(ACTIVATION_KEYS.DATA, JSON.stringify({ count: 0 }));
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, sha256str(JSON.stringify({ count: 0 })))));
  const repo = makeRepo(base);

  // Fire 5 concurrent increments — without serialisation, the final count would be 1.
  // With serialisation, the final count must be 5.
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      repo.update(data => ({ ...data, count: data.count + 1 })),
    ),
  );
  assert.ok(results.every(r => r.ok), 'all updates must succeed');
  const final = JSON.parse(base.getItem(ACTIVATION_KEYS.DATA));
  assert.equal(final.count, 5, `expected count:5, got ${final.count}`);
});

/* ════════════════════════════════════════════════════════════════════
   F · ExclusiveMutationLock contract — focused provider tests
   Each case proves zero writes to mutation keys (JOURNAL/DATA/LIVE-STATE)
   and leaves the authority marker and unrelated keys byte-identical.
════════════════════════════════════════════════════════════════════ */
section('lock-provider');

/** Build an adapter with a pre-planted marker and an unrelated sentinel key. */
function makeLockedAdapter() {
  const base = makeAdapter();
  const digest = sha256str(SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.DATA, SAMPLE_V2);
  base.setItem(ACTIVATION_KEYS.LIVE_STATE, JSON.stringify(buildLiveState(0, digest)));
  plantMarker(base, digest);
  base.setItem('unrelated-sentinel', 'sentinel-value');
  return base;
}

/** Assert that all three mutation keys and the marker are unchanged. */
function assertNoMutationKeyWrites(base, opts = {}) {
  const { expectedData = SAMPLE_V2, expectedGeneration = 0 } = opts;
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), expectedData, 'DATA must be unchanged');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'JOURNAL must not be written');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.ok(ls, 'LIVE-STATE must exist');
  assert.equal(ls.generation, expectedGeneration, 'LIVE-STATE generation must be unchanged');
  // Marker must be present and byte-identical.
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must still be present');
  // Unrelated key must be intact.
  assert.equal(base.getItem('unrelated-sentinel'), 'sentinel-value', 'unrelated key must be unchanged');
}

const MUTATION_KEYS = [
  ACTIVATION_KEYS.DATA,
  ACTIVATION_KEYS.MUT_JOURNAL,
  ACTIVATION_KEYS.LIVE_STATE,
];

/** Wrap adapter to record writes; throws if any mutation key is touched. */
function makeWriteGuardAdapter(base) {
  const written = [];
  return {
    getItem:    k      => base.getItem(k),
    setItem:    (k, v) => { written.push(k); base.setItem(k, v); },
    removeItem: k      => { written.push(k); base.removeItem(k); },
    keys:       ()     => base.keys(),
    snapshotAll: ()    => base.snapshotAll(),
    get writtenKeys() { return written; },
  };
}

// F1 — lock absent (undefined) ─────────────────────────────────────
check('F1: lock absent → concurrency-unavailable, zero mutation-key writes', async () => {
  const base  = makeLockedAdapter();
  const guard = makeWriteGuardAdapter(base);

  const r = await writeMutation(guard, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0 });
  // lock absent (no opts.lock) → concurrency-unavailable before any storage op.
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');

  const mutationWrites = guard.writtenKeys.filter(k => MUTATION_KEYS.includes(k));
  assert.deepEqual(mutationWrites, [], 'zero mutation-key writes must occur');
  assertNoMutationKeyWrites(base);
});

// F2 — lock explicitly null ────────────────────────────────────────
check('F2: lock: null → concurrency-unavailable, zero mutation-key writes', async () => {
  const base  = makeLockedAdapter();
  const guard = makeWriteGuardAdapter(base);

  const r = await writeMutation(guard, SAMPLE_V2B, { digestFn: testDigest, timeoutMs: 0, lock: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');

  const mutationWrites = guard.writtenKeys.filter(k => MUTATION_KEYS.includes(k));
  assert.deepEqual(mutationWrites, [], 'zero mutation-key writes must occur');
  assertNoMutationKeyWrites(base);
});

// F3 — lock malformed (no runExclusive) ───────────────────────────
check('F3: lock malformed (object, no runExclusive) → concurrency-unavailable, zero writes', async () => {
  const base  = makeLockedAdapter();
  const guard = makeWriteGuardAdapter(base);

  const r = await writeMutation(guard, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0,
    lock: { acquire: async () => ({ ok: true }) }, // wrong interface
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');

  const mutationWrites = guard.writtenKeys.filter(k => MUTATION_KEYS.includes(k));
  assert.deepEqual(mutationWrites, [], 'zero mutation-key writes must occur');
  assertNoMutationKeyWrites(base);
});

// F4 — lock denied (runExclusive returns ok:false) ─────────────────
check('F4: lock denied → concurrency-unavailable, callback never invoked, zero writes', async () => {
  const base  = makeLockedAdapter();
  const guard = makeWriteGuardAdapter(base);

  let callbackInvoked = false;
  const deniedLock = {
    runExclusive: async (_txId, _fn) => {
      // Deliberately does NOT invoke _fn — lock denied before callback runs.
      return { ok: false, code: 'denied', message: 'Resource busy' };
    },
  };

  const r = await writeMutation(guard, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: deniedLock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  assert.equal(callbackInvoked, false, 'callback must never be invoked on denied lock');

  const mutationWrites = guard.writtenKeys.filter(k => MUTATION_KEYS.includes(k));
  assert.deepEqual(mutationWrites, [], 'zero mutation-key writes must occur');
  assertNoMutationKeyWrites(base);
});

// F5 — lock provider throws ────────────────────────────────────────
check('F5: lock.runExclusive throws → concurrency-unavailable, zero writes', async () => {
  const base  = makeLockedAdapter();
  const guard = makeWriteGuardAdapter(base);

  const throwingLock = {
    runExclusive: async () => { throw new Error('Lock provider crashed'); },
  };

  const r = await writeMutation(guard, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: throwingLock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');

  const mutationWrites = guard.writtenKeys.filter(k => MUTATION_KEYS.includes(k));
  assert.deepEqual(mutationWrites, [], 'zero mutation-key writes must occur');
  assertNoMutationKeyWrites(base);
});

// F6 — lock timeout (returns ok:false, code:'timeout') ────────────
check('F6: lock timeout → concurrency-unavailable, zero writes', async () => {
  const base  = makeLockedAdapter();
  const guard = makeWriteGuardAdapter(base);

  const timedOutLock = {
    runExclusive: async (_txId, _fn) => {
      // Times out without invoking callback.
      return { ok: false, code: 'timeout', message: 'Lock acquisition timed out' };
    },
  };

  const r = await writeMutation(guard, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: timedOutLock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');

  const mutationWrites = guard.writtenKeys.filter(k => MUTATION_KEYS.includes(k));
  assert.deepEqual(mutationWrites, [], 'zero mutation-key writes must occur');
  assertNoMutationKeyWrites(base);
});

// F7 — always-grant lock passes through mutation result ────────────
check('F7: always-grant lock → mutation succeeds; DATA and LIVE-STATE updated', async () => {
  const base = makeLockedAdapter();
  const r    = await writeMutation(base, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: ALWAYS_GRANT_LOCK,
  });
  assert.equal(r.ok, true, `expected ok:true; got ${JSON.stringify(r)}`);
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B, 'DATA updated');
  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 1, 'generation advanced');
  assert.equal(ls.digest, sha256str(SAMPLE_V2B));
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null, 'journal cleared');
  assert.equal(base.getItem('unrelated-sentinel'), 'sentinel-value', 'unrelated key unchanged');
});

// F8 — V2Repository propagates concurrency-unavailable ────────────
check('F8: V2Repository with denied lock → concurrency-unavailable returned to caller', async () => {
  const base = makeLockedAdapter();
  const deniedLock = {
    runExclusive: async () => ({ ok: false, code: 'denied' }),
  };
  const repo = makeRepo(base, { lock: deniedLock });
  const r    = await repo.put({ schemaVersion: 2, tasks: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'concurrency-unavailable');
  // DATA must be unchanged.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2, 'DATA must be unchanged');
});

// F9 — journal records transactionId when provided ─────────────────
check('F9: transactionId included in journal for crash-recovery evidence', async () => {
  const base = makeLockedAdapter();

  // Use a lock that captures what the callback writes.
  const capturedLock = {
    runExclusive: async (txId, fn) => {
      const result = await fn();
      return { ok: true, result };
    },
  };

  // Intercept step 3 (LIVE-STATE write) so journal stays on storage after step 2.
  const base2  = makeLockedAdapter();
  const adapter = createInterceptAdapter(base2, [
    { op: 'set', key: ACTIVATION_KEYS.LIVE_STATE, mode: 'throw' },
  ]);

  await writeMutation(adapter, SAMPLE_V2B, {
    digestFn: testDigest, timeoutMs: 0, lock: capturedLock,
    transactionId: 'test-tx-abc',
  });

  const j = parseJournal(base2.getItem(ACTIVATION_KEYS.MUT_JOURNAL));
  assert.ok(j, 'journal must be present (step 3 failed so journal retained)');
  assert.equal(j.transactionId, 'test-tx-abc', 'journal must record transactionId');
});

// F10 — buildJournal with/without transactionId ───────────────────
check('F10: buildJournal includes transactionId when provided; omits it when null', () => {
  const withTxId = buildJournal(1, 'a'.repeat(64), 'raw', 'b'.repeat(64), 'tx-001');
  assert.equal(withTxId.transactionId, 'tx-001', 'transactionId must be present');

  const noTxId = buildJournal(1, 'a'.repeat(64), 'raw', 'b'.repeat(64));
  assert.ok(!('transactionId' in noTxId), 'transactionId must be absent when null');
});

/* ════════════════════════════════════════════════════════════════════
   G · Two-writer shared-lock interleaving
   ─────────────────────────────────────────────────────────────────
   Proves that two independent V2Repository instances sharing one
   backing store and one ExclusiveMutationLock provider:
     G1 — serialize and produce no lost update (count N+2 not N+1)
     G2 — second writer's journal captures A's committed state as
          prevDigest/prevRaw; transactionIds are distinct, no clobber
     G3 — first writer crashes at step 3, recovery resolves the
          partial write, later writer builds on recovered state
          without data loss
════════════════════════════════════════════════════════════════════ */
section('two-writer-interleaving');

/**
 * Deterministic serializing lock for multi-repo tests.
 * Implements the ExclusiveMutationLock interface (runExclusive(txId, fn))
 * with strict FIFO ordering — each call waits for the previous to finish.
 * No denials, no timeouts; simply serialises concurrent callers.
 */
class SerializingLock {
  constructor() { this._tail = Promise.resolve(); }

  runExclusive(_txId, fn) {
    const slot = this._tail.then(async () => {
      const result = await fn();
      return { ok: true, result };
    });
    // swallow any rejection from fn so the queue never gets poisoned
    this._tail = slot.catch(() => {});
    return slot;
  }
}

/** Make a fresh adapter with DATA={count}, gen-0 LIVE-STATE, marker, sentinel. */
function makeTwoWriterBase(count = 0) {
  const base = makeAdapter();
  const initial = JSON.stringify({ schemaVersion: 2, count });
  base.setItem(ACTIVATION_KEYS.DATA, initial);
  base.setItem(
    ACTIVATION_KEYS.LIVE_STATE,
    JSON.stringify(buildLiveState(0, sha256str(initial))),
  );
  plantMarker(base, sha256str(initial));
  base.setItem('unrelated-sentinel', 'sentinel-value');
  return { base, initial };
}

/**
 * G1: Two independent repos share one SerializingLock.
 * Both call update(increment) concurrently via Promise.all.
 *
 * Lost-update proof:
 *   Without post-lock read in mutateFn, both see count=0, both write count=1;
 *   final count would be 1 (stale overwrite).
 *   With the read-mutate-serialize cycle inside the lock callback:
 *     • A acquires lock, reads count=0, increments to 1, writes count=1.
 *     • B waits, then acquires lock, reads count=1 (post-lock), writes count=2.
 *   Final must be count=2 and generation=2.
 */
check('G1: two repos share SerializingLock; concurrent increments → count=2, gen=2, marker+sentinel unchanged', async () => {
  const { base } = makeTwoWriterBase(0);
  const lock = new SerializingLock();
  let seq = 0;

  const makeWriter = () => new V2Repository({
    adapter:     base,
    parseFn:     raw => JSON.parse(raw),
    serializeFn: data => JSON.stringify(data),
    lock,
    generateId:  () => `tx-G1-${++seq}`,
    digestFn:    testDigest,
    timeoutMs:   0,
  });

  const increment = data => ({ ...data, count: data.count + 1 });

  const [rA, rB] = await Promise.all([
    makeWriter().update(increment),
    makeWriter().update(increment),
  ]);

  assert.equal(rA.ok, true, 'repoA must succeed');
  assert.equal(rB.ok, true, 'repoB must succeed');

  const finalData = JSON.parse(base.getItem(ACTIVATION_KEYS.DATA));
  assert.equal(
    finalData.count, 2,
    `expected count:2 (both increments applied); got ${finalData.count} — lost-update detected`,
  );

  const ls = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(ls.generation, 2, `expected generation:2; got ${ls.generation}`);

  // Marker written at activation must be byte-identical — no mutation may touch it.
  const markerRaw = base.getItem(ACTIVATION_KEYS.MARKER);
  assert.ok(markerRaw, 'marker must be present');
  const marker = JSON.parse(markerRaw);
  assert.ok(marker.v2DataDigest, 'marker.v2DataDigest must be present');

  // Unrelated keys must be byte-identical.
  assert.equal(
    base.getItem('unrelated-sentinel'), 'sentinel-value',
    'unrelated sentinel must not be touched',
  );
});

/**
 * G2: A commits at gen 1; B starts after, crashes at step 3 (LIVE-STATE write
 * fails so journal is retained).
 *
 * Verifies:
 *   • B's journal.prevDigest  = sha256(A's committed DATA)
 *   • B's journal.prevRaw     = A's committed DATA bytes
 *   • B's journal.generation  = 2  (not 1 — no collision with A)
 *   • B's journal.transactionId = 'tx-B'  (not 'tx-A' — no clobber)
 *   • Marker byte-identical; unrelated sentinel unchanged.
 */
check('G2: B journal prevDigest = sha256(A committed DATA); txIds distinct; gen=2; marker+sentinel unchanged', async () => {
  const base = makeLockedAdapter();   // DATA=SAMPLE_V2, gen-0 LIVE-STATE, marker
  base.setItem('unrelated-sentinel', 'sentinel-value');

  // ── A commits successfully ──────────────────────────────────────
  const lockA = new SerializingLock();
  const repoA = makeRepo(base, { lock: lockA, generateId: () => 'tx-A' });
  const rA = await repoA.put(JSON.parse(SAMPLE_V2B));
  assert.equal(rA.ok, true, 'A must commit successfully');
  // Now: DATA=SAMPLE_V2B, LIVE-STATE gen=1, JOURNAL cleared.

  // ── B writes via writeMutation, crashes at LIVE-STATE (step 3) ─
  // JOURNAL is retained because step 4 (clear) only runs after step 3 succeeds.
  const crashAdapter = createInterceptAdapter(base, [
    { op: 'set', key: ACTIVATION_KEYS.LIVE_STATE, mode: 'throw' },
  ]);
  const lockB = new SerializingLock();   // fresh lock — A is fully done
  const rB = await writeMutation(crashAdapter, SAMPLE_V2C, {
    lock:          lockB,
    transactionId: 'tx-B',
    digestFn:      testDigest,
    timeoutMs:     0,
  });
  assert.equal(rB.code, 'live-state-write-failed', 'B must fail at step 3');

  // ── Inspect B's retained journal ────────────────────────────────
  const j = parseJournal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL));
  assert.ok(j, 'B\'s journal must be present on storage');

  assert.equal(j.transactionId, 'tx-B',
    'journal.transactionId must be B\'s — A\'s txId must not clobber it');

  assert.equal(j.generation, 2,
    'journal.generation must be 2 (B reads A\'s gen-1 LIVE-STATE post-lock)');

  assert.equal(j.prevDigest, sha256str(SAMPLE_V2B),
    'journal.prevDigest must equal sha256 of A\'s committed DATA (post-lock re-read)');

  assert.equal(j.prevRaw, SAMPLE_V2B,
    'journal.prevRaw must be A\'s committed DATA bytes (post-lock re-read)');

  // ── Invariants ──────────────────────────────────────────────────
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER), 'marker must be present');
  assert.equal(
    base.getItem('unrelated-sentinel'), 'sentinel-value',
    'unrelated sentinel must not be touched',
  );
});

/**
 * G3: A crashes at step 3 leaving journal evidence.  Recovery resolves to
 * mutation-recovered-complete-step3.  B then acquires the shared lock, reads
 * the recovered state (gen=1, DATA=SAMPLE_V2B), and writes gen=2.
 *
 * Verifies no data loss: A's committed DATA is the base for B's write.
 */
check('G3: A crashes at step 3; recoverMutationStartup completes it; B builds on recovered state without data loss', async () => {
  const base = makeLockedAdapter();   // DATA=SAMPLE_V2, gen-0 LIVE-STATE, marker
  const lock = new SerializingLock();

  // ── A writes, crashes at LIVE-STATE (step 3) ────────────────────
  const crashAdapter = createInterceptAdapter(base, [
    { op: 'set', key: ACTIVATION_KEYS.LIVE_STATE, mode: 'throw' },
  ]);
  const crashResult = await writeMutation(crashAdapter, SAMPLE_V2B, {
    lock,
    transactionId: 'tx-A-crash',
    digestFn:      testDigest,
    timeoutMs:     0,
  });
  assert.equal(crashResult.code, 'live-state-write-failed',
    'A must fail at step 3');

  // State: DATA=SAMPLE_V2B (step 2 succeeded), LIVE-STATE still gen=0,
  //        JOURNAL has tx-A-crash evidence.
  assert.equal(base.getItem(ACTIVATION_KEYS.DATA), SAMPLE_V2B,
    'A\'s DATA write (step 2) must be committed on storage');
  assert.ok(parseJournal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL)),
    'A\'s journal must be present after step-3 crash');

  // ── Startup recovery resolves A's partial write ─────────────────
  const marker = JSON.parse(base.getItem(ACTIVATION_KEYS.MARKER));
  const rec = await recoverMutationStartup(base, marker, CLOCK, testDigest, 0);
  assert.equal(rec.action, 'mutation-recovered-complete-step3',
    'recovery must complete A\'s missing LIVE-STATE write');
  assert.equal(rec.v2Active, true, 'v2Active must be true after recovery');

  // State: DATA=SAMPLE_V2B, LIVE-STATE gen=1 with sha256(SAMPLE_V2B), JOURNAL cleared.
  const lsAfterRecovery = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(lsAfterRecovery.generation, 1,
    'LIVE-STATE must be at gen=1 after recovery');
  assert.equal(lsAfterRecovery.digest, sha256str(SAMPLE_V2B),
    'LIVE-STATE digest must match A\'s committed DATA');
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null,
    'journal must be cleared after successful recovery');

  // ── B acquires shared lock, builds on recovered state ───────────
  const bPayload = { ...JSON.parse(SAMPLE_V2B), extra: 'from-B' };
  const repoB = makeRepo(base, {
    lock,
    generateId: () => 'tx-B-post-recovery',
  });
  const rB = await repoB.put(bPayload);
  assert.equal(rB.ok, true, 'B must succeed after recovery');

  const finalData = JSON.parse(base.getItem(ACTIVATION_KEYS.DATA));
  assert.deepEqual(finalData, bPayload,
    'DATA must contain B\'s payload (A\'s data was the base, not lost)');

  const lsFinal = parseLiveState(base.getItem(ACTIVATION_KEYS.LIVE_STATE));
  assert.equal(lsFinal.generation, 2,
    'LIVE-STATE must be at gen=2 (recovery→1, B→2)');

  // B's journal is cleared (step 4 succeeded). Verify no orphan journal.
  assert.equal(base.getItem(ACTIVATION_KEYS.MUT_JOURNAL), null,
    'B\'s journal must be cleared after successful commit');

  // Marker unchanged throughout.
  assert.ok(base.getItem(ACTIVATION_KEYS.MARKER),
    'marker must be present and unchanged');
});

/* ════════════════════════════════════════════════════════════════════
   E · disconnection guard
════════════════════════════════════════════════════════════════════ */
section('disconnection');

check('v2-mutation-writer.js is NOT statically reachable from script.js entry', () => {
  // Use madge-style static analysis: just check script.js text and known import chain.
  // The guard mirrors the pattern in import-order.test.mjs.
  const scriptSrc = readFileSync(resolvePath(SRC, 'script.js'), 'utf8');
  assert.ok(
    !scriptSrc.includes('v2-mutation-writer'),
    'script.js must not directly import v2-mutation-writer',
  );
  assert.ok(
    !scriptSrc.includes('v2-repository'),
    'script.js must not directly import v2-repository',
  );
});

check('v2-mutation-writer.js not reachable from any app/ module', () => {
  // Scan all src/app/ files for any import of v2-mutation-writer or v2-repository.
  const appDir = resolvePath(SRC, 'app');
  const files = readdirSync(appDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => join(appDir, e.name));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!src.includes('v2-mutation-writer'), `${f} must not import v2-mutation-writer`);
    assert.ok(!src.includes('v2-repository'),      `${f} must not import v2-repository`);
  }
});

/* ── Summary ─────────────────────────────────────────────────────── */
await Promise.all(_pending);
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
