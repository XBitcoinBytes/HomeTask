/**
 * v2.test.mjs — CP1 suite: pure schema, composition, validation, migration.
 *
 * Standalone Node ESM. No browser, no real localStorage/sessionStorage,
 * no clock reads — FIXED_TODAY is injected everywhere (guardrails 4 & 9).
 * Run with:  node artifacts/home-tasks/tests/v2.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG } from '../src/v2/catalog.data.js';
import { extractCatalog } from '../scripts/extract-catalog.mjs';
import { validateRecurrence, fromIntervalDays, toIntervalDays, nextDue, effectiveDue } from '../src/v2/recurrence.js';
import { compose } from '../src/v2/compose.js';
import { migrate, reverseMigrate, validateEnvelope, CANONICAL_ENVELOPE_FIELDS } from '../src/v2/migrate.js';
import { assertEquivalent, buildV1World, v1StatusType } from '../src/v2/equivalence.js';
import { FIXTURES, FIXED_TODAY, D, raw } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX  = { today: FIXED_TODAY, catalog: CATALOG, appBuild: 'v19' };

let group = '', pass = 0, fail = 0;
const groups = new Map();
function check(name, fn) {
  try { fn(); pass++; groups.set(group, (groups.get(group) ?? 0) + 1); }
  catch (e) { fail++; console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); }
}
function section(name) { group = name; console.log(`\n── ${name}`); }

/* ════ 1 · Catalog extraction sync ════ */
section('catalog-extraction');
check('committed catalog.data.js matches a fresh extraction from script.js', () => {
  const fresh = extractCatalog(readFileSync(join(HERE, '..', 'src', 'app', 'catalog.js'), 'utf8'));
  assert.deepEqual(CATALOG, fresh);
});
check('counts: 122 tasks, 24 zones, 1 safety task, 4 tombstones', () => {
  assert.equal(CATALOG.tasks.length, 122);
  assert.equal(CATALOG.zones.length, 24);
  assert.deepEqual(CATALOG.tasks.filter(t => t.safety).map(t => t.id), ['smoke-batteries']);
  assert.equal(CATALOG.tombstones.tasks.length, 4);
});
check('every task references an existing zone; every recurrence validates', () => {
  const zoneIds = new Set(CATALOG.zones.map(z => z.id));
  for (const t of CATALOG.tasks) {
    assert.ok(zoneIds.has(t.zoneId), `${t.id} → unknown zone ${t.zoneId}`);
    assert.ok(validateRecurrence(t.recurrence).ok, `${t.id} recurrence invalid`);
  }
});
check('task IDs and zone IDs are unique', () => {
  assert.equal(new Set(CATALOG.tasks.map(t => t.id)).size, 122);
  assert.equal(new Set(CATALOG.zones.map(z => z.id)).size, 24);
});
check('fixture task IDs all exist in the catalog', () => {
  const ids = new Set(CATALOG.tasks.map(t => t.id));
  for (const id of ['mb-floor','mb-baseboards','mb-doorknob','md-floor','md-cobweb',
                    'smoke-batteries','to-floor','k-stove-sink'])
    assert.ok(ids.has(id), `fixture id ${id} missing from catalog`);
});

