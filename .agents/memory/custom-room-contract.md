---
name: Explicit custom-room storage
description: Why custom rooms use a dedicated v1 key and how future room lifecycle changes should preserve it.
---

Explicit custom rooms are stored under a dedicated `hometask-rooms-v1` envelope, separate from the task array. The envelope contains ordered `{id, name, _customRoom}` records; missing records remain compatible with older installs, while task-derived rooms preserve legacy behavior.

**Why:** The historic `hometask-v1` value is assumed to contain task records everywhere in the v1 load, backup, and migration paths. Embedding room records there would risk silently dropping or misreading data.

**How to apply:** Include the room key in every v1 backup snapshot, staging write, commit, rollback, and startup-recovery key list. Validate room records individually, reject built-in-name masquerades, and use save-before-commit copy-on-write for room mutations.