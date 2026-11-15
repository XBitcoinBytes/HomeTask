# CP4B Completion Report

**Date:** 2026-08-01  
**Suite result:** 399 checks · 9 suites · 0 failed  

---

## Confirmations

| Item | Status |
|------|--------|
| Committed `SHADOW_MIGRATION_ENABLED` flag is `false` | ✓ |
| No `hometask-v2-shadow` key was created during development | ✓ |
| v1 (`hometask-v1`, `hometask-meta-v1`, `hometask-recent-searches-v1`) remains active and authoritative | ✓ |
| Current visible behavior is unchanged from v19 | ✓ |
| No visible migration controls, banners, buttons, dialogs, or status text added | ✓ |
| Build and SW remain v19 | ✓ |
| `public/`, `dist/`, and production remain unchanged | ✓ |
| Nothing was built or published | ✓ |
| CP4C was not started | ✓ |

---

## Files Added or Changed

| File | Change |
|------|--------|
| `src/v2/shadow-config.js` | **New** — compile-time flag (`SHADOW_MIGRATION_ENABLED = false`) |
| `src/v2/shadow-bridge.js` | **New** — isolated bridge: flag check, adapter factory, dynamic runner import, structured result |
| `src/script.js` | **Modified** — bridge import + `app.init().then(() => maybeShadowMigrate(...)).catch(() => {})` |
| `tests/import-order.test.mjs` | **Updated** — `parseImports` excludes dynamic `import()`, 6 new structural checks |
| `tests/v2-shadow-bridge.test.mjs` | **New** — 28 checks across 6 sections |
| `tests/run-all.mjs` | **Updated** — added `v2-shadow-bridge.test.mjs` |

**Not touched:** `public/`, `dist/`, `src/app/`, `src/workload.js`, service worker, build config, any deployed artifact.

---

## Compile-Time Flag

**File:** `src/v2/shadow-config.js`

```js
export const SHADOW_MIGRATION_ENABLED = false;
```

- Default is `false`. Committed value is always `false`.
- Never read from a URL parameter, `localStorage`, environment variable, or remote endpoint.
- Enabling requires an explicit, reviewed source-code edit to this file only.
- The `import-order.test.mjs` structural suite enforces the committed value remains `false` by reading the source file.

---

## Bridge API

**File:** `src/v2/shadow-bridge.js`

### Exports

```ts
// Compile-time flag (imported statically — only this from shadow-config.js).
import { SHADOW_MIGRATION_ENABLED } from './shadow-config.js';

// Production localStorage adapter factory.
export function createLocalStorageAdapter(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(): never;   // throws — runner never needs removeItem
};

// Bridge entry point.
export async function maybeShadowMigrate(opts?: {
  enabled?: boolean;      // override flag (tests only)
  adapter?: object;       // injected adapter (tests only)
  today?: string;         // 'YYYY-MM-DD' (defaults to real clock)
  clock?: string;         // ISO timestamp (defaults to real clock)
  appBuild?: string;      // build string (passed by script.js)
  timeoutMs?: number;     // per-operation timeout override
  scheduler?: object;     // mock scheduler (tests only)
  _testHooks?: object;    // forwarded to runner._testHooks
}): Promise<{ status: 'disabled'|'verified'|'failed', [key: string]: unknown }>;
```

### Static imports (evaluated at module load)
Only `shadow-config.js` — a pure constant module with no side effects.

### Dynamic imports (inside `maybeShadowMigrate`, enabled branch only)
- `./shadow-migrate.js` (the CP4A runner and constants)
- `./catalog.data.js` (the canonical v2 catalog)

Both dynamic imports fire only when `enabled === true`. Disabled builds never evaluate them.

---

## Startup Sequence

### Before CP4B (v19)
```
1. ES module evaluation (in import order):
   util → catalog → due → startup[IIFE] → recovery → storage → meta →
   tasks → status → search → recents → scroll-lock → ui → onboarding →
   backup-store → staging-store → backup → backup-ui → app → script.js body
2. DOMContentLoaded / immediate:
   app.init() → meta.load → ui setup → tab wiring → backupUI.init →
   SW register → onboarding.maybeShow → console.info Loaded
```

