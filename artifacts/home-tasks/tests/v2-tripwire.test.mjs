/**
 * v2-tripwire.test.mjs — CP3 suite 3: the deterministic silent-data-loss
 * tripwire.
 *
 * Pipeline under test (full lifecycle, isolated mock storage only):
 *   rich v1 fixtures → v1 backup file → import/migrate to v2 →
 *   export v2 backup → reimport into an EMPTY store via the transaction →
 *   compose with the same catalog → assertEquivalent() + field-by-field
 *   preservation checks → unrelated keys byte-identical.
 *
 * Plus: one deliberately injected field-loss defect must make the
 * tripwire FAIL (proves the tripwire actually trips).
 *
 * Run with:  node artifacts/home-tasks/tests/v2-tripwire.test.mjs
 */

import assert from 'node:assert/strict';
import { CATALOG } from '../src/v2/catalog.data.js';
import { migrate } from '../src/v2/migrate.js';
import { compose } from '../src/v2/compose.js';
import { assertEquivalent } from '../src/v2/equivalence.js';
import { buildBackup, parseAndValidateBackup, readBackupFile } from '../src/v2/backup.js';
import { createMemoryAdapter } from '../src/v2/storage-adapter.js';
import { runImportTransaction, V2_KEYS } from '../src/v2/import-tx.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';

const CTX = { today: FIXED_TODAY, catalog: CATALOG, appBuild: 'v19' };
const EXPORT_CTX = { exportedAt: '2026-08-01T00:00:00.000Z', catalogVersion: CATALOG.catalogVersion, appBuild: 'v19' };
const NOW = '2026-08-01T00:00:00.000Z';
const UNRELATED = Object.freeze({ 'unrelated-app-key': 'do-not-touch', 'another-key': '42' });

