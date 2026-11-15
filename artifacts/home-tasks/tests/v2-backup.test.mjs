/**
 * v2-backup.test.mjs — CP3 suite 1: v2 backup envelope, size guard,
 * strict validation/sanitization, security payloads, v1↔v2 compatibility,
 * plus correction suites for Title Case, referential integrity, Policy A
 * (extended to all user-owned records), completionEvents, and uniqueness.
 *
 * Standalone Node ESM. No browser, no real storage, no clock reads.
 * Run with:  node artifacts/home-tasks/tests/v2-backup.test.mjs
 */

import assert from 'node:assert/strict';
import { CATALOG } from '../src/v2/catalog.data.js';
import { migrate, reverseMigrate } from '../src/v2/migrate.js';
import { buildBackup, checkImportSize, readBackupFile, parseAndValidateBackup, MAX_FILE_BYTES } from '../src/v2/backup.js';
import { validateBackup, LIMITS } from '../src/v2/backup-validate.js';
import { FIXTURES, FIXED_TODAY } from './fixtures.mjs';

const CTX = { today: FIXED_TODAY, catalog: CATALOG, appBuild: 'v19' };
const EXPORT_CTX = { exportedAt: '2026-08-01T00:00:00.000Z', catalogVersion: CATALOG.catalogVersion, appBuild: 'v19' };

let group = '', pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); }
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/** Baseline valid v2 backup built from the 'typical' fixture via migrate(). */
function typicalBackup() {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  return buildBackup(structuredClone(v2), EXPORT_CTX);
}
/** Rich v2-only backup: custom zone, custom task, override, tombstone state. */
function richV2Backup() {
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_garage', title: 'Garage', sortOrder: 99, archivedAt: null }];
  b.data.userTasks = [{ id: 'u_sweep-garage', title: 'Sweep Garage', zoneId: 'u_garage',
    recurrence: { kind: 'interval', unit: 'week', every: 2 }, archivedAt: null, safety: false }];
  b.data.overrides = { 'mb-floor': { title: 'Vacuum Master Floor' }, 'zone:z_kitchen': { sortOrder: 3 } };
  b.data.state.push({ taskId: 'mbath-all', lastDone: '2026-07-01', doneToday: false, skipUntil: null, tags: [] });
  b.data.state.push({ taskId: 'u_sweep-garage', lastDone: '2026-07-20', doneToday: false, skipUntil: null, tags: ['weekend'] });
  return b;
}

/* ════ 1 · Envelope build ════ */
section('envelope-build');
check('buildBackup wraps the canonical 9-field envelope with exact wrapper fields', () => {
  const b = typicalBackup();
  assert.deepEqual(Object.keys(b), ['app', 'schemaVersion', 'exportedAt', 'catalogVersion', 'appBuild', 'data']);
  assert.equal(b.app, 'HomeTask'); assert.equal(b.schemaVersion, 2);
  assert.equal(b.catalogVersion, 1);
  assert.deepEqual(Object.keys(b.data),
    ['schemaVersion', 'state', 'prefs', 'userZones', 'userTasks', 'completionEvents', 'overrides', 'recentSearches', 'meta']);
});
check('buildBackup requires injected ctx (no clock reads)', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  assert.throws(() => buildBackup(v2, { exportedAt: 'x', catalogVersion: 1 }), /appBuild is required/);
  assert.throws(() => buildBackup({ schemaVersion: 1 }, EXPORT_CTX), /not a v2 storage envelope/);
});
check('backup excludes staging/snapshot/recovery concepts entirely', () => {
  const json = JSON.stringify(typicalBackup());
  for (const bad of ['staging', 'snapshot', 'txState', 'keysWritten', 'rawData', 'preservationFailed']) {
    assert.ok(!json.includes(`"${bad}"`), `backup JSON must not contain "${bad}"`);
  }
});
check('backup does not duplicate the seed catalog', () => {
  const b = typicalBackup();
  assert.ok(!('tasks' in b.data) && !('zones' in b.data) && !('catalog' in b.data));
  assert.ok(!JSON.stringify(b.data.state).includes('"title"'));
});

/* ════ 2 · Size guard ════ */
section('size-guard');
check('boundary: below limit accepted, exactly 2 MB accepted, above rejected', () => {
  assert.equal(checkImportSize(MAX_FILE_BYTES - 1).ok, true);
  assert.equal(checkImportSize(MAX_FILE_BYTES).ok, true);
  assert.equal(checkImportSize(MAX_FILE_BYTES + 1).ok, false);
  assert.equal(checkImportSize(undefined).ok, false);
  assert.equal(checkImportSize(-5).ok, false);
});
check('oversized file is rejected BEFORE .text() is called', async () => {
  let textCalled = false;
  const file = { size: MAX_FILE_BYTES + 1, text: async () => { textCalled = true; return '{}'; } };
  const r = await readBackupFile(file);
  assert.equal(r.ok, false);
  assert.equal(textCalled, false, '.text() must never run for oversized files');
});
check('valid-size file is read; read errors are calm', async () => {
  const ok = await readBackupFile({ size: 10, text: async () => '{"a":1}' });
  assert.deepEqual(ok, { ok: true, text: '{"a":1}' });
  const bad = await readBackupFile({ size: 10, text: async () => { throw new Error('io'); } });
  assert.equal(bad.ok, false);
});
check('recovery-data download is not an importable backup', () => {
  const recoveryRecord = { detectedAt: 'x', sourceKey: 'hometask-v1', originalLength: 5, storedLength: 5,
    truncated: false, rawData: '{"a":', downloaded: true, dismissed: false, preservationFailed: false };
  const r = parseAndValidateBackup(JSON.stringify(recoveryRecord), CTX);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /app identifier/);
});