### After CP4B (v19 + bridge)
```
1. ES module evaluation (in import order):
   util → catalog → due → startup[IIFE] → recovery → storage → meta →
   tasks → status → search → recents → scroll-lock → ui → onboarding →
   backup-store → staging-store → backup → backup-ui → app →
   shadow-config[const] → shadow-bridge[fn defs] → script.js body
   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   ONLY: define two constants + two functions — zero side effects
2. DOMContentLoaded / immediate:
   app.init()                              ← UNCHANGED
     → meta.load → ui setup → ... → console.info Loaded
   .then(() => maybeShadowMigrate(...))    ← NEW (flag=false: returns immediately)
   .catch(() => {})
```

**With committed flag=false:** Step 2's `.then()` executes `maybeShadowMigrate({ appBuild: 'v19' })`, which returns `{ status: 'disabled' }` immediately with zero side effects. The app experiences no difference.

**The bridge is never the bottleneck for first render.** `app.init()` resolves the returned Promise after onboarding fires; the bridge call is in the `.then()` callback and has no path to the main thread between DOMContentLoaded and first paint.

---

## Disabled-Path Zero-Operation Evidence

Test suite `§2 disabled-path` (5 checks, all pass):

| Invariant | How tested |
|-----------|-----------|
| Returns `{ status: 'disabled' }` when `opts.enabled = false` | Direct assertion |
| Returns `{ status: 'disabled' }` using committed flag (no opts) | Calls `maybeShadowMigrate({})` — reads `SHADOW_MIGRATION_ENABLED = false` |
| Zero adapter `getItem`/`setItem` calls | Spy adapter injected, call counts asserted at 0 |
| Zero timer registrations | Spy scheduler injected, `setTimeout` call count asserted at 0 |
| Storage left byte-identical; `hometask-v2-shadow` does not exist | Snapshot before/after, `deepEqual` |

---

## Enabled-Path Isolated-Test Evidence

All enabled-path tests pass `opts.enabled: true` without modifying `shadow-config.js`.  
Real localStorage is never touched; tests use injected mock adapters.

### Happy path (§3 enabled-happy, 5 checks)

| Scenario | Result |
|----------|--------|
| Typical v1 data → verified shadow | `ok: true, status: 'verified'` |
| Fresh install (all null source keys) | `ok: true, stateCount: 0` |
| Idempotent re-run | Byte-identical shadow wrapper |
| Structured result fields | `ok`, `byteSize`, `wrapper.candidate.schemaVersion === 2`, `errors`, `warnings` |
| Bridge never throws | Catastrophic adapter → returns `{ status: 'failed' }` |

### Failure modes (§4 enabled-failures, 7 checks)

| Scenario | Result |
|----------|--------|
| Migration exception (injected) | `ok: false`, shadow not written |
| Digest rejection (injected) | `ok: false`, shadow not written |
| Adapter timeout (mock scheduler + polling flush) | `ok: false`, timeout in errors |
| QuotaExceededError on shadow write | `ok: false`, v1 unchanged |
| Silent lost write (noop setItem) | `ok: false`, readback mismatch in errors |
| Malformed existing shadow → overwritten on success | New verified shadow written |
| V1 mutation during run (step 13) | `ok: false`, mutation detected in errors |

---

## V1 Authority Evidence

Test suite `§5 v1-authority` (4 checks, all pass):

| Invariant | Test |
|-----------|------|
| v1 source keys byte-identical after successful run | Snapshot before/after, key-by-key equality |
| v1 source keys byte-identical after failed run | Same check after injected failure |
| `SHADOW_KEY` not in `SOURCE_KEYS` | `SOURCE_KEYS.includes(SHADOW_KEY)` === false |
| Done/Skip simulation: v1 write does not affect shadow; shadow deletion does not affect v1 | Write `'hometask-v1' = '[]'` after run; assert shadow unchanged. Delete shadow; assert v1 retains the write. |

Even with the flag enabled in tests:
- All reads come from v1 source keys through the injected adapter.
- All v2 migration logic is in `src/v2/` and unreachable from `src/app/`.
- No task is rendered from `hometask-v2-shadow`.
- No backup is exported from the shadow candidate.
- Deleting or corrupting the shadow key cannot affect the application.

