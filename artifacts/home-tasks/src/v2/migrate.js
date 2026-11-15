/**
 * migrate.js — pure, deterministic v1 → v2 migration (and its reverse).
 *
 * CP1 guardrail 4: this module NEVER reads localStorage, sessionStorage,
 * the clock, the DOM, or global app state. All inputs — including `today` —
 * are explicit arguments. Given identical inputs it returns identical output.
 *
 * migrate(input, ctx):
 *   input = {
 *     v1TasksRaw:   string|null   — raw contents of "hometask-v1"
 *     v1MetaRaw:    string|null   — raw contents of "hometask-meta-v1"
 *     v1RecentsRaw: string|null   — raw contents of "hometask-recent-searches-v1"
 *     lastExport:   string|null   — backupStore lastExport date, if any
 *   }
 *   ctx = { today: "YYYY-MM-DD", catalog, appBuild: string }
 *
 * Returns { v2, report } — report lists every normalization and drop so
 * nothing disappears silently (droppedUnknownIds remain recoverable from
 * the retained v1 snapshot; see Step 1 §G).
 */

import { isDateStr } from './dates.js';
import { fromIntervalDays, toIntervalDays } from './recurrence.js';

const V1_META_DEFAULTS = {
  onboarded: false, choice: null, completedAt: null,
  dueNowDefault: undefined, viewMode: undefined, roomFilter: '',
};

function parseOrNull(raw, report, label) {
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); }
  catch { report.malformed.push(label); return null; }
}

export function migrate(input, ctx) {
  const { today, catalog, appBuild } = ctx;
  if (!isDateStr(today)) throw new Error('migrate: ctx.today must be an explicit "YYYY-MM-DD"');
  const report = {
    malformed: [], droppedUnknownIds: [], normalizedDoneToday: [],
    sanitizedFields: [], roomFilterResolved: null, dueNowDefaultFold: null,
  };

  const knownIds = new Set([
    ...catalog.tasks.map(t => t.id),
    ...(catalog.tombstones?.tasks ?? []).map(t => t.id),
  ]);

  /* ── Task state ── */
  const v1Tasks = parseOrNull(input.v1TasksRaw, report, 'hometask-v1');
  const state = [];
  if (Array.isArray(v1Tasks)) {
    for (const t of v1Tasks) {
      if (!t || typeof t.id !== 'string') { report.malformed.push('task record without id'); continue; }
      if (!knownIds.has(t.id)) { report.droppedUnknownIds.push(t.id); continue; }

      let lastDone = isDateStr(t.lastDone) ? t.lastDone : null;
      if (t.lastDone != null && lastDone === null) report.sanitizedFields.push(`${t.id}.lastDone`);
      let skipUntil = isDateStr(t.skipUntil) ? t.skipUntil : null;
      if (t.skipUntil != null && skipUntil === null) report.sanitizedFields.push(`${t.id}.skipUntil`);
      const tags = Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string') : [];

      // Invariant: doneToday requires lastDone === today. v1 load coerces
      // with Boolean() (`s.lastDone === today ? Boolean(s.doneToday) : false`),
      // so a truthy non-boolean counts — exact port, then the same invariant.
      const doneToday = Boolean(t.doneToday) && lastDone === today;
      if (Boolean(t.doneToday) && !doneToday) report.normalizedDoneToday.push(t.id);

      // Untouched tasks need no state record.
      if (lastDone === null && skipUntil === null && doneToday === false && tags.length === 0) continue;
      state.push({ taskId: t.id, lastDone, doneToday, skipUntil, tags });
    }
  } else if (v1Tasks !== null) {
    report.malformed.push('hometask-v1 is not an array');
  }

  /* ── Preferences ── */
  const v1MetaParsed = parseOrNull(input.v1MetaRaw, report, 'hometask-meta-v1');
  const m = { ...V1_META_DEFAULTS, ...(v1MetaParsed && typeof v1MetaParsed === 'object' ? v1MetaParsed : {}) };

  // dueNowDefault → viewMode fold (exact port of the v1 meta.load rule).
  let viewMode = m.viewMode;
  if (!viewMode) {
    if (m.dueNowDefault === true)       viewMode = 'week';
    else if (m.dueNowDefault === false) viewMode = 'all';
    else                                viewMode = 'today';
    report.dueNowDefaultFold = `${String(m.dueNowDefault)} → ${viewMode}`;
  }
  if (!['today', 'week', 'all'].includes(viewMode)) { viewMode = 'today'; report.sanitizedFields.push('prefs.viewMode'); }

  // roomFilter title → stable zone id.
  let roomFilterZoneId = '';
  if (typeof m.roomFilter === 'string' && m.roomFilter !== '') {
    const zone = catalog.zones.find(z => z.title === m.roomFilter);
    roomFilterZoneId = zone ? zone.id : '';
    report.roomFilterResolved = `${JSON.stringify(m.roomFilter)} → ${zone ? zone.id : '"" (no matching zone)'}`;
  }

  /* ── Recent searches ── */
  const recentsParsed = parseOrNull(input.v1RecentsRaw, report, 'hometask-recent-searches-v1');
  const recentSearches = Array.isArray(recentsParsed) ? recentsParsed.filter(x => typeof x === 'string') : [];

  const v2 = {
    schemaVersion: 2,
    state,
    prefs: {
      viewMode,
      roomFilterZoneId,
      onboarded: m.onboarded === true,
      choice: m.choice ?? null,
      completedAt: m.completedAt ?? null,
    },
    userZones: [],
    userTasks: [],
    completionEvents: [],   // v1 has no completion-event history; never fabricated from lastDone
    overrides: {},
    recentSearches,
    meta: {
      migratedFrom: 'hometask-v1',
      migratedAt: today,                       // date-only: deterministic, injected
      catalogVersionAtMigration: catalog.catalogVersion,
      appBuildAtMigration: appBuild,
      lastBackupExport: isDateStr(input.lastExport) ? input.lastExport : null,
    },
  };
  return { v2, report };
}

