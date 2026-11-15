---
name: withLockTimeout design and trailing-args gotcha
description: withLockTimeout wraps lock.runExclusive in a scheduler race. Critical: the caller must append timeoutMs,scheduler after the callback close-brace, not just change the opening line.
---

## What it does

`withLockTimeout(lock, txId, callback, timeoutMs, scheduler)` — exported from `v2-locked-import.js`.

- Calls `lock.runExclusive(txId, callback)` to get `lockPromise`
- If `timeoutMs ≤ 0`: returns `lockPromise` directly (disabled path)
- Otherwise: races `lockPromise` against `scheduler.setTimeout(..., timeoutMs)`
- On timeout: **resolves** `{ ok:false, code:'lock-timeout' }` (never rejects) so callers can use their normal `!lockResult.ok` guard
- Attaches `lockPromise.catch(() => {})` immediately to silence any late provider rejection
- Late settlement after timeout: `resolve(r)` on the already-settled outer Promise is a no-op; no unhandled rejection, no extra adapter ops

## Fail-closed routing in callers

- `runV2LockedImport` / `runV2LockedUndo`: `!lockResult.ok → { ok:false, code:'concurrency-unavailable' }`
- `recoverV2Startup`: `!lockResult.ok → { action:'coordinator-lock-denied', v2Active:false, stagingAction:'skipped' }`

## Critical gotcha — trailing arguments

When refactoring `lock.runExclusive(txId, async () => { ... })` to `withLockTimeout(...)`, the caller MUST append `, timeoutMs, scheduler)` at the callback's close-brace, not just change the opening line.

**Wrong** (looks right, silently broken):
```js
lockResult = await withLockTimeout(lock, txId, async () => {
  ...long body...
});  // ← timeoutMs, scheduler missing; withLockTimeout receives undefined → race disabled
```

**Correct:**
```js
lockResult = await withLockTimeout(lock, txId, async () => {
  ...long body...
}, timeoutMs, scheduler);  // ← trailing args here
```

**Why this fails silently:** `timeoutMs=undefined` passes the `!timeoutMs` check → returns `lockPromise` directly → the real `DEFAULT_SCHEDULER.setTimeout` is never called → `sched.pendingCount === 0` → J tests fail with "0 !== 1". No syntax error, no runtime error, no stack trace.

## Test pattern for withLockTimeout

- `MockScheduler`: captures `setTimeout` callbacks in a Map; `flush()` clears then fires all; `pendingCount` getter
- `makePendingLock()`: `{ runExclusive: () => new Promise(() => {}) }` — never settles, never calls callback
- `makeControllableLock()`: exposes `settle(v)` and `reject(e)` handles for late-settlement tests
- Assert `sched.pendingCount === 1` BEFORE flush (proves timer registered synchronously before first await)
- Assert `sched.pendingCount === 0` AFTER flush (proves timer consumed)
- After `sched.flush()` + `await pending`: assert fail-closed code; assert zero adapter ops (opCount delta = 0)
- J4/J5: call `settle()`/`reject()` on controllable lock AFTER `await pending`; drain microtasks with `nextTick()`; verify opCount unchanged
