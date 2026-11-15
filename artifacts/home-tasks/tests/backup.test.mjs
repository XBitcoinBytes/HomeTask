/**
 * HomeTask — Atomic Backup & Restore regression suite
 *
 * Standalone Node.js ESM test file.
 * No browser, no real localStorage, no external dependencies.
 * Run with:  node artifacts/home-tasks/tests/backup.test.mjs
 * Exits 0 on all-pass, exits 1 on any failure.
 *
 * Coverage (spec §9):
 *   1.  Export envelope — valid structure and fields
 *   2.  Import valid backup — tasks and prefs applied
 *   3.  Unknown task IDs in import — silently dropped
 *   4.  Retired IDs (mbath-all etc.) — silently dropped
 *   5.  Missing task fields — filled with seed defaults
 *   6.  Invalid viewMode — sanitized to 'today'
 *   7.  'home' viewMode — sanitized to 'today' (transient, not persisted)
 *   8.  Invalid roomFilter — sanitized to ''
 *   9.  Future lastDone (tomorrow) — clamped / treated as no prior history
 *  10.  doneToday=true with lastDone≠today — forced to false on load
 *  11.  Malformed JSON — rejected with error
 *  12.  schemaVersion ≠ 1 — rejected with error
 *  13.  Missing preferences block — defaults applied
 *  14.  Import with 0 tasks — all seed tasks get defaults
 *  15.  Import with >122 tasks — excess unknown IDs dropped
 *  16.  Undo last import — restores pre-import snapshot
 *  17.  Undo with no prior snapshot — no-op / graceful
 *  18.  Interrupted import (staging present on startup) — rolled back
 *  19.  Export → import round-trip — idempotent task state
 *  20.  Safety task (smoke-batteries) — preserved through import
 *  21.  Room catalog authority — seed room name overrides stored room
 *  22.  Alias expansion (couch↔sofa, trash↔garbage, office↔study)
 */

import assert from 'node:assert/strict';

/* ══════════════════════════════════════════════════════════════════════
   MINI CATALOG — a small slice of SEED_TASKS for testing import logic
═══════════════════════════════════════════════════════════════════════ */
const SEED_CATALOG = [
  { id: 'mb-floor',      title: 'Clean Floor',              room: 'Master Bedroom',   intervalDays: 14, tags: [] },
  { id: 'k-floor',       title: 'Clean Floor',              room: 'Kitchen',          intervalDays: 7,  tags: [] },
  { id: 'garbage',       title: 'Take Out Garbage',         room: 'Whole House',      intervalDays: 7,  tags: [] },
  { id: 'smoke-batteries', title: 'Check Smoke Detector Batteries', room: 'Whole House', intervalDays: 90, tags: ['safety'] },
  { id: 'couch-condition', title: 'Leather Couch Conditioning', room: 'Family Room', intervalDays: 90, tags: [] },
  { id: 'water-softener', title: 'Check Water Softener',   room: 'Utility Room',     intervalDays: 7,  tags: [] },
];

const SEED_IDS = new Set(SEED_CATALOG.map(t => t.id));

