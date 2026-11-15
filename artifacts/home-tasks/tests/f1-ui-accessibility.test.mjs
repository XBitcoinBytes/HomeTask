/* ================================================================
   f1-ui-accessibility.test.mjs — F1 UI and accessibility tests.
   26 checks across sections A–E.

   Sections
     A (6) — add-task controller (tasks module layer)
     B (7) — delete controller: removeTask + restoreFromSnapshot
     C (3) — room filter logic: getCustomRooms lifecycle
     D (6) — static HTML source analysis (aria, labels, structure)
     E (4) — static CSS source analysis (safe-area, dvh, 16px, min-height)

   Runs in a standalone Node.js process — no DOM, no browser.
   HTML and CSS are read as plain text for static checks.
   ================================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { V1Repository } from '../src/data/repository/v1-repository.js';
import { SEED_TASKS, SEED_TASK_ROOMS } from '../src/app/catalog.js';
import { tasks } from '../src/app/tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TODAY = '2026-08-14';

/* ── Source texts for static analysis ────────────────────────── */
const htmlSrc  = readFileSync(join(ROOT, 'index.html'), 'utf8');
const appJsSrc = readFileSync(join(ROOT, 'src', 'app', 'app.js'), 'utf8');
const uiJsSrc  = readFileSync(join(ROOT, 'src', 'app', 'ui.js'), 'utf8');
const cssSrc   = readFileSync(join(ROOT, 'src', 'style.css'), 'utf8');

/* ── Set up the tasks singleton ──────────────────────────────── */
function makeBacking() {
  const store = new Map();
  return {
    getItem:    k => store.get(k) ?? null,
    setItem:    (k, v) => store.set(k, v),
    removeItem: k => store.delete(k),
  };
}
const repo = new V1Repository({ backing: makeBacking(), catalog: SEED_TASKS, todayFn: () => TODAY });
tasks.setRepo(repo);

/* ── Test harness ─────────────────────────────────────────────── */
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' — ' + e.message); }
}
console.log('F1 UI and accessibility — 26 checks');

let addedTask, catalogRoomTask;

/* ════════════════════════════════════════════════════════════════
   Section A — add-task controller (tasks module layer)
════════════════════════════════════════════════════════════════ */

check('A1: addTask valid → {ok:true, task._custom:true, id starts with "custom-"}', () => {
  const r = tasks.addTask({ title: 'Polish Floor', room: 'My Den', intervalDays: 14 });
  assert.equal(r.ok, true);
  assert.equal(r.task._custom, true);
  assert.ok(r.task.id.startsWith('custom-'), `id="${r.task.id}"`);
  addedTask = r.task;
});