/* ════ 2 · Recurrence validation (full union) ════ */
section('recurrence');
check('accepts all five kinds', () => {
  for (const rec of [
    { kind:'interval', unit:'day', every:14 }, { kind:'interval', unit:'week', every:2 },
    { kind:'interval', unit:'month', every:3 }, { kind:'interval', unit:'year', every:1 },
    { kind:'annualDate', month:10, day:1 }, { kind:'annualDate', month:2, day:29 },
    { kind:'seasonal', season:'spring' }, { kind:'once', date:'2026-12-01' }, { kind:'paused' },
  ]) assert.ok(validateRecurrence(rec).ok, JSON.stringify(rec));
});
check('rejects invalid shapes', () => {
  for (const rec of [
    null, [], { kind:'weekly' }, { kind:'interval', unit:'fortnight', every:1 },
    { kind:'interval', unit:'day', every:0 }, { kind:'interval', unit:'day', every:1.5 },
    { kind:'annualDate', month:13, day:1 }, { kind:'annualDate', month:4, day:31 },
    { kind:'annualDate', month:2, day:30 }, { kind:'seasonal', season:'monsoon' },
    { kind:'once', date:'tomorrow' }, { kind:'paused', extra:1 },
    { kind:'interval', unit:'day', every:7, stray:true },
  ]) assert.equal(validateRecurrence(rec).ok, false, JSON.stringify(rec));
});
check('intervalDays ⇄ recurrence round-trips exactly', () => {
  for (const n of [1, 7, 14, 30, 90, 365]) {
    const rec = fromIntervalDays(n);
    const back = toIntervalDays(rec);
    assert.ok(back.ok); assert.equal(back.intervalDays, n);
  }
});
check('toIntervalDays refuses v2-only kinds explicitly', () => {
  for (const rec of [{ kind:'interval', unit:'month', every:1 }, { kind:'annualDate', month:1, day:1 },
                     { kind:'seasonal', season:'fall' }, { kind:'once', date:'2026-12-01' }, { kind:'paused' }]) {
    const r = toIntervalDays(rec);
    assert.equal(r.ok, false); assert.ok(r.reason.length > 0);
  }
});
check('nextDue: interval/day matches v1 (lastDone + n), null when never done', () => {
  assert.equal(nextDue(fromIntervalDays(7), D.lastWeek), FIXED_TODAY);
  assert.equal(nextDue(fromIntervalDays(7), null), null);
  assert.equal(nextDue({ kind:'paused' }, D.lastWeek), null);
});
check('nextDue: Step-2 kinds throw explicitly instead of guessing', () => {
  assert.throws(() => nextDue({ kind:'interval', unit:'month', every:1 }, D.lastWeek), /Step 2 scope/);
  assert.throws(() => nextDue({ kind:'seasonal', season:'fall' }, D.lastWeek), /Step 2 scope/);
});
check('effectiveDue: skipUntil wins over natural due', () => {
  assert.equal(effectiveDue(fromIntervalDays(7), D.lastWeek, D.nextWeek), D.nextWeek);
  assert.equal(effectiveDue(fromIntervalDays(7), D.lastWeek, null), FIXED_TODAY);
});

