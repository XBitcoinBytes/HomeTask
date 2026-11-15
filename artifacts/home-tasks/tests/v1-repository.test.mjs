/**
 * v1-repository.test.mjs — CP5C-A1 test suite.
 *
 * Coverage:
 *   1. v1-adapter: tryRead distinguishes missing / ok / error
 *   2. v1-adapter: setAndVerify three distinct error codes
 *   3. v1-adapter: null-safe restore (prevBytes=null → removeItem+verify)
 *   4. V1Repository: loadTasks parity (first-use, merge, catalog authority)
 *   5. V1Repository: loadTasks doneToday normalization (exact v1 rule)
 *   6. V1Repository: loadTasks hardened parsing (wrong shape, malformed entries)
 *   7. V1Repository: loadTasks read-error path (no seed, mark degraded)
 *   8. V1Repository: saveTasks (success, degraded-key blocked, write failure)
 *   9. V1Repository: loadPrefs parity (defaults, merge, dueNowDefault fold)
 *  10. V1Repository: loadPrefs hardened parsing (wrong shape)
 *  11. V1Repository: loadPrefs read-error path
 *  12. V1Repository: savePrefs
 *  13. V1Repository: loadRecents / addRecent / clearRecents parity
 *  14. V1Repository: getLastExport / setLastExport (round-trip, snapshot preserved)
 *  15. V1Repository: degraded key lifecycle (set on error, cleared on success)
 *  16. Differential parity harness: reference vs V1Repository (task, prefs, recents)
 *  17. Differential parity harness: 122-task full real catalog parity case
 *
 * Run with:  node artifacts/home-tasks/tests/v1-repository.test.mjs
 */

import assert from 'node:assert/strict';
import { createV1StorageAdapter } from '../src/data/repository/v1-adapter.js';
import { V1Repository }           from '../src/data/repository/v1-repository.js';
import { CATALOG }                from '../src/v2/catalog.data.js';

/* ── Production modules (for real-execution parity section) ──────────────
   These modules reference `global.localStorage` at function-call time, not
   at import time.  Setting global.localStorage before each call routes them
   through an isolated fake backing with no cross-test contamination.
   catalog.js IIFEs run once here and print harmless validation summaries. */
import { storage }           from '../src/app/storage.js';
import { meta }              from '../src/app/meta.js';
import { recentSearches }    from '../src/app/recents.js';
import { backupStore }       from '../src/app/backup-store.js';
import { todayStr, addDays } from '../src/app/util.js';
import { SEED_TASKS }        from '../src/app/catalog.js';

/** Real calendar today — both production calls and V1Repository use this
 *  so doneToday normalization is evaluated against the same date. */
const TODAY_PROD     = todayStr();
const YESTERDAY_PROD = addDays(TODAY_PROD, -1);

/* ── Test harness ─────────────────────────────────────────────────── */

let _group = '', _pass = 0, _fail = 0;

function section(name) {
  _group = name;
  console.log(`\n── ${name}`);
}

function check(name, fn) {
  try {
    fn();
    _pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    _fail++;
    console.error(`  ✗ [${_group}] ${name}\n    ${e.message}`);
  }
}

/* ── Shared fixtures ──────────────────────────────────────────────── */

const TODAY     = '2026-08-10';
const YESTERDAY = '2026-08-09';
const TOMORROW  = '2026-08-11';

/**
 * Build a v1 SEED_TASKS-shaped catalog from CATALOG (catalog.data.js).
 * This avoids importing catalog.js which has console.assert IIFEs.
 */
const ZONE_TITLE = Object.fromEntries(CATALOG.zones.map(z => [z.id, z.title]));
const SEED_V1 = CATALOG.tasks.map(t => ({
  id:          t.id,
  title:       t.title,
  room:        ZONE_TITLE[t.zoneId],
  intervalDays: t.recurrence.every,
  safety:      t.safety,
  tags:        [],
  lastDone:    null,
  doneToday:   false,
  skipUntil:   null,
}));

/** Small synthetic catalog for isolated unit tests (not the full 122). */
const MINI_CATALOG = [
  { id: 'a1', title: 'Task Alpha',  room: 'Kitchen', intervalDays: 7,
    tags: [], lastDone: null, doneToday: false, skipUntil: null },
  { id: 'b2', title: 'Task Beta',   room: 'Bathroom', intervalDays: 14,
    tags: [], lastDone: null, doneToday: false, skipUntil: null },
  { id: 'c3', title: 'Task Gamma',  room: 'Kitchen', intervalDays: 30,
    tags: [], lastDone: null, doneToday: false, skipUntil: null },
];

/** Simple in-memory backing (no side-effect noise). */
function makeBacking(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem:    k       => (map.has(k) ? map.get(k) : null),
    setItem:    (k, v)  => { map.set(k, String(v)); },
    removeItem: k       => { map.delete(k); },
    snapshot:   ()      => Object.fromEntries(map),
    has:        k       => map.has(k),
  };
}

/** Backing whose getItem throws on the first call for a given key. */
function makeThrowGetBacking(throwKey, initial = {}) {
  const base  = makeBacking(initial);
  const fired = new Set();
  return {
    ...base,
    getItem: k => {
      if (k === throwKey && !fired.has(k)) { fired.add(k); throw new Error(`injected getItem failure on "${k}"`); }
      return base.getItem(k);
    },
  };
}

/** Backing whose setItem throws on first call for a given key. */
function makeThrowSetBacking(throwKey, initial = {}) {
  const base  = makeBacking(initial);
  const fired = new Set();
  return {
    ...base,
    setItem: (k, v) => {
      if (k === throwKey && !fired.has(k)) { fired.add(k); throw new Error(`injected setItem failure on "${k}"`); }
      base.setItem(k, v);
    },
  };
}

/** Backing whose getItem returns a different value on readback (simulates silent truncation). */
function makeTruncatingBacking(truncKey, initial = {}) {
  const base   = makeBacking(initial);
  let   writes = 0;
  return {
    ...base,
    setItem: (k, v) => {
      base.setItem(k, v);
      if (k === truncKey) writes++;
    },
    getItem: k => {
      if (k === truncKey && writes > 0) return 'TRUNCATED';
      return base.getItem(k);
    },
  };
}

/** Backing whose removeItem throws. */
function makeThrowRemoveBacking(throwKey, initial = {}) {
  const base = makeBacking(initial);
  return {
    ...base,
    removeItem: k => {
      if (k === throwKey) throw new Error(`injected removeItem failure on "${k}"`);
      base.removeItem(k);
    },
  };
}

/** Capture recovery adapter. */
function makeRecovery() {
  const calls = [];
  return {
    save:  (sourceKey, rawStr) => calls.push({ sourceKey, rawStr }),
    calls,
  };
}

/** Build a V1Repository with the mini catalog. */
function makeRepo(backingOrInitial = {}, todayStr = TODAY, recovery = null) {
  const backing = (typeof backingOrInitial.getItem === 'function')
    ? backingOrInitial
    : makeBacking(backingOrInitial);
  return new V1Repository({
    backing,
    catalog:          MINI_CATALOG,
    todayFn:          () => todayStr,
    recoveryAdapter:  recovery ?? makeRecovery(),
  });
}