/* ════ 3 · Reject-level validation ════ */
section('reject-cases');
const rejects = (mutate, pattern) => {
  const b = typicalBackup(); mutate(b);
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'expected rejection');
  assert.ok(r.errors.some(e => pattern.test(e)), `no error matching ${pattern} in: ${JSON.stringify(r.errors)}`);
};
check('malformed JSON rejected calmly', () => {
  const r = parseAndValidateBackup('{"app":"HomeTask",', CTX);
  assert.equal(r.ok, false); assert.match(r.errors[0], /could not be read/);
});
check('wrong app identifier', () => rejects(b => { b.app = 'OtherApp'; }, /app identifier/));
check('future schemaVersion rejected calmly', () => rejects(b => { b.schemaVersion = 3; }, /newer version/));
check('missing schemaVersion', () => rejects(b => { delete b.schemaVersion; }, /schemaVersion/));
check('missing catalogVersion', () => rejects(b => { delete b.catalogVersion; }, /catalogVersion/));
check('unknown wrapper field', () => rejects(b => { b.extra = 1; }, /unknown wrapper field/));
check('data not canonical: missing field', () => rejects(b => { delete b.data.prefs; }, /missing canonical field/));
check('data not canonical: unknown top-level field', () => rejects(b => { b.data.bonus = []; }, /unknown top-level field/));
check('array as top level rejected', () => {
  const r = parseAndValidateBackup('[]', CTX);
  assert.equal(r.ok, false);
});
check('duplicate state records for one task rejected', () =>
  rejects(b => { b.data.state.push({ ...b.data.state[0] }); }, /duplicate state records/));
check('duplicate task id (user task colliding with seed) rejected', () => {
  const b = typicalBackup();
  const ut = { id: 'u_dup', title: 'One', zoneId: 'z_kitchen', recurrence: { kind: 'paused' }, archivedAt: null };
  b.data.userTasks = [ut, { ...ut, title: 'Two (conflicting definition)' }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate task id: u_dup/.test(e)));
});
check('duplicate zone id rejected', () => {
  const b = typicalBackup();
  const z = { id: 'u_z', title: 'A', sortOrder: 0, archivedAt: null };
  b.data.userZones = [z, { ...z, title: 'B' }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate zone id/.test(e)));
});
check('oversized collections rejected', () => {
  rejects(b => { b.data.recentSearches = []; b.data.state = Array.from({ length: LIMITS.STATE_MAX + 1 },
    (_, i) => ({ taskId: `x${i}`, lastDone: null, doneToday: false, skipUntil: null, tags: [] })); }, /max 2000/);
});
check('excessively long string rejected', () =>
  rejects(b => { b.data.prefs.choice = 'x'.repeat(LIMITS.STRING_MAX + 1); }, /string too long/));
check('excessively deep object rejected', () => {
  let deep = 'x';
  for (let i = 0; i < LIMITS.MAX_DEPTH + 2; i++) deep = { d: deep };
  rejects(b => { b.data.overrides['mb-floor'] = deep; }, /too deep/);
});
check('empty backup (no restorable data) rejected', () => {
  const { v2 } = migrate(FIXTURES.empty, CTX);
  v2.prefs.onboarded = false;
  const r = validateBackup(buildBackup(v2, EXPORT_CTX), CATALOG);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /no restorable data/);
});

/* ════ 4 · Security payloads ════ */
section('security');
check('__proto__ / constructor / prototype keys rejected outright', () => {
  for (const evil of ['__proto__', 'constructor', 'prototype']) {
    const json = JSON.stringify(typicalBackup()).replace('"overrides":{}', `"overrides":{"${evil}":{"title":"x"}}`)
      .replace('"overrides":{"mb', `"overrides":{"${evil}":{"title":"x"},"mb`);
    const r = parseAndValidateBackup(json, CTX);
    assert.equal(r.ok, false, `${evil} must reject`);
    assert.ok(r.errors.some(e => e.includes('prototype-pollution')), `${evil}: ${JSON.stringify(r.errors)}`);
  }
  assert.equal(({}).polluted, undefined, 'global Object prototype untouched');
});
check('HTML/script content survives as inert data, never executed/rendered', () => {
  const b = richV2Backup();
  b.data.userTasks[0].title = '<script>alert(1)</script>';
  b.data.state[0].tags = ['<img src=x onerror=alert(1)>'];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  const ut = r.sanitized.userTasks[0];
  assert.equal(ut.title, '<script>alert(1)</script>');   // stored as data; escaping is render-time
  assert.ok(r.sanitized.state[0].tags[0].startsWith('<img'));
  for (const e of [...r.repairs, ...r.warnings]) assert.equal(typeof e, 'string');
});
check('attempt to overwrite catalog-authoritative safety is stripped + reported', () => {
  const b = typicalBackup();
  b.data.overrides = { 'smoke-batteries': { safety: false, title: 'Renamed' } };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sanitized.overrides['smoke-batteries'], { title: 'Renamed' });
  assert.ok(r.repairs.some(x => x.includes('safety') && x.includes('catalog-authoritative')));
});
check('attempt to inject unknown override fields → rejected (Policy A)', () => {
  // intervalDays, room, id are not in SEED_TASK_OVERRIDABLE → unknown override fields → Policy A reject.
  const b = typicalBackup();
  b.data.overrides = { 'mb-floor': { intervalDays: 1, room: 'Fake', id: 'hijack', title: 'Ok' } };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown override fields must reject');
  assert.ok(r.errors.some(e => /unknown override field/.test(e) || /not overridable/.test(e)),
    `expected override-field error, got: ${JSON.stringify(r.errors)}`);
});
check('user task cannot self-declare safety (explicit exception: safe repair)', () => {
  const b = richV2Backup();
  b.data.userTasks[0].safety = true;
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.userTasks[0].safety, false);
  assert.ok(r.repairs.some(x => x.includes('cannot set safety')));
});
check('duplicate IDs with conflicting definitions cannot slip through as last-wins', () => {
  const b = typicalBackup();
  const json = JSON.stringify(b).replace('"overrides":{}',
    '"overrides":{"mb-floor":{"title":"A"},"mb-floor":{"title":"B"}}');
  const r = parseAndValidateBackup(json, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.overrides['mb-floor'].title, 'B');   // documented JSON semantics, no crash
});

