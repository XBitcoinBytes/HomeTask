/**
 * v2-shadow.test.mjs — CP4A suite: pure disconnected shadow-migration runner.
 *
 * Covers (corrected per CP4A review):
 *   1 · shadow-api         Constants, exports, SHA-256 fingerprint primitives.
 *   2 · sync-adapter       Happy path with synchronous memory adapter.
 *   3 · async-adapter      Happy path with Promise-based delayed adapter.
 *   4 · idempotency        Byte-identical output; fingerprint sensitivity.
 *   5 · failure-inject     22+ failure modes + digest-rejection modes.
 *   6 · privacy-scan       verificationSummary contains no household content.
 *   7 · completion-ev      completionEvents in shadow context.
 *   8 · utf8-size          Size limit measured in UTF-8 bytes (not characters).
 *   9 · timeout            Adapter/digest timeout with injected mock scheduler.
 *  10 · harness-self-test  Negative self-test: harness exits nonzero on delayed failure.
 *  11 · failed-shadow-sem  Semantics of failed vs verified shadow candidates.
 *  12 · disconnection      Shadow runner not reachable from production code.
 *
 * Standalone Node ESM. No browser, no real storage, no clock reads.
 * Run with:  node artifacts/home-tasks/tests/v2-shadow.test.mjs
 */

import assert  from 'node:assert/strict';
import { createHash }  from 'node:crypto';
import { spawnSync }   from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG }   from '../src/v2/catalog.data.js';
import { migrate }   from '../src/v2/migrate.js';
import {
  buildCanonicalEncoding,
  buildFingerprint,
  webCryptoDigest,
  fingerprintsMatch,
  isCanonicalFingerprint,
} from '../src/v2/shadow-fingerprint.js';
import {
  runShadowMigration,
  SOURCE_KEYS, SHADOW_KEY, SHADOW_SCHEMA_VERSION, SHADOW_SIZE_LIMIT, ADAPTER_TIMEOUT_MS,
} from '../src/v2/shadow-migrate.js';
import { FIXTURES, FIXED_TODAY, D } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = resolvePath(HERE, '../src');
const FIXTURE_PATH = resolvePath(HERE, 'harness-fixture-fail.mjs');

/* ── Test harness ──────────────────────────────────────────────────── */
let group = '', pass = 0, fail = 0;
const _pending = [];   // all Promises — awaited before summary so no check can be silently dropped
function check(name, fn) {
  const p = Promise.resolve().then(() => fn()).then(
    () => { pass++; },
    e  => { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); },
  );
  _pending.push(p);
  return p;
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/* ── Fast test digest (Node.js crypto — test-only, not imported in production modules) */
function testDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ── Test adapters ─────────────────────────────────────────────────── */

