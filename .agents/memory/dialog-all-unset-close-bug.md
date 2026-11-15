---
name: Dialog all:unset close bug
description: Using "all:unset" on a native <dialog> element breaks dialog.close() visual hiding because author styles beat UA styles.
---

## Rule
Never use `all: unset` on a native `<dialog>` element if you need `dialog.close()` to visually hide it.

## Why
The UA stylesheet contains `dialog:not([open]) { display: none; }` which fires when `close()` removes the `[open]` attribute. But `all: unset` sets all properties to their initial/inherited value at the author level. Author styles beat UA styles regardless of specificity. So `all: unset` effectively sets `display: initial` (= `inline`), which permanently overrides the UA's `display: none` — meaning the dialog stays visible even after `close()`.

The bug manifests as: `dialog.close()` runs (JS-observable via `dialog.open === false` and absence of `[open]` attribute), the dialog's internal state updates, but the element remains visibly rendered on screen.

## How to apply
- Use targeted property resets instead of `all: unset` on `<dialog>`:
  ```css
  .my-dialog {
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    max-width: unset;
    max-height: unset;
    position: fixed;
    ...
  }
  /* Belt-and-suspenders safety net */
  .my-dialog:not([open]) { display: none; }
  ```
- The animation `.is-entering` class must go on the inner **sheet** element (the visually animated child), NOT on the `<dialog>` parent — otherwise `sheet.is-entering` selector never matches and the animation never fires.

## Context
Discovered during HomeTask sprint implementing the search dialog bottom sheet. The room-picker dialog also uses `all: unset` but closing was tested separately and appears to work — possibly because the UA style wins in some browsers or the specificity interacts differently. Added explicit `:not([open]) { display: none }` as the canonical fix.