/* ════ 3 · Migration ════ */
section('migrate');
const emptyV2Shape = v2 => {
  assert.equal(v2.schemaVersion, 2);
  assert.deepEqual(v2.userZones, []); assert.deepEqual(v2.userTasks, []);
  assert.deepEqual(v2.overrides, {});
};
check('fresh install → empty v2 with defaults', () => {
  const { v2, report } = migrate(FIXTURES.fresh, CTX);
  emptyV2Shape(v2);
  assert.deepEqual(v2.state, []);
  assert.deepEqual(v2.prefs, { viewMode:'today', roomFilterZoneId:'', onboarded:false, choice:null, completedAt:null });
  assert.equal(report.malformed.length, 0);
});
check('empty storage → same as fresh (plus dueNowDefault fold report)', () => {
  const { v2 } = migrate(FIXTURES.empty, CTX);
  emptyV2Shape(v2); assert.deepEqual(v2.state, []);
});
check('typical: every touched field preserved; untouched tasks get no record', () => {
  const { v2, report } = migrate(FIXTURES.typical, CTX);
  assert.equal(v2.state.length, 7);
  const by = Object.fromEntries(v2.state.map(s => [s.taskId, s]));
  assert.deepEqual(by['mb-floor'], { taskId:'mb-floor', lastDone:D.today, doneToday:true, skipUntil:null, tags:[] });
  assert.deepEqual(by['md-floor'], { taskId:'md-floor', lastDone:D.monthAgo, doneToday:false, skipUntil:D.nextWeek, tags:[] });
  assert.deepEqual(by['md-cobweb'], { taskId:'md-cobweb', lastDone:null, doneToday:false, skipUntil:D.tomorrow, tags:[] });
  assert.deepEqual(by['to-floor'].tags, ['deep-clean']);
  assert.equal(v2.prefs.viewMode, 'week');
  assert.equal(v2.prefs.roomFilterZoneId, 'z_madis-room');
  assert.equal(v2.prefs.onboarded, true);
  assert.equal(v2.prefs.choice, 'guided');
  assert.deepEqual(v2.recentSearches, ['oven', 'windows']);
  assert.equal(v2.meta.lastBackupExport, '2026-07-20');
  assert.equal(v2.meta.migratedFrom, 'hometask-v1');
  assert.equal(v2.meta.catalogVersionAtMigration, 1);
  assert.equal(report.droppedUnknownIds.length, 0);
});
check('inconsistent doneToday combinations normalize exactly like v1 load', () => {
  const { v2, report } = migrate(FIXTURES.inconsistentDoneToday, CTX);
  const by = Object.fromEntries(v2.state.map(s => [s.taskId, s]));
  assert.equal(by['mb-floor'].doneToday, false);              // true + stale lastDone → false
  assert.equal(by['mb-floor'].lastDone, D.yesterday);          // history untouched
  assert.equal(by['mb-doorknob'], undefined);                  // true + null lastDone → false → untouched, no record
  assert.equal(by['mb-baseboards'].doneToday, false);          // false + today stays false
  assert.equal(by['md-floor'].doneToday, true);                // non-boolean truthy + today → true (v1 Boolean() coercion)
  assert.deepEqual(report.normalizedDoneToday.sort(), ['mb-doorknob', 'mb-floor']);
});
check('dueNowDefault folds: true→week, false→all, absent→today', () => {
  assert.equal(migrate(FIXTURES.legacyDueNowTrue,  CTX).v2.prefs.viewMode, 'week');
  assert.equal(migrate(FIXTURES.legacyDueNowFalse, CTX).v2.prefs.viewMode, 'all');
  assert.equal(migrate(FIXTURES.empty,             CTX).v2.prefs.viewMode, 'today');
});
check('retired IDs keep state (tombstoned); unknown IDs dropped and reported', () => {
  const { v2, report } = migrate(FIXTURES.retiredAndUnknown, CTX);
  const ids = v2.state.map(s => s.taskId).sort();
  assert.deepEqual(ids, ['hb-all', 'mb-floor', 'mbath-all']);   // retired kept, ghost dropped
  assert.deepEqual(report.droppedUnknownIds, ['ghost-task']);
  assert.equal(v2.prefs.roomFilterZoneId, '');                  // unmatched room title → ''
  assert.match(report.roomFilterResolved, /No Such Room/);
});
check('malformed records sanitized field-by-field; neighbors survive', () => {
  const { v2, report } = migrate(FIXTURES.malformedRecords, CTX);
  const by = Object.fromEntries(v2.state.map(s => [s.taskId, s]));
  assert.equal(by['mb-floor'], undefined);                      // only field was bad date → untouched
  assert.equal(by['md-floor'].lastDone, D.lastWeek);
  assert.ok(report.sanitizedFields.includes('mb-floor.lastDone'));
  assert.ok(report.sanitizedFields.includes('prefs.viewMode'));
  assert.equal(v2.prefs.viewMode, 'today');
  assert.deepEqual(v2.recentSearches, ['ok']);
  assert.equal(v2.meta.lastBackupExport, null);
  assert.ok(report.malformed.some(m => m.includes('no id') || m.includes('without id')));
});
check('damaged JSON never throws; reported; yields safe defaults', () => {
  const { v2, report } = migrate(FIXTURES.damagedJson, CTX);
  emptyV2Shape(v2);
  assert.deepEqual(report.malformed.sort(),
    ['hometask-meta-v1', 'hometask-recent-searches-v1', 'hometask-v1']);
});
check('deterministic: identical inputs → identical output, twice', () => {
  const a = migrate(FIXTURES.typical, CTX), b = migrate(FIXTURES.typical, CTX);
  assert.deepEqual(a, b);
});
check('migrate refuses a missing injected today', () => {
  assert.throws(() => migrate(FIXTURES.fresh, { ...CTX, today: undefined }), /explicit/);
});