/** Synchronous in-memory adapter. */
function makeSync(initial = {}) {
  const store = { ...initial };
  return {
    getItem:    (k) => store[k] ?? null,
    setItem:    (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
    _snapshot: () => ({ ...store }),
  };
}

/** Async Promise-based adapter with configurable delays (ms). */
function makeAsync(initial = {}, readMs = 8, writeMs = 8) {
  const store = { ...initial };
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  return {
    getItem:    async (k) => { await delay(readMs);  return store[k] ?? null; },
    setItem:    async (k, v) => { await delay(writeMs); store[k] = v; },
    removeItem: async (k) => { await delay(1); delete store[k]; },
    get _store() { return store; },
    _snapshot: () => ({ ...store }),
  };
}

/** Adapter whose setItem succeeds syntactically but the write is silently lost. */
function makeSilentLostWriteAdapter(initial = {}) {
  const store = { ...initial };
  return {
    getItem:    (k) => store[k] ?? null,
    setItem:    (_k, _v) => { /* intentionally do not write */ },
    removeItem: (k) => { delete store[k]; },
  };
}

/** Adapter that throws on getItem for a specific key. */
function makeReadFailAdapter(initial = {}, failKey) {
  const store = { ...initial };
  return {
    getItem:    (k) => { if (k === failKey) throw new Error(`simulated read failure for ${k}`); return store[k] ?? null; },
    setItem:    (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
  };
}

/** Adapter that throws on setItem for a specific key. */
function makeWriteFailAdapter(initial = {}, failKey) {
  const store = { ...initial };
  return {
    getItem:    (k) => store[k] ?? null,
    setItem:    (k, v) => { if (k === failKey) throw new Error(`simulated write failure for ${k}`); store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
  };
}

/** Async adapter that rejects reads/writes for a specific key. */
function makeAsyncRejectAdapter(initial = {}, rejectKey, rejectOp = 'read') {
  const store = { ...initial };
  return {
    getItem:    async (k) => {
      if (k === rejectKey && rejectOp === 'read') return Promise.reject(new Error(`async read rejected for ${k}`));
      return store[k] ?? null;
    },
    setItem:    async (k, v) => {
      if (k === rejectKey && rejectOp === 'write') return Promise.reject(new Error(`async write rejected for ${k}`));
      store[k] = v;
    },
    removeItem: async (k) => { delete store[k]; },
    get _store() { return store; },
  };
}

/** Adapter that mutates source key on every read AFTER the shadow key is written. */
function makeMutateAfterShadowWriteAdapter(initial = {}, mutatedKey, mutatedValue) {
  const store = { ...initial };
  let shadowWritten = false;
  return {
    getItem:    (k) => {
      if (shadowWritten && k === mutatedKey) return mutatedValue;
      return store[k] ?? null;
    },
    setItem:    (k, v) => { store[k] = v; if (k === SHADOW_KEY) shadowWritten = true; },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
  };
}

/** Adapter where source key reads return a mutated value after the N-th source read. */
function makeMutateDuringRunAdapter(initial = {}, mutatedKey, mutatedValue, mutateAfterN = 3) {
  const store = { ...initial };
  let sourceReadCount = 0;
  return {
    getItem:    (k) => {
      if (SOURCE_KEYS.includes(k)) {
        sourceReadCount++;
        if (sourceReadCount > mutateAfterN && k === mutatedKey) return mutatedValue;
      }
      return store[k] ?? null;
    },
    setItem:    (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    get _store() { return store; },
  };
}

/**
 * Mock scheduler for deterministic timeout tests.
 * Timeouts are registered with ids; flush() triggers all pending ones synchronously.
 * No real-time delays — the runner's withTimeout wrapper fires the timeout when flush() is called.
 */
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

/**
 * Adapter that never-settles (returns new Promise(() => {})) for a specific key/op.
 * Used with makeMockScheduler() to test timeout handling deterministically.
 */
function makeNeverSettleAdapter(initial = {}, neverKey, neverOp = 'read') {
  const store = { ...initial };
  return {
    getItem: k => {
      if (k === neverKey && neverOp === 'read') return new Promise(() => {});  // never settles
      return store[k] ?? null;
    },
    setItem: (k, v) => {
      if (k === neverKey && neverOp === 'write') return new Promise(() => {});  // never settles
      store[k] = v;
    },
    removeItem: k => { delete store[k]; },
    get _store() { return store; },
  };
}

/* ── Fixture stores ─────────────────────────────────────────────────── */

const TYPICAL_STORE = {
  'hometask-v1':                 FIXTURES.typical.v1TasksRaw,
  'hometask-meta-v1':            FIXTURES.typical.v1MetaRaw,
  'hometask-recent-searches-v1': FIXTURES.typical.v1RecentsRaw,
};

/**
 * Default shadow-migration context (all injected, no clock reads).
 * Includes testDigest for faster test runs (Node.js crypto vs Web Crypto).
 * Tests that override _testHooks must use withHooks() to preserve testDigest.
 */
const CTX = {
  catalog:    CATALOG,
  today:      FIXED_TODAY,
  clock:      '2026-08-01T00:00:00.000Z',
  appBuild:   'v19',
  _testHooks: { digest: testDigest },
};

/**
 * Merge additional test hooks into CTX without losing the default testDigest.
 * Usage: withHooks({ migrate: myMigrate }) → { ...CTX, _testHooks: { digest: testDigest, migrate: myMigrate } }
 */
function withHooks(hooks) {
  return { ...CTX, _testHooks: { ...CTX._testHooks, ...hooks } };
}

const WITH_WITNESS = { ...CTX, witnessKeys: ['hometask-v19'] };

/** Run with typical store + optional witness key, merging _testHooks safely. */
function runTypical(adapterOverride, ctxOverride = {}) {
  const store = { ...TYPICAL_STORE, 'hometask-v19': 'unrelated-app-data' };
  const adapter = adapterOverride ?? makeSync(store);
  const mergedHooks = { ...CTX._testHooks, ...(ctxOverride._testHooks ?? {}) };
  return runShadowMigration({ adapter, witnessKeys: ['hometask-v19'], ...CTX, ...ctxOverride, _testHooks: mergedHooks });
}

/* ═══════════════════════════════════════════════════════════════════ */
/*  1 · shadow-api                                                     */
/* ═══════════════════════════════════════════════════════════════════ */
section('shadow-api');
check('SOURCE_KEYS is the exact approved list', () => {
  assert.deepEqual([...SOURCE_KEYS], ['hometask-v1', 'hometask-meta-v1', 'hometask-recent-searches-v1']);
});
check('SHADOW_KEY is the dedicated versioned shadow key', () => {
  assert.equal(SHADOW_KEY, 'hometask-v2-shadow');
  assert.ok(!SOURCE_KEYS.includes(SHADOW_KEY), 'shadow key must not be in SOURCE_KEYS');
});
check('SHADOW_SCHEMA_VERSION is 1', () => { assert.equal(SHADOW_SCHEMA_VERSION, 1); });
check('SHADOW_SIZE_LIMIT is exactly 2 MB (measured in UTF-8 bytes)', () => {
  assert.equal(SHADOW_SIZE_LIMIT, 2 * 1024 * 1024);
});
check('ADAPTER_TIMEOUT_MS is exported as a positive number', () => {
  assert.ok(typeof ADAPTER_TIMEOUT_MS === 'number' && ADAPTER_TIMEOUT_MS > 0,
    'ADAPTER_TIMEOUT_MS must be a positive number');
});
check('buildCanonicalEncoding is exported and returns a Uint8Array', () => {
  const bytes = buildCanonicalEncoding({ 'hometask-v1': '[]', 'hometask-meta-v1': null });
  assert.ok(bytes instanceof Uint8Array, 'must return Uint8Array');
  assert.ok(bytes.length > 0, 'must not be empty');
});
check('webCryptoDigest is exported and produces 64-char lowercase hex (SHA-256)', async () => {
  const bytes = new TextEncoder().encode('hello');
  const hex = await webCryptoDigest(bytes);
  assert.equal(hex.length, 64, 'SHA-256 hex must be 64 chars');
  assert.match(hex, /^[0-9a-f]{64}$/, 'must be lowercase hex');
});
check('buildFingerprint is async and produces 64-char lowercase hex for the same input', async () => {
  const map = { 'hometask-v1': '[]', 'hometask-meta-v1': '{}' };
  const a = await buildFingerprint(map, testDigest);
  const b = await buildFingerprint(map, testDigest);
  assert.equal(a, b, 'identical inputs must produce identical digest');
  assert.equal(a.length, 64, 'SHA-256 hex must be 64 chars');
  assert.match(a, /^[0-9a-f]{64}$/, 'must be lowercase hex');
});
check('buildFingerprint: key-order independent (canonical encoding sorts keys)', async () => {
  const a = await buildFingerprint({ 'hometask-v1': '[]', 'hometask-meta-v1': '{}' }, testDigest);
  const b = await buildFingerprint({ 'hometask-meta-v1': '{}', 'hometask-v1': '[]' }, testDigest);
  assert.equal(a, b, 'fingerprint must be canonical regardless of insertion order');
});
check('buildFingerprint: null is distinct from empty string ""', async () => {
  const fNull  = await buildFingerprint({ 'k': null }, testDigest);
  const fEmpty = await buildFingerprint({ 'k': '' }, testDigest);
  assert.notEqual(fNull, fEmpty, 'null and "" must produce different digests');
  assert.equal(fNull.length, 64);
  assert.equal(fEmpty.length, 64);
});
check('buildFingerprint: Unicode characters encoded consistently (UTF-8 length-prefixed)', async () => {
  const a1 = await buildFingerprint({ 'k': 'café' }, testDigest);
  const a2 = await buildFingerprint({ 'k': 'café' }, testDigest);
  const b  = await buildFingerprint({ 'k': 'cafe' }, testDigest);   // without accent
  assert.equal(a1, a2, 'accented input must produce stable digest');
  assert.notEqual(a1, b, 'accented vs non-accented must differ');
});
check('buildFingerprint: delimiter-like content cannot create ambiguity (length-prefixed)', async () => {
  // All three have different key/value partitions but similar raw bytes.
  const a = await buildFingerprint({ 'a:b': 'c' }, testDigest);
  const b = await buildFingerprint({ 'a': 'b:c' }, testDigest);
  const c = await buildFingerprint({ 'a': 'b', ':c': '' }, testDigest);
  assert.notEqual(a, b, 'colon in key vs value must produce different digest');
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});
check('buildFingerprint: single-character mutation changes digest', async () => {
  const base = await buildFingerprint({ 'hometask-v1': 'hello world' }, testDigest);
  const mut1 = await buildFingerprint({ 'hometask-v1': 'hello xorld' }, testDigest);
  const mut2 = await buildFingerprint({ 'hometask-v1': 'hello worl\x00' }, testDigest);
  assert.notEqual(base, mut1, 'single char change must change digest');
  assert.notEqual(base, mut2, 'null-byte injection must change digest');
  assert.notEqual(mut1, mut2);
});
check('buildFingerprint: async digest functions are awaited before returning', async () => {
  let called = false;
  const delayedDigest = async (bytes) => {
    await new Promise(r => setTimeout(r, 5));
    called = true;
    return testDigest(bytes);
  };
  const fp = await buildFingerprint({ 'k': 'v' }, delayedDigest);
  assert.ok(called, 'async digest must be awaited before result is returned');
  assert.equal(fp.length, 64);
});
check('isCanonicalFingerprint: accepts 64-char lowercase hex, rejects everything else', () => {
  assert.ok( isCanonicalFingerprint('a'.repeat(64)),            '64 a-chars is valid');
  assert.ok( isCanonicalFingerprint('0123456789abcdef'.repeat(4)), '16-char pattern × 4 is valid');
  assert.ok(!isCanonicalFingerprint('a'.repeat(63)),            '63 chars → false');
  assert.ok(!isCanonicalFingerprint('a'.repeat(65)),            '65 chars → false');
  assert.ok(!isCanonicalFingerprint('A'.repeat(64)),            'uppercase → false');
  assert.ok(!isCanonicalFingerprint('g'.repeat(64)),            'non-hex char → false');
  assert.ok(!isCanonicalFingerprint(''),                        'empty string → false');
  assert.ok(!isCanonicalFingerprint(null),                      'null → false');
  assert.ok(!isCanonicalFingerprint(undefined),                 'undefined → false');
  assert.ok(!isCanonicalFingerprint(42),                        'number → false');
  assert.ok(!isCanonicalFingerprint([]),                        'array → false');
  assert.ok(!isCanonicalFingerprint({}),                        'object → false');
});
check('fingerprintsMatch: equal valid 64-char lowercase SHA-256 digests → true', () => {
  const hex64a = 'a'.repeat(64);
  const hex64b = '0123456789abcdef'.repeat(4);
  assert.ok( fingerprintsMatch(hex64a, hex64a), 'identical 64-a strings must match');
  assert.ok( fingerprintsMatch(hex64b, hex64b), 'identical hex-pattern strings must match');
});
check('fingerprintsMatch: different valid digests → false', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.ok(!fingerprintsMatch(a, b), 'different valid digests must not match');
  assert.ok(!fingerprintsMatch(b, a), 'symmetric: must also be false');
});
check('fingerprintsMatch: equal short strings → false (length not validated ≠ canonical)', () => {
  assert.ok(!fingerprintsMatch('abc', 'abc'),  'equal 3-char strings → false');
  assert.ok(!fingerprintsMatch('', ''),         'equal empty strings → false');
});
check('fingerprintsMatch: 63-char and 65-char strings → false (must be exactly 64)', () => {
  assert.ok(!fingerprintsMatch('a'.repeat(63), 'a'.repeat(63)), '63-char → false');
  assert.ok(!fingerprintsMatch('a'.repeat(65), 'a'.repeat(65)), '65-char → false');
});
check('fingerprintsMatch: uppercase hexadecimal → false (canonical is lowercase only)', () => {
  const upper64 = 'A'.repeat(64);
  const lower64 = 'a'.repeat(64);
  assert.ok(!fingerprintsMatch(upper64, upper64), 'uppercase equal → false');
  assert.ok(!fingerprintsMatch(upper64, lower64), 'uppercase vs lowercase → false');
});
check('fingerprintsMatch: non-hex characters → false', () => {
  assert.ok(!fingerprintsMatch('g'.repeat(64), 'g'.repeat(64)), 'non-hex char "g" → false');
  assert.ok(!fingerprintsMatch(' '.repeat(64), ' '.repeat(64)), 'space → false');
  const mixedInvalid = 'z'.repeat(64);
  assert.ok(!fingerprintsMatch(mixedInvalid, mixedInvalid), '"z" × 64 → false');
});
check('fingerprintsMatch: null, undefined, numbers, arrays, objects → false', () => {
  const valid = 'a'.repeat(64);
  assert.ok(!fingerprintsMatch(null,      valid), 'null a → false');
  assert.ok(!fingerprintsMatch(valid,     null),  'null b → false');
  assert.ok(!fingerprintsMatch(undefined, valid), 'undefined a → false');
  assert.ok(!fingerprintsMatch(valid, undefined), 'undefined b → false');
  assert.ok(!fingerprintsMatch(42,        valid), 'number a → false');
  assert.ok(!fingerprintsMatch(valid,     42),    'number b → false');
  assert.ok(!fingerprintsMatch([],        valid), 'array a → false');
  assert.ok(!fingerprintsMatch({},        valid), 'object a → false');
  assert.ok(!fingerprintsMatch(null,      null),  'null, null → false');
  assert.ok(!fingerprintsMatch(42,        42),    'number, number → false');
});
check('fingerprintsMatch: two equal malformed values → false (equal malformed ≠ match)', () => {
  const short  = 'abc';
  const upper  = 'ABCDEF'.repeat(10).slice(0, 64);  // uppercase, 64 chars
  const nonHex = 'g'.repeat(64);
  assert.ok(!fingerprintsMatch(short,  short),  'equal short strings → false');
  assert.ok(!fingerprintsMatch(upper,  upper),  'equal uppercase → false');
  assert.ok(!fingerprintsMatch(nonHex, nonHex), 'equal non-hex → false');
});
check('runShadowMigration returns structured failure for missing adapter', async () => {
  const r = await runShadowMigration({ adapter: null, ...CTX });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  assert.ok(Array.isArray(r.warnings));
  assert.equal(r.wrapper, undefined, 'no wrapper on failure');
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  2 · sync-adapter (happy path)                                      */
/* ═══════════════════════════════════════════════════════════════════ */
section('sync-adapter');
check('typical v1 data → verified shadow via synchronous adapter', async () => {
  const store = { ...TYPICAL_STORE, 'hometask-v19': 'unrelated-data' };
  const adapter = makeSync(store);
  const r = await runShadowMigration({ adapter, ...CTX, witnessKeys: ['hometask-v19'] });

  assert.equal(r.ok, true, `unexpected failure: ${JSON.stringify(r.errors)}`);
  assert.equal(r.status, 'verified');
  assert.ok(r.wrapper, 'wrapper must be returned on success');
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});
check('shadow wrapper has exact required fields', async () => {
  const r = await runTypical();
  const w = r.wrapper;
  assert.equal(w.shadowSchemaVersion, SHADOW_SCHEMA_VERSION);
  assert.equal(w.sourceSchema, 1);
  assert.equal(w.targetSchema, 2);
  assert.equal(w.generatedAt, CTX.clock);
  assert.equal(w.appBuild, CTX.appBuild);
  assert.equal(w.catalogVersion, CATALOG.catalogVersion);
  assert.equal(w.status, 'verified');
  // SHA-256 produces 64-char lowercase hex.
  assert.ok(typeof w.sourceFingerprint === 'string' && w.sourceFingerprint.length === 64,
    `sourceFingerprint must be 64-char hex, got "${w.sourceFingerprint?.slice(0, 16)}..." (len ${w.sourceFingerprint?.length})`);
  assert.match(w.sourceFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(w.candidate && w.candidate.schemaVersion === 2, 'candidate must be the v2 envelope');
  assert.ok(w.verificationSummary, 'verificationSummary must be present');
});
check('candidate has all 9 canonical envelope fields', async () => {
  const r = await runTypical();
  const c = r.wrapper.candidate;
  const fields = ['schemaVersion','state','prefs','userZones','userTasks',
                  'completionEvents','overrides','recentSearches','meta'];
  assert.deepEqual(Object.keys(c), fields);
  assert.ok(Array.isArray(c.completionEvents), 'completionEvents must be an array');
});
check('shadow key is written; source keys remain byte-identical', async () => {
  const store = { ...TYPICAL_STORE, 'hometask-v19': 'witness-data' };
  const adapter = makeSync(store);
  const before = adapter._snapshot();
  await runShadowMigration({ adapter, ...CTX, witnessKeys: ['hometask-v19'] });

  assert.ok(typeof adapter._store[SHADOW_KEY] === 'string', 'shadow key must be written');
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k], before[k], `source key "${k}" must not be modified`);
  }
  assert.equal(adapter._store['hometask-v19'], 'witness-data', 'witness key must not be modified');
});
check('shadow key is NOT written to source-key space', async () => {
  const r = await runTypical();
  assert.ok(r.ok);
  assert.ok(!SOURCE_KEYS.includes(SHADOW_KEY));
});
check('shadow wrapper is valid JSON parseable back to original wrapper', async () => {
  const store = { ...TYPICAL_STORE };
  const adapter = makeSync(store);
  await runShadowMigration({ adapter, ...CTX });
  const raw = adapter._store[SHADOW_KEY];
  assert.ok(typeof raw === 'string');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.status, 'verified');
  assert.equal(parsed.shadowSchemaVersion, SHADOW_SCHEMA_VERSION);
  assert.ok(typeof parsed.sourceFingerprint === 'string' && parsed.sourceFingerprint.length === 64);
});
check('verificationSummary has correct structure and types', async () => {
  const r = await runTypical();
  const vs = r.wrapper.verificationSummary;
  for (const k of ['stateCount','userZoneCount','userTaskCount','completionEventCount','overrideCount','recentSearchCount']) {
    assert.ok(typeof vs[k] === 'number', `${k} must be a number`);
  }
  assert.ok(typeof vs.repairsFromMigration === 'object');
  assert.ok(typeof vs.repairsFromMigration.droppedUnknownIdsCount === 'number');
  assert.ok(Array.isArray(vs.repairsFromMigration.sanitizedFieldCategories));
  assert.ok(typeof vs.repairsFromMigration.roomFilterResolved === 'boolean');
  assert.ok(typeof vs.repairsFromMigration.dueNowDefaultFold === 'boolean');
  assert.equal(vs.unexpectedDiffCount, 0);
  assert.deepEqual(vs.diffCategoryCodes, []);
});
check('verificationSummary counts match actual v2 envelope content', async () => {
  const r = await runTypical();
  const c = r.wrapper.candidate;
  const vs = r.wrapper.verificationSummary;
  assert.equal(vs.stateCount,           c.state.length);
  assert.equal(vs.userZoneCount,        c.userZones.length);
  assert.equal(vs.userTaskCount,        c.userTasks.length);
  assert.equal(vs.completionEventCount, c.completionEvents.length);
  assert.equal(vs.overrideCount,        Object.keys(c.overrides).length);
  assert.equal(vs.recentSearchCount,    c.recentSearches.length);
});
check('runner returns byteSize on success matching TextEncoder byte count', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true);
  assert.ok(typeof r.byteSize === 'number' && r.byteSize > 0, 'byteSize must be returned');
  const raw = adapter._store[SHADOW_KEY];
  const manualByteLen = new TextEncoder().encode(raw).byteLength;
  assert.equal(r.byteSize, manualByteLen, 'byteSize must equal TextEncoder byte count');
});
check('fresh install (all null source keys) → verified shadow with zero counts', async () => {
  const adapter = makeSync({});
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true, `fresh install should succeed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.wrapper.verificationSummary.stateCount, 0);
  assert.equal(r.wrapper.verificationSummary.recentSearchCount, 0);
  assert.equal(r.wrapper.candidate.state.length, 0);
  assert.deepEqual(r.wrapper.candidate.completionEvents, []);
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  3 · async-adapter (happy path)                                     */
/* ═══════════════════════════════════════════════════════════════════ */
section('async-adapter');
check('typical v1 data → verified shadow via async adapter with delays', async () => {
  const store = { ...TYPICAL_STORE, 'hometask-v19': 'witness' };
  const adapter = makeAsync(store, 8, 8);
  const r = await runShadowMigration({ adapter, ...CTX, witnessKeys: ['hometask-v19'] });
  assert.equal(r.ok, true, `async happy path failed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.status, 'verified');
  assert.equal(r.wrapper.candidate.schemaVersion, 2);
  assert.equal(r.wrapper.verificationSummary.unexpectedDiffCount, 0);
});
check('async adapter: source keys byte-identical after run', async () => {
  const store = { ...TYPICAL_STORE };
  const adapter = makeAsync(store, 8, 8);
  await runShadowMigration({ adapter, ...CTX });
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k], TYPICAL_STORE[k] ?? null, `source key "${k}" was modified`);
  }
});
check('async adapter: shadow wrapper parseable with exact schema', async () => {
  const adapter = makeAsync({ ...TYPICAL_STORE }, 5, 5);
  await runShadowMigration({ adapter, ...CTX });
  const parsed = JSON.parse(adapter._store[SHADOW_KEY]);
  assert.equal(parsed.shadowSchemaVersion, SHADOW_SCHEMA_VERSION);
  assert.equal(parsed.sourceSchema, 1);
  assert.equal(parsed.targetSchema, 2);
  assert.equal(parsed.status, 'verified');
  assert.ok(typeof parsed.sourceFingerprint === 'string' && parsed.sourceFingerprint.length === 64);
});
check('async adapter: delayed reads and writes both complete correctly', async () => {
  const adapter = makeAsync({ ...TYPICAL_STORE }, 20, 20);
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true);
  assert.ok(adapter._store[SHADOW_KEY], 'shadow must be written after delayed writes');
});
check('async adapter rejection on source read → structured failure, no success', async () => {
  for (const failKey of SOURCE_KEYS) {
    const adapter = makeAsyncRejectAdapter({ ...TYPICAL_STORE }, failKey, 'read');
    const r = await runShadowMigration({ adapter, ...CTX });
    assert.equal(r.ok, false, `expected failure when "${failKey}" read rejects`);
    assert.equal(r.status, 'failed');
    assert.ok(r.errors.some(e => e.includes(failKey)), `error must name the failing key`);
    assert.equal(r.wrapper, undefined, 'no wrapper on failure');
    for (const k of SOURCE_KEYS.filter(k => k !== failKey)) {
      assert.equal(adapter._store[k], TYPICAL_STORE[k] ?? null);
    }
  }
});
check('async adapter rejection on shadow write → structured failure, v1 unchanged', async () => {
  const adapter = makeAsyncRejectAdapter({ ...TYPICAL_STORE }, SHADOW_KEY, 'write');
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(r.errors.some(e => e.includes('write failed') || e.includes('write failure') || e.includes(SHADOW_KEY)));
  for (const k of SOURCE_KEYS) assert.equal(adapter._store[k], TYPICAL_STORE[k] ?? null);
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  4 · idempotency                                                    */
/* ═══════════════════════════════════════════════════════════════════ */
section('idempotency');
check('identical inputs → byte-identical candidate, summary, and fingerprint', async () => {
  const r1 = await runShadowMigration({ adapter: makeSync({ ...TYPICAL_STORE }), ...CTX });
  const r2 = await runShadowMigration({ adapter: makeSync({ ...TYPICAL_STORE }), ...CTX });
  assert.equal(r1.ok, true); assert.equal(r2.ok, true);
  assert.deepEqual(r1.wrapper.candidate, r2.wrapper.candidate);
  assert.deepEqual(r1.wrapper.verificationSummary, r2.wrapper.verificationSummary);
  assert.equal(r1.wrapper.sourceFingerprint, r2.wrapper.sourceFingerprint);
});
check('re-running with identical inputs replaces the shadow with the same bytes', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({ adapter, ...CTX });
  const firstShadow = adapter._store[SHADOW_KEY];
  const r2 = await runShadowMigration({ adapter, ...CTX });
  const secondShadow = adapter._store[SHADOW_KEY];
  assert.equal(r2.ok, true);
  assert.equal(firstShadow, secondShadow, 'identical re-run must produce byte-identical shadow');
});
check('source fingerprint changes when any source value changes', async () => {
  const r0 = await runShadowMigration({ adapter: makeSync({ ...TYPICAL_STORE }), ...CTX });
  const altStore = { ...TYPICAL_STORE, 'hometask-v1': '[]' };
  const r1 = await runShadowMigration({ adapter: makeSync(altStore), ...CTX });
  assert.notEqual(r0.wrapper.sourceFingerprint, r1.wrapper.sourceFingerprint,
    'fingerprint must change when source changes');
  assert.equal(r1.wrapper.verificationSummary.stateCount, 0);
});
check('re-running does not modify v1 source keys', async () => {
  const store = { ...TYPICAL_STORE };
  const adapter = makeSync(store);
  await runShadowMigration({ adapter, ...CTX });
  await runShadowMigration({ adapter, ...CTX });
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k], TYPICAL_STORE[k] ?? null, `source key "${k}" modified on re-run`);
  }
});
check('identical verified shadow replacement is harmless and deterministic', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r1.status, 'verified');
  const r2 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r2.status, 'verified');
  assert.equal(r2.ok, true, 'replacing an identical verified shadow must succeed');
  assert.deepEqual(r2.wrapper, r1.wrapper, 'wrapper must be byte-identical');
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  5 · failure-injection                                              */
/* ═══════════════════════════════════════════════════════════════════ */
section('failure-inject');