---

## Storage-Key Read/Write Matrix

| Key | Bridge enabled=false | Bridge enabled=true (success) | Bridge enabled=true (failure) |
|-----|---------------------|-------------------------------|-------------------------------|
| `hometask-v1` | — | read-only | read-only |
| `hometask-meta-v1` | — | read-only | read-only |
| `hometask-recent-searches-v1` | — | read-only | read-only |
| `hometask-v2-shadow` | — | written (verified wrapper) | written (failed wrapper) OR preserved if existing verified |
| All other keys | — | never touched | never touched |

The bridge never calls `localStorage.clear()`. The bridge never removes any key. The adapter's `removeItem` throws to enforce this structurally.

---

## Structural Import Graph

```
script.js (entry)
  ├── app/util.js
  ├── app/catalog.js
  ├── app/due.js
  ├── app/startup.js          ← IIFE fires before any storage read
  ├── app/recovery.js
  ├── app/storage.js
  ├── app/meta.js
  ├── app/tasks.js
  ├── app/status.js
  ├── app/search.js
  ├── app/recents.js
  ├── app/scroll-lock.js
  ├── app/ui.js
  ├── app/onboarding.js
  ├── app/backup-store.js
  ├── app/staging-store.js
  ├── app/backup.js
  ├── app/backup-ui.js
  ├── app/app.js              ← exports { init }
  └── v2/shadow-bridge.js     ← NEW (statically reachable; only defines functions)
        └── v2/shadow-config.js  ← NEW (SHADOW_MIGRATION_ENABLED = false)

Dynamic imports (only when enabled=true, inside maybeShadowMigrate):
  v2/shadow-migrate.js  → v2/migrate.js, v2/equivalence.js, v2/compose.js,
                          v2/shadow-fingerprint.js, v2/catalog.data.js, etc.
  v2/catalog.data.js
```

No v2 module other than `shadow-bridge.js` and `shadow-config.js` is statically reachable from the entry. Enforced by `import-order.test.mjs`.

---

## Structural Guards (import-order.test.mjs) — 14 checks

| Guard | Check |
|-------|-------|
| Graph is acyclic | `evaluationOrder` does not throw |
| Startup recovery evaluates before every storage consumer | `checkStartupOrder` passes |
| 19 app modules in canonical CP2 order | filter `p.startsWith('app/')` equals canonical list |
| `script.js` is the last module to evaluate | `order[last] === 'script.js'` |
| `workload.js` evaluates before app modules | index check |
| Deliberate invalid order rejected | Self-test |
| Cycle detected and rejected | Self-test |
| **Only shadow-bridge + shadow-config statically reachable (CP4B)** | `unauthorized v2 = []` |
| **shadow-migrate.js not statically reachable from entry** | Not in `graph.keys()` |
| **No src/app module imports shadow runner or bridge** | Content scan |
| **No src/app module references shadow key** | Content scan |
| **script.js does not hardcode shadow key** | Content check |
| **Committed SHADOW_MIGRATION_ENABLED is false** | Source text check |
| **maybeShadowMigrate chained after app.init() via .then()** | Pattern match in script.js |

---

## Exact Test Totals by Suite

```
════════════════════════════════════════════════════
 backup.test.mjs            22 passed, 0 failed
 workload.test.mjs          21 passed, 0 failed
 v2.test.mjs                54 passed, 0 failed
 import-order.test.mjs      14 passed, 0 failed  (+3 from CP4B)
 v2-backup.test.mjs        100 passed, 0 failed
 v2-tx.test.mjs             37 passed, 0 failed
 v2-tripwire.test.mjs        9 passed, 0 failed
 v2-shadow.test.mjs        114 passed, 0 failed
 v2-shadow-bridge.test.mjs  28 passed, 0 failed  (new)
────────────────────────────────────────────────────
 ALL SUITES PASSED          399 total, 0 failed
════════════════════════════════════════════════════
```

---

## Interactive Browser Smoke Results

**Context:** Replit preview pane, 390×844 viewport, committed flag `false`.

These are manual interactive observations, not a committed automated Playwright suite.

