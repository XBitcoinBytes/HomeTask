# E2 Shadow Evidence Decision

## Decision

Step 7 intentionally retires the user-facing Upgrade Check, live shadow-status region, Share Report controls, automatic post-startup diagnostic, and Backup & Restore dialog subscriptions. The accepted v1 Backup & Restore behavior remains the product-facing path.

## Rationale

With both activation and shadow migration disabled, ordinary startup must not import or invoke diagnostic runtime code or perform shadow I/O. Removing the dormant interface keeps that disabled boundary explicit and prevents a diagnostic feature from becoming an accidental production path.

The validator, presentation, and listener-isolation modules remain pure logic. Their synthetic tests are retained because they verify safe-report eligibility and rejection behavior without loading a diagnostic UI, accessing browser storage, or changing user data.

## Safety Boundary

This decision does not change Export Backup, Import Backup, Undo, recovery controls, v1 storage, backup formats, or user data. Any future Step 8 shadow exercise must use copies and synthetic data only; it must not activate v2 or reintroduce diagnostic runtime behavior without separate approval.