/* ════════════════════════════════════════════════════════════════
   1 · v1-adapter — tryRead
   ════════════════════════════════════════════════════════════════ */
section('adapter — tryRead');

check('missing key → { status:"missing" }', () => {
  const a = createV1StorageAdapter(makeBacking());
  assert.deepEqual(a.tryRead('nope'), { status: 'missing' });
});

check('present key → { status:"ok", value }', () => {
  const a = createV1StorageAdapter(makeBacking({ foo: 'bar' }));
  assert.deepEqual(a.tryRead('foo'), { status: 'ok', value: 'bar' });
});

check('getItem throws → { status:"error", message }', () => {
  const b = makeThrowGetBacking('bad', {});
  const a = createV1StorageAdapter(b);
  const r = a.tryRead('bad');
  assert.equal(r.status, 'error');
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.length > 0);
});

check('error result has no "value" field', () => {
  const a = createV1StorageAdapter(makeThrowGetBacking('x'));
  const r = a.tryRead('x');
  assert.equal(r.status, 'error');
  assert.equal('value' in r, false);
});

check('missing result has no "value" field', () => {
  const a = createV1StorageAdapter(makeBacking());
  const r = a.tryRead('gone');
  assert.equal(r.status, 'missing');
  assert.equal('value' in r, false);
});

/* ════════════════════════════════════════════════════════════════
   2 · v1-adapter — setAndVerify error codes
   ════════════════════════════════════════════════════════════════ */
section('adapter — setAndVerify codes');

check('happy path → { ok:true }', () => {
  const b = makeBacking();
  const a = createV1StorageAdapter(b);
  const r = a.setAndVerify('k', 'hello');
  assert.deepEqual(r, { ok: true });
  assert.equal(b.getItem('k'), 'hello');
});

check('setItem throws → code:write_failed', () => {
  const b = makeThrowSetBacking('k');
  const a = createV1StorageAdapter(b);
  const r = a.setAndVerify('k', 'v');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'write_failed');
  assert.equal(typeof r.message, 'string');
});

check('write_failed: storage unchanged', () => {
  const b = makeThrowSetBacking('k', { k: 'original' });
  const a = createV1StorageAdapter(b);
  a.setAndVerify('k', 'new-value');
  assert.equal(b.getItem('k'), 'original');
});

check('readback mismatch with successful restore → readback_mismatch_restored', () => {
  // Backing: getItem returns 'original' normally, but returns 'BAD' only for the
  // SECOND getItem call on 'k' (the post-write readback). The restore setItem
  // then sets 'original' back, and the third getItem returns 'original' correctly.
  // Sequence: tryRead(prevBytes capture) → setItem(write) → getItem(readback='BAD')
  //           → setItem(restore) → getItem(restore-verify='original') → _restored.
  const b = (() => {
    const map = new Map([['k', 'original']]);
    let getCount = 0;
    return {
      getItem:    k => { getCount++; if (k === 'k' && getCount === 2) return 'BAD'; return map.get(k) ?? null; },
      setItem:    (k, v) => { map.set(k, v); },
      removeItem: k => { map.delete(k); },
    };
  })();
  const a = createV1StorageAdapter(b);
  const r = a.setAndVerify('k', 'new-value');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'readback_mismatch_restored');
  assert.equal(typeof r.message, 'string');
});

check('readback_mismatch_restored: storage returned to previous value', () => {
  // Same fixture: after the mismatch+restore cycle, the backing map holds 'original'.
  const map = new Map([['k', 'original']]);
  let getCount = 0;
  const b = {
    getItem:    k => { getCount++; if (k === 'k' && getCount === 2) return 'BAD'; return map.get(k) ?? null; },
    setItem:    (k, v) => { map.set(k, v); },
    removeItem: k => { map.delete(k); },
  };
  const a = createV1StorageAdapter(b);
  a.setAndVerify('k', 'new-value');
  // After mismatch, restore setItem('k', 'original') was called → map holds 'original'.
  assert.equal(map.get('k'), 'original', 'storage restored to previous value');
});

check('readback mismatch, restore also fails → readback_mismatch_restore_failed', () => {
  // Backing where key is absent before write (prevBytes=null), write appears to
  // succeed but readback returns non-null value, AND removeItem does nothing so
  // the restore-verify getItem also returns non-null → restore failed.
  let written = false;
  const b = {
    getItem:    () => written ? 'STUCK' : null,   // absent until write; then stuck
    setItem:    () => { written = true; },        // write appears to succeed
    removeItem: () => { /* intentional noop */ }, // remove does not clear
  };
  const a = createV1StorageAdapter(b);
  const r = a.setAndVerify('k', 'value');
  // prevBytes=null (key absent) → write → readback='STUCK'≠'value' → mismatch.
  // Restore: removeItem (noop) → getItem='STUCK'≠null → restore failed.
  assert.equal(r.ok, false);
  assert.equal(r.code, 'readback_mismatch_restore_failed');
  assert.equal(typeof r.restoreError, 'string');
});

/* ════════════════════════════════════════════════════════════════
   3 · v1-adapter — null-safe restore (prevBytes = null)
   ════════════════════════════════════════════════════════════════ */
section('adapter — null-safe restore');

check('prevBytes=null: restore uses removeItem, not setItem(null)', () => {
  // Key is absent before write; getItem returns wrong value after write.
  const removeCalls = [];
  const setNullCalls = [];
  const b = (() => {
    const map = new Map();
    return {
      getItem:    k => {
        // After the first setItem, always return 'WRONG' to trigger mismatch.
        return map.has(k) ? 'WRONG' : null;
      },
      setItem:    (k, v) => {
        if (v === null || v === undefined) setNullCalls.push(k);
        map.set(k, String(v));
      },
      removeItem: k => { removeCalls.push(k); map.delete(k); },
    };
  })();
  const a = createV1StorageAdapter(b);
  a.setAndVerify('k', 'hello');
  assert.equal(setNullCalls.length, 0, 'null was never passed to setItem');
  assert.ok(removeCalls.includes('k'), 'removeItem was called for the null-prevBytes restore');
});

check('prevBytes=null, removeItem verify passes → readback_mismatch_restored', () => {
  // Key absent; write occurs; readback wrong; restore via removeItem succeeds.
  const b = (() => {
    let written = false;
    const map = new Map();
    return {
      getItem:    k => {
        if (k === 'k' && written) return 'BAD';   // simulate mismatch
        return map.has(k) ? map.get(k) : null;
      },
      setItem:    (k, v) => { map.set(k, v); written = true; },
      removeItem: k => { map.delete(k); written = false; },
    };
  })();
  const a = createV1StorageAdapter(b);
  const r = a.setAndVerify('k', 'hello');
  // getItem('k') === 'BAD' ≠ 'hello' → mismatch.
  // prevBytes was null (key was absent). Restore = removeItem('k').
  // After removeItem, written=false, so getItem('k')=null → restore verified.
  assert.equal(r.ok, false);
  assert.equal(r.code, 'readback_mismatch_restored');
});

