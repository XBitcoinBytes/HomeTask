/**
 * compose.js — pure composition of (static catalog + user storage) into the
 * effective zones and tasks the app would display.
 *
 * Authority rules (approved Step 1 design, §B):
 *   • Seed fields are defaults; explicit user overrides win per-field.
 *   • SAFETY IS CATALOG-AUTHORITATIVE for seed tasks — an override carrying
 *     a `safety` field is ignored (and reported) rather than applied.
 *   • Completion/scheduling state always comes from the user state record.
 *   • Tombstoned (retired) catalog tasks appear ONLY when the user has state
 *     or an override for them; otherwise they are inert metadata. They are
 *     marked `retired: true` and NEVER enter active daily views by default.
 *   • Archived items (archivedAt set) are excluded from `tasks`/`zones` and
 *     surfaced under `archived`.
 *
 * Pure module: no storage, no DOM, no clock.
 */

const EMPTY_STATE = Object.freeze({ lastDone: null, doneToday: false, skipUntil: null, tags: [] });

// Fields an override may set on a seed task. `safety` deliberately absent.
const SEED_TASK_OVERRIDABLE = ['title', 'zoneId', 'recurrence', 'archivedAt'];
const SEED_ZONE_OVERRIDABLE = ['title', 'sortOrder', 'archivedAt'];

function stateFor(storage, taskId) {
  const rec = (storage.state ?? []).find(s => s.taskId === taskId);
  if (!rec) return { ...EMPTY_STATE };
  return {
    lastDone: rec.lastDone ?? null,
    doneToday: rec.doneToday === true,
    skipUntil: rec.skipUntil ?? null,
    tags: Array.isArray(rec.tags) ? [...rec.tags] : [],
  };
}

/**
 * @param {object} catalog  — src/v2/catalog.data.js CATALOG shape
 * @param {object} storage  — hometask-v2 envelope (user data only)
 * @returns {{ zones, tasks, archived: {zones, tasks}, retiredVisible, report }}
 */
export function compose(catalog, storage) {
  const report = { ignoredSafetyOverrides: [], ignoredOverrideFields: [], unknownOverrideIds: [] };
  const overrides = storage.overrides ?? {};

  const applyOverride = (base, ov, allowed, id, isSeedTask) => {
    if (!ov) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(ov)) {
      if (isSeedTask && k === 'safety') { report.ignoredSafetyOverrides.push(id); continue; }
      if (!allowed.includes(k)) { report.ignoredOverrideFields.push(`${id}.${k}`); continue; }
      out[k] = v;
    }
    return out;
  };

  /* ── Zones ── */
  const seedZones = catalog.zones.map(z =>
    applyOverride({ ...z, origin: 'seed' }, overrides['zone:' + z.id], SEED_ZONE_OVERRIDABLE, 'zone:' + z.id, false));
  const userZones = (storage.userZones ?? []).map(z => ({ ...z, origin: 'user' }));
  const allZones  = [...seedZones, ...userZones];

  /* ── Seed tasks (active catalog) ── */
  const seedTasks = catalog.tasks.map(t => {
    const composed = applyOverride(
      { ...t, origin: 'seed', retired: false, archivedAt: null },
      overrides[t.id], SEED_TASK_OVERRIDABLE, t.id, true);
    composed.safety = t.safety;               // catalog-authoritative, unconditionally
    return { ...composed, ...{ state: stateFor(storage, t.id) } };
  });

  /* ── Tombstoned tasks — visible only with user state or override ── */
  const stateIds = new Set((storage.state ?? []).map(s => s.taskId));
  const retiredVisible = (catalog.tombstones?.tasks ?? [])
    .filter(tb => stateIds.has(tb.id) || overrides[tb.id])
    .map(tb => {
      const lk = tb.lastKnown ?? {};
      const base = {
        id: tb.id, origin: 'seed', retired: true, retiredIn: tb.retired ?? null,
        title: lk.title ?? tb.id, zoneId: lk.zoneId ?? null,
        recurrence: lk.recurrence ?? { kind: 'paused' },
        safety: lk.safety === true, tags: lk.tags ?? [], archivedAt: null,
      };
      const composed = applyOverride(base, overrides[tb.id], SEED_TASK_OVERRIDABLE, tb.id, true);
      composed.safety = base.safety;          // catalog-authoritative here too
      return { ...composed, state: stateFor(storage, tb.id) };
    });

  /* ── User tasks ── */
  const knownZoneIds = new Set(allZones.map(z => z.id));
  const userTasks = (storage.userTasks ?? []).map(t => ({
    ...t, origin: 'user', retired: false,
    zoneId: knownZoneIds.has(t.zoneId) ? t.zoneId : null,
    state: stateFor(storage, t.id),
  }));

  for (const id of Object.keys(overrides)) {
    const bare = id.startsWith('zone:') ? id.slice(5) : id;
    const known = catalog.tasks.some(t => t.id === bare) ||
      catalog.zones.some(z => z.id === bare) ||
      (catalog.tombstones?.tasks ?? []).some(tb => tb.id === bare);
    if (!known) report.unknownOverrideIds.push(id);
  }

  const active   = x => !x.archivedAt;
  const archived = x => Boolean(x.archivedAt);
  const allTasks = [...seedTasks, ...userTasks];

  return {
    zones: allZones.filter(active).sort((a, b) => a.sortOrder - b.sortOrder),
    tasks: allTasks.filter(active),
    // retired tasks are reported separately — they never mix into `tasks`
    retiredVisible,
    archived: { zones: allZones.filter(archived), tasks: allTasks.filter(archived) },
    report,
  };
}