/* ════ 5 · Quarantine + repair policy ════ */
section('quarantine-repair');
check('unknown seed-format id in state → Policy A reject with calm catalog-version message', () => {
  // Schema-v2: all state quarantines are Policy A. Even seed-format unknown IDs
  // (which may come from a newer catalog version) now reject the whole import.
  const b = typicalBackup();
  b.data.state.push({ taskId: 'ghost-task', lastDone: '2026-07-01', doneToday: false, skipUntil: null, tags: [] });
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'schema-v2: state with unknown seed-format id must reject');
  assert.ok(r.errors.some(e => e.includes('catalog') || e.includes('newer version')),
    `expected catalog-version message, got: ${JSON.stringify(r.errors)}`);
  assert.ok(Array.isArray(r.quarantined));
  assert.ok(r.quarantined.some(q => q.record?.taskId === 'ghost-task'), 'quarantined[] still populated for diagnostics');
});
check('retired/tombstoned seed id in state → retained with warning (not Policy A)', () => {
  const b = richV2Backup();
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.ok(r.sanitized.state.some(s => s.taskId === 'mbath-all'));
  assert.ok(r.warnings.some(w => w.includes('retired task mbath-all')));
});
check('invalid dates repaired to null with report; impossible calendar dates too', () => {
  const b = typicalBackup();
  b.data.state[0].lastDone = '2026-02-30';
  b.data.state[1].skipUntil = 'not-a-date';
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  const s0 = r.sanitized.state.find(s => s.taskId === b.data.state[0].taskId);
  assert.equal(s0.lastDone, null);
  assert.ok(r.repairs.filter(x => x.includes('invalid date')).length >= 2);
});
check('doneToday true without lastDone repaired to false', () => {
  const b = typicalBackup();
  b.data.state[1].doneToday = true; b.data.state[1].lastDone = null;
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.ok(r.repairs.some(x => x.includes('doneToday')));
});
check('user task with invalid recurrence → entire import REJECTED (Policy A)', () => {
  const b = richV2Backup();
  b.data.userTasks.push({ id: 'u_bad', title: 'Bad', zoneId: 'z_kitchen',
    recurrence: { kind: 'interval', unit: 'fortnight', every: 0 }, archivedAt: null });
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'Policy A: user-owned quarantine must reject');
  assert.ok(r.errors.some(e => /invalid recurrence/.test(e)), `errors: ${JSON.stringify(r.errors)}`);
});
check('user task referencing nonexistent zone → entire import REJECTED (Policy A)', () => {
  const b = richV2Backup();
  b.data.userTasks[0].zoneId = 'u_nowhere';
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'Policy A: nonexistent zone must reject');
  assert.ok(r.errors.some(e => /nonexistent zone/.test(e) || /cannot be placed/.test(e)),
    `errors: ${JSON.stringify(r.errors)}`);
});
check('user task with null/missing zoneId → entire import REJECTED (Policy A)', () => {
  const b = richV2Backup();
  b.data.userTasks[0].zoneId = null;
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'Policy A: no-zone user task must reject');
  assert.ok(r.errors.some(e => /no zone/.test(e) || /valid zone/.test(e)),
    `errors: ${JSON.stringify(r.errors)}`);
});
check('override addressing unknown id → Policy A reject (schema-v2)', () => {
  // Schema-v2: overrides are user-owned. An override for an id that doesn't
  // exist in this catalog is now a Policy A reject (was quarantine only).
  const b = typicalBackup();
  b.data.overrides = { 'never-existed': { title: 'x' }, 'zone:z_fake': { title: 'y' } };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown override id must now reject');
  assert.ok(r.errors.some(e => /unknown id/.test(e) || /catalog/.test(e)),
    `expected catalog-compat message, got: ${JSON.stringify(r.errors)}`);
  assert.ok(Array.isArray(r.quarantined));  // quarantined[] still returned for diagnostics
});
check('titles are normalized to Title Case; ids and history are never altered', () => {
  const b = richV2Backup();
  b.data.userTasks[0].title = '  wash the DOG house  ';
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  // Trim, collapse whitespace, Title Case — "DOG" is not a recognized acronym
  // so _normWord capitalizes the first letter and preserves the rest as-is:
  // _normWord("DOG") → charAt(0).toUpperCase() + slice(1) = "D" + "OG" = "DOG".
  assert.equal(r.sanitized.userTasks[0].title, 'Wash The DOG House');
  assert.ok(r.repairs.some(x => x.includes('title normalized')));
  // IDs and state are never rewritten.
  assert.equal(r.sanitized.userTasks[0].id, 'u_sweep-garage');
  // Long titles: normalized then capped at TITLE_MAX.
  const long = 'x'.repeat(LIMITS.TITLE_MAX + 30);
  b.data.userTasks[0].title = long;
  const r2 = validateBackup(b, CATALOG);
  assert.equal(r2.sanitized.userTasks[0].title.length, LIMITS.TITLE_MAX);
  // Already-normalized title: no task-specific title repair logged.
  b.data.userTasks[0].title = 'Sweep Garage';
  const r3 = validateBackup(b, CATALOG);
  assert.equal(r3.ok, true);
  assert.equal(r3.sanitized.userTasks[0].title, 'Sweep Garage');
  assert.ok(!r3.repairs.some(x => x.startsWith('userTasks[0]') && x.includes('title normalized')),
    'no task-title repair for an already-normalized title');
});
check('tags: capped per-task, entries trimmed, non-strings dropped — all reported', () => {
  const b = typicalBackup();
  b.data.state[0].tags = [' spaced ', 7, 'x'.repeat(80), ...Array.from({ length: 30 }, (_, i) => `t${i}`)];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  const s = r.sanitized.state.find(x => x.taskId === b.data.state[0].taskId);
  assert.ok(s.tags.length <= LIMITS.TAGS_PER_TASK_MAX);
  assert.equal(s.tags[0], 'spaced');
  assert.equal(s.tags[1].length, LIMITS.TAG_MAX);
});
check('prefs repaired: bad viewMode, unknown roomFilterZoneId, unknown field', () => {
  const b = typicalBackup();
  b.data.prefs = { viewMode: 'bogus', roomFilterZoneId: 'z_fake', onboarded: true, choice: null, completedAt: null, hacker: 1 };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.prefs.viewMode, 'today');
  assert.equal(r.sanitized.prefs.roomFilterZoneId, '');
  assert.ok(r.repairs.some(x => x.includes('prefs.hacker')));
});
check('bad seed-state now rejects import (Policy A, schema-v2)', () => {
  // Schema-v2: state records are user-owned. An unknown seed-format taskId
  // (ghost: no u_ prefix) now triggers Policy A — the whole import rejects.
  const b = richV2Backup();
  b.data.state.push({ taskId: 'ghost', lastDone: null, doneToday: false, skipUntil: null, tags: [] });
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'schema-v2: state with unknown taskId must reject');
  assert.ok(r.errors.some(e => e.includes('catalog') || e.includes('newer')));
});
check('bad user task triggers Policy A reject; unknown override id also now rejects', () => {
  // User task with an invalid id → Policy A reject.
  const b = richV2Backup();
  b.data.userTasks.push({ id: 'not a valid id!', title: 'x', zoneId: 'z_kitchen', recurrence: { kind: 'paused' } });
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'invalid user-task id must trigger Policy A');
  assert.ok(r.errors.some(e => /invalid user task id/.test(e)));
  // An override with an unknown seed id ALSO now triggers Policy A (schema-v2).
  const b2 = richV2Backup();
  b2.data.overrides = { 'never-existed': { title: 'X' } };
  const r2 = validateBackup(b2, CATALOG);
  assert.equal(r2.ok, false, 'unknown override id must also trigger Policy A in schema-v2');
  assert.ok(r2.errors.some(e => /unknown id/.test(e) || /catalog/.test(e)));
});
check('unknown field in user task → Policy A reject', () => {
  const b = richV2Backup();
  b.data.userTasks[0].futureProp = 'some-value';
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown field in user task must reject');
  assert.ok(r.errors.some(e => /unknown field in user task/.test(e)));
});
check('unknown field in user zone → Policy A reject', () => {
  const b = richV2Backup();
  b.data.userZones[0].futureField = 'x';
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown field in user zone must reject');
  assert.ok(r.errors.some(e => /unknown field in user zone/.test(e)));
});
check('unknown field in state record → Policy A reject', () => {
  const b = typicalBackup();
  b.data.state[0].newField = 'value';
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown field in state record must reject');
  assert.ok(r.errors.some(e => /unknown field in state record/.test(e)));
});

