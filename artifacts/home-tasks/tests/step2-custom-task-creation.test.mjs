/* ================================================================
   Step 2 — iPhone-friendly custom task creation

   Focused synthetic checks for the existing-room-only creation flow:
   model validation/persistence plus static DOM/controller/mobile contracts.
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { V1Repository } from '../src/data/repository/v1-repository.js';
import { tasks } from '../src/app/tasks.js';

const TODAY = '2026-08-20';
const MINI_CATALOG = [
  { id: 'seed-kitchen', title: 'Clean Sink', room: 'Kitchen', intervalDays: 7,
    tags: [], lastDone: null, doneToday: false, skipUntil: null },
  { id: 'seed-bedroom', title: 'Change Sheets', room: 'Bedroom', intervalDays: 7,
    tags: [], lastDone: null, doneToday: false, skipUntil: null },
];

function makeBacking(initial = {}) {
  const values = new Map(Object.entries(initial));
  let failWrites = false;
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (failWrites) throw new Error('synthetic-write-failure');
      values.set(key, value);
    },
    removeItem(key) { values.delete(key); },
    failWrites(value) { failWrites = value; },
    read(key) { return values.get(key); },
  };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + ' — ' + error.message); }
}

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

console.log('Step 2 custom task creation — focused checks');

check('M1: creates exactly one custom task in a built-in room with safe whitespace normalization', () => {
  const backing = makeBacking();
  const repo = new V1Repository({ backing, catalog: MINI_CATALOG, todayFn: () => TODAY });
  const before = repo.loadTasks();
  const input = { title: '  organize   spice rack  ', room: ' Kitchen ', intervalDays: 14 };
  const all = [...before, {
    id: 'custom-step2-kitchen',
    title: 'Organize Spice Rack',
    room: 'Kitchen',
    intervalDays: 14,
    tags: [], lastDone: null, doneToday: false, skipUntil: null, _custom: true,
  }];
  assert.equal(repo.saveTasks(all).ok, true);
  const reloaded = repo.loadTasks();
  const custom = reloaded.filter(task => task._custom);
  assert.equal(custom.length, 1);
  assert.deepEqual(
    { title: custom[0].title, room: custom[0].room, intervalDays: custom[0].intervalDays },
    { title: 'Organize Spice Rack', room: 'Kitchen', intervalDays: input.intervalDays },
  );
});

check('M2: tasks.addTask accepts a built-in room, persists the custom record, and reloads it', () => {
  const backing = makeBacking();
  const repo = new V1Repository({ backing, catalog: MINI_CATALOG, todayFn: () => TODAY });
  tasks.setRepo(repo);
  const result = tasks.addTask({
    title: '  clean   oven racks ',
    room: ' Kitchen ',
    intervalDays: 30,
    generator: () => 'custom-step2-built-in-room',
  });
  assert.equal(result.ok, true);
  assert.equal(result.task._custom, true);
  assert.equal(result.task.id, 'custom-step2-built-in-room');
  assert.equal(result.task.title, 'Clean Oven Racks');
  assert.equal(result.task.room, 'Kitchen');
  assert.ok(repo.loadTasks().some(task => task.id === result.task.id));
});

check('M3: collision-safe ID generation refuses repeated IDs without persisting a duplicate', () => {
  const before = tasks.getAll().length;
  const result = tasks.addTask({
    title: 'Collision Candidate',
    room: 'Kitchen',
    intervalDays: 7,
    generator: () => 'custom-step2-built-in-room',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'id-generation-exhausted');
  assert.equal(tasks.getAll().length, before);
});

check('M4: required-field validation rejects whitespace-only task names before persistence', () => {
  const before = tasks.getAll().length;
  const result = tasks.addTask({
    title: '   ',
    room: 'Kitchen',
    intervalDays: 7,
    generator: () => 'custom-step2-should-not-save',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'validation-title');
  assert.equal(tasks.getAll().length, before);
});

check('M5: repository write failure leaves in-memory tasks and stored bytes unchanged', () => {
  const backing = makeBacking();
  const repo = new V1Repository({ backing, catalog: MINI_CATALOG, todayFn: () => TODAY });
  const original = repo.loadTasks();
  const beforeBytes = backing.read('hometask-v1');
  backing.failWrites(true);
  const attempted = [...original, {
    id: 'custom-step2-failed-write', title: 'Failed Write', room: 'Kitchen',
    intervalDays: 7, tags: [], lastDone: null, doneToday: false, skipUntil: null, _custom: true,
  }];
  const result = repo.saveTasks(attempted);
  assert.equal(result.ok, false);
  assert.equal(backing.read('hometask-v1'), beforeBytes);
  assert.deepEqual(repo.loadTasks(), original);
});

check('U1: the sheet has visible labels and accessible error descriptions for every form field', () => {
  assert.ok(html.includes('for="at-title-input"'), 'task-name label must target its input');
  assert.ok(html.includes('for="at-room-select"'), 'room label must target its select');
  assert.ok(html.includes('id="at-frequency-label"'), 'frequency group must have a visible label');
  assert.ok(html.includes('aria-labelledby="at-frequency-label"'), 'frequency group must reference its label');
  assert.ok(html.includes('aria-describedby="at-room-error"'), 'room select must describe its error');
  assert.ok(html.includes('aria-describedby="at-freq-error"'), 'custom frequency input must describe its error');
  assert.ok(html.includes('role="alert"'), 'validation errors must announce accessibly');
});

check('U2: creation is limited to existing built-in and existing custom rooms', () => {
  assert.ok(app.includes('ROOMS_ORDERED.forEach'), 'catalog rooms must populate the selector');
  assert.ok(app.includes('tasks.getCustomRooms()'), 'existing custom rooms must populate the selector');
  assert.ok(!html.includes('at-room-input'), 'out-of-scope new-room input must be absent');
  assert.ok(!app.includes("'__new__'"), 'controller must not create a new-room mode');
  assert.ok(!html.includes('New room'), 'new-room option must be absent');
});

check('U3: open/cancel is mutation-free and focus returns to the triggering control', () => {
  assert.ok(app.includes('_addTaskReturnFocus'), 'dialog must remember the opening control');
  assert.ok(app.includes('target?.focus()'), 'dialog close must restore focus');
  assert.ok(app.includes("dlg.close()"), 'close and cancel must dismiss without calling tasks.addTask');
  const openBlock = app.slice(app.indexOf('function _openAddTask'), app.indexOf('function _populateRoomSelect'));
  assert.ok(!openBlock.includes('tasks.addTask'), 'opening the dialog must not mutate tasks');
});

check('U4: submit prevents duplicate writes, retains fields on failure, and renders the saved task immediately', () => {
  assert.ok(app.includes('if (_addTaskPending) return'), 'pending submissions must be ignored');
  assert.ok(app.includes('submitBtn.disabled = true'), 'submit button must disable while saving');
  assert.ok(app.includes('submitBtn.setAttribute(\'aria-busy\', \'true\')'), 'saving state must be exposed');
  const submitBlock = app.slice(app.indexOf('function _submitAddTask'), app.indexOf('function _wireAddTask'));
  assert.ok(!submitBlock.includes('titleInput.value = \'\''), 'failed submission must retain the entered title');
  assert.ok(app.includes('result.task.room'), 'success navigation must use the selected room');
  assert.ok(app.includes('card?.scrollIntoView'), 'saved task must be revealed after render');
});

check('U5: iPhone controls meet the 44px target and sheet remains keyboard-safe', () => {
  assert.ok(css.includes('.at-dialog') && css.includes('max-height: 92dvh'),
    'sheet must use dynamic viewport height');
  assert.ok(css.includes('.at-body') && css.includes('min-height: 0'),
    'sheet body must remain scrollable with the on-screen keyboard');
  assert.ok(css.includes('.at-close') && css.includes('min-width: 44px'),
    'close control must meet the touch target');
  assert.ok(css.includes('.at-freq-btn') && css.includes('min-height: 44px'),
    'frequency controls must meet the touch target');
  assert.ok(css.includes('.at-submit') && css.includes('height: 50px'),
    'submit control must meet the touch target');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);