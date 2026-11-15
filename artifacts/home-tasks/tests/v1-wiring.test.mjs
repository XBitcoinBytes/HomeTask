/**
 * v1-wiring.test.mjs — CP5C-A2.1 wiring test suite (suite 16).
 *
 * Tests that the wired production modules honour the repository contract:
 *
 *   A. Injection guard (tasks.js as the representative module):
 *        - rejects null / non-object
 *        - allows initial assignment
 *        - allows idempotent repeat with the same object
 *        - rejects swap to a different object
 *
 *   B. Copy-on-write for all four task mutators (success paths):
 *        - _items is replaced with a new array reference on success
 *        - the mutated task reflects the expected change
 *
 *   C. Copy-on-write failure paths:
 *        - _items reference is UNCHANGED when saveTasks fails
 *        - the task's field is UNCHANGED
 *
 *   D. Degraded key protection via V1Repository:
 *        - a read error marks the key degraded
 *        - subsequent saveTasks calls return { ok: false }
 *
 * The suite imports tasks.js (which is now storage-free) and feeds it
 * an in-memory controllable V1Repository backed by a fake Map store.
 * Since tasks.js is a singleton, tests run in a controlled order:
 * guard tests fire before the repo is assigned, then all mutation
 * tests run against the same singleton with the repo already set.
 *
 * No DOM, no browser, no real localStorage is touched.
 */
import assert from 'node:assert/strict';
import { V1Repository } from '../src/data/repository/v1-repository.js';
import { tasks }        from '../src/app/tasks.js';
import { SEED_TASKS }   from '../src/app/catalog.js';
import { todayStr }     from '../src/app/util.js';

const TODAY = todayStr();

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' — ' + e.message); }
}
function section(name) { console.log('\n── ' + name); }

/* ── Controllable fake backing ──────────────────────────────── */
const fakeMap    = new Map();
let   _failWrites = false;

const fakeBacking = {
  getItem:    k      => fakeMap.get(k) ?? null,
  setItem:    (k, v) => {
    if (_failWrites) throw new Error('QuotaExceededError (simulated)');
    fakeMap.set(k, v);
  },
  removeItem: k      => { fakeMap.delete(k); },
};

const repo = new V1Repository({
  backing:  fakeBacking,
  catalog:  SEED_TASKS,
  todayFn:  () => TODAY,
});

// A second distinct repo object — used to verify the swap-rejection guard.
const repo2 = new V1Repository({
  backing:  fakeBacking,
  catalog:  SEED_TASKS,
  todayFn:  () => TODAY,
});

/* ══════════════════════════════════════════════════════════════
   A. Injection guard
   ══════════════════════════════════════════════════════════════ */
section('A — injection guard');

check('setRepo(null) throws — invalid repository', () => {
  assert.throws(
    () => tasks.setRepo(null),
    /invalid repository/,
    'setRepo(null) must throw with "invalid repository"',
  );
});

check('setRepo(42) throws — non-object rejected', () => {
  assert.throws(
    () => tasks.setRepo(42),
    /invalid repository/,
  );
});

check('setRepo(valid repo) — initial assignment allowed', () => {
  // Must not throw
  tasks.setRepo(repo);
});

check('setRepo(same object) — idempotent repeat allowed', () => {
  // Must not throw — same reference is fine
  tasks.setRepo(repo);
});

check('setRepo(different repo) — late swap rejected', () => {
  assert.throws(
    () => tasks.setRepo(repo2),
    /already set/,
    'setRepo with a different object must throw "already set"',
  );
});

/* ══════════════════════════════════════════════════════════════
   B. Copy-on-write — success paths
   ══════════════════════════════════════════════════════════════ */
section('B — copy-on-write (success)');

check('getAll() seeds from catalog on first call', () => {
  const all = tasks.getAll();
  assert.equal(all.length, SEED_TASKS.length,
    `getAll() should return ${SEED_TASKS.length} tasks`);
  assert.ok(fakeMap.has('hometask-v1'), 'seed bytes must be written to backing');
});

// We use distinct SEED_TASKS indices for each mutator so tests are independent.
const [T0, T1, T2, T3] = SEED_TASKS;

check('markDone — _items replaced with new array on success', () => {
  const refBefore = tasks.getAll();
  tasks.markDone(T0.id);
  const refAfter = tasks.getAll();
  assert.notEqual(refAfter, refBefore, '_items reference must change on success');
  const t = refAfter.find(x => x.id === T0.id);
  assert.equal(t.lastDone,  TODAY, 'lastDone must be set to today');
  assert.equal(t.doneToday, true,  'doneToday must be true');
  assert.equal(t.skipUntil, null,  'skipUntil must be cleared');
});

check('skipToday — _items replaced with new array on success', () => {
  const refBefore = tasks.getAll();
  tasks.skipToday(T1.id);
  const refAfter = tasks.getAll();
  assert.notEqual(refAfter, refBefore, '_items reference must change on success');
  const t = refAfter.find(x => x.id === T1.id);
  assert.ok(t.skipUntil !== null, 'skipUntil must be set after skipToday');
});