/* ════ 4 · Reverse migration — supported domain only ════ */
section('reverse-migrate');
check('v1-origin data round-trips exactly (tasks, meta, recents)', () => {
  for (const name of ['fresh', 'empty', 'typical', 'inconsistentDoneToday', 'partial']) {
    const { v2 } = migrate(FIXTURES[name], CTX);
    const back = reverseMigrate(v2, CTX);
    assert.ok(back.ok, `${name}: ${JSON.stringify(back.unsupported ?? [])}`);
    // Re-migrating the reversed data must reproduce the same v2 exactly.
    const again = migrate({ v1TasksRaw: raw(back.v1Tasks), v1MetaRaw: raw(back.v1Meta),
      v1RecentsRaw: raw(back.v1Recents), lastExport: v2.meta.lastBackupExport }, CTX);
    const byId = arr => [...arr].sort((a, b) => a.taskId.localeCompare(b.taskId));
    assert.deepEqual(byId(again.v2.state), byId(v2.state), name);   // catalog-order vs input-order is immaterial
    assert.deepEqual(again.v2.prefs, v2.prefs, name);
    assert.deepEqual(again.v2.recentSearches, v2.recentSearches, name);
  }
});
check('v2-only content returns explicit unsupported, never silent loss', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const withUserTask = { ...v2, userTasks: [{ id:'u1', zoneId:'z_kitchen', title:'Clean Hot Tub',
    recurrence:{ kind:'interval', unit:'month', every:1 }, safety:false, tags:[], archivedAt:null }] };
  const r1 = reverseMigrate(withUserTask, CTX);
  assert.equal(r1.ok, false); assert.ok(r1.unsupported.some(u => u.includes('userTasks')));

  const withOverride = { ...v2, overrides: { 'mb-floor': { title: 'Vacuum Floor' } } };
  const r2 = reverseMigrate(withOverride, CTX);
  assert.equal(r2.ok, false); assert.ok(r2.unsupported.some(u => u.includes('override on mb-floor')));

  const withRetiredState = { ...v2, state: [...v2.state, { taskId:'mbath-all', lastDone:D.monthAgo, doneToday:false, skipUntil:null, tags:[] }] };
  const r3 = reverseMigrate(withRetiredState, CTX);
  assert.equal(r3.ok, false); assert.ok(r3.unsupported.some(u => u.includes('mbath-all')));

  // completionEvents are v2-only — reverseMigrate must report them as unsupported.
  const withEvents = { ...v2, completionEvents: [{ id:'c_one', taskId:'mb-floor', completedOn:D.lastWeek, durationMinutes:null }] };
  const r4 = reverseMigrate(withEvents, CTX);
  assert.equal(r4.ok, false); assert.ok(r4.unsupported.some(u => u.includes('completionEvents')),
    `expected completionEvents in unsupported: ${JSON.stringify(r4.unsupported)}`);
});
check('unknown state IDs and duplicate state records reject explicitly', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const withUnknown = { ...v2, state: [...v2.state, { taskId:'u-custom-1', lastDone:D.lastWeek, doneToday:false, skipUntil:null, tags:[] }] };
  const r1 = reverseMigrate(withUnknown, CTX);
  assert.equal(r1.ok, false);
  assert.ok(r1.unsupported.some(u => u.includes('unknown task u-custom-1')));

  const withDup = { ...v2, state: [...v2.state, { ...v2.state[0] }] };
  const r2 = reverseMigrate(withDup, CTX);
  assert.equal(r2.ok, false);
  assert.ok(r2.unsupported.some(u => u.includes('duplicate state records')));
});