/**
 * reverseMigrate(v2, ctx) — supported domain ONLY (CP1 guardrail 5).
 *
 * Round-trips exactly: v1-origin data (interval/day recurrences, empty
 * userZones/userTasks/overrides, empty completionEvents). Anything v1
 * cannot represent returns an explicit { ok:false, unsupported:[...] } —
 * never a silent discard.
 *
 * @returns {{ ok:true, v1Tasks, v1Meta, v1Recents } | { ok:false, unsupported:string[] }}
 */
export function reverseMigrate(v2, ctx) {
  const { catalog } = ctx;
  const unsupported = [];
  if ((v2.userZones ?? []).length) unsupported.push(`userZones (${v2.userZones.length}) — v1 has no user zones`);
  if ((v2.userTasks ?? []).length) unsupported.push(`userTasks (${v2.userTasks.length}) — v1 has no user tasks`);
  if ((v2.completionEvents ?? []).length) unsupported.push(`completionEvents (${v2.completionEvents.length}) — v1 has no completion-event history`);
  for (const [id, ov] of Object.entries(v2.overrides ?? {})) {
    unsupported.push(`override on ${id} (${Object.keys(ov).join(',')}) — v1 has no override layer`);
  }
  const tombstoneIds = new Set((catalog.tombstones?.tasks ?? []).map(t => t.id));
  const catalogIds   = new Set(catalog.tasks.map(t => t.id));
  const seenStateIds = new Set();
  for (const s of v2.state ?? []) {
    if (tombstoneIds.has(s.taskId)) unsupported.push(`state for retired task ${s.taskId} — invisible in v1`);
    else if (!catalogIds.has(s.taskId)) unsupported.push(`state for unknown task ${s.taskId} — v1 cannot represent it`);
    if (seenStateIds.has(s.taskId)) unsupported.push(`duplicate state records for ${s.taskId} — reversal would lose one`);
    seenStateIds.add(s.taskId);
  }
  for (const t of catalog.tasks) {
    const conv = toIntervalDays(t.recurrence);
    if (!conv.ok) unsupported.push(`task ${t.id}: ${conv.reason}`);
  }
  if (unsupported.length) return { ok: false, unsupported };

  const stateById = new Map((v2.state ?? []).map(s => [s.taskId, s]));
  const v1Tasks = catalog.tasks.map(t => {
    const s = stateById.get(t.id);
    const zone = catalog.zones.find(z => z.id === t.zoneId);
    return {
      id: t.id, title: t.title, room: zone.title,
      intervalDays: toIntervalDays(t.recurrence).intervalDays,
      tags: s ? [...s.tags] : [],
      lastDone: s?.lastDone ?? null,
      doneToday: s?.doneToday === true,
      skipUntil: s?.skipUntil ?? null,
    };
  });
  const zone = catalog.zones.find(z => z.id === v2.prefs.roomFilterZoneId);
  const v1Meta = {
    onboarded: v2.prefs.onboarded, choice: v2.prefs.choice, completedAt: v2.prefs.completedAt,
    viewMode: v2.prefs.viewMode, roomFilter: zone ? zone.title : '',
  };
  return { ok: true, v1Tasks, v1Meta, v1Recents: [...(v2.recentSearches ?? [])] };
}

/* ── Canonical v2 envelope (CP1 correction 2; updated CP3 correction 3) ──
 * Every successful migrate() returns exactly these top-level fields, even
 * when collections are empty. Downstream code must never rely on defaulting.
 *
 * Field order: schemaVersion · state · prefs · userZones · userTasks ·
 * completionEvents · overrides · recentSearches · meta
 *
 * Note: the approved Step 1 design names the recents collection
 * `recentSearches` (not `recents`). */
export const CANONICAL_ENVELOPE_FIELDS = Object.freeze({
  schemaVersion:    v => v === 2,
  state:            Array.isArray,
  prefs:            v => v !== null && typeof v === 'object' && !Array.isArray(v),
  userZones:        Array.isArray,
  userTasks:        Array.isArray,
  completionEvents: Array.isArray,
  overrides:        v => v !== null && typeof v === 'object' && !Array.isArray(v),
  recentSearches:   Array.isArray,
  meta:             v => v !== null && typeof v === 'object' && !Array.isArray(v),
});

/**
 * validateEnvelope(v2) → { ok, errors, unknownFields }
 * Rejects missing/mistyped canonical fields; unknown top-level fields are
 * reported explicitly (never silently accepted or silently dropped).
 */
export function validateEnvelope(v2) {
  const errors = [];
  const unknownFields = [];
  if (v2 === null || typeof v2 !== 'object' || Array.isArray(v2)) {
    return { ok: false, errors: ['envelope is not an object'], unknownFields };
  }
  for (const [field, check] of Object.entries(CANONICAL_ENVELOPE_FIELDS)) {
    if (!(field in v2)) errors.push(`missing canonical field: ${field}`);
    else if (!check(v2[field])) errors.push(`canonical field has wrong type/value: ${field}`);
  }
  for (const k of Object.keys(v2)) {
    if (!(k in CANONICAL_ENVELOPE_FIELDS)) { unknownFields.push(k); errors.push(`unknown top-level field: ${k}`); }
  }
  return { ok: errors.length === 0, errors, unknownFields };
}

/** Round-trip helper for fromIntervalDays coverage in tests. */
export { fromIntervalDays };