/** Assert all failure invariants for a failed run result. */
function assertFailureInvariants(r, _adapterBefore, msg = '') {
  assert.equal(r.ok, false, `expected failure: ${msg}`);
  assert.equal(r.status, 'failed', `status must be "failed": ${msg}`);
  assert.equal(r.wrapper, undefined, `no wrapper on failure: ${msg}`);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `errors must be non-empty: ${msg}`);
  assert.ok(!r.errors.some(e => e.toLowerCase().includes('success')));
}

check('missing v1 source key (null) does not throw — migrate handles gracefully', async () => {
  const adapter = makeSync({ 'hometask-meta-v1': FIXTURES.typical.v1MetaRaw });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true, `missing source key should not fail: ${JSON.stringify(r.errors)}`);
  assert.equal(r.wrapper.candidate.state.length, 0);
});
check('missing meta key (null) does not throw — migrate uses defaults', async () => {
  const adapter = makeSync({ 'hometask-v1': FIXTURES.typical.v1TasksRaw });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true, `missing meta key: ${JSON.stringify(r.errors)}`);
  assert.equal(r.wrapper.candidate.prefs.viewMode, 'today');
});
check('missing recents key (null) does not throw — migrate treats as empty', async () => {
  const adapter = makeSync({
    'hometask-v1': FIXTURES.typical.v1TasksRaw,
    'hometask-meta-v1': FIXTURES.typical.v1MetaRaw,
  });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true, `missing recents key: ${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.wrapper.candidate.recentSearches, []);
});
check('malformed v1 task storage — migrate sanitizes, runner does not throw', async () => {
  const adapter = makeSync({
    'hometask-v1': FIXTURES.malformedRecords?.v1TasksRaw ?? '{"not":"an array"}',
    'hometask-meta-v1': FIXTURES.malformedRecords?.v1MetaRaw ?? '{}',
    'hometask-recent-searches-v1': null,
  });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.ok(r && typeof r === 'object', 'runner must return a result object');
  assert.ok(Array.isArray(r.errors), 'errors must be an array');
  assert.ok(typeof r.ok === 'boolean', 'ok must be boolean');
  assert.ok(!r.errors.some(e => /uncaught|internal crash|cannot read/i.test(e)),
    `unexpected internal error: ${JSON.stringify(r.errors)}`);
});
check('malformed v1 metadata — migrate uses defaults, runner succeeds', async () => {
  const adapter = makeSync({
    'hometask-v1': FIXTURES.typical.v1TasksRaw,
    'hometask-meta-v1': 'not valid json {{{',
    'hometask-recent-searches-v1': null,
  });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true, `malformed meta: ${JSON.stringify(r.errors)}`);
  assert.equal(r.wrapper.candidate.prefs.viewMode, 'today');
});
check('malformed recent-search storage — migrate treats as empty, runner succeeds', async () => {
  const adapter = makeSync({
    'hometask-v1': FIXTURES.typical.v1TasksRaw,
    'hometask-meta-v1': FIXTURES.typical.v1MetaRaw,
    'hometask-recent-searches-v1': '"not an array"',
  });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true, `malformed recents: ${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.wrapper.candidate.recentSearches, []);
});
check('read failure for each source key → structured failure, no success', async () => {
  for (const failKey of SOURCE_KEYS) {
    const store = { ...TYPICAL_STORE };
    const adapter = makeReadFailAdapter(store, failKey);
    const r = await runShadowMigration({ adapter, ...CTX });
    assertFailureInvariants(r, adapter._store ?? store, `read failure on "${failKey}"`);
    assert.ok(r.errors.some(e => e.includes(failKey) || e.includes('read failure')),
      `error must name failing key "${failKey}"`);
    for (const k of SOURCE_KEYS.filter(k => k !== failKey)) {
      assert.equal(adapter._store?.[k] ?? store[k], store[k]);
    }
  }
});
check('migration exception (via _testHooks) → structured failure, no exception escapes', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({ migrate: () => { throw new Error('simulated migration bug'); } }),
  });
  assertFailureInvariants(r, {}, 'migration exception');
  assert.ok(r.errors.some(e => e.includes('migration threw') || e.includes('migration bug')));
  assert.ok(!adapter._store[SHADOW_KEY], 'shadow must NOT be written after migration exception');
});
check('envelope validation failure (via _testHooks) → structured failure', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        delete res.v2.completionEvents;  // sabotage: remove required field
        return res;
      },
    }),
  });
  assertFailureInvariants(r, {}, 'envelope validation failure');
  assert.ok(r.errors.some(e => e.includes('envelope validation')));
});
check('deliberate state loss → equivalence failure → structured failure, refuses verified', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.state = [];  // drop all state records
        return res;
      },
    }),
  });
  assert.equal(r.ok, false, 'state loss must be detected and rejected');
  assert.equal(r.status, 'failed');
  assert.ok(r.errors.some(e => e.includes('equivalence') || e.includes('unexpected difference')));
  if (adapter._store[SHADOW_KEY]) {
    const written = JSON.parse(adapter._store[SHADOW_KEY]);
    assert.equal(written.status, 'failed', 'written shadow must have status: failed');
    assert.ok(written.verificationSummary.unexpectedDiffCount > 0);
  }
});
check('deliberate preference loss → equivalence failure → structured failure', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.prefs = { ...res.v2.prefs, viewMode: 'today' === res.v2.prefs.viewMode ? 'all' : 'today' };
        return res;
      },
    }),
  });
  assert.equal(r.ok, false, 'preference loss must be detected');
  assert.ok(r.errors.some(e => e.includes('equivalence') || e.includes('unexpected difference') || e.includes('PREFERENCE')));
});
check('deliberate tag loss → equivalence failure → structured failure', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.state = res.v2.state.map(s => ({ ...s, tags: [] }));
        return res;
      },
    }),
  });
  assert.equal(r.ok, false, 'tag loss must be detected');
  assert.ok(r.errors.some(e => e.includes('equivalence') || e.includes('TAGS') || e.includes('unexpected')));
});
check('deliberate skip loss → equivalence failure → structured failure', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.state = res.v2.state.map(s => ({ ...s, skipUntil: null }));
        return res;
      },
    }),
  });
  assert.equal(r.ok, false, 'skip loss must be detected');
  assert.ok(r.errors.some(e => e.includes('equivalence') || e.includes('unexpected')));
});
check('shadow-size overflow → structured failure, v1 unchanged', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        // 25,000 × 100-char ASCII strings ≈ 2.5 MB in bytes — reliably exceeds the 2 MB limit.
        res.v2.recentSearches = Array.from({ length: 25_000 }, () => 'x'.repeat(100));
        return res;
      },
    }),
  });
  assertFailureInvariants(r, {}, 'shadow size overflow');
  assert.ok(r.errors.some(e => e.includes('size limit') || e.includes('exceeds')));
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k], TYPICAL_STORE[k] ?? null, `source key "${k}" was modified`);
  }
});
check('shadow write failure → structured failure, v1 unchanged', async () => {
  const adapter = makeWriteFailAdapter({ ...TYPICAL_STORE }, SHADOW_KEY);
  const r = await runShadowMigration({ adapter, ...CTX });
  assertFailureInvariants(r, {}, 'shadow write failure');
  assert.ok(r.errors.some(e => e.includes('write') || e.includes(SHADOW_KEY)));
  for (const k of SOURCE_KEYS) {
    assert.equal(adapter._store[k] ?? null, TYPICAL_STORE[k] ?? null);
  }
});
check('silent lost write (adapter lies about write) → detected via readback → structured failure', async () => {
  const adapter = makeSilentLostWriteAdapter({ ...TYPICAL_STORE });
  const r = await runShadowMigration({ adapter, ...CTX });
  assertFailureInvariants(r, {}, 'silent lost write');
  assert.ok(r.errors.some(e => e.includes('readback') || e.includes('mismatch')),
    `expected readback error, got: ${JSON.stringify(r.errors)}`);
});
check('source key changing after shadow write → detected in step 13 → structured failure', async () => {
  const adapter = makeMutateAfterShadowWriteAdapter({ ...TYPICAL_STORE }, 'hometask-v1', '[]');
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, false, 'source mutation after write must be detected');
  assert.ok(r.errors.some(e => e.includes('changed during shadow run') || e.includes('hometask-v1')));
});
check('source key changing during run → detected in step 13 → structured failure', async () => {
  const adapter = makeMutateDuringRunAdapter({ ...TYPICAL_STORE }, 'hometask-v1', '[]', 3);
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, false, 'source mutation during run must be detected');
  assert.ok(r.errors.some(e => e.includes('changed during shadow run') || e.includes('hometask-v1')));
});
check('existing verified shadow + failed run → previous verified shadow preserved', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r1.status, 'verified');
  const verifiedRaw = adapter._store[SHADOW_KEY];

  // Mutate a source key so the fingerprint differs from the existing wrapper.
  // This ensures the early-exit (Step 2b) does not fire — the full run executes
  // and hits the injected failure, proving the existing verified wrapper is protected.
  adapter._store['hometask-recent-searches-v1'] = JSON.stringify(['modified-search']);

  const r2 = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.state = [];  // deliberate loss
        return res;
      },
    }),
  });
  assert.equal(r2.ok, false, 'failed run must not succeed');
  assert.equal(r2.preservedExistingVerified, true, 'must report that existing verified shadow was preserved');
  assert.equal(adapter._store[SHADOW_KEY], verifiedRaw, 'existing verified shadow must not be overwritten');
});
check('existing malformed shadow + new successful run → overwrites', async () => {
  const store = { ...TYPICAL_STORE, [SHADOW_KEY]: 'not valid json {{{' };
  const adapter = makeSync(store);
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true, `should succeed: ${JSON.stringify(r.errors)}`);
  const written = JSON.parse(adapter._store[SHADOW_KEY]);
  assert.equal(written.status, 'verified');
});
check('unrelated keys present → not modified by any run path', async () => {
  const store = {
    ...TYPICAL_STORE,
    'hometask-v19':               'app-state-data',
    'hometask-import-staging-v1': 'staging-tx-data',
    'hometask-backup-v1':         'backup-snapshot',
    'hometask-recovery-v1':       'recovery-record',
    'unrelated-app-key':          'other-app-data',
  };
  const adapter = makeSync(store);
  await runShadowMigration({ adapter, ...CTX, witnessKeys: ['hometask-v19', 'hometask-backup-v1'] });
  for (const k of Object.keys(store)) {
    if (k === SHADOW_KEY) continue;
    assert.equal(adapter._store[k], store[k], `key "${k}" must not be modified`);
  }
});
check('no exception escapes when adapter throws in unexpected ways', async () => {
  const evilAdapter = {
    getItem: () => { throw new TypeError('boom'); },
    setItem: () => {},
    removeItem: () => {},
  };
  let result;
  try { result = await runShadowMigration({ adapter: evilAdapter, ...CTX }); }
  catch (e) { assert.fail(`exception must not escape: ${e.message}`); }
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
});
check('failed run with unknown droppedUnknownIds still returns structured result', async () => {
  const store = {
    'hometask-v1':                 FIXTURES.retiredAndUnknown.v1TasksRaw,
    'hometask-meta-v1':            FIXTURES.retiredAndUnknown.v1MetaRaw,
    'hometask-recent-searches-v1': null,
  };
  const adapter = makeSync(store);
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(typeof r.ok, 'boolean', 'result must have ok field');
  if (r.ok) {
    assert.equal(r.wrapper.verificationSummary.repairsFromMigration.droppedUnknownIdsCount, 1);
    const summaryJson = JSON.stringify(r.wrapper.verificationSummary);
    assert.ok(!summaryJson.includes('ghost'), 'unknown ID "ghost-task" must not leak into summary');
  }
});
check('digest rejection → structured failure, no shadow written', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({ digest: () => Promise.reject(new Error('simulated digest failure')) }),
  });
  assert.equal(r.ok, false, 'digest rejection must produce structured failure');
  assert.equal(r.status, 'failed');
  assert.ok(r.errors.some(e => e.includes('digest') || e.includes('source digest')),
    `error must mention digest: ${JSON.stringify(r.errors)}`);
  assert.ok(!adapter._store[SHADOW_KEY], 'shadow must NOT be written when digest fails');
});
check('digest rejection with existing verified shadow → verified shadow preserved', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r1.status, 'verified');
  const verifiedRaw = adapter._store[SHADOW_KEY];

  const r2 = await runShadowMigration({
    adapter, ...withHooks({ digest: () => { throw new Error('digest died'); } }),
  });
  assert.equal(r2.ok, false, 'digest failure must not succeed');
  // Digest fails before reaching the "check existing shadow" step; shadow untouched.
  assert.equal(adapter._store[SHADOW_KEY], verifiedRaw, 'verified shadow must be preserved after digest failure');
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  6 · privacy-scan                                                   */
/* ═══════════════════════════════════════════════════════════════════ */
section('privacy-scan');