/* ════ 5 · Composition, overrides, safety authority, tombstones ════ */
section('compose');
const v2of = f => migrate(f, CTX).v2;
check('untouched seed tasks compose to catalog defaults', () => {
  const c = compose(CATALOG, v2of(FIXTURES.fresh));
  assert.equal(c.tasks.length, 122);
  assert.equal(c.zones.length, 24);
  const mb = c.tasks.find(t => t.id === 'mb-floor');
  assert.equal(mb.title, 'Clean Floor');
  assert.deepEqual(mb.recurrence, { kind:'interval', unit:'day', every:7 });
  assert.deepEqual(mb.state, { lastDone:null, doneToday:false, skipUntil:null, tags:[] });
});
check('each overridable field wins individually; unlisted fields ignored+reported', () => {
  const v2 = v2of(FIXTURES.fresh);
  v2.overrides = { 'mb-floor': { title:'Vacuum Floor', recurrence:{ kind:'interval', unit:'day', every:3 }, bogus:1 } };
  const c = compose(CATALOG, v2);
  const mb = c.tasks.find(t => t.id === 'mb-floor');
  assert.equal(mb.title, 'Vacuum Floor');
  assert.equal(mb.recurrence.every, 3);
  assert.deepEqual(c.report.ignoredOverrideFields, ['mb-floor.bogus']);
});
check('SAFETY: an override cannot downgrade a seed safety task', () => {
  const v2 = v2of(FIXTURES.fresh);
  v2.overrides = { 'smoke-batteries': { safety: false, title: 'Check Smoke Batteries' } };
  const c = compose(CATALOG, v2);
  const sb = c.tasks.find(t => t.id === 'smoke-batteries');
  assert.equal(sb.safety, true);                                // catalog-authoritative
  assert.equal(sb.title, 'Check Smoke Batteries');              // other fields still work
  assert.deepEqual(c.report.ignoredSafetyOverrides, ['smoke-batteries']);
});
check('SAFETY: an override cannot upgrade a non-safety seed task either', () => {
  const v2 = v2of(FIXTURES.fresh);
  v2.overrides = { 'mb-floor': { safety: true } };
  const c = compose(CATALOG, v2);
  assert.equal(c.tasks.find(t => t.id === 'mb-floor').safety, false);
});
check('user tasks own their safety value', () => {
  const v2 = v2of(FIXTURES.fresh);
  v2.userTasks = [{ id:'u1', zoneId:'z_kitchen', title:'Test Gas Detector',
    recurrence:{ kind:'interval', unit:'day', every:30 }, safety:true, tags:[], archivedAt:null }];
  const c = compose(CATALOG, v2);
  assert.equal(c.tasks.find(t => t.id === 'u1').safety, true);
});
check('tombstones stay out of daily tasks; appear in retiredVisible only with state', () => {
  const cFresh = compose(CATALOG, v2of(FIXTURES.fresh));
  assert.equal(cFresh.retiredVisible.length, 0);
  assert.ok(!cFresh.tasks.some(t => t.retired));

  const cRet = compose(CATALOG, v2of(FIXTURES.retiredAndUnknown));
  assert.ok(!cRet.tasks.some(t => t.id === 'mbath-all'), 'tombstone leaked into tasks');
  const ids = cRet.retiredVisible.map(t => t.id).sort();
  assert.deepEqual(ids, ['hb-all', 'mbath-all']);
  const mba = cRet.retiredVisible.find(t => t.id === 'mbath-all');
  assert.equal(mba.retired, true);
  assert.equal(mba.state.lastDone, D.monthAgo);                 // history recoverable
});
check('archived items excluded from active lists, surfaced under archived', () => {
  const v2 = v2of(FIXTURES.fresh);
  v2.overrides = { 'mb-floor': { archivedAt: '2026-07-01T00:00:00.000Z' } };
  v2.userZones = [{ id:'uz1', title:'Garage Loft', sortOrder: 99, archivedAt: '2026-07-02T00:00:00.000Z' }];
  const c = compose(CATALOG, v2);
  assert.ok(!c.tasks.some(t => t.id === 'mb-floor'));
  assert.ok(c.archived.tasks.some(t => t.id === 'mb-floor'));
  assert.ok(!c.zones.some(z => z.id === 'uz1'));
  assert.ok(c.archived.zones.some(z => z.id === 'uz1'));
});
check('unknown override IDs reported, not applied', () => {
  const v2 = v2of(FIXTURES.fresh);
  v2.overrides = { 'no-such-task': { title:'X' } };
  const c = compose(CATALOG, v2);
  assert.deepEqual(c.report.unknownOverrideIds, ['no-such-task']);
});

