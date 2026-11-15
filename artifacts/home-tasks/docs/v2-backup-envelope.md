# V2 Backup Envelope — CP3 Specification

Status: CP3 design document. The running application still uses v1 storage;
nothing in this document is user-visible yet. All CP3 code is pure and
adapter-injected, disconnected from the production entry point.

## 1 · File shape (schemaVersion 2)

A v2 backup file is a single JSON object:

```json
{
  "app":            "HomeTask",
  "schemaVersion":  2,
  "exportedAt":     "2026-08-01T00:00:00.000Z",
  "catalogVersion": 1,
  "appBuild":       "v19",
  "data":           { …canonical hometask-v2 storage envelope… }
}
```

`data` is EXACTLY the frozen canonical 9-field storage envelope (see §2).
Export = wrap the envelope; import = unwrap + validate.
`data.schemaVersion` must equal the wrapper `schemaVersion` (both 2).

## 2 · Canonical storage envelope (9 fields)

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `2` | Literal value 2 |
| `state` | array | Per-task scheduling/completion state |
| `prefs` | object | Portable user preferences |
| `userZones` | array | User-created zones |
| `userTasks` | array | User-created tasks |
| `completionEvents` | array | Portable completion-event history (see §2a) |
| `overrides` | object | Sparse per-field seed overrides (`zone:` prefix for zones) |
| `recentSearches` | array | User-entered search strings |
| `meta` | object | Migration provenance |

Field order in the canonical envelope matches the table above.
All 9 fields are required; `validateEnvelope()` rejects any missing,
mistyped, or extra top-level field.

### §2a · completionEvents

The ninth collection reserves space for portable completion-event history
without activating any runtime behavior in CP3.

Each event has this exact shape:

```json
{
  "id":              "c_<1-64 chars of [A-Za-z0-9_-]>",
  "taskId":          "<seed-task-id or user-task-id>",
  "completedOn":     "YYYY-MM-DD",
  "durationMinutes": null
}
```

Rules:
- `id` is a stable identifier, generated once at runtime (the `c_` prefix
  marks it as a completion-event record). For test fixtures, deterministic
  IDs are used directly. `crypto.randomUUID()` is NOT required during
  migration or pure tests — ID generation belongs to the later runtime step.
- `durationMinutes` is optional in the product flow. When intentionally
  absent, it is stored as `null`. When a user records a duration it must be
  a positive integer `≤ LIMITS.DURATION_MAX` (1440 minutes / 24 hours).
  Values outside this range are rejected rather than silently capped.
  Duration tracking (averages, UI) is NOT activated in CP3.
- `completedOn` must be a valid local YYYY-MM-DD calendar date.
- `taskId` must resolve to an active, archived, or known tombstoned task.
- Each event `id` must be unique within a backup file.
- Completion events are user-owned portable data. Under Policy A any invalid
  event rejects the entire import.
- `migrate()` always outputs `completionEvents: []`. Historical `lastDone`
  values are never fabricated into completion events — `lastDone` remains
  the authoritative current scheduling field.
- `reverseMigrate()` reports `completionEvents` as unsupported if non-empty.
- Completion events survive export, import, rollback, and the data-loss
  tripwire (proven by the tripwire suite).

## 3 · Included fields — and why

| Field | Why included |
|---|---|
| `app` | Refuse files not created by HomeTask. |
| `schemaVersion` | Version gate; unsupported future versions rejected calmly. |
| `exportedAt` | Export timestamp (informational; injected, never read from clock in pure code). |
| `catalogVersion` | Records which catalog version the state was written against, so tombstone/override interpretation is auditable. Missing ⇒ reject. |
| `appBuild` | Diagnostic provenance only. |
| `data.state` | Task scheduling/completion state (`taskId, lastDone, doneToday, skipUntil, tags`) — includes retained state for retired/tombstoned seed tasks. |
| `data.prefs` | Exactly the approved portable preferences: `viewMode, roomFilterZoneId, onboarded, choice, completedAt`. |
| `data.userZones` | User-created zones. |
| `data.userTasks` | User-created tasks, carrying full future-compatible recurrence objects. |
| `data.completionEvents` | Portable completion-event history with optional duration; see §2a. |
| `data.overrides` | Sparse per-field seed-task / seed-zone overrides (`zone:` prefix for zones). `safety` is never accepted (catalog-authoritative). |
| `data.recentSearches` | Intentionally portable (small, user-entered, restores search UX). |
| `data.meta` | Migration provenance (`migratedFrom, migratedAt, catalogVersionAtMigration, appBuildAtMigration, lastBackupExport`). |

## 4 · Excluded — and why

