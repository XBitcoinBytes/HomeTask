/* Extracted mechanically from src/script.js lines 868–939 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new.
   F1 additions: addTask, removeTask, isCustomTask, getCustomRooms,
   restoreFromSnapshot, _generateId. */
import { addDays, todayStr } from './util.js';
import { computeEffectiveDue } from './due.js';
import { SEED_TASK_IDS, SEED_TASK_ROOMS, normalizeTaskTitle } from './catalog.js';
import {
  ROOM_NAME_MAX_LENGTH,
  canonicalRoomName,
  normalizeRoomName,
} from '../data/custom-room-record.js';

/* Lowercase set for case-insensitive built-in room comparison. */
const _SEED_ROOMS_LC = new Set([...SEED_TASK_ROOMS].map(r => r.toLowerCase()));

/* ── ID generator ─────────────────────────────────────────────── */
const _DEFAULT_GENERATOR = (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? () => `custom-${crypto.randomUUID()}`
    : (() => {
        const hex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
        return () => `custom-${Date.now()}-${hex4()}${hex4()}`;
      })()
);
const MAX_ID_ATTEMPTS = 10;

function _generateId(existingIds, generator) {
  const gen = generator ?? _DEFAULT_GENERATOR;
  for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
    const id = gen();
    if (!existingIds.has(id)) return id;
  }
  throw new Error('id-generation-exhausted');
}

function _generateRoomId(existingIds, generator) {
  const gen = generator ?? (() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `room-${crypto.randomUUID()}`;
    }
    return `room-${Date.now()}-${Math.floor(Math.random() * 0x100000000).toString(16)}`;
  });
  for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
    const id = gen();
    if (typeof id === 'string' && !existingIds.has(id)) return id;
  }
  throw new Error('room-id-generation-exhausted');
}

