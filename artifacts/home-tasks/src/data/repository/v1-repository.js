/**
 * v1-repository.js — V1Repository: authority-agnostic v1 storage implementation.
 *
 * Exact behavioral parity with the current production modules:
 *   storage.js   → loadTasks / saveTasks
 *   meta.js      → loadPrefs / savePrefs
 *   recents.js   → loadRecents / addRecent / clearRecents
 *   backup-store.js → getLastExport / setLastExport
 *
 * Key hardening over the production modules:
 *   1. Read failures are distinguished from missing keys.
 *      A thrown getItem() is never converted to null; doing so could make
 *      a transient storage failure look like first use and seed the catalog
 *      over existing data. On read error: return safe defaults, do not write,
 *      mark the key degraded.
 *   2. Valid JSON with wrong shape is handled safely.
 *      Non-array tasks / non-object prefs / non-array recents trigger the
 *      recovery path rather than letting .map()/.filter() throw.
 *   3. Malformed task entries within a valid array are skipped; neighbours survive.
 *   4. Write errors are returned to the caller instead of silently logged.
 *   5. Degraded keys are write-protected until a successful read clears the flag.
 *
 * Pure module: no localStorage, no DOM, no clock reads.
 * No imports of tasks.js, meta.js, recents.js, storage.js, or backup-store.js.
 * All impure inputs — backing store, catalog, today, recoveryAdapter — are injected.
 *
 * Imports: v1-adapter.js only (Layer 0 wrapper). Zero Layer 7+ imports.
 */

import { createV1StorageAdapter } from './v1-adapter.js';
import { sanitizeCustomRecord } from '../custom-record.js';
import { sanitizeCustomRoomState, serializeCustomRoomState } from '../custom-room-record.js';

/* ── Storage keys (match production modules exactly) ─────────────────── */

const TASKS_KEY   = 'hometask-v1';
const ROOMS_KEY   = 'hometask-rooms-v1';
const META_KEY    = 'hometask-meta-v1';
const RECENTS_KEY = 'hometask-recent-searches-v1';
const BACKUP_KEY  = 'hometask-backup-v1';

const RECENTS_MAX = 5;   // exact port of recentSearches.MAX

/**
 * Preference defaults — exact port of meta.js DEFAULTS.
 * dueNowDefault is retained for migration fold; viewMode is the live field.
 */
const PREFS_DEFAULTS = Object.freeze({
  onboarded:     false,
  choice:        null,
  completedAt:   null,
  dueNowDefault: false,
  viewMode:      'today',
  roomFilter:    '',
});

/* ── V1Repository ─────────────────────────────────────────────────────── */

export class V1Repository {
  /**
   * @param {object} opts
   * @param {{ getItem(k:string):string|null,
   *            setItem(k:string,v:string):void,
   *            removeItem(k:string):void }} opts.backing
   *   Raw storage backing. Production: localStorage adapter.
   *   Tests: Map-backed fake.
   *
   * @param {Array<{
   *   id:string, title:string, room:string, intervalDays:number,
   *   tags:string[], lastDone:string|null, doneToday:boolean,
   *   skipUntil:string|null
   * }>} opts.catalog
   *   Seed task array in the v1 SEED_TASKS shape. Injected for testability.
   *   Production: SEED_TASKS from catalog.js.
   *
   * @param {function(): string} opts.todayFn
   *   Returns 'YYYY-MM-DD'. Injected so tests can control the date.
   *   Production: () => todayStr().
   *
   * @param {{ save(sourceKey:string, rawStr:string): void }} [opts.recoveryAdapter]
   *   Called when a storage key fails JSON.parse or has the wrong shape.
   *   Default: no-op (safe for callers that do not need recovery evidence).
   *   Production: wraps recoveryStore.save().
   */
  constructor({ backing, catalog, todayFn, recoveryAdapter = { save() {} } }) {
    this._adapter  = createV1StorageAdapter(backing);
    this._catalog  = catalog;
    this._todayFn  = todayFn;
    this._recovery = recoveryAdapter;
    this._customRooms = null;
    /**
     * Keys whose last read threw. Writes to these keys are blocked until a
     * subsequent loadTasks/loadPrefs/etc. call reads successfully and clears
     * the flag. This prevents overwriting unknown existing data with defaults
     * after a transient storage failure.
     * @type {Set<string>}
     */
    this._degraded = new Set();
  }