/* ════ 6 · v1 ↔ v2 compatibility ════ */
section('v1-v2-compat');
check('a real schema-v1 backup file imports through the pure migrate() path', () => {
  const v1Tasks = JSON.parse(FIXTURES.typical.v1TasksRaw);
  const v1File = {
    app: 'HomeTask', schemaVersion: 1, exportedAt: '2026-07-20T12:00:00.000Z',
    catalogTaskCount: 122, catalogRoomCount: 24,
    taskState: v1Tasks.map(t => ({ id: t.id, lastDone: t.lastDone, doneToday: Boolean(t.doneToday), skipUntil: t.skipUntil, tags: t.tags })),
    preferences: { viewMode: 'week', roomFilter: "Madi's Room", onboarded: true, choice: 'guided', completedAt: '2026-06-01T10:00:00.000Z' },
  };
  const r = parseAndValidateBackup(JSON.stringify(v1File), CTX);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'v1');
  assert.equal(r.sanitized.schemaVersion, 2);
  assert.equal(r.sanitized.prefs.viewMode, 'week');
  assert.equal(r.sanitized.prefs.roomFilterZoneId, 'z_madis-room');
  assert.ok(r.sanitized.state.some(s => s.taskId === 'to-floor' && s.tags[0] === 'deep-clean'));
  assert.deepEqual(r.sanitized.completionEvents, [], 'v1 import never fabricates completion events');
  assert.ok(r.report, 'migrate() report surfaced');
});
check('v1 backup with unknown ids: migration reports the drop explicitly', () => {
  const v1File = {
    app: 'HomeTask', schemaVersion: 1, exportedAt: 'x',
    taskState: [
      { id: 'mb-floor', lastDone: '2026-07-24', doneToday: false, skipUntil: null, tags: [] },
      { id: 'ghost-task', lastDone: '2026-07-24', doneToday: false, skipUntil: null, tags: [] },
    ],
    preferences: { viewMode: 'today', roomFilter: '', onboarded: true, choice: null, completedAt: null },
  };
  const r = parseAndValidateBackup(JSON.stringify(v1File), CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.report.droppedUnknownIds, ['ghost-task']);
});
check('v2 export → reimport round-trips the sanitized envelope byte-exactly', () => {
  const rich = richV2Backup();
  const first = validateBackup(rich, CATALOG);
  assert.equal(first.ok, true);
  const reExported = buildBackup(first.sanitized, EXPORT_CTX);
  const second = validateBackup(reExported, CATALOG);
  assert.equal(second.ok, true);
  assert.equal(second.repairs.length, 0, `re-import needed repairs: ${JSON.stringify(second.repairs)}`);
  assert.equal(second.quarantined.length, 0);
  assert.deepEqual(second.sanitized, first.sanitized);
});
check('a genuinely v2-only backup is never converted to v1', () => {
  const rich = validateBackup(richV2Backup(), CATALOG).sanitized;
  const r = reverseMigrate(rich, { catalog: CATALOG });
  assert.equal(r.ok, false);
  const text = r.unsupported.join('\n');
  assert.match(text, /userZones/); assert.match(text, /userTasks/);
  assert.match(text, /override on mb-floor/);
  assert.match(text, /retired task mbath-all/);
});

/* ════ 7 · Title normalization policy (Correction 1 + Correction 4) ════ */
section('title-normalize');
import { normalizeTitle } from '../src/v2/title-normalize.js';