check('prevBytes=string, restore succeeds → readback_mismatch_restored', () => {
  // Key present with 'old'; write; readback wrong; restore succeeds.
  const b = (() => {
    const map = new Map([['k', 'old']]);
    let readCount = 0;
    return {
      getItem:    k => {
        if (k !== 'k') return null;
        readCount++;
        // readCount=1: pre-write capture (returns 'old') — triggered by tryRead in setAndVerify.
        // readCount=2: readback after setItem (return 'BAD' to trigger mismatch).
        // readCount=3: restore readback (return what was set).
        if (readCount === 2) return 'BAD';
        return map.get('k') ?? null;
      },
      setItem:    (k, v) => { map.set(k, v); },
      removeItem: k => { map.delete(k); },
    };
  })();
  const a = createV1StorageAdapter(b);
  const r = a.setAndVerify('k', 'new');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'readback_mismatch_restored');
});

/* ════════════════════════════════════════════════════════════════
   4 · loadTasks — first use and basic merge
   ════════════════════════════════════════════════════════════════ */
section('loadTasks — first use + merge');

check('first use: returns catalog defaults for all tasks', () => {
  const repo = makeRepo();
  const tasks = repo.loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length);
  for (const [i, t] of tasks.entries()) {
    assert.equal(t.id,           MINI_CATALOG[i].id);
    assert.equal(t.title,        MINI_CATALOG[i].title);
    assert.equal(t.room,         MINI_CATALOG[i].room);
    assert.equal(t.intervalDays, MINI_CATALOG[i].intervalDays);
    assert.equal(t.lastDone,     null);
    assert.equal(t.doneToday,    false);
    assert.equal(t.skipUntil,    null);
  }
});

check('first use: writes seed bytes to storage', () => {
  const b = makeBacking();
  const repo = makeRepo(b);
  repo.loadTasks();
  const stored = b.getItem('hometask-v1');
  assert.ok(stored !== null, 'storage was written');
  const parsed = JSON.parse(stored);
  assert.equal(parsed.length, MINI_CATALOG.length);
  assert.equal(parsed[0].id, MINI_CATALOG[0].id);
});

check('catalog fields always win over stale stored values', () => {
  const stale = JSON.stringify([
    { id: 'a1', title: 'OLD TITLE', room: 'wrong room', intervalDays: 999,
      lastDone: YESTERDAY, doneToday: false, skipUntil: null, tags: [] },
  ]);
  const repo = makeRepo({ 'hometask-v1': stale });
  const tasks = repo.loadTasks();
  const a1 = tasks.find(t => t.id === 'a1');
  assert.equal(a1.title,        'Task Alpha',  'title from catalog');
  assert.equal(a1.room,         'Kitchen',     'room from catalog');
  assert.equal(a1.intervalDays, 7,             'intervalDays from catalog');
  assert.equal(a1.lastDone,     YESTERDAY,     'lastDone preserved from storage');
});

check('unknown saved IDs are ignored; known IDs receive catalog defaults', () => {
  const withUnknown = JSON.stringify([
    { id: 'unknown-xyz', lastDone: YESTERDAY, doneToday: false, skipUntil: null, tags: [] },
    { id: 'a1',          lastDone: null,       doneToday: false, skipUntil: null, tags: [] },
  ]);
  const repo = makeRepo({ 'hometask-v1': withUnknown });
  const tasks = repo.loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length, 'length always equals catalog length');
  const a1 = tasks.find(t => t.id === 'a1');
  assert.ok(a1, 'known ID present');
  assert.equal(tasks.find(t => t.id === 'unknown-xyz'), undefined, 'unknown ID absent');
});

check('skipUntil preserved from storage', () => {
  const raw = JSON.stringify([
    { id: 'b2', lastDone: null, doneToday: false, skipUntil: TOMORROW, tags: [] },
  ]);
  const repo = makeRepo({ 'hometask-v1': raw });
  const b2 = repo.loadTasks().find(t => t.id === 'b2');
  assert.equal(b2.skipUntil, TOMORROW);
});

check('tags preserved from storage; non-array tags become []', () => {
  const raw = JSON.stringify([
    { id: 'a1', tags: ['quick', 'morning'] },
    { id: 'b2', tags: 'not-an-array' },
  ]);
  const repo = makeRepo({ 'hometask-v1': raw });
  const tasks = repo.loadTasks();
  assert.deepEqual(tasks.find(t => t.id === 'a1').tags, ['quick', 'morning']);
  assert.deepEqual(tasks.find(t => t.id === 'b2').tags, []);
});

/* ════════════════════════════════════════════════════════════════
   5 · loadTasks — doneToday normalization (exact v1 rule)
   ════════════════════════════════════════════════════════════════ */
section('loadTasks — doneToday normalization');

check('lastDone === today && doneToday truthy → true', () => {
  const raw = JSON.stringify([{ id: 'a1', lastDone: TODAY, doneToday: true, tags: [] }]);
  const tasks = makeRepo({ 'hometask-v1': raw }).loadTasks();
  assert.equal(tasks.find(t => t.id === 'a1').doneToday, true);
});

check('lastDone === today && doneToday falsy → false', () => {
  const raw = JSON.stringify([{ id: 'a1', lastDone: TODAY, doneToday: false, tags: [] }]);
  const tasks = makeRepo({ 'hometask-v1': raw }).loadTasks();
  assert.equal(tasks.find(t => t.id === 'a1').doneToday, false);
});

check('lastDone !== today → doneToday false regardless of stored value', () => {
  const raw = JSON.stringify([{ id: 'a1', lastDone: YESTERDAY, doneToday: true, tags: [] }]);
  const tasks = makeRepo({ 'hometask-v1': raw }).loadTasks();
  assert.equal(tasks.find(t => t.id === 'a1').doneToday, false);
});

check('lastDone null → doneToday false regardless of stored value', () => {
  const raw = JSON.stringify([{ id: 'a1', lastDone: null, doneToday: true, tags: [] }]);
  const tasks = makeRepo({ 'hometask-v1': raw }).loadTasks();
  assert.equal(tasks.find(t => t.id === 'a1').doneToday, false);
});

check('doneToday truthy non-boolean (1, "yes") coerced via Boolean()', () => {
  // Boolean(1) === true; Boolean("yes") === true. Exact v1 behaviour.
  for (const truthy of [1, 'yes', {}, []]) {
    const raw = JSON.stringify([{ id: 'a1', lastDone: TODAY, doneToday: truthy, tags: [] }]);
    const tasks = makeRepo({ 'hometask-v1': raw }).loadTasks();
    assert.equal(tasks.find(t => t.id === 'a1').doneToday, Boolean(truthy),
      `doneToday coercion for ${JSON.stringify(truthy)}`);
  }
});

check('doneToday falsy non-boolean (0, "", null) coerced via Boolean()', () => {
  for (const falsy of [0, '', null]) {
    const raw = JSON.stringify([{ id: 'a1', lastDone: TODAY, doneToday: falsy, tags: [] }]);
    const tasks = makeRepo({ 'hometask-v1': raw }).loadTasks();
    assert.equal(tasks.find(t => t.id === 'a1').doneToday, false,
      `doneToday coercion for ${JSON.stringify(falsy)}`);
  }
});