let group = '', pass = 0, fail = 0;
const pending = [];
function check(name, fn) {
  const g = group;
  pending.push((async () => {
    try { await fn(); pass++; }
    catch (e) { fail++; console.error(`  ✗ [${g}] ${name}\n    ${e.message}`); }
  })());
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/** Build a v1 backup FILE from a fixture, exactly like the shipped v1 exporter. */
function v1BackupFileFrom(fixture) {
  const v1Tasks = JSON.parse(fixture.v1TasksRaw);
  const v1Meta = JSON.parse(fixture.v1MetaRaw);
  return {
    app: 'HomeTask', schemaVersion: 1, exportedAt: '2026-07-20T12:00:00.000Z',
    catalogTaskCount: CATALOG.tasks.length, catalogRoomCount: CATALOG.zones.length,
    taskState: v1Tasks.map(t => ({ id: t.id, lastDone: t.lastDone ?? null,
      doneToday: Boolean(t.doneToday), skipUntil: t.skipUntil ?? null,
      tags: Array.isArray(t.tags) ? t.tags : [] })),
    preferences: {
      viewMode: v1Meta.viewMode ?? 'today', roomFilter: v1Meta.roomFilter ?? '',
      onboarded: Boolean(v1Meta.onboarded), choice: v1Meta.choice ?? null,
      completedAt: v1Meta.completedAt ?? null,
    },
  };
}

/**
 * The tripwire pipeline. `mutateExport` optionally injects a defect into
 * the exported v2 backup (for the deliberate-defect proof).
 * Returns { diffs, fieldFailures, store }.
 */
async function runTripwire(fixture, mutateExport = null) {
  const fieldFailures = [];

  // 1 · v1 fixture → v1 backup file → import/migrate into the v2 model.
  const v1File = v1BackupFileFrom(fixture);
  const fileLike = { size: JSON.stringify(v1File).length, text: async () => JSON.stringify(v1File) };
  const read = await readBackupFile(fileLike);
  assert.equal(read.ok, true);
  const imported = parseAndValidateBackup(read.text, CTX);
  assert.equal(imported.ok, true, `v1 import failed: ${JSON.stringify(imported.errors)}`);
  const v2First = imported.sanitized;

  // 2 · Export v2.
  let exported = buildBackup(v2First, EXPORT_CTX);
  if (mutateExport) exported = mutateExport(structuredClone(exported));

  // 3 · Reimport into an EMPTY store through the real transaction.
  const reimported = parseAndValidateBackup(JSON.stringify(exported), CTX);
  assert.equal(reimported.ok, true, `v2 reimport failed: ${JSON.stringify(reimported.errors)}`);
  const store = createMemoryAdapter({ ...UNRELATED });
  const tx = runImportTransaction(store, JSON.stringify(reimported.sanitized), NOW);
  assert.equal(tx.ok, true, `transaction failed: ${tx.message}`);
  const v2Final = JSON.parse(store.getItem(V2_KEYS.DATA));

  // 4 · Compose with the same catalog (must not throw, zones/tasks present).
  const composed = compose(CATALOG, v2Final);
  assert.ok(composed.tasks.length >= CATALOG.tasks.length);

  // 5 · Equivalence against the ORIGINAL v1 fixture world.
  const v1Raw = { tasks: JSON.parse(fixture.v1TasksRaw), meta: JSON.parse(fixture.v1MetaRaw) };
  const diffs = assertEquivalent(CATALOG, v1Raw, v2Final, FIXED_TODAY);

  // 6 · Field-by-field survival across the round trip (v2First vs v2Final).
  for (const fieldSet of [
    ['state'], ['prefs'], ['userZones'], ['userTasks'], ['completionEvents'], ['overrides'], ['recentSearches'], ['meta'],
  ]) {
    const f = fieldSet[0];
    if (JSON.stringify(v2First[f]) !== JSON.stringify(v2Final[f])) {
      fieldFailures.push(`${f} changed across export→reimport`);
    }
  }
  // 7 · Unrelated keys byte-identical.
  for (const [k, v] of Object.entries(UNRELATED)) {
    if (store.getItem(k) !== v) fieldFailures.push(`unrelated key ${k} touched`);
  }
  return { diffs, fieldFailures, v2First, v2Final, store };
}

/* ════ 1 · Tripwire passes on rich fixtures ════ */
section('tripwire-pass');
for (const name of ['typical', 'inconsistentDoneToday', 'retiredAndUnknown']) {
  check(`full lifecycle preserves everything: fixture "${name}"`, async () => {
    const { diffs, fieldFailures } = await runTripwire(FIXTURES[name]);
    assert.deepEqual(diffs, [], `equivalence diffs: ${JSON.stringify(diffs)}`);
    assert.deepEqual(fieldFailures, []);
  });
}
check('fixture "malformedRecords": exactly the documented repair diffs, no other loss', async () => {
  // v1 keeps "not-a-date" lastDone and a bogus viewMode; migration repairs
  // them by design (see v1-storage-quirks + CP1 suite). Equivalence must
  // differ ONLY in those documented ways — anything else is data loss.
  const { diffs, fieldFailures } = await runTripwire(FIXTURES.malformedRecords);
  const allowed = /^(mb-floor\.(lastDone|status|effectiveDue)|workload:|prefs\.viewMode:|today view|week view)/;
  const unexpected = diffs.filter(d => !allowed.test(d));
  assert.deepEqual(unexpected, [], `undocumented differences:\n${unexpected.join('\n')}`);
  assert.ok(diffs.some(d => d.startsWith('mb-floor.lastDone')), 'expected repair diff missing');
  assert.deepEqual(fieldFailures, [], 'round-trip must still be lossless after the first import');
});
check('completion, skip, tags, prefs, tombstone state survive explicitly', async () => {
  const { v2Final } = await runTripwire(FIXTURES.typical);
  const byId = Object.fromEntries(v2Final.state.map(s => [s.taskId, s]));
  assert.equal(byId['mb-floor'].doneToday, true);                 // completed today
  assert.equal(byId['mb-floor'].lastDone, FIXED_TODAY);
  assert.equal(byId['md-floor'].skipUntil, '2026-08-05');         // skip override
  assert.deepEqual(byId['to-floor'].tags, ['deep-clean']);        // user tag
  assert.equal(byId['smoke-batteries'].lastDone, '2026-01-15');   // safety history
  assert.equal(v2Final.prefs.viewMode, 'week');
  assert.equal(v2Final.prefs.roomFilterZoneId, 'z_madis-room');
  assert.equal(v2Final.prefs.choice, 'guided');
});
check('v2-only content (custom zones/tasks/overrides/recurrence/completionEvents) survives a v2→v2 round trip', async () => {
  // Start from typical, enrich with v2-only data, export → reimport → tx.
  const { v2 } = migrate(FIXTURES.typical, CTX);
  v2.userZones = [{ id: 'u_garage', title: 'Garage', sortOrder: 99, archivedAt: null }];
  v2.userTasks = [{ id: 'u_sweep', title: 'Sweep Garage', zoneId: 'u_garage',
    recurrence: { kind: 'annualDate', month: 4, day: 15 }, archivedAt: null, safety: false }];
  v2.completionEvents = [
    { id: 'c_ev1', taskId: 'mb-floor', completedOn: '2026-07-15', durationMinutes: 20 },
    { id: 'c_ev2', taskId: 'u_sweep',  completedOn: '2026-07-10', durationMinutes: null },
  ];
  v2.overrides = { 'mb-floor': { recurrence: { kind: 'interval', unit: 'week', every: 2 } } };
  v2.state.push({ taskId: 'mbath-all', lastDone: '2026-07-01', doneToday: false, skipUntil: null, tags: [] });

  const r1 = parseAndValidateBackup(JSON.stringify(buildBackup(v2, EXPORT_CTX)), CTX);
  assert.equal(r1.ok, true);
  const r2 = parseAndValidateBackup(JSON.stringify(buildBackup(r1.sanitized, EXPORT_CTX)), CTX);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.sanitized, r1.sanitized, 'semantic loss across v2 round trip');
  assert.equal(r2.sanitized.userTasks[0].recurrence.kind, 'annualDate');
  assert.ok(r2.sanitized.state.some(s => s.taskId === 'mbath-all'), 'tombstone state lost');
  assert.equal(r2.sanitized.completionEvents.length, 2, 'completionEvents lost in round trip');
  assert.equal(r2.sanitized.completionEvents[0].durationMinutes, 20);
  assert.equal(r2.sanitized.completionEvents[1].durationMinutes, null);
});