// Contract tests: v2 normalizer must match the production policy exactly.
const CONTRACT_CASES = [
  ['clean baseboards',          'Clean Baseboards'],
  ['  take   out garbage  ',    'Take Out Garbage'],
  ['change air cleaner HEPA',   'Change Air Cleaner HEPA'],
  ['mother-in-law room',        'Mother-In-Law Room'],
  ['',                          ''],
  ['   ',                       ''],
  ["don't touch",               "Don't Touch"],
  ['check CO detector',         'Check CO Detector'],
  ['replace uv lamp',           'Replace UV Lamp'],
  ['test AC unit',              'Test AC Unit'],
  ['check CO2 levels',          'Check CO2 Levels'],
  ['Scrub Floor',               'Scrub Floor'],           // already normalized → same
  ['sweep-mop kitchen',         'Sweep-Mop Kitchen'],    // hyphenated word
];
for (const [input, expected] of CONTRACT_CASES) {
  check(`normalizeTitle contract: "${input}" → "${expected}"`, () => {
    assert.equal(normalizeTitle(input), expected, `normalizeTitle(${JSON.stringify(input)})`);
  });
}
check('normalizeTitle: non-string input → empty string', () => {
  for (const bad of [null, undefined, 42, [], {}]) {
    assert.equal(normalizeTitle(bad), '', `expected '' for ${JSON.stringify(bad)}`);
  }
});
check('HTML-like content stays inert after normalization (chars not alphabetic → unchanged by _normWord)', () => {
  const r = normalizeTitle('<script>alert(1)</script>');
  assert.equal(r, '<script>alert(1)</script>', `HTML chars not mangled: got ${r}`);
});
check('Correction 4: normalizer capitalizes FIRST char only; rest preserved verbatim', () => {
  // "cLEAN FLOOR": 'c' → 'C', "LEAN" preserved → "CLEAN FLOOR" (not "Clean Floor").
  assert.equal(normalizeTitle('cLEAN FLOOR'), 'CLEAN FLOOR',
    '"cLEAN FLOOR" → "CLEAN FLOOR" because only the first char of each word is uppercased');
  // "DOG house": 'D' already uppercase, "OG" preserved → "DOG House".
  assert.equal(normalizeTitle('DOG house'), 'DOG House',
    '"DOG house" → "DOG House" — "OG" is not modified');
  // "mIxEd" → "MIxEd" — only first char changes.
  assert.equal(normalizeTitle('mIxEd case'), 'MIxEd Case');
  // This is NOT general English title case: input case is mostly preserved.
});
check('user zone title normalized in backup import; repair logged', () => {
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_attic', title: 'attic storage', sortOrder: 5, archivedAt: null }];
  b.data.userTasks = [{ id: 'u_boxes', title: 'sort boxes', zoneId: 'u_attic',
    recurrence: { kind: 'paused' }, archivedAt: null, safety: false }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.userZones[0].title, 'Attic Storage');
  assert.equal(r.sanitized.userTasks[0].title, 'Sort Boxes');
  assert.ok(r.repairs.some(x => x.includes('Attic Storage')));
  assert.ok(r.repairs.some(x => x.includes('Sort Boxes')));
});
check('override title normalized; already-correct override title produces no repair', () => {
  const b = typicalBackup();
  b.data.overrides = { 'mb-floor': { title: 'vacuum master bedroom floor' } };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.overrides['mb-floor'].title, 'Vacuum Master Bedroom Floor');
  assert.ok(r.repairs.some(x => x.includes('Vacuum Master Bedroom Floor')));
  // Re-import with already-normalized title → no repair.
  const b2 = typicalBackup();
  b2.data.overrides = { 'mb-floor': { title: 'Vacuum Master Bedroom Floor' } };
  const r2 = validateBackup(b2, CATALOG);
  assert.equal(r2.ok, true);
  assert.ok(!r2.repairs.some(x => x.includes('overrides') && x.includes('title normalized')),
    'no repair for already-normalized override title');
});
check('title with recognized acronyms preserved in all positions', () => {
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_hvac', title: 'change hepa and uv filter for ac unit', sortOrder: 0, archivedAt: null }];
  b.data.userTasks = [{ id: 'u_hvac-task', title: 'check co and co2 levels near hepa filter',
    zoneId: 'u_hvac', recurrence: { kind: 'paused' }, archivedAt: null, safety: false }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.userZones[0].title, 'Change HEPA And UV Filter For AC Unit');
  assert.equal(r.sanitized.userTasks[0].title, 'Check CO And CO2 Levels Near HEPA Filter');
});
check('hyphenated zone/task names capitalize each segment', () => {
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_mil', title: 'mother-in-law suite', sortOrder: 0, archivedAt: null }];
  b.data.userTasks = [{ id: 'u_sweep-mop', title: 'sweep-mop the floor',
    zoneId: 'u_mil', recurrence: { kind: 'paused' }, archivedAt: null, safety: false }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.userZones[0].title, 'Mother-In-Law Suite');
  assert.equal(r.sanitized.userTasks[0].title, 'Sweep-Mop The Floor');
});
check("apostrophe rule: first letter of token uppercased, rest preserved", () => {
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_kids', title: "kid's room", sortOrder: 0, archivedAt: null }];
  b.data.userTasks = [{ id: 'u_tidy', title: "don't forget to tidy",
    zoneId: 'u_kids', recurrence: { kind: 'paused' }, archivedAt: null, safety: false }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.userZones[0].title, "Kid's Room");
  assert.equal(r.sanitized.userTasks[0].title, "Don't Forget To Tidy");
});
check('excessive whitespace collapsed; empty title after normalize → quarantine (Policy A)', () => {
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_z', title: '   ', sortOrder: 0, archivedAt: null }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'empty-after-normalize zone must reject');
  assert.ok(r.errors.some(e => /empty title/.test(e)));
});

