---
name: v2 envelope field names
description: The v2 canonical envelope uses `prefs` not `preferences`; confusing them silently breaks isValidVerifiedWrapper and any structural shape check.
---

The v2 canonical envelope (CANONICAL_ENVELOPE_FIELDS in migrate.js) has exactly 9 fields:

  schemaVersion, state, prefs, userZones, userTasks,
  completionEvents, overrides, recentSearches, meta

**Why:** The field is `prefs` (short form), not `preferences`. This is the source of truth for any structural shape check (e.g. hasValidCandidateShape in shadow-validate.js) and any test fixture building a mock candidate.

**How to apply:**
- Any code checking candidate field presence must use `c.prefs`, not `c.preferences`.
- Test fixtures building a v2 candidate must include `prefs: {}` (not `preferences`).
- shadow-validate.js's hasValidCandidateShape already uses `prefs` (fixed in CP4C).
- v2-shadow-ui.test.mjs's makeValidWrapper uses `prefs` (fixed in CP4C).
- When writing new shape checks, cross-check against CANONICAL_ENVELOPE_FIELDS in migrate.js.