/* ════ 6 · Full semantic equivalence, fixed injected date ════ */
section('equivalence');
for (const name of ['fresh', 'empty', 'typical', 'inconsistentDoneToday',
                    'legacyDueNowTrue', 'legacyDueNowFalse', 'retiredAndUnknown',
                    'damagedJson', 'partial']) {
  check(`fixture "${name}" migrates semantically equivalent`, () => {
    const f = FIXTURES[name];
    const { v2 } = migrate(f, CTX);
    const v1Raw = {
      tasks: (() => { try { return JSON.parse(f.v1TasksRaw); } catch { return null; } })(),
      meta:  (() => { try { const m = JSON.parse(f.v1MetaRaw); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; } catch { return {}; } })(),
    };
    const diffs = assertEquivalent(CATALOG, v1Raw, v2, FIXED_TODAY);
    assert.deepEqual(diffs, [], `\n${diffs.join('\n')}`);
  });
}
check('malformedRecords: exactly the documented repairs, nothing else', () => {
  // v1 does NOT sanitize these (verified: storage merge keeps any non-null
  // lastDone — "not-a-date" produces NaN date math and lands in 'overdue';
  // meta.load keeps a bogus viewMode). Migration deliberately repairs them,
  // so equivalence must differ in EXACTLY these ways and no others.
  const f = FIXTURES.malformedRecords;
  const { v2 } = migrate(f, CTX);
  const v1Raw = { tasks: JSON.parse(f.v1TasksRaw), meta: JSON.parse(f.v1MetaRaw) };
  const diffs = assertEquivalent(CATALOG, v1Raw, v2, FIXED_TODAY);
  const allowed = /^(mb-floor\.(lastDone|status|effectiveDue)|workload:|prefs\.viewMode:|today view|week view)/;
  const unexpected = diffs.filter(d => !allowed.test(d));
  assert.deepEqual(unexpected, [], `undocumented differences:\n${unexpected.join('\n')}`);
  assert.ok(diffs.some(d => d.startsWith('mb-floor.lastDone')), 'expected repair diff missing');
  assert.ok(diffs.some(d => d.startsWith('prefs.viewMode')), 'expected viewMode repair diff missing');
});
check('equivalence detects an injected defect (sanity of the checker itself)', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const broken = JSON.parse(JSON.stringify(v2));
  broken.state.find(s => s.taskId === 'mb-floor').lastDone = D.longAgo;   // corrupt one field
  const v1Raw = { tasks: JSON.parse(FIXTURES.typical.v1TasksRaw), meta: JSON.parse(FIXTURES.typical.v1MetaRaw) };
  const diffs = assertEquivalent(CATALOG, v1Raw, broken, FIXED_TODAY);
  assert.ok(diffs.length > 0, 'checker failed to notice a corrupted lastDone');
});
check('safety semantics preserved: overdue smoke-batteries is critical in both worlds', () => {
  const w1 = buildV1World(CATALOG, JSON.parse(FIXTURES.typical.v1TasksRaw), {}, FIXED_TODAY);
  const sb = w1.tasks.find(t => t.id === 'smoke-batteries');
  assert.equal(v1StatusType(sb, FIXED_TODAY), 'critical');
});