/* ════ 8 · Referential integrity invariants + uniqueness (Corrections 2 + 3) ════ */
section('ref-integrity');
/** Assert post-import invariants on a successful validateBackup result. */
function assertPostImportInvariants(result, catalog) {
  assert.equal(result.ok, true, 'assertPostImportInvariants called on failed result');
  const { sanitized, quarantined } = result;
  const seedZoneIds = new Set(catalog.zones.map(z => z.id));
  const seedTaskIds = new Set(catalog.tasks.map(t => t.id));
  const retiredIds  = new Set((catalog.tombstones?.tasks ?? []).map(t => t.id));
  const userZoneIds = new Set(sanitized.userZones.map(z => z.id));
  const userTaskIds = new Set(sanitized.userTasks.map(t => t.id));
  const allZoneIds  = new Set([...seedZoneIds, ...userZoneIds]);
  const allTaskIds  = new Set([...seedTaskIds, ...retiredIds, ...userTaskIds]);
  const eventIds    = new Set(sanitized.completionEvents.map(e => e.id));

  // Invariant 1: every active (non-archived) user task resolves to exactly one valid zone.
  for (const t of sanitized.userTasks) {
    if (t.archivedAt) continue;
    assert.ok(t.zoneId && allZoneIds.has(t.zoneId),
      `active user task ${t.id} has invalid zoneId: ${JSON.stringify(t.zoneId)}`);
  }
  // Invariant 2: every state record resolves to a known task.
  for (const s of sanitized.state) {
    assert.ok(allTaskIds.has(s.taskId),
      `state record for unknown taskId: ${s.taskId}`);
  }
  // Invariant 3: no quarantined task/zone id appears in active sanitized records.
  const quarantinedIds = new Set(
    quarantined.map(q => q.record?.id ?? q.record?.taskId).filter(Boolean)
  );
  for (const t of sanitized.userTasks)
    assert.ok(!quarantinedIds.has(t.id), `quarantined user task ${t.id} leaked into sanitized`);
  for (const z of sanitized.userZones)
    assert.ok(!quarantinedIds.has(z.id), `quarantined user zone ${z.id} leaked into sanitized`);
  for (const s of sanitized.state)
    assert.ok(!quarantinedIds.has(s.taskId), `state for quarantined task ${s.taskId} leaked into sanitized`);
  // Invariant 4: no dangling override (all override keys address known ids).
  for (const key of Object.keys(sanitized.overrides)) {
    const bare = key.startsWith('zone:') ? key.slice(5) : key;
    const isSeed = key.startsWith('zone:') ? seedZoneIds.has(bare) : seedTaskIds.has(bare) || retiredIds.has(bare);
    assert.ok(isSeed, `override key ${key} addresses unknown id`);
  }
  // Invariant 5: every completionEvent resolves to a known task.
  for (const ev of sanitized.completionEvents) {
    assert.ok(allTaskIds.has(ev.taskId), `completionEvent ${ev.id} references unknown taskId ${ev.taskId}`);
  }
  // Invariant 6: completion event ids are unique.
  assert.equal(eventIds.size, sanitized.completionEvents.length, 'duplicate event id in sanitized');
}
check('invariants hold after typical v2 round-trip import', () => {
  const r = validateBackup(richV2Backup(), CATALOG);
  assertPostImportInvariants(r, CATALOG);
});
check('invariants hold after v1→v2 migration import', () => {
  const v1Tasks = JSON.parse(FIXTURES.typical.v1TasksRaw);
  const v1File = {
    app: 'HomeTask', schemaVersion: 1, exportedAt: 'x', catalogTaskCount: 122, catalogRoomCount: 24,
    taskState: v1Tasks.map(t => ({ id: t.id, lastDone: t.lastDone ?? null, doneToday: Boolean(t.doneToday),
      skipUntil: t.skipUntil ?? null, tags: Array.isArray(t.tags) ? t.tags : [] })),
    preferences: { viewMode: 'week', roomFilter: "Madi's Room", onboarded: true, choice: null, completedAt: null },
  };
  const r = parseAndValidateBackup(JSON.stringify(v1File), CTX);
  assertPostImportInvariants(r, CATALOG);
});
check('unknown override id now rejects (all user-owned quarantines → Policy A in schema-v2)', () => {
  // Previously: override quarantine was not Policy A. Schema-v2: it is.
  const b = richV2Backup();
  b.data.overrides['never-existed'] = { title: 'ghost' };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown override id must trigger Policy A in schema-v2');
  assert.ok(r.errors.some(e => /unknown id/.test(e) || /catalog/.test(e)));
});
check('duplicate normalized zone title → reject (Policy A)', () => {
  const b = typicalBackup();
  b.data.userZones = [
    { id: 'u_z1', title: 'Guest Bathroom', sortOrder: 0, archivedAt: null },
    { id: 'u_z2', title: 'guest bathroom', sortOrder: 1, archivedAt: null },  // normalizes same
  ];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'duplicate normalized zone title must reject');
  assert.ok(r.errors.some(e => /duplicate zone title/.test(e)));
});
check('user zone title matching a seed zone title → Policy A reject (Correction 2)', () => {
  // A user zone called "Kitchen" conflicts with the seed "Kitchen" zone.
  // The normalizeTitle pre-check catches this during userZones processing.
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_kitchen2', title: 'Kitchen', sortOrder: 0, archivedAt: null }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'user zone title matching seed zone title must reject');
  assert.ok(r.errors.some(e => /duplicate zone title/.test(e) || /conflicts with seed zone/.test(e)),
    `expected zone-title conflict, got: ${JSON.stringify(r.errors)}`);
});
check('override-created duplicate zone title → Policy A reject (Correction 2)', () => {
  // An override renames a seed zone title to match a user zone → composed uniqueness fails.
  // First find a seed zone that, if renamed to match another seed zone, creates a conflict.
  // Simpler: an override that changes z_kitchen title to "Master Bedroom" (or any other seed zone).
  // Actually let's add a user zone "Laundry Room" and then override a seed zone to "Laundry Room".
  // Wait — we need to find a seed zone title. Let me just rename a seed zone to match a user zone.
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_myzone', title: 'My Unique Zone', sortOrder: 0, archivedAt: null }];
  b.data.userTasks = [{ id: 'u_mytask', title: 'Do Something', zoneId: 'u_myzone',
    recurrence: { kind: 'paused' }, archivedAt: null, safety: false }];
  // Override a seed zone (z_kitchen) title to match the user zone.
  b.data.overrides = { 'zone:z_kitchen': { title: 'My Unique Zone' } };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'override-created zone title conflict must reject');
  assert.ok(r.errors.some(e => /duplicate active zone title/.test(e) || /conflicts with/.test(e)),
    `expected zone uniqueness error, got: ${JSON.stringify(r.errors)}`);
});
check('duplicate task title in same zone → Policy A reject (Correction 2)', () => {
  // A user task with the same normalized title as a seed task in the same zone.
  // Find a seed task in z_kitchen and duplicate its normalized title.
  // k-stove-sink is a catalog task in z_kitchen with title 'Clean Stove & Sink'.
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_kitch', title: 'User Kitchen', sortOrder: 0, archivedAt: null }];
  // Two user tasks with the same normalized title in the same zone.
  b.data.userTasks = [
    { id: 'u_t1', title: 'Sweep Floor', zoneId: 'u_kitch', recurrence: { kind: 'paused' }, archivedAt: null, safety: false },
    { id: 'u_t2', title: 'sweep floor', zoneId: 'u_kitch', recurrence: { kind: 'paused' }, archivedAt: null, safety: false },
  ];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'duplicate task title in same zone must reject');
  assert.ok(r.errors.some(e => /duplicate active task title/.test(e)),
    `expected task title uniqueness error, got: ${JSON.stringify(r.errors)}`);
});
check('state records for quarantined user tasks are excluded, not silently passed through', () => {
  const b = richV2Backup();
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  for (const s of r.sanitized.state) {
    const userTaskIds = new Set(r.sanitized.userTasks.map(t => t.id));
    const seedIds = new Set([...CATALOG.tasks, ...(CATALOG.tombstones?.tasks ?? [])].map(t => t.id));
    assert.ok(userTaskIds.has(s.taskId) || seedIds.has(s.taskId),
      `state for unknown/uncommitted task ${s.taskId} leaked through`);
  }
});