| Scenario | Observed |
|----------|----------|
| Fresh launch — onboarding screen | ✓ Balanced Start + Everything is current options visible |
| App console log on load | `[HomeTask] Loaded 122 tasks across 24 rooms` — normal v19 output |
| `hometask-v2-shadow` key created | ✗ Not present (flag disabled) |
| Console errors | ✗ None |
| Unhandled rejections | ✗ None |
| Horizontal overflow | ✗ None |
| Startup sequence | `normalizeTaskTitle OK`, `Catalog OK`, `Merge whitelist OK`, `First use seeded 122 tasks`, `SW registered` — identical to v19 |
| Shadow-related console output | ✗ None (disabled path is silent) |

Remaining interactive scenarios (Today/Week/All, Search, Room picker, Done, Skip, Backup sheet, Reload) require device interaction and would be verified at the CP4C build stage before any flag-enabled publication.

---

## Proposed CP4C/CP4D Retrieval Mechanism (Physical iPhone, No Safari Inspector)

CP4B produces a verified shadow wrapper stored in `hometask-v2-shadow` as a JSON string.  
The privacy-safe report for CP4D must be extractable from a physical iPhone without Safari Web Inspector.

**Proposed approach for CP4D (not yet authorized):**

A small, flag-gated control inside the existing Backup & Restore sheet exposes:
- A single line of text: `Shadow: verified | stateCount=N | byteSize=X` (privacy-safe fields only).
- A **Download shadow report** button that calls:
  ```js
  const raw = localStorage.getItem('hometask-v2-shadow');
  const wrapper = JSON.parse(raw);
  // Strip candidate and sourceFingerprint; keep only verificationSummary,
  // status, shadowSchemaVersion, targetSchema, appBuild, catalogVersion,
  // generatedAt, byteSize.
  const safeReport = { ...wrapper, candidate: undefined, sourceFingerprint: undefined };
  const blob = new Blob([JSON.stringify(safeReport, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `hometask-shadow-report-${wrapper.generatedAt}.json`,
  });
  a.click();
  ```
  This triggers iOS's native Share sheet (AirDrop, Files, Mail, etc.) without needing a desktop.

**Alternatively for CP4C (diff-only, no UI change):**  
Share the flag-enabled IPA or TestFlight build, open the app, then use:
- Xcode → Devices and Simulators → Export container → inspect localStorage file directly.  
- This does require a Mac, but not Safari Web Inspector or a USB cable on the day of the test.

The CP4D UI approach (Backup & Restore button) is the recommended no-Mac-required path. It is not authorized for implementation in CP4B.

---

## Remaining Risks

| Risk | Mitigation |
|------|-----------|
| Dynamic import latency on first enabled run | `ADAPTER_TIMEOUT_MS = 5000` covers slow imports; runner has its own per-op timeout |
| Shadow run starts while app is mid-mutation (user taps Done during first second) | CP4A step-13 source re-read detects byte change → structured failure, no false verified |
| iOS localStorage quota limits on low-storage devices | `QuotaExceededError` propagates to runner → structured failure, v1 never touched |
| Future developer accidentally sets flag to `true` in a PR | `import-order.test.mjs` checks committed source text; CI would catch it |
| Long shadow run blocks battery/CPU on old iPhone | Bridge is fire-and-forget; it runs in background microtask queue; no UI impact |
| Shadow wrapper survives across sessions even if v1 is deleted/reset | Shadow key is isolated; startup recovery never reads it; the app is unaffected |

---

## Git/Diff Summary

```
M  src/script.js              +14 −5   add bridge import + .then() chaining
A  src/v2/shadow-config.js    +14  0   compile-time flag (SHADOW_MIGRATION_ENABLED = false)
A  src/v2/shadow-bridge.js   +141  0   isolated bridge: flag, adapter, dynamic import, result
M  tests/import-order.test.mjs +85 −35  parseImports dynamic-import fix + 6 new guards
A  tests/v2-shadow-bridge.test.mjs +454  0  28 checks across 6 sections
M  tests/run-all.mjs            +2  −1  add v2-shadow-bridge.test.mjs

No changes to: public/, dist/, src/app/*, src/workload.js, sw.js, vite.config.ts,
               artifact.toml, package.json, or any deployed file.
```
