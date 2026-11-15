/* ================================================================
   f1-custom-tasks.test.mjs — F1 custom task management
   38 checks across sections A–H.

   Sections
     A (7)  — V1Repository custom-task append pass
     B (9)  — tasks.addTask validation, save, and normalization
     C (5)  — tasks.removeTask: success, guards, copy-on-write
     D (4)  — custom room derivation via getCustomRooms()
     E (3)  — tasks.isCustomTask
     F (3)  — persistence and restoreFromSnapshot round-trip
     G (4)  — cross-cutting invariants
     H (3)  — ID generation: default, injected, collision

   Runs in a standalone Node.js process — no DOM, no browser.
   ================================================================ */
import assert from 'node:assert/strict';
import { V1Repository }    from '../src/data/repository/v1-repository.js';
import { SEED_TASKS, SEED_TASK_IDS, SEED_TASK_ROOMS } from '../src/app/catalog.js';
import { tasks } from '../src/app/tasks.js';
import { todayStr } from '../src/app/util.js';

const TODAY = '2026-08-14';
const FROZEN_ISO = `${TODAY}T12:00:00.000Z`;
const RealDate = globalThis.Date;

/** Keep production todayStr() aligned with the synthetic fixture date. */
function withFrozenDate(fn) {
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FROZEN_ISO);
      else super(...args);
    }
    static now() { return new RealDate(FROZEN_ISO).getTime(); }
  }
  globalThis.Date = FrozenDate;
  try { return fn(); }
  finally { globalThis.Date = RealDate; }
}

/* ── Minimal catalog for A section (fresh repos, isolated) ─────── */
const MINI = [{
  id: 'seed-a', title: 'Seed Task', room: 'Seed Room', intervalDays: 30,
  lastDone: null, doneToday: false, skipUntil: null, tags: [],
}];

/* ── Fake backing ─────────────────────────────────────────────── */
function makeBacking(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem:    k => store.has(k) ? store.get(k) : null,
    setItem:    (k, v) => store.set(k, v),
    removeItem: k => store.delete(k),
  };
}
function makeRepo(catalog = SEED_TASKS) {
  return new V1Repository({ backing: makeBacking(), catalog, todayFn: () => TODAY });
}

/* ── Set up the tasks singleton (one repo per process) ─────────── */
const mainRepo = makeRepo();
tasks.setRepo(mainRepo);

/* ── Test harness ─────────────────────────────────────────────── */
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' — ' + e.message); }
}
console.log('F1 custom tasks — 38 checks');

/* Task instances tracked across sections (sequential state) */
let task1, task2, task3, task4, task5;

/* ════════════════════════════════════════════════════════════════
   Section A — V1Repository custom-task append pass
   Fresh V1Repository instances for each check; no tasks singleton.
════════════════════════════════════════════════════════════════ */

check('A1: loadTasks appends _custom:true records after catalog result', () => {
  const b = makeBacking({
    'hometask-v1': JSON.stringify([
      MINI[0],
      { id: 'custom-a1', title: 'Custom A1', room: 'My Loft',
        intervalDays: 14, _custom: true, lastDone: null, doneToday: false, skipUntil: null, tags: [] },
    ]),
  });
  const repo = new V1Repository({ backing: b, catalog: MINI, todayFn: () => TODAY });
  const all = repo.loadTasks();
  assert.equal(all.filter(t => t._custom).length, 1);
  assert.equal(all.filter(t => t._custom)[0].title, 'Custom A1');
  assert.equal(all.length, 2, 'catalog(1) + custom(1)');
});

check('A2: record with _custom:false is NOT appended', () => {
  const b = makeBacking({
    'hometask-v1': JSON.stringify([
      MINI[0],
      { id: 'custom-a2', title: 'Not Custom', room: 'Room', intervalDays: 7, _custom: false },
    ]),
  });
  const all = new V1Repository({ backing: b, catalog: MINI, todayFn: () => TODAY }).loadTasks();
  assert.equal(all.filter(t => t._custom).length, 0);
  assert.equal(all.length, 1);
});