/* ════════════════════════════════════════════════════════════════
   6 · loadTasks — hardened parsing
   ════════════════════════════════════════════════════════════════ */
section('loadTasks — hardened parsing');

check('JSON parse failure: recovery called with raw string, returns catalog defaults', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-v1': '{NOT JSON}' }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  const tasks = repo.loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length);
  assert.equal(tasks[0].lastDone, null);  // catalog defaults
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].sourceKey, 'hometask-v1');
  assert.equal(rec.calls[0].rawStr,    '{NOT JSON}');
});

check('valid JSON object (not array): recovery called, catalog defaults returned', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-v1': JSON.stringify({ id: 'a1' }) }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  const tasks = repo.loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length);
  assert.equal(rec.calls.length, 1, 'recovery called for object shape');
});

check('valid JSON null: recovery called, catalog defaults returned', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-v1': 'null' }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  const tasks = repo.loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length);
  assert.equal(rec.calls.length, 1, 'recovery called for null shape');
});

check('valid JSON string: recovery called, catalog defaults returned', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-v1': '"a plain string"' }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  const tasks = repo.loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length);
  assert.equal(rec.calls.length, 1, 'recovery called for string shape');
});

check('malformed entries within valid array: skipped, neighbours survive', () => {
  // Entry without id, entry that is null, entry that is a string — all skipped.
  // Known entries before and after still merge correctly.
  const raw = JSON.stringify([
    { id: 'a1', lastDone: YESTERDAY, doneToday: false, skipUntil: null, tags: ['ok'] },
    { noId: true },                          // malformed: no id
    null,                                    // malformed: null
    'not-an-object',                         // malformed: string
    { id: [], lastDone: TODAY },             // malformed: id not a string
    { id: 'c3', lastDone: TODAY, doneToday: true, skipUntil: null, tags: [] },
  ]);
  const tasks = makeRepo({ 'hometask-v1': raw }).loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length, 'result length still equals catalog length');
  const a1 = tasks.find(t => t.id === 'a1');
  const c3 = tasks.find(t => t.id === 'c3');
  assert.equal(a1.lastDone, YESTERDAY,  'a1 user state preserved');
  assert.deepEqual(a1.tags, ['ok'],     'a1 tags preserved');
  assert.equal(c3.doneToday, true,      'c3 user state preserved');
  // b2 was absent from saved array → catalog defaults.
  const b2 = tasks.find(t => t.id === 'b2');
  assert.equal(b2.lastDone, null, 'b2 receives catalog defaults');
});

check('empty saved array: all tasks receive catalog defaults', () => {
  const tasks = makeRepo({ 'hometask-v1': '[]' }).loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length);
  for (const t of tasks) assert.equal(t.lastDone, null);
});

/* ════════════════════════════════════════════════════════════════
   7 · loadTasks — read error path (degraded)
   ════════════════════════════════════════════════════════════════ */
section('loadTasks — read error');

check('getItem throws: returns catalog defaults without seeding storage', () => {
  const b    = makeThrowGetBacking('hometask-v1', {});
  const repo = makeRepo(b);
  const tasks = repo.loadTasks();
  assert.equal(tasks.length, MINI_CATALOG.length);
  // Storage must remain untouched — no first-use seed.
  // After the throw, the backing fires normally, so check it's still absent.
  assert.equal(b.has('hometask-v1'), false, 'storage not written on read error');
});

check('getItem throws: key marked degraded', () => {
  const repo = makeRepo(makeThrowGetBacking('hometask-v1', {}));
  repo.loadTasks();
  // saveTasks should now fail with degraded error.
  const r = repo.saveTasks([]);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('read-error-degraded'), `expected degraded error, got: ${r.error}`);
});

check('read error does not call recoveryAdapter', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeThrowGetBacking('hometask-v1', {}),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  repo.loadTasks();
  assert.equal(rec.calls.length, 0, 'recoveryAdapter not called on read error (no raw string available)');
});

/* ════════════════════════════════════════════════════════════════
   8 · saveTasks
   ════════════════════════════════════════════════════════════════ */
section('saveTasks');

check('success: written bytes are JSON of taskList', () => {
  const b    = makeBacking();
  const repo = makeRepo(b);
  const list = [{ id: 'a1', title: 'Task Alpha', lastDone: TODAY }];
  const r    = repo.saveTasks(list);
  assert.equal(r.ok, true);
  assert.equal(b.getItem('hometask-v1'), JSON.stringify(list));
});

check('degraded key: returns { ok:false } without touching storage', () => {
  const b    = makeThrowGetBacking('hometask-v1', { 'hometask-v1': '["original"]' });
  const repo = makeRepo(b);
  repo.loadTasks();   // triggers the throw → degraded
  const before = b.snapshot();
  const r = repo.saveTasks([{ id: 'a1' }]);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('read-error-degraded'));
  assert.deepEqual(b.snapshot(), before, 'storage unchanged');
});

check('write failure (quota): returns { ok:false }', () => {
  const b    = makeThrowSetBacking('hometask-v1');
  const repo = makeRepo(b);
  const r    = repo.saveTasks([{ id: 'a1' }]);
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

/* ════════════════════════════════════════════════════════════════
   9 · loadPrefs — defaults, merge, dueNowDefault fold
   ════════════════════════════════════════════════════════════════ */
section('loadPrefs — defaults and merge');

check('key absent → all DEFAULTS returned', () => {
  const p = makeRepo().loadPrefs();
  assert.equal(p.onboarded,  false);
  assert.equal(p.choice,     null);
  assert.equal(p.completedAt,null);
  assert.equal(p.viewMode,   'today');
  assert.equal(p.roomFilter, '');
});

check('saved partial object merged over DEFAULTS', () => {
  const raw = JSON.stringify({ onboarded: true, viewMode: 'week', roomFilter: 'Kitchen' });
  const p   = makeRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(p.onboarded,  true);
  assert.equal(p.viewMode,   'week');
  assert.equal(p.roomFilter, 'Kitchen');
  assert.equal(p.choice,     null, 'DEFAULTS applied for missing field');
});

check('dueNowDefault=true, viewMode absent → viewMode="week"', () => {
  const raw = JSON.stringify({ dueNowDefault: true });
  const p   = makeRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(p.viewMode, 'week');
});

check('dueNowDefault=false, viewMode absent → viewMode="all"', () => {
  const raw = JSON.stringify({ dueNowDefault: false });
  const p   = makeRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(p.viewMode, 'all');
});

check('dueNowDefault absent, viewMode absent → viewMode="today"', () => {
  const raw = JSON.stringify({ onboarded: true });
  const p   = makeRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(p.viewMode, 'today');
});

check('saved viewMode overrides dueNowDefault fold', () => {
  const raw = JSON.stringify({ dueNowDefault: true, viewMode: 'all' });
  const p   = makeRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(p.viewMode, 'all', 'saved viewMode wins over fold');
});

check('falsy but present viewMode (empty string) still triggers fold', () => {
  // !saved.viewMode is true for '' — fold applies.
  const raw = JSON.stringify({ dueNowDefault: true, viewMode: '' });
  const p   = makeRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(p.viewMode, 'week', 'empty string viewMode triggers fold');
});

/* ════════════════════════════════════════════════════════════════
   10 · loadPrefs — hardened parsing
   ════════════════════════════════════════════════════════════════ */
section('loadPrefs — hardened parsing');

check('JSON parse failure: recovery called, DEFAULTS returned', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-meta-v1': 'NOT{JSON' }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  const p = repo.loadPrefs();
  assert.equal(p.onboarded, false);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].sourceKey, 'hometask-meta-v1');
});

