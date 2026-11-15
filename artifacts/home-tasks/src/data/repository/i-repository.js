/**
 * i-repository.js — Authority-agnostic storage interface (IRepository).
 *
 * Both V1Repository and V2Repository implement this contract.
 * Domain services depend only on this interface; they never import a
 * concrete implementation. Bootstrap constructs the concrete class and
 * injects it via the interface.
 *
 * All write methods return { ok:true } on success or
 * { ok:false, error:string } on failure — they never throw.
 * All read methods return a value or a safe default — they never throw.
 *
 * This file contains no runtime code. It is the single source of truth
 * for the IRepository contract: method names, parameter shapes, and
 * return shapes are documented here and must not diverge in implementors.
 *
 * CP5C-A1: interface definition only. Concrete implementations and
 * app wiring are deferred to subsequent checkpoints.
 */

/**
 * @typedef {object} IRepository
 *
 * ── Tasks ──────────────────────────────────────────────────────────────
 *
 * loadTasks() → Task[]
 *   Returns the full task list merged onto the seed catalog.
 *   On a storage read failure: returns catalog defaults without writing
 *   to storage and marks the key degraded (subsequent writes blocked).
 *   On a JSON parse failure or wrong shape: calls the injected
 *   recoveryAdapter with the raw string and returns catalog defaults.
 *
 * saveTasks(taskList: Task[]) → { ok:boolean, error?:string }
 *   Serialises and persists taskList with write/readback verification.
 *   Returns { ok:false, error } when:
 *     - the underlying key is degraded (prior read threw);
 *     - the write fails (quota etc.);
 *     - the readback does not match the written bytes.
 *
 * ── Preferences ────────────────────────────────────────────────────────
 *
 * loadPrefs() → Prefs
 *   Returns merged preferences with DEFAULTS applied for missing fields.
 *   Applies the dueNowDefault → viewMode fold for v1 data.
 *   On read/parse failure: returns DEFAULTS without writing to storage.
 *
 * savePrefs(patch: Partial<Prefs>) → { ok:boolean, error?:string }
 *   Reads current prefs, applies patch, writes back with verification.
 *
 * ── Recent searches ────────────────────────────────────────────────────
 *
 * loadRecents() → string[]
 *   Returns the recent-search list, or [] on any failure.
 *
 * addRecent(query: string) → { ok:boolean, error?:string }
 *   Deduplicates case-insensitively, prepends, caps at the implementation
 *   maximum (5 for V1Repository). Empty or whitespace-only queries are
 *   silently ignored and return { ok:true }.
 *
 * clearRecents() → { ok:boolean, error?:string }
 *   Removes the recents key from storage.
 *
 * ── Last export date ───────────────────────────────────────────────────
 *
 * getLastExport() → string | null
 *   Returns the lastExport date string from the backup store, or null.
 *
 * setLastExport(dateStr: string) → { ok:boolean, error?:string }
 *   Merges dateStr into the backup store key without touching any
 *   snapshot field that may coexist in the same key.
 */

// No runtime exports. This file exists for documentation and type-annotation
// purposes only. Implementors must satisfy the contract described above.
