---
name: shadow-config flag and coupled tests
description: Several tests assert the exact value of SHADOW_MIGRATION_ENABLED; they must be updated whenever the flag changes between true/false.
---

Tests that are tightly coupled to the SHADOW_MIGRATION_ENABLED value and must be updated on any flag change:

1. **import-order.test.mjs** — check 13: asserts the source string `= true` or `= false`.
2. **v2-shadow-bridge.test.mjs** — three checks in the `structural` and `boot-sequencing` sections:
   - "SHADOW_MIGRATION_ENABLED is [true/false] for CP4C test build" — asserts the imported value
   - source check — string-searches shadow-config.js for `= true` / `= false`
   - default-call behavior — `maybeShadowMigrate({})` returns `disabled` when false, `failed` when true (no adapter)

**Why:** The tests use raw `content.includes('= false')` and imported-value equality, not a configurable constant, so they fail silently if the flag changes without a test update.

**How to apply:** Before toggling SHADOW_MIGRATION_ENABLED, grep for `= false` / `= true` in test files and update all three locations above to match.
