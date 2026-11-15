/**
 * backup-validate.js — strict validation and sanitization of a parsed v2
 * backup file, per docs/v2-backup-envelope.md §5.
 *
 * Three outcomes, never a silent discard:
 *   REJECT     — whole import refused (result.ok === false, errors[]).
 *   QUARANTINE — record excluded from import AND retained verbatim in
 *                result.quarantined[] with a reason. Because Policy A is in
 *                effect for schema-v2 imports, every quarantine also appends
 *                to userOwnedErrors[] and therefore triggers a full reject.
 *                The quarantined[] array is still returned on reject for
 *                diagnostics.
 *   REPAIR     — value fixed; every repair listed in result.repairs[].
 *                Safe, deterministic repairs (dates → null, tag trimming,
 *                doneToday coercion, title normalization) continue for
 *                known-field invalid values. Unknown field NAMES always reject.
 *
 * Policy A (schema-v2): any quarantined record — userTask, userZone, state,
 * override, or completionEvent — rejects the entire import. The only
 * explicit exception: a safety-field override on a seed task is stripped
 * and repaired because that field was never valid user authority.
 *
 * Validation produces plain structured strings only — imported content is
 * never executed, rendered, or interpolated into markup here.
 *
 * Pure module: no storage, no DOM, no clock.
 */

import { isDateStr } from './dates.js';
import { validateRecurrence } from './recurrence.js';
import { validateEnvelope } from './migrate.js';
import { normalizeTitle } from './title-normalize.js';

export const BACKUP_SCHEMA_VERSION = 2;

/* Size / shape limits (docs §5 "excessive sizes"). */
export const LIMITS = Object.freeze({
  TITLE_MAX: 120,
  TAG_MAX: 50,
  TAGS_PER_TASK_MAX: 20,
  STRING_MAX: 10_000,
  STATE_MAX: 2_000,
  USER_TASKS_MAX: 1_000,
  USER_ZONES_MAX: 200,
  OVERRIDE_KEYS_MAX: 2_000,
  COMPLETION_EVENTS_MAX: 10_000,
  /**
   * Maximum duration in minutes per completion event (1440 = 24 hours).
   * Chosen to cover an entire work-day of household chores with a round cap.
   * Values above this are likely data-entry errors and are rejected, not
   * silently capped, to preserve the user's intent.
   */
  DURATION_MAX: 1440,
  RECENTS_MAX: 50,
  MAX_DEPTH: 12,
});

const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];
const SEED_TASK_OVERRIDABLE = ['title', 'zoneId', 'recurrence', 'archivedAt'];
const SEED_ZONE_OVERRIDABLE = ['title', 'sortOrder', 'archivedAt'];
const SEED_TASK_STATE_FIELDS = ['taskId', 'lastDone', 'doneToday', 'skipUntil', 'tags'];
const USER_ZONE_FIELDS       = ['id', 'title', 'sortOrder', 'archivedAt'];
const USER_TASK_FIELDS       = ['id', 'title', 'zoneId', 'recurrence', 'archivedAt', 'safety'];
const COMPLETION_EVENT_FIELDS = ['id', 'taskId', 'completedOn', 'durationMinutes'];
const USER_ID_RE             = /^u_[A-Za-z0-9_-]{1,64}$/;
const COMPLETION_ID_RE       = /^c_[A-Za-z0-9_-]{1,64}$/;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/**
 * Walk a parsed JSON value; report prototype-pollution keys and excessive
 * depth/width. JSON.parse never activates __proto__ as a setter, but such
 * keys can still appear as own properties — we reject them outright.
 */
function structuralScan(value, errors) {
  let nodes = 0;
  const walk = (v, depth, path) => {
    if (depth > LIMITS.MAX_DEPTH) { errors.push(`too deep at ${path} (max depth ${LIMITS.MAX_DEPTH})`); return; }
    if (typeof v === 'string' && v.length > LIMITS.STRING_MAX) {
      errors.push(`string too long at ${path} (${v.length} > ${LIMITS.STRING_MAX})`);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (++nodes > 100_000) { errors.push('object graph too large'); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, depth + 1, `${path}[${i}]`)); return; }
    for (const k of Object.getOwnPropertyNames(v)) {
      if (POLLUTION_KEYS.includes(k)) { errors.push(`prototype-pollution key "${k}" at ${path}`); continue; }
      walk(v[k], depth + 1, `${path}.${k}`);
    }
  };
  walk(value, 0, '$');
}

