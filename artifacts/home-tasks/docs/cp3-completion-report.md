# CP3 Completion Report — Final Corrected

**Date:** 2026-08-01  
**Scope:** V2 Backup / Import / Recovery / Rollback / Failure-Injection / Data-Loss Tripwire  
**Status:** All corrections applied; all suites green; awaiting CP4A authorization.

---

## 1 · What CP3 Delivered

Pure, adapter-injected v2 backup and import infrastructure — **completely disconnected from
the v1 production runtime**. No UI changes. No service-worker changes. No build changes.
Nothing published. The v1 production path is byte-identical to CP2.

### 1a · Files produced

| File | Purpose |
|---|---|
| `src/v2/backup-validate.js` | Strict v2 envelope validator: 9 fields, Policy A, repairs, quarantine |
| `src/v2/backup.js` | `buildBackup`, `checkImportSize`, `readBackupFile`, `parseAndValidateBackup`, `importV1Backup` |
| `src/v2/migrate.js` | Updated: `completionEvents: []` in `migrate()` output; `reverseMigrate()` rejects non-empty completionEvents |
| `src/v2/title-normalize.js` | Updated: doc comments precisely state first-char-only rule |
| `tests/v2-backup.test.mjs` | 100 checks across 10 sections |
| `tests/v2-tripwire.test.mjs` | 9 checks: completionEvents added to field-survival loop and round-trip check |
| `tests/v2.test.mjs` | 54 checks: completionEvents added to reverse-migrate and envelope assertions |
| `tests/v2-tx.test.mjs` | 37 checks (CP3 transaction suite, unchanged) |
| `docs/v2-backup-envelope.md` | Full 9-field envelope specification, validation policy, title policy |

---

## 2 · Canonical Envelope — 9 Fields

```json
{
  "schemaVersion": 2,
  "state": [],
  "prefs": {},
  "userZones": [],
  "userTasks": [],
  "completionEvents": [],
  "overrides": {},
  "recentSearches": [],
  "meta": {}
}
```

The ninth field `completionEvents` was added per Correction 3. Field order is canonical
and verified by the envelope-build test. `validateEnvelope()` rejects any missing, mistyped,
or extra top-level field.

---

## 3 · Four Corrections — Decisions

### Correction 1 — Policy A extended to ALL user-owned quarantines

**Decision:** Every quarantine in a schema-v2 file is now Policy A — the entire import is
rejected. Previously, state records and override quarantines were exempt; they no longer are.

| Record type | Before | After |
|---|---|---|
| User zone — bad | Policy A reject | Policy A reject (unchanged) |
| User task — bad | Policy A reject | Policy A reject (unchanged) |
| State — unknown seed-format id | Quarantined; others survive | **Policy A reject** |
| State — unknown user-format id | Quarantined; others survive | **Policy A reject** |
| Override — unknown id | Quarantined; others survive | **Policy A reject** |
| Completion event — bad | (new) | **Policy A reject** |

**Tombstone exception preserved:** Retired/tombstoned seed IDs in state are still accepted
with a warning. They are not unknown — they are recognized by the catalog's tombstones list.

**Explicit repair exception preserved:** `safety` on a seed-task override is stripped and
reported as a repair (catalog-authoritative). This is the one field whose value is a safe,
predictable repair rather than a structural unknown.

**Unknown field names on any user-owned record reject.** Invalid values of known fields
are repaired deterministically where the repair is unambiguous (dates → null, doneToday
boolean coercion, tags trimmed/capped, prefs defaults). Structural unknowns (unknown field
names, unknown IDs, wrong types on required fields) always reject.

### Correction 2 — Effective uniqueness

**Decision:** Uniqueness is checked at three levels:

1. **User zone names:** `seenNormalizedZoneTitles` is pre-seeded with all 24 seed zone
   normalized titles before the userZones loop. A user zone whose normalized title matches
   any seed zone title — including one that has been renamed by an override — is rejected.

2. **Composed zone uniqueness:** After processing overrides, the set of effective zone titles
   (seed zones after overrides applied, plus user zones) is checked for uniqueness. An
   override that renames a seed zone to collide with a user zone title rejects the import.

3. **Task uniqueness within zone:** No two active (non-archived) tasks in the same effective
   zone may share a normalized title. User-task titles are checked against each other after
   normalization.

### Correction 3 — Ninth canonical collection: `completionEvents`

**Shape:**
```json
{
  "id":              "c_abc123",
  "taskId":          "<seed-or-user-task-id>",
  "completedOn":     "YYYY-MM-DD",
  "durationMinutes": null
}
```

**ID format:** `COMPLETION_ID_RE = /^c_[A-Za-z0-9_-]{1,64}$/`  
**LIMITS added:** `COMPLETION_EVENTS_MAX: 10_000`, `DURATION_MAX: 1440`

**Rules:**
- All fields are user-owned → any quarantine → Policy A reject.
- Unknown field names reject.
- `durationMinutes` must be `null` or a positive integer ≤ 1440. Zero rejects. Values above
  1440 reject. `null` means intentionally absent (no timing recorded).
- `taskId` must resolve to a known active, archived, or tombstoned task.
- `completedOn` must be a valid calendar YYYY-MM-DD date.
- Event IDs must be unique within a backup file.
- `migrate()` always outputs `completionEvents: []`. Historical `lastDone` values are NEVER
  fabricated into completion events. `lastDone` remains the authoritative scheduling field.
- `reverseMigrate()` reports non-empty `completionEvents` as unsupported.
- Completion events survive export, import, rollback, and the data-loss tripwire.
- Duration tracking (averages, UI) is NOT activated in CP3.

