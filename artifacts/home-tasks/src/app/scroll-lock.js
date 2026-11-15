/* Extracted mechanically from src/script.js lines 1141–1192 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */

/* ── Scroll lock module ───────────────────────────────────────── */
/**
 * Locks the document scroll while a modal sheet is open so the
 * background list cannot move (including iOS rubber-band scrolling).
 *
 * Uses the body position:fixed technique required for iOS Safari,
 * preserving and restoring the exact prior scroll position.
 * Wired via a MutationObserver on each dialog's [open] attribute so
 * every showModal()/close() path is covered automatically.
 */
const scrollLock = (() => {
  let _lockedY = 0;
  let _locked  = false;

  function lock() {
    if (_locked) return;
    _locked  = true;
    _lockedY = window.scrollY;
    const b = document.body;
    b.style.position = 'fixed';
    b.style.top      = `-${_lockedY}px`;
    b.style.left     = '0';
    b.style.right    = '0';
    b.style.width    = '100%';
    b.classList.add('scroll-locked');
  }

  function unlock() {
    if (!_locked) return;
    _locked = false;
    const b = document.body;
    b.style.position = '';
    b.style.top      = '';
    b.style.left     = '';
    b.style.right    = '';
    b.style.width    = '';
    b.classList.remove('scroll-locked');
    // Restore the exact prior scroll position — never jump to top.
    window.scrollTo({ top: _lockedY, behavior: 'instant' });
  }

  /** Observe a <dialog> and lock/unlock as its [open] attribute changes. */
  function attach(dialog) {
    if (!dialog) return;
    const sync = () => (dialog.open ? lock() : unlock());
    new MutationObserver(sync)
      .observe(dialog, { attributes: true, attributeFilter: ['open'] });
    sync(); // handle a dialog already open at attach time
  }

  return { lock, unlock, attach };
})();

export { scrollLock };