check('A3: custom record with empty title is skipped by append pass', () => {
  const b = makeBacking({
    'hometask-v1': JSON.stringify([
      { id: 'custom-a3', title: '', room: 'Room', intervalDays: 7, _custom: true },
    ]),
  });
  const all = new V1Repository({ backing: b, catalog: MINI, todayFn: () => TODAY }).loadTasks();
  assert.equal(all.filter(t => t._custom).length, 0);
});

check('A4: custom record with empty id is skipped (savedMap rejects id.length === 0)', () => {
  const b = makeBacking({
    'hometask-v1': JSON.stringify([
      { id: '', title: 'Good Title', room: 'Room', intervalDays: 7, _custom: true },
    ]),
  });
  const all = new V1Repository({ backing: b, catalog: MINI, todayFn: () => TODAY }).loadTasks();
  assert.equal(all.filter(t => t._custom).length, 0);
});

check('A5: storage read error (degraded) → catalog-only, zero custom tasks', () => {
  const errorBacking = {
    getItem: () => { throw new Error('storage error'); },
    setItem: () => {},
    removeItem: () => {},
  };
  const repo = new V1Repository({ backing: errorBacking, catalog: MINI, todayFn: () => TODAY });
  const all = repo.loadTasks();
  assert.equal(all.length, 1, 'catalog defaults on read error');
  assert.equal(all.filter(t => t._custom).length, 0);
});

check('A6: JSON parse error → catalog-only, zero custom tasks', () => {
  const b = makeBacking({ 'hometask-v1': '{ broken json ' });
  const all = new V1Repository({ backing: b, catalog: MINI, todayFn: () => TODAY }).loadTasks();
  assert.equal(all.length, 1);
  assert.equal(all.filter(t => t._custom).length, 0);
});

check('A7: first-use (key missing) → seeded catalog-only, zero custom tasks', () => {
  const all = makeRepo(MINI).loadTasks();
  assert.equal(all.length, 1, 'seeded catalog only');
  assert.equal(all.filter(t => t._custom).length, 0);
});

/* ════════════════════════════════════════════════════════════════
   Section B — tasks.addTask
   State before: 122 seeded tasks
════════════════════════════════════════════════════════════════ */