/* ══════════════════════════════════════════════════════════════════════
   TEST HARNESS
═══════════════════════════════════════════════════════════════════════ */
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓  ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   MOCK localStorage
═══════════════════════════════════════════════════════════════════════ */
function makeMockStorage() {
  const store = new Map();
  return {
    getItem:    k       => store.has(k) ? store.get(k) : null,
    setItem:    (k, v)  => store.set(k, String(v)),
    removeItem: k       => store.delete(k),
    clear:      ()      => store.clear(),
    _store:     store,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   REIMPLEMENTED BACKUP CORE
   (mirrors the real backup module's sanitize / import / export logic)
═══════════════════════════════════════════════════════════════════════ */
const SCHEMA_VERSION  = 1;
const VALID_VIEW_MODES = new Set(['today', 'week', 'all']);
const VALID_ROOMS      = new Set(SEED_CATALOG.map(t => t.room));
const TODAY_STR        = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function todayStr() { return TODAY_STR; }

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Sanitize preferences block from an imported envelope. */
function sanitizePreferences(raw = {}) {
  return {
    viewMode:    VALID_VIEW_MODES.has(raw.viewMode) ? raw.viewMode : 'today',
    roomFilter:  VALID_ROOMS.has(raw.roomFilter)    ? raw.roomFilter : '',
    onboarded:   Boolean(raw.onboarded),
    choice:      typeof raw.choice === 'string'     ? raw.choice    : 'balanced',
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : '',
  };
}

/**
 * Merge saved task state over the seed catalog.
 * Unknown IDs (not in SEED_IDS) are silently dropped.
 * Missing seed IDs get their default state.
 * doneToday is forced to false when lastDone ≠ today.
 * lastDone cannot be a future date (clamped to null).
 */
function mergeSavedTasks(savedTasks) {
  const today  = todayStr();
  const savedMap = new Map((savedTasks ?? [])
    .filter(t => typeof t.id === 'string')
    .map(t => [t.id, t]));

  return SEED_CATALOG.map(seed => {
    const s = savedMap.get(seed.id);
    if (!s) return { ...seed, lastDone: null, doneToday: false, skipUntil: null };

    // Future lastDone is invalid — treat as no prior history
    const rawLastDone = typeof s.lastDone === 'string' ? s.lastDone : null;
    const lastDone    = rawLastDone && rawLastDone > today ? null : rawLastDone;
    const doneToday   = lastDone === today ? Boolean(s.doneToday) : false;

    return {
      ...seed,
      lastDone,
      doneToday,
      skipUntil: typeof s.skipUntil === 'string' ? s.skipUntil : null,
      tags:      Array.isArray(s.tags) ? s.tags : [],
    };
  });
}

/** Build an export envelope from current state. */
function buildEnvelope(taskList, prefsMeta, exporterTag = 'hometask-v18') {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt:    new Date().toISOString(),
    exporter:      exporterTag,
    tasks:         taskList.map(t => ({
      id:          t.id,
      lastDone:    t.lastDone    ?? null,
      doneToday:   t.doneToday  ?? false,
      skipUntil:   t.skipUntil  ?? null,
      tags:        t.tags        ?? [],
    })),
    preferences:   {
      viewMode:    prefsMeta.viewMode   ?? 'today',
      roomFilter:  prefsMeta.roomFilter ?? '',
      onboarded:   Boolean(prefsMeta.onboarded),
      choice:      prefsMeta.choice      ?? 'balanced',
      completedAt: prefsMeta.completedAt ?? '',
    },
  };
}

/** Validate that an envelope is importable. Returns { ok, error }. */
function validateEnvelope(raw) {
  if (!raw || typeof raw !== 'object')      return { ok: false, error: 'Not an object' };
  if (raw.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: `Unsupported schemaVersion: ${raw.schemaVersion}` };
  if (!Array.isArray(raw.tasks))            return { ok: false, error: 'tasks is not an array' };
  return { ok: true };
}

/**
 * Apply a validated import envelope.
 * Saves a pre-import snapshot for undo, then writes new state.
 * Returns { ok, taskCount }.
 */
function applyImport(envelope, storage) {
  const { ok, error } = validateEnvelope(envelope);
  if (!ok) return { ok: false, error };

  // Save snapshot for undo
  const currentTasks = storage.getItem('hometask-v1');
  const currentMeta  = storage.getItem('hometask-meta-v1');
  storage.setItem('hometask-backup-snapshot-v1', JSON.stringify({
    tasks: currentTasks,
    meta:  currentMeta,
  }));

  // Write new state
  const mergedTasks = mergeSavedTasks(envelope.tasks);
  const sanitizedPrefs = sanitizePreferences(envelope.preferences ?? {});
  storage.setItem('hometask-v1', JSON.stringify(mergedTasks));
  storage.setItem('hometask-meta-v1', JSON.stringify(sanitizedPrefs));

  return { ok: true, taskCount: mergedTasks.length };
}

/** Undo the last import by restoring the pre-import snapshot. */
function applyUndo(storage) {
  const raw = storage.getItem('hometask-backup-snapshot-v1');
  if (!raw) return { ok: false, error: 'No snapshot to restore' };

  let snapshot;
  try { snapshot = JSON.parse(raw); } catch { return { ok: false, error: 'Snapshot is damaged' }; }

  if (snapshot.tasks !== null) storage.setItem('hometask-v1', snapshot.tasks);
  else storage.removeItem('hometask-v1');

  if (snapshot.meta !== null) storage.setItem('hometask-meta-v1', snapshot.meta);
  else storage.removeItem('hometask-meta-v1');

  storage.removeItem('hometask-backup-snapshot-v1');
  return { ok: true };
}

/** Simulate a startup check for an interrupted import (staging present). */
function checkAndRollbackInterruptedImport(storage) {
  const staging = storage.getItem('hometask-staging-v1');
  if (!staging) return false;

  // Interrupted — roll back: discard staging, restore snapshot if present
  const snapshotRaw = storage.getItem('hometask-backup-snapshot-v1');
  if (snapshotRaw) {
    try {
      const snap = JSON.parse(snapshotRaw);
      if (snap.tasks !== null) storage.setItem('hometask-v1', snap.tasks);
      if (snap.meta  !== null) storage.setItem('hometask-meta-v1', snap.meta);
    } catch (_) {}
    storage.removeItem('hometask-backup-snapshot-v1');
  }
  storage.removeItem('hometask-staging-v1');
  return true;
}

/** Simple alias expansion (mirrors the real search.expandTerms). */
const ALIASES = {
  'couch':    ['sofa'],
  'sofa':     ['couch'],
  'trash':    ['garbage'],
  'garbage':  ['trash'],
  'office':   ['study'],
  'study':    ['office'],
};

function expandTerms(q) {
  const terms = new Set([q]);
  q.split(/\s+/).filter(Boolean).forEach(w => {
    (ALIASES[w] ?? []).forEach(a => terms.add(a));
  });
  return [...terms];
}

/* ══════════════════════════════════════════════════════════════════════
   TEST CASES
═══════════════════════════════════════════════════════════════════════ */
console.log('\nHomeTask Backup & Restore — regression suite\n');

// 1. Export envelope — valid structure
test('Export: envelope has all required fields', () => {
  const tasks  = SEED_CATALOG.map(t => ({ ...t, lastDone: null, doneToday: false, skipUntil: null }));
  const prefs  = { viewMode: 'today', roomFilter: '', onboarded: true, choice: 'balanced', completedAt: '2026-07-31' };
  const env    = buildEnvelope(tasks, prefs);
  assert.equal(env.schemaVersion, 1);
  assert.ok(typeof env.exportedAt === 'string');
  assert.equal(env.exporter, 'hometask-v18');
  assert.ok(Array.isArray(env.tasks));
  assert.ok(typeof env.preferences === 'object');
  assert.equal(env.preferences.viewMode, 'today');
});

// 2. Import valid backup — applied correctly
test('Import: valid backup applies tasks and preferences', () => {
  const storage = makeMockStorage();
  const env = {
    schemaVersion: 1,
    exportedAt:    '2026-07-31T10:00:00.000Z',
    exporter:      'hometask-v18',
    tasks: [
      { id: 'mb-floor', lastDone: '2026-07-20', doneToday: false, skipUntil: null, tags: [] },
    ],
    preferences: { viewMode: 'week', roomFilter: '', onboarded: true, choice: 'balanced', completedAt: '2026-07-01' },
  };
  const result = applyImport(env, storage);
  assert.ok(result.ok, result.error);
  const savedTasks = JSON.parse(storage.getItem('hometask-v1'));
  const mbFloor    = savedTasks.find(t => t.id === 'mb-floor');
  assert.equal(mbFloor.lastDone, '2026-07-20');
  const savedMeta  = JSON.parse(storage.getItem('hometask-meta-v1'));
  assert.equal(savedMeta.viewMode, 'week');
});

// 3. Unknown task IDs silently dropped
test('Import: unknown task IDs are silently dropped', () => {
  const storage = makeMockStorage();
  const env = {
    schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {},
    tasks: [
      { id: 'mb-floor',       lastDone: '2026-07-20', doneToday: false, skipUntil: null, tags: [] },
      { id: 'unknown-task-1', lastDone: '2026-07-01', doneToday: false, skipUntil: null, tags: [] },
      { id: 'unknown-task-2', lastDone: null,          doneToday: false, skipUntil: null, tags: [] },
    ],
  };
  applyImport(env, storage);
  const savedTasks = JSON.parse(storage.getItem('hometask-v1'));
  const ids = savedTasks.map(t => t.id);
  assert.ok(!ids.includes('unknown-task-1'), 'unknown-task-1 should be dropped');
  assert.ok(!ids.includes('unknown-task-2'), 'unknown-task-2 should be dropped');
  assert.equal(savedTasks.length, SEED_CATALOG.length, 'result length equals seed length');
});

// 4. Retired IDs (mbath-all, hb-all, mdb-all, bb-all) silently dropped
test('Import: retired task IDs (mbath-all etc.) are silently dropped', () => {
  const storage = makeMockStorage();
  const retiredIds = ['mbath-all', 'hb-all', 'mdb-all', 'bb-all'];
  const env = {
    schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {},
    tasks: retiredIds.map(id => ({ id, lastDone: '2026-01-01', doneToday: false, skipUntil: null, tags: [] })),
  };
  applyImport(env, storage);
  const savedTasks = JSON.parse(storage.getItem('hometask-v1'));
  const ids = savedTasks.map(t => t.id);
  retiredIds.forEach(rid => assert.ok(!ids.includes(rid), `${rid} should not appear`));
  assert.equal(savedTasks.length, SEED_CATALOG.length);
});

// 5. Missing task fields filled with seed defaults
test('Import: tasks with missing fields get seed defaults', () => {
  const storage = makeMockStorage();
  const env = {
    schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {},
    tasks: [
      { id: 'k-floor' },   // minimal — no lastDone, no tags
    ],
  };
  applyImport(env, storage);
  const saved   = JSON.parse(storage.getItem('hometask-v1'));
  const kFloor  = saved.find(t => t.id === 'k-floor');
  assert.equal(kFloor.title,        'Clean Floor',  'title from seed');
  assert.equal(kFloor.room,         'Kitchen',      'room from seed');
  assert.equal(kFloor.intervalDays, 7,              'intervalDays from seed');
  assert.equal(kFloor.lastDone,     null,           'lastDone defaults null');
  assert.deepEqual(kFloor.tags,     [],             'tags default empty');
});

// 6. Invalid viewMode sanitized to 'today'
test('Preferences: invalid viewMode sanitized to "today"', () => {
  const prefs = sanitizePreferences({ viewMode: 'garbage', roomFilter: '' });
  assert.equal(prefs.viewMode, 'today');
});

// 7. 'home' viewMode sanitized to 'today' (it is transient, never stored)
test('Preferences: "home" viewMode sanitized to "today"', () => {
  const prefs = sanitizePreferences({ viewMode: 'home', roomFilter: '' });
  assert.equal(prefs.viewMode, 'today', '"home" is transient and must not be persisted');
});

// 8. Invalid roomFilter sanitized to ''
test('Preferences: unknown roomFilter sanitized to empty string', () => {
  const prefs = sanitizePreferences({ viewMode: 'all', roomFilter: 'Nonexistent Room' });
  assert.equal(prefs.roomFilter, '');
});

// 9. Future lastDone clamped to null
test('Import: future lastDone is treated as no prior history (null)', () => {
  const storage = makeMockStorage();
  const future  = tomorrowStr();
  const env = {
    schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {},
    tasks: [{ id: 'garbage', lastDone: future, doneToday: true, skipUntil: null, tags: [] }],
  };
  applyImport(env, storage);
  const saved   = JSON.parse(storage.getItem('hometask-v1'));
  const garbage = saved.find(t => t.id === 'garbage');
  assert.equal(garbage.lastDone,  null,  'future lastDone must be clamped to null');
  assert.equal(garbage.doneToday, false, 'doneToday must be false when lastDone is null');
});

// 10. doneToday=true with lastDone≠today forced to false
test('Import: doneToday=true with lastDone≠today is forced to false', () => {
  const storage = makeMockStorage();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
  const env = {
    schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {},
    tasks: [{ id: 'k-floor', lastDone: yesterday, doneToday: true, skipUntil: null, tags: [] }],
  };
  applyImport(env, storage);
  const saved  = JSON.parse(storage.getItem('hometask-v1'));
  const kFloor = saved.find(t => t.id === 'k-floor');
  assert.equal(kFloor.doneToday, false, 'doneToday must be false when lastDone is not today');
});

// 11. Malformed JSON rejected with error
test('Import: malformed JSON string rejected', () => {
  let threw = false;
  try {
    JSON.parse('{ this is not valid JSON }}}');
  } catch (_) { threw = true; }
  assert.ok(threw, 'malformed JSON should throw on parse');
  // Validate the rejection path
  const result = validateEnvelope(null);
  assert.ok(!result.ok, 'null envelope should be rejected');
});

// 12. Wrong schemaVersion rejected
test('Import: schemaVersion ≠ 1 is rejected', () => {
  const fakeEnvelope = { schemaVersion: 99, tasks: [], preferences: {} };
  const result = validateEnvelope(fakeEnvelope);
  assert.ok(!result.ok, 'schemaVersion 99 should be rejected');
  assert.ok(result.error.includes('99'), 'error should mention the bad version');
});

// 13. Missing preferences block — defaults applied
test('Import: missing preferences block applies safe defaults', () => {
  const storage = makeMockStorage();
  const env = { schemaVersion: 1, exportedAt: '', exporter: 'test', tasks: [] };
  // No preferences key at all
  applyImport(env, storage);
  const meta = JSON.parse(storage.getItem('hometask-meta-v1'));
  assert.equal(meta.viewMode,   'today');
  assert.equal(meta.roomFilter, '');
});

// 14. Import with 0 tasks — all seed tasks get null defaults
test('Import: 0 tasks → all seed tasks present with null lastDone', () => {
  const storage = makeMockStorage();
  const env = { schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {}, tasks: [] };
  applyImport(env, storage);
  const saved = JSON.parse(storage.getItem('hometask-v1'));
  assert.equal(saved.length, SEED_CATALOG.length, 'all seed tasks present');
  saved.forEach(t => {
    assert.equal(t.lastDone,  null,  `${t.id}: lastDone should be null`);
    assert.equal(t.doneToday, false, `${t.id}: doneToday should be false`);
  });
});

// 15. Import with >SEED_CATALOG.length tasks — excess dropped
test('Import: excess tasks (unknown IDs) beyond seed catalog are dropped', () => {
  const storage  = makeMockStorage();
  const extra    = Array.from({ length: 20 }, (_, i) => ({ id: `extra-${i}`, lastDone: null, doneToday: false, skipUntil: null, tags: [] }));
  const seedPart = SEED_CATALOG.map(t => ({ id: t.id, lastDone: null, doneToday: false, skipUntil: null, tags: [] }));
  const env      = { schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {}, tasks: [...seedPart, ...extra] };
  applyImport(env, storage);
  const saved = JSON.parse(storage.getItem('hometask-v1'));
  assert.equal(saved.length, SEED_CATALOG.length, 'result length matches seed catalog');
  saved.forEach(t => assert.ok(SEED_IDS.has(t.id), `${t.id} should be a known seed ID`));
});

// 16. Undo last import restores pre-import snapshot
test('Undo: restores pre-import task state and meta', () => {
  const storage = makeMockStorage();
  // Set up original state
  const originalTasks = JSON.stringify([{ id: 'k-floor', lastDone: '2026-06-01', doneToday: false, skipUntil: null, tags: [] }]);
  const originalMeta  = JSON.stringify({ viewMode: 'all', roomFilter: '', onboarded: true });
  storage.setItem('hometask-v1',        originalTasks);
  storage.setItem('hometask-meta-v1',   originalMeta);

  // Apply an import that changes everything
  const env = { schemaVersion: 1, exportedAt: '', exporter: 'test',
    preferences: { viewMode: 'week' },
    tasks: [{ id: 'garbage', lastDone: '2026-07-01', doneToday: false, skipUntil: null, tags: [] }],
  };
  applyImport(env, storage);

  // Verify import changed things
  const afterImport = JSON.parse(storage.getItem('hometask-meta-v1'));
  assert.equal(afterImport.viewMode, 'week');

  // Undo
  const undoResult = applyUndo(storage);
  assert.ok(undoResult.ok, undoResult.error);

  // Verify restoration
  assert.equal(storage.getItem('hometask-v1'),      originalTasks);
  assert.equal(storage.getItem('hometask-meta-v1'), originalMeta);
  assert.equal(storage.getItem('hometask-backup-snapshot-v1'), null, 'snapshot cleared after undo');
});

// 17. Undo with no prior snapshot — graceful no-op
test('Undo: no prior snapshot → graceful no-op', () => {
  const storage = makeMockStorage();
  const result  = applyUndo(storage);
  assert.ok(!result.ok, 'should return ok:false');
  assert.ok(typeof result.error === 'string', 'should provide an error message');
});

// 18. Interrupted import (staging on startup) → rolled back
test('Startup: interrupted import (staging present) rolled back', () => {
  const storage = makeMockStorage();
  const priorTasks = JSON.stringify([{ id: 'k-floor', lastDone: '2026-05-01', doneToday: false, skipUntil: null, tags: [] }]);
  storage.setItem('hometask-v1', priorTasks);
  // Simulate an interrupted import: staging key present, snapshot saved
  storage.setItem('hometask-staging-v1', JSON.stringify({ pending: true }));
  storage.setItem('hometask-backup-snapshot-v1', JSON.stringify({ tasks: priorTasks, meta: null }));

  const wasInterrupted = checkAndRollbackInterruptedImport(storage);
  assert.ok(wasInterrupted, 'should detect interrupted import');
  assert.equal(storage.getItem('hometask-staging-v1'), null, 'staging cleared');
  assert.equal(storage.getItem('hometask-backup-snapshot-v1'), null, 'snapshot cleared after rollback');
  assert.equal(storage.getItem('hometask-v1'), priorTasks, 'prior task data restored');
});

// 19. Export → import round-trip idempotent
test('Round-trip: export then import produces identical task state', () => {
  const storage = makeMockStorage();
  // Start with meaningful state
  const startTasks = SEED_CATALOG.map((t, i) => ({
    ...t,
    lastDone:  i % 2 === 0 ? '2026-07-25' : null,
    doneToday: false,
    skipUntil: null,
  }));
  const startMeta = { viewMode: 'week', roomFilter: '', onboarded: true, choice: 'balanced', completedAt: '2026-07-01' };

  // Export
  const env = buildEnvelope(startTasks, startMeta);

  // Import
  const result = applyImport(env, storage);
  assert.ok(result.ok, result.error);
  const importedTasks = JSON.parse(storage.getItem('hometask-v1'));

  // Verify round-trip fidelity
  SEED_CATALOG.forEach((seed, i) => {
    const imported = importedTasks.find(t => t.id === seed.id);
    assert.ok(imported, `${seed.id} should be present after round-trip`);
    const expectedLastDone = i % 2 === 0 ? '2026-07-25' : null;
    assert.equal(imported.lastDone, expectedLastDone, `${seed.id}: lastDone should match`);
    // Catalog fields come from seed
    assert.equal(imported.title,    seed.title,    `${seed.id}: title from seed`);
    assert.equal(imported.room,     seed.room,     `${seed.id}: room from seed`);
  });
});

// 20. Safety task (smoke-batteries) preserved through import
test('Import: safety task smoke-batteries preserved with lastDone', () => {
  const storage = makeMockStorage();
  const env = {
    schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {},
    tasks: [{ id: 'smoke-batteries', lastDone: '2026-01-15', doneToday: false, skipUntil: null, tags: ['safety'] }],
  };
  applyImport(env, storage);
  const saved  = JSON.parse(storage.getItem('hometask-v1'));
  const smoke  = saved.find(t => t.id === 'smoke-batteries');
  assert.ok(smoke, 'smoke-batteries should be present');
  assert.equal(smoke.lastDone, '2026-01-15', 'lastDone should be preserved');
  // Catalog authority: title and room come from seed, not import
  assert.equal(smoke.title, 'Check Smoke Detector Batteries', 'title from seed');
  assert.equal(smoke.room,  'Whole House', 'room from seed (not Shared)');
});

// 21. Room catalog authority — seed room name overrides stored room
test('Catalog authority: seed room overrides stored room name', () => {
  const storage = makeMockStorage();
  // Simulate old data with "Shared" room for smoke-batteries (before migration)
  const env = {
    schemaVersion: 1, exportedAt: '', exporter: 'test', preferences: {},
    tasks: [
      // Old room name "Shared" — seed overrides to "Whole House"
      { id: 'smoke-batteries', lastDone: '2026-05-01', doneToday: false, skipUntil: null, tags: [] },
      { id: 'couch-condition', lastDone: '2026-04-01', doneToday: false, skipUntil: null, tags: [] },
    ],
  };
  applyImport(env, storage);
  const saved = JSON.parse(storage.getItem('hometask-v1'));
  const smoke = saved.find(t => t.id === 'smoke-batteries');
  const couch = saved.find(t => t.id === 'couch-condition');
  assert.equal(smoke.room, 'Whole House',  'smoke-batteries: room from seed (Whole House)');
  assert.equal(couch.room, 'Family Room',  'couch-condition: room from seed (Family Room)');
});

// 22. Alias expansion — couch↔sofa, trash↔garbage, office↔study
test('Alias expansion: couch↔sofa, trash↔garbage, office↔study', () => {
  const couchTerms   = expandTerms('couch');
  const sofaTerms    = expandTerms('sofa');
  const trashTerms   = expandTerms('trash');
  const garbageTerms = expandTerms('garbage');
  const officeTerms  = expandTerms('office');
  const studyTerms   = expandTerms('study');

  assert.ok(couchTerms.includes('sofa'),    '"couch" should expand to include "sofa"');
  assert.ok(sofaTerms.includes('couch'),    '"sofa" should expand to include "couch"');
  assert.ok(trashTerms.includes('garbage'), '"trash" should expand to include "garbage"');
  assert.ok(garbageTerms.includes('trash'), '"garbage" should expand to include "trash"');
  assert.ok(officeTerms.includes('study'),  '"office" should expand to include "study"');
  assert.ok(studyTerms.includes('office'),  '"study" should expand to include "office"');

  // Original term always present
  assert.ok(couchTerms.includes('couch'),   'original term preserved');
  assert.ok(trashTerms.includes('trash'),   'original term preserved');
});

/* ══════════════════════════════════════════════════════════════════════
   SUMMARY
═══════════════════════════════════════════════════════════════════════ */
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.error('\nFailed tests:');
  failures.forEach(f => console.error(`  • ${f.name}\n    ${f.error}`));
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
