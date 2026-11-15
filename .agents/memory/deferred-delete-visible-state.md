---
name: Deferred-delete visible state
description: Consistent UI and accessible undo rules while deletion is delayed for a reversible undo window.
---

When deletion is deferred for an undo period, every user-visible task surface must read the same pending-delete exclusion: task cards, global search, room/home summaries, totals, and workload/progress. The active modal layer must also own both its Undo action and any expiry-failure announcement.

**Why:** Hiding only the list lets a supposedly deleted record leak through search or makes visible totals disagree with the cards. A normal toast can sit behind a native dialog, making Undo or a persistence-failure error inaccessible; it can also resurface as stale state when that dialog closes.

**How to apply:** Treat the pending ID as shared presentation state, not merely a list-render detail. If another native dialog can open during the window, render task-specific Undo and failure feedback inside it, route Undo through the single controller path, and clear any page-level toast before relying on modal-layer feedback.