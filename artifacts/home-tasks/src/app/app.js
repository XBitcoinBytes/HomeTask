/* Extracted mechanically from src/script.js lines 2548–3242 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { computeWorkload } from '../workload.js';
import { esc, todayStr } from './util.js';
import { ROOMS_ORDERED, SAFETY_TASK_IDS } from './catalog.js';
import { CUSTOM_TASKS_UI_ENABLED } from './custom-tasks-config.js';
import { computeEffectiveDue } from './due.js';
import { tasks } from './tasks.js';
import { statusOf } from './status.js';
import { search } from './search.js';
import { scrollLock } from './scroll-lock.js';
import { ui } from './ui.js';
import { onboarding } from './onboarding.js';
import { backupUI } from './backup-ui.js';
import { backup } from './backup.js';
import { createDeferredDelete } from './deferred-delete.js';


const app = (() => {
  // ── Element refs ──────────────────────────────────────────────────────
  const homeBtn          = document.getElementById('home-btn');
  const homeScreenEl     = document.getElementById('home-screen');
  const homeTodayCountEl = document.getElementById('home-today-count');
  const homeAllLabelEl   = document.getElementById('home-all-label');
  const controlsEl       = document.getElementById('controls');
  const taskListEl       = document.getElementById('task-list');
  const globalEmptyEl    = document.getElementById('global-empty');
  const viewTabToday     = document.getElementById('view-tab-today');
  const viewTabWeek      = document.getElementById('view-tab-week');
  const viewTabAll       = document.getElementById('view-tab-all');
  const viewTabsEl       = document.getElementById('view-tabs');
  const roomPickerBtn    = document.getElementById('room-picker-btn');
  const roomPickerDialog = document.getElementById('room-picker-dialog');
  const rpSearch         = document.getElementById('rp-search');
  const rpCloseBtn       = document.getElementById('rp-close');
  const searchBtn        = document.getElementById('search-btn');
  const searchDialog     = document.getElementById('search-dialog');
  const srInput          = document.getElementById('sr-input');
  const srClear          = document.getElementById('sr-clear');
  const srClose          = document.getElementById('sr-close');
  const srBody           = document.getElementById('sr-body');
  const srSheet          = searchDialog?.querySelector('.sr-sheet');

  // ── App state ─────────────────────────────────────────────────────────
  let _roomFilter   = '';
  let _viewMode     = 'today';  // 'today' | 'week' | 'all' | 'home'
  let _srDebounce   = null;
  let _srHadResults = false;
  let _srQuery      = '';       // the single authoritative search query

  /** Injected V1Repository — set once by init(repo) before first render. */
  let _repo = null;

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER PIPELINE
  // ═══════════════════════════════════════════════════════════════════════

  /** The task set that is currently visible while a deletion can still be undone. */
  function _visibleTasks() {
    const pendingDeleteId = _deferredDelete.getPending()?.id;
    return tasks.getAll().filter(task => task.id !== pendingDeleteId);
  }

  /**
   * _refresh — the single task-list render pipeline.
   *
   * Pipeline: all tasks → room filter → view filter → ui.render
   *
   * Today : done + critical + overdue + soon-dueToday
   * Week  : done + critical + overdue + soon (anything within 7 days)
   * All   : everything
   */
  function _refresh() {
    if (_viewMode === 'home') return; // Home screen manages its own display
    const today = todayStr();
    let visible = search.filter(_visibleTasks(), '', _roomFilter);

    if (_viewMode === 'today') {
      visible = visible.filter(t => {
        const s = statusOf.compute(t);
        if (s.type === 'done' || s.type === 'critical' || s.type === 'overdue') return true;
        if (s.type === 'soon') return computeEffectiveDue(t) === today;
        return false;
      });
    } else if (_viewMode === 'week') {
      visible = visible.filter(t => statusOf.compute(t).type !== 'future');
    }
    // 'all' → no additional filter

    // Preserve scroll position across in-place list rerender.
    const savedScrollY = window.scrollY;
    ui.render(visible, {
      viewMode:     _viewMode,
      roomFilter:   _roomFilter,
      query:        '',
      hiddenTaskId: _deferredDelete.getPending()?.id ?? null,
      onSwitchView: _switchView,
    });
    if (window.scrollY !== savedScrollY) {
      window.scrollTo({ top: savedScrollY, behavior: 'instant' });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW SWITCHING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Switch to a named view. 'home' is transient — never persisted to meta
   * so the user's last task view is always restored on the next launch.
   */
  function _switchView(mode, { scrollTop = false } = {}) {
    const cameFromHome = _viewMode === 'home';
    // Save-before-commit: persist the new viewMode before updating state.
    // 'home' is transient — never persisted — so skip the save for it.
    if (mode !== 'home') {
      const saved = _repo.savePrefs({ viewMode: mode });
      if (!saved.ok) return;   // silent failure — state and UI unchanged
    }
    _viewMode = mode;
    _syncViewControl();
    _syncHomeView();
    if (mode !== 'home') _refresh();
    // Entering a task view from Home (or explicitly requested) starts at
    // the top — never restore an old giant All Tasks scroll position.
    if (mode === 'home' || cameFromHome || scrollTop) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  /** Move DOM focus to the currently-active view tab (after keyboard nav). */
  function _focusActiveTab() {
    const map = { today: viewTabToday, week: viewTabWeek, all: viewTabAll };
    map[_viewMode]?.focus();
  }

  function _selectRoom(room) {
    if (roomPickerDialog.open) roomPickerDialog.close();
    // Save-before-commit: persist before committing state or updating UI.
    // On failure return immediately — state and UI unchanged (silent failure).
    if (_viewMode === 'home') {
      const saved = _repo.savePrefs({ viewMode: 'all', roomFilter: room });
      if (!saved.ok) return;
      _roomFilter = room;
      _viewMode = 'all';
      ui.updateRoomPickerBtn(room);
      _syncViewControl();
      _syncHomeView();
    } else {
      const saved = _repo.savePrefs({ roomFilter: room });
      if (!saved.ok) return;
      _roomFilter = room;
      ui.updateRoomPickerBtn(room);
    }
    _refresh();
  }

  function _renderRoomPicker() {
    ui.buildRoomList(_roomFilter, rpSearch.value, _selectRoom, _showRoomDeleteConfirm);
  }

  /**
   * Sync view tab ARIA states and tabIndex so the radiogroup
   * is navigable with arrow keys and readable by VoiceOver.
   * Only the active tab is in the natural tab order (tabIndex 0);
   * the others are reachable via arrow keys only (tabIndex -1).
   * In 'home' mode no tab is active — Today gets natural tab order.
   */
  function _syncViewControl() {
    const tabs = [
      { el: viewTabToday, mode: 'today' },
      { el: viewTabWeek,  mode: 'week'  },
      { el: viewTabAll,   mode: 'all'   },
    ];
    tabs.forEach(({ el, mode }) => {
      if (!el) return;
      const active = mode === _viewMode;
      el.setAttribute('aria-checked', active ? 'true' : 'false');
      el.tabIndex = active ? 0 : -1;
    });
    // Home view: no tab is checked; give Today natural tab order
    if (_viewMode === 'home' && viewTabToday) viewTabToday.tabIndex = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HOME SCREEN
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Show/hide the home screen and controls based on _viewMode.
   * Renders the home summary when switching to home.
   */
  function _syncHomeView() {
    const isHome = _viewMode === 'home';
    if (homeScreenEl)  homeScreenEl.hidden  = !isHome;
    if (controlsEl)    controlsEl.hidden    =  isHome;
    if (taskListEl)    taskListEl.hidden    =  isHome;
    // Let render() control globalEmpty when not in home mode
    if (isHome && globalEmptyEl) globalEmptyEl.hidden = true;
    if (isHome) _updateHomeSummary();
  }

  /**
   * Refresh the Home screen: the Today primary-action count and the
   * dynamic "All N Tasks" label. Both derive from the single shared
   * workload function so Home and Today can never disagree.
   */
  function _updateHomeSummary() {
    const all = _visibleTasks();

    if (homeAllLabelEl) homeAllLabelEl.textContent = `All ${all.length} Tasks`;

    if (!homeTodayCountEl) return;
    if (!_repo.loadPrefs().onboarded) {
      homeTodayCountEl.textContent = 'Welcome to HomeTask';
      return;
    }
    const wl = computeWorkload(all, statusOf.compute, computeEffectiveDue, todayStr());
    if (wl.attention > 0) {
      homeTodayCountEl.textContent =
        `${wl.attention} Task${wl.attention !== 1 ? 's' : ''} Need${wl.attention === 1 ? 's' : ''} Attention Today`;
    } else {
      homeTodayCountEl.textContent = 'You\u2019re All Caught Up';
    }
  }

  /** Wire the Home screen brand button and navigation cards. */
  function _wireHomeScreen() {
    homeBtn?.addEventListener('click', () => _switchView('home'));

    document.getElementById('home-to-today')
      ?.addEventListener('click', () => _switchView('today'));
    document.getElementById('home-to-week')
      ?.addEventListener('click', () => _switchView('week'));
    document.getElementById('home-to-all')
      ?.addEventListener('click', () => _switchView('all', { scrollTop: true }));

    // Header "N Total Tasks" button: close any open sheet, clear the room
    // filter, open All Tasks, and scroll to the top.
    // Single-patch: { roomFilter: '', viewMode: 'all' } persisted once.
    // On success, replicate _switchView effects manually without a second save.
    document.getElementById('total-tasks-btn')
      ?.addEventListener('click', () => {
        if (searchDialog?.open)     searchDialog.close();
        if (roomPickerDialog?.open) roomPickerDialog.close();
        const saved = _repo.savePrefs({ roomFilter: '', viewMode: 'all' });
        if (!saved.ok) return;   // silent failure
        _roomFilter = '';
        _viewMode   = 'all';
        ui.updateRoomPickerBtn('');
        _syncViewControl();
        _syncHomeView();
        _refresh();
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
    document.getElementById('home-to-rooms')
      ?.addEventListener('click', () => {
        // Pre-switch to 'all' so that after room selection we land on All Tasks
        if (_viewMode === 'home') { _viewMode = 'all'; _syncViewControl(); _syncHomeView(); }
        roomPickerBtn.click();
      });
    document.getElementById('home-to-backup')
      ?.addEventListener('click', () => document.getElementById('backup-btn').click());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SEARCH DIALOG
  // ═══════════════════════════════════════════════════════════════════════

  function _srStatusText(s) { return s.label || ''; }

  /**
   * Match tasks for a query — the single search matcher.
   * Supports two virtual queries derived from live data:
   *   "safety [tasks]"  → all safety tasks
   *   "overdue [tasks]" → all overdue + critical tasks
   */
  function _matchTasks(rawQuery) {
    const norm = (rawQuery ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!norm) return [];
    const all = _visibleTasks();

    if (/^safety( tasks?)?$/.test(norm)) {
      return all.filter(t => SAFETY_TASK_IDS.has(t.id));
    }
    if (/^overdue( tasks?)?$/.test(norm)) {
      return all.filter(t => {
        const type = statusOf.compute(t).type;
        return type === 'overdue' || type === 'critical';
      });
    }

    const terms = search.expandTerms(norm);
    return all.filter(t => {
      const titleL = t.title.toLowerCase();
      const roomL  = t.room.toLowerCase();
      return terms.some(term =>
        titleL.includes(term) ||
        roomL.includes(term)  ||
        t.tags.some(tag => tag.toLowerCase().includes(term))
      );
    });
  }

  /* Candidate suggestion chips — only those with live results are shown. */
  const _SR_SUGGESTIONS = [
    'Kitchen', 'Bathrooms', 'Bedrooms',
    'Safety Tasks', 'Overdue Tasks', 'Clean Windows',
  ];

  /**
   * Render the idle state (empty query): recent searches, then
   * data-derived suggestions that are guaranteed to return results.
   */
  function _renderSrIdle() {
    const recents     = _repo.loadRecents();
    const suggestions = _SR_SUGGESTIONS.filter(sug => _matchTasks(sug).length > 0);

    let html = '';

    if (recents.length > 0) {
      html += `<div class="sr-section-head">
        <span class="sr-section-title">Recent Searches</span>
        <button class="sr-clear-recents" id="sr-clear-recents">Clear Recent Searches</button>
      </div><div class="sr-recents">`;
      recents.forEach(q => {
        html += `<button class="sr-recent-chip" data-query="${esc(q)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>${esc(q)}</button>`;
      });
      html += `</div>`;
    }

    if (suggestions.length > 0) {
      html += `<div class="sr-section-head">
        <span class="sr-section-title">Suggestions</span>
      </div><div class="sr-suggestions">`;
      suggestions.forEach(sug => {
        html += `<button class="sr-suggest-chip" data-query="${esc(sug)}">${esc(sug)}</button>`;
      });
      html += `</div>`;
    }

    srBody.innerHTML = html;
    _prependSrDeleteFailure();
    _prependSrPendingUndo();
    srBody.scrollTop = 0;

    srBody.querySelectorAll('.sr-recent-chip,.sr-suggest-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        srInput.value = btn.dataset.query;
        _applySrQuery(btn.dataset.query);
        srInput.focus();
      });
    });

    document.getElementById('sr-clear-recents')?.addEventListener('click', () => {
      _repo.clearRecents();
      _renderSrIdle();
    });
  }

  /**
   * Close Search, navigate to a room in All Tasks, and (optionally)
   * reveal + briefly highlight a specific task card.
   */
  function _srNavigate(room, taskId) {
    if (searchDialog.open) searchDialog.close();
    // Save-before-commit: persist before committing state or updating UI.
    const saved = _repo.savePrefs({ roomFilter: room, viewMode: 'all' });
    if (!saved.ok) return;   // silent failure — state and UI unchanged
    _roomFilter = room;
    _viewMode = 'all';
    ui.updateRoomPickerBtn(room);
    _syncViewControl();
    _syncHomeView();
    _refresh();
    window.scrollTo({ top: 0, behavior: 'instant' });

    if (taskId) {
      // After render, reveal the card and apply a restrained highlight.
      requestAnimationFrame(() => {
        const card = document.querySelector(`.task-card[data-id="${CSS.escape(taskId)}"]`);
        if (!card) return;
        card.scrollIntoView({ block: 'center', behavior: 'instant' });
        card.classList.add('flash-highlight');
        setTimeout(() => card.classList.remove('flash-highlight'), 1600);
      });
    }
  }

  /**
   * The single authoritative query pipeline.
   * All entry points (typing, Clear, chips, reopen) funnel through here.
   */
  function _applySrQuery(rawQuery) {
    // Authoritative entry point: kill any pending debounced search so a
    // stale timeout can never resurrect old results after Clear/delete.
    clearTimeout(_srDebounce);
    const q = (rawQuery ?? '').trim();
    _srQuery = q;
    srClear.hidden = q.length === 0;

    if (!q) {
      // Final character deleted / cleared: immediately return to the
      // suggestion view. Sheet stays visible, backdrop stays correct.
      _srHadResults = false;
      _renderSrIdle();
      return;
    }

    const matched = _matchTasks(q);

    if (matched.length === 0) {
      _srHadResults = false;
      srBody.innerHTML = `<div class="sr-empty">
        <p class="sr-empty-icon">🔍</p>
        <p class="sr-empty-title">No results for \u201c${esc(q)}\u201d</p>
        <p class="sr-empty-body">Try a different word or search by room name.</p>
      </div>`;
      _prependSrDeleteFailure();
      _prependSrPendingUndo();
      srBody.scrollTop = 0;
      return;
    }

    _srHadResults = true;

    // Group by room (catalog order first, then custom rooms)
    const groups = new Map();
    ROOMS_ORDERED.forEach(r => groups.set(r, []));
    matched.forEach(t => {
      if (!groups.has(t.room)) groups.set(t.room, []);
      groups.get(t.room).push(t);
    });

    let html = '';
    groups.forEach((roomTasks, roomName) => {
      if (roomTasks.length === 0) return;
      html += `<div class="sr-group">
        <div class="sr-group-hd">
          <button class="sr-group-room" data-room="${esc(roomName)}"
                  aria-label="Open ${esc(roomName)}">${esc(roomName)}</button>
          <span class="sr-group-count">${roomTasks.length}</span>
        </div><ul class="sr-group-list">`;
      roomTasks.forEach(t => {
        const s = statusOf.compute(t);
        html += `<li class="sr-result-li">
          <button class="sr-result" data-room="${esc(t.room)}" data-id="${esc(t.id)}"
                  aria-label="Open ${esc(t.title)} In ${esc(t.room)}">
            <span class="sr-result-title">${esc(t.title)}</span>
            <span class="sr-status sr-status--${s.type}">${esc(_srStatusText(s))}</span>
          </button>
        </li>`;
      });
      html += `</ul></div>`;
    });
    srBody.innerHTML = html;
    _prependSrDeleteFailure();
    _prependSrPendingUndo();
    srBody.scrollTop = 0;   // new results always start at the top

    // Task results → open the task in its room, reveal + highlight
    srBody.querySelectorAll('.sr-result').forEach(btn => {
      btn.addEventListener('click', () => {
        _repo.addRecent(q);   // a selection commits the query
        _srHadResults = false;
        _srNavigate(btn.dataset.room, btn.dataset.id);
      });
    });

    // Room headers → open that room in All Tasks
    srBody.querySelectorAll('.sr-group-room').forEach(btn => {
      btn.addEventListener('click', () => {
        _repo.addRecent(q);
        _srHadResults = false;
        _srNavigate(btn.dataset.room, null);
      });
    });
  }

  /** Keep an expiry failure accessible inside the active native Search dialog. */
  function _prependSrDeleteFailure() {
    if (!_searchDeleteFailure) return;
    const notice = document.createElement('div');
    notice.className = 'sr-delete-failure';
    notice.setAttribute('role', 'alert');
    notice.textContent = `Could not delete “${_searchDeleteFailure.task.title}”. ${_searchDeleteFailure.message}`;
    srBody.prepend(notice);
  }

  /** Keep an actionable undo control above the native Search dialog layer. */
  function _prependSrPendingUndo() {
    const pending = _deferredDelete.getPending();
    if (!pending) return;
    const notice = document.createElement('div');
    notice.className = 'sr-pending-delete';
    notice.setAttribute('role', 'status');
    notice.textContent = `Deleted “${pending.task.title}”. `;
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.textContent = 'Undo';
    undoBtn.setAttribute('aria-label', `Undo deleting ${pending.task.title}`);
    undoBtn.addEventListener('click', _undoDelete, { once: true });
    notice.appendChild(undoBtn);
    srBody.prepend(notice);
  }

  /** Open the search dialog sheet with slide-up animation. */
  function _openSearch() {
    if (!searchDialog || !srSheet) return;
    srInput.value  = '';
    _srQuery       = '';
    srClear.hidden = true;
    _srHadResults  = false;
    _renderSrIdle();

    // Room-picker pattern: .is-entering on the <dialog>; the CSS rule
    // .sr-dialog.is-entering .sr-sheet animates ONLY the inner sheet.
    // The dialog itself is never transformed or animated.
    searchDialog.classList.add('is-entering');
    searchDialog.showModal();

    // Double-rAF layout check: default to visible if measurement fails.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = srSheet.getBoundingClientRect();
      const vh   = (window.visualViewport?.height) ?? window.innerHeight;
      if (rect.width === 0 || rect.height === 0 ||
          rect.top  >= vh  || rect.bottom <= 0) {
        searchDialog.classList.remove('is-entering');
        console.warn('[HomeTask] Search sheet outside viewport — forced visible.');
      }
      srInput.focus();
    }));

    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; searchDialog.classList.remove('is-entering'); };
    srSheet.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 500);
  }

  /**
   * Close the search dialog. Queries are saved to Recent Searches only
   * when the user selects a result or explicitly submits (Enter) —
   * never implicitly on close.
   */
  function _closeSearch() {
    clearTimeout(_srDebounce);   // no pending search may fire after close
    _srHadResults = false;
    _searchDeleteFailure = null;
    if (searchDialog.open) searchDialog.close();
  }

  /** Wire all search dialog interactions. */
  function _wireSearchDialog() {
    if (!searchDialog) return;

    searchBtn?.addEventListener('click', _openSearch);

    srClose.addEventListener('click', _closeSearch);

    srClear.addEventListener('click', () => {
      srInput.value = '';
      _applySrQuery('');
      srInput.focus();
    });

    // Controlled input: always read the CURRENT value from the event
    // target (never a stale reference). An emptied field re-renders the
    // idle view immediately — no debounce lag, no stale results.
    srInput.addEventListener('input', e => {
      const val = e.currentTarget.value;
      clearTimeout(_srDebounce);
      if (val.trim() === '') {
        _applySrQuery('');
      } else {
        _srDebounce = setTimeout(() => {
          // Reconcile against the live input — if the field changed or
          // emptied since this timeout was scheduled, drop the stale value.
          if (srInput.value === val && searchDialog.open) _applySrQuery(val);
        }, 150);
      }
    });

    // Explicit submit (Enter) commits the query to Recent Searches
    srInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.currentTarget.value;
        clearTimeout(_srDebounce);
        _applySrQuery(val);
        if (val.trim() && _srHadResults) _repo.addRecent(val.trim());
      }
    });

    searchDialog.addEventListener('click', e => {
      if (e.target === searchDialog) _closeSearch();
    });

    searchDialog.addEventListener('close', () => searchBtn?.focus());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LIST INTERACTIONS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * After a Done or Skip action, decide whether to patch the card in-place
   * or do a full refresh.
   *
   * - 'all' view: patchCard() keeps scroll position; all tasks stay visible.
   * - 'today' / 'week': full refresh correctly removes a task that has moved
   *   outside the current view window (e.g. skip → future).
   */
  function _afterAction(id) {
    if (_viewMode === 'all') {
      ui.patchCard(id);
    } else {
      _refresh();
    }
  }

  function _onListClick(e) {
    // F1: custom task interactions (delete confirm, room add)
    if (CUSTOM_TASKS_UI_ENABLED) {
      const deleteBtn = e.target.closest('.js-delete');
      if (deleteBtn) { _showDeleteConfirm(deleteBtn.dataset.id); return; }
      const roomAddBtn = e.target.closest('.js-room-add');
      if (roomAddBtn) { _openAddTask(roomAddBtn.dataset.room, roomAddBtn); return; }
    }

    const doneBtn = e.target.closest('.js-done');
    if (doneBtn) { tasks.markDone(doneBtn.dataset.id); _afterAction(doneBtn.dataset.id); return; }
    const skipTodayBtn = e.target.closest('.js-skip-today');
    if (skipTodayBtn) { tasks.skipToday(skipTodayBtn.dataset.id); _afterAction(skipTodayBtn.dataset.id); return; }
    const skipWeekBtn = e.target.closest('.js-skip-week');
    if (skipWeekBtn) { tasks.skipWeek(skipWeekBtn.dataset.id); _afterAction(skipWeekBtn.dataset.id); return; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WIRING
  // ═══════════════════════════════════════════════════════════════════════

  /** Wire up the view tabs: click handlers + arrow-key keyboard navigation. */
  function _wireViewTabs() {
    const modes = ['today', 'week', 'all'];

    viewTabToday.addEventListener('click', () => _switchView('today'));
    viewTabWeek.addEventListener('click',  () => _switchView('week'));
    viewTabAll.addEventListener('click',   () => _switchView('all'));

    // Arrow-key navigation within the radiogroup (ARIA roving tabIndex pattern)
    viewTabsEl.addEventListener('keydown', e => {
      const curIdx = modes.indexOf(_viewMode === 'home' ? 'today' : _viewMode);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        _switchView(modes[(curIdx + 1) % modes.length]);
        _focusActiveTab();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        _switchView(modes[(curIdx - 1 + modes.length) % modes.length]);
        _focusActiveTab();
      }
    });
  }

  /** Wire up the room picker dialog (open, search, close, backdrop). */
  function _wireRoomPicker() {
    const rpSheet = roomPickerDialog.querySelector('.rp-sheet');

    roomPickerBtn.addEventListener('click', () => {
      rpSearch.value = '';
      _renderRoomPicker();

      // Add .is-entering BEFORE showModal() so the CSS slide-up animation
      // (on .rp-sheet, not on <dialog>) begins from the correct start frame.
      roomPickerDialog.classList.add('is-entering');
      roomPickerDialog.showModal();
      roomPickerBtn.setAttribute('aria-expanded', 'true');

      // Double-rAF: top-layer elements opened via showModal() may not complete
      // layout by the first animation frame in all browsers.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = rpSheet.getBoundingClientRect();
        const vh   = (window.visualViewport?.height) ?? window.innerHeight;
        if (rect.width === 0 || rect.height === 0 ||
            rect.top  >= vh  || rect.bottom <= 0) {
          roomPickerDialog.classList.remove('is-entering');
          console.warn('[HomeTask] Room picker sheet outside viewport — forced visible.');
        }
        rpCloseBtn.focus();
      }));

      let enteringCleaned = false;
      const cleanupEntering = () => {
        if (enteringCleaned) return;
        enteringCleaned = true;
        roomPickerDialog.classList.remove('is-entering');
      };
      rpSheet.addEventListener('animationend', cleanupEntering, { once: true });
      setTimeout(cleanupEntering, 500);
    });

    rpSearch.addEventListener('input', () => {
      _renderRoomPicker();
    });

    rpCloseBtn.addEventListener('click', () => roomPickerDialog.close());
    document.getElementById('rp-create-room')?.addEventListener('click', event => {
      const opener = event.currentTarget;
      roomPickerDialog.close();
      requestAnimationFrame(() => _openCreateRoom(opener));
    });

    roomPickerDialog.addEventListener('click', e => {
      if (e.target === roomPickerDialog) roomPickerDialog.close();
    });

    roomPickerDialog.addEventListener('close', () => {
      roomPickerBtn.setAttribute('aria-expanded', 'false');
      roomPickerBtn.focus();
    });
  }

  function _registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('sw.js')
      .then(reg => console.info('[HomeTask] SW registered', reg.scope))
      .catch(err => console.warn('[HomeTask] SW failed', err));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════

  async function init(repo) {
    // Inject the repository into every module that needs it before any
    // storage read or write occurs.  setRepo() enforces the injection guard
    // on each module: null/invalid rejected; idempotent repeat allowed;
    // late swap with a different object throws.
    _repo = repo;
    tasks.setRepo(repo);
    ui.setRepo(repo);
    onboarding.setRepo(repo);
    backupUI.setRepo(repo);
    backup.setRepo(repo);

    const _prefs = _repo.loadPrefs();
    // Allow any saved room filter (including custom rooms) — do not strip unknown rooms.
    _roomFilter = typeof _prefs.roomFilter === 'string' ? _prefs.roomFilter : '';

    // Every normal launch opens the calm Home screen — never All Tasks.
    // The 122-task list is NOT rendered behind Home (_refresh no-ops in
    // 'home' mode); task views render on demand when the user navigates.
    // Task history and preferences are fully preserved; onboarding is
    // not re-run (handled below by onboarding.maybeShow()).
    _viewMode = 'home';

    ui.updateRoomPickerBtn(_roomFilter);
    _syncViewControl();
    _syncHomeView();
    _refresh();   // no-op in 'home' mode by design

    _wireViewTabs();
    _wireRoomPicker();
    _wireHomeScreen();
    _wireSearchDialog();
    _wireAddTask();
    _wireCustomRoomLifecycle();
    _wireDeleteDialog();

    // Background scroll lock for every modal sheet
    scrollLock.attach(document.getElementById('search-dialog'));
    scrollLock.attach(document.getElementById('room-picker-dialog'));
    scrollLock.attach(document.getElementById('backup-dialog'));
    scrollLock.attach(document.getElementById('onboarding-dialog'));
    scrollLock.attach(document.getElementById('create-room-dialog'));
    scrollLock.attach(document.getElementById('delete-room-dialog'));

    taskListEl.addEventListener('click', _onListClick);
    backupUI.init();
    _registerSW();

    // Smart Start onboarding — waits for user choice if shown
    const result = await onboarding.maybeShow();
    if (result) {
      tasks.applyBaseline(result.overrides);
      _repo.savePrefs({
        onboarded:   true,
        choice:      result.choice,
        completedAt: todayStr(),
        viewMode:    'today',   // persist Today as first task destination
      });
      // After onboarding: show Home screen (first-launch experience).
      // savePrefs viewMode stays 'today' so next launch restores Today.
      _viewMode = 'home';
      _syncViewControl();
      _syncHomeView();
    }

    console.info(
      '[HomeTask] Loaded',
      tasks.getAll().length, 'tasks across',
      ROOMS_ORDERED.length, 'rooms'
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F1 — SAFE CUSTOM-TASK DELETE WITH DEFERRED PERSISTENCE + UNDO
  // ═══════════════════════════════════════════════════════════════════════

  let _deleteConfirmId      = null;
  let _deleteConfirmPending = false;
  let _deleteReturnFocus    = null;
  let _toastHideTimer       = null;
  let _searchDeleteFailure  = null;

  const _deferredDelete = createDeferredDelete({
    taskModel: tasks,
    onExpire: _onDeferredDeleteExpiry,
  });

  /** Open the native confirmation dialog for a valid custom task. */
  function _showDeleteConfirm(id) {
    if (_deferredDelete.getPending() || _deleteConfirmPending || !tasks.isCustomTask(id)) return;
    _searchDeleteFailure = null;
    const task = tasks.getAll().find(item => item.id === id);
    const dlg = document.getElementById('delete-confirm-dialog');
    const msg = document.getElementById('dc-message');
    const err = document.getElementById('dc-error');
    const confirmBtn = document.getElementById('dc-confirm');
    if (!task || !dlg || !msg || !confirmBtn) return;

    _deleteConfirmId = id;
    _deleteReturnFocus = document.activeElement;
    msg.textContent = `Delete “${task.title}”? You can undo this for 5 seconds.`;
    if (err) { err.hidden = true; err.textContent = ''; }
    confirmBtn.disabled = false;
    confirmBtn.removeAttribute('aria-busy');
    if (!dlg.open) dlg.showModal();
    requestAnimationFrame(() => confirmBtn.focus());
  }

  /** Hide a task in the live UI; persistence is deferred to the controller. */
  function _confirmDeferredDelete() {
    if (_deleteConfirmPending || !_deleteConfirmId) return;
    const id = _deleteConfirmId;
    const dialog = document.getElementById('delete-confirm-dialog');
    const confirmBtn = document.getElementById('dc-confirm');
    const err = document.getElementById('dc-error');
    _deleteConfirmPending = true;
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.setAttribute('aria-busy', 'true');
    }

    const started = _deferredDelete.begin(id);
    if (!started.ok) {
      _deleteConfirmPending = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.removeAttribute('aria-busy');
      }
      if (err) { err.textContent = started.message; err.hidden = false; }
      return;
    }

    _deleteConfirmId = null;
    _deleteReturnFocus = null; // Undo is the next meaningful focus target.
    dialog?.close();
    _renderAfterDeferredDeleteChange();
    _showDeleteToast(started.task);
  }

  /** Undo before expiry: the original record never left model or v1 storage. */
  function _undoDelete() {
    const pending = _deferredDelete.getPending();
    if (!pending || !_deferredDelete.undo(pending.id).ok) return;
    _renderAfterDeferredDeleteChange();
    _dismissToast();
  }

  /** Persist exactly the pending task after its five-second undo window. */
  function _onDeferredDeleteExpiry({ task, result }) {
    if (result.ok) {
      // Only after persistence succeeds may an empty custom-room filter reset.
      if (_roomFilter === task.room && !ROOMS_ORDERED.includes(_roomFilter) &&
          !tasks.getCustomRooms().includes(_roomFilter)) {
        const saved = _repo.savePrefs({ roomFilter: '' });
        if (saved.ok) { _roomFilter = ''; ui.updateRoomPickerBtn(''); }
      }
      _renderAfterDeferredDeleteChange();
      _dismissToast();
      return;
    }

    // removeTask is copy-on-write: on failure the original task and bytes stay
    // intact. Clearing the pending state makes that original visible again.
    _searchDeleteFailure = { task, message: result.message };
    _renderAfterDeferredDeleteChange();
    _showDeleteFailure(task, result.message);
  }

  function _renderAfterDeferredDeleteChange() {
    _syncHomeView();
    _refresh();
    if (searchDialog?.open) _applySrQuery(srInput.value);
  }

  /** Display the five-second undo notice for an in-memory pending deletion. */
  function _showDeleteToast(task) {
    clearTimeout(_toastHideTimer);
    const toastEl = document.getElementById('ht-toast');
    const msgEl   = document.getElementById('ht-toast-msg');
    const undoBtn = document.getElementById('ht-toast-undo');
    if (!toastEl || !msgEl || !undoBtn) return;
    toastEl.setAttribute('role', 'status');
    toastEl.classList.remove('ht-toast--error');
    msgEl.textContent = `Deleted “${task.title}”. Undo?`;
    undoBtn.hidden = false;
    undoBtn.setAttribute('aria-label', `Undo deleting ${task.title}`);
    toastEl.hidden = false;
    requestAnimationFrame(() => {
      toastEl.classList.add('is-visible');
      undoBtn.focus();
    });
  }

  function _showDeleteFailure(task, message) {
    if (searchDialog?.open) {
      _dismissToast();
      return;
    }
    clearTimeout(_toastHideTimer);
    const toastEl = document.getElementById('ht-toast');
    const msgEl = document.getElementById('ht-toast-msg');
    const undoBtn = document.getElementById('ht-toast-undo');
    if (!toastEl || !msgEl || !undoBtn) return;
    toastEl.setAttribute('role', 'alert');
    toastEl.classList.add('ht-toast--error');
    msgEl.textContent = `Could not delete “${task.title}”. ${message || 'Please try again.'}`;
    undoBtn.hidden = true;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('is-visible'));
    _toastHideTimer = setTimeout(_dismissToast, 5000);
  }

  function _dismissToast() {
    clearTimeout(_toastHideTimer);
    const toastEl = document.getElementById('ht-toast');
    if (!toastEl) return;
    toastEl.classList.remove('is-visible');
    setTimeout(() => { if (!toastEl.classList.contains('is-visible')) toastEl.hidden = true; }, 300);
  }

  function _wireDeleteDialog() {
    const dlg = document.getElementById('delete-confirm-dialog');
    const cancelBtn = document.getElementById('dc-cancel');
    const confirmBtn = document.getElementById('dc-confirm');
    if (!dlg || !cancelBtn || !confirmBtn) return;

    cancelBtn.addEventListener('click', () => dlg.close());
    confirmBtn.addEventListener('click', _confirmDeferredDelete);
    dlg.addEventListener('click', event => { if (event.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => {
      const target = _deleteReturnFocus;
      _deleteConfirmId = null;
      _deleteConfirmPending = false;
      _deleteReturnFocus = null;
      target?.focus?.();
    });
    document.getElementById('ht-toast-undo')?.addEventListener('click', _undoDelete);
    scrollLock.attach(dlg);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F1 — ADD TASK SHEET
  // ═══════════════════════════════════════════════════════════════════════

  let _selectedFreqDays = 7;
  let _addTaskReturnFocus = null;
  let _addTaskPending = false;

  /** Open the add-task dialog, optionally pre-filling a room and return target. */
  function _openAddTask(prefilledRoom, opener = document.activeElement) {
    const dlg = document.getElementById('add-task-dialog');
    if (!dlg || !CUSTOM_TASKS_UI_ENABLED) return;

    _addTaskReturnFocus = opener?.focus ? opener : document.getElementById('add-task-fab');
    document.getElementById('at-title-input').value = '';
    ['at-form-error', 'at-title-error', 'at-room-error', 'at-freq-error']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.hidden = true; el.textContent = ''; }
      });

    _populateRoomSelect(prefilledRoom || '');
    _setFreqDays(7);

    dlg.classList.add('is-entering');
    dlg.showModal();

    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sheet = dlg.querySelector('.at-sheet');
      const rect  = sheet?.getBoundingClientRect();
      const vh    = window.visualViewport?.height ?? window.innerHeight;
      if (!rect || rect.width === 0 || rect.top >= vh)
        dlg.classList.remove('is-entering');
      document.getElementById('at-title-input')?.focus();
    }));

    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; dlg.classList.remove('is-entering'); };
    dlg.querySelector('.at-sheet')?.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 500);
  }

  /** Populate the room <select> with all valid existing rooms. */
  function _populateRoomSelect(prefilledRoom) {
    const sel = document.getElementById('at-room-select');
    if (!sel) return;
    sel.innerHTML = '';

    const ph = document.createElement('option');
    ph.value = ''; ph.disabled = true; ph.selected = !prefilledRoom;
    ph.textContent = 'Choose a room\u2026';
    sel.appendChild(ph);

    ROOMS_ORDERED.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      if (r === prefilledRoom) opt.selected = true;
      sel.appendChild(opt);
    });

    const customRooms = tasks.getCustomRooms();
    if (customRooms.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = 'My Rooms';
      customRooms.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r; opt.textContent = r;
        if (r === prefilledRoom) opt.selected = true;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    }

  }

  function _setFreqDays(days) {
    _selectedFreqDays = days;
    const isCustom = days === 'custom';
    const wrap  = document.getElementById('at-freq-custom-wrap');
    const input = document.getElementById('at-freq-custom-input');
    if (wrap) wrap.hidden = !isCustom;
    document.querySelectorAll('.at-freq-btn').forEach(btn => {
      const d = btn.dataset.days === 'custom' ? 'custom' : Number(btn.dataset.days);
      const active = d === days;
      btn.classList.toggle('at-freq-btn--active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (!isCustom && input) input.value = days;
  }

  function _submitAddTask() {
    const dlg        = document.getElementById('add-task-dialog');
    const titleInput = document.getElementById('at-title-input');
    const selEl      = document.getElementById('at-room-select');
    const freqInput  = document.getElementById('at-freq-custom-input');
    const submitBtn  = document.getElementById('at-submit');
    const formErr    = document.getElementById('at-form-error');
    const titleErr   = document.getElementById('at-title-error');
    const roomErr    = document.getElementById('at-room-error');
    const freqErr    = document.getElementById('at-freq-error');

    [formErr, titleErr, roomErr, freqErr].forEach(el => { if (el) el.hidden = true; });
    if (_addTaskPending) return;

    const rawTitle = titleInput?.value ?? '';
    const rawRoom  = selEl?.value ?? '';
    const rawDays  = _selectedFreqDays === 'custom'
      ? Number(freqInput?.value ?? 7)
      : _selectedFreqDays;

    _addTaskPending = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute('aria-busy', 'true');
    }

    let result;
    try {
      result = tasks.addTask({ title: rawTitle, room: rawRoom, intervalDays: rawDays });
    } finally {
      _addTaskPending = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.removeAttribute('aria-busy');
      }
    }

    if (result.ok) {
      // The task write already succeeded. Keep it immediately visible even if
      // the non-critical view-preference write cannot be persisted.
      _repo.savePrefs({ viewMode: 'all', roomFilter: result.task.room });
      _viewMode = 'all';
      _roomFilter = result.task.room;
      ui.updateRoomPickerBtn(_roomFilter);
      _syncViewControl();
      _syncHomeView();
      dlg?.close();
      _refresh();
      requestAnimationFrame(() => {
        const card = taskListEl.querySelector(`[data-id="${CSS.escape(result.task.id)}"]`);
        card?.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      return;
    }

    const show = (el, msg) => { if (el) { el.textContent = msg; el.hidden = false; } };
    if      (result.code === 'validation-title')     { show(titleErr, result.message); titleInput?.focus(); }
    else if (result.code === 'validation-room')      { show(roomErr, result.message); selEl?.focus(); }
    else if (result.code === 'validation-interval')  { show(freqErr, result.message); freqInput?.focus(); }
    else if (result.code === 'validation-duplicate') { show(formErr, result.message); }
    else                                             { show(formErr, result.message || 'Could not save task. Please try again.'); }
  }

  function _wireAddTask() {
    const dlg = document.getElementById('add-task-dialog');
    if (!CUSTOM_TASKS_UI_ENABLED) {
      // Compatibility rollback: hide the FAB; loader still runs unconditionally.
      document.getElementById('add-task-fab')?.remove();
      return;
    }
    if (!dlg) return;

    document.getElementById('add-task-fab')
      ?.addEventListener('click', e => _openAddTask('', e.currentTarget));
    document.getElementById('at-close')
      ?.addEventListener('click', () => dlg.close());
    document.getElementById('at-cancel-btn')
      ?.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => {
      const target = _addTaskReturnFocus ?? document.getElementById('add-task-fab');
      _addTaskReturnFocus = null;
      target?.focus();
    });

    document.querySelectorAll('.at-freq-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = btn.dataset.days;
        _setFreqDays(d === 'custom' ? 'custom' : Number(d));
      });
    });

    document.getElementById('at-form')
      ?.addEventListener('submit', e => { e.preventDefault(); _submitAddTask(); });

    scrollLock.attach(dlg);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F1 — EXPLICIT CUSTOM-ROOM LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  let _createRoomReturnFocus = null;
  let _createRoomPending = false;
  let _roomDeleteName = null;
  let _roomDeleteReturnFocus = null;

  function _openCreateRoom(opener = document.activeElement) {
    const dlg = document.getElementById('create-room-dialog');
    if (!dlg || !CUSTOM_TASKS_UI_ENABLED) return;
    _createRoomReturnFocus = opener?.focus ? opener : roomPickerBtn;
    const input = document.getElementById('cr-name-input');
    const error = document.getElementById('cr-error');
    if (input) input.value = '';
    if (error) { error.hidden = true; error.textContent = ''; }
    dlg.classList.add('is-entering');
    dlg.showModal();
    requestAnimationFrame(() => requestAnimationFrame(() => input?.focus()));
    const cleanup = () => dlg.classList.remove('is-entering');
    dlg.querySelector('.cr-sheet')?.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 500);
  }

  function _submitCreateRoom() {
    if (_createRoomPending) return;
    const dlg = document.getElementById('create-room-dialog');
    const input = document.getElementById('cr-name-input');
    const error = document.getElementById('cr-error');
    const submit = document.getElementById('cr-submit');
    if (error) { error.hidden = true; error.textContent = ''; }
    _createRoomPending = true;
    if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); }
    let result;
    try { result = tasks.createRoom({ name: input?.value ?? '' }); }
    finally {
      _createRoomPending = false;
      if (submit) { submit.disabled = false; submit.removeAttribute('aria-busy'); }
    }
    if (!result.ok) {
      if (error) {
        error.textContent = result.message || 'Could not save room. Please try again.';
        error.hidden = false;
      }
      input?.focus();
      return;
    }

    // Room data is persisted before display state changes. Preference failure is
    // non-critical here: the room exists and remains usable on the next launch.
    _repo.savePrefs({ viewMode: 'all', roomFilter: result.room.name });
    _roomFilter = result.room.name;
    _viewMode = 'all';
    ui.updateRoomPickerBtn(_roomFilter);
    _syncViewControl();
    _syncHomeView();
    dlg?.close();
    _refresh();
  }

  function _showRoomDeleteConfirm(name, opener = document.activeElement) {
    if (!tasks.isCustomRoom(name)) return;
    const dlg = document.getElementById('delete-room-dialog');
    const message = document.getElementById('dr-message');
    const error = document.getElementById('dr-error');
    const confirm = document.getElementById('dr-confirm');
    if (!dlg || !message || !confirm) return;
    _roomDeleteName = name;
    _roomDeleteReturnFocus = opener?.focus ? opener : roomPickerBtn;
    message.textContent = `Delete “${name}”? Tasks in this room will not be moved or deleted.`;
    if (error) { error.hidden = true; error.textContent = ''; }
    confirm.disabled = false;
    if (!dlg.open) dlg.showModal();
    requestAnimationFrame(() => confirm.focus());
  }

  function _confirmRoomDelete() {
    if (!_roomDeleteName) return;
    const result = tasks.removeRoom(_roomDeleteName);
    const dlg = document.getElementById('delete-room-dialog');
    const error = document.getElementById('dr-error');
    if (!result.ok) {
      if (error) {
        error.textContent = result.message || 'Could not delete room. Please try again.';
        error.hidden = false;
      }
      return;
    }

    const removedWasSelected = _roomFilter.trim().toLowerCase() === result.room.name.trim().toLowerCase();
    if (removedWasSelected) {
      const fallback = ROOMS_ORDERED[0];
      _repo.savePrefs({ viewMode: 'all', roomFilter: fallback });
      _roomFilter = fallback;
      _viewMode = 'all';
      ui.updateRoomPickerBtn(fallback);
      _syncViewControl();
      _syncHomeView();
    }
    dlg?.close();
    // The room-delete confirmation is opened from inside the room-picker
    // modal. Close that underlying modal before restoring focus to its
    // trigger; otherwise focus would escape an open native dialog.
    if (roomPickerDialog?.open) roomPickerDialog.close();
    _renderRoomPicker();
    _refresh();
    requestAnimationFrame(() => roomPickerBtn.focus());
  }

  function _wireCustomRoomLifecycle() {
    const createDlg = document.getElementById('create-room-dialog');
    const deleteDlg = document.getElementById('delete-room-dialog');
    if (!CUSTOM_TASKS_UI_ENABLED) {
      document.getElementById('rp-create-room')?.remove();
      return;
    }
    document.getElementById('cr-close')?.addEventListener('click', () => createDlg?.close());
    document.getElementById('cr-cancel')?.addEventListener('click', () => createDlg?.close());
    createDlg?.addEventListener('click', event => { if (event.target === createDlg) createDlg.close(); });
    createDlg?.addEventListener('close', () => {
      const target = _createRoomReturnFocus ?? roomPickerBtn;
      _createRoomReturnFocus = null;
      target?.focus?.();
    });
    document.getElementById('cr-form')?.addEventListener('submit', event => {
      event.preventDefault();
      _submitCreateRoom();
    });

    document.getElementById('dr-cancel')?.addEventListener('click', () => deleteDlg?.close());
    document.getElementById('dr-confirm')?.addEventListener('click', _confirmRoomDelete);
    deleteDlg?.addEventListener('click', event => { if (event.target === deleteDlg) deleteDlg.close(); });
    deleteDlg?.addEventListener('close', () => {
      const target = _roomDeleteReturnFocus;
      _roomDeleteName = null;
      _roomDeleteReturnFocus = null;
      target?.focus?.();
    });
  }

  return { init };
})();

export { app };
