---
name: V1BackupService test isolation quirks
description: Node 24 + backup-service.test.mjs specific patterns required for correct test isolation.
---

## navigator is read-only in Node 24
`navigator` is a getter-only accessor property in Node 24. Assigning `globalThis.navigator = {}` throws.
Use `Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true })` once at setup, then plain assignment works in subsequent tests.

**Why:** Node 24 added a read-only navigator property (Web-compatibility shim). The Object.defineProperty call replaces the getter-only descriptor with a writable data property.

**How to apply:** Any test file that needs to control `navigator.canShare` must apply this pattern before dynamic imports.

## meta key order: DEFAULTS-spread vs raw loadPrefs()
`backup.js` uses `meta.load()` (returns `{ ...DEFAULTS, ...stored }` → DEFAULTS key order).
`V1BackupService` uses `repo.loadPrefs()` which returns the raw parsed object (stored key order).
The resulting `hometask-meta-v1` bytes are SEMANTICALLY identical but differ in key order.

**Why:** JSON.stringify preserves insertion order; the two paths produce the same data but via different merges.

**How to apply:** Differential applyImport tests for meta bytes must use `deepEqual(JSON.parse(a), JSON.parse(b))` not string equality.

## Map.get() vs Storage.getItem() for absent keys
`mockLS._snapshot()` returns a raw Map. `Map.get(k)` returns `undefined` for absent keys.
`mockLS.getItem(k)` returns `null` for absent keys (matching browser localStorage).
Use `!snapshotMap.has(key)` to check for cleared/absent staging keys in snapshot assertions.

**Why:** Test snapshots capture the Map directly; deleted keys are `undefined` in the Map, not `null`.

## Rollback failure injection (applyImport)
`backupStore.applySnapshot()` writes via `localStorage` (globalThis.localStorage = mockLS), NOT the injected backing.
To test rollback failure, break `mockLS.setItem` for the failing key — this affects BOTH the commit (via backing.setItem → mockLS.setItem) and the rollback (via backupStore.applySnapshot → localStorage.setItem → mockLS.setItem).
Save the snapshot BEFORE breaking mockLS.setItem; restore with `origSetItem` immediately after the service call.
