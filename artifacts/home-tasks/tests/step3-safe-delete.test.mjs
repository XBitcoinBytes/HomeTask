/* ================================================================
   Step 3 — safe custom-task deletion

   Deterministic tests for deferred persistence: a custom task is hidden
   during its five-second undo window, but remains in the model/storage until
   the fake clock reaches expiry.
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeferredDelete } from '../src/app/deferred-delete.js';

class FakeScheduler {
  #now = 0;
  #nextId = 1;
  #timers = new Map();

  setTimeout(callback, delay) {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, dueAt: this.#now + delay });
    return id;
  }

  clearTimeout(id) {
    this.#timers.delete(id);
  }

  advance(ms) {
    const target = this.#now + ms;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort(([, a], [, b]) => a.dueAt - b.dueAt)[0];
      if (!next) break;
      const [id, timer] = next;
      this.#now = timer.dueAt;
      this.#timers.delete(id);
      timer.callback();
    }
    this.#now = target;
  }
}

function customTask() {
  return {
    id: 'custom-step3-kitchen', title: 'Clean Oven Racks', room: 'Kitchen',
    intervalDays: 14, tags: ['deep clean'], lastDone: '2026-08-01',
    doneToday: false, skipUntil: null, _custom: true,
    preserved: { note: 'keep this safe field', flags: ['a', 'b'] },
  };
}

function builtInTask() {
  return {
    id: 'seed-kitchen', title: 'Clean Sink', room: 'Kitchen',
    intervalDays: 7, tags: [], lastDone: null, doneToday: false,
    skipUntil: null,
  };
}

function makeModel({ failDelete = false } = {}) {
  let items = [builtInTask(), customTask()];
  let writes = 0;
  let bytes = JSON.stringify(items);
  return {
    getAll: () => items.map(task => structuredClone(task)),
    isCustomTask: id => items.find(task => task.id === id)?._custom === true,
    removeTask(id) {
      const task = items.find(item => item.id === id);
      if (!task) return { ok: false, code: 'not-found', message: 'Task not found.' };
      if (task._custom !== true) {
        return { ok: false, code: 'catalog-task', message: 'Built-in tasks cannot be deleted.' };
      }
      writes++;
      if (failDelete) return { ok: false, code: 'storage-error', message: 'synthetic write failure' };
      items = items.filter(item => item.id !== id);
      bytes = JSON.stringify(items);
      return { ok: true };
    },
    snapshot: () => structuredClone(items),
    bytes: () => bytes,
    writes: () => writes,
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
const tasksSource = readFileSync(new URL('../src/app/tasks.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/app/ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

console.log('Step 3 safe custom-task deletion — focused checks');

check('D1: built-in tasks are rejected before a deferred deletion can begin', () => {
  const model = makeModel();
  const controller = createDeferredDelete({ taskModel: model, scheduler: new FakeScheduler() });
  const result = controller.begin('seed-kitchen');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-custom-task');
  assert.equal(model.writes(), 0);
  assert.equal(model.getAll().length, 2);
});

check('D2: confirming custom deletion performs no write before the five-second deadline', () => {
  const model = makeModel();
  const scheduler = new FakeScheduler();
  const controller = createDeferredDelete({ taskModel: model, scheduler });
  const before = model.snapshot();
  const result = controller.begin('custom-step3-kitchen');
  assert.equal(result.ok, true);
  assert.deepEqual(result.task.preserved, before[1].preserved);
  assert.equal(model.writes(), 0);
  assert.deepEqual(model.snapshot(), before, 'the model remains reload-safe during undo');
  scheduler.advance(4999);
  assert.equal(model.writes(), 0);
  assert.ok(model.getAll().some(task => task.id === 'custom-step3-kitchen'));
});

check('D3: expiry at exactly 5,000ms performs one persistent deletion of exactly the pending custom task', () => {
  const model = makeModel();
  const scheduler = new FakeScheduler();
  const events = [];
  const controller = createDeferredDelete({
    taskModel: model, scheduler, onExpire: event => events.push(event),
  });
  controller.begin('custom-step3-kitchen');
  scheduler.advance(5000);
  assert.equal(model.writes(), 1);
  assert.equal(model.getAll().some(task => task.id === 'custom-step3-kitchen'), false);
  assert.ok(model.getAll().some(task => task.id === 'seed-kitchen'));
  assert.equal(events.length, 1);
  assert.equal(events[0].result.ok, true);
  assert.deepEqual(events[0].task.preserved, customTask().preserved);
});

check('D4: undo before expiry keeps every original field and performs no persistence write', () => {
  const model = makeModel();
  const scheduler = new FakeScheduler();
  const controller = createDeferredDelete({ taskModel: model, scheduler });
  const before = model.snapshot();
  controller.begin('custom-step3-kitchen');
  scheduler.advance(4999);
  const undone = controller.undo('custom-step3-kitchen');
  scheduler.advance(1);
  assert.equal(undone.ok, true);
  assert.equal(model.writes(), 0);
  assert.deepEqual(model.snapshot(), before);
  assert.equal(controller.getPending(), null);
});

check('D5: duplicate delete attempts and duplicate expiry writes are blocked', () => {
  const model = makeModel();
  const scheduler = new FakeScheduler();
  const controller = createDeferredDelete({ taskModel: model, scheduler });
  assert.equal(controller.begin('custom-step3-kitchen').ok, true);
  assert.equal(controller.begin('custom-step3-kitchen').code, 'delete-pending');
  scheduler.advance(5000);
  scheduler.advance(5000);
  assert.equal(model.writes(), 1);
});

check('D6: a permanent persistence failure retains all original data and stored bytes', () => {
  const model = makeModel({ failDelete: true });
  const scheduler = new FakeScheduler();
  const events = [];
  const controller = createDeferredDelete({
    taskModel: model, scheduler, onExpire: event => events.push(event),
  });
  const beforeItems = model.snapshot();
  const beforeBytes = model.bytes();
  controller.begin('custom-step3-kitchen');
  scheduler.advance(5000);
  assert.equal(model.writes(), 1, 'one attempted write is allowed at expiry');
  assert.deepEqual(model.snapshot(), beforeItems);
  assert.equal(model.bytes(), beforeBytes);
  assert.equal(events[0].result.ok, false);
  assert.equal(events[0].result.code, 'storage-error');
});

check('D7: a reload before expiry sees the original task because no deletion was stored', () => {
  const model = makeModel();
  const scheduler = new FakeScheduler();
  const firstSession = createDeferredDelete({ taskModel: model, scheduler });
  firstSession.begin('custom-step3-kitchen');
  firstSession.dispose();
  const reloadedSession = createDeferredDelete({ taskModel: model, scheduler });
  assert.equal(reloadedSession.getPending(), null);
  assert.ok(model.getAll().some(task => task.id === 'custom-step3-kitchen'));
  assert.equal(model.writes(), 0);
});

check('D8: an expiry write failure retains the task and has an accessible Search-dialog error path', () => {
  const model = makeModel({ failDelete: true });
  const scheduler = new FakeScheduler();
  let expiryResult = null;
  const controller = createDeferredDelete({
    taskModel: model, scheduler, onExpire: event => { expiryResult = event.result; },
  });
  controller.begin('custom-step3-kitchen');
  scheduler.advance(5000);
  assert.equal(expiryResult?.ok, false);
  assert.ok(model.getAll().some(task => task.id === 'custom-step3-kitchen'));
  assert.ok(app.includes('_searchDeleteFailure = { task, message: result.message }'),
    'failure state must be set before rerendering the active Search dialog');
  assert.ok(app.includes('function _prependSrDeleteFailure()') && app.includes("notice.setAttribute('role', 'alert')"),
    'the active Search dialog must contain an assertive failure announcement');
});

check('U1: custom delete controls and the confirmation dialog are accessible and task-specific', () => {
  assert.ok(ui.includes('CUSTOM_TASKS_UI_ENABLED && task._custom'), 'delete control must be custom-task-only');
  assert.ok(html.includes('<dialog class="dc-dialog" id="delete-confirm-dialog"'), 'native confirmation dialog required');
  assert.ok(html.includes('aria-labelledby="dc-title"'), 'dialog must name itself');
  assert.ok(html.includes('aria-describedby="dc-message"'), 'dialog must identify the exact task');
  assert.ok(html.includes('id="dc-error" role="alert"'), 'confirmation errors must announce accessibly');
  assert.ok(app.includes('Undo deleting ${task.title}'), 'undo control must name the deleted task');
});

check('U2: the app defers persistent deletion and makes failure visible without snapshot rewrites', () => {
  assert.ok(app.includes('createDeferredDelete'), 'app must use the deferred controller');
  assert.ok(app.includes('function _visibleTasks()'), 'all visible task views must share one pending-delete filter');
  assert.ok(app.includes('let visible = search.filter(_visibleTasks()'),
    'main list must exclude the pending task');
  assert.ok(app.includes('const all = _visibleTasks();'),
    'home summary and search pipeline must exclude the pending task');
  assert.ok(app.includes('hiddenTaskId: _deferredDelete.getPending()?.id ?? null'),
    'rendered header/progress counts must receive the pending task exclusion');
  assert.ok(ui.includes('_hiddenTaskId') && ui.includes('tasks.getAll().filter(task => task.id !== _hiddenTaskId)'),
    'header/progress counts must exclude the pending task too');
  assert.ok(app.includes('_deferredDelete.begin(id)'), 'confirmation must begin a deferred deletion');
  assert.ok(app.includes('_deferredDelete.undo(pending.id)'), 'undo must cancel pending deletion');
  assert.ok(app.includes('_showDeleteFailure(task, result.message)'), 'persistent failure must announce visibly');
  assert.ok(app.includes('function _prependSrPendingUndo()'),
    'Search must expose Undo above its native dialog layer');
  assert.ok(app.includes('function _prependSrDeleteFailure()'),
    'Search must expose persistence failures above its native dialog layer');
  assert.ok(app.includes('if (searchDialog?.open) {\n      _dismissToast();'),
    'an active Search failure must clear the stale undo toast');
  assert.ok(!app.includes('_deleteSnapshot'), 'undo must not restore a stale whole-task snapshot');
  assert.ok(!app.includes('function _commitDelete'), 'immediate delete path must be removed');
  assert.ok(tasksSource.includes('if (task._custom !== true)'), 'model must independently reject non-custom deletion');
});

check('U3: confirmation and deletion controls meet mobile touch and keyboard-safe dialog requirements', () => {
  assert.ok(css.includes('.dc-dialog') && css.includes('width: min(420px, calc(100vw - 32px))'));
  assert.ok(css.includes('.dc-cancel,') && css.includes('min-height: 44px'));
  assert.ok(css.includes('.btn-delete') && css.includes('min-width: 44px'));
  assert.ok(css.includes('.sr-pending-delete button') && css.includes('min-width: 44px'));
  assert.ok(css.includes('.sr-delete-failure'));
  assert.ok(app.includes('scrollLock.attach(dlg)'), 'confirmation dialog must lock background scroll');
  assert.ok(app.includes('target?.focus?.()'), 'dismiss must return focus to the triggering control');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);