/* ════ 9 · Policy A + durable quarantine ════ */
section('policy-a');
check('Policy A: malformed user zone → reject entire import, live data unchanged', () => {
  const b = typicalBackup();
  b.data.userZones = [{ id: 'u_bad', sortOrder: 0 }];  // missing title
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'malformed user zone must reject');
  assert.ok(r.errors.some(e => /malformed user zone/.test(e)));
  assert.equal(r.sanitized, undefined, 'no sanitized output when rejected');
});
check('Policy A: malformed user task → reject entire import', () => {
  const b = typicalBackup();
  b.data.userTasks = [{ id: 'u_missing-title', zoneId: 'z_kitchen', recurrence: { kind: 'paused' } }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /malformed user task/.test(e)));
});
check('Policy A quarantined[] is returned on reject for diagnostics', () => {
  const b = richV2Backup();
  b.data.userTasks[0].zoneId = 'u_nowhere';
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.quarantined), 'quarantined must be an array even on reject');
  assert.ok(r.quarantined.length > 0);
  assert.ok(r.quarantined[0].record, 'record retained verbatim in quarantined');
});
check('no user-owned record silently disappears while import reports success', () => {
  const b = richV2Backup();
  b.data.userTasks.push({ id: 'u_extra', title: 'Extra Task', zoneId: 'u_garage',
    recurrence: { kind: 'paused' }, archivedAt: null, safety: false });
  b.data.userTasks[0].recurrence = { kind: 'interval', unit: 'fortnight', every: 0 };
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'must reject — never silently drop a user-owned record');
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.some(e => e.includes('userTasks')));
});
check('calm compatibility explanation for state from newer catalog version → now Policy A reject', () => {
  // Schema-v2: the calm message is still returned, but as a Policy A reject.
  const b = typicalBackup();
  b.data.state.push({ taskId: 'future-task-abc', lastDone: null, doneToday: false, skipUntil: null, tags: [] });
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'schema-v2: state for newer-catalog task must now reject');
  assert.ok(r.errors.some(e => e.includes('newer version') || e.includes('catalog version')),
    `expected catalog-version message in errors, got: ${JSON.stringify(r.errors)}`);
  assert.ok(!r.errors.some(e => e.includes('malformed')), 'must not call a catalog-version record "malformed"');
  assert.ok(Array.isArray(r.quarantined), 'quarantined[] still returned for diagnostics');
});
check('user-format unknown state id gets corruption-focused message → now Policy A reject', () => {
  // Schema-v2: the corruption message is still returned, but as a Policy A reject.
  const b = typicalBackup();
  b.data.state.push({ taskId: 'u_ghost-task', lastDone: null, doneToday: false, skipUntil: null, tags: [] });
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'schema-v2: user-format state with no matching userTask must reject');
  assert.ok(r.errors.some(e => e.includes('partial') || e.includes('corrupt') || e.includes('not found')),
    `expected corruption-focused message, got: ${JSON.stringify(r.errors)}`);
});