  /* ── Tasks ─────────────────────────────────────────────────────────── */

  /**
   * Load tasks — exact port of storage.load().
   *
   * Merge rules (seed is always authoritative for catalog fields):
   *   - First use (key absent): seed from catalog, write to storage, return seeded list.
   *   - Read error (threw): return catalog defaults; do NOT seed or write; mark degraded.
   *   - Parse error or wrong shape: call recoveryAdapter; return catalog defaults.
   *   - Normal load: spread seed first, then overlay only the four user-state fields
   *     (lastDone, doneToday, skipUntil, tags). All catalog fields are authoritative.
   *   - doneToday normalization: s.lastDone === today ? Boolean(s.doneToday) : false.
   *   - Malformed task entries (no id, non-object, null, array) are skipped silently;
   *     those tasks receive catalog defaults. Neighbouring valid entries survive.
   *
   * @returns {Array} merged task list, length always equals catalog.length
   */
  loadTasks() {
    const read = this._adapter.tryRead(TASKS_KEY);

    if (read.status === 'error') {
      // Storage threw — cannot distinguish missing from present.
      // Do NOT seed or write; mark degraded so subsequent saveTasks fail calmly.
      this._degraded.add(TASKS_KEY);
      return this._catalog.map(t => ({ ...t }));
    }

    // A successful read (ok or missing) clears any prior degraded state.
    this._degraded.delete(TASKS_KEY);

    if (read.status === 'missing') {
      // First use — seed from catalog and persist.
      const seeded = this._catalog.map(t => ({ ...t }));
      this._adapter.setAndVerify(TASKS_KEY, JSON.stringify(seeded));
      return seeded;
    }

    // Key present — parse.
    let saved;
    try {
      saved = JSON.parse(read.value);
    } catch {
      // Damaged JSON — preserve evidence, return catalog defaults.
      this._recovery.save(TASKS_KEY, read.value);
      return this._catalog.map(t => ({ ...t }));
    }

    // Harden: valid JSON but wrong shape (object, null, string, number, boolean).
    // Never call .map() on non-arrays — it would throw and silently lose data.
    if (!Array.isArray(saved)) {
      this._recovery.save(TASKS_KEY, read.value);
      return this._catalog.map(t => ({ ...t }));
    }

    const today = this._todayFn();

    // Build savedMap — skip malformed entries without throwing.
    // A malformed entry means that task falls back to catalog defaults.
    const savedMap = new Map();
    for (const t of saved) {
      if (
        t !== null &&
        typeof t === 'object' &&
        !Array.isArray(t) &&
        typeof t.id === 'string' &&
        t.id.length > 0
      ) {
        savedMap.set(t.id, t);
      }
      // Malformed entries are silently skipped; their task IDs receive seed defaults below.
    }

    // Exact port of storage.load() merge.
    // Seed is spread first so ALL catalog fields are authoritative.
    // Only the four user-state fields are overlaid from storage.
    const catalogResult = this._catalog.map(seed => {
      const s = savedMap.get(seed.id);
      if (!s) return { ...seed };
      return {
        ...seed,                                                     // catalog fields always win
        lastDone:  s.lastDone  ?? null,
        doneToday: s.lastDone === today ? Boolean(s.doneToday) : false,  // exact v1 rule
        skipUntil: s.skipUntil ?? null,
        tags:      Array.isArray(s.tags) ? s.tags : [],
      };
    });

    // Unconditional custom-task append pass.
    // NEVER gated by CUSTOM_TASKS_UI_ENABLED — custom records survive every
    // build variant, compatibility rollback, and backup/restore cycle.
    // The pure custom-record boundary preserves safe future fields, rejects
    // malformed/unsafe records, prevents seed-ID masquerading, and makes
    // duplicate custom IDs deterministic: first valid record wins.
    const customTasks = [];
    const seenCustomIds = new Set();
    const seedIds = new Set(this._catalog.map(task => task.id));
    for (const savedRecord of saved) {
      const custom = sanitizeCustomRecord(savedRecord, { today, seedIds });
      if (!custom || seenCustomIds.has(custom.id)) continue;
      seenCustomIds.add(custom.id);
      customTasks.push(custom);
    }
    return [...catalogResult, ...customTasks];
  }

