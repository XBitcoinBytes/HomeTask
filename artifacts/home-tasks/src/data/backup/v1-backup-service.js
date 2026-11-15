import { isPlainObject, sanitizeCustomRecord } from '../custom-record.js';
import { sanitizeCustomRoomState, serializeCustomRoomState } from '../custom-room-record.js';

/**
 * V1BackupService — authority-neutral backup orchestration for v1.
 *
 * No browser globals (except Blob, which is not prohibited).
 * No src/app imports. All catalog data, stores, adapters, and clock are injected.
 *
 * Constructor parameters:
 *   catalogTasks   — SEED_TASKS array (injected; not imported)
 *   catalogRooms   — ROOMS_ORDERED array (injected; not imported)
 *   repo           — V1Repository: loadTasks(), loadPrefs(), getLastExport(), setLastExport()
 *   backing        — { getItem, setItem, removeItem } — for atomic commit writes
 *   backupStore    — { saveSnapshot, getSnapshot, applySnapshot, clearSnapshot, IMPORT_KEYS }
 *   stagingStore   — { get, save, patch, clear }
 *   recoveryStore  — { hasUndismissed, get, markDownloaded, markDismissed }
 *   fileReader     — { readAsText(fileLike): Promise<string> }
 *   delivery       — { canShare(blob,filename):bool, share(blob,filename):Promise<void>,
 *                       download(blob,filename):void }
 *   clock          — ():string  ISO-8601 timestamp
 *   sessionStore   — { getItem, setItem, removeItem }
 */
