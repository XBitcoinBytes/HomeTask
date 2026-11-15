/**
 * equivalence.js — deterministic semantic equivalence between a v1 world
 * and its migrated v2 world, under a fixed injected `today`.
 *
 * Used by CP1 unit tests and, later, by the CP4 shadow-migration audit.
 * Compares EVERY record (no sampling): identities, zone mappings,
 * completion/skip state, tags, status classification, workload buckets,
 * Today / This Week / All membership, safety behavior, searchable titles,
 * and preferences.
 *
 * Pure module: no storage, no DOM, no clock.
 */

import { addDays, daysBetween } from './dates.js';
import { effectiveDue as v2EffectiveDue } from './recurrence.js';
import { compose } from './compose.js';
import { computeWorkload, belongsInToday, isActionableNow } from '../workload.js';

/* ── v1 semantics, ported as pure functions ─────────────────────────── */

/** Exact port of v1 storage.load() merge: seed authoritative, user state overlaid. */
export function buildV1World(catalog, v1TasksParsed, v1Meta, today) {
  const zoneTitleById = Object.fromEntries(catalog.zones.map(z => [z.id, z.title]));
  const savedById = new Map(
    (Array.isArray(v1TasksParsed) ? v1TasksParsed : [])
      .filter(t => t && typeof t.id === 'string')
      .map(t => [t.id, t]));
  const tasks = catalog.tasks.map(seed => {
    const s = savedById.get(seed.id) ?? {};
    return {
      id: seed.id, title: seed.title, room: zoneTitleById[seed.zoneId],
      intervalDays: seed.recurrence.every, safety: seed.safety,
      lastDone: typeof s.lastDone === 'string' ? s.lastDone : null,
      doneToday: s.lastDone === today ? Boolean(s.doneToday) : false,
      skipUntil: typeof s.skipUntil === 'string' ? s.skipUntil : null,
      tags: Array.isArray(s.tags) ? s.tags.filter(x => typeof x === 'string') : [],
    };
  });
  return { tasks, meta: v1Meta };
}

/** Exact port of v1 statusOf.compute() → status type only, with injected today. */
export function v1StatusType(t, today) {
  if (t.doneToday === true && t.lastDone === today) return 'done';
  const effective = t.skipUntil ? t.skipUntil
    : t.lastDone ? addDays(t.lastDone, t.intervalDays) : null;
  if (!effective) return 'critical';                      // never done, no skip
  const daysUntil = daysBetween(today, effective);
  if (daysUntil > 7) return 'future';
  if (daysUntil >= 0) return t.safety ? 'critical' : 'soon';
  const daysOverdue = -daysUntil;
  const severe = Math.max(7, t.intervalDays);
  return (t.safety || daysOverdue >= severe) ? 'critical' : 'overdue';
}

export function v1EffectiveDue(t) {
  if (t.skipUntil) return t.skipUntil;
  if (t.lastDone)  return addDays(t.lastDone, t.intervalDays);
  return null;
}

/* ── v2 semantics via compose() + recurrence ────────────────────────── */

export function buildV2World(catalog, v2Storage) {
  const composed = compose(catalog, v2Storage);
  const zoneTitleById = Object.fromEntries(composed.zones.map(z => [z.id, z.title]));
  const tasks = composed.tasks.map(t => ({
    id: t.id, title: t.title, room: zoneTitleById[t.zoneId] ?? null,
    intervalDays: t.recurrence.kind === 'interval' && t.recurrence.unit === 'day' ? t.recurrence.every : null,
    safety: t.safety,
    lastDone: t.state.lastDone, doneToday: t.state.doneToday,
    skipUntil: t.state.skipUntil, tags: t.state.tags,
    recurrence: t.recurrence,
  }));
  return { tasks, composed };
}

export function v2StatusType(t, today) {
  if (t.doneToday === true && t.lastDone === today) return 'done';
  const effective = v2EffectiveDue(t.recurrence, t.lastDone, t.skipUntil);
  if (!effective) return 'critical';
  const daysUntil = daysBetween(today, effective);
  if (daysUntil > 7) return 'future';
  if (daysUntil >= 0) return t.safety ? 'critical' : 'soon';
  const severe = Math.max(7, t.recurrence.every);
  return (t.safety || -daysUntil >= severe) ? 'critical' : 'overdue';
}

/* ── The equivalence check ──────────────────────────────────────────── */

function viewMembership(tasks, statusFn, dueFn, today) {
  const ids = { today: [], week: [], all: [] };
  for (const t of tasks) {
    const type = statusFn(t);
    const dueIsToday = dueFn(t) === today;
    ids.all.push(t.id);
    if (belongsInToday(type, dueIsToday)) ids.today.push(t.id);
    if (type !== 'future') ids.week.push(t.id);   // This Week = everything non-future (v1 rule)
  }
  return ids;
}

/**
 * Compare a v1 world with a v2 world under a fixed date.
 * @returns {string[]} diffs — empty array means fully equivalent.
 */
