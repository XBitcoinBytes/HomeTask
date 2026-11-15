/**
 * backup.js (v2) — build, size-guard, parse, and cross-version import of
 * v2 backup files, per docs/v2-backup-envelope.md.
 *
 * Pure module: no storage, no DOM, no clock. Timestamps are injected.
 * NOT connected to the production entry point during CP3.
 */

import { migrate } from './migrate.js';
import { validateBackup, BACKUP_SCHEMA_VERSION } from './backup-validate.js';

/** Identical to the shipped v1 limit; exactly 2 MB is accepted (size > MAX rejects). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* ── Export ─────────────────────────────────────────────────────────── */

/**
 * Wrap a canonical hometask-v2 storage envelope into a backup file object.
 * @param {object} v2Storage — canonical 9-field envelope
 * @param {{ exportedAt:string, catalogVersion:number, appBuild:string }} ctx
 */
export function buildBackup(v2Storage, ctx) {
  if (!v2Storage || v2Storage.schemaVersion !== 2) throw new Error('buildBackup: not a v2 storage envelope');
  for (const k of ['exportedAt', 'catalogVersion', 'appBuild']) {
    if (ctx?.[k] === undefined) throw new Error(`buildBackup: ctx.${k} is required (injected, never clock-read)`);
  }
  return {
    app: 'HomeTask',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: ctx.exportedAt,
    catalogVersion: ctx.catalogVersion,
    appBuild: ctx.appBuild,
    data: {
      schemaVersion:    2,
      state:            v2Storage.state,
      prefs:            v2Storage.prefs,
      userZones:        v2Storage.userZones,
      userTasks:        v2Storage.userTasks,
      completionEvents: v2Storage.completionEvents,
      overrides:        v2Storage.overrides,
      recentSearches:   v2Storage.recentSearches,
      meta:             v2Storage.meta,
    },
  };
}

/* ── Size guard (before any full read) ──────────────────────────────── */

/** Pure boundary check used by every import entry path. */
export function checkImportSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return { ok: false, error: 'unknown file size — refusing to read' };
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return { ok: false, error: 'This file is too large to be a HomeTask backup (maximum 2 MB).' };
  }
  return { ok: true };
}

/**
 * The ONLY sanctioned way to read a backup file: checks `.size` BEFORE
 * calling `.text()`, so oversized content never reaches JSON.parse.
 * @param {{ size:number, text:() => Promise<string> }} fileLike
 * @returns {Promise<{ ok:true, text:string } | { ok:false, error:string }>}
 */
export async function readBackupFile(fileLike) {
  const gate = checkImportSize(fileLike?.size);
  if (!gate.ok) return gate;
  let text;
  try { text = await fileLike.text(); }
  catch { return { ok: false, error: 'Could not read this file. Please try again.' }; }
  return { ok: true, text };
}

/* ── Parse + route by schema version ────────────────────────────────── */

/**
 * Parse backup text and validate it into a sanitized v2 storage envelope.
 * Handles: malformed JSON, v2 backups (strict validation), v1 backups
 * (via the approved pure migrate() path), unsupported future versions.
 *
 * @param {string} text
 * @param {{ today:string, catalog:object, appBuild:string }} ctx
 * @returns {{ ok:false, errors:string[] } |
 *           { ok:true, source:'v2'|'v1', sanitized, repairs, quarantined, warnings, report? }}
 */
export function parseAndValidateBackup(text, ctx) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, errors: ['This file could not be read. Make sure it is a HomeTask backup.'] }; }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['backup is not a plain JSON object'] };
  }

  // A recovery-data download is damaged-storage evidence, not a backup —
  // it has no app identifier and is rejected here like any foreign file.
  if (parsed.app !== 'HomeTask') return { ok: false, errors: ['not a HomeTask backup (app identifier mismatch)'] };

  if (parsed.schemaVersion === 1) return importV1Backup(parsed, ctx);
  return validateBackupV2(parsed, ctx);
}

function validateBackupV2(parsed, ctx) {
  const res = validateBackup(parsed, ctx.catalog);
  if (!res.ok) return res;
  return { ok: true, source: 'v2', ...res };
}

/**
 * Import a schema-v1 HomeTask backup through the approved pure path:
 * v1-file field checks → reconstruct v1 raw strings → migrate().
 * Nothing is silently discarded: migrate()'s report is surfaced.
 *
 * Schema-v1 import retains its separately documented migration rules:
 * unknown IDs are dropped and reported; malformed fields are sanitized
 * field-by-field; neighbours survive. migrate() never produces user tasks,
 * user zones, overrides, or completionEvents, so Policy A cannot trigger
 * on these collections for v1 imports.
 */
export function importV1Backup(parsed, ctx) {
  const errors = [];
  if (!Array.isArray(parsed.taskState)) errors.push('the v1 backup has an invalid or missing task list');
  else if (parsed.taskState.length === 0) errors.push('the v1 backup contains no task records');
  if (parsed.preferences === null || typeof parsed.preferences !== 'object' || Array.isArray(parsed.preferences)) {
    errors.push('the v1 backup has an invalid preferences section');
  }
  if (errors.length) return { ok: false, errors };

  // Reconstruct the raw v1 key strings migrate() expects. The v1 backup's
  // preferences shape matches v1 meta minus dueNowDefault (already folded).
  const v1TasksRaw = JSON.stringify(parsed.taskState);
  const v1MetaRaw = JSON.stringify(parsed.preferences);
  const { v2, report } = migrate(
    { v1TasksRaw, v1MetaRaw, v1RecentsRaw: null, lastExport: null },
    { today: ctx.today, catalog: ctx.catalog, appBuild: ctx.appBuild },
  );

  // Run the migrated envelope through the same strict v2 validation so
  // both entry paths converge on one sanitizer.
  const res = validateBackup(
    buildBackup(v2, { exportedAt: 'v1-import', catalogVersion: ctx.catalog.catalogVersion, appBuild: ctx.appBuild }),
    ctx.catalog,
  );
  if (!res.ok) return res;
  return { ok: true, source: 'v1', ...res, report };
}