check('A2: addTask empty title → validation-title code', () => {
  const r = tasks.addTask({ title: '', room: 'My Den', intervalDays: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-title');
});

check('A3: addTask empty room → validation-room code', () => {
  const r = tasks.addTask({ title: 'Valid Title', room: '', intervalDays: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-room');
});

check('A4: addTask interval < 1 → validation-interval code', () => {
  const r = tasks.addTask({ title: 'Valid Title', room: 'My Den', intervalDays: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-interval');
});

check('A5: addTask duplicate room+title → validation-duplicate code', () => {
  // "Polish Floor" in "My Den" was added in A1
  const r = tasks.addTask({ title: 'Polish Floor', room: 'My Den', intervalDays: 99 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'validation-duplicate');
});

check('A6: addTask in existing catalog room → ok:true (catalog rooms are allowed)', () => {
  const r = tasks.addTask({ title: 'Reorganize Spices', room: 'Kitchen', intervalDays: 180 });
  assert.equal(r.ok, true, 'custom tasks in catalog rooms must succeed');
  assert.equal(r.task.room, 'Kitchen');
  catalogRoomTask = r.task;
});

/* ════════════════════════════════════════════════════════════════
   Section B — delete controller (removeTask + restoreFromSnapshot)
════════════════════════════════════════════════════════════════ */

check('B1: removeTask custom task → {ok:true}; task absent from getAll()', () => {
  const r = tasks.addTask({ title: 'B1 Task', room: 'B1 Room', intervalDays: 7 });
  assert.equal(r.ok, true);
  const del = tasks.removeTask(r.task.id);
  assert.equal(del.ok, true);
  assert.ok(!tasks.getAll().some(t => t.id === r.task.id));
});

check('B2: removeTask catalog ID → {ok:false, code:\'catalog-task\'}', () => {
  const r = tasks.removeTask('smoke-batteries');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'catalog-task');
});

check('B3: removeTask nonexistent custom ID → {ok:false, code:\'not-found\'}', () => {
  const r = tasks.removeTask('custom-does-not-exist-b3-acc');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-found');
});

check('B4: degraded repo blocks saveTasks → ok:false (copy-on-write protection)', () => {
  const failBacking = {
    getItem: () => { throw new Error('storage error'); },
    setItem: () => {},
    removeItem: () => {},
  };
  const failRepo = new V1Repository({ backing: failBacking, catalog: SEED_TASKS, todayFn: () => TODAY });
  const loaded = failRepo.loadTasks();  // triggers degraded state
  const r = failRepo.saveTasks(loaded);
  assert.equal(r.ok, false, 'degraded repo must reject saveTasks');
});

check('B5: restoreFromSnapshot returns true and restores getAll() length exactly', () => {
  const snapshot = tasks.getAll().slice();
  const tmp = tasks.addTask({ title: 'B5 Temp', room: 'B5 Room', intervalDays: 7 });
  assert.equal(tmp.ok, true);
  tasks.removeTask(tmp.task.id);
  const ok = tasks.restoreFromSnapshot(snapshot);
  assert.equal(ok, true);
  assert.equal(tasks.getAll().length, snapshot.length);
});

check('B6: after removing last custom task in a custom room, getCustomRooms() excludes it', () => {
  const r = tasks.addTask({ title: 'B6 Task', room: 'My B6 Room', intervalDays: 7 });
  assert.equal(r.ok, true);
  tasks.removeTask(r.task.id);
  assert.ok(!tasks.getCustomRooms().includes('My B6 Room'));
});

check('B7: restoreFromSnapshot after deletion restores task AND its custom room', () => {
  const r = tasks.addTask({ title: 'B7 Task', room: 'My B7 Room', intervalDays: 7 });
  assert.equal(r.ok, true);
  const snapshot = tasks.getAll().slice();
  tasks.removeTask(r.task.id);
  assert.ok(!tasks.getCustomRooms().includes('My B7 Room'), 'room absent after delete');
  const ok = tasks.restoreFromSnapshot(snapshot);
  assert.equal(ok, true);
  assert.ok(tasks.getCustomRooms().includes('My B7 Room'), 'room restored by snapshot');
});

/* ════════════════════════════════════════════════════════════════
   Section C — room filter logic (getCustomRooms lifecycle)
════════════════════════════════════════════════════════════════ */

check('C1: custom task in catalog room does NOT appear in getCustomRooms()', () => {
  // catalogRoomTask was added to "Kitchen" in A6
  const rooms = tasks.getCustomRooms();
  assert.ok(!rooms.includes('Kitchen'), '"Kitchen" must not be in custom rooms');
  assert.ok(SEED_TASK_ROOMS.has('Kitchen'), '"Kitchen" is a built-in room (precondition)');
});

check('C2: getCustomRooms() returns [] when all tasks in custom rooms are removed', () => {
  const snapshot = tasks.getAll().slice();
  const customRooms = tasks.getCustomRooms();
  // Remove every custom task that is in a custom (non-catalog) room
  tasks.getAll()
    .filter(t => t._custom && customRooms.includes(t.room))
    .forEach(t => tasks.removeTask(t.id));
  assert.deepEqual(tasks.getCustomRooms(), []);
  tasks.restoreFromSnapshot(snapshot);  // restore for C3
});

check('C3: restoreFromSnapshot after all-custom-room deletions restores getCustomRooms()', () => {
  const snapshot = tasks.getAll().slice();
  const roomsBefore = tasks.getCustomRooms();
  // Remove all custom tasks in custom rooms
  tasks.getAll()
    .filter(t => t._custom && !SEED_TASK_ROOMS.has(t.room))
    .forEach(t => tasks.removeTask(t.id));
  assert.deepEqual(tasks.getCustomRooms(), [], 'all custom rooms cleared');
  const ok = tasks.restoreFromSnapshot(snapshot);
  assert.equal(ok, true);
  const roomsAfter = tasks.getCustomRooms();
  roomsBefore.forEach(r =>
    assert.ok(roomsAfter.includes(r), `room "${r}" must be restored`)
  );
});

/* ════════════════════════════════════════════════════════════════
   Section D — static HTML accessibility analysis
   Reads index.html, app.js, ui.js as text — no module loading.
════════════════════════════════════════════════════════════════ */

check('D1: add-task dialog uses native <dialog> with aria-labelledby="at-title"', () => {
  assert.ok(htmlSrc.includes('id="add-task-dialog"'),
    'add-task-dialog element must be present');
  assert.ok(htmlSrc.includes('aria-labelledby="at-title"'),
    'dialog must declare aria-labelledby="at-title"');
  assert.ok(htmlSrc.includes('<dialog'), 'native <dialog> element must be used');
});

check('D2: FAB has id="add-task-fab" and aria-label="Add new task"', () => {
  assert.ok(htmlSrc.includes('id="add-task-fab"'),
    'FAB element must be present');
  assert.ok(htmlSrc.includes('aria-label="Add new task"'),
    'FAB must have aria-label="Add new task"');
});

check('D3: aria-labelledby target element (at-title) is present in HTML', () => {
  assert.ok(htmlSrc.includes('id="at-title"'),
    'id="at-title" must exist in index.html for aria-labelledby resolution');
});

check('D4: delete confirmation uses a named native dialog with an accessible error announcement', () => {
  assert.ok(htmlSrc.includes('id="delete-confirm-dialog"'),
    'delete confirmation dialog must be present');
  assert.ok(htmlSrc.includes('aria-labelledby="dc-title"'),
    'delete confirmation dialog must have an accessible name');
  assert.ok(htmlSrc.includes('id="dc-error" role="alert"'),
    'delete confirmation must expose failures through an alert');
});

check('D5: delete button in ui.js is gated by task._custom and CUSTOM_TASKS_UI_ENABLED', () => {
  assert.ok(uiJsSrc.includes('CUSTOM_TASKS_UI_ENABLED && task._custom'),
    'delete button must check CUSTOM_TASKS_UI_ENABLED && task._custom');
  assert.ok(uiJsSrc.includes('js-delete'),
    'delete button must have class js-delete');
});

check('D6: delete button aria-label dynamically includes the task title', () => {
  // The source text of the template literal contains the expression literally
  assert.ok(uiJsSrc.includes('aria-label="Delete ${esc(task.title)}"'),
    'delete button aria-label must include esc(task.title)');
});

/* ════════════════════════════════════════════════════════════════
   Section E — static CSS: responsive and safe-area rules
════════════════════════════════════════════════════════════════ */

check('E1: .fab uses env(safe-area-inset-bottom) for iPhone safe area', () => {
  assert.ok(cssSrc.includes('.fab'),
    '.fab selector must exist in style.css');
  assert.ok(cssSrc.includes('env(safe-area-inset-bottom'),
    'style.css must reference env(safe-area-inset-bottom) for the FAB area');
});

check('E2: .at-sheet max-height uses dvh unit for dynamic viewport height', () => {
  assert.ok(cssSrc.includes('.at-sheet'), '.at-sheet must exist in style.css');
  // The add-task sheet must use dvh (for dynamic viewport height on mobile)
  const sheetStart = cssSrc.indexOf('.at-sheet');
  const sheetChunk = cssSrc.slice(sheetStart, sheetStart + 400);
  assert.ok(sheetChunk.includes('dvh'),
    '.at-sheet must use dvh unit for max-height');
});

check('E3: .at-input has font-size: 16px (prevents iOS zoom on focus)', () => {
  assert.ok(cssSrc.includes('.at-input'),
    '.at-input must exist in style.css');
  assert.ok(cssSrc.includes('font-size: 16px'),
    'style.css must include font-size: 16px for inputs (prevents iOS auto-zoom)');
});

check('E4: .at-body has min-height: 0 (required for flex child scrolling)', () => {
  assert.ok(cssSrc.includes('.at-body'), '.at-body must exist in style.css');
  const bodyStart = cssSrc.indexOf('.at-body');
  const bodyChunk = cssSrc.slice(bodyStart, bodyStart + 200);
  assert.ok(bodyChunk.includes('min-height: 0'),
    '.at-body must have min-height: 0 for correct overflow scrolling');
});

/* ── Results ──────────────────────────────────────────────────── */
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
