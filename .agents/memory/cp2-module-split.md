---
name: CP2 module split verification
description: How the HomeTask script.js → src/app/ split is guarded and how to re-verify against the pre-split baseline.
---

- The pre-split single-file baseline is git commit `17d3422` (`src/script.js`, 3,249 lines). Replit auto-checkpoints commit after every change, so "HEAD" is NOT a stable baseline — always diff against the pre-split commit for equivalence claims.
- `tests/import-order.test.mjs` is the structural guard: it statically parses the real import graph, computes ESM evaluation order, and fails if `app/startup.js` (interrupted-import rollback) would evaluate after any storage consumer, if the 19-module canonical order changes, or if any `src/v2` module becomes reachable from the entry. It includes negative self-tests. Never weaken it when adding modules — add new modules to its canonical list deliberately.
- **Why:** startup safety (staging rollback before any localStorage read) is now an emergent property of import order, not file position.
- **How to apply:** any edit to imports in `src/script.js` or `src/app/*` must keep `node tests/run-all.mjs` green (now 105 checks: backup 22 + workload 21 + v2 54 + import-order 8).
