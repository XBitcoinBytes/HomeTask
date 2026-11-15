/**
 * shadow-status.js — mutable shadow diagnostic state + single-subscriber pub-sub.
 *
 * shadowStatus holds the current presentation model produced by
 * shadow-presenter.js. script.js updates it via startShadowDiagnostic();
 * backup-ui.js reads it via _refreshShadowCheck() and subscribes to changes
 * via onShadowUpdate().
 *
 * Subscription rules:
 *   - Only one subscriber at a time (the open Backup & Restore dialog).
 *   - onShadowUpdate() returns an unsubscribe function.
 *   - Callers must call unsubscribe before dialog close (backup-ui.js does
 *     this in both the close event and on re-open via _open()).
 *   - Listener exceptions are caught and do not alter diagnostic state
 *     or create unhandled rejections.
 */

/**
 * Mutable shadow diagnostic state.
 * Initialized to 'running' so the UI shows a running indicator immediately
 * after startShadowDiagnostic() fires, before the bridge promise resolves.
 *
 * phase values:
 *   'running'      — check in progress
 *   'verified'     — passed all validation; safeReport and shareAllowed set
 *   'needs-review' — failed or malformed; safeReport null, shareAllowed false
 *   'idle'         — flag disabled; no check performed
 */
export const shadowStatus = {
  phase:        'running',
  safeReport:   null,
  shareAllowed: false,
};

/** @type {(() => void) | null} */
let _listener = null;

/**
 * Register a listener to be called when shadowStatus changes.
 * Replaces any previously registered listener.
 * Returns an unsubscribe function.
 *
 * @param {() => void} fn
 * @returns {() => void}  unsubscribe
 */
export function onShadowUpdate(fn) {
  _listener = fn;
  return function unsubscribe() {
    if (_listener === fn) _listener = null;
  };
}

/**
 * Notify the current listener that shadowStatus has changed.
 *
 * Listener exceptions are caught so they cannot:
 *   - corrupt the diagnostic state
 *   - propagate as unhandled rejections
 *   - affect the calling module (script.js or the v2 bridge)
 */
export function notifyShadowUpdate() {
  if (_listener) {
    try { _listener(); }
    catch { /* listener exception must not alter diagnostic state or propagate */ }
  }
}
