/* Extracted mechanically from src/script.js lines 2282–2546 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { backup } from './backup.js';

/* ── Backup UI module ─────────────────────────────────────────── */
/**
 * backupUI — wires the Backup & Restore bottom-sheet dialog.
 *
 * States:
 *   idle       — main body visible (Export / Import / Undo)
 *   confirming — confirmation panel visible after file validation
 *
 * Recovery panel (#bk-recovery): shown above the main actions when
 * backup.getRecoveryNoticeState().visible is true (damaged storage,
 * rollback_failed staging, or interrupted import rolled back at startup).
 * Dismissed per-event.
 *
 * Reload strategy: import and undo both call location.reload() after a
 * short delay so all in-memory app state is cleanly re-initialized from
 * the newly-written localStorage values.
 */
const backupUI = (() => {
  let dialog, closeBtn, exportBtn, importBtn, undoBtn;
  let fileInput, statusEl, bodyPanel, confirmPanel, confirmMsg, restoreBtn, cancelBtn;
  let lastExportEl;
  let recoveryPanel, recoveryMsgEl, importRecoveryBtn, downloadRecoveryBtn, dismissRecoveryBtn;
  let _pending = null;   // { sanitizedTasks, sanitizedPrefs } awaiting confirmation

  /**
   * Backward-compatible validated no-op retained for app.init() call sites.
   * Backup operations now route through the backup facade to V1BackupService.
   */
  function setRepo(r) {
    if (!r || typeof r !== 'object')
      throw new Error('[HomeTask] backupUI.setRepo: invalid repository');
    // No-op: backup operations delegate through backup facade → V1BackupService.
  }

  function _status(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.className   = 'bk-status' + (isError ? ' bk-status--error' : '');
  }

  function _clearStatus() { statusEl.textContent = ''; statusEl.className = 'bk-status'; }

  function _showBody() {
    bodyPanel.hidden    = false;
    confirmPanel.hidden = true;
    _pending = null;
  }

  function _showConfirm(msg) {
    bodyPanel.hidden    = true;
    confirmPanel.hidden = false;
    confirmMsg.textContent = msg;
    restoreBtn.focus();
  }

  function _refreshLastExport() {
    const d = backup.getLastExport();
    if (d) {
      lastExportEl.textContent = `Last backup: ${d}`;
      lastExportEl.hidden = false;
    } else {
      lastExportEl.hidden = true;
    }
  }

  function _refreshUndoBtn() {
    undoBtn.hidden = !backup.hasSnapshot();
  }

  /**
   * Show the recovery panel if damaged storage was detected this session
   * or if an interrupted import was automatically rolled back at startup.
   * Hidden and dismissed independently of the normal backup controls.
   * Delegates all store reads to the backup facade (→ V1BackupService).
   */
  function _refreshRecoveryPanel() {
    const n = backup.getRecoveryNoticeState();
    if (!n.visible) {
      recoveryPanel.hidden = true;
      return;
    }
    recoveryPanel.hidden       = false;
    downloadRecoveryBtn.hidden = !n.showDownload;
    recoveryMsgEl.textContent  = n.message;
  }

  function _open() {
    _showBody();
    _clearStatus();
    _refreshLastExport();
    _refreshUndoBtn();
    _refreshRecoveryPanel();
    dialog.showModal();
  }

  /* ── Export ── */

  function _onExport() {
    _clearStatus();
    exportBtn.disabled    = true;
    exportBtn.textContent = 'Exporting…';

    backup.exportBackup().then(result => {
      exportBtn.disabled  = false;
      exportBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
        '<polyline points="17 8 12 3 7 8"/>' +
        '<line x1="12" y1="3" x2="12" y2="15"/></svg> Export Backup';
      _status(result.message, !result.ok);
      if (result.ok) _refreshLastExport();
    });
  }

  /* ── Import ── */

  function _onImport() {
    _clearStatus();
    fileInput.value = '';
    fileInput.click();
  }

  function _onFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    _status('Reading file…');

    backup.readAndValidate(file).then(result => {
      _pending = result;
      const datePart = result.exportDate ? ` from ${result.exportDate}` : '';
      _clearStatus();
      _showConfirm(
        `Found ${result.taskCount} task record${result.taskCount !== 1 ? 's' : ''}${datePart}.\n\n` +
        `Restoring will replace your current task history. You can undo this immediately after if needed.`
      );
    }).catch(err => {
      _status(err.message, true);
    });
  }

  function _onRestore() {
    if (!_pending) return;
    const result = backup.applyImport(
      _pending.sanitizedTasks,
      _pending.sanitizedPrefs,
      _pending.sanitizedRooms,
    );
    _showBody();
    if (result.ok) {
      _status(result.message);
      setTimeout(() => location.reload(), 1300);
    } else {
      _status(result.message, true);
      _refreshUndoBtn();
      _refreshRecoveryPanel();   // show amber panel immediately if rollback_failed
    }
  }

  /* ── Undo ── */

  function _onUndo() {
    const result = backup.applyUndo();
    if (result.ok) {
      _status('Restoring previous data. Reloading…');
      setTimeout(() => location.reload(), 1300);
    } else {
      _status('Undo failed — ' + (result.error ?? 'no snapshot available.'), true);
    }
  }

  /* ── Recovery panel ── */

  /** Import Backup button inside recovery panel — same as main Import. */
  function _onImportRecovery() { _onImport(); }

  /**
   * Download Recovery Data — delegates to the backup facade (→ V1BackupService).
   * Creates HomeTask-recovery-YYYY-MM-DD.json via the delivery adapter.
   */
  function _onDownloadRecovery() {
    const result = backup.downloadRecoveryData();
    _status(result.message, !result.ok);
  }

  /** Dismiss the recovery notice for this event. Delegates to backup facade. */
  function _onDismissRecovery() {
    backup.dismissRecovery();
    recoveryPanel.hidden = true;
    _clearStatus();
  }

  /* ── Init ── */

  function init() {
    dialog              = document.getElementById('backup-dialog');
    closeBtn            = document.getElementById('bk-close');
    exportBtn           = document.getElementById('bk-export-btn');
    importBtn           = document.getElementById('bk-import-btn');
    undoBtn             = document.getElementById('bk-undo-btn');
    fileInput           = document.getElementById('bk-file-input');
    statusEl            = document.getElementById('bk-status');
    bodyPanel           = document.getElementById('bk-body');
    confirmPanel        = document.getElementById('bk-confirm');
    confirmMsg          = document.getElementById('bk-confirm-msg');
    restoreBtn          = document.getElementById('bk-restore-btn');
    cancelBtn           = document.getElementById('bk-cancel-btn');
    lastExportEl        = document.getElementById('bk-last-export');
    recoveryPanel       = document.getElementById('bk-recovery');
    recoveryMsgEl       = document.getElementById('bk-recovery-msg');
    importRecoveryBtn   = document.getElementById('bk-import-recovery-btn');
    downloadRecoveryBtn = document.getElementById('bk-download-recovery-btn');
    dismissRecoveryBtn  = document.getElementById('bk-dismiss-recovery-btn');
    document.getElementById('backup-btn').addEventListener('click', _open);

    closeBtn.addEventListener('click',  () => dialog.close());
    cancelBtn.addEventListener('click', () => { _showBody(); _clearStatus(); });

    // Backdrop click closes
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

    // Restore focus to the backup button on close.
    dialog.addEventListener('close', () => {
      document.getElementById('backup-btn').focus();
    });

    exportBtn.addEventListener('click',  _onExport);
    importBtn.addEventListener('click',  _onImport);
    fileInput.addEventListener('change', _onFileSelected);
    restoreBtn.addEventListener('click', _onRestore);
    undoBtn.addEventListener('click',    _onUndo);

    importRecoveryBtn.addEventListener('click',   _onImportRecovery);
    downloadRecoveryBtn.addEventListener('click', _onDownloadRecovery);
    dismissRecoveryBtn.addEventListener('click',  _onDismissRecovery);
  }

  return { init, setRepo };
})();

export { backupUI };
