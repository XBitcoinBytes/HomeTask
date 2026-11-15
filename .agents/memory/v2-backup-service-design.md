---
name: V2BackupService design
description: Architecture decisions and traps for V2BackupService (B2 checkpoint).
---

## Location
`src/data/backup/v2-backup-service.js` — no browser globals, no localStorage, adapter-only.

## Constructor injections
`adapter`, `catalog`, `appBuild`, `delivery`, `fileReader`, `clock`, `todayFn`, `sessionStore`.
No separate recoveryStore/backupStore/stagingStore — all v2 state lives in adapter at import-tx.js V2_KEYS constants.

## Delegation pattern
- Export: reads raw bytes from `adapter.getItem(V2_KEYS.DATA)`, calls `buildBackup()`.
- Import: calls `parseAndValidateBackup()` then delegates entirely to `runImportTransaction(adapter, dataStr, now)`.
- Undo: calls `getSnapshot / applySnapshot / clearSnapshot` from import-tx.js.
- Recovery/staging reads: direct JSON parse of adapter keys (no exported helpers for these).

## Null-DATA rollback trap
When DATA was absent (null) before import, the snapshot stores `{ DATA: null }`.
`applySnapshot` calls `adapter.removeItem(DATA)` not `adapter.setItem(DATA,...)` for null values.
Failure-injection tests that need `setItem(DATA)` to trigger rollback MUST seed a prior DATA value first.
Without a prior value, faulting `setItem(DATA)` still lets rollback succeed via removeItem.

## Session key
`SESSION_RECOVERED_KEY = 'hometask-recovered-staging-v2'` — distinct from v1's `'hometask-recovered-staging'`.

## Test structure (73 tests, suite 20)
A=constructor, B=export(9), C=readAndValidate(10), D=happy-import(6),
E=failure-injection(12: snapshot/staging/DATA quota/noop/timeout/rollback/guard/startup/malformed),
F=applyUndo(7), G=snapshot-invariants(4), H=recovery-notice(6), I=recovery-actions(6),
J=tripwire-v2-service(4), K=direct-storage-boundary(2).

**Why:** V2BackupService must be wired behind V2_ACTIVATION_ENABLED; it is never called in production (V2_ACTIVATION_ENABLED=false). Tests exercise it directly, not through the backup facade.
**How to apply:** When wiring V2BackupService in composition root, inject the v2 storage adapter (same one passed to V2Repository), not the v1 backing. No-direct-storage guard must not flag it (K1/K2 tests enforce this).