  /**
   * Persist task list — exact port of storage.save()/_write().
   * Returns { ok, code?, message? } instead of silently swallowing errors.
   *
   * @param {Array} taskList
   * @returns {{ ok:true }|{ ok:false, error:string }}
   */
  saveTasks(taskList) {
    if (this._degraded.has(TASKS_KEY)) {
      return { ok: false, error: `read-error-degraded:${TASKS_KEY}` };
    }
    const r = this._adapter.setAndVerify(TASKS_KEY, JSON.stringify(taskList));
    return r.ok ? { ok: true } : { ok: false, error: r.code ?? r.message };
  }

  /* ── Explicit custom rooms ─────────────────────────────────────── */

  /**
   * Load standalone custom-room records. Missing key is a compatible legacy
   * state and returns []; invalid neighboring records are skipped individually.
   */
  loadCustomRooms() {
    const read = this._adapter.tryRead(ROOMS_KEY);
    const seedRooms = new Set(this._catalog.map(task => task.room.toLowerCase()));

    if (read.status === 'error') {
      this._degraded.add(ROOMS_KEY);
      this._customRooms = [];
      return [];
    }
    this._degraded.delete(ROOMS_KEY);
    if (read.status === 'missing') {
      this._customRooms = [];
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(read.value);
    } catch {
      this._recovery.save(ROOMS_KEY, read.value);
      this._customRooms = [];
      return [];
    }
    this._customRooms = sanitizeCustomRoomState(parsed, { seedRooms });
    return this._customRooms.map(room => ({ ...room }));
  }

  /**
   * Persist the complete explicit-room set. Task writes remain independent so
   * normal task mutations cannot remove an empty room.
   */
  saveCustomRooms(roomList) {
    if (this._degraded.has(ROOMS_KEY)) {
      return { ok: false, error: `read-error-degraded:${ROOMS_KEY}` };
    }
    const seedRooms = new Set(this._catalog.map(task => task.room.toLowerCase()));
    const raw = serializeCustomRoomState(roomList, { seedRooms });
    const r = this._adapter.setAndVerify(ROOMS_KEY, raw);
    if (!r.ok) return { ok: false, error: r.code ?? r.message };
    this._customRooms = sanitizeCustomRoomState(JSON.parse(raw), { seedRooms });
    return { ok: true };
  }

  /* ── Preferences ────────────────────────────────────────────────────── */

  /**
   * Load preferences — exact port of meta.load().
   *
   * Merge rules:
   *   - Key absent: return DEFAULTS (no write).
   *   - Read error: return DEFAULTS; mark degraded; do NOT write.
   *   - Parse error or wrong shape: call recoveryAdapter; return DEFAULTS.
   *   - Normal load: spread DEFAULTS then saved; apply dueNowDefault→viewMode fold
   *     when viewMode is absent in the saved record (exact port of lines 39–43).
   *
   * @returns {object}
   */
  loadPrefs() {
    const read = this._adapter.tryRead(META_KEY);

    if (read.status === 'error') {
      this._degraded.add(META_KEY);
      return { ...PREFS_DEFAULTS };
    }
    this._degraded.delete(META_KEY);

    if (read.status === 'missing') {
      return { ...PREFS_DEFAULTS };
    }

    let saved;
    try {
      saved = JSON.parse(read.value);
    } catch {
      this._recovery.save(META_KEY, read.value);
      return { ...PREFS_DEFAULTS };
    }

    // Harden: valid JSON but wrong shape (array, string, null, number, boolean).
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      this._recovery.save(META_KEY, read.value);
      return { ...PREFS_DEFAULTS };
    }

    const merged = { ...PREFS_DEFAULTS, ...saved };

    // dueNowDefault → viewMode fold — exact port of meta.load() lines 39–43.
    // Only applies when viewMode is absent or falsy in the raw saved object.
    if (!saved.viewMode) {
      if      (saved.dueNowDefault === true)  merged.viewMode = 'week';
      else if (saved.dueNowDefault === false) merged.viewMode = 'all';
      else                                    merged.viewMode = 'today';
    }

