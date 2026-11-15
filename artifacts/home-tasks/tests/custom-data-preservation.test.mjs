/**
 * Custom-data preservation — focused v1 repository + backup regression suite.
 *
 * Uses synthetic in-memory storage only. No browser profile, device, or live
 * application data is read or modified.
 *
 * Run with: node artifacts/home-tasks/tests/custom-data-preservation.test.mjs
 */

import assert from 'node:assert/strict';
import { V1Repository } from '../src/data/repository/v1-repository.js';
import { V1BackupService } from '../src/data/backup/v1-backup-service.js';
import { backupStore } from '../src/app/backup-store.js';

const TODAY = '2026-08-20';
const ISO = '2026-08-20T12:00:00.000Z';
const TASKS_KEY = 'hometask-v1';
const META_KEY = 'hometask-meta-v1';

const CATALOG = [
  { id: 'seed-kitchen', title: 'Clean Counter', room: 'Kitchen', intervalDays: 7,
    tags: [], lastDone: null, doneToday: false, skipUntil: null },
  { id: 'seed-bath', title: 'Clean Mirror', room: 'Bathroom', intervalDays: 14,
    tags: [], lastDone: null, doneToday: false, skipUntil: null },
];
const ROOMS = ['Kitchen', 'Bathroom'];

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    clear: () => map.clear(),
    snapshot: () => new Map(map),
  };
}

function makeRepo(storage) {
  return new V1Repository({
    backing: storage,
    catalog: CATALOG,
    todayFn: () => TODAY,
  });
}

function makeStagingStore() {
  let value = null;
  return {
    get: () => value,
    save: data => { value = structuredClone(data); return true; },
    patch: patch => { value = { ...value, ...structuredClone(patch) }; return true; },
    clear: () => { value = null; return true; },
  };
}

function makeService({ storage, repo, exported = { text: null } }) {
  return new V1BackupService({
    catalogTasks: CATALOG,
    catalogRooms: ROOMS,
    repo,
    backing: storage,
    backupStore,
    stagingStore: makeStagingStore(),
    recoveryStore: {
      hasUndismissed: () => false,
      get: () => null,
      markDownloaded() {},
      markDismissed() {},
    },
    fileReader: {
      readAsText: file => Promise.resolve(file._text),
    },
    delivery: {
      canShare: () => false,
      download: blob => { exported.text = blob.text(); },
    },
    clock: () => ISO,
    sessionStore: makeStorage(),
  });
}

async function exportEnvelope(service, exported) {
  const result = await service.exportBackup();
  assert.equal(result.ok, true, result.message);
  return JSON.parse(await exported.text);
}

function customTask(overrides = {}) {
  return {
    id: 'custom-lab-air',
    title: 'Maintain Air Monitor',
    room: 'Lab',
    intervalDays: 9,
    tags: ['sensor'],
    lastDone: TODAY,
    doneToday: true,
    skipUntil: null,
    _custom: true,
    futureMetadata: {
      source: 'synthetic',
      nested: [{ label: 'seasonal', enabled: true }],
    },
    ...overrides,
  };
}

function basePrefs(roomFilter = 'Lab') {
  return {
    onboarded: true,
    choice: 'balanced',
    completedAt: '2026-08-01',
    dueNowDefault: false,
    viewMode: 'week',
    roomFilter,
  };
}

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, message: error.message });
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

console.log('\nCustom data preservation — focused v1 tests\n');

await check('P1: valid custom records retain safe unknown fields across load/save/restart', async () => {
  const raw = JSON.stringify([CATALOG[0], customTask()]);
  const storage = makeStorage({ [TASKS_KEY]: raw });
  const first = makeRepo(storage);
  const loaded = first.loadTasks();
  const custom = loaded.find(task => task.id === 'custom-lab-air');
  assert.deepEqual(custom.futureMetadata, customTask().futureMetadata);

  assert.equal(first.saveTasks(loaded).ok, true);
  const restarted = makeRepo(storage).loadTasks();
  assert.deepEqual(
    restarted.find(task => task.id === 'custom-lab-air'),
    custom,
    'synthetic restart must preserve the complete valid custom record',
  );
});

await check('P2: custom backup export includes full identity, state, and safe unknown fields', async () => {
  const storage = makeStorage({
    [TASKS_KEY]: JSON.stringify([CATALOG[0], customTask()]),
    [META_KEY]: JSON.stringify(basePrefs()),
  });
  globalThis.localStorage = storage;
  const exported = { text: null };
  const service = makeService({ storage, repo: makeRepo(storage), exported });
  const envelope = await exportEnvelope(service, exported);

  const custom = envelope.taskState.find(task => task.id === 'custom-lab-air');
  assert.deepEqual(custom, customTask());
  assert.equal(envelope.preferences.roomFilter, 'Lab');
});