function sanitizeTags(tags, path, repairs) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) { repairs.push(`${path}.tags: not an array → []`); return []; }
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') { repairs.push(`${path}.tags: non-string entry dropped`); continue; }
    const trimmed = t.trim().slice(0, LIMITS.TAG_MAX);
    if (trimmed !== t) repairs.push(`${path}.tags: entry trimmed/capped`);
    if (trimmed) out.push(trimmed);
  }
  if (out.length > LIMITS.TAGS_PER_TASK_MAX) {
    repairs.push(`${path}.tags: capped to ${LIMITS.TAGS_PER_TASK_MAX}`);
    return out.slice(0, LIMITS.TAGS_PER_TASK_MAX);
  }
  return out;
}

/** Strict calendar check: rejects impossible dates like 2026-02-30 (which
 *  JS Date would silently roll over to March 2). */
function isRealCalendarDate(v) {
  if (!isDateStr(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(v + 'T00:00:00');
  return dt.getFullYear() === y && dt.getMonth() + 1 === m && dt.getDate() === d;
}

function dateOrNull(v, path, repairs) {
  if (v === null || v === undefined) return null;
  if (isRealCalendarDate(v)) return v;
  repairs.push(`${path}: invalid date ${JSON.stringify(String(v).slice(0, 40))} → null`);
  return null;
}

/**
 * Normalize a user-entered display-name field to canonical Title Case, then
 * cap at TITLE_MAX. Logs a repair whenever the stored value differs from the
 * result. Caller must quarantine when null is returned (empty after normalize).
 *
 * Title policy: first char of each word uppercased, remainder preserved as-is.
 * "cLEAN FLOOR" → "CLEAN FLOOR", not "Clean Floor". See title-normalize.js.
 */
function sanitizeTitle(v, path, repairs) {
  if (typeof v !== 'string') return null;
  const normalized = normalizeTitle(v).slice(0, LIMITS.TITLE_MAX);
  if (!normalized) return null;
  if (normalized !== v) repairs.push(`${path}: title normalized → "${normalized.slice(0, 60)}"`);
  return normalized;
}

/**
 * Validate a fully parsed v2 backup file object against the catalog.
 *
 * Policy A (schema-v2): any quarantined record from any collection rejects
 * the entire import. The one explicit exception is safety-field overrides on
 * seed tasks, which are stripped (repaired) because safety was never valid
 * user authority. All other user-owned-record issues trigger Policy A.
 *
 * @returns {{ ok:false, errors:string[], quarantined?:array } |
 *           { ok:true, sanitized:object, repairs:string[],
 *             quarantined:{ path:string, reason:string, record:any }[],
 *             warnings:string[] }}
 * `sanitized` is a canonical 9-field storage envelope safe to hand to the
 * transaction layer. Wrapper fields are validated but not re-emitted.
 */
export function validateBackup(parsed, catalog) {
  const errors = [];

  /* ── Wrapper: reject-level checks ── */
  if (!isPlainObject(parsed)) return { ok: false, errors: ['backup is not a plain JSON object'] };
  structuralScan(parsed, errors);
  if (errors.length) return { ok: false, errors };

  if (parsed.app !== 'HomeTask') errors.push('not a HomeTask backup (app identifier mismatch)');
  if (typeof parsed.schemaVersion !== 'number' || !Number.isInteger(parsed.schemaVersion)) {
    errors.push('missing or invalid schemaVersion');
  } else if (parsed.schemaVersion > BACKUP_SCHEMA_VERSION) {
    errors.push(`made by a newer version of HomeTask (v${parsed.schemaVersion}) — update the app and try again`);
  } else if (parsed.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${parsed.schemaVersion} is not a v2 backup (v1 backups use the v1-import path)`);
  }
  if (parsed.catalogVersion === undefined || parsed.catalogVersion === null) {
    errors.push('missing catalogVersion');
  }
  const WRAPPER_FIELDS = ['app', 'schemaVersion', 'exportedAt', 'catalogVersion', 'appBuild', 'data'];
  for (const k of Object.keys(parsed)) {
    if (!WRAPPER_FIELDS.includes(k)) errors.push(`unknown wrapper field: ${k}`);
  }
  if (!isPlainObject(parsed.data)) errors.push('missing or invalid data envelope');
  if (errors.length) return { ok: false, errors };

  const env = validateEnvelope(parsed.data);
  if (!env.ok) return { ok: false, errors: env.errors.map(e => `data: ${e}`) };
  const d = parsed.data;

  /* ── Collection size caps (reject) ── */
  if (d.state.length > LIMITS.STATE_MAX)
    errors.push(`state has ${d.state.length} records (max ${LIMITS.STATE_MAX})`);
  if (d.userTasks.length > LIMITS.USER_TASKS_MAX)
    errors.push(`userTasks has ${d.userTasks.length} (max ${LIMITS.USER_TASKS_MAX})`);
  if (d.userZones.length > LIMITS.USER_ZONES_MAX)
    errors.push(`userZones has ${d.userZones.length} (max ${LIMITS.USER_ZONES_MAX})`);
  if (Object.keys(d.overrides).length > LIMITS.OVERRIDE_KEYS_MAX)
    errors.push(`overrides has ${Object.keys(d.overrides).length} keys (max ${LIMITS.OVERRIDE_KEYS_MAX})`);
  if (d.completionEvents.length > LIMITS.COMPLETION_EVENTS_MAX)
    errors.push(`completionEvents has ${d.completionEvents.length} (max ${LIMITS.COMPLETION_EVENTS_MAX})`);
  if (errors.length) return { ok: false, errors };

  const repairs = [];
  const quarantined = [];
  /** Reasons for ANY user-owned quarantine.
   *  Non-empty → Policy A: reject the entire import before any storage write. */
  const userOwnedErrors = [];
  const warnings = [];

  const seedTaskIds  = new Set(catalog.tasks.map(t => t.id));
  const retiredIds   = new Set((catalog.tombstones?.tasks ?? []).map(t => t.id));
  const seedZoneIds  = new Set(catalog.zones.map(z => z.id));

  /* ── userZones (validated first: state/userTasks/completionEvents may reference them) ──
   * seenNormalizedZoneTitles is pre-populated with ALL seed zone normalized titles so
   * that a user zone whose name matches any seed zone (even after Title Case
   * normalization) is immediately detected as ambiguous and rejected. */
  const userZones = [];
  const userZoneIds = new Set();
  const seenNormalizedZoneTitles = new Map();  // normalizedTitle → "seed zone <id>" or user zone id
  for (const z of catalog.zones) {
    const t = normalizeTitle(z.title);
    if (t) seenNormalizedZoneTitles.set(t, `seed zone ${z.id}`);
  }

  d.userZones.forEach((z, i) => {
    const path = `userZones[${i}]`;
    if (!isPlainObject(z) || typeof z.id !== 'string' || typeof z.title !== 'string') {
      const reason = 'malformed user zone (missing id/title)';
      quarantined.push({ path, reason, record: z });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    if (!USER_ID_RE.test(z.id)) {
      const reason = `invalid user zone id ${JSON.stringify(z.id.slice(0, 40))}`;
      quarantined.push({ path, reason, record: z });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    if (seedZoneIds.has(z.id) || userZoneIds.has(z.id)) { errors.push(`duplicate zone id: ${z.id}`); return; }
    userZoneIds.add(z.id);

    // Unknown fields in user-owned records reject (they may be from a newer compatible build).
    for (const k of Object.keys(z)) {
      if (!USER_ZONE_FIELDS.includes(k)) {
        userOwnedErrors.push(`${path}.${k}: unknown field in user zone (may be from a newer build)`);
      }
    }
    if (userOwnedErrors.some(e => e.startsWith(`${path}.`))) { userZoneIds.delete(z.id); return; }

    const title = sanitizeTitle(z.title, path, repairs);
    if (!title) {
      const reason = 'empty title after normalization';
      quarantined.push({ path, reason, record: z });
      userOwnedErrors.push(`${path}: ${reason}`);
      userZoneIds.delete(z.id); return;
    }
    // Duplicate normalized title → conflicts with seed zone or earlier user zone.
    if (seenNormalizedZoneTitles.has(title)) {
      const conflictsWith = seenNormalizedZoneTitles.get(title);
      const reason = `duplicate zone title "${title}" — conflicts with ${conflictsWith}`;
      quarantined.push({ path, reason, record: z });
      userOwnedErrors.push(`${path}: ${reason}`);
      userZoneIds.delete(z.id); return;
    }
    seenNormalizedZoneTitles.set(title, z.id);
    const sortOrder = Number.isFinite(z.sortOrder) ? z.sortOrder : 0;
    if (!Number.isFinite(z.sortOrder)) repairs.push(`${path}.sortOrder: invalid → 0`);
    const archivedAt = dateOrNull(z.archivedAt, `${path}.archivedAt`, repairs);
    userZones.push({ id: z.id, title, sortOrder, archivedAt });
  });
  const allZoneIds = new Set([...seedZoneIds, ...userZoneIds]);

  /* ── userTasks ── */
  const userTasks = [];
  const userTaskIds = new Set();
  d.userTasks.forEach((t, i) => {
    const path = `userTasks[${i}]`;
    if (!isPlainObject(t) || typeof t.id !== 'string' || typeof t.title !== 'string') {
      const reason = 'malformed user task (missing id/title)';
      quarantined.push({ path, reason, record: t });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    if (!USER_ID_RE.test(t.id)) {
      const reason = `invalid user task id ${JSON.stringify(t.id.slice(0, 40))}`;
      quarantined.push({ path, reason, record: t });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    if (seedTaskIds.has(t.id) || retiredIds.has(t.id) || userTaskIds.has(t.id)) { errors.push(`duplicate task id: ${t.id}`); return; }

    // Unknown fields reject (may be from newer build).
    for (const k of Object.keys(t)) {
      if (!USER_TASK_FIELDS.includes(k)) {
        userOwnedErrors.push(`${path}.${k}: unknown field in user task (may be from a newer build)`);
      }
    }
    if (userOwnedErrors.some(e => e.startsWith(`${path}.`))) return;

    const rec = validateRecurrence(t.recurrence);
    if (!rec.ok) {
      const reason = `invalid recurrence: ${rec.errors.join('; ')}`;
      quarantined.push({ path, reason, record: t });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    userTaskIds.add(t.id);
    const title = sanitizeTitle(t.title, path, repairs);
    if (!title) {
      const reason = 'empty title after normalization';
      quarantined.push({ path, reason, record: t });
      userOwnedErrors.push(`${path}: ${reason}`);
      userTaskIds.delete(t.id); return;
    }
    // Referential integrity: every active user task must resolve to a valid zone.
    const rawZoneId = typeof t.zoneId === 'string' ? t.zoneId : null;
    if (rawZoneId === null || !allZoneIds.has(rawZoneId)) {
      const reason = rawZoneId === null
        ? 'user task has no zone — every active user task must reference a valid zone'
        : `references nonexistent zone ${JSON.stringify(rawZoneId.slice(0, 40))} — task cannot be placed`;
      quarantined.push({ path, reason, record: t });
      userOwnedErrors.push(`${path}: ${reason}`);
      userTaskIds.delete(t.id); return;
    }
    if (t.safety !== undefined && t.safety !== false) {
      // user tasks may not self-declare safety-critical status (explicit exception: safe repair)
      repairs.push(`${path}.safety: user tasks cannot set safety → stripped`);
    }
    const archivedAt = dateOrNull(t.archivedAt, `${path}.archivedAt`, repairs);
    userTasks.push({ id: t.id, title, zoneId: rawZoneId, recurrence: t.recurrence, archivedAt, safety: false });
  });

  /* ── state ──
   * All quarantine events for state records are now Policy A under schema-v2.
   * State carries user-owned data: completion history, skip schedule, tags.
   * Known tombstone state remains accepted (it's valid user data, not an error).
   * Unknown fields in state records reject (may be from a newer compatible build). */
  const state = [];
  const seenState = new Set();
  const validStateTargets = new Set([...seedTaskIds, ...retiredIds, ...userTaskIds]);
  d.state.forEach((s, i) => {
    const path = `state[${i}]`;
    if (!isPlainObject(s) || typeof s.taskId !== 'string') {
      const reason = 'malformed state record (missing taskId)';
      quarantined.push({ path, reason, record: s });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    if (!validStateTargets.has(s.taskId)) {
      // Distinguish newer-catalog seed IDs from truly unknown/corrupt IDs so
      // users get a calm, actionable explanation. Both are Policy A rejects.
      const isUserFormat = USER_ID_RE.test(s.taskId);
      const reason = isUserFormat
        ? `state for user task "${s.taskId.slice(0, 60)}" not found in this backup's userTasks — record may be from a partial or corrupted backup`
        : `state for task "${s.taskId.slice(0, 60)}" is not recognized in this catalog version — this backup may come from a newer HomeTask catalog; update HomeTask and try again`;
      quarantined.push({ path, reason, record: s });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    if (seenState.has(s.taskId)) { errors.push(`duplicate state records for ${s.taskId}`); return; }
    seenState.add(s.taskId);

    // Unknown fields in state records reject.
    const unknownStateKeys = Object.keys(s).filter(k => !SEED_TASK_STATE_FIELDS.includes(k));
    if (unknownStateKeys.length) {
      for (const k of unknownStateKeys)
        userOwnedErrors.push(`${path}.${k}: unknown field in state record (may be from a newer build)`);
      return;
    }

    if (retiredIds.has(s.taskId)) warnings.push(`${path}: retained state for retired task ${s.taskId}`);
    const lastDone  = dateOrNull(s.lastDone,  `${path}.lastDone`,  repairs);
    const skipUntil = dateOrNull(s.skipUntil, `${path}.skipUntil`, repairs);
    let doneToday = s.doneToday === true;
    if (s.doneToday !== undefined && typeof s.doneToday !== 'boolean') repairs.push(`${path}.doneToday: non-boolean → false`);
    if (doneToday && lastDone === null) { doneToday = false; repairs.push(`${path}.doneToday: true without lastDone → false`); }
    const tags = sanitizeTags(s.tags, path, repairs);
    state.push({ taskId: s.taskId, lastDone, doneToday, skipUntil, tags });
  });

  /* ── overrides ──
   * All quarantine events for overrides are Policy A under schema-v2.
   * Unknown fields in an override reject (may be from a newer build).
   * The one explicit exception: a safety field on a seed-task override is
   * stripped (repaired) because safety authority was never delegated to users. */
  const overrides = {};
  for (const [id, ov] of Object.entries(d.overrides)) {
    const path = `overrides[${JSON.stringify(id.slice(0, 60))}]`;
    if (!isPlainObject(ov)) {
      quarantined.push({ path, reason: 'override is not an object', record: ov });
      userOwnedErrors.push(`${path}: override is not an object`); continue;
    }
    const isZone = id.startsWith('zone:');
    const bare = isZone ? id.slice(5) : id;
    const known = isZone ? seedZoneIds.has(bare) : (seedTaskIds.has(bare) || retiredIds.has(bare));
    if (!known) {
      const reason = 'override addresses unknown id — this backup may come from a newer HomeTask catalog; update HomeTask and try again';
      quarantined.push({ path, reason, record: ov });
      userOwnedErrors.push(`${path}: ${reason}`); continue;
    }
    const allowed = isZone ? SEED_ZONE_OVERRIDABLE : SEED_TASK_OVERRIDABLE;
    const clean = {};
    let ovError = false;
    for (const [k, v] of Object.entries(ov)) {
      // Explicit exception: safety on seed-task overrides is always stripped (safe repair).
      if (!isZone && k === 'safety') { repairs.push(`${path}.safety: catalog-authoritative → stripped`); continue; }
      if (!allowed.includes(k)) {
        userOwnedErrors.push(`${path}.${k}: unknown override field (not overridable in v2; may be from a newer build)`);
        ovError = true; continue;
      }
      if (k === 'title') {
        const t = sanitizeTitle(v, path, repairs);
        if (!t) {
          userOwnedErrors.push(`${path}.title: empty title after normalization`);
          ovError = true; continue;
        }
        clean.title = t; continue;
      }
      if (k === 'recurrence') {
        const r = validateRecurrence(v);
        if (!r.ok) {
          userOwnedErrors.push(`${path}: invalid recurrence override: ${r.errors.join('; ')} — user schedule cannot be silently dropped`);
          ovError = true; continue;
        }
        clean.recurrence = v; continue;
      }
      if (k === 'zoneId') {
        if (typeof v !== 'string' || !allZoneIds.has(v)) {
          userOwnedErrors.push(`${path}.zoneId: nonexistent zone "${String(v).slice(0, 40)}" — override cannot be applied`);
          ovError = true; continue;
        }
        clean.zoneId = v; continue;
      }
      if (k === 'archivedAt') { clean.archivedAt = dateOrNull(v, `${path}.archivedAt`, repairs); continue; }
      if (k === 'sortOrder') {
        // sortOrder with an invalid value is a safe repair (known field, keep override without it).
        if (!Number.isFinite(v)) { repairs.push(`${path}.sortOrder: invalid → stripped`); continue; }
        clean.sortOrder = v; continue;
      }
    }
    if (ovError) continue;
    if (Object.keys(clean).length === 0) { repairs.push(`${path}: no valid fields remained → override omitted`); continue; }
    overrides[id] = clean;
  }

  /* ── completionEvents ──
   * completionEvents are user-owned portable backup data. Each event records
   * that a specific task was completed on a specific date, with an optional
   * duration. Any validation failure is Policy A (reject).
   *
   * ID format: "c_<1–64 chars of [A-Za-z0-9_-]>" — stable, user-generated
   * at runtime; pure tests use deterministic IDs.
   *
   * Duration maximum: LIMITS.DURATION_MAX = 1440 minutes (24 hours).
   * Values above this are rejected rather than silently capped — they likely
   * indicate a data-entry error, and capping would fabricate a different value. */
  const completionEvents = [];
  const seenEventIds = new Set();
  d.completionEvents.forEach((ev, i) => {
    const path = `completionEvents[${i}]`;
    if (!isPlainObject(ev)) {
      quarantined.push({ path, reason: 'completion event is not an object', record: ev });
      userOwnedErrors.push(`${path}: completion event is not an object`); return;
    }
    // Unknown fields reject.
    const unknownKeys = Object.keys(ev).filter(k => !COMPLETION_EVENT_FIELDS.includes(k));
    if (unknownKeys.length) {
      for (const k of unknownKeys)
        userOwnedErrors.push(`${path}.${k}: unknown field in completion event (may be from a newer build)`);
      return;
    }
    // id: must match COMPLETION_ID_RE
    if (typeof ev.id !== 'string' || !COMPLETION_ID_RE.test(ev.id)) {
      const reason = `invalid completion event id ${JSON.stringify(String(ev.id ?? '').slice(0, 40))}`;
      quarantined.push({ path, reason, record: ev });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    if (seenEventIds.has(ev.id)) { errors.push(`duplicate completion event id: ${ev.id}`); return; }
    seenEventIds.add(ev.id);
    // taskId: must resolve to an active, archived, or tombstoned task
    if (typeof ev.taskId !== 'string' || !validStateTargets.has(ev.taskId)) {
      const isUserFmt = typeof ev.taskId === 'string' && USER_ID_RE.test(ev.taskId);
      const reason = isUserFmt
        ? `completion event references user task "${String(ev.taskId).slice(0, 60)}" not found in userTasks — record may be from a partial or corrupted backup`
        : `completion event references task "${String(ev.taskId ?? '').slice(0, 60)}" not recognized in this catalog — this backup may come from a newer HomeTask catalog; update HomeTask and try again`;
      quarantined.push({ path, reason, record: ev });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    // completedOn: must be a valid YYYY-MM-DD calendar date
    if (!isRealCalendarDate(ev.completedOn)) {
      const reason = `invalid completedOn date ${JSON.stringify(String(ev.completedOn ?? '').slice(0, 40))}`;
      quarantined.push({ path, reason, record: ev });
      userOwnedErrors.push(`${path}: ${reason}`); return;
    }
    // durationMinutes: null/undefined → null; positive integer ≤ DURATION_MAX → keep; else reject
    let durationMinutes = null;
    if (ev.durationMinutes !== null && ev.durationMinutes !== undefined) {
      if (!Number.isInteger(ev.durationMinutes) || ev.durationMinutes <= 0 || ev.durationMinutes > LIMITS.DURATION_MAX) {
        const reason = `invalid durationMinutes ${JSON.stringify(ev.durationMinutes)} (must be null or a positive integer ≤ ${LIMITS.DURATION_MAX})`;
        quarantined.push({ path, reason, record: ev });
        userOwnedErrors.push(`${path}: ${reason}`); return;
      }
      durationMinutes = ev.durationMinutes;
    }
    completionEvents.push({ id: ev.id, taskId: ev.taskId, completedOn: ev.completedOn, durationMinutes });
  });

  /* ── Composed uniqueness: active zone titles after effective overrides ──
   * Override titles may shift a seed zone's effective name. We check the
   * full composed set (seed zones with effective override titles + user zones,
   * non-archived only) so overrides cannot accidentally create ambiguous names.
   * Also checks: no two active tasks in the same effective zone share a
   * normalized title (seed tasks with effective overrides + user tasks). */

  // Zone title uniqueness (effective after overrides)
  const effectiveZoneTitles = new Map();  // normalizedTitle → descriptive id string
  for (const z of catalog.zones) {
    const ov = overrides['zone:' + z.id];
    if (ov?.archivedAt) continue;
    const effectiveTitle = (typeof ov?.title === 'string') ? ov.title : normalizeTitle(z.title);
    if (effectiveZoneTitles.has(effectiveTitle)) {
      userOwnedErrors.push(`override creates duplicate active zone title "${effectiveTitle}" — conflicts with zone "${effectiveZoneTitles.get(effectiveTitle)}"`);
    } else {
      effectiveZoneTitles.set(effectiveTitle, `seed:${z.id}`);
    }
  }
  for (const z of userZones) {
    if (z.archivedAt) continue;
    if (effectiveZoneTitles.has(z.title)) {
      userOwnedErrors.push(`user zone "${z.id}" has effective title "${z.title}" that conflicts with zone "${effectiveZoneTitles.get(z.title)}" — ambiguous after override`);
    } else {
      effectiveZoneTitles.set(z.title, z.id);
    }
  }

  // Task title uniqueness per effective zone (non-archived)
  const taskTitlesPerZone = new Map();  // effectiveZoneId → Map<normalizedTitle, id>
  for (const t of catalog.tasks) {
    const ov = overrides[t.id];
    if (ov?.archivedAt) continue;
    const effectiveZoneId = (typeof ov?.zoneId === 'string') ? ov.zoneId : t.zoneId;
    const effectiveTitle  = (typeof ov?.title === 'string')  ? ov.title  : normalizeTitle(t.title);
    if (!taskTitlesPerZone.has(effectiveZoneId)) taskTitlesPerZone.set(effectiveZoneId, new Map());
    const zm = taskTitlesPerZone.get(effectiveZoneId);
    if (zm.has(effectiveTitle)) {
      userOwnedErrors.push(`duplicate active task title "${effectiveTitle}" in zone "${effectiveZoneId}" — conflicts with task "${zm.get(effectiveTitle)}"`);
    } else {
      zm.set(effectiveTitle, t.id);
    }
  }
  for (const t of userTasks) {
    if (t.archivedAt) continue;
    if (!taskTitlesPerZone.has(t.zoneId)) taskTitlesPerZone.set(t.zoneId, new Map());
    const zm = taskTitlesPerZone.get(t.zoneId);
    if (zm.has(t.title)) {
      userOwnedErrors.push(`duplicate active task title "${t.title}" in zone "${t.zoneId}" — conflicts with task "${zm.get(t.zoneId)}"`);
    } else {
      zm.set(t.title, t.id);
    }
  }

  /* ── Policy A: reject if any user-owned record could not be safely placed ──
   * Schema-v2: every quarantine (tasks, zones, state, overrides, completionEvents)
   * is Policy A. An in-memory quarantine that disappears on reload is not safe.
   * The quarantined[] array is still returned so callers can log details. */
  if (userOwnedErrors.length > 0) {
    return { ok: false, errors: [...errors, ...userOwnedErrors], quarantined };
  }

  if (errors.length) return { ok: false, errors };

  /* ── prefs ── */
  const p = d.prefs;
  const viewMode = ['today', 'week', 'all'].includes(p.viewMode) ? p.viewMode : 'today';
  if (viewMode !== p.viewMode) repairs.push('prefs.viewMode: invalid → "today"');
  let roomFilterZoneId = typeof p.roomFilterZoneId === 'string' ? p.roomFilterZoneId : '';
  if (roomFilterZoneId && !allZoneIds.has(roomFilterZoneId)) {
    repairs.push('prefs.roomFilterZoneId: unknown zone → ""'); roomFilterZoneId = '';
  }
  const prefs = {
    viewMode, roomFilterZoneId,
    onboarded: p.onboarded === true,
    choice: typeof p.choice === 'string' ? p.choice.slice(0, 40) : null,
    completedAt: typeof p.completedAt === 'string' ? p.completedAt.slice(0, 40) : null,
  };
  for (const k of Object.keys(p)) {
    if (!['viewMode', 'roomFilterZoneId', 'onboarded', 'choice', 'completedAt'].includes(k)) repairs.push(`prefs.${k}: unknown field stripped`);
  }

  /* ── recentSearches ── */
  const recentSearches = d.recentSearches
    .filter(x => typeof x === 'string')
    .map(x => x.slice(0, 100))
    .slice(0, LIMITS.RECENTS_MAX);
  if (recentSearches.length !== d.recentSearches.length) repairs.push('recentSearches: non-strings dropped / capped');

  /* ── meta (provenance; pass through known fields only) ── */
  const meta = isPlainObject(d.meta) ? {
    migratedFrom: typeof d.meta.migratedFrom === 'string' ? d.meta.migratedFrom.slice(0, 60) : null,
    migratedAt: isDateStr(d.meta.migratedAt) ? d.meta.migratedAt : null,
    catalogVersionAtMigration: Number.isFinite(d.meta.catalogVersionAtMigration) ? d.meta.catalogVersionAtMigration : null,
    appBuildAtMigration: typeof d.meta.appBuildAtMigration === 'string' ? d.meta.appBuildAtMigration.slice(0, 40) : null,
    lastBackupExport: isDateStr(d.meta.lastBackupExport) ? d.meta.lastBackupExport : null,
  } : {};

  /* ── empty backup: nothing to restore at all ── */
  if (state.length === 0 && userTasks.length === 0 && userZones.length === 0 &&
      Object.keys(overrides).length === 0 && completionEvents.length === 0 && !prefs.onboarded) {
    return { ok: false, errors: ['the backup contains no restorable data'] };
  }

  const sanitized = {
    schemaVersion: 2, state, prefs, userZones, userTasks, completionEvents,
    overrides, recentSearches, meta,
  };
  return { ok: true, sanitized, repairs, quarantined, warnings };
}