check('valid JSON array → recovery called, DEFAULTS returned', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-meta-v1': '["array"]' }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  const p = repo.loadPrefs();
  assert.equal(p.viewMode, 'today');
  assert.equal(rec.calls.length, 1);
});

check('valid JSON null → recovery called, DEFAULTS returned', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-meta-v1': 'null' }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  assert.equal(repo.loadPrefs().viewMode, 'today');
  assert.equal(rec.calls.length, 1);
});

check('valid JSON string → recovery called, DEFAULTS returned', () => {
  const rec  = makeRecovery();
  const repo = new V1Repository({
    backing:         makeBacking({ 'hometask-meta-v1': '"a string"' }),
    catalog:         MINI_CATALOG,
    todayFn:         () => TODAY,
    recoveryAdapter: rec,
  });
  assert.equal(repo.loadPrefs().viewMode, 'today');
  assert.equal(rec.calls.length, 1);
});

/* ════════════════════════════════════════════════════════════════
   11 · loadPrefs — read error path
   ════════════════════════════════════════════════════════════════ */
section('loadPrefs — read error');

check('getItem throws: returns DEFAULTS, marks key degraded', () => {
  const b    = makeThrowGetBacking('hometask-meta-v1', {});
  const repo = makeRepo(b);
  const p    = repo.loadPrefs();
  assert.equal(p.viewMode, 'today', 'DEFAULTS returned');
  const r = repo.savePrefs({ viewMode: 'week' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('read-error-degraded'), `expected degraded, got ${r.error}`);
});

check('existing bytes untouched after read error', () => {
  const b = makeThrowGetBacking('hometask-meta-v1',
    { 'hometask-meta-v1': JSON.stringify({ viewMode: 'all' }) });
  const repo = makeRepo(b);
  repo.loadPrefs();
  // After the one throw, backing returns normally.
  // Key should still have its original value — repo did NOT overwrite it.
  const stored = b.getItem('hometask-meta-v1');
  // The throw was on the first call; after that getItem works.
  // The key should be present (it was seeded in initial state).
  assert.equal(typeof stored, 'string', 'storage key still present');
  assert.equal(JSON.parse(stored).viewMode, 'all', 'existing bytes unchanged');
});

/* ════════════════════════════════════════════════════════════════
   12 · savePrefs
   ════════════════════════════════════════════════════════════════ */
section('savePrefs');

check('merges patch into current prefs and writes', () => {
  const b    = makeBacking({ 'hometask-meta-v1': JSON.stringify({ viewMode: 'all', onboarded: true }) });
  const repo = makeRepo(b);
  const r    = repo.savePrefs({ roomFilter: 'Kitchen' });
  assert.equal(r.ok, true);
  const stored = JSON.parse(b.getItem('hometask-meta-v1'));
  assert.equal(stored.viewMode,   'all');      // existing field preserved
  assert.equal(stored.onboarded,  true);       // existing field preserved
  assert.equal(stored.roomFilter, 'Kitchen');  // patch applied
});

check('degraded key: blocked', () => {
  const repo = makeRepo(makeThrowGetBacking('hometask-meta-v1', {}));
  repo.loadPrefs();
  const r = repo.savePrefs({ viewMode: 'week' });
  assert.equal(r.ok, false);
});

/* ════════════════════════════════════════════════════════════════
   13 · loadRecents / addRecent / clearRecents
   ════════════════════════════════════════════════════════════════ */
section('loadRecents / addRecent / clearRecents');

check('key absent → []', () => {
  assert.deepEqual(makeRepo().loadRecents(), []);
});

check('normal array returned', () => {
  const raw  = JSON.stringify(['alpha', 'beta']);
  const repo = makeRepo({ 'hometask-recent-searches-v1': raw });
  assert.deepEqual(repo.loadRecents(), ['alpha', 'beta']);
});

check('wrong shape (object) → []', () => {
  const repo = makeRepo({ 'hometask-recent-searches-v1': '{"a":1}' });
  assert.deepEqual(repo.loadRecents(), []);
});

check('wrong shape (null) → []', () => {
  const repo = makeRepo({ 'hometask-recent-searches-v1': 'null' });
  assert.deepEqual(repo.loadRecents(), []);
});

check('wrong shape (string) → []', () => {
  const repo = makeRepo({ 'hometask-recent-searches-v1': '"nope"' });
  assert.deepEqual(repo.loadRecents(), []);
});

check('invalid JSON → []', () => {
  const repo = makeRepo({ 'hometask-recent-searches-v1': 'NOT_JSON' });
  assert.deepEqual(repo.loadRecents(), []);
});

check('addRecent: prepends, deduplicates case-insensitively', () => {
  const b    = makeBacking();
  const repo = makeRepo(b);
  repo.addRecent('Alpha');
  repo.addRecent('beta');
  repo.addRecent('ALPHA');   // duplicate of 'Alpha' → 'Alpha' removed, 'ALPHA' prepended
  const r = repo.loadRecents();
  assert.deepEqual(r, ['ALPHA', 'beta']);
});

check('addRecent: newest first', () => {
  const repo = makeRepo();
  repo.addRecent('first');
  repo.addRecent('second');
  repo.addRecent('third');
  assert.deepEqual(repo.loadRecents(), ['third', 'second', 'first']);
});

check('addRecent: capped at 5', () => {
  const repo = makeRepo();
  for (let i = 1; i <= 7; i++) repo.addRecent(`term${i}`);
  const r = repo.loadRecents();
  assert.equal(r.length, 5);
  assert.equal(r[0], 'term7');
  assert.equal(r[4], 'term3');
});

check('addRecent: empty string ignored', () => {
  const repo = makeRepo();
  const r = repo.addRecent('');
  assert.equal(r.ok, true);
  assert.deepEqual(repo.loadRecents(), []);
});

check('addRecent: whitespace-only ignored', () => {
  const repo = makeRepo();
  repo.addRecent('   ');
  assert.deepEqual(repo.loadRecents(), []);
});

check('clearRecents: removes key', () => {
  const b    = makeBacking({ 'hometask-recent-searches-v1': '["a"]' });
  const repo = makeRepo(b);
  const r    = repo.clearRecents();
  assert.equal(r.ok, true);
  assert.equal(b.has('hometask-recent-searches-v1'), false);
});

/* ════════════════════════════════════════════════════════════════
   14 · getLastExport / setLastExport
   ════════════════════════════════════════════════════════════════ */
section('getLastExport / setLastExport');

check('key absent → null', () => {
  assert.equal(makeRepo().getLastExport(), null);
});

check('lastExport present → returned', () => {
  const raw  = JSON.stringify({ lastExport: '2026-07-01' });
  assert.equal(makeRepo({ 'hometask-backup-v1': raw }).getLastExport(), '2026-07-01');
});

check('setLastExport writes lastExport without touching snapshot', () => {
  const snap = { savedAt: '2026-08-01T00:00:00Z', keys: { 'hometask-v1': '[]' } };
  const raw  = JSON.stringify({ lastExport: '2026-07-01', snapshot: snap });
  const b    = makeBacking({ 'hometask-backup-v1': raw });
  const repo = makeRepo(b);
  const r    = repo.setLastExport('2026-08-10');
  assert.equal(r.ok, true);
  const stored = JSON.parse(b.getItem('hometask-backup-v1'));
  assert.equal(stored.lastExport, '2026-08-10', 'lastExport updated');
  assert.deepEqual(stored.snapshot, snap,        'snapshot untouched');
});

check('setLastExport on empty backup key: writes only lastExport', () => {
  const b    = makeBacking();
  const repo = makeRepo(b);
  repo.setLastExport('2026-08-10');
  const stored = JSON.parse(b.getItem('hometask-backup-v1'));
  assert.equal(stored.lastExport, '2026-08-10');
  assert.equal('snapshot' in stored, false);
});

check('round-trip: set then get', () => {
  const repo = makeRepo();
  repo.setLastExport('2026-05-15');
  assert.equal(repo.getLastExport(), '2026-05-15');
});

/* ════════════════════════════════════════════════════════════════
   15 · Degraded key lifecycle
   ════════════════════════════════════════════════════════════════ */
section('degraded key lifecycle');

check('degraded cleared after a successful loadTasks read', () => {
  // First call throws (marks degraded); subsequent backing works normally.
  const b = makeThrowGetBacking('hometask-v1',
    { 'hometask-v1': JSON.stringify([{ id: 'a1', lastDone: null, doneToday: false, tags: [] }]) });
  const repo = makeRepo(b);
  repo.loadTasks();   // throws → degraded

  // Verify degraded
  assert.equal(repo.saveTasks([]).ok, false);

  // Second loadTasks succeeds (throw only fires once) → clears degraded.
  repo.loadTasks();
  const r2 = repo.saveTasks([{ id: 'a1' }]);
  assert.equal(r2.ok, true, 'write succeeds after degraded cleared by successful read');
});

check('degraded on one key does not affect other keys', () => {
  const b    = makeThrowGetBacking('hometask-v1', {});
  const repo = makeRepo(b);
  repo.loadTasks();   // marks hometask-v1 degraded
  // loadPrefs and savePrefs on hometask-meta-v1 should work fine.
  const p  = repo.loadPrefs();
  assert.equal(p.viewMode, 'today');
  const r = repo.savePrefs({ onboarded: true });
  assert.equal(r.ok, true, 'unrelated key write unaffected');
});

check('degraded cleared on loadPrefs after a successful read', () => {
  const b = makeThrowGetBacking('hometask-meta-v1',
    { 'hometask-meta-v1': JSON.stringify({ viewMode: 'week' }) });
  const repo = makeRepo(b);
  repo.loadPrefs();   // throws → degraded
  assert.equal(repo.savePrefs({ onboarded: true }).ok, false);
  repo.loadPrefs();   // succeeds → clears degraded
  const r = repo.savePrefs({ onboarded: true });
  assert.equal(r.ok, true);
});

/* ════════════════════════════════════════════════════════════════
   16 · Production-module real-execution parity — tasks
   ════════════════════════════════════════════════════════════════
   These tests run the actual production storage.js, meta.js,
   recents.js, and backup-store.js functions against an isolated
   in-memory fake localStorage.  V1Repository is then called with
   the identical initial backing state and the same real todayStr()
   value.  Outputs are compared byte-for-byte.

   Scope of comparison: correct inputs and malformed-JSON inputs.
   Valid-JSON-wrong-shape inputs are deliberately excluded because
   production storage.load() calls .map() on the parsed value and
   would THROW on a non-array, while V1Repository hardens this
   edge case.  The hardening tests remain in sections 6–10 above.

   The V1Repository injected catalog is SEED_TASKS (imported from
   the same catalog.js that storage.js uses) so both sides are
   seeded byte-for-byte identically.
   ════════════════════════════════════════════════════════════════ */

/**
 * Fake localStorage backed by a Map.
 * Returned object exposes .snapshot() for byte inspection.
 */
function makeFakeLS(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem:    k      => (map.has(k) ? map.get(k) : null),
    setItem:    (k, v) => { map.set(k, String(v)); },
    removeItem: k      => { map.delete(k); },
    snapshot:   ()     => Object.fromEntries(map),
  };
}