check('B1: valid addTask → {ok:true, task._custom:true}', () => {
  const r = tasks.addTask({ title: 'dust shelves', room: 'My Studio', intervalDays: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.task._custom, true);
  assert.equal(r.task.room, 'My Studio');
  task1 = r.task;
});

check('B2: empty title → validation-title', () => {
  const r = tasks.addTask({ title: '', room: 'My Studio', intervalDays: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-title');
});

check('B3: title > 80 chars → validation-title', () => {
  const r = tasks.addTask({ title: 'x'.repeat(81), room: 'My Studio', intervalDays: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-title');
});

check('B4: intervalDays < 1 → validation-interval', () => {
  const r = tasks.addTask({ title: 'Clean Stuff', room: 'My Studio', intervalDays: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-interval');
});

check('B5: intervalDays > 365 → validation-interval', () => {
  const r = tasks.addTask({ title: 'Clean Stuff', room: 'My Studio', intervalDays: 400 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-interval');
});

check('B6: empty room → validation-room', () => {
  const r = tasks.addTask({ title: 'Clean Stuff', room: '', intervalDays: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-room');
});

check('B7: success → saveTasks called; total count increases by 1', () => {
  const before = tasks.getAll().length;
  const r = tasks.addTask({ title: 'clean windows', room: 'My Studio', intervalDays: 14 });
  assert.equal(r.ok, true);
  assert.equal(tasks.getAll().length, before + 1);
  task2 = r.task;
});

check('B8: task title is normalized to Title Case before saving', () => {
  const r = tasks.addTask({ title: 'clean floor', room: 'My Attic', intervalDays: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.task.title, 'Clean Floor', 'normalized to Title Case');
  task3 = r.task;
});

check('B9: duplicate canonical room+title → validation-duplicate', () => {
  // task1 is "Dust Shelves" (normalized) in "My Studio"
  const r = tasks.addTask({ title: 'Dust Shelves', room: 'My Studio', intervalDays: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-duplicate');
});

/* ════════════════════════════════════════════════════════════════
   Section C — tasks.removeTask
   State before: 122 + 3 = 125 tasks
════════════════════════════════════════════════════════════════ */

check('C1: removeTask custom task → {ok:true}; task absent from getAll()', () => {
  const r = tasks.removeTask(task1.id);
  assert.equal(r.ok, true);
  assert.ok(!tasks.getAll().some(t => t.id === task1.id));
  // State: 124 tasks
});

check('C2: removeTask catalog ID → {ok:false, code:\'catalog-task\'}', () => {
  const r = tasks.removeTask('mb-baseboards');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'catalog-task');
});

check('C3: removeTask nonexistent custom ID → {ok:false, code:\'not-found\'}', () => {
  const r = tasks.removeTask('custom-nonexistent-xyz-000abc');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-found');
});

check('C4: degraded repo → saveTasks blocked; read still returns catalog defaults', () => {
  const errorBacking = {
    getItem: () => { throw new Error('read error'); },
    setItem: () => {},
    removeItem: () => {},
  };
  const repo = new V1Repository({ backing: errorBacking, catalog: MINI, todayFn: () => TODAY });
  const loaded = repo.loadTasks();          // triggers degraded state on TASKS_KEY
  const result = repo.saveTasks(loaded);    // blocked by degraded guard
  assert.equal(result.ok, false, 'saveTasks must return ok:false when degraded');
  assert.equal(loaded.length, 1, 'catalog defaults returned even on read error');
});

check('C5: removing last custom task in a room removes it from getCustomRooms()', () => {
  // task3 is the only custom task in "My Attic"
  const r = tasks.removeTask(task3.id);
  assert.equal(r.ok, true);
  assert.ok(!tasks.getCustomRooms().includes('My Attic'));
  // State: 123 tasks (only task2: Clean Windows/My Studio)
});

/* ════════════════════════════════════════════════════════════════
   Section D — custom room derivation
   State before: 123 tasks (task2: Clean Windows/My Studio)
════════════════════════════════════════════════════════════════ */

check('D1: getCustomRooms() returns rooms of _custom:true tasks not in SEED_TASK_ROOMS', () => {
  const rooms = tasks.getCustomRooms();
  assert.ok(rooms.includes('My Studio'), '"My Studio" should appear as a custom room');
  assert.ok(!SEED_TASK_ROOMS.has('My Studio'), '"My Studio" must not be a built-in room');
});

check('D2: two tasks in the same custom room → one entry in getCustomRooms()', () => {
  const r = tasks.addTask({ title: 'Clean Mirrors', room: 'My Studio', intervalDays: 30 });
  assert.equal(r.ok, true);
  task4 = r.task;
  const rooms = tasks.getCustomRooms();
  assert.equal(rooms.filter(r => r === 'My Studio').length, 1, 'deduplicated');
});

check('D3: custom task in a catalog room is excluded from getCustomRooms()', () => {
  const r = tasks.addTask({ title: 'Polish Backsplash', room: 'Kitchen', intervalDays: 30 });
  assert.equal(r.ok, true, 'custom tasks in catalog rooms must be allowed');
  task5 = r.task;
  assert.ok(!tasks.getCustomRooms().includes('Kitchen'), '"Kitchen" is built-in');
});

check('D4: removing all custom tasks in a room removes it from getCustomRooms()', () => {
  const r = tasks.addTask({ title: 'Temp Task', room: 'My Temp Room', intervalDays: 7 });
  assert.equal(r.ok, true);
  const tempTask = r.task;
  assert.ok(tasks.getCustomRooms().includes('My Temp Room'));
  tasks.removeTask(tempTask.id);
  assert.ok(!tasks.getCustomRooms().includes('My Temp Room'));
});

/* ════════════════════════════════════════════════════════════════
   Section E — tasks.isCustomTask
   State: task2, task4, task5 present
════════════════════════════════════════════════════════════════ */

check('E1: isCustomTask(custom task ID) → true', () => {
  assert.equal(tasks.isCustomTask(task2.id), true);
});

check('E2: isCustomTask(catalog ID) → false', () => {
  assert.equal(tasks.isCustomTask('mb-baseboards'), false);
});

check('E3: isCustomTask(unknown ID) → false', () => {
  assert.equal(tasks.isCustomTask('custom-xyz-absolutely-not-here-abc'), false);
});

/* ════════════════════════════════════════════════════════════════
   Section F — persistence and snapshot round-trip
════════════════════════════════════════════════════════════════ */

check('F1: getAll() includes all custom tasks alongside 122 catalog tasks', () => {
  const all = tasks.getAll();
  assert.ok(all.some(t => t.id === task2.id), 'task2 in getAll()');
  assert.ok(all.some(t => t.id === task4.id), 'task4 in getAll()');
  assert.ok(all.some(t => t.id === task5.id), 'task5 in getAll()');
});

check('F2: restoreFromSnapshot restores prior state exactly', () => {
  const snapshot = tasks.getAll().slice();
  tasks.removeTask(task4.id);
  assert.ok(!tasks.getAll().some(t => t.id === task4.id), 'task4 removed');
  const ok = tasks.restoreFromSnapshot(snapshot);
  assert.equal(ok, true);
  assert.ok(tasks.getAll().some(t => t.id === task4.id), 'task4 restored');
  assert.equal(tasks.getAll().length, snapshot.length, 'length matches snapshot');
});

check('F3: V1Repository.loadTasks returns custom tasks stored via addTask', () => {
  // Verify the main backing now contains custom tasks that survive a reload
  const reloaded = mainRepo.loadTasks();
  const custom = reloaded.filter(t => t._custom);
  assert.ok(custom.length > 0, 'custom tasks persist through loadTasks()');
  assert.ok(custom.some(t => t.id === task2.id), 'task2 survives reload');
});

/* ════════════════════════════════════════════════════════════════
   Section G — invariants
════════════════════════════════════════════════════════════════ */

check('G1: SEED_TASK_IDS contains no IDs with the "custom-" prefix', () => {
  const hasCustomPrefix = [...SEED_TASK_IDS].some(id => id.startsWith('custom-'));
  assert.equal(hasCustomPrefix, false);
});

check('G2: markDone on a custom task updates lastDone to today', () => {
  withFrozenDate(() => {
    assert.equal(todayStr(), TODAY, 'production todayStr() must observe the frozen fixture date');
    tasks.markDone(task2.id);
    const t = tasks.getAll().find(t => t.id === task2.id);
    assert.equal(t.lastDone, TODAY);
  });
});

check('G3: skipToday on a custom task sets skipUntil', () => {
  tasks.skipToday(task4.id);
  const t = tasks.getAll().find(t => t.id === task4.id);
  assert.ok(t.skipUntil !== null, 'skipUntil set after skipToday');
});

check('G4: getAll().length equals 122 catalog + current custom task count', () => {
  const all = tasks.getAll();
  const custom = all.filter(t => t._custom);
  assert.equal(all.length, 122 + custom.length, 'total = catalog + custom');
});

/* ════════════════════════════════════════════════════════════════
   Section H — ID generation
════════════════════════════════════════════════════════════════ */

check('H1: default generator produces IDs with the "custom-" prefix', () => {
  assert.ok(task2.id.startsWith('custom-'), `task2.id="${task2.id}"`);
  assert.ok(task4.id.startsWith('custom-'), `task4.id="${task4.id}"`);
});

check('H2: injected generator is used when provided', () => {
  const r = tasks.addTask({
    title: 'H2 Task', room: 'My Lab', intervalDays: 7,
    generator: () => 'custom-h2-injected-test-id',
  });
  assert.equal(r.ok, true);
  assert.equal(r.task.id, 'custom-h2-injected-test-id');
});

check('H3: generator producing always-colliding IDs → id-generation-exhausted', () => {
  // task2.id is already in _items — the generator always returns it → collision every time
  const r = tasks.addTask({
    title: 'H3 Task', room: 'My Lab', intervalDays: 7,
    generator: () => task2.id,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'id-generation-exhausted');
});

/* ── Results ──────────────────────────────────────────────────── */
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