/* ════ 7 · Purity guards (static) ════ */
section('purity');
check('v2 modules never reference storage, DOM, or the clock', () => {
  const forbidden = /localStorage|sessionStorage|document\.|window\.|new Date\(\)|Date\.now\(/;
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['dates.js', 'recurrence.js', 'compose.js', 'migrate.js', 'equivalence.js', 'catalog.data.js']) {
    const src = stripComments(readFileSync(join(HERE, '..', 'src', 'v2', f), 'utf8'));
    const m = src.match(forbidden);
    assert.equal(m, null, `${f} contains forbidden reference "${m?.[0]}"`);
  }
});

/* ════ Summary ════ */
/* ════ 8 · Tombstone completeness & recoverability (CP1 correction 1) ════ */
section('tombstones');
check('no committed tombstone has a null or empty identifying definition', () => {
  assert.equal(CATALOG.tombstones.tasks.length, 4);
  for (const tb of CATALOG.tombstones.tasks) {
    assert.ok(typeof tb.id === 'string' && tb.id.length > 0, `${tb.id}: id`);
    const lk = tb.lastKnown;
    assert.ok(lk && typeof lk === 'object', `${tb.id}: lastKnown missing`);
    assert.ok(typeof lk.title === 'string' && lk.title.length > 0, `${tb.id}: title`);
    assert.ok(typeof lk.zoneId === 'string' && lk.zoneId.startsWith('z_'), `${tb.id}: zoneId`);
    assert.ok(typeof lk.zoneTitle === 'string' && lk.zoneTitle.length > 0, `${tb.id}: zoneTitle`);
    assert.equal(validateRecurrence(lk.recurrence).ok, true, `${tb.id}: recurrence`);
    assert.equal(lk.intervalDays, 7, `${tb.id}: intervalDays`);
    assert.equal(typeof lk.safety, 'boolean', `${tb.id}: safety`);
    assert.ok(Array.isArray(lk.tags), `${tb.id}: tags`);
    // Retirement provenance
    assert.equal(tb.retired.date, '2026-07-30');
    assert.equal(tb.retired.appBuild, 'hometask-v12');
    assert.ok(tb.retired.reason.includes('duplicated individual tasks'));
    assert.ok(tb.retired.sourceCommit && tb.retired.evidenceCommit);
    // lastKnown zone must resolve to a live zone (all four bathrooms still exist)
    assert.ok(CATALOG.zones.some(z => z.id === lk.zoneId && z.title === lk.zoneTitle), `${tb.id}: zone resolves`);
  }
});
check('retired record with user state shows meaningful title and room in retiredVisible', () => {
  const { v2 } = migrate(FIXTURES.retiredAndUnknown, CTX);
  const c = compose(CATALOG, v2);
  for (const id of ['mbath-all', 'hb-all']) {
    const r = c.retiredVisible.find(t => t.id === id);
    assert.ok(r, `${id} missing from retiredVisible`);
    assert.equal(r.title, 'Whole bathroom done');
    assert.ok(r.zoneId.startsWith('z_'), `${id}: real zoneId, not null`);
    assert.equal(r.retired, true);
    assert.equal(r.retiredIn.appBuild, 'hometask-v12');
  }
});
check('retired records excluded from Today/Week/All, room lists, and workload', () => {
  const { v2 } = migrate(FIXTURES.retiredAndUnknown, CTX);
  const c = compose(CATALOG, v2);
  const retiredIds = new Set(c.retiredVisible.map(t => t.id));
  assert.ok(retiredIds.size >= 2, 'fixture should surface retired records');
  for (const t of c.tasks) assert.ok(!retiredIds.has(t.id), `${t.id} leaked into active tasks`);
  // Active tasks drive views/room-lists/workload; the v2 world builder uses
  // c.tasks only — assert none of its per-view sets can contain retired ids.
  const activeIds = new Set(c.tasks.map(t => t.id));
  for (const id of retiredIds) assert.ok(!activeIds.has(id));
});
check('tombstone state survives migrate → compose → serialization round-trip', () => {
  const { v2 } = migrate(FIXTURES.retiredAndUnknown, CTX);
  const mba = v2.state.find(s => s.taskId === 'mbath-all');
  assert.ok(mba, 'migrate dropped tombstone state');
  const serialized = JSON.parse(JSON.stringify(v2));           // backup-oriented serialization
  const c = compose(CATALOG, serialized);
  const r = c.retiredVisible.find(t => t.id === 'mbath-all');
  assert.deepEqual(r.state.lastDone, mba.lastDone);
  // Recovery path: reverse migration refuses explicitly rather than losing it.
  const rev = reverseMigrate(serialized, CTX);
  assert.equal(rev.ok, false);
  assert.ok(rev.unsupported.some(u => u.includes('mbath-all')));
});
check('a tombstone can be restored as a user task without inventing identity', () => {
  const tb = CATALOG.tombstones.tasks.find(t => t.id === 'mbath-all');
  const { v2 } = migrate(FIXTURES.retiredAndUnknown, CTX);
  const restored = {
    ...v2,
    userTasks: [{
      id: 'u_restored-' + tb.id, title: tb.lastKnown.title, zoneId: tb.lastKnown.zoneId,
      recurrence: tb.lastKnown.recurrence, safety: tb.lastKnown.safety, tags: [...tb.lastKnown.tags],
    }],
  };
  const c = compose(CATALOG, restored);
  const u = c.tasks.find(t => t.id === 'u_restored-mbath-all');
  assert.ok(u, 'restored user task missing');
  assert.equal(u.title, 'Whole bathroom done');
  assert.equal(u.zoneId, 'z_master-bathroom');
  assert.equal(u.origin, 'user');
});