/**
 * Run fn(fakeLS) with global.localStorage pointing at a fresh Map-backed
 * fake seeded from `initial`.  Always restores global.localStorage to null.
 * Returns { result, fls } so callers can inspect bytes after the call.
 */
function withLS(initial, fn) {
  const fls = makeFakeLS(initial);
  global.localStorage = fls;
  let result;
  try { result = fn(fls); }
  finally { global.localStorage = null; }
  return { result, fls };
}

/** Build a V1Repository using the same SEED_TASKS catalog that storage.js uses. */
function makeParityRepo(backingInitial, todayOverride) {
  return new V1Repository({
    backing: makeBacking(backingInitial),
    catalog: SEED_TASKS,
    todayFn: () => todayOverride ?? TODAY_PROD,
  });
}

section('production parity — tasks');

check('first use: V1Repository.loadTasks() === production storage.load() (122 tasks)', () => {
  // Both called with empty storage and the same real today.
  const { result: prod } = withLS({}, () => storage.load());
  const repo = makeParityRepo({});
  const got  = repo.loadTasks();

  assert.equal(got.length, 122, 'repo returns 122 tasks');
  assert.equal(prod.length, 122, 'production returns 122 tasks');
  assert.deepEqual(got, prod, 'byte-identical to production on first use');
});

check('first use: persisted bytes from V1Repository match production storage.load()', () => {
  // After first-use seeding, both sides persist identical JSON.
  const { fls: prodLS } = withLS({}, () => storage.load());
  // Construct directly so repoB is the actual backing the repo writes to.
  const repoB = makeBacking({});
  const repo  = new V1Repository({ backing: repoB, catalog: SEED_TASKS, todayFn: () => TODAY_PROD });
  repo.loadTasks();

  const prodBytes = prodLS.snapshot()['hometask-v1'];
  const repoBytes = repoB.getItem('hometask-v1');
  assert.ok(typeof prodBytes === 'string' && prodBytes.length > 0, 'production wrote bytes');
  assert.equal(repoBytes, prodBytes, 'persisted bytes are byte-for-byte identical');
});