const SENSITIVE_STRINGS = [
  'mb-floor', 'mb-baseboards', 'mb-doorknob', 'md-floor', 'md-cobweb', 'smoke-batteries', 'to-floor',
  'deep-clean',
  'oven', 'windows',
  D.today, D.yesterday, D.lastWeek, D.monthAgo, D.longAgo, D.tomorrow, D.nextWeek,
  "Madi's Room", 'Kitchen', 'Master Bedroom', 'Master Bathroom',
  'guided', '2026-06-01T10:00:00.000Z',
];

check('verificationSummary contains no task IDs, tags, dates, zone titles, or user text', async () => {
  const r = await runTypical();
  assert.equal(r.ok, true);
  const summaryJson = JSON.stringify(r.wrapper.verificationSummary);
  for (const s of SENSITIVE_STRINGS) {
    assert.ok(!summaryJson.includes(s), `sensitive string "${s}" leaked into verificationSummary`);
  }
});
check('verificationSummary contains no room filter value (only boolean)', async () => {
  const r = await runTypical();
  const summaryJson = JSON.stringify(r.wrapper.verificationSummary);
  assert.ok(!summaryJson.includes('z_madis-room'), 'zone id must not appear in summary');
  assert.ok(!summaryJson.includes("Madi"), 'room name must not appear in summary');
  assert.equal(r.wrapper.verificationSummary.repairsFromMigration.roomFilterResolved, true);
});
check('dropped unknown IDs do not appear in verificationSummary', async () => {
  const store = {
    'hometask-v1':                 FIXTURES.retiredAndUnknown.v1TasksRaw,
    'hometask-meta-v1':            FIXTURES.retiredAndUnknown.v1MetaRaw,
    'hometask-recent-searches-v1': null,
  };
  const r = await runShadowMigration({ adapter: makeSync(store), ...CTX });
  if (!r.ok) return;
  const summaryJson = JSON.stringify(r.wrapper.verificationSummary);
  assert.ok(!summaryJson.includes('ghost-task'), '"ghost-task" must not appear in summary');
  assert.ok(!summaryJson.includes('ghost'), '"ghost" must not appear in summary');
  assert.ok(r.wrapper.verificationSummary.repairsFromMigration.droppedUnknownIdsCount >= 1);
});
check('sanitizedFieldCategories contains field names only, no task IDs or values', async () => {
  const store = {
    'hometask-v1': FIXTURES.malformedRecords?.v1TasksRaw ?? JSON.stringify([{ id: 'mb-floor', lastDone: 'not-a-date' }]),
    'hometask-meta-v1': '{}',
    'hometask-recent-searches-v1': null,
  };
  const r = await runShadowMigration({ adapter: makeSync(store), ...CTX });
  if (!r.ok) return;
  const cats = r.wrapper.verificationSummary.repairsFromMigration.sanitizedFieldCategories;
  for (const cat of cats) {
    assert.ok(!cat.includes('mb-') && !cat.includes('md-') && !cat.includes('smoke'),
      `category "${cat}" appears to contain a task ID`);
    assert.ok(typeof cat === 'string' && cat.length > 0, `empty category`);
  }
});
check('diff category codes contain no task IDs, titles, or values', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.state = [];
        return res;
      },
    }),
  });
  assert.equal(r.ok, false);
  if (adapter._store[SHADOW_KEY]) {
    const written = JSON.parse(adapter._store[SHADOW_KEY]);
    const codes = written.verificationSummary.diffCategoryCodes;
    for (const code of codes) {
      for (const s of ['mb-floor', 'deep-clean', '2026', 'Madi']) {
        assert.ok(!code.includes(s), `sensitive content "${s}" in diff code "${code}"`);
      }
      assert.match(code, /^[A-Z_:]+$/, `diff code must be UPPER_SNAKE_CASE: "${code}"`);
    }
    assert.ok(written.verificationSummary.unexpectedDiffCount > 0);
  }
});
check('source fingerprint contains no source content (64-char hex)', async () => {
  // SHA-256 hex digits 0–9a–f never contain task titles, tags, or dates.
  const fp = await buildFingerprint({ 'hometask-v1': FIXTURES.typical.v1TasksRaw }, testDigest);
  assert.match(fp, /^[0-9a-f]{64}$/, 'fingerprint must be 64-char pure hex');
  for (const s of ['mb-floor', 'deep-clean', 'oven', FIXED_TODAY]) {
    assert.ok(!fp.includes(s), `sensitive content "${s}" in fingerprint`);
  }
});
check('the full shadow wrapper does not store raw duplicate v1 values', async () => {
  const r = await runTypical();
  const wrapperJson = JSON.stringify(r.wrapper);
  const rawV1 = FIXTURES.typical.v1TasksRaw;
  assert.ok(!wrapperJson.includes(rawV1), 'raw v1 source string must not appear verbatim in shadow wrapper');
  const rawMeta = FIXTURES.typical.v1MetaRaw;
  assert.ok(!wrapperJson.includes(rawMeta), 'raw v1 meta string must not appear verbatim in shadow wrapper');
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  7 · completion-events in shadow context                            */
/* ═══════════════════════════════════════════════════════════════════ */
section('completion-ev');
check('completionEvents is always [] after v1 migration — never fabricated from lastDone', async () => {
  const r = await runTypical();
  assert.equal(r.ok, true);
  assert.deepEqual(r.wrapper.candidate.completionEvents, []);
  assert.equal(r.wrapper.verificationSummary.completionEventCount, 0);
});
check('completionEvents: [] satisfies the canonical envelope check', async () => {
  const r = await runTypical();
  assert.ok(Array.isArray(r.wrapper.candidate.completionEvents), 'must be array');
  assert.equal(r.wrapper.candidate.completionEvents.length, 0, 'must be empty for v1 migration');
});
check('completionEvents included in candidate size calculation (does not undercount)', async () => {
  const r = await runTypical();
  assert.ok(r.ok);
  const wrapperJson = JSON.stringify(r.wrapper);
  assert.ok(wrapperJson.includes('"completionEvents":[]'),
    'completionEvents must appear in serialized wrapper');
});
check('completionEvents privacy: no completion dates appear in verificationSummary (count only)', async () => {
  const r = await runTypical();
  const summaryJson = JSON.stringify(r.wrapper.verificationSummary);
  assert.ok(!summaryJson.includes('2026'), 'no dates in verificationSummary');
  assert.equal(r.wrapper.verificationSummary.completionEventCount, 0);
});
check('completionEvents absence does not break equivalence check', async () => {
  const r = await runTypical();
  assert.equal(r.wrapper.verificationSummary.unexpectedDiffCount, 0);
  assert.deepEqual(r.wrapper.verificationSummary.diffCategoryCodes, []);
});
check('size limit includes completionEvents field in size calculation', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.completionEvents = Array.from({ length: 25_000 }, (_, i) =>
          ({ id: `c_${i.toString().padStart(5,'0')}`, taskId: 'mb-floor', completedOn: D.lastWeek, durationMinutes: null })
        );
        return res;
      },
    }),
  });
  assert.equal(r.ok, false, 'padded completionEvents must trigger size limit');
  assert.ok(r.errors.some(e => e.includes('size limit') || e.includes('exceeds')));
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  8 · utf8-size — size limit measured in UTF-8 bytes                */
/* ═══════════════════════════════════════════════════════════════════ */
section('utf8-size');
check('SHADOW_SIZE_LIMIT is measured in UTF-8 bytes (multi-byte chars > char count)', () => {
  // Sanity-check: a multi-byte char has byteLen > charLen.
  const emoji = '🏠';  // U+1F3E0: 4 UTF-8 bytes, 2 JS code units
  const bytes = new TextEncoder().encode(emoji);
  assert.ok(bytes.length > emoji.length, `emoji must have more bytes (${bytes.length}) than JS chars (${emoji.length})`);
  // Limit is 2 × 1024 × 1024 = 2,097,152 bytes.
  assert.equal(SHADOW_SIZE_LIMIT, 2 * 1024 * 1024);
});
check('typical shadow well below UTF-8 byte limit; byteSize matches TextEncoder', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r.ok, true);
  assert.ok(r.byteSize < SHADOW_SIZE_LIMIT, `byteSize (${r.byteSize}) must be below limit`);
  const raw = adapter._store[SHADOW_KEY];
  const manualByteLen = new TextEncoder().encode(raw).byteLength;
  assert.equal(r.byteSize, manualByteLen, 'reported byteSize must equal TextEncoder.encode().byteLength');
});
check('ASCII overflow: error message includes byte count and char count', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.recentSearches = Array.from({ length: 25_000 }, () => 'x'.repeat(100));
        return res;
      },
    }),
  });
  assert.equal(r.ok, false);
  const errMsg = r.errors.join(' ');
  assert.ok(errMsg.includes('bytes'), `error must say "bytes": ${errMsg}`);
  assert.ok(/\d{7,}/.test(errMsg), `error must include the large byte count: ${errMsg}`);
  assert.ok(errMsg.includes('chars'), `error must say "chars": ${errMsg}`);
});
check('accented multi-byte chars: byteLen > charLen and reported correctly', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.recentSearches = ['café', 'naïve', 'résumé', 'crème brûlée'];
        return res;
      },
    }),
  });
  assert.equal(r.ok, true, `accented chars should not fail: ${JSON.stringify(r.errors)}`);
  const raw = adapter._store[SHADOW_KEY];
  const byteLen = new TextEncoder().encode(raw).byteLength;
  const charLen = raw.length;
  assert.ok(byteLen > charLen,
    `expect byteLen (${byteLen}) > charLen (${charLen}) due to multi-byte chars`);
  assert.equal(r.byteSize, byteLen, 'reported byteSize must equal actual UTF-8 byte count');
});
check('emoji surrogate pairs: UTF-8 byte count is 4 bytes per emoji code point', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        res.v2.recentSearches = ['🏠 kitchen', '🛁 bathroom', '🛏️ bedroom'];
        return res;
      },
    }),
  });
  assert.equal(r.ok, true, `emoji test failed: ${JSON.stringify(r.errors)}`);
  const raw = adapter._store[SHADOW_KEY];
  const byteLen = new TextEncoder().encode(raw).byteLength;
  assert.equal(r.byteSize, byteLen, 'emoji: reported byteSize must equal TextEncoder byte count');
  assert.ok(r.byteSize > raw.length, 'emoji should cause byteSize > charLen');
});
check('char count below limit but UTF-8 byte count above → size failure (CJK chars = 3 bytes each)', async () => {
  // Each CJK char is ~3 UTF-8 bytes. Fill just enough to push bytes over 2 MB while
  // char count is below it (chars ≈ LIMIT/3 ≈ 699k, bytes ≈ 2.1 MB).
  const cjkChar = '\u4e2d';  // 中, 3 UTF-8 bytes
  const totalChars = Math.ceil(SHADOW_SIZE_LIMIT / 3) + 2_000;
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => {
        const res = migrate(input, ctx);
        // Pack CJK chars into many short search strings.
        res.v2.recentSearches = Array.from({ length: Math.ceil(totalChars / 50) }, () => cjkChar.repeat(50));
        return res;
      },
    }),
  });
  assert.equal(r.ok, false, 'CJK overflow must trigger size failure (byte count > limit, char count < limit)');
  assert.ok(r.errors.some(e => e.includes('size limit') || e.includes('exceeds')),
    `expected size error: ${JSON.stringify(r.errors)}`);
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  9 · timeout — adapter/digest timeout with mock scheduler           */
/* ═══════════════════════════════════════════════════════════════════ */
section('timeout');
check('ADAPTER_TIMEOUT_MS is a production-intended positive number (≥ 1000 ms)', () => {
  assert.ok(typeof ADAPTER_TIMEOUT_MS === 'number');
  assert.ok(ADAPTER_TIMEOUT_MS >= 1000, 'production timeout must be at least 1 second');
});
check('never-settling source read → structured failure via injected mock scheduler', async () => {
  // The first source read (SOURCE_KEYS[0]) never settles.
  // withTimeout registers the timeout synchronously; flushing fires it immediately.
  const scheduler = makeMockScheduler();
  const adapter = makeNeverSettleAdapter({ ...TYPICAL_STORE }, SOURCE_KEYS[0], 'read');
  const runPromise = runShadowMigration({
    adapter, ...CTX, timeoutMs: 1000, scheduler,
  });
  // Timeout for SOURCE_KEYS[0] read is registered synchronously during the first await.
  scheduler.flush();
  const r = await runPromise;
  assert.equal(r.ok, false, 'never-settling read must fail');
  assert.equal(r.status, 'failed');
  assert.ok(r.errors.some(e => e.includes('timed out') || e.includes('timeout')),
    `expected timeout error: ${JSON.stringify(r.errors)}`);
});
check('never-settling source read: v1 source keys remain unchanged', async () => {
  const scheduler = makeMockScheduler();
  const adapter = makeNeverSettleAdapter({ ...TYPICAL_STORE }, SOURCE_KEYS[0], 'read');
  const runPromise = runShadowMigration({ adapter, ...CTX, timeoutMs: 1000, scheduler });
  scheduler.flush();
  await runPromise;
  // Only the first key fails; others remain as-is.
  for (const k of SOURCE_KEYS.slice(1)) {
    assert.equal(adapter._store[k] ?? null, TYPICAL_STORE[k] ?? null,
      `source key "${k}" must not be modified after read timeout`);
  }
});
check('never-settling digest → structured failure, no shadow written', async () => {
  // Poll until the digest is called (synchronously in buildFingerprint), then flush.
  let digestCalled = false;
  const neverDigest = () => { digestCalled = true; return new Promise(() => {}); };
  const scheduler = makeMockScheduler();
  const adapter = makeSync({ ...TYPICAL_STORE });
  const runPromise = runShadowMigration({
    adapter, timeoutMs: 1000, scheduler,
    ...withHooks({ digest: neverDigest }),
  });
  // Poll until neverDigest is called (source reads complete, digest step reached).
  while (!digestCalled) await Promise.resolve();
  // Now the digest timeout is registered — flush it.
  scheduler.flush();
  const r = await runPromise;
  assert.equal(r.ok, false, 'never-settling digest must fail');
  assert.ok(r.errors.some(e => e.includes('timed out') || e.includes('digest')),
    `expected digest timeout: ${JSON.stringify(r.errors)}`);
  assert.ok(!adapter._store[SHADOW_KEY], 'shadow must not be written after digest timeout');
});
check('never-settling shadow write → structured failure, v1 unchanged', async () => {
  // Use a write-flag adapter: setItem for SHADOW_KEY returns a never-settling Promise.
  // Poll until the write is attempted, then flush the mock scheduler.
  let writeAttempted = false;
  const store = { ...TYPICAL_STORE };
  const controlledAdapter = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => {
      if (k === SHADOW_KEY) {
        writeAttempted = true;
        return new Promise(() => {});  // never settles — timeout will fire
      }
      store[k] = v;
    },
    removeItem: k => { delete store[k]; },
    get _store() { return store; },
  };
  const scheduler = makeMockScheduler();
  const runPromise = runShadowMigration({ adapter: controlledAdapter, ...CTX, timeoutMs: 1000, scheduler });
  // Poll until the write is attempted (all reads + migration + serialization complete).
  while (!writeAttempted) await Promise.resolve();
  scheduler.flush();  // fire the write timeout
  const r = await runPromise;
  assert.equal(r.ok, false, 'never-settling write must fail');
  assert.ok(r.errors.some(e => e.includes('timed out') || e.includes('write')),
    `expected timeout/write error: ${JSON.stringify(r.errors)}`);
  for (const k of SOURCE_KEYS) {
    assert.equal(store[k] ?? null, TYPICAL_STORE[k] ?? null,
      `source key "${k}" must not be modified after write timeout`);
  }
});
check('timeout with existing verified shadow → verified shadow remains intact', async () => {
  // First establish a verified shadow.
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r1.status, 'verified');
  const verifiedRaw = adapter._store[SHADOW_KEY];

  // Second run fails on read timeout.
  const scheduler = makeMockScheduler();
  const neverReadAdapter = makeNeverSettleAdapter({ ...TYPICAL_STORE }, SOURCE_KEYS[0], 'read');
  neverReadAdapter._store[SHADOW_KEY] = verifiedRaw;  // copy verified shadow in
  const runPromise = runShadowMigration({ adapter: neverReadAdapter, ...CTX, timeoutMs: 1000, scheduler });
  scheduler.flush();
  const r2 = await runPromise;
  assert.equal(r2.ok, false, 'read timeout must fail');
  // Verified shadow was never touched (failure happened before write step).
  assert.equal(neverReadAdapter._store[SHADOW_KEY], verifiedRaw,
    'verified shadow must survive a timeout-induced failure');
});
check('late-reject after timeout → no unhandled rejection', async () => {
  // Adapter whose source read rejects AFTER the timeout fires.
  let lateRejectFn;
  const store = { ...TYPICAL_STORE };
  const controlledAdapter = {
    getItem: k => {
      if (k === SOURCE_KEYS[0]) return new Promise((_, reject) => { lateRejectFn = reject; });
      return store[k] ?? null;
    },
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; },
  };

  const unhandled = [];
  const onUnhandled = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  const scheduler = makeMockScheduler();
  const runPromise = runShadowMigration({ adapter: controlledAdapter, ...CTX, timeoutMs: 1000, scheduler });
  scheduler.flush();  // fire timeout; withTimeout's .catch(() => {}) swallows future rejects
  const r = await runPromise;
  assert.equal(r.ok, false, 'timeout must produce failure result');

  // Now late-reject the original never-settling promise.
  lateRejectFn?.(new Error('late rejection from controlled adapter'));
  await new Promise(res => setTimeout(res, 20));  // let microtasks settle

  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled.length, 0,
    `late-reject must be swallowed, not become unhandled rejection: ${unhandled.map(e => e?.message ?? e).join(', ')}`);
});
check('timeoutMs=0 disables timeout (adapter ops pass through without race)', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({ adapter, ...CTX, timeoutMs: 0 });
  assert.equal(r.ok, true, 'timeoutMs=0 must not cause failure for fast sync adapter');
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  10 · harness-self-test                                             */
/* ═══════════════════════════════════════════════════════════════════ */
section('harness-self-test');
check('harness fixture exits with code 1 when an async check fails after a delay', () => {
  // Runs harness-fixture-fail.mjs as a child process and verifies it exits nonzero.
  // This proves the repaired _pending harness catches delayed async failures.
  const result = spawnSync(process.execPath, [FIXTURE_PATH], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1,
    `fixture must exit 1; got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
});
check('harness fixture output reports "1 failed" before exiting', () => {
  const result = spawnSync(process.execPath, [FIXTURE_PATH], { encoding: 'utf8', timeout: 10_000 });
  const output = result.stdout + result.stderr;
  assert.ok(output.includes('1 failed'),
    `fixture output must include "1 failed". Output: ${output}`);
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  11 · failed-shadow-semantics                                       */
/* ═══════════════════════════════════════════════════════════════════ */
section('failed-shadow-semantics');
check('failed wrapper has status: "failed" and never "verified"', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  if (adapter._store[SHADOW_KEY]) {
    const written = JSON.parse(adapter._store[SHADOW_KEY]);
    assert.equal(written.status, 'failed', 'written wrapper must have status: "failed"');
    assert.notEqual(written.status, 'verified');
  }
});
check('failed wrapper does not satisfy CP4B promotion criteria (status + schemaVersion check)', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  if (adapter._store[SHADOW_KEY]) {
    const written = JSON.parse(adapter._store[SHADOW_KEY]);
    // CP4B will require: status === 'verified' AND shadowSchemaVersion === SHADOW_SCHEMA_VERSION.
    const wouldBePromoted = written.status === 'verified' &&
                            written.shadowSchemaVersion === SHADOW_SCHEMA_VERSION;
    assert.ok(!wouldBePromoted,
      'failed wrapper must not satisfy CP4B promotion criteria');
    // Diagnostic data IS present (for debugging).
    assert.ok(written.candidate, 'failed wrapper must have candidate for diagnostics');
    assert.ok(written.verificationSummary, 'failed wrapper must have verificationSummary');
    assert.ok(written.verificationSummary.unexpectedDiffCount > 0, 'diff count must be non-zero');
  }
});
check('successful run overwrites a previous failed wrapper', async () => {
  // Step 1: write a failed wrapper.
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  assert.equal(r1.ok, false);
  const failedRaw = adapter._store[SHADOW_KEY];

  // Step 2: successful run must overwrite the failed wrapper.
  const r2 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r2.ok, true, 'successful run must succeed');
  const newWrapper = JSON.parse(adapter._store[SHADOW_KEY]);
  assert.equal(newWrapper.status, 'verified', 'successful run must produce verified wrapper');
  assert.notEqual(adapter._store[SHADOW_KEY], failedRaw, 'failed wrapper must be replaced');
});
check('failed run with existing verified shadow → preservedExistingVerified: true', async () => {
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r1.status, 'verified');
  const verifiedRaw = adapter._store[SHADOW_KEY];

  // Mutate a source key so the fingerprint differs and Step 2b early-exit does not fire.
  adapter._store['hometask-recent-searches-v1'] = JSON.stringify(['modified-search']);

  const r2 = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.preservedExistingVerified, true, 'must report that existing verified shadow was preserved');
  assert.equal(adapter._store[SHADOW_KEY], verifiedRaw, 'verified shadow must not be overwritten by failed run');
});
check('existingIsVerified check requires BOTH status==="verified" AND correct shadowSchemaVersion', async () => {
  // A wrapper with wrong shadowSchemaVersion must not be treated as verified.
  const wrongVersionWrapper = JSON.stringify({
    shadowSchemaVersion: 9999,  // wrong version
    status: 'verified',
    candidate: {},
  });
  const adapter = makeSync({ ...TYPICAL_STORE, [SHADOW_KEY]: wrongVersionWrapper });

  // A failed run with a wrong-version "verified" shadow should NOT preserve it.
  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  assert.equal(r.ok, false);
  // preservedExistingVerified must be false (wrong version → not treated as verified).
  assert.equal(r.preservedExistingVerified, false,
    'wrong shadowSchemaVersion must not be treated as a verified shadow to protect');
});
check('malformed "verified" wrapper with short fingerprint is not trusted', async () => {
  // Wrapper claims status: "verified" but sourceFingerprint is short (not canonical 64-char hex).
  // Full wrapper validation must reject it — equal short fingerprints do not count as matching.
  const malformedWrapper = JSON.stringify({
    shadowSchemaVersion: SHADOW_SCHEMA_VERSION,
    status:              'verified',
    sourceFingerprint:   'abc',    // short — not canonical
    targetSchema:        2,
    candidate:           {},       // also fails envelope validation
    verificationSummary: { unexpectedDiffCount: 0, diffCategoryCodes: [] },
  });
  const adapter = makeSync({ ...TYPICAL_STORE, [SHADOW_KEY]: malformedWrapper });

  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.preservedExistingVerified, false,
    'wrapper with short/malformed sourceFingerprint must not be treated as a verified shadow');
});
check('wrapper with valid-looking fingerprint but invalid candidate is not trusted', async () => {
  // Status and fingerprint look correct, but candidate fails envelope validation.
  // Full wrapper validation must reject it.
  const invalidCandidateWrapper = JSON.stringify({
    shadowSchemaVersion: SHADOW_SCHEMA_VERSION,
    status:              'verified',
    sourceFingerprint:   'a'.repeat(64),   // canonical 64-char hex
    targetSchema:        2,
    candidate:           { schemaVersion: 2 },   // missing 8 of 9 required envelope fields
    verificationSummary: { unexpectedDiffCount: 0, diffCategoryCodes: [] },
  });
  const adapter = makeSync({ ...TYPICAL_STORE, [SHADOW_KEY]: invalidCandidateWrapper });

  const r = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.preservedExistingVerified, false,
    'wrapper with invalid candidate envelope must not be treated as a verified shadow');
});
check('genuinely valid verified wrapper passes full validation and is protected from failed rerun', async () => {
  // Build a real verified wrapper via a normal run, then confirm the new full validation
  // still recognises it and protects it from a subsequent failed run.
  const adapter = makeSync({ ...TYPICAL_STORE });
  const r1 = await runShadowMigration({ adapter, ...CTX });
  assert.equal(r1.status, 'verified', `setup: first run must be verified: ${JSON.stringify(r1.errors)}`);
  const verifiedRaw = adapter._store[SHADOW_KEY];

  // Mutate a source key so the fingerprint differs and Step 2b early-exit does not fire.
  // This proves the late-stage preservation guard (Step 10b) still works when source has changed.
  adapter._store['hometask-recent-searches-v1'] = JSON.stringify(['modified-search']);

  // Sabotage the second run so it fails equivalence.
  const r2 = await runShadowMigration({
    adapter, ...withHooks({
      migrate: (input, ctx) => { const res = migrate(input, ctx); res.v2.state = []; return res; },
    }),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.preservedExistingVerified, true,
    'genuine verified wrapper must pass full validation and be protected');
  assert.equal(adapter._store[SHADOW_KEY], verifiedRaw,
    'verified shadow must not be overwritten by a failed rerun');
});

/* ═══════════════════════════════════════════════════════════════════ */
/*  12 · disconnection-guard                                           */
/* ═══════════════════════════════════════════════════════════════════ */
section('disconnection');

function readSrc(relPath) {
  return readFileSync(resolvePath(SRC, relPath), 'utf8');
}
function srcImports(file) {
  const content = readSrc(file);
  return [...content.matchAll(/^\s*import\s+.+from\s+['"](.+)['"]/gm)].map(m => m[1]);
}
function srcContains(file, pattern) {
  return readSrc(file).includes(pattern);
}

check('src/script.js does not import shadow-migrate (runtime disconnection)', () => {
  const imports = srcImports('script.js');
  assert.ok(!imports.some(i => i.includes('shadow-migrate')),
    `script.js must not import shadow-migrate; found: ${imports.filter(i => i.includes('shadow')).join(', ')}`);
});
check('no src/app module imports shadow-migrate', () => {
  const appFiles = [
    'app/storage.js', 'app/startup.js', 'app/tasks.js', 'app/status.js', 'app/search.js',
    'app/recents.js', 'app/scroll-lock.js', 'app/ui.js', 'app/onboarding.js',
    'app/backup-store.js', 'app/staging-store.js', 'app/backup.js', 'app/backup-ui.js', 'app/app.js',
  ];
  for (const f of appFiles) {
    let content;
    try { content = readSrc(f); } catch { continue; }
    assert.ok(!content.includes('shadow-migrate'), `${f} must not import shadow-migrate`);
  }
});
check('src/script.js does not reference hometask-v2-shadow key', () => {
  assert.ok(!srcContains('script.js', 'hometask-v2-shadow'), 'script.js must not reference the shadow key');
});
check('no src/app module references hometask-v2-shadow', () => {
  const appFiles = [
    'app/storage.js', 'app/startup.js', 'app/tasks.js', 'app/backup-store.js',
    'app/staging-store.js', 'app/backup.js', 'app/backup-ui.js', 'app/app.js',
  ];
  for (const f of appFiles) {
    let content;
    try { content = readSrc(f); } catch { continue; }
    assert.ok(!content.includes('hometask-v2-shadow'),
      `${f} must not reference the shadow key "hometask-v2-shadow"`);
  }
});
check('shadow-fingerprint.js has no imports (fully self-contained, environment-neutral)', () => {
  const imports = srcImports('v2/shadow-fingerprint.js');
  // Zero imports: no node: builtins, no external packages, no relative modules.
  assert.deepEqual(imports, [], `shadow-fingerprint.js must have zero imports, got: ${imports.join(', ')}`);
  // Must not use any Node-only 'node:' modules (verified above via import list).
  const nodeImports = imports.filter(i => i.startsWith('node:'));
  assert.deepEqual(nodeImports, [], `shadow-fingerprint.js must not use node: imports: ${nodeImports.join(', ')}`);
  const content = readSrc('v2/shadow-fingerprint.js');
  for (const bad of ['localStorage', 'sessionStorage', 'document', 'window', 'Date.now()']) {
    assert.ok(!content.includes(bad), `shadow-fingerprint.js must not use "${bad}"`);
  }
});
check('shadow-migrate.js does not read localStorage, sessionStorage, or DOM', () => {
  const content = readSrc('v2/shadow-migrate.js');
  for (const bad of ['localStorage.', 'sessionStorage.', 'document.', 'new Date()']) {
    assert.ok(!content.includes(bad), `shadow-migrate.js must not use "${bad}"`);
  }
});
check('shadow-migrate.js only imports from other pure v2 modules', () => {
  const imports = srcImports('v2/shadow-migrate.js');
  for (const i of imports) {
    assert.ok(
      i.startsWith('./') || i.startsWith('../v2/') || i.startsWith('../'),
      `shadow-migrate.js has unexpected import: ${i}`,
    );
    assert.ok(!i.includes('app/') && !i.includes('script.js') && !i.includes('workload'),
      `shadow-migrate.js must not import production modules: ${i}`);
  }
});

/* ── Consecutive no-action load regression ──────────────────────────── */
section('consecutive-no-action-preservation');

check('two consecutive loads with unchanged v1 data leave shadow bytes identical', async () => {
  const adapter = makeSync({ ...FIXTURES.minimal });
  const base = { adapter, catalog: CATALOG, today: FIXED_TODAY,
    appBuild: 'v20-shadow', _testHooks: { digest: testDigest } };

  // First load: cold start, no existing shadow
  const r1 = await runShadowMigration({ ...base, clock: '2026-08-04T10:00:00.000Z' });
  assert.equal(r1.status, 'verified', 'first run must verify');
  const raw1 = adapter._store[SHADOW_KEY];
  assert.ok(typeof raw1 === 'string' && raw1.length > 0, 'shadow must be written after first run');
  const w1 = JSON.parse(raw1);

  // Second load: identical v1 data, different clock — shadow bytes must not change
  const r2 = await runShadowMigration({ ...base, clock: '2026-08-04T10:05:00.000Z' });
  assert.equal(r2.status, 'verified', 'second run must verify');
  assert.equal(r2.preservedExistingVerified, true, 'second run must report preservedExistingVerified: true');
  const raw2 = adapter._store[SHADOW_KEY];
  assert.strictEqual(raw2, raw1, 'shadow bytes must be byte-identical across two no-action loads');

  // Confirm generatedAt is the value from the FIRST run, not the second clock
  const w2 = JSON.parse(raw2);
  assert.equal(w2.generatedAt, w1.generatedAt, 'generatedAt must be unchanged on second no-action load');
  assert.equal(w2.generatedAt, '2026-08-04T10:00:00.000Z', 'generatedAt must remain the first-run timestamp');
});

check('changing v1 data after first run triggers a full re-run and new bytes', async () => {
  const adapter = makeSync({ ...FIXTURES.minimal });
  const base = { adapter, catalog: CATALOG, today: FIXED_TODAY,
    appBuild: 'v20-shadow', _testHooks: { digest: testDigest } };

  const r1 = await runShadowMigration({ ...base, clock: '2026-08-04T10:00:00.000Z' });
  assert.equal(r1.status, 'verified');
  const raw1 = adapter._store[SHADOW_KEY];

  // Mutate v1 data
  const tasks = JSON.parse(adapter._store['hometask-v1'] ?? '[]');
  if (tasks.length > 0) { tasks[0].lastDone = FIXED_TODAY; adapter._store['hometask-v1'] = JSON.stringify(tasks); }
  else { adapter._store['hometask-v1'] = JSON.stringify([{ id: 'x', title: 'X', lastDone: null }]); }

  const r2 = await runShadowMigration({ ...base, clock: '2026-08-04T10:05:00.000Z' });
  // Must re-run (preservedExistingVerified must be false — source changed)
  assert.equal(r2.preservedExistingVerified, false, 'mutated source must trigger full re-run');
  const raw2 = adapter._store[SHADOW_KEY];
  // Bytes will differ (new generatedAt at minimum)
  assert.notEqual(raw2, raw1, 'mutated source must produce new shadow bytes');
});

/* ── Final summary ─────────────────────────────────────────────────── */
// All check() calls push Promises into _pending.
// Await every one before printing results so no async check can be silently dropped.
await Promise.all(_pending);
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