/* ════ 2 · Deliberate-defect proof: the tripwire must trip ════ */
section('deliberate-defect');
check('injected tag-loss defect is caught', async () => {
  const { diffs, fieldFailures } = await runTripwire(FIXTURES.typical, exported => {
    exported.data.state = exported.data.state.map(s => ({ ...s, tags: [] }));   // silent tag loss
    return exported;
  });
  assert.ok(diffs.length + fieldFailures.length > 0, 'tripwire failed to detect tag loss');
  assert.ok(diffs.some(d => d.includes('tags')) || fieldFailures.some(f => f.includes('state')));
});
check('injected skip-state-loss defect is caught', async () => {
  const { diffs } = await runTripwire(FIXTURES.typical, exported => {
    exported.data.state = exported.data.state.map(s => ({ ...s, skipUntil: null }));
    return exported;
  });
  assert.ok(diffs.some(d => d.includes('skipUntil') || d.includes('status') || d.includes('effectiveDue') || d.includes('membership')),
    `skip loss not detected: ${JSON.stringify(diffs)}`);
});
check('injected preference-loss defect is caught', async () => {
  const { diffs, fieldFailures } = await runTripwire(FIXTURES.typical, exported => {
    exported.data.prefs = { ...exported.data.prefs, viewMode: 'today', roomFilterZoneId: '' };
    return exported;
  });
  assert.ok(diffs.some(d => d.includes('prefs')) || fieldFailures.some(f => f.includes('prefs')),
    `pref loss not detected: ${JSON.stringify({ diffs, fieldFailures })}`);
});

/* async checks: wait for all of them */
await Promise.all(pending);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