| Excluded | Why |
|---|---|
| Seed catalog (titles, zones, recurrences, safety) | Static application source; duplicating it invites drift and catalog-injection. |
| Import staging transactions | Temporary transaction data, meaningless outside the device. |
| Undo snapshots | Byte-exact pre-operation device state, not portable user data. |
| Recovery / quarantine raw data | Damaged-data evidence; must never round-trip as a "backup". |
| Any non-`hometask-*` localStorage data | Out of scope by definition. |

## 5 · Validation policy

Full detail lives in `src/v2/backup-validate.js`. Three outcomes, never a
silent discard:

### REJECT (whole import) — any of:
- Wrong `app`; unsupported/missing/future `schemaVersion`; malformed JSON.
- Top-level not a plain object; missing `catalogVersion`.
- Canonical envelope missing/mistyped/unknown top-level fields.
- Prototype-pollution keys anywhere (`__proto__`, `constructor`, `prototype`).
- Duplicate task/zone IDs, duplicate state records, or duplicate completion-event IDs.
- Oversized collections/strings/depth.
- Empty backup (no state, no user content, no completion events, not onboarded).

### Policy A (schema-v2, reject whole import) — any of:
- User zone: malformed / invalid ID / empty title / duplicate normalized title
  (including against seed zone titles after override) / unknown field.
- User task: malformed / invalid ID / bad recurrence / null or nonexistent
  zoneId / empty title / unknown field.
- State record: malformed (missing taskId) / unknown taskId (seed-format or
  user-format) / unknown field.
- Override: unknown seed/zone id / invalid recurrence / non-overridable field
  (exception: safety stripped as repair) / nonexistent override zoneId / empty
  override title.
- Completion event: not an object / invalid id / unknown taskId / invalid
  completedOn / invalid durationMinutes / unknown field.
- Composed uniqueness violation: two active zones with same normalized title
  (including after override), or two active tasks in the same effective zone
  with the same normalized title.

### REPAIR (with explicit report entry) — all of:
- Invalid dates → `null`.
- Non-boolean `doneToday` → `false`.
- Malformed tags filtered/trimmed/capped.
- User-task `safety: true/truthy` → `false` (user tasks cannot self-declare safety).
- Override `safety` field on a seed task → stripped (catalog-authoritative; explicit exception).
- Override `sortOrder` not finite → stripped.
- Invalid `prefs` fields → safe defaults.
- Non-string recentSearches entries → dropped / capped.
- Override / user zone / user task title → canonical Title Case normalization.

### Always accepted:
- Retired/tombstoned seed IDs in state (with warning).

### Schema-v1 compatibility:
- Schema-v1 HomeTask backups import through the approved pure `migrate()` path.
- v1 migration retains its separately documented rules: unknown IDs are
  dropped and reported; malformed fields are sanitized field-by-field;
  neighbours survive. `migrate()` produces no user tasks, user zones, or
  completion events, so Policy A cannot trigger on those collections for v1.

## 6 · Title normalization policy

User-entered display names (task titles, zone titles, title overrides) are
normalized to canonical Title Case at import time. Every normalization is
recorded as a repair. Tags are never normalized (no approved policy).

**The normalizer capitalizes ONLY the first character of each whitespace-
separated word and preserves ALL remaining characters verbatim.** This is
not general English title case:

| Input | Result | Notes |
|---|---|---|
| `"clean baseboards"` | `"Clean Baseboards"` | Standard case |
| `"cLEAN FLOOR"` | `"CLEAN FLOOR"` | First char 'C', rest 'LEAN' preserved |
| `"DOG house"` | `"DOG House"` | 'D' already uppercase; 'OG' preserved |
| `"HEPA filter"` | `"HEPA Filter"` | HEPA is a recognized acronym → fully upper |
| `"check CO2 levels"` | `"Check CO2 Levels"` | CO2 is a recognized acronym |
| `"mother-in-law room"` | `"Mother-In-Law Room"` | Hyphen: each segment |
| `"don't forget"` | `"Don't Forget"` | Apostrophe: first char uppercased |

Recognized acronyms (returned fully upper-case regardless of input position):
`HEPA`, `UV`, `AC`, `CO`, `CO2`.

This policy may be revised as a separately migrated product decision. Do not
assume arbitrary mixed-case input becomes English title case.

## 7 · Transaction model (v2 keys)

Injected storage adapter; state machine identical in spirit to the shipped
v1 import transaction, with an explicit `txVersion: 2`:

```
in-memory validate → snapshot(save+verify) → staging(write+verify)
  → committing → per-key write+byte-verify+progress → committed → cleanup
```

Keys: target `hometask-v2`, staging `hometask-import-staging-v2`,
snapshot inside `hometask-backup-v2`, recovery `hometask-recovery-v2`.
No unrelated key is ever read destructively, changed, or removed.

Recovery records keep the established 250 KB raw-data cap, truncation
metadata, and never-overwrite-undownloaded policy.
