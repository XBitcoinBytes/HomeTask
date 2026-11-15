---
name: HomeTask v1 storage quirks that migration must honor
description: Non-obvious v1 load semantics discovered while building the v2 migration layer; the equivalence audit depends on them.
---

- v1 load coerces `doneToday` with `Boolean()` (not `=== true`) when `lastDone === today` — truthy non-booleans count as done. Migration must match, or equivalence fails.
- v1 does NOT sanitize stored task fields: a non-date `lastDone` string survives load, feeds NaN date math, and classifies as 'overdue'. Migration repairs this deliberately; the equivalence test asserts these exact documented repair diffs instead of zero diffs.
- v1 `meta.load` keeps a bogus `viewMode` (only backup import sanitizes). Migration sanitizes → another documented repair.
- **Why:** any future migration/audit code (CP4 shadow audit) that assumes "clean v1 data" will report false mismatches or, worse, mask real ones.
- **How to apply:** when comparing v1↔v2 worlds, use `tests/v2.test.mjs`'s pattern — strict zero-diff for clean fixtures, exact allowed-diff list for malformed fixtures. The reverse migration's supported domain must reject unknown/duplicate/retired state IDs explicitly, never drop them.
