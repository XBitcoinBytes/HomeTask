/* Deferred custom-task deletion.
 *
 * A task remains in the model and v1 storage during the undo window. The
 * caller hides the pending task from its current UI; only expiry invokes the
 * model's persistent removeTask() boundary. This makes reload/close safe:
 * browser teardown cancels the timer while the original storage bytes still
 * contain the task.
 */

export function createDeferredDelete({
  taskModel,
  scheduler = globalThis,
  delayMs = 5000,
  onExpire,
} = {}) {
  if (!taskModel || typeof taskModel.getAll !== 'function' ||
      typeof taskModel.isCustomTask !== 'function' ||
      typeof taskModel.removeTask !== 'function') {
    throw new Error('createDeferredDelete requires a task model');
  }
  if (!scheduler || typeof scheduler.setTimeout !== 'function' ||
      typeof scheduler.clearTimeout !== 'function') {
    throw new Error('createDeferredDelete requires a timer scheduler');
  }

  let pending = null;
  let timer = null;

  function copyTask(task) {
    // Custom records have already crossed the safe JSON boundary. Copying
    // prevents UI callers from mutating the complete pending task snapshot.
    return typeof structuredClone === 'function'
      ? structuredClone(task)
      : JSON.parse(JSON.stringify(task));
  }

  function getPending() {
    return pending ? { id: pending.id, task: copyTask(pending.task) } : null;
  }

  function begin(id) {
    if (pending) {
      return { ok: false, code: 'delete-pending', message: 'Finish the current delete first.' };
    }
    if (!taskModel.isCustomTask(id)) {
      return { ok: false, code: 'not-custom-task', message: 'Only custom tasks can be deleted.' };
    }
    const task = taskModel.getAll().find(item => item.id === id);
    if (!task) {
      return { ok: false, code: 'not-found', message: 'Task not found.' };
    }

    pending = { id, task: copyTask(task) };
    timer = scheduler.setTimeout(() => expire(id), delayMs);
    return { ok: true, task: copyTask(task) };
  }

  function undo(id) {
    if (!pending || pending.id !== id) {
      return { ok: false, code: 'no-pending-delete', message: 'Nothing to undo.' };
    }
    scheduler.clearTimeout(timer);
    timer = null;
    const task = pending.task;
    pending = null;
    return { ok: true, task: copyTask(task) };
  }

  function expire(id) {
    if (!pending || pending.id !== id) return;
    const expiring = pending;
    timer = null;
    const result = taskModel.removeTask(id);
    pending = null;
    onExpire?.({ id, task: copyTask(expiring.task), result });
  }

  function dispose() {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
    pending = null;
  }

  return { begin, undo, getPending, dispose };
}