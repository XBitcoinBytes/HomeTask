---
name: E2 disabled startup boundary
description: Durable safety constraints for the deferred V2Repository coordinator and disabled boot path.
---

## Rule

Keep `V2_ACTIVATION_ENABLED` and `SHADOW_MIGRATION_ENABLED` as literal source-controlled `false` values until a separately authorized serving step. The v2 coordinator is dynamically loaded only after a verified `v2-authoritative` decision; its disabled path must return before accessing a backing, lock, loader, timer, or V2Repository.

**Why:** The accepted F1 path is v1-authoritative. E2 establishes the coordinator boundary without allowing hidden reads, writes, migration, recovery, or shadow diagnostics during ordinary startup.

**How to apply:** Future activation work must retain the coordinator-only V2Repository route, preserve the v1 repository and backup-facade composition in disabled mode, and extend the import/disabled-side-effect tests rather than weakening them. Do not reconnect shadow diagnostic runtime wiring without explicit approval.

## Diagnostic evidence after UI retirement

The owner approved retirement of the published Upgrade Check, shadow-status, and Share Report interface while retaining direct synthetic tests for verified-wrapper validation, presentation safety, and listener isolation.

**Why:** The runtime diagnostic would violate the disabled-startup no-import/no-I/O boundary, but its pure logic still guards safe-report eligibility and must remain independently evidenced.

**How to apply:** Keep the four disabled-isolation checks and the 25 pure synthetic checks. Do not restore automatic diagnostic startup, Backup & Restore subscriptions, or the retired UI without separate approval; future shadow work must use copies and synthetic data until a separately authorized activation step.