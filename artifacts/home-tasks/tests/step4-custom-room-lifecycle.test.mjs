/* ================================================================
   Step 4 — explicit custom-room lifecycle

   Synthetic-only coverage for the dedicated hometask-rooms-v1 key:
   repository hardening, model lifecycle, legacy compatibility, and
   v1 backup/import/undo atomicity.
   ================================================================ */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { V1Repository } from '../src/data/repository/v1-repository.js';
import { V1BackupService } from '../src/data/backup/v1-backup-service.js';

const TODAY = '2026-08-21';
const CATALOG = [
  { id: 'seed-kitchen', title: 'Wipe Counter', room: 'Kitchen', intervalDays: 7, tags: [], lastDone: null, doneToday: false, skipUntil: null },
  { id: 'seed-bath', title: 'Scrub Sink', room: 'Bathroom', intervalDays: 14, tags: [], lastDone: null, doneToday: false, skipUntil: null },
];
const ROOM_KEY = 'hometask-rooms-v1';
const APP_SOURCE = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');

function makeBacking(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    raw: key => map.has(key) ? map.get(key) : null,
  };
}

function makeRepo(backing) {
  return new V1Repository({ backing, catalog: CATALOG, todayFn: () => TODAY });
}

let modelNumber = 0;
async function freshModel(repo) {
  const { tasks } = await import(`../src/app/tasks.js?step4=${modelNumber++}`);
  tasks.setRepo(repo);
  return tasks;
}

function makeBackupStore(backing) {
  const IMPORT_KEYS = ['hometask-v1', ROOM_KEY, 'hometask-meta-v1'];
  let snapshot = null;
  return {
    IMPORT_KEYS,
    saveSnapshot() {
      snapshot = { savedAt: '2026-08-21T12:00:00.000Z', keys: Object.fromEntries(IMPORT_KEYS.map(key => [key, backing.getItem(key)])) };
      return { ok: true };
    },
    getSnapshot: () => snapshot,
    clearSnapshot: () => { snapshot = null; },
    applySnapshot(snap) {
      for (const key of IMPORT_KEYS) {
        if (snap.keys[key] === null) backing.removeItem(key);
        else backing.setItem(key, snap.keys[key]);
      }
      return { ok: true, restored: [...IMPORT_KEYS] };
    },
  };
}