    return merged;
  }

  /**
   * Save preferences — exact port of meta.save().
   * Reads current prefs, applies patch, writes the merged result.
   *
   * @param {object} patch
   * @returns {{ ok:true }|{ ok:false, error:string }}
   */
  savePrefs(patch) {
    if (this._degraded.has(META_KEY)) {
      return { ok: false, error: `read-error-degraded:${META_KEY}` };
    }
    const current = this.loadPrefs();
    const r = this._adapter.setAndVerify(META_KEY, JSON.stringify({ ...current, ...patch }));
    return r.ok ? { ok: true } : { ok: false, error: r.code ?? r.message };
  }

  /* ── Recent searches ────────────────────────────────────────────────── */

  /**
   * Load recents — exact port of recentSearches.load().
   * Returns [] on any failure; never throws.
   *
   * @returns {string[]}
   */
  loadRecents() {
    const read = this._adapter.tryRead(RECENTS_KEY);
    if (read.status !== 'ok') return [];

    let parsed;
    try {
      parsed = JSON.parse(read.value);
    } catch {
      return [];
    }

    // Harden: valid JSON but wrong shape.
    if (!Array.isArray(parsed)) return [];
    return parsed;
  }

  /**
   * Add a recent search — exact port of recentSearches.add().
   * Deduplicates case-insensitively, prepends, caps at RECENTS_MAX.
   * Empty or whitespace-only queries are ignored and return { ok:true }.
   *
   * @param {string} query
   * @returns {{ ok:true }|{ ok:false, error:string }}
   */
  addRecent(query) {
    const term = (query ?? '').trim();
    if (!term) return { ok: true };

    if (this._degraded.has(RECENTS_KEY)) {
      return { ok: false, error: `read-error-degraded:${RECENTS_KEY}` };
    }

    // Filter is safe because loadRecents() guarantees an array.
    const existing = this.loadRecents().filter(
      s => typeof s === 'string' && s.toLowerCase() !== term.toLowerCase(),
    );
    existing.unshift(term);

    const r = this._adapter.setAndVerify(
      RECENTS_KEY,
      JSON.stringify(existing.slice(0, RECENTS_MAX)),
    );
    return r.ok ? { ok: true } : { ok: false, error: r.code ?? r.message };
  }

  /**
   * Clear recents — exact port of recentSearches.clear().
   *
   * @returns {{ ok:true }|{ ok:false, error:string }}
   */
  clearRecents() {
    const r = this._adapter.removeItem(RECENTS_KEY);
    return r.ok ? { ok: true } : { ok: false, error: r.message };
  }

  /* ── Last export date ───────────────────────────────────────────────── */

  /**
   * Get lastExport date — exact port of backupStore.getLastExport().
   * Reads hometask-backup-v1; returns the lastExport field or null.
   * Never throws; returns null on any error.
   *
   * @returns {string|null}
   */
  getLastExport() {
    const read = this._adapter.tryRead(BACKUP_KEY);
    if (read.status !== 'ok') return null;

    try {
      const parsed = JSON.parse(read.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed.lastExport ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Set lastExport date — exact port of backupStore.setLastExport().
   * Merges { lastExport: dateStr } into existing backup-v1 content so
   * the snapshot field (used by Undo Import) is never overwritten.
   *
   * @param {string} dateStr
   * @returns {{ ok:true }|{ ok:false, error:string }}
   */
  setLastExport(dateStr) {
    if (this._degraded.has(BACKUP_KEY)) {
      return { ok: false, error: `read-error-degraded:${BACKUP_KEY}` };
    }

    let existing = {};
    const read = this._adapter.tryRead(BACKUP_KEY);
    if (read.status === 'ok') {
      try {
        const parsed = JSON.parse(read.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed;
        }
      } catch {
        existing = {};
      }
    }
    // If read errored or missing, existing stays {}; the write still proceeds
    // because BACKUP_KEY is not in _degraded (setLastExport has its own guard above).

    const r = this._adapter.setAndVerify(
      BACKUP_KEY,
      JSON.stringify({ ...existing, lastExport: dateStr }),
    );
    return r.ok ? { ok: true } : { ok: false, error: r.code ?? r.message };
  }
}
