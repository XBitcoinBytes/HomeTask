---
name: Bottom-sheet dialog pattern
description: The one reliable bottom-sheet <dialog> recipe for this project; also debounced-search state authority rule.
---

**Rule:** Every bottom-sheet `<dialog>` must follow the room-picker pattern: the dialog itself is a stable, bottom-anchored clip container (`position:fixed; inset:auto 0 0 0; max-height` with vh→svh→dvh fallbacks; `overflow:hidden`; never transformed/animated) and the entrance class goes on the *dialog* while CSS animates only the inner sheet (`.x-dialog.is-entering .x-sheet`). Scrollable body needs `flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain`.

**Why:** The search sheet originally animated/measured the sheet independently, causing "sheet outside viewport" fallbacks on iPhone; without `min-height:0` the flex body wouldn't shrink and pushed the sheet off-screen.

**How to apply:** Copy the `.rp-dialog` / `.sr-dialog` CSS block for any new sheet. Background scroll is locked via the `scrollLock` module (MutationObserver on `[open]`, body position:fixed with scroll restore) — just `scrollLock.attach(dialog)`.

**Debounced search:** treat the query state as authoritative — every empty/commit/close path must `clearTimeout` the pending debounce, and the debounce callback must reconcile against the live input value before rendering, or a stale timeout resurrects old results after Clear.