function makeService(backing, repo, delivery = { canShare: () => false, download() {} }) {
  const staged = { value: null };
  return new V1BackupService({
    catalogTasks: CATALOG,
    catalogRooms: ['Kitchen', 'Bathroom'],
    repo,
    backing,
    backupStore: makeBackupStore(backing),
    stagingStore: {
      get: () => staged.value,
      save: data => { staged.value = structuredClone(data); return true; },
      patch: patch => { staged.value = { ...staged.value, ...patch }; return true; },
      clear: () => { staged.value = null; },
    },
    recoveryStore: { hasUndismissed: () => false, get: () => null, markDownloaded() {}, markDismissed() {} },
    fileReader: { readAsText: file => Promise.resolve(file.text) },
    delivery,
    clock: () => '2026-08-21T12:00:00.000Z',
    sessionStore: { getItem: () => null, setItem() {}, removeItem() {} },
  });
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name} — ${error.message}`);
  }
}

console.log('Step 4 custom-room lifecycle');

await check('A1: empty explicit room persists through repository reload', async () => {
  const backing = makeBacking();
  const repo = makeRepo(backing);
  assert.deepEqual(repo.loadCustomRooms(), []);
  assert.equal(repo.saveCustomRooms([{ id: 'room-workshop', name: 'Workshop', _customRoom: true }]).ok, true);
  assert.deepEqual(makeRepo(backing).loadCustomRooms(), [{ id: 'room-workshop', name: 'Workshop', _customRoom: true }]);
});

await check('A2: malformed or built-in conflicting neighboring records are skipped individually', async () => {
  const backing = makeBacking({
    [ROOM_KEY]: JSON.stringify({
      schemaVersion: 1,
      rooms: [
        { id: 'room-good', name: 'Craft Space', _customRoom: true },
        { id: 'room-bad', name: '', _customRoom: true },
        { id: 'room-kitchen', name: 'Kitchen', _customRoom: true },
        { id: 'room-good', name: 'Duplicate id', _customRoom: true },
      ],
    }),
  });
  assert.deepEqual(makeRepo(backing).loadCustomRooms(), [{ id: 'room-good', name: 'Craft Space', _customRoom: true }]);
});

await check('A3: dedicated room key never changes the v1 task-array contract', async () => {
  const backing = makeBacking({
    [ROOM_KEY]: JSON.stringify({ schemaVersion: 1, rooms: [{ id: 'room-loft', name: 'Loft', _customRoom: true }] }),
  });
  const tasks = makeRepo(backing).loadTasks();
  assert.equal(tasks.length, CATALOG.length);
  assert.equal(backing.raw('hometask-v1').startsWith('['), true);
});

await check('B1: create empty room survives restart and appears alongside legacy task-derived rooms', async () => {
  const backing = makeBacking();
  const model = await freshModel(makeRepo(backing));
  assert.equal(model.createRoom({ name: '  Tool Shed  ', generator: () => 'room-tool-shed' }).ok, true);
  assert.equal(model.addTask({ title: 'Sort supplies', room: 'Legacy Loft', intervalDays: 7, generator: () => 'custom-legacy' }).ok, true);
  assert.deepEqual(model.getCustomRooms(), ['Tool Shed', 'Legacy Loft']);
  const restarted = await freshModel(makeRepo(backing));
  assert.deepEqual(restarted.getCustomRooms(), ['Tool Shed', 'Legacy Loft']);
});

await check('B2: built-in names and duplicate submissions are rejected without a write', async () => {
  const backing = makeBacking();
  const model = await freshModel(makeRepo(backing));
  assert.equal(model.createRoom({ name: 'Kitchen' }).code, 'validation-room-duplicate');
  assert.equal(model.createRoom({ name: 'Studio', generator: () => 'room-studio' }).ok, true);
  assert.equal(model.createRoom({ name: '  studio  ' }).code, 'validation-room-duplicate');
  assert.equal(model.getCustomRooms().length, 1);
});

await check('B3: custom tasks remain valid in built-in rooms', async () => {
  const model = await freshModel(makeRepo(makeBacking()));
  assert.equal(model.addTask({ title: 'Polish knobs', room: 'Kitchen', intervalDays: 7, generator: () => 'custom-kitchen' }).ok, true);
  assert.equal(model.getCustomRooms().includes('Kitchen'), false);
});

await check('B4: populated room deletion is blocked with exact count and leaves records untouched', async () => {
  const backing = makeBacking();
  const model = await freshModel(makeRepo(backing));
  assert.equal(model.createRoom({ name: 'Garage', generator: () => 'room-garage' }).ok, true);
  assert.equal(model.addTask({ title: 'Sweep floor', room: 'Garage', intervalDays: 7, generator: () => 'custom-garage' }).ok, true);
  const before = backing.raw(ROOM_KEY);
  const result = model.removeRoom('Garage');
  assert.equal(result.code, 'room-not-empty');
  assert.equal(result.count, 1);
  assert.match(result.message, /1 task remains/);
  assert.equal(backing.raw(ROOM_KEY), before);
});

await check('B5: empty custom room deletes; built-in room deletion never can', async () => {
  const model = await freshModel(makeRepo(makeBacking()));
  assert.equal(model.createRoom({ name: 'Office', generator: () => 'room-office' }).ok, true);
  assert.equal(model.removeRoom('Kitchen').code, 'catalog-room');
  assert.equal(model.removeRoom('Office').ok, true);
  assert.equal(model.getCustomRooms().includes('Office'), false);
});

await check('B6: room write failure is copy-on-write and leaves visible state unchanged', async () => {
  const backing = makeBacking();
  const originalSet = backing.setItem;
  backing.setItem = (key, value) => {
    if (key === ROOM_KEY) throw new Error('injected room write failure');
    originalSet(key, value);
  };
  const model = await freshModel(makeRepo(backing));
  const result = model.createRoom({ name: 'Sunroom', generator: () => 'room-sunroom' });
  assert.equal(result.code, 'storage-error');
  assert.equal(model.getCustomRooms().includes('Sunroom'), false);
  assert.equal(backing.raw(ROOM_KEY), null);
});

await check('C1: new backup export carries explicit room records', async () => {
  const backing = makeBacking();
  const repo = makeRepo(backing);
  repo.saveCustomRooms([{ id: 'room-studio', name: 'Studio', _customRoom: true }]);
  let blob;
  const service = makeService(backing, repo, { canShare: () => false, download: value => { blob = value; } });
  assert.equal((await service.exportBackup()).ok, true);
  const parsed = JSON.parse(await blob.text());
  assert.deepEqual(parsed.customRooms.rooms, [{ id: 'room-studio', name: 'Studio', _customRoom: true }]);
});

await check('C2: legacy backup without customRooms validates as an empty explicit-room set', async () => {
  const service = makeService(makeBacking(), makeRepo(makeBacking()));
  const result = await service.readAndValidate({
    size: 100,
    text: JSON.stringify({
      app: 'HomeTask', schemaVersion: 1, exportedAt: '2026-08-21T12:00:00.000Z',
      taskState: [{ id: 'seed-kitchen', lastDone: null, doneToday: false, skipUntil: null, tags: [] }],
      preferences: { viewMode: 'all', roomFilter: 'Kitchen', onboarded: false, choice: null, completedAt: null },
    }),
  });
  assert.deepEqual(result.sanitizedRooms, []);
});

await check('C3: import writes room key atomically and undo restores its prior bytes', async () => {
  const priorRooms = JSON.stringify({ schemaVersion: 1, rooms: [{ id: 'room-prior', name: 'Prior', _customRoom: true }] });
  const backing = makeBacking({ [ROOM_KEY]: priorRooms });
  const repo = makeRepo(backing);
  const service = makeService(backing, repo);
  const imported = [{ id: 'room-new', name: 'New Room', _customRoom: true }];
  assert.equal(service.applyImport([], { roomFilter: 'New Room' }, imported).ok, true);
  assert.deepEqual(JSON.parse(backing.raw(ROOM_KEY)).rooms, imported);
  assert.equal(service.applyUndo().ok, true);
  assert.equal(backing.raw(ROOM_KEY), priorRooms);
});

await check('D1: successful room deletion closes the picker before restoring trigger focus', async () => {
  const deleteBlock = APP_SOURCE.match(/function _confirmRoomDelete\(\)[\s\S]*?\n  \}\n\n  function _wireCustomRoomLifecycle/ )?.[0] ?? '';
  assert.match(deleteBlock, /dlg\?\.close\(\);[\s\S]*roomPickerDialog\?\.open[\s\S]*roomPickerDialog\.close\(\);[\s\S]*roomPickerBtn\.focus\(\)/);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);