check('catalog-authoritative merge: V1Repository === production (all 122 tasks)', () => {
  // Store state for a representative subset; rest are untouched (catalog defaults apply).
  const stateEntries = SEED_TASKS.slice(0, 6).map((t, i) => ({
    id:        t.id,
    lastDone:  i === 0 ? TODAY_PROD : i === 1 ? YESTERDAY_PROD : null,
    doneToday: i === 0 ? true : false,
    skipUntil: i === 2 ? addDays(TODAY_PROD, 3) : null,
    tags:      i === 3 ? ['quick'] : [],
  }));
  // Also include an unknown id — production ignores it; V1Repository ignores it.
  stateEntries.push({ id: 'retired-ghost', lastDone: TODAY_PROD, doneToday: true, tags: [] });
  const rawV1 = JSON.stringify(stateEntries);

  const { result: prod } = withLS({ 'hometask-v1': rawV1 }, () => storage.load());
  const repo = makeParityRepo({ 'hometask-v1': rawV1 });
  const got  = repo.loadTasks();

  assert.equal(got.length, 122);
  assert.deepEqual(got, prod, 'merged output matches production exactly for all 122 tasks');
});

check('catalog authority: stale title/intervalDays overridden identically by both', () => {
  // Every task stored with wrong title and wrong intervalDays.
  const stale = JSON.stringify(SEED_TASKS.map(t => ({
    id: t.id, title: 'OLD', intervalDays: 999,
    lastDone: YESTERDAY_PROD, doneToday: false, skipUntil: null, tags: [],
  })));
  const { result: prod } = withLS({ 'hometask-v1': stale }, () => storage.load());
  const got = makeParityRepo({ 'hometask-v1': stale }).loadTasks();

  assert.deepEqual(got, prod, 'catalog authority: both sides use seed title/intervalDays');
  assert.ok(got.every(t => t.lastDone === YESTERDAY_PROD), 'lastDone preserved by both');
});

check('doneToday: lastDone=today, stored true → both coerce to true', () => {
  // Task 0: lastDone=today, doneToday=1 (truthy non-boolean) — both coerce via Boolean()
  const raw = JSON.stringify([{
    id: SEED_TASKS[0].id, lastDone: TODAY_PROD, doneToday: 1, skipUntil: null, tags: [],
  }]);
  const { result: prod } = withLS({ 'hometask-v1': raw }, () => storage.load());
  const got = makeParityRepo({ 'hometask-v1': raw }).loadTasks();
  const prodTask = prod.find(t => t.id === SEED_TASKS[0].id);
  const repoTask = got.find(t => t.id === SEED_TASKS[0].id);
  assert.equal(repoTask.doneToday, true);
  assert.deepEqual(repoTask, prodTask, 'doneToday coercion matches production exactly');
});

check('doneToday: lastDone=yesterday, stored true → both force to false', () => {
  const raw = JSON.stringify([{
    id: SEED_TASKS[0].id, lastDone: YESTERDAY_PROD, doneToday: true, skipUntil: null, tags: [],
  }]);
  const { result: prod } = withLS({ 'hometask-v1': raw }, () => storage.load());
  const got = makeParityRepo({ 'hometask-v1': raw }).loadTasks();
  const prodTask = prod.find(t => t.id === SEED_TASKS[0].id);
  const repoTask = got.find(t => t.id === SEED_TASKS[0].id);
  assert.equal(repoTask.doneToday, false);
  assert.deepEqual(repoTask, prodTask, 'doneToday cleared when lastDone≠today: matches production');
});

check('malformed tasks JSON: both return 122 catalog defaults', () => {
  // Both catch JSON.parse error. Production sets saved=[] then builds catalog defaults.
  // V1Repository calls recoveryAdapter and returns catalog defaults.
  // Returned task lists must be deeply equal.
  const { result: prod } = withLS({ 'hometask-v1': '{NOT_JSON' }, () => storage.load());
  const got = makeParityRepo({ 'hometask-v1': '{NOT_JSON' }).loadTasks();
  assert.equal(got.length, 122);
  assert.deepEqual(got, prod, 'both return catalog defaults for damaged JSON');
  assert.ok(got.every(t => t.lastDone === null), 'all at catalog defaults');
});

check('saveTasks: V1Repository bytes === production storage.save() bytes', () => {
  // Both write JSON.stringify(list). Confirm byte identity.
  const list = SEED_TASKS.map((t, i) => ({
    ...t,
    lastDone:  i === 0 ? TODAY_PROD : null,
    doneToday: i === 0,
    skipUntil: null,
    tags:      [],
  }));
  const { fls: prodLS } = withLS({}, (ls) => { storage.save(list); });
  const repoB = makeBacking({});
  new V1Repository({ backing: repoB, catalog: SEED_TASKS, todayFn: () => TODAY_PROD })
    .saveTasks(list);

  const prodBytes = prodLS.snapshot()['hometask-v1'];
  const repoBytes = repoB.getItem('hometask-v1');
  assert.equal(repoBytes, prodBytes, 'saveTasks bytes are byte-for-byte identical to production');
});

/* ════════════════════════════════════════════════════════════════
   17 · Production-module real-execution parity — prefs
   ════════════════════════════════════════════════════════════════ */
section('production parity — prefs');

check('prefs absent: V1Repository.loadPrefs() === production meta.load()', () => {
  const { result: prod } = withLS({}, () => meta.load());
  const got = makeParityRepo({}).loadPrefs();
  assert.deepEqual(got, prod, 'absent prefs: matches production DEFAULTS exactly');
});

check('dueNowDefault=true, no viewMode → viewMode="week" in both', () => {
  const raw = JSON.stringify({ dueNowDefault: true });
  const { result: prod } = withLS({ 'hometask-meta-v1': raw }, () => meta.load());
  const got = makeParityRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(got.viewMode, 'week');
  assert.deepEqual(got, prod);
});

check('dueNowDefault=false, no viewMode → viewMode="all" in both', () => {
  const raw = JSON.stringify({ dueNowDefault: false });
  const { result: prod } = withLS({ 'hometask-meta-v1': raw }, () => meta.load());
  const got = makeParityRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(got.viewMode, 'all');
  assert.deepEqual(got, prod);
});

check('no dueNowDefault, no viewMode → viewMode="today" in both', () => {
  const raw = JSON.stringify({ onboarded: true });
  const { result: prod } = withLS({ 'hometask-meta-v1': raw }, () => meta.load());
  const got = makeParityRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(got.viewMode, 'today');
  assert.deepEqual(got, prod);
});

check('saved viewMode wins over dueNowDefault fold in both', () => {
  const raw = JSON.stringify({ dueNowDefault: true, viewMode: 'all' });
  const { result: prod } = withLS({ 'hometask-meta-v1': raw }, () => meta.load());
  const got = makeParityRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.equal(got.viewMode, 'all', 'saved viewMode wins');
  assert.deepEqual(got, prod);
});