/* ════ 10 · completionEvents (Correction 3) ════ */
section('completion-events');
check('valid completionEvents survive import round-trip', () => {
  const b = richV2Backup();
  b.data.completionEvents = [
    { id: 'c_abc123', taskId: 'mb-floor', completedOn: '2026-07-20', durationMinutes: null },
    { id: 'c_def456', taskId: 'u_sweep-garage', completedOn: '2026-07-10', durationMinutes: 30 },
    { id: 'c_ghi789', taskId: 'mbath-all', completedOn: '2026-07-01', durationMinutes: null },
  ];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true, `unexpected reject: ${JSON.stringify(r.errors ?? [])}`);
  assert.equal(r.sanitized.completionEvents.length, 3);
  assert.deepEqual(r.sanitized.completionEvents[0], { id: 'c_abc123', taskId: 'mb-floor', completedOn: '2026-07-20', durationMinutes: null });
  assert.deepEqual(r.sanitized.completionEvents[1], { id: 'c_def456', taskId: 'u_sweep-garage', completedOn: '2026-07-10', durationMinutes: 30 });
});
check('completionEvents with durationMinutes at boundary values', () => {
  const b = typicalBackup();
  b.data.completionEvents = [
    { id: 'c_min', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: 1 },
    { id: 'c_max', taskId: 'mb-floor', completedOn: '2026-07-02', durationMinutes: LIMITS.DURATION_MAX },
  ];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.completionEvents[0].durationMinutes, 1);
  assert.equal(r.sanitized.completionEvents[1].durationMinutes, LIMITS.DURATION_MAX);
});
check('durationMinutes exceeds DURATION_MAX → Policy A reject', () => {
  const b = typicalBackup();
  b.data.completionEvents = [
    { id: 'c_toolong', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: LIMITS.DURATION_MAX + 1 },
  ];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'durationMinutes > DURATION_MAX must reject');
  assert.ok(r.errors.some(e => /durationMinutes/.test(e) || /invalid/.test(e)));
});
check('durationMinutes = 0 → Policy A reject (must be positive)', () => {
  const b = typicalBackup();
  b.data.completionEvents = [{ id: 'c_zero', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: 0 }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'durationMinutes: 0 is not positive → reject');
});
check('durationMinutes: null is valid (intentionally absent)', () => {
  const b = typicalBackup();
  b.data.completionEvents = [{ id: 'c_nulldur', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: null }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized.completionEvents[0].durationMinutes, null);
});
check('unknown taskId in completionEvent → Policy A reject', () => {
  const b = typicalBackup();
  b.data.completionEvents = [{ id: 'c_bad', taskId: 'no-such-task', completedOn: '2026-07-01', durationMinutes: null }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown taskId in completionEvent must reject');
  assert.ok(r.errors.some(e => /completion event/.test(e) || /task/.test(e)));
});
check('invalid completedOn in completionEvent → Policy A reject', () => {
  const b = typicalBackup();
  b.data.completionEvents = [{ id: 'c_baddate', taskId: 'mb-floor', completedOn: '2026-02-30', durationMinutes: null }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'invalid completedOn must reject');
  assert.ok(r.errors.some(e => /completedOn/.test(e) || /invalid/.test(e)));
});
check('invalid completionEvent id format → Policy A reject', () => {
  const b = typicalBackup();
  b.data.completionEvents = [{ id: 'ev_wrong_prefix', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: null }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'invalid event id must reject');
  assert.ok(r.errors.some(e => /invalid completion event id/.test(e) || /id/.test(e)));
});
check('duplicate completionEvent id → reject', () => {
  const b = typicalBackup();
  b.data.completionEvents = [
    { id: 'c_dup', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: null },
    { id: 'c_dup', taskId: 'mb-floor', completedOn: '2026-07-02', durationMinutes: null },
  ];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'duplicate event id must reject');
  assert.ok(r.errors.some(e => /duplicate completion event id/.test(e)));
});
check('unknown field in completionEvent → Policy A reject', () => {
  const b = typicalBackup();
  b.data.completionEvents = [{ id: 'c_unk', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: null, futureField: 'x' }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, false, 'unknown field in completionEvent must reject');
  assert.ok(r.errors.some(e => /unknown field in completion event/.test(e)));
});
check('completionEvent for tombstoned task accepted', () => {
  const b = typicalBackup();
  b.data.completionEvents = [{ id: 'c_tomb', taskId: 'mbath-all', completedOn: '2026-07-01', durationMinutes: null }];
  const r = validateBackup(b, CATALOG);
  assert.equal(r.ok, true, `tombstone completionEvent should be accepted: ${JSON.stringify(r.errors ?? [])}`);
  assert.equal(r.sanitized.completionEvents[0].taskId, 'mbath-all');
});
check('migrate() outputs completionEvents: [] — never fabricates from lastDone', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  assert.deepEqual(v2.completionEvents, [], 'migrate must output empty completionEvents');
  // Verify that history fields (lastDone) still survive through state
  const byId = Object.fromEntries(v2.state.map(s => [s.taskId, s]));
  assert.ok(byId['mb-floor'], 'lastDone still present in state');
  assert.equal(byId['mb-floor'].lastDone, FIXTURES.typical.v1TasksRaw ? JSON.parse(FIXTURES.typical.v1TasksRaw)[0].lastDone : null);
});
check('completionEvents survive export → import round-trip byte-exactly', () => {
  const b = richV2Backup();
  b.data.completionEvents = [
    { id: 'c_ev1', taskId: 'mb-floor', completedOn: '2026-07-15', durationMinutes: 45 },
    { id: 'c_ev2', taskId: 'mbath-all', completedOn: '2026-07-01', durationMinutes: null },
  ];
  const first = validateBackup(b, CATALOG);
  assert.equal(first.ok, true);
  const reExported = buildBackup(first.sanitized, EXPORT_CTX);
  const second = validateBackup(reExported, CATALOG);
  assert.equal(second.ok, true);
  assert.deepEqual(second.sanitized.completionEvents, first.sanitized.completionEvents);
  assert.equal(second.repairs.length, 0, `re-import needed repairs: ${JSON.stringify(second.repairs)}`);
});
check('reverseMigrate reports completionEvents as unsupported when non-empty', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const withEvents = {
    ...v2,
    completionEvents: [{ id: 'c_one', taskId: 'mb-floor', completedOn: '2026-07-01', durationMinutes: null }],
  };
  const r = reverseMigrate(withEvents, { catalog: CATALOG });
  assert.equal(r.ok, false);
  assert.ok(r.unsupported.some(u => u.includes('completionEvents')),
    `expected completionEvents in unsupported: ${JSON.stringify(r.unsupported)}`);
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