/* ── Tasks module ─────────────────────────────────────────────── */
const tasks = (() => {
  // CP5B lazification: _items is no longer loaded at module-evaluation time.
  // The deferred load happens inside _ensureLoaded() on first call, which
  // occurs inside app.init() — after activation startup recovery has completed.
  // The structural test in v2-activation-bridge.test.mjs verifies this invariant.
  let _items = null;
  let _customRooms = null;

  /** Injected V1Repository — set once by app.init(repo) before first render. */
  let _repo = null;

  /**
   * Injection guard.
   * - Rejects null / non-object values immediately.
   * - Allows initial assignment (first setRepo call in a session).
   * - Allows idempotent repeat with the identical object reference.
   * - Rejects a replacement attempt with a different object.
   */
  function setRepo(r) {
    if (!r || typeof r !== 'object')
      throw new Error('[HomeTask] tasks.setRepo: invalid repository');
    if (_repo === null) { _repo = r; return; }
    if (_repo === r)   return;           // idempotent repeat — ok
    throw new Error('[HomeTask] tasks.setRepo: repository already set — late authority swap rejected');
  }

  function _ensureLoaded() {
    if (_items !== null) return;
    _items = _repo.loadTasks();
    _customRooms = typeof _repo.loadCustomRooms === 'function'
      ? _repo.loadCustomRooms()
      : [];
  }

  function getAll() { _ensureLoaded(); return _items; }

  function _find(id) { _ensureLoaded(); return _items.find(t => t.id === id); }

  /**
   * Mark a task done today.
   * Copy-on-write: builds nextItems without mutating _items.
   * Assigns _items = nextItems only after a successful persist.
   * On failure _items reference and content are unchanged.
   * Returns undefined — callers do not check the return value.
   */
  function markDone(id) {
    _ensureLoaded();
    if (!_items.some(t => t.id === id)) return;
    const nextItems = _items.map(t =>
      t.id === id
        ? { ...t, lastDone: todayStr(), doneToday: true, skipUntil: null }
        : t,
    );
    const r = _repo.saveTasks(nextItems);
    if (r.ok) _items = nextItems;
  }

  /**
   * Skip today — move the effective due date forward by 1 day.
   *
   * Base = current effective due date (or today if never done / already past).
   * Does NOT touch lastDone, doneToday, or any completion data.
   * Copy-on-write; void return; same failure contract as markDone.
   */
  function skipToday(id) {
    _ensureLoaded();
    const orig = _find(id);
    if (!orig) return;
    const base      = computeEffectiveDue(orig) ?? todayStr();
    const nextItems = _items.map(t =>
      t.id === id ? { ...t, skipUntil: addDays(base, 1) } : t,
    );
    const r = _repo.saveTasks(nextItems);
    if (r.ok) _items = nextItems;
  }

  /**
   * Skip week — move the effective due date forward by 7 days.
   *
   * Same rules as skipToday but +7.
   * Copy-on-write; void return; same failure contract as markDone.
   */
  function skipWeek(id) {
    _ensureLoaded();
    const orig = _find(id);
    if (!orig) return;
    const base      = computeEffectiveDue(orig) ?? todayStr();
    const nextItems = _items.map(t =>
      t.id === id ? { ...t, skipUntil: addDays(base, 7) } : t,
    );
    const r = _repo.saveTasks(nextItems);
    if (r.ok) _items = nextItems;
  }

  /**
   * Apply initial schedule overrides (onboarding only).
   *
   * Writes skipUntil on tasks where lastDone is null (never done).
   * Never sets lastDone or doneToday — nothing is recorded as completed.
   * Safety tasks are intentionally excluded from overrides by the caller.
   * Copy-on-write across all overridden tasks.
   * On failure _items is unchanged.
   *
   * @param {Array<{id: string, skipUntil: string}>} overrides
   */
  function applyBaseline(overrides) {
    _ensureLoaded();
    const map       = new Map(overrides.map(o => [o.id, o.skipUntil]));
    const nextItems = _items.map(t =>
      (t.lastDone === null && map.has(t.id))
        ? { ...t, skipUntil: map.get(t.id) }
        : t,
    );
    const r = _repo.saveTasks(nextItems);
    if (r.ok) _items = nextItems;
  }

  // ── F1: custom task management ─────────────────────────────────

  /**
   * Add a custom task. Returns { ok:true, task } on success or
   * { ok:false, code, message } on validation / storage failure.
   *
   * Validation:
   *   - title: non-empty after normalizeTaskTitle(); ≤ 80 chars
   *   - room:  non-empty after trim/whitespace-collapse; ≤ 50 chars
   *   - intervalDays: integer 1–365
   *   - Duplicate: canonical room+title pair must not already exist
   *
   * Room name: display casing is preserved; comparisons use lowercase.
   * Custom tasks MAY be assigned to built-in catalog rooms.
   *
   * @param {{ title:string, room:string, intervalDays:number,
   *            generator?:function():string }} opts
   * @returns {{ ok:true, task:object }|{ ok:false, code:string, message:string }}
   */
  function addTask({ title, room, intervalDays, generator } = {}) {
    _ensureLoaded();

    const normTitle = normalizeTaskTitle(title);
    const normRoom  = typeof room === 'string'
      ? room.trim().replace(/\s+/g, ' ')
      : '';

    if (!normTitle)
      return { ok: false, code: 'validation-title', message: 'Task name is required.' };
    if (normTitle.length > 80)
      return { ok: false, code: 'validation-title', message: 'Task name must be 80 characters or fewer.' };
    if (!normRoom)
      return { ok: false, code: 'validation-room', message: 'Room is required.' };
    if (normRoom.length > 50)
      return { ok: false, code: 'validation-room', message: 'Room name must be 50 characters or fewer.' };

    const normInterval = Math.round(Number(intervalDays));
    if (!Number.isFinite(normInterval) || normInterval < 1)
      return { ok: false, code: 'validation-interval', message: 'Interval must be at least 1 day.' };
    if (normInterval > 365)
      return { ok: false, code: 'validation-interval', message: 'Interval must be 365 days or fewer.' };

    // Duplicate: same normalized room+title already exists in ANY task
    const canonKey = `${normRoom.toLowerCase()}::${normTitle.toLowerCase()}`;
    if (_items.some(t =>
      `${t.room.toLowerCase()}::${t.title.toLowerCase()}` === canonKey
    )) {
      return { ok: false, code: 'validation-duplicate',
               message: 'A task with this name already exists in this room.' };
    }

    const existingIds = new Set(_items.map(t => t.id));
    let id;
    try { id = _generateId(existingIds, generator); }
    catch (e) { return { ok: false, code: 'id-generation-exhausted', message: e.message }; }

    const newTask = {
      id,
      title:       normTitle,
      room:        normRoom,
      intervalDays: normInterval,
      tags:        [],
      lastDone:    null,
      doneToday:   false,
      skipUntil:   null,
      _custom:     true,
    };
    const nextItems = [..._items, newTask];
    const r = _repo.saveTasks(nextItems);
    if (r.ok) { _items = nextItems; return { ok: true, task: newTask }; }
    return { ok: false, code: 'storage-error', message: r.error };
  }

  /**
   * Delete a custom task by ID. Copy-on-write; void-like return.
   * Returns { ok:true } or { ok:false, code, message }.
   * Built-in (catalog) task IDs are rejected with code:'catalog-task'.
   */
  function removeTask(id) {
    _ensureLoaded();
    if (SEED_TASK_IDS.has(id))
      return { ok: false, code: 'catalog-task',
               message: 'Built-in tasks cannot be deleted.' };
    const task = _items.find(t => t.id === id);
    if (!task)
      return { ok: false, code: 'not-found', message: 'Task not found.' };
    if (task._custom !== true)
      return { ok: false, code: 'not-custom-task',
               message: 'Only custom tasks can be deleted.' };
    const nextItems = _items.filter(t => t.id !== id);
    const r = _repo.saveTasks(nextItems);
    if (r.ok) { _items = nextItems; return { ok: true }; }
    return { ok: false, code: 'storage-error', message: r.error };
  }

  /**
   * Return true if the task with the given ID has _custom:true.
   * Returns false for catalog tasks, missing tasks, and unknown IDs.
   */
  function isCustomTask(id) {
    _ensureLoaded();
    return _items.find(t => t.id === id)?._custom === true;
  }

  /**
   * Return the ordered list of unique custom room names.
   * Excludes rooms that are built-in catalog rooms (case-insensitive match).
   * Custom tasks assigned to catalog rooms do NOT create custom room entries.
   */
  function getCustomRooms() {
    _ensureLoaded();
    const seen = new Set();
    const rooms = [];
    for (const room of _customRooms) {
      const key = canonicalRoomName(room.name);
      if (_SEED_ROOMS_LC.has(key) || seen.has(key)) continue;
      seen.add(key);
      rooms.push(room.name);
    }
    for (const t of _items) {
      if (t._custom !== true) continue;
      const key = canonicalRoomName(t.room);
      if (_SEED_ROOMS_LC.has(key) || seen.has(key)) continue;
      seen.add(key);
      rooms.push(t.room);
    }
    return rooms;
  }

  /** Return custom rooms with task counts and explicit-record status. */
  function getCustomRoomDetails() {
    _ensureLoaded();
    const explicitByName = new Map(_customRooms.map(room => [canonicalRoomName(room.name), room]));
    return getCustomRooms().map(name => {
      const key = canonicalRoomName(name);
      return {
        name,
        taskCount: _items.filter(task => canonicalRoomName(task.room) === key).length,
        explicit: explicitByName.has(key),
      };
    });
  }

  function isCustomRoom(name) {
    const key = canonicalRoomName(name);
    return Boolean(key) && getCustomRooms().some(room => canonicalRoomName(room) === key);
  }

  /**
   * Create an explicit custom room. A room name uses the same conservative
   * 50-character limit as task rooms and is compared case-insensitively.
   */
  function createRoom({ name, generator } = {}) {
    _ensureLoaded();
    const normalized = normalizeRoomName(name);
    if (!normalized) {
      return { ok: false, code: 'validation-room-name', message: 'Room name is required.' };
    }
    if (normalized.length > ROOM_NAME_MAX_LENGTH) {
      return {
        ok: false,
        code: 'validation-room-name',
        message: `Room name must be ${ROOM_NAME_MAX_LENGTH} characters or fewer.`,
      };
    }
    const key = canonicalRoomName(normalized);
    if (_SEED_ROOMS_LC.has(key) || getCustomRooms().some(room => canonicalRoomName(room) === key)) {
      return { ok: false, code: 'validation-room-duplicate', message: 'A room with this name already exists.' };
    }

    let id;
    try { id = _generateRoomId(new Set(_customRooms.map(room => room.id)), generator); }
    catch (error) {
      return { ok: false, code: 'room-id-generation-exhausted', message: error.message };
    }
    const room = { id, name: normalized, _customRoom: true };
    const nextRooms = [..._customRooms, room];
    const saved = _repo.saveCustomRooms(nextRooms);
    if (!saved.ok) return { ok: false, code: 'storage-error', message: saved.error };
    _customRooms = nextRooms;
    return { ok: true, room };
  }

  /** Delete only an empty explicit custom room; task assignments are untouched. */
  function removeRoom(name) {
    _ensureLoaded();
    const key = canonicalRoomName(name);
    if (_SEED_ROOMS_LC.has(key)) {
      return { ok: false, code: 'catalog-room', message: 'Built-in rooms cannot be deleted.' };
    }
    const displayName = getCustomRooms().find(room => canonicalRoomName(room) === key);
    if (!displayName) return { ok: false, code: 'not-found', message: 'Room not found.' };
    const taskCount = _items.filter(task => canonicalRoomName(task.room) === key).length;
    if (taskCount > 0) {
      return {
        ok: false,
        code: 'room-not-empty',
        count: taskCount,
        message: `Cannot delete “${displayName}” because ${taskCount} task${taskCount === 1 ? ' remains' : 's remain'}.`,
      };
    }
    const room = _customRooms.find(item => canonicalRoomName(item.name) === key);
    if (!room) return { ok: false, code: 'not-found', message: 'Room not found.' };
    const nextRooms = _customRooms.filter(item => item.id !== room.id);
    const saved = _repo.saveCustomRooms(nextRooms);
    if (!saved.ok) return { ok: false, code: 'storage-error', message: saved.error };
    _customRooms = nextRooms;
    return { ok: true, room };
  }

  /**
   * Restore _items to a prior snapshot (used by undo-delete in app.js).
   * Writes the snapshot to storage; updates _items only on success.
   * Returns true on success, false on storage failure.
   *
   * @param {Array} snapshot  Exact array from a prior tasks.getAll().slice() call.
   * @returns {boolean}
   */
  function restoreFromSnapshot(snapshot) {
    _ensureLoaded();
    const r = _repo.saveTasks(snapshot);
    if (r.ok) { _items = snapshot; return true; }
    return false;
  }

  return {
    getAll, markDone, skipToday, skipWeek, applyBaseline, setRepo,
    addTask, removeTask, isCustomTask, getCustomRooms, getCustomRoomDetails,
    isCustomRoom, createRoom, removeRoom, restoreFromSnapshot,
  };
})();

export { tasks };
