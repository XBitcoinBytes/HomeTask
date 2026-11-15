---
name: Concurrent lock test design (V2BackupService)
description: Patterns for testing overlapping export+import/undo schedule with TracingLock; barrier mechanism; txId format quirks; blob content reading.
---

## TracingLock
Records `acquire:<tag>` / `release:<tag>` into `this.log`. Tag = the txId string argument to `runExclusive`. Same FIFO serialisation as TestLock.

## txId format — DO NOT match by exact string
`runV2LockedImport` and `runV2LockedUndo` prefix the caller-supplied txId internally:
- Import: `'import:<clock>:<counter>'` (e.g. `'import:2026-07-31T10:00:00.000Z:1'`)
- Undo: `'undo:<timestamp>:<counter>'` (e.g. `'undo:1786601377535:2'`)
- Export-read: `'export-read'` (set directly in V2BackupService, not prefixed)
- Backup-write: `'backup-write'` (set directly in V2BackupService, not prefixed)

**Rule:** locate import and undo entries by position (first acquire/release after export-read, before backup-write), not by `log.indexOf('acquire:undo')` or `log.indexOf(`acquire:${NOW}`)` — those return -1.

```javascript
const imAcq = log.findIndex((e, i) => i > erRel && e.startsWith('acquire:') && !e.endsWith('backup-write'));
const imRel = imAcq >= 0 ? log.findIndex((e, i) => i > imAcq && e.startsWith('release:') && !e.endsWith('backup-write')) : -1;
```

## Delivery barrier: use setImmediate, not Promise.resolve
`await Promise.resolve()` in delivery.share() is insufficient — export's backup-write may already be queued as a microtask before the import/undo lock gets queued. Use:

```javascript
share: async (blob) => {
  deliveredContent = typeof blob.text === 'function' ? await blob.text() : blob._content;
  await new Promise(r => setImmediate(r)); // full task boundary — queued locks drain here
},
```

setImmediate fires after all microtasks drain, guaranteeing import/undo runs before backup-write.

## Reading delivered content
V2BackupService passes a **native Blob** (not a blob-like with `_content`) to delivery.share(). Use `await blob.text()` to read the JSON. V1BackupService also uses native Blob for download.

In makeDelivery mocks for download tests, `blob._content` works because those tests use V2's internal file-writer which sets `_content`. But for concurrent share() tests, always use `blob.text()`.

## Correct import chain for M5-style tests
Chain readAndValidate→applyImport BEFORE the first await so the import lock is queued before setImmediate fires:

```javascript
const exportP = svc.exportBackup();
const importP = svc.readAndValidate(makeBackupFileLike())
  .then(({ sanitized }) => svc.applyImport(sanitized));
await Promise.all([exportP, importP]);
```

## Why it works
1. exportBackup queues export-read (next1).
2. importP chain is registered before `await Promise.all(...)`.
3. On suspension: microtasks run — export-read fires, delivery.share() starts, setImmediate registered, then readAndValidate resolves, applyImport queued, import lock runs.
4. setImmediate fires: share resolves, exportBackup acquires backup-write.
Result: export-read → import/undo → backup-write. ✓

**Why:**
Prevents race condition where backup-write runs before import lock is queued if test code awaits readAndValidate before applyImport.
