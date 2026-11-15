/* backup.js — Public facade for V1BackupService (CP5C-A2.2b).
 *
 * All backup operations are delegated to the injected V1BackupService instance.
 * The service is constructed and injected at the composition root (script.js)
 * via setService() before app.init() runs.
 *
 * setRepo() is retained for backward compatibility with app.init() call sites
 * (app.js calls backup.setRepo(repo)); it is a validated no-op — the repository
 * is already held by the injected service.
 *
 * No src/app imports. No internal implementation. No direct storage access.
 */
const backup = (() => {
  /** Injected V1BackupService — set exactly once from the composition root. */
  let _svc = null;

  /**
   * Inject the V1BackupService instance.
   * Must be called once, before any backup operation, from script.js.
   * Throws if already set or if svc is not a valid service object.
   */
  function setService(svc) {
    if (!svc || typeof svc !== 'object' || typeof svc.exportBackup !== 'function')
      throw new Error('[HomeTask] backup.setService: invalid service — expected V1BackupService');
    if (_svc !== null)
      throw new Error('[HomeTask] backup.setService: service already set — second injection rejected');
    _svc = svc;
  }

  /**
   * Backward-compatible validated no-op retained for app.init() call sites.
   * The repository is already held by the injected service; this guard
   * validates the argument shape without storing or using it.
   */
  function setRepo(r) {
    if (!r || typeof r !== 'object')
      throw new Error('[HomeTask] backup.setRepo: invalid repository');
    // No-op: repo is managed by the injected service.
  }

  /** Fail-closed gate — throws with a calm diagnostic when service is absent. */
  function _svc$(op) {
    if (!_svc)
      throw new Error(
        `[HomeTask] backup.${op}: no service — call backup.setService() before use`
      );
    return _svc;
  }

  /* ── Delegating facade methods ─────────────────────────────────── */

  function exportBackup()                              { return _svc$('exportBackup').exportBackup(); }
  function readAndValidate(file)                       { return _svc$('readAndValidate').readAndValidate(file); }
  function applyImport(sanitizedTasks, sanitizedPrefs, sanitizedRooms) {
    return _svc$('applyImport').applyImport(sanitizedTasks, sanitizedPrefs, sanitizedRooms);
  }
  function applyUndo()                                 { return _svc$('applyUndo').applyUndo(); }
  function hasSnapshot()                               { return _svc$('hasSnapshot').hasSnapshot(); }
  function getLastExport()                             { return _svc$('getLastExport').getLastExport(); }
  function getRecoveryNoticeState()                    { return _svc$('getRecoveryNoticeState').getRecoveryNoticeState(); }
  function downloadRecoveryData()                      { return _svc$('downloadRecoveryData').downloadRecoveryData(); }
  function dismissRecovery()                           { return _svc$('dismissRecovery').dismissRecovery(); }

  return {
    setService,
    setRepo,
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
})();

export { backup };
