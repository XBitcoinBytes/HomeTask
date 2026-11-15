---
name: v2 activation controller design
description: Key decisions and invariants for activation-tx.js (CP5A). Required reading before implementing CP5B (production wiring).
---

## Core invariants

**Authority marker is the sole final authority switch.**
Written LAST, verified on every startup. Absence → v1 authoritative. Malformed or digest-mismatch → quarantine, v1 authoritative.

**v1 is never modified by the activation transaction.**
Therefore, startup recovery must never rewrite v1 from the snapshot regardless of transaction state. A v1/snapshot mismatch represents concurrent mutation (newer data), not corruption.

**Concurrent-v1-mutation check.**
`recomputeAndVerifyFingerprint` runs immediately before writing the marker. Must match all four of: pre-snapshot fingerprint, shadow sourceFingerprint, staging fingerprint, proposed marker fingerprint. Mismatch → `source_changed`, DATA quarantined, SNAPSHOT+STAGING retained as evidence.

**Post-commitment ambiguity rule.**
If marker/v2 invalid AND current v1 differs from snapshot → `ambiguous_state`, retain all evidence, do not overwrite newer v1.

## State machine

`snapshot_verified → staged → v2_written → committed`

STAGING is the only temporary record; deleted only after committed is verified.
SNAPSHOT is never deleted by the controller (§G retention policy).
MARKER is never deleted on successful recovery.

## Storage key namespacing

All keys are `hometask-v2-activation-*` (SNAPSHOT, STAGING, MARKER, QUARANTINE).
DATA = `hometask-v2` (shared with import-tx DATA key — safe because activation is the final write).

## Quarantine pattern

Write evidence to QUARANTINE key → verify write → remove source.
If quarantine write fails: retain original, never discard last recoverable copy.

## Test injection pattern for concurrent-v1-mutation

v1 source keys are read exactly ONCE in the transaction (in `recomputeAndVerifyFingerprint`, after all writes). Use `createSetCountMutatingAdapter` (counts SET calls) not a getItem-call counter. afterSets values:
- 0 → before any writes (point 1: after snapshot)
- 1 → after STAGING write (point 2)
- 2 → after DATA write (point 3)
- 3 → after STAGING patch (point 4: immediately before fingerprint check)

## CP5B — completed

Production wiring of `recoverActivationStartup()` into startup via `_boot()` in script.js.

**New modules (all in src/v2/):**
- `activation-boot.js` — pure: `SAFE_V1_ACTIONS` (12-entry frozen Set), `ALL_RECOVERY_ACTIONS`, `bootDecision()`. Strictly fail-closed: only exact `{ status:'disabled' }` or `ok`+safe-action+`v2Active:false` → `'boot-v1'`.
- `activation-bridge.js` — `maybeRecoverActivation(opts)`. Disabled path returns `{ status:'disabled' }` with zero side effects. Enabled path dynamic-imports `activation-tx.js` (via `opts._loadModule` injection for tests). Catches all exceptions; only `_loadModule` rejection produces `status:'failed'` — `recoverActivationStartup` catches all adapter errors internally and always returns `status:'ok'`.

**Key quirk:** `recoverActivationStartup()` has internal try/catch on all adapter operations; adapter failures produce `status:'ok'` not `status:'failed'`. Only bridge-level failures (e.g. `_loadModule` rejection) produce `status:'failed'`. Tests that expect `status:'failed'` must use `_loadModule` injection, not failing adapters.

**tasks.js lazification:** `let _items = null` + `_ensureLoaded()` defers `storage.load()` from module-eval to first call. Comment must not contain the literal string "storage.load()" — structural test counts occurrences.

**Parity test quirk:** Template literal `` `recovered-${staging.txState}` `` case labels are 700+ chars before the template position; window-search fails. Use hardcoded `RECOVERED_TX_STATES = ['v2_written','source_changed','rollback_failed']` + verify each `case '${state}':` exists in source.

**Tests:** 622 total (was 522), all pass. `v2-shadow-ui.test.mjs` test #33 updated from "two branch" to "_boot() single call" pattern.

## CP5C-A2.1 — completed

V1Repository wiring into all production app modules.

**Key patterns:**
- `_repo` closure var in each IIFE; `setRepo(r)` with injection guard (null/non-object rejected, initial assignment allowed, idempotent repeat allowed, swap rejected).
- Copy-on-write in tasks.js: all 4 mutators build `nextItems` via `.map()`, call `_repo.saveTasks(nextItems)`, assign `_items = nextItems` only on `{ok:true}`.
- Save-before-commit for all prefs writes: `_repo.savePrefs()` before updating `_viewMode`/`_roomFilter`/UI; return early on `{ok:false}`.
- `total-tasks-btn` clear-filter: single-patch `{ roomFilter:'', viewMode:'all' }` — replicate `_switchView` effects manually, no second call.
- `backup.js` retains `import { backupStore }` (snapshot ops), but `setLastExport` replaced by `_repo.setLastExport`.
- `browser-storage-backing.js` is the ONLY new file permitted to reference `localStorage` directly.
- `_byId` renamed to `_find` in tasks.js — `v2-activation-bridge.test.mjs` CHECKED array updated accordingly.
- Comment-only mention of "localStorage" in backup-ui.js/script.js: structural guard must check `localStorage.` (API call) not bare word.
- `v2-shadow-ui.test.mjs` test #33 and `import-order.test.mjs` CP5B check: updated regex to `app\.init\([^)]*\)` to accept repo argument.
- `v2-activation-bridge.test.mjs`: `storage.load()` check replaced with `_repo.loadTasks()` check.

**Tests:** 771 total (was 718), +53 new. 16 suites, all pass.
