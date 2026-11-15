# CP4A Completion Report — Final Corrected

**Date:** 2026-08-01  
**Suite result:** 368 checks · 8 suites · 0 failed  
*(114 checks in v2-shadow.test.mjs; 254 checks across all other suites)*

---

## Purpose

CP4A implements a **pure, disconnected shadow-migration runner** for the HomeTask PWA.  
It reads approved v1 localStorage keys through an injected adapter, migrates to v2, verifies semantic equivalence, and writes the shadow candidate to `hometask-v2-shadow`.  

**No runtime activation, no UI/SW/build changes, no publishing.**  
CP4B (runtime wiring behind a disabled-by-default flag) remains blocked pending CP4A approval.

---

## Runtime / build confirmation

| Item | Status |
|------|--------|
| v1 remains active (script.js, app/*.js unchanged) | ✓ |
| CP4B was not started | ✓ |
| Runtime files unchanged | ✓ |
| Build and SW remain v19 | ✓ |
| Nothing was built or published | ✓ |
| import-order structural suite enforces all of the above | ✓ |

---

## Files Added or Changed

| File | Change |
|------|--------|
| `src/v2/shadow-fingerprint.js` | Rewritten — SHA-256 (Web Crypto), length-prefixed canonical UTF-8 encoding, `isCanonicalFingerprint`, validated `fingerprintsMatch`, injected `digestFn` |
| `src/v2/shadow-migrate.js` | Updated — imports `isCanonicalFingerprint`, adds `isValidVerifiedWrapper` (6-field full validation), `ADAPTER_TIMEOUT_MS`, injected scheduler/timeout, UTF-8 byte size, `byteSize` return |
| `tests/v2-shadow.test.mjs` | Updated — 114 checks across 12 sections |
| `tests/harness-fixture-fail.mjs` | New — deliberately failing async fixture for harness self-test |
| `docs/cp4a-completion-report.md` | This file |

**Not touched:** `public/`, `dist/`, `script.js`, any `app/*.js`, service worker, build config, any deployed artifact.

---

## Correction 1 — SHA-256 replaces FNV-1a

### Specification

`shadow-fingerprint.js` now:

- Encodes the source map using a **length-prefixed UTF-8 canonical encoding**:  
  `[4B uint32 BE: key byte length] [key UTF-8] [0x00 = null | 0x01 = non-null] [4B uint32 BE: value byte length] [value UTF-8]`  
  Keys sorted alphabetically. Unambiguous for null vs `""`, delimiters in keys/values, all Unicode.
- Passes the canonical `Uint8Array` to an **injected `digestFn`** (async, environment-neutral).
- Default `digestFn` is `webCryptoDigest`: uses `globalThis.crypto.subtle.digest('SHA-256', bytes)`.  
  Available in all modern browsers and Node.js 19+. No `node:crypto` import anywhere in the module.
- Produces a **64-character lowercase hex** digest.
- SHA-256 is used as a **one-way integrity digest to detect source mutations**.  
  It is not encryption and does not prevent inspection by parties with access to the local storage.
- `sourceFingerprint` is stored in the local shadow wrapper only.  
  Excluded from any future shareable CP4E privacy-safe report unless demonstrated necessary.

### Test evidence (§1 shadow-api, §5 failure-inject, §6 privacy-scan)

| Check | Result |
|-------|--------|
| `buildCanonicalEncoding` exported, returns `Uint8Array` | ✓ |
| `webCryptoDigest` exported, returns 64-char lowercase hex | ✓ |
| `buildFingerprint` async, produces 64-char hex | ✓ |
| Identical input → identical digest (determinism) | ✓ |
| Key insertion-order independent | ✓ |
| `null` ≠ `""` — distinct digests | ✓ |
| Unicode `"café"` vs `"cafe"` — distinct digests | ✓ |
| Delimiter-like colons in key vs value → distinct digests | ✓ |
| Single-character mutation changes digest | ✓ |
| Async digest implementations awaited | ✓ |
| Digest rejection → structured failure, no shadow written | ✓ |
| Digest rejection + existing verified shadow → shadow preserved | ✓ |
| Source fingerprint is 64-char hex, contains no household content | ✓ |

---

## Correction 2 — UTF-8 byte size

### Specification

- `SHADOW_SIZE_LIMIT = 2 * 1024 * 1024` (value unchanged, **unit is now UTF-8 bytes**).
- Size check: `new TextEncoder().encode(serialized).byteLength`.
- Error message format: `shadow candidate exceeds 2097152-byte size limit (got X bytes, Y chars)`.
- Runner return value includes `byteSize: number` (UTF-8 bytes of the written wrapper).

### Test evidence (§8 utf8-size)

| Check | Result |
|-------|--------|
| `TextEncoder` byte count matches `r.byteSize` on success | ✓ |
| ASCII overflow: error message includes byte count and char count | ✓ |
| Accented chars (`café`, `résumé`): `byteLen > charLen`, reported correctly | ✓ |
| Emoji surrogate pairs: `byteLen > charLen` | ✓ |
| CJK chars (3 bytes each): char count below limit but byte count above → failure | ✓ |

---

## Correction 3 — Adapter timeout with injected scheduler

### Specification

- Exported: `ADAPTER_TIMEOUT_MS = 5_000` (production-intended, configurable).
- All adapter ops (`adapterGet`, `adapterSet`) and the digest computation use `withTimeout(promise, label, ms, scheduler)`.
- `scheduler` defaults to `{ setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }`.
- Injected mock scheduler for tests: timeouts registered synchronously, fired by `scheduler.flush()` — no real-time sleeps.
- On timeout: original promise is swallowed via `.catch(() => {})` to prevent unhandled-rejection events if it later settles.
- `timeoutMs = 0` disables timeout (passes through directly).

### Timeout behavior matrix

| Operation | Never settles | Behavior |
|-----------|---------------|----------|
| Source read | ✓ | Structured failure, v1 unchanged |
| Source digest | ✓ | Structured failure, no shadow written |
| Shadow write | ✓ | Structured failure, v1 unchanged |
| Any timeout with existing verified shadow | ✓ | Verified shadow preserved |
| Late-reject after timeout | ✓ | Swallowed by `.catch(() => {})`, no unhandled rejection |
| `timeoutMs = 0` | n/a | Timeout disabled, sync adapter passes through |

### Test evidence (§9 timeout)

| Check | Result |
|-------|--------|
| `ADAPTER_TIMEOUT_MS` ≥ 1000 ms | ✓ |
| Never-settling source read → failure via mock scheduler flush | ✓ |
| v1 source keys unchanged after read timeout | ✓ |
| Never-settling digest → failure, no shadow written | ✓ |
| Never-settling write → failure, v1 unchanged | ✓ |
| Timeout with existing verified shadow → shadow preserved | ✓ |
| Late-reject → no unhandled rejection (verified via `process.on('unhandledRejection', ...)`) | ✓ |
| `timeoutMs = 0` disables timeout | ✓ |

---

## Correction 4 — Async harness negative self-test

### Specification

`tests/harness-fixture-fail.mjs` is a standalone fixture that:
1. Defines one synchronous passing check.
2. Defines one asynchronous check that rejects after a real 20 ms delay (deliberate failure).
3. Awaits `Promise.all(_pending)` before printing the summary and calling `process.exit`.
4. Exits with code 1.

The main suite (`v2-shadow.test.mjs §10 harness-self-test`) runs this fixture as a child process via `spawnSync` and asserts exit code 1 and output includes `"1 failed"`.

The fixture is **not added to `run-all.mjs`**.

### Test evidence (§10 harness-self-test)

| Check | Result |
|-------|--------|
| Fixture exits with code 1 | ✓ |
| Fixture output includes `"1 failed"` | ✓ |

---

## Correction 5 — Failed-shadow semantics

### Specification

- A failed wrapper always has `status: "failed"`.
- CP4B promotion criteria require `status === "verified"` AND `shadowSchemaVersion === SHADOW_SCHEMA_VERSION`. A failed wrapper fails both.
- A failed run with no existing verified shadow writes a diagnostic wrapper (`status: "failed"`) for debugging.
- A failed run with an existing verified shadow preserves it untouched (`preservedExistingVerified: true`).
- A successful run overwrites a failed wrapper.

### Test evidence (§5 failure-inject, §11 failed-shadow-semantics)

| Check | Result |
|-------|--------|
| Failed wrapper has `status: "failed"`, never `"verified"` | ✓ |
| Failed wrapper does not satisfy CP4B promotion criteria | ✓ |
| Successful run overwrites a previous failed wrapper | ✓ |
| Failed run with existing verified shadow → `preservedExistingVerified: true`, shadow unchanged | ✓ |
| Wrong `shadowSchemaVersion` → not treated as verified | ✓ |

---

## Correction 6 — `fingerprintsMatch` canonical validation (final correction)

### Specification

`fingerprintsMatch(a, b)` now validates both inputs before comparing:

- Both must be strings.
- Both must be exactly 64 characters.
- Both must match `/^[0-9a-f]{64}$/` (lowercase hex only).
- **Invalid, truncated, oversized, uppercase, non-hex, null, undefined, object, or array inputs return `false`.**
- **Two identical malformed strings return `false`** (equal short strings, equal uppercase, equal non-hex all return false).
- After validation, comparison uses a **fixed-length accumulation loop** (XOR-accumulate over all 64 characters) with no early character-mismatch return, avoiding unnecessary timing variation for this fixed-length format.

New `isCanonicalFingerprint(s)` helper also exported for use in wrapper validation.

### Test evidence (§1 shadow-api)

| Check | Result |
|-------|--------|
| `isCanonicalFingerprint`: 64-char lowercase hex → true | ✓ |
| `isCanonicalFingerprint`: 63-char, 65-char → false | ✓ |
| `isCanonicalFingerprint`: uppercase hex → false | ✓ |
| `isCanonicalFingerprint`: non-hex char → false | ✓ |
| `isCanonicalFingerprint`: null, undefined, number, array, object → false | ✓ |
| Equal valid 64-char lowercase SHA-256 digests → true | ✓ |
| Different valid digests → false | ✓ |
| Equal short strings → false | ✓ |
| 63-char values → false | ✓ |
| 65-char values → false | ✓ |
| Uppercase hexadecimal → false | ✓ |
| Non-hex characters → false | ✓ |
| null, undefined, numbers, arrays, objects → false | ✓ |
| Two equal malformed values → false | ✓ |

---

## Correction 7 — Full existing-wrapper validation before preservation

### Specification

Before treating an existing shadow as a protected verified candidate, `isValidVerifiedWrapper(w)` validates all six conditions:

1. `shadowSchemaVersion === SHADOW_SCHEMA_VERSION`
2. `status === 'verified'`
3. `sourceFingerprint` passes `isCanonicalFingerprint` (64-char lowercase hex)
4. `targetSchema === 2`
5. `candidate` passes `validateEnvelope()` (full 9-field canonical v2 envelope check)
6. `verificationSummary` is a valid object with `unexpectedDiffCount === 0` and `diffCategoryCodes.length === 0`

A malformed wrapper is **never protected** solely because it claims `status: "verified"`, contains equal malformed fingerprint strings, or passes any subset of the conditions.

### Test evidence (§11 failed-shadow-semantics — regression tests)

| Check | Result |
|-------|--------|
| Malformed "verified" wrapper with short `sourceFingerprint` (`"abc"`) → not trusted | ✓ |
| Wrapper with canonical fingerprint but invalid candidate (missing 8 of 9 envelope fields) → not trusted | ✓ |
| Genuinely valid verified wrapper passes full validation and is protected from failed rerun | ✓ |

---

## Runtime disconnection evidence (§12)

- `script.js` does not import `shadow-migrate` or reference `hometask-v2-shadow`.
- No `app/*.js` module imports or references either.
- `shadow-fingerprint.js` has zero imports (no `node:crypto`, no DOM access).
- `shadow-migrate.js` only imports from pure v2 modules; does not use `localStorage.`, `sessionStorage.`, `document.`, or `new Date()`.
- Enforced independently by `import-order.test.mjs` (structural graph traversal).

---

## Full suite summary

```
════════════════════════════════════════
 backup.test.mjs       22 passed, 0 failed
 workload.test.mjs     21 passed, 0 failed
 v2.test.mjs           54 passed, 0 failed
 import-order.test.mjs 11 passed, 0 failed
 v2-backup.test.mjs   100 passed, 0 failed
 v2-tx.test.mjs        37 passed, 0 failed
 v2-tripwire.test.mjs   9 passed, 0 failed
 v2-shadow.test.mjs   114 passed, 0 failed
────────────────────────────────────────
 ALL SUITES PASSED     368 total, 0 failed
════════════════════════════════════════
```
