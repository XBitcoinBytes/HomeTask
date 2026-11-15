---
name: Release identity files — what to update on each build bump
description: Every file that must be updated together when bumping the HomeTask build label and SW cache version.
---

## Files to update on every version bump

| File | What to change | Example |
|---|---|---|
| `src/script.js` line ~11 | `APP_BUILD = 'vXX-...'` | `'v21-repository-test'` |
| `public/sw.js` line ~2 | comment header cache name | `Cache: hometask-v21-repository-test` |
| `public/sw.js` line ~16 | `const CACHE = '...'` | `'hometask-v21-repository-test'` |
| `index.html` line ~436 | `Build vXX-...` visible label in Backup sheet | `Build v21-repository-test` |
| `tests/sw-install.test.mjs` line ~25 | `const CACHE_NAME = '...'` | `'hometask-v21-repository-test'` |
| `tests/sw-install.test.mjs` line ~240 | test 8 description string | update to match new name |

**Why:** The sw-install test hardcodes CACHE_NAME independently of reading sw.js. All 5 locations must be in sync or sw-install tests fail with ~11 failures. The index.html build label is user-visible in the Backup & Restore sheet bottom.

**How to apply:** On every build bump, grep for the old version string and replace all 6 occurrences. Run `node tests/run-all.mjs` before building to catch mismatches.