check('full preferences object round-trip: both sides identical', () => {
  const raw = JSON.stringify({
    onboarded: true, choice: 'balanced', completedAt: '2026-07-01',
    viewMode: 'week', roomFilter: 'Kitchen',
  });
  const { result: prod } = withLS({ 'hometask-meta-v1': raw }, () => meta.load());
  const got = makeParityRepo({ 'hometask-meta-v1': raw }).loadPrefs();
  assert.deepEqual(got, prod);
});

check('malformed prefs JSON: both return DEFAULTS', () => {
  const { result: prod } = withLS({ 'hometask-meta-v1': '{BAD' }, () => meta.load());
  const got = makeParityRepo({ 'hometask-meta-v1': '{BAD' }).loadPrefs();
  assert.equal(got.viewMode, 'today');
  assert.equal(got.onboarded, false);
  // Note: production meta.load() also calls recoveryStore.save() on damaged
  // prefs — that writes to hometask-recovery-v1 in the fake LS, which is fine.
  // We only compare the RETURNED prefs object.
  assert.deepEqual(got, prod, 'malformed prefs: both return DEFAULTS');
});

check('savePrefs: V1Repository bytes === production meta.save() bytes', () => {
  const initial = JSON.stringify({ onboarded: true, viewMode: 'all', choice: 'balanced' });
  const patch   = { roomFilter: 'Kitchen', completedAt: '2026-08-01' };

  const { fls: prodLS } = withLS({ 'hometask-meta-v1': initial }, () => meta.save(patch));
  const repoB = makeBacking({ 'hometask-meta-v1': initial });
  new V1Repository({ backing: repoB, catalog: SEED_TASKS, todayFn: () => TODAY_PROD })
    .savePrefs(patch);

  const prodBytes = prodLS.snapshot()['hometask-meta-v1'];
  const repoBytes = repoB.getItem('hometask-meta-v1');
  assert.equal(repoBytes, prodBytes, 'savePrefs bytes are byte-for-byte identical to production');
});

/* ════════════════════════════════════════════════════════════════
   18 · Production-module real-execution parity — recents
   ════════════════════════════════════════════════════════════════ */
section('production parity — recents');

check('recents absent: V1Repository.loadRecents() === production recentSearches.load()', () => {
  const { result: prod } = withLS({}, () => recentSearches.load());
  const got = makeParityRepo({}).loadRecents();
  assert.deepEqual(got, [], 'absent recents: both return []');
  assert.deepEqual(got, prod);
});

check('recents normal array: both return same array', () => {
  const raw = JSON.stringify(['alpha', 'beta', 'gamma']);
  const { result: prod } = withLS({ 'hometask-recent-searches-v1': raw }, () => recentSearches.load());
  const got = makeParityRepo({ 'hometask-recent-searches-v1': raw }).loadRecents();
  assert.deepEqual(got, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(got, prod);
});

check('malformed recents JSON: both return []', () => {
  const { result: prod } = withLS({ 'hometask-recent-searches-v1': '{BAD' }, () => recentSearches.load());
  const got = makeParityRepo({ 'hometask-recent-searches-v1': '{BAD' }).loadRecents();
  assert.deepEqual(got, []);
  assert.deepEqual(got, prod);
});

check('addRecent: dedup + newest-first + cap-5 matches production recentSearches.add()', () => {
  // Build up 7 terms via production, then mirror with V1Repository.
  const terms = ['term1', 'term2', 'term3', 'term4', 'term5', 'term6', 'TERM1']; // TERM1 dedupes term1
  const { fls: prodLS } = withLS({}, () => {
    for (const t of terms) recentSearches.add(t);
  });
  const prodBytes = prodLS.snapshot()['hometask-recent-searches-v1'];

  // Construct V1Repository directly — do NOT wrap an instantiated backing in makeParityRepo.
  const repoB = makeBacking({});
  const repo  = new V1Repository({ backing: repoB, catalog: SEED_TASKS, todayFn: () => TODAY_PROD });
  for (const t of terms) repo.addRecent(t);
  const repoBytes = repoB.getItem('hometask-recent-searches-v1');

  assert.equal(repoBytes, prodBytes, 'add bytes match production exactly');
  // Verify expected semantic: cap 5, TERM1 deduped term1, newest first
  const parsed = JSON.parse(repoBytes);
  assert.equal(parsed.length, 5);
  assert.equal(parsed[0], 'TERM1', 'newest-first dedup result matches');
});

/* ════════════════════════════════════════════════════════════════
   19 · Production-module real-execution parity — lastExport
   ════════════════════════════════════════════════════════════════ */
section('production parity — lastExport');

check('setLastExport then getLastExport: V1Repository matches production backupStore', () => {
  const DATE = '2026-08-10';

  // Production: setLastExport writes; getLastExport reads back.
  const { fls: prodLS } = withLS({}, () => backupStore.setLastExport(DATE));
  const prodGet = (() => {
    global.localStorage = prodLS;
    try { return backupStore.getLastExport(); } finally { global.localStorage = null; }
  })();

  // V1Repository: construct directly with the backing we inspect.
  const repoB = makeBacking({});
  const repo  = new V1Repository({ backing: repoB, catalog: SEED_TASKS, todayFn: () => TODAY_PROD });
  repo.setLastExport(DATE);
  const repoGet = repo.getLastExport();

  assert.equal(prodGet, DATE, 'production round-trip ok');
  assert.equal(repoGet, DATE, 'repo round-trip ok');
  assert.equal(repoB.getItem('hometask-backup-v1'),
               prodLS.snapshot()['hometask-backup-v1'],
               'written bytes are byte-for-byte identical');
});

check('setLastExport does not overwrite existing snapshot: both sides preserve it', () => {
  const snap    = { savedAt: '2026-08-01T00:00:00Z', keys: { 'hometask-v1': '[]' } };
  const initial = JSON.stringify({ lastExport: '2026-07-01', snapshot: snap });
  const DATE    = '2026-08-10';

  const { fls: prodLS } = withLS({ 'hometask-backup-v1': initial },
    () => backupStore.setLastExport(DATE));

  // Construct directly so repoB is the actual backing inspected below.
  const repoB = makeBacking({ 'hometask-backup-v1': initial });
  const repo  = new V1Repository({ backing: repoB, catalog: SEED_TASKS, todayFn: () => TODAY_PROD });
  repo.setLastExport(DATE);

  const prodStored = JSON.parse(prodLS.snapshot()['hometask-backup-v1']);
  const repoStored = JSON.parse(repoB.getItem('hometask-backup-v1'));

  assert.equal(prodStored.lastExport, DATE, 'production updated lastExport');
  assert.equal(repoStored.lastExport, DATE, 'repo updated lastExport');
  assert.deepEqual(repoStored.snapshot, snap, 'snapshot untouched by repo');
  assert.deepEqual(prodStored.snapshot, snap, 'snapshot untouched by production');
  assert.deepEqual(repoStored, prodStored,     'bytes are byte-for-byte identical');
});

/* ── Final summary ─────────────────────────────────────────────── */
console.log(`\nv1-repository.test.mjs: ${_pass} passed, ${_fail} failed  (total ${_pass + _fail})`);
process.exit(_fail > 0 ? 1 : 0);