check('skipWeek — _items replaced with new array on success', () => {
  const refBefore = tasks.getAll();
  tasks.skipWeek(T2.id);
  const refAfter = tasks.getAll();
  assert.notEqual(refAfter, refBefore, '_items reference must change on success');
  const t = refAfter.find(x => x.id === T2.id);
  assert.ok(t.skipUntil !== null, 'skipUntil must be set after skipWeek');
});

check('applyBaseline — _items replaced with new array on success', () => {
  // Find tasks that have never been done (lastDone === null)
  const undone = tasks.getAll().filter(t => t.lastDone === null).slice(0, 3);
  assert.ok(undone.length > 0, 'need at least one undone task for this test');
  const overrides = undone.map(t => ({ id: t.id, skipUntil: '2026-09-15' }));
  const refBefore = tasks.getAll();
  tasks.applyBaseline(overrides);
  const refAfter = tasks.getAll();
  assert.notEqual(refAfter, refBefore, '_items reference must change on success');
  for (const o of overrides) {
    const t = refAfter.find(x => x.id === o.id);
    assert.equal(t.skipUntil, '2026-09-15', `skipUntil must be set for task ${o.id}`);
  }
});

check('markDone with unknown id — no-op, _items unchanged', () => {
  const refBefore = tasks.getAll();
  tasks.markDone('nonexistent-id-xyz-987');
  assert.equal(tasks.getAll(), refBefore, '_items reference must be unchanged for unknown id');
});

/* ══════════════════════════════════════════════════════════════
   C. Copy-on-write — failure paths (write blocked)
   ══════════════════════════════════════════════════════════════ */
section('C — copy-on-write (failure — writes blocked)');

// Use T3 for failure tests; its state was untouched in success tests.
check('markDone — _items reference UNCHANGED when saveTasks fails', () => {
  _failWrites = true;
  const refBefore      = tasks.getAll();
  const fieldBefore    = refBefore.find(t => t.id === T3.id).doneToday;
  tasks.markDone(T3.id);
  const refAfter = tasks.getAll();
  _failWrites = false;
  assert.equal(refAfter, refBefore, '_items reference must be unchanged on failure');
  assert.equal(refAfter.find(t => t.id === T3.id).doneToday, fieldBefore,
    'doneToday must be unchanged on failure');
});

check('skipToday — _items reference UNCHANGED when saveTasks fails', () => {
  _failWrites = true;
  const refBefore   = tasks.getAll();
  const skipBefore  = refBefore.find(t => t.id === T3.id).skipUntil;
  tasks.skipToday(T3.id);
  const refAfter = tasks.getAll();
  _failWrites = false;
  assert.equal(refAfter, refBefore, '_items reference must be unchanged on failure');
  assert.equal(refAfter.find(t => t.id === T3.id).skipUntil, skipBefore,
    'skipUntil must be unchanged on failure');
});

check('skipWeek — _items reference UNCHANGED when saveTasks fails', () => {
  _failWrites = true;
  const refBefore = tasks.getAll();
  tasks.skipWeek(T3.id);
  const refAfter = tasks.getAll();
  _failWrites = false;
  assert.equal(refAfter, refBefore, '_items reference must be unchanged on failure');
});

check('applyBaseline — _items reference UNCHANGED when saveTasks fails', () => {
  _failWrites = true;
  const refBefore  = tasks.getAll();
  const undone     = refBefore.filter(t => t.lastDone === null).slice(0, 1);
  const overrides  = undone.map(t => ({ id: t.id, skipUntil: '2099-01-01' }));
  tasks.applyBaseline(overrides);
  const refAfter = tasks.getAll();
  _failWrites = false;
  assert.equal(refAfter, refBefore, '_items reference must be unchanged on failure');
  if (overrides.length > 0) {
    const t = refAfter.find(x => x.id === overrides[0].id);
    assert.notEqual(t.skipUntil, '2099-01-01',
      'skipUntil must NOT be set to sentinel value when save failed');
  }
});

/* ══════════════════════════════════════════════════════════════
   D. Degraded key protection (via V1Repository directly)
   ══════════════════════════════════════════════════════════════ */
section('D — degraded key protection');

check('read error marks tasks key degraded; subsequent save returns ok:false', () => {
  let readCount = 0;
  const throwOnSecondRead = {
    getItem: k => {
      if (k === 'hometask-v1') {
        readCount++;
        if (readCount === 1) throw new Error('storage broken');
        return null;
      }
      return null;
    },
    setItem:    () => {},
    removeItem: () => {},
  };
  const degradedRepo = new V1Repository({
    backing:  throwOnSecondRead,
    catalog:  SEED_TASKS,
    todayFn:  () => TODAY,
  });

  const loaded = degradedRepo.loadTasks();
  assert.equal(loaded.length, SEED_TASKS.length,
    'loadTasks must return catalog defaults when storage is broken');

  const result = degradedRepo.saveTasks(loaded);
  assert.equal(result.ok, false,
    'saveTasks must return ok:false after the tasks key was degraded by a read error');
  assert.ok(
    typeof result.error === 'string' && result.error.length > 0,
    'saveTasks failure result must include an error string',
  );
});

/* ── Results ────────────────────────────────────────────────── */
console.log(`\nv1-wiring.test.mjs: ${passed} passed, ${failed} failed  (total ${passed + failed})`);
process.exit(failed > 0 ? 1 : 0);