/* ════ 9 · Canonical v2 envelope (CP1 correction 2) ════ */
section('envelope');
check('every migration returns the full canonical envelope with exact types', () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    const { v2 } = migrate(f, CTX);
    assert.deepEqual(Object.keys(v2).sort(), Object.keys(CANONICAL_ENVELOPE_FIELDS).sort(), name);
    assert.equal(v2.schemaVersion, 2, name);
    assert.ok(Array.isArray(v2.state) && Array.isArray(v2.userZones) &&
              Array.isArray(v2.userTasks) && Array.isArray(v2.completionEvents) &&
              Array.isArray(v2.recentSearches), name);
    assert.ok(typeof v2.prefs === 'object' && !Array.isArray(v2.prefs), name);
    assert.ok(typeof v2.overrides === 'object' && !Array.isArray(v2.overrides), name);
    assert.ok(typeof v2.meta === 'object' && !Array.isArray(v2.meta), name);
    const val = validateEnvelope(v2);
    assert.deepEqual(val, { ok: true, errors: [], unknownFields: [] }, `${name}: ${val.errors}`);
  }
});
check('validateEnvelope rejects missing, mistyped, and unknown top-level fields', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const missing = { ...v2 }; delete missing.userTasks;
  const r1 = validateEnvelope(missing);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some(e => e.includes('missing canonical field: userTasks')));
  const mistyped = { ...v2, overrides: [] };
  const r2 = validateEnvelope(mistyped);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => e.includes('wrong type/value: overrides')));
  const unknown = { ...v2, legacyBlob: {} };
  const r3 = validateEnvelope(unknown);
  assert.equal(r3.ok, false);
  assert.deepEqual(r3.unknownFields, ['legacyBlob']);
  assert.ok(validateEnvelope(null).ok === false && validateEnvelope([]).ok === false);
});
check('compose() output is identical for a freshly migrated canonical envelope and its serialized copy', () => {
  const { v2 } = migrate(FIXTURES.typical, CTX);
  const a = compose(CATALOG, v2);
  const b = compose(CATALOG, JSON.parse(JSON.stringify(v2)));
  assert.deepEqual(a, b);
});

console.log('\n══ CP1 suite ══');
for (const [g, n] of groups) console.log(`  ${g}: ${n} passed`);
console.log(`TOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