### Correction 4 — Explicit title normalization policy

**Decision:** The normalizer capitalizes **only the first character** of each
whitespace-separated word and preserves all remaining characters verbatim.

This is NOT general English title case. It is a minimal, predictable transform:

| Input | Output | Notes |
|---|---|---|
| `"cLEAN FLOOR"` | `"CLEAN FLOOR"` | 'c'→'C'; "LEAN" verbatim |
| `"DOG house"` | `"DOG House"` | 'D' already upper; "OG" verbatim |
| `"clean baseboards"` | `"Clean Baseboards"` | Standard expected result |
| `"mIxEd case"` | `"MIxEd Case"` | Only first char changed |

Recognized acronyms (`HEPA`, `UV`, `AC`, `CO`, `CO2`) are returned fully uppercase
regardless of input position, as a separately documented exception.

Doc comment in `title-normalize.js` now states the rule explicitly.
Tests assert "cLEAN FLOOR" → "CLEAN FLOOR" (not "Clean Floor").

---

## 4 · Validation Outcome Table (schema-v2)

| Situation | Outcome |
|---|---|
| Wrong `app` identifier | Reject |
| Future `schemaVersion` | Reject (calm: "newer version") |
| Missing `catalogVersion` | Reject |
| Missing/extra/wrong-type canonical field | Reject |
| Prototype-pollution key | Reject |
| Duplicate task/zone/event IDs | Reject |
| Oversized collection or string | Reject |
| Empty backup (nothing to restore) | Reject |
| Malformed user zone (any error) | Policy A reject |
| Malformed user task (any error) | Policy A reject |
| Unknown field in user task / zone | Policy A reject |
| State record — unknown seed-format id | Policy A reject (+ quarantined[] for diagnostics) |
| State record — unknown user-format id | Policy A reject (+ quarantined[] for diagnostics) |
| State record — unknown field | Policy A reject |
| Override — unknown id | Policy A reject (+ quarantined[] for diagnostics) |
| Override — non-overridable field (excl. safety) | Policy A reject |
| Override — unknown field | Policy A reject |
| Completion event — any Policy A trigger | Policy A reject |
| User zone title = seed zone title | Policy A reject |
| Composed zone title collision (via override) | Policy A reject |
| Duplicate task title in same zone (active tasks) | Policy A reject |
| Override `safety` field | Repair: stripped, catalog-authoritative |
| User task `safety: true` | Repair: stripped to false |
| Invalid date | Repair: → null |
| `doneToday: true`, `lastDone` absent | Repair: → false |
| Malformed tags | Repair: trimmed, capped, non-strings dropped |
| Invalid `prefs` field | Repair: safe default |
| Title not normalized | Repair: normalized, logged |
| Retired/tombstoned seed id in state | Warning: retained |
| Schema-v1 backup | Accepted: via migrate() path |

---

## 5 · Test Totals

| Suite | Checks | Status |
|---|---|---|
| `v2.test.mjs` | 54 | ✅ all pass |
| `v2-backup.test.mjs` | 100 | ✅ all pass |
| `v2-tx.test.mjs` | 37 | ✅ all pass |
| `v2-tripwire.test.mjs` | 9 | ✅ all pass |
| `import-order.test.mjs` | 8 | ✅ all pass |
| `backup.test.mjs` (v1 prod) | 22 | ✅ all pass |
| `workload.test.mjs` | 21 | ✅ all pass |
| **TOTAL** | **251** | **✅ all pass** |

---

## 6 · CP4A–CP4E Plan

### CP4A — Browser-origin isolation

Wire `parseAndValidateBackup` + `readBackupFile` into the actual `<input type="file">`
handler, behind the `ENABLE_V2_IMPORT` feature flag (env var gate, off by default). The
handler must:
1. Call `readBackupFile(file)` — size-guarded before `.text()`.
2. Call `parseAndValidateBackup(text, ctx)` — fully validated.
3. Pass `sanitized` into the v2 transaction machinery (`v2-tx.js`).

**Browser-origin isolation caveat:** The import handler lives in a browser context. The
pure `backup.js` and `backup-validate.js` modules have no DOM or storage dependencies and
import cleanly into any environment. The adapter boundary is the `ctx` object injected at
call time: `{ today, catalog, appBuild }`. The transaction layer (`v2-tx.js`) provides the
storage adapter. No changes to either pure module are needed to wire them into the browser.
The `import-order.test.mjs` structural guard (`no production module imports src/v2`) must
pass continuously — the flag-gated entry point is the sole permitted bridge.

### CP4B — Export UI

Wire `buildBackup` into the export button handler (currently v1 path). Inject `exportedAt`
from `new Date().toISOString()` (the one permitted clock read, at the UI boundary).
Filename: `hometask-backup-YYYY-MM-DD.json`.

### CP4C — Rollback UI

Wire the v2 rollback (undo snapshot) into the Settings > Import > "Undo" button. Display
the snapshot timestamp. Block if no snapshot exists.

### CP4D — Recovery UI

Wire `hometask-recovery-v2` records into the damaged-data recovery banner. Display
truncation warning when `truncated: true`. Prevent re-use after `preservationFailed: true`.

### CP4E — completionEvents runtime activation

Add completion-event recording to the task-complete handler (generate `c_` IDs, write to
storage). Activate the completionEvents count in the workload display. This is intentionally
deferred — CP3 proved the format is stable and portable before any UI surface exists.

---

Do you approve final corrected CP3 and authorize CP4A only?
