---
name: HomeTask backup safety architecture
description: Key decisions for atomic import, recovery-data preservation, and interrupted-import rollback in the HomeTask PWA
---

## localStorage key registry
- `hometask-v1` — tasks (serialized SEED_TASKS + user-state)
- `hometask-meta-v1` — preferences
- `hometask-backup-v1` — backupStore: `{ lastExport, snapshot }` where snapshot is `{ savedAt, keys: { 'hometask-v1': raw|null, 'hometask-meta-v1': raw|null } }`
- `hometask-recovery-v1` — recoveryStore: raw damaged string (capped 250 KB) + metadata
- `hometask-import-staging-v1` — stagingStore: transaction state for atomic import
- `hometask-quarantine-v1` — OBSOLETE (migrated to recovery-v1 on startup)

## Atomic import sequence (applyImport)
1. Guard: if stagingStore has txState='rollback_failed', reject new import immediately
2. Build complete destination state in memory
3. `backupStore.saveSnapshot()` → abort if returns `{ ok: false }` (never touch live data)
4. Write to stagingStore with txState='staged'
5. Read back and validate staging content (abort + clear staging if mismatch)
6. Patch staging to txState='committing'
7. For each key: write + verify, patch keysWritten; on failure → rollback from snapshot
8a. Rollback ok → `stagingStore.clear()` then return error (data restored)
8b. Rollback fails → `stagingStore.patch({ txState:'rollback_failed', rollbackError, keysRestored, failedAt })` — staging and snapshot RETAINED
9. Patch staging to txState='committed' then `stagingStore.clear()` (only on full success)

**Why:** stagingStore.clear() must only happen after verified rollback or verified commit. On rollback failure, staging must be retained so startup can retry.

## rollback_failed txState
When mid-commit write fails AND automatic rollback also fails:
- Staging patched to txState='rollback_failed' with rollbackError, keysRestored[], failedAt
- Undo snapshot in hometask-backup-v1 is NOT cleared
- applyImport immediately returns error message directing user to Undo Last Import
- New imports are blocked while rollback_failed staging exists (guard at top of applyImport)
- _refreshRecoveryPanel checks stagingStore.get()?.txState==='rollback_failed' as a trigger
- _onRestore calls _refreshRecoveryPanel() after error so amber panel shows without reload
- Startup IIFE: retries rollback once; on retry failure sets sessionStorage flag anyway + re-patches lastRetryAt; never loops

## Snapshot format change (breaking, with migration)
Old format: `{ tasks: "<raw>", meta: "<raw>", savedAt: "ISO" }`
New format: `{ savedAt: "ISO", keys: { "hometask-v1": "<raw>"|null, "hometask-meta-v1": "<raw>"|null } }`

`backupStore.getSnapshot()` migrates old format on read. `applySnapshot()` handles null values by calling `localStorage.removeItem()` instead of writing the string "null".

**Why:** Old format could not represent absent keys correctly, causing "null" strings on undo.

## Interrupted-import startup check (runs before any module reads localStorage)
- Finds `hometask-import-staging-v1` at startup as a self-invoking IIFE (before storage/meta modules execute)
- `txState === 'committed'` → cleanup only (no rollback)
- Any other txState → rollback from `backupStore.snapshot.keys`
- Sets `sessionStorage['hometask-recovered-staging'] = '1'` when rollback occurred

**Why:** App modules (storage, meta) must see clean state. Recovery IIFE must run before their IIFEs.

## recoveryStore: don't overwrite undownloaded records
- `save()` skips overwrite if existing record has `downloaded !== true && dismissed !== true`
- On quota-exceeded: writes failure metadata without rawData (preservationFailed: 'quota-exceeded')
- Cap: 250 KB (MAX_RAW = 250 * 1024)

## Build environment variables (for `pnpm run build`)
`PORT=19890 BASE_PATH=/ pnpm run build` — both required by vite.config.ts

## Room-picker bottom-sheet CSS (settled approach, all 23 tests pass)
Dialog: `position:fixed; inset:auto 0 0 0; background:transparent; overflow:hidden` — bottom-anchored, never animated, never transformed.
Sheet: NO `height:100%` (creates circular dependency causing rect.top = -365px when 23+ rooms). Use `max-height: 82vh/svh/dvh` directly on the sheet (three lines, ascending specificity). `display:flex; flex-direction:column; overflow:hidden`.
List: `flex:1; min-height:0; overflow-y:auto` — works because the sheet's max-height constrains the flex container.
Animation: `@keyframes rpSheetSlideUp` via `.rp-dialog.is-entering .rp-sheet`. Safety check uses double-rAF (top-layer elements not fully laid out at first frame).
SW version at this fix: hometask-v17.

CP3 addition: the pure v2 foundation (src/v2/backup*, import-tx, storage-adapter) mirrors these rules over injected adapters; commit success may only be claimed when staging verifiably ends absent or 'committed' — otherwise a startup would revert a "successful" import. Spec: artifacts/home-tasks/docs/v2-backup-envelope.md.

CP3 correction (Policy A): user-owned quarantines (user tasks, user zones) REJECT the whole import — never partial-import silently. Seed-state quarantines and override quarantines do NOT trigger this. See src/v2/backup-validate.js userOwnedErrors[] pattern.
CP3 correction (Title Case): import validation applies the same normalizeTitle policy as the production normalizer (src/v2/title-normalize.js mirrors src/app/catalog.js). Apply to zone titles, task titles, and override titles — never to tags. A repair is logged when the stored value differs from the normalized result.
CP3 correction (zoneId): null or nonexistent zoneId for a user task is a Policy A reject — never repaired to null silently.