function V1BackupService({
  catalogTasks,
  catalogRooms,
  repo,
  backing,
  backupStore,
  stagingStore,
  recoveryStore,
  fileReader,
  delivery,
  clock,
  sessionStore,
}) {
  /* ── Construction validation ───────────────────────────────────── */
  if (!Array.isArray(catalogTasks) || catalogTasks.length === 0)
    throw new Error('[HomeTask] V1BackupService: catalogTasks must be a non-empty array');
  if (!Array.isArray(catalogRooms))
    throw new Error('[HomeTask] V1BackupService: catalogRooms must be an array');
  if (!repo || typeof repo !== 'object')
    throw new Error('[HomeTask] V1BackupService: repo required');
  if (!backing || typeof backing.setItem !== 'function')
    throw new Error('[HomeTask] V1BackupService: backing required');
  if (!backupStore || typeof backupStore.saveSnapshot !== 'function')
    throw new Error('[HomeTask] V1BackupService: backupStore required');
  if (!stagingStore || typeof stagingStore.get !== 'function')
    throw new Error('[HomeTask] V1BackupService: stagingStore required');
  if (!recoveryStore || typeof recoveryStore.hasUndismissed !== 'function')
    throw new Error('[HomeTask] V1BackupService: recoveryStore required');
  if (!fileReader || typeof fileReader.readAsText !== 'function')
    throw new Error('[HomeTask] V1BackupService: fileReader required');
  if (!delivery || typeof delivery.canShare !== 'function')
    throw new Error('[HomeTask] V1BackupService: delivery required');
  if (typeof clock !== 'function')
    throw new Error('[HomeTask] V1BackupService: clock must be a function');
  if (!sessionStore || typeof sessionStore.getItem !== 'function')
    throw new Error('[HomeTask] V1BackupService: sessionStore required');

  /* ── Constants ────────────────────────────────────────────────── */
  const SCHEMA_VERSION   = 1;
  const MAX_FILE_BYTES   = 2 * 1024 * 1024;   // 2 MB
  const VALID_VIEW_MODES = new Set(['today', 'week', 'all']);

  /**
   * Preference defaults — exact port of meta.js DEFAULTS and
   * v1-repository.js PREFS_DEFAULTS (all three must stay in sync).
   *
   * Used in applyImport to normalise the existing-prefs key order before
   * merging sanitizedPrefs, so the written hometask-meta-v1 bytes are
   * byte-for-byte identical to those backup.js produces via meta.load().
   *
   * meta.load() does { ...DEFAULTS, ...stored } internally, giving DEFAULTS
   * insertion order in the result.  repo.loadPrefs() (V1Repository) does the
   * same.  When a bare mock repo returns a raw object, the service must apply
   * the same normalisation itself rather than rely on the repo doing so.
   */
  const META_DEFAULTS = Object.freeze({
    onboarded:     false,
    choice:        null,
    completedAt:   null,
    dueNowDefault: false,   // kept for migration fold only
    viewMode:      'today',
    roomFilter:    '',
  });

  // Derived from injected catalog (never imported)
  const _catalogTaskIds = new Set(catalogTasks.map(t => t.id));

  /* ── Private helpers ──────────────────────────────────────────── */

  /**
   * Derive local-date string from clock().
   * Uses local time methods to match util.js todayStr() exactly.
   */
  function _todayStr() {
    const d = new Date(clock());
    return (
      d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  function _validateEnvelope(parsed) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return 'This file is not a valid HomeTask backup.';
    if (parsed.app !== 'HomeTask')
      return 'This file was not created by HomeTask.';
    if (typeof parsed.schemaVersion !== 'number' || !Number.isFinite(parsed.schemaVersion))
      return 'The backup file has a missing or invalid version number.';
    if (parsed.schemaVersion > SCHEMA_VERSION)
      return `This backup was made by a newer version of HomeTask (v${parsed.schemaVersion}). ` +
             'Please update the app and try again.';
    if (parsed.schemaVersion < 1)
      return 'This backup has an unrecognized version and cannot be restored.';
    if (!Array.isArray(parsed.taskState))
      return 'The backup has an invalid or missing task list.';
    if (parsed.taskState.length === 0)
      return 'The backup contains no task records and cannot be restored.';
    if (typeof parsed.preferences !== 'object' || parsed.preferences === null || Array.isArray(parsed.preferences))
      return 'The backup has an invalid preferences section.';
    return null;   // OK
  }

  /**
   * Sanitize imported task records.
   *
    * Seed rules preserve the historic whitelist: stable seed IDs only, state
    * fields only, and first occurrence wins. Custom rules intentionally retain
    * complete valid records (including safe unknown fields) because custom
    * identity is user-owned. A custom record cannot use a seed ID.
   */
  function _sanitizeTaskState(arr) {
    const seen = new Set();
    const out  = [];

    for (const rec of Array.isArray(arr) ? arr : []) {
      // Guard against prototype pollution: only process plain objects
      if (!isPlainObject(rec) || typeof rec.id !== 'string' || !rec.id.trim()) continue;

      if (rec._custom === true) {
        const custom = sanitizeCustomRecord(rec, {
          today: _todayStr(),
          seedIds: _catalogTaskIds,
        });
        if (!custom || seen.has(custom.id)) continue;
        seen.add(custom.id);
        out.push(custom);
        continue;
      }

      if (!_catalogTaskIds.has(rec.id)) continue;   // gracefully skip unknown IDs
      if (seen.has(rec.id)) continue;               // first occurrence wins
      seen.add(rec.id);

      const lastDone  = _isDateOrNull(rec.lastDone)  ? (rec.lastDone  ?? null) : null;
      const skipUntil = _isDateOrNull(rec.skipUntil) ? (rec.skipUntil ?? null) : null;
      const doneToday = typeof rec.doneToday === 'boolean' ? rec.doneToday : false;
      const tags = Array.isArray(rec.tags)
        ? rec.tags
            .filter(t => typeof t === 'string')
            .map(t => t.trim().slice(0, 50))
            .filter(Boolean)
        : [];

      out.push({ id: rec.id, lastDone, doneToday, skipUntil, tags });
    }
    return out;
  }

  function _isDateOrNull(v) {
    if (v === null || v === undefined) return true;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    return !Number.isNaN(new Date(v + 'T00:00:00').getTime());
  }

  function _sanitizePreferences(prefs, customTasks = [], explicitRooms = []) {
    const customRooms = new Set(customTasks.map(task => task.room));
    for (const room of explicitRooms) customRooms.add(room.name);
    return {
      viewMode:    VALID_VIEW_MODES.has(prefs.viewMode)     ? prefs.viewMode   : 'today',
      roomFilter:  catalogRooms.includes(prefs.roomFilter) || customRooms.has(prefs.roomFilter)
        ? prefs.roomFilter : '',
      onboarded:   typeof prefs.onboarded === 'boolean'     ? prefs.onboarded  : false,
      choice:      ['balanced', 'current', null].includes(prefs.choice) ? prefs.choice : null,
      completedAt: _isDateOrNull(prefs.completedAt) ? (prefs.completedAt ?? null) : null,
    };
  }

  function _buildEnvelope(taskList, prefsMeta, roomRecords) {
    return {
      app:              'HomeTask',
      schemaVersion:    SCHEMA_VERSION,
      exportedAt:       clock(),
      catalogTaskCount: catalogTasks.length,
      catalogRoomCount: catalogRooms.length,
      // Seeds export state-only and always remain catalog-controlled. Valid
      // custom records export their full user-owned identity and safe future
      // fields; malformed/unsafe runtime records are intentionally omitted.
      taskState: taskList.flatMap(task => {
        if (task?._custom === true) {
          const custom = sanitizeCustomRecord(task, {
            today: _todayStr(),
            seedIds: _catalogTaskIds,
          });
          return custom ? [custom] : [];
        }
        if (!_catalogTaskIds.has(task?.id)) return [];
        return [{
          id:        task.id,
          lastDone:  task.lastDone  ?? null,
          doneToday: Boolean(task.doneToday),
          skipUntil: task.skipUntil ?? null,
          tags:      Array.isArray(task.tags) ? [...task.tags] : [],
        }];
      }),
      preferences: {
        viewMode:    prefsMeta.viewMode    ?? 'today',
        roomFilter:  prefsMeta.roomFilter  ?? '',
        onboarded:   Boolean(prefsMeta.onboarded),
        choice:      prefsMeta.choice      ?? null,
        completedAt: prefsMeta.completedAt ?? null,
      },
      // Optional for schema-v1 compatibility: older backups simply omit this
      // field and import as an empty explicit-room set.
      customRooms: {
        schemaVersion: 1,
        rooms: sanitizeCustomRoomState({
          schemaVersion: 1,
          rooms: Array.isArray(roomRecords) ? roomRecords : [],
        }, { seedRooms: new Set(catalogRooms.map(room => room.toLowerCase())) }),
      },
    };
  }

  /* ── Export ──────────────────────────────────────────────────── */

  /**
   * Build and deliver a schemaVersion-1 backup file.
   *
   * Delivery order mirrors production exactly:
   *   1. If delivery.canShare(blob, filename) → try share
   *      a. AbortError → ok:false, "Share was cancelled…"
   *      b. Non-Abort error → fall through to download
   *   2. delivery.download(blob, filename)
   *      a. Success → setLastExport; ok:true, "Backup saved as …"
   *      b. Failure → ok:false, "The backup could not be saved…"
   *
   * setLastExport is called only after confirmed delivery (share OR download success).
   */
  async function exportBackup() {
    const taskList  = repo.loadTasks();
    const prefsMeta = repo.loadPrefs();
    const rooms     = typeof repo.loadCustomRooms === 'function' ? repo.loadCustomRooms() : [];
    const envelope  = _buildEnvelope(taskList, prefsMeta, rooms);
    const json      = JSON.stringify(envelope, null, 2);
    const today     = _todayStr();
    const filename  = `HomeTask-backup-${today}.json`;
    const blob      = new Blob([json], { type: 'application/json' });

    if (delivery.canShare(blob, filename)) {
      try {
        await delivery.share(blob, filename);
        repo.setLastExport(today);
        return { ok: true, message: 'Backup shared successfully.' };
      } catch (e) {
        if (e.name === 'AbortError') {
          return { ok: false, message: 'Share was cancelled. Your data was not saved.' };
        }
        // Non-Abort share failure — fall through to download
      }
    }

    try {
      delivery.download(blob, filename);
      repo.setLastExport(today);
      return { ok: true, message: `Backup saved as "${filename}".` };
    } catch {
      return { ok: false, message: 'The backup could not be saved. Please try again.' };
    }
  }

  /* ── File reading & validation ────────────────────────────────── */

  /**
   * Read a file-like object, validate it, and return sanitized data.
   * Resolves with { sanitizedTasks, sanitizedPrefs, sanitizedRooms, exportDate, taskCount }
   * or rejects with a user-facing Error.
   *
   * Security boundary: hostile fields (catalog fields, __proto__, constructor,
   * object tags, unknown IDs) are stripped here before reaching applyImport.
   */
  function readAndValidate(fileLike) {
    return new Promise((resolve, reject) => {
      if (fileLike.size > MAX_FILE_BYTES) {
        reject(new Error('This file is too large to be a HomeTask backup (maximum 2 MB).'));
        return;
      }

      fileReader.readAsText(fileLike).then(text => {
        let parsed;
        try { parsed = JSON.parse(text); }
        catch {
          reject(new Error('This file could not be read. Make sure it is a HomeTask backup.'));
          return;
        }

        const err = _validateEnvelope(parsed);
        if (err) { reject(new Error(err)); return; }

        const sanitizedTasks = _sanitizeTaskState(parsed.taskState);
        const sanitizedRooms = sanitizeCustomRoomState(parsed.customRooms, {
          seedRooms: new Set(catalogRooms.map(room => room.toLowerCase())),
        });
        const sanitizedPrefs = _sanitizePreferences(
          parsed.preferences ?? {},
          sanitizedTasks.filter(task => task._custom === true),
          sanitizedRooms,
        );
        const exportDate     = typeof parsed.exportedAt === 'string'
          ? parsed.exportedAt.slice(0, 10)
          : null;

        resolve({ sanitizedTasks, sanitizedPrefs, sanitizedRooms, exportDate, taskCount: sanitizedTasks.length });
      }).catch(() => {
        reject(new Error('Could not read this file. Please try again.'));
      });
    });
  }

  /* ── Import ───────────────────────────────────────────────────── */

  /**
   * Apply a validated, sanitized import atomically.
   *
   * applyImport provides a second defensive whitelist even if the caller passes
   * an over-filled "sanitized" record: the merge only pulls { lastDone, doneToday,
   * skipUntil, tags } by name from each user record — no spread of the import record.
   * Catalog fields (title, room, intervalDays, safety, etc.) are structurally
   * unreachable from the import side.
   *
   * Sequence (mirrors production exactly):
   *   Guard: rollback_failed staging → abort immediately
   *   1. Build complete destination state in memory (seed ⊕ whitelist)
   *   2. saveSnapshot() — abort without touching data if it fails
   *   3. stagingStore.save() — abort if it fails
   *   4. Readback-validate staging content
   *   5. Transition: staged → committing
   *   6. Write each key via backing.setItem + readback verify; update keysWritten
   *   7. On write failure → rollback from snapshot
   *      ok → clear staging; return {ok:false, 'recovered automatically'}
   *      fail → patch txState=rollback_failed; return {ok:false}
   *   8. Transition: committed; clear staging
   *   9. Return {ok:true} — caller is responsible for page reload
   */
  function applyImport(sanitizedTasks, sanitizedPrefs, sanitizedRooms = []) {
    // Guard: refuse new import while an unresolved rollback_failed transaction exists.
    const existingStaging = stagingStore.get();
    if (existingStaging?.txState === 'rollback_failed') {
      return {
        ok: false,
        message: 'A previous import could not be recovered automatically. ' +
                 'Use "Undo Last Import" to restore your previous data before importing again.',
      };
    }

    // 1. Build complete destination state in memory
    const today = _todayStr();
    // Re-sanitize at the apply boundary: callers other than readAndValidate
    // cannot smuggle catalog overrides, unsafe custom values, or seed-ID
    // masquerades into the atomic write.
    const safeTasks = _sanitizeTaskState(sanitizedTasks);
    const savedMap = new Map(safeTasks.filter(task => task._custom !== true).map(task => [task.id, task]));
    const customTasks = safeTasks.filter(task => task._custom === true);
    const safeRooms = sanitizeCustomRoomState({
      schemaVersion: 1,
      rooms: Array.isArray(sanitizedRooms) ? sanitizedRooms : [],
    }, { seedRooms: new Set(catalogRooms.map(room => room.toLowerCase())) });
    // Defensive whitelist: spread seed first, then only named user-state fields.
    // Catalog fields are structurally unreachable even if the caller passes extra fields.
    const merged = [
      ...catalogTasks.map(seed => {
      const s = savedMap.get(seed.id);
      if (!s) return { ...seed };
      return {
        ...seed,
        lastDone:  s.lastDone  ?? null,
        doneToday: s.lastDone === today ? Boolean(s.doneToday) : false,
        skipUntil: s.skipUntil ?? null,
        tags:      Array.isArray(s.tags) ? s.tags : [],
      };
      }),
      ...customTasks,
    ];
    const safePrefs = _sanitizePreferences(sanitizedPrefs ?? {}, customTasks, safeRooms);
    const existingPrefs = repo.loadPrefs();
    const newTasksStr   = JSON.stringify(merged);
    const newRoomsStr   = serializeCustomRoomState(safeRooms, {
      seedRooms: new Set(catalogRooms.map(room => room.toLowerCase())),
    });
    // Apply META_DEFAULTS normalisation before merging sanitizedPrefs.
    // meta.load() (and V1Repository.loadPrefs()) both do { ...DEFAULTS, ...stored }
    // internally, producing DEFAULTS insertion order in the returned object.
    // If the repo returns a raw object without that normalisation (e.g. in tests),
    // the spread below would preserve the raw key order and produce different bytes.
    // By always normalising here the service owns the byte-exact output contract
    // independently of the repo implementation.
    const newMetaStr    = JSON.stringify({ ...META_DEFAULTS, ...existingPrefs, ...safePrefs });

    // 2. Save pre-import snapshot — abort if it cannot be saved or verified
    const snapResult = backupStore.saveSnapshot();
    if (!snapResult.ok) {
      return {
        ok: false,
        message: 'The backup could not be restored: the undo checkpoint could not be saved ' +
                 '(' + snapResult.error + '). Your data has not been changed.',
      };
    }

    // 3. Write proposed state to staging store
    const stagingData = {
      txState:     'staged',
      startedAt:   clock(),
      committedAt: null,
      keysToWrite: backupStore.IMPORT_KEYS,
      keysWritten: [],
      data: {
        'hometask-v1':      newTasksStr,
        'hometask-rooms-v1': newRoomsStr,
        'hometask-meta-v1': newMetaStr,
      },
    };
    if (!stagingStore.save(stagingData)) {
      return {
        ok: false,
        message: 'The backup could not be restored: staging data could not be saved. ' +
                 'Your data has not been changed.',
      };
    }

    // 4. Read back and validate staging content integrity
    const readBack = stagingStore.get();
    if (!readBack ||
        readBack.txState !== 'staged' ||
        backupStore.IMPORT_KEYS.some(key => readBack.data?.[key] !== stagingData.data[key])) {
      stagingStore.clear();
      return {
        ok: false,
        message: 'The backup could not be restored: staging validation failed. ' +
                 'Your data has not been changed.',
      };
    }

    // 5. Transition to committing and write each final key
    stagingStore.patch({ txState: 'committing' });

    const keysWritten = [];
    for (const key of backupStore.IMPORT_KEYS) {
      const val = stagingData.data[key];
      try {
        backing.setItem(key, val);
        if (backing.getItem(key) !== val) throw new Error('verify-mismatch');
        keysWritten.push(key);
        stagingStore.patch({ keysWritten: [...keysWritten] });
      } catch (e) {
        // Write failed — roll back all committed changes from snapshot
        const snap     = backupStore.getSnapshot();
        const rollback = snap
          ? backupStore.applySnapshot(snap)
          : { ok: false, error: 'no-snapshot' };
        if (rollback.ok) {
          stagingStore.clear();
          return {
            ok: false,
            message: 'The backup could not be fully restored (write failed: ' + key + '). ' +
                     'Your previous data has been recovered automatically.',
          };
        }
        stagingStore.patch({
          txState:       'rollback_failed',
          rollbackError: rollback.error,
          keysRestored:  rollback.restored ?? [],
          failedAt:      clock(),
        });
        return {
          ok: false,
          message: 'The backup could not be fully restored and automatic recovery also failed ' +
                   '(' + rollback.error + '). ' +
                   'Use "Undo Last Import" to recover your previous data.',
        };
      }
    }

    // 6. Mark committed and clean up staging
    stagingStore.patch({ txState: 'committed', committedAt: clock() });
    stagingStore.clear();

    return { ok: true, message: 'Backup restored. Reloading…' };
  }

  /* ── Undo ─────────────────────────────────────────────────────── */

  /**
   * Restore the pre-import snapshot (Undo Last Import).
   * Snapshot cleared ONLY after successful verification.
   * Returns { ok: boolean, error?: string }.
   * Caller is responsible for page reload on ok:true.
   */
  function applyUndo() {
    const snap = backupStore.getSnapshot();
    if (!snap) return { ok: false, error: 'no-snapshot' };
    const result = backupStore.applySnapshot(snap);
    if (result.ok) {
      backupStore.clearSnapshot();
      return { ok: true };
    }
    return { ok: false, error: result.error };
  }

  /* ── State queries ────────────────────────────────────────────── */

  function hasSnapshot() { return backupStore.getSnapshot() !== null; }

  function getLastExport() { return repo.getLastExport(); }

  /* ── Recovery notice state ────────────────────────────────────── */

  /**
   * Compute the recovery notice state for the Backup UI.
   *
   * Encapsulates all authority-specific store reads that backup-ui.js
   * currently performs directly — after A2.2b, the UI reads only this.
   *
   * Priority: damaged-data > rollback_failed > interrupted-import notice.
   *
   * Returns: { visible, message, showDownload, showUndo }
   */
  function getRecoveryNoticeState() {
    const hasRecovery       = recoveryStore.hasUndismissed();
    const hasRollbackFailed = stagingStore.get()?.txState === 'rollback_failed';
    const hadInterrupt      = sessionStore.getItem('hometask-recovered-staging') === '1';

    if (hasRecovery) {
      return {
        visible:      true,
        message:      'HomeTask found damaged saved data and reopened safely. ' +
                      'Some history may need to be restored from a backup.',
        showDownload: true,
        showUndo:     false,
      };
    }
    if (hasRollbackFailed) {
      return {
        visible:      true,
        message:      'An import could not be applied or recovered automatically. ' +
                      'Use "Undo Last Import" to restore your previous data.',
        showDownload: false,
        showUndo:     true,
      };
    }
    if (hadInterrupt) {
      return {
        visible:      true,
        message:      'HomeTask detected an incomplete import and restored your previous data safely.',
        showDownload: false,
        showUndo:     false,
      };
    }
    return { visible: false, message: '', showDownload: false, showUndo: false };
  }

  /* ── Recovery actions ─────────────────────────────────────────── */

  /**
   * Build and deliver the diagnostic recovery-data file.
   * Does NOT attempt share — download only (matches production backup-ui.js).
   */
  function downloadRecoveryData() {
    const record = recoveryStore.get();
    if (!record) return { ok: false, message: 'No recovery data available.' };
    const today    = _todayStr();
    const filename = `HomeTask-recovery-${today}.json`;
    const payload  = {
      _type:              'HomeTask Recovery Data',
      _notice:            'This file is diagnostic data, not an importable backup.',
      detectedAt:         record.detectedAt,
      sourceKey:          record.sourceKey,
      originalLength:     record.originalLength,
      storedLength:       record.storedLength,
      truncated:          record.truncated,
      preservationFailed: record.preservationFailed,
      rawData:            record.rawData,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    try {
      delivery.download(blob, filename);
      recoveryStore.markDownloaded();
      return { ok: true, message: `Recovery data saved as "${filename}".` };
    } catch {
      return { ok: false, message: 'Could not download recovery data. Please try again.' };
    }
  }

  /**
   * Dismiss the recovery notice.
   * Marks the recovery record dismissed AND clears the sessionStorage interrupt flag.
   */
  function dismissRecovery() {
    recoveryStore.markDismissed();
    try { sessionStore.removeItem('hometask-recovered-staging'); } catch (_) {}
  }

  /* ── Public interface ─────────────────────────────────────────── */
  return {
    exportBackup,
    readAndValidate,
    applyImport,
    applyUndo,
    hasSnapshot,
    getLastExport,
    getRecoveryNoticeState,
    downloadRecoveryData,
    dismissRecovery,
  };
}

export { V1BackupService };
