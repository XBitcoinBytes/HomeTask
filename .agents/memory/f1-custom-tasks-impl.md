---
name: F1 Custom Tasks Implementation
description: Architecture decisions and gotchas for the F1 custom tasks and rooms feature.
---

## Key Decisions

**CUSTOM_TASKS_UI_ENABLED flag**
- Value `true` in the accepted build (custom-tasks-config.js).
- Guards FAB, delete icons, and add-task sheet ONLY.
- `loadTasks()` append pass in v1-repository.js is UNCONDITIONAL — never gated.
- Compatibility rollback: set to `false`, rebuild, publish. Custom tasks survive in storage.

**Room names**
- Display casing preserved; trim + whitespace-collapse on input.
- Duplicate checks use `.toLowerCase()` for case-insensitive comparison.
- Custom tasks MAY be assigned to catalog rooms (no block on SEED_TASK_ROOMS membership).
- `getCustomRooms()` excludes rooms in SEED_TASK_ROOMS even when a custom task sits there.

**Duplicate rule**
- `canonical(room.toLowerCase())::normalizeTaskTitle(title).toLowerCase()` must be unique across ALL tasks.
- "Clean Oven" in "Kitchen" collides with the catalog — use unique names in tests.

**Delete UX**
- Inline confirmation row → commit immediately → 5-second toast undo.
- `_deleteSnapshot` = `tasks.getAll().slice()` captured BEFORE `removeTask`.
- `tasks.restoreFromSnapshot(snapshot)` is the undo mechanism.
- Room filter is also captured (`_deleteRoomFilter`) and restored on undo.

**ID generation**
- `crypto.randomUUID()` primary (Node 15+ / modern browsers).
- Fallback: `custom-${Date.now()}-${hex4()}${hex4()}` (injected at module load).
- Injected generator via `addTask({ ..., generator })` — used in tests and collision tests.
- MAX_ID_ATTEMPTS=10; throws `'id-generation-exhausted'` on exhaustion.

**tasks.js singleton constraint**
- `setRepo()` allows ONE initial assignment; idempotent for same object; throws on replacement.
- Each test FILE runs in its own Node.js process (via spawnSync in run-all.mjs), so each can call `setRepo()` independently.

## Files Modified/Added

- `src/app/custom-tasks-config.js` — new; exports `CUSTOM_TASKS_UI_ENABLED = true`
- `src/app/catalog.js` — added `SEED_TASK_IDS`, `SEED_TASK_ROOMS`, exported `normalizeTaskTitle`
- `src/app/tasks.js` — added `addTask`, `removeTask`, `isCustomTask`, `getCustomRooms`, `restoreFromSnapshot`, `_generateId`
- `src/data/repository/v1-repository.js` — extended `loadTasks()` with unconditional custom-task append pass
- `src/script.js` — added `import './app/custom-tasks-config.js'` between scroll-lock.js and ui.js
- `src/app/ui.js` — FAB + button in room headers, delete icon in custom cards, custom rooms in room picker and render groups
- `src/app/app.js` — delete/undo/add-task functions; fixed room-filter loading; fixed _applySrQuery grouping for custom rooms
- `index.html` — FAB, add-task dialog (bottom sheet), undo toast
- `src/style.css` — §F1 section appended (FAB, room-add-btn, btn-delete, card-row-confirm, at-dialog, ht-toast, rp-divider)
- `tests/f1-custom-tasks.test.mjs` — new; 38 checks (A–H)
- `tests/f1-ui-accessibility.test.mjs` — new; 26 checks (A–E)
- `tests/run-all.mjs` — added both new suites
- `tests/import-order.test.mjs` — updated canonical to 21 modules; added 4 F1 guards

## Test Totals After F1
26 suites · 1,470 checks (import-order grew to 29; both new suites add 64 total).

## Why: app.js room-filter bug fix
`init()` previously stripped non-catalog rooms: `ROOMS_ORDERED.includes(pref) ? pref : ''`.
Changed to: `typeof pref === 'string' ? pref : ''`.
Custom rooms in localStorage would have been silently reset without this fix.

## Why: _applySrQuery and render() grouping fix
Both used `groups.get(t.room)?.push(t)` which silently dropped custom-room tasks.
Fixed to: `if (!groups.has(t.room)) groups.set(t.room, []); groups.get(t.room).push(t);`