await check('P3: synthetic pre-backup and post-restore custom semantics are equal', async () => {
  const sourceTasks = [CATALOG[0], customTask()];
  const sourcePrefs = basePrefs();
  const storage = makeStorage({
    [TASKS_KEY]: JSON.stringify(sourceTasks),
    [META_KEY]: JSON.stringify(sourcePrefs),
  });
  globalThis.localStorage = storage;
  const exported = { text: null };
  const service = makeService({ storage, repo: makeRepo(storage), exported });
  const envelope = await exportEnvelope(service, exported);
  const fileText = JSON.stringify(envelope);
  const validated = await service.readAndValidate({ size: fileText.length, _text: fileText });

  const imported = service.applyImport(validated.sanitizedTasks, validated.sanitizedPrefs);
  assert.equal(imported.ok, true, imported.message);

  const postRestoreTasks = makeRepo(storage).loadTasks();
  const postRestorePrefs = makeRepo(storage).loadPrefs();
  assert.deepEqual(
    postRestoreTasks.find(task => task.id === 'custom-lab-air'),
    customTask(),
    'custom task must be semantically identical after synthetic restore',
  );
  assert.equal(postRestorePrefs.roomFilter, 'Lab');
});

await check('P4: duplicate valid custom IDs are first-valid-wins; built-in IDs cannot be custom', async () => {
  const storage = makeStorage();
  globalThis.localStorage = storage;
  const first = customTask({ futureMetadata: { ordinal: 1 } });
  const second = customTask({ futureMetadata: { ordinal: 2 } });
  const masquerade = customTask({
    id: 'seed-kitchen',
    title: 'Cannot Replace Seed',
    room: 'Lab',
    futureMetadata: { hostile: true },
  });
  const envelope = {
    app: 'HomeTask',
    schemaVersion: 1,
    exportedAt: ISO,
    taskState: [
      masquerade,
      { id: 'seed-kitchen', lastDone: null, doneToday: false, skipUntil: null, tags: ['seed-state'] },
      first,
      second,
    ],
    preferences: basePrefs(),
  };
  const text = JSON.stringify(envelope);
  const service = makeService({ storage, repo: makeRepo(storage) });
  const validated = await service.readAndValidate({ size: text.length, _text: text });

  assert.equal(validated.sanitizedTasks.filter(task => task.id === 'custom-lab-air').length, 1);
  assert.deepEqual(
    validated.sanitizedTasks.find(task => task.id === 'custom-lab-air').futureMetadata,
    { ordinal: 1 },
  );
  assert.deepEqual(
    validated.sanitizedTasks.find(task => task.id === 'seed-kitchen').tags,
    ['seed-state'],
    'a custom record cannot consume or overwrite a built-in ID',
  );
});

await check('P5: malformed or unsafe custom records are rejected without dropping valid neighbours', async () => {
  const storage = makeStorage();
  globalThis.localStorage = storage;
  const unsafe = customTask({
    id: 'custom-unsafe',
    futureMetadata: { safe: true, constructor: { attempted: true } },
  });
  const malformed = customTask({ id: 'custom-malformed', title: '   ' });
  const envelope = {
    app: 'HomeTask',
    schemaVersion: 1,
    exportedAt: ISO,
    taskState: [
      CATALOG[0],
      customTask(),
      unsafe,
      malformed,
    ],
    preferences: basePrefs(),
  };
  const text = JSON.stringify(envelope);
  const service = makeService({ storage, repo: makeRepo(storage) });
  const validated = await service.readAndValidate({ size: text.length, _text: text });

  assert.deepEqual(
    validated.sanitizedTasks.filter(task => task._custom).map(task => task.id),
    ['custom-lab-air'],
  );
  assert.ok(
    validated.sanitizedTasks.some(task => task.id === 'seed-kitchen'),
    'unrelated valid seed state must survive',
  );
});

await check('P6: seed-only v1 backup remains state-only and restores exactly as before', async () => {
  const storage = makeStorage({
    [TASKS_KEY]: JSON.stringify([{ ...CATALOG[0], lastDone: '2026-08-19', doneToday: false, tags: ['legacy'] }]),
    [META_KEY]: JSON.stringify(basePrefs('Kitchen')),
  });
  globalThis.localStorage = storage;
  const exported = { text: null };
  const service = makeService({ storage, repo: makeRepo(storage), exported });
  const envelope = await exportEnvelope(service, exported);

  assert.equal(envelope.taskState.some(task => task._custom === true), false);
  assert.deepEqual(Object.keys(envelope.taskState[0]).sort(), ['doneToday', 'id', 'lastDone', 'skipUntil', 'tags']);

  const fileText = JSON.stringify(envelope);
  const validated = await service.readAndValidate({ size: fileText.length, _text: fileText });
  assert.equal(service.applyImport(validated.sanitizedTasks, validated.sanitizedPrefs).ok, true);
  assert.equal(makeRepo(storage).loadTasks().find(task => task.id === 'seed-kitchen').lastDone, '2026-08-19');
});

await check('P7: custom save failure does not overwrite existing synthetic bytes', async () => {
  const raw = JSON.stringify([CATALOG[0], customTask()]);
  const storage = makeStorage({ [TASKS_KEY]: raw });
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === TASKS_KEY) throw new Error('synthetic quota failure');
    originalSetItem(key, value);
  };
  const repo = makeRepo(storage);
  const result = repo.saveTasks([CATALOG[0], customTask({ futureMetadata: { changed: true } })]);
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(TASKS_KEY), raw);
});

console.log('\n' + '─'.repeat(60));
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failures.length) {
  console.error('\nFailed tests:');
  failures.forEach(failure => console.error(`  ✗ ${failure.name}\n    ${failure.message}`));
}
console.log('─'.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);