export function assertEquivalent(catalog, v1Raw, v2Storage, today) {
  const diffs = [];
  const w1 = buildV1World(catalog, v1Raw.tasks, v1Raw.meta, today);
  const w2 = buildV2World(catalog, v2Storage);

  // 1 · Identity sets
  const ids1 = w1.tasks.map(t => t.id).sort();
  const ids2 = w2.tasks.map(t => t.id).sort();
  if (JSON.stringify(ids1) !== JSON.stringify(ids2)) {
    diffs.push(`task ID sets differ: v1=${ids1.length}, v2=${ids2.length}`);
    return diffs;                                  // everything else is meaningless
  }

  // 2 · Per-task fields, state, status, effective due, actionability
  const by2 = new Map(w2.tasks.map(t => [t.id, t]));
  for (const a of w1.tasks) {
    const b = by2.get(a.id);
    for (const f of ['title', 'room', 'intervalDays', 'safety', 'lastDone', 'doneToday', 'skipUntil']) {
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) diffs.push(`${a.id}.${f}: v1=${JSON.stringify(a[f])} v2=${JSON.stringify(b[f])}`);
    }
    if (JSON.stringify(a.tags) !== JSON.stringify(b.tags)) diffs.push(`${a.id}.tags differ`);
    const s1 = v1StatusType(a, today), s2 = v2StatusType(b, today);
    if (s1 !== s2) diffs.push(`${a.id}.status: v1=${s1} v2=${s2}`);
    const d1 = v1EffectiveDue(a), d2 = v2EffectiveDue(b.recurrence, b.lastDone, b.skipUntil);
    if (d1 !== d2) diffs.push(`${a.id}.effectiveDue: v1=${d1} v2=${d2}`);
    if (isActionableNow(s1, d1 === today) !== isActionableNow(s2, d2 === today)) diffs.push(`${a.id}.actionable differs`);
  }

  // 3 · Workload buckets (full object)
  const wl1 = computeWorkload(w1.tasks, t => ({ type: v1StatusType(t, today) }), v1EffectiveDue, today);
  const wl2 = computeWorkload(w2.tasks, t => ({ type: v2StatusType(t, today) }),
    t => v2EffectiveDue(t.recurrence, t.lastDone, t.skipUntil), today);
  if (JSON.stringify(wl1) !== JSON.stringify(wl2)) diffs.push(`workload: v1=${JSON.stringify(wl1)} v2=${JSON.stringify(wl2)}`);

  // 4 · View membership (exact ID lists)
  const m1 = viewMembership(w1.tasks, t => v1StatusType(t, today), v1EffectiveDue, today);
  const m2 = viewMembership(w2.tasks, t => v2StatusType(t, today),
    t => v2EffectiveDue(t.recurrence, t.lastDone, t.skipUntil), today);
  for (const v of ['today', 'week', 'all']) {
    if (JSON.stringify([...m1[v]].sort()) !== JSON.stringify([...m2[v]].sort())) diffs.push(`${v} view membership differs`);
  }

  // 5 · Zones: count, titles, order; per-room task ID lists
  const rooms1 = [...new Set(w1.tasks.map(t => t.room))];
  const rooms2 = w2.composed.zones.map(z => z.title);
  if (JSON.stringify(rooms1) !== JSON.stringify(rooms2)) diffs.push('zone titles/order differ');
  for (const r of rooms1) {
    const l1 = w1.tasks.filter(t => t.room === r).map(t => t.id).sort();
    const l2 = w2.tasks.filter(t => t.room === r).map(t => t.id).sort();
    if (JSON.stringify(l1) !== JSON.stringify(l2)) diffs.push(`room "${r}" task lists differ`);
  }

  // 6 · Preferences
  const p1 = w1.meta, p2 = v2Storage.prefs;
  const zoneTitle = w2.composed.zones.find(z => z.id === p2.roomFilterZoneId)?.title ?? '';
  const expectedViewMode = p1.viewMode ??
    (p1.dueNowDefault === true ? 'week' : p1.dueNowDefault === false ? 'all' : 'today');
  if (p2.viewMode !== expectedViewMode) diffs.push(`prefs.viewMode: expected ${expectedViewMode}, got ${p2.viewMode}`);
  const expectedRoom = rooms1.includes(p1.roomFilter) ? p1.roomFilter : '';
  if (zoneTitle !== expectedRoom) diffs.push(`prefs.roomFilter: expected ${JSON.stringify(expectedRoom)}, resolved ${JSON.stringify(zoneTitle)}`);
  if (Boolean(p1.onboarded) !== p2.onboarded) diffs.push('prefs.onboarded differs');
  if ((p1.choice ?? null) !== p2.choice) diffs.push('prefs.choice differs');
  if ((p1.completedAt ?? null) !== p2.completedAt) diffs.push('prefs.completedAt differs');

  return diffs;
}
