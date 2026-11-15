/* Extracted mechanically from src/script.js lines 1194–1648 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { computeWorkload, isActionableNow } from '../workload.js';
import { esc, isCompletedToday, todayStr } from './util.js';
import { ROOMS_ORDERED } from './catalog.js';
import { computeEffectiveDue } from './due.js';
import { tasks } from './tasks.js';
import { statusOf } from './status.js';
import { search } from './search.js';
import { CUSTOM_TASKS_UI_ENABLED } from './custom-tasks-config.js';

/* ── UI module ────────────────────────────────────────────────── */
const ui = (() => {
  const listEl          = document.getElementById('task-list');
  const emptyEl         = document.getElementById('global-empty');
  const emptyIcon       = emptyEl.querySelector('.empty-icon');
  const emptyTitle      = emptyEl.querySelector('.empty-title');
  const emptyBody       = emptyEl.querySelector('.empty-body');
  const countEl         = document.getElementById('attention-count');
  const progressEl      = document.getElementById('progress-count');
  const progressBar     = document.getElementById('progress-bar');
  const roomPickerBtn   = document.getElementById('room-picker-btn');
  const roomPickerLabel = document.getElementById('room-picker-label');
  const rpListEl        = document.getElementById('rp-list');

  /** Injected V1Repository — set once by app.init(repo) before first render. */
  let _repo = null;

  function setRepo(r) {
    if (!r || typeof r !== 'object')
      throw new Error('[HomeTask] ui.setRepo: invalid repository');
    if (_repo === null) { _repo = r; return; }
    if (_repo === r)   return;
    throw new Error('[HomeTask] ui.setRepo: repository already set — late authority swap rejected');
  }

  // Tracks the active view, query, and room so patchCard() can call
  // _updateCountAndProgress() with full context without needing to pass ctx.
  let _currentViewMode = 'today';
  let _currentQuery    = '';
  let _currentRoom     = '';
  let _hiddenTaskId    = null;

  /** Lazy lookup so a stale cached HTML (missing the button) doesn't crash. */
  function _emptyActionEl() {
    return document.getElementById('empty-action-btn');
  }

  /**
   * Update the room picker trigger button label + active state.
   * Called whenever the room filter changes.
   * @param {string} activeRoom  '' = All rooms, or a room name
   */
  function updateRoomPickerBtn(activeRoom) {
    const label = activeRoom || 'All rooms';
    roomPickerLabel.textContent = label;
    roomPickerBtn.setAttribute(
      'aria-label',
      `Filter by room — currently showing ${label}`
    );
    roomPickerBtn.classList.toggle('active', Boolean(activeRoom));
  }

  /**
   * Populate the room picker list inside the bottom-sheet dialog.
   * Renders "All rooms" first, then all rooms in ROOMS_ORDERED order,
   * filtered by the search query.
   *
   * @param {string}   activeRoom   Currently selected room ('' = All rooms)
   * @param {string}   query        Search string from the picker's search input
   * @param {Function} onSelect     Callback(roomName) when user picks a room
   * @param {Function} onDelete     Callback(roomName, opener) for custom rooms
   */
  function buildRoomList(activeRoom, query, onSelect, onDelete = null) {
    rpListEl.innerHTML = '';
    const q = (query ?? '').trim().toLowerCase();

    /** Helper: render one option li and append to rpListEl */
    function _appendOption(value, label, canDelete = false) {
      const selected = value === activeRoom;
      const li = document.createElement('li');
      li.className = 'rp-option';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', selected ? 'true' : 'false');
      li.innerHTML = `<span>${esc(label)}</span><span class="rp-option-check" aria-hidden="true">✓</span>`;
      li.addEventListener('click', () => onSelect(value));
      if (canDelete && typeof onDelete === 'function') {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'rp-option-delete';
        deleteBtn.textContent = 'Delete';
        deleteBtn.setAttribute('aria-label', `Delete room ${label}`);
        deleteBtn.addEventListener('click', event => {
          event.stopPropagation();
          onDelete(value, deleteBtn);
        });
        li.appendChild(deleteBtn);
      }
      rpListEl.appendChild(li);
    }

    // Build ordered entries: [value, label]
    const entries = [['', 'All rooms'], ...ROOMS_ORDERED.map(r => [r, r])];
    const filtered = entries.filter(([, label]) =>
      !q || label.toLowerCase().includes(q)
    );

    // Custom rooms (F1)
    const customRooms = CUSTOM_TASKS_UI_ENABLED ? tasks.getCustomRooms() : [];
    const filteredCustom = customRooms.filter(r =>
      !q || r.toLowerCase().includes(q)
    );

    if (filtered.length === 0 && filteredCustom.length === 0) {
      const li = document.createElement('li');
      li.className = 'rp-empty';
      li.textContent = 'No rooms match';
      rpListEl.appendChild(li);
      return;
    }

    filtered.forEach(([value, label]) => _appendOption(value, label));

    // Custom rooms section with divider label
    if (filteredCustom.length > 0) {
      const divider = document.createElement('li');
      divider.className = 'rp-divider';
      divider.setAttribute('aria-hidden', 'true');
      divider.textContent = 'My Rooms';
      rpListEl.appendChild(divider);
      filteredCustom.forEach(r => _appendOption(r, r, true));
    }
  }

  /**
   * Render grouped task list.
   * @param {Array}  filteredTasks  Tasks after search + room + view filters
   * @param {Object} ctx            { viewMode, roomFilter, query, onSwitchView }
   */
  function render(filteredTasks, ctx = {}) {
    _currentViewMode = ctx.viewMode    || 'today';
    _currentQuery    = ctx.query       || '';
    _currentRoom     = ctx.roomFilter  || '';
    _hiddenTaskId    = ctx.hiddenTaskId || null;
    listEl.innerHTML = '';

    if (filteredTasks.length === 0) {
      emptyEl.hidden = false;
      const msg = _emptyMessage(ctx);
      emptyIcon.textContent  = msg.icon;
      emptyTitle.textContent = msg.title;
      emptyBody.textContent  = msg.body;

      // Show/hide the action button (guarded: button may be absent in cached HTML)
      const actionEl = _emptyActionEl();
      if (actionEl) {
        if (msg.action && ctx.onSwitchView && msg.targetView) {
          // Clone to replace any prior click listener cleanly
          const fresh = actionEl.cloneNode(false);
          fresh.textContent = msg.action;
          fresh.hidden = false;
          actionEl.replaceWith(fresh);
          fresh.addEventListener('click', () => ctx.onSwitchView(msg.targetView), { once: true });
        } else {
          actionEl.hidden = true;
        }
      }

      _updateCountAndProgress();
      return;
    }
    emptyEl.hidden = true;
    const _ael = _emptyActionEl();
    if (_ael) _ael.hidden = true;

    // Initialize with catalog rooms in their canonical order.
    // Also pre-add custom rooms so the Map insertion order puts catalog first.
    const groups = new Map();
    ROOMS_ORDERED.forEach(r => groups.set(r, []));
    if (CUSTOM_TASKS_UI_ENABLED) {
      tasks.getCustomRooms().forEach(r => { if (!groups.has(r)) groups.set(r, []); });
    }
    // Push every filtered task into its room group; add any unseen room on the fly.
    filteredTasks.forEach(t => {
      if (!groups.has(t.room)) groups.set(t.room, []);
      groups.get(t.room).push(t);
    });

    groups.forEach((roomTasks, roomName) => {
      if (roomTasks.length === 0) return;
      listEl.appendChild(_roomGroup(roomName, roomTasks));
    });

    _updateCountAndProgress();
  }

  /**
   * Context-aware empty state message.
   * Returns { icon, title, body, action?, targetView? }
   *   action + targetView: optional button that switches to another view.
   */
  function _emptyMessage({ viewMode, roomFilter } = {}) {

    /* ── Today view ─────────────────────────────────────────────── */
    if (viewMode === 'today') {
      if (roomFilter) {
        return {
          icon:       '✅',
          title:      'Nothing Needs Attention In This Room Today.',
          body:       `${roomFilter} has tasks, but none are due or overdue right now.`,
          action:     'View All Tasks In This Room',
          targetView: 'all',
        };
      }
      return {
        icon:       '✅',
        title:      "You're caught up for today.",
        body:       "No overdue or due-today tasks. Check back later or see what's coming up.",
        action:     'View this week',
        targetView: 'week',
      };
    }

    /* ── This Week view ─────────────────────────────────────────── */
    if (viewMode === 'week') {
      if (roomFilter) {
        return {
          icon:       '✅',
          title:      `${roomFilter} is all caught up this week.`,
          body:       'Nothing is due this week in this room.',
          action:     'View All Tasks In This Room',
          targetView: 'all',
        };
      }
      return {
        icon:       '🎉',
        title:      'Nothing else is due this week.',
        body:       "You're all caught up for the week.",
        action:     'View all tasks',
        targetView: 'all',
      };
    }

    /* ── All Tasks view ─────────────────────────────────────────── */
    if (roomFilter) {
      return {
        icon:  '🏠',
        title: `No tasks found in ${roomFilter}.`,
        body:  'No tasks have been added to this room.',
      };
    }
    return {
      icon:  '✓',
      title: 'Nothing to show',
      body:  'All tasks are complete or hidden.',
    };
  }

  /**
   * Update the header subtitle (calm view-aware summary) and daily progress.
   * Called after every render or card patch.
   *
   * Subtitle categories (non-overlapping):
   *   safety      — type === 'critical' (severely overdue safety tasks)
   *   overdue     — type === 'overdue'  (past due, non-safety)
   *   dueToday    — type === 'soon' AND effectiveDue === today
   *   laterWeek   — type === 'soon' AND effectiveDue 1–7 days out
   *   done        — type === 'done' (completed today)
   *
   * When a room or search filter is active, the subtitle summarises that
   * filtered context (e.g. "Kitchen is caught up today"). The global
   * progress bar always reflects the full 126-task catalog.
   */
  function _updateCountAndProgress() {
    const all   = tasks.getAll().filter(task => task.id !== _hiddenTaskId);
    const today = todayStr();
    const total = all.length;

    // ── Pre-onboarding state ──────────────────────────────────────────────
    // Before the user completes Smart Start, every task has lastDone: null and
    // no skipUntil, so statusOf.compute() returns type 'critical' for all of
    // them. That would produce "122 safety checks" which is wrong.
    // Show a neutral catalog count instead.
    if (!_repo.loadPrefs().onboarded) {
      countEl.textContent  = `${total} task${total === 1 ? '' : 's'} ready to schedule`;
      progressEl.textContent = '';
      document.documentElement.style.setProperty('--progress-pct', '0%');
      return;
    }

    // ── Full-catalog counts — the single authoritative workload function.
    //    The Home screen, Today header, and progress line all read from
    //    this same computation so the numbers can never disagree.
    const wl = computeWorkload(all, statusOf.compute, computeEffectiveDue, today);
    const doneToday    = wl.doneToday;
    const allDueToday  = wl.attention;   // critical + overdue + dueToday
    const allLaterWeek = wl.laterWeek;

    // ── Filter-context counts (subtitle) ─────────────────────────────────
    // Apply the same search + room filter as the visible list, then bucket.
    const hasFilter = _currentQuery.length > 0 || _currentRoom.length > 0;
    const source    = hasFilter
      ? search.filter(all, _currentQuery, _currentRoom)
      : all;

    let safetyCt    = 0;  // 'critical'
    let overdueCt   = 0;  // 'overdue'
    let dueTodayCt  = 0;  // 'soon' + today
    let laterWeekCt = 0;  // 'soon' + 1–7 days

    source.forEach(t => {
      const { type } = statusOf.compute(t);
      if      (type === 'critical') safetyCt++;
      else if (type === 'overdue')  overdueCt++;
      else if (type === 'soon') {
        if (computeEffectiveDue(t) === today) dueTodayCt++;
        else                                   laterWeekCt++;
      }
      // 'done' and 'future' intentionally excluded from urgency summary
    });

    const roomLabel = _currentRoom || '';

    // Helper: build parts string, with optional "in {room}" suffix.
    function withRoom(parts) {
      return roomLabel
        ? parts.join(' · ') + ` in ${roomLabel}`
        : parts.join(' · ');
    }

    // ── Primary subtitle ─────────────────────────────────────────────────
    let subtitle;
    if (_currentViewMode === 'today') {
      if (!hasFilter && wl.attention > 0) {
        // Primary header info: the shared attention count (matches Home)
        subtitle = `${wl.attention} Need Attention Today`;
      } else if (hasFilter && safetyCt + overdueCt + dueTodayCt > 0) {
        const urgentParts = [];
        if (safetyCt   > 0) urgentParts.push(`${safetyCt} safety check${safetyCt > 1 ? 's' : ''}`);
        if (overdueCt  > 0) urgentParts.push(`${overdueCt} overdue`);
        if (dueTodayCt > 0) urgentParts.push(`${dueTodayCt} due today`);
        subtitle = withRoom(urgentParts);
      } else {
        // Caught up
        if (roomLabel)          subtitle = `${roomLabel} is caught up today`;
        else if (_currentQuery) subtitle = 'No matching tasks due today';
        else                    subtitle = "You're caught up today";
      }

    } else if (_currentViewMode === 'week') {
      const weekParts = [];
      if (safetyCt    > 0) weekParts.push(`${safetyCt} safety check${safetyCt > 1 ? 's' : ''}`);
      if (overdueCt   > 0) weekParts.push(`${overdueCt} overdue`);
      if (dueTodayCt  > 0) weekParts.push(`${dueTodayCt} today`);
      if (laterWeekCt > 0) weekParts.push(`${laterWeekCt} later this week`);

      if (weekParts.length > 0) {
        subtitle = hasFilter ? withRoom(weekParts) : weekParts.join(' · ');
      } else {
        if (roomLabel)          subtitle = `${roomLabel} is all caught up this week`;
        else if (_currentQuery) subtitle = 'No matching tasks due this week';
        else                    subtitle = "You're caught up for the week";
      }

    } else {
      // 'all' — neutral catalog total, no urgency language.
      // The interactive "N Total Tasks" control lives in #total-tasks-btn.
      subtitle = `All ${total} task${total === 1 ? '' : 's'}`;
    }
    countEl.textContent = subtitle;

    // ── Total-catalog button (accessible "View All N Tasks" control) ─────
    const totalBtn = document.getElementById('total-tasks-btn');
    if (totalBtn) {
      totalBtn.textContent = `${total} Total Tasks`;
      totalBtn.setAttribute('aria-label', `View All ${total} Tasks`);
      // Hidden in 'all' view (redundant with the subtitle there)
      totalBtn.hidden = _currentViewMode === 'all';
    }

    // ── Secondary / progress line ─────────────────────────────────────────
    // Today:     "X coming up this week" when caught up (unfiltered),
    //            else "X of Y done today" when any progress exists.
    // This Week: "X of Y done today" when any progress exists.
    // All Tasks: "X due today · Y later this week" breakdown,
    //            plus "Z of N done today" when progress exists.
    // Always uses full-catalog counts to stay filter-independent.
    let progressText = '';
    if (_currentViewMode === 'today' && !hasFilter && allLaterWeek > 0
        && safetyCt + overdueCt + dueTodayCt === 0) {
      // Caught up today — show what's coming
      progressText = `${allLaterWeek} coming up this week`;
      if (doneToday > 0) progressText += ` · ${doneToday} of ${total} done today`;
    } else if (_currentViewMode === 'all' && !hasFilter) {
      const secParts = [];
      if (allDueToday  > 0) secParts.push(`${allDueToday} due today`);
      if (allLaterWeek > 0) secParts.push(`${allLaterWeek} later this week`);
      if (doneToday    > 0) secParts.push(`${doneToday} of ${total} done today`);
      progressText = secParts.join(' · ');
    } else {
      progressText = doneToday > 0 ? `${doneToday} of ${total} done today` : '';
    }
    progressEl.textContent = progressText;

    // ── Progress bar ──────────────────────────────────────────────────────
    const pct = total > 0 ? ((doneToday / total) * 100).toFixed(1) : 0;
    document.documentElement.style.setProperty('--progress-pct', `${pct}%`);
  }

  /**
   * Toggle the subtitle live region on/off.
   * Called by app._setQuery to suppress VoiceOver announcements during
   * rapid search keystrokes; restored once the debounce fires.
   */
  function setSearching(active) {
    countEl.setAttribute('aria-live', active ? 'off' : 'polite');
  }

  function _roomGroup(roomName, roomTasks) {
    const section = document.createElement('section');
    section.className = 'room-group';
    section.setAttribute('aria-label', roomName);

    const header = document.createElement('div');
    header.className = 'room-header';
    const countLabel = `${roomTasks.length} task${roomTasks.length !== 1 ? 's' : ''}`;
    const addBtn = CUSTOM_TASKS_UI_ENABLED
      ? `<button class="room-add-btn js-room-add" type="button"
                 aria-label="Add task to ${esc(roomName)}"
                 data-room="${esc(roomName)}">+</button>`
      : '';
    header.innerHTML = `
      <h2 class="room-name">${esc(roomName)}</h2>
      <div class="room-header-right">
        <span class="room-count" aria-label="${countLabel}">${roomTasks.length}</span>
        ${addBtn}
      </div>`;
    section.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'room-tasks';
    // Pass index for staggered entrance animation (--i CSS custom property)
    roomTasks.forEach((task, idx) => ul.appendChild(_taskCard(task, idx)));
    section.appendChild(ul);

    return section;
  }

  /**
   * Build the inner HTML of a task card <article>.
   * Shared by _taskCard (initial render) and patchCard (in-place update)
   * so the Skip-visibility rule can never diverge between the two paths.
   *
   * Skip Today / Skip Week render ONLY when the task requires attention
   * now (isActionableNow) — hidden controls are fully absent from the DOM,
   * so they are removed from keyboard and VoiceOver navigation.
   */
  function _cardInner(task) {
    const s = statusOf.compute(task);

    const intervalLabel  = `Every ${task.intervalDays}d`;
    const completed      = isCompletedToday(task);
    const doneBtnClass   = completed ? 'btn-done btn-done--completed js-done' : 'btn-done js-done';
    const doneBtnLabel   = completed ? '✓ Done today' : 'Done';

    const dueIsToday = computeEffectiveDue(task) === todayStr();
    const showSkips  = isActionableNow(s.type, dueIsToday);

    const skipRow = showSkips ? `
        <div class="card-row-actions">
          <button class="btn-skip js-skip-today"
                  aria-label="Skip Today — shift due date for ${esc(task.title)} forward by 1 day"
                  data-id="${esc(task.id)}">Skip Today</button>
          <button class="btn-skip js-skip-week"
                  aria-label="Skip Week — shift due date for ${esc(task.title)} forward by 7 days"
                  data-id="${esc(task.id)}">Skip Week</button>
        </div>` : '';

    const deleteBtn = (CUSTOM_TASKS_UI_ENABLED && task._custom)
      ? `<button class="btn-delete js-delete" type="button"
                 aria-label="Delete ${esc(task.title)}"
                 data-id="${esc(task.id)}">
           <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"
                viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                aria-hidden="true">
             <polyline points="3 6 5 6 21 6"/>
             <path d="M19 6l-1 14H6L5 6"/>
             <path d="M10 11v6M14 11v6"/>
             <path d="M9 6V4h6v2"/>
           </svg>
         </button>`
      : '';

    return `
        <div class="card-row-main">
          <span class="task-title">${esc(task.title)}</span>
          <button class="${doneBtnClass}"
                  aria-label="Mark ${esc(task.title)} done"
                  data-id="${esc(task.id)}">
            ${doneBtnLabel}
          </button>
        </div>
        <div class="card-row-meta">
          <span class="meta-interval">${intervalLabel}</span>
          <span class="status-badge ${s.badgeClass}"
                role="status"
                aria-label="${esc(s.label)}">${esc(s.label)}</span>
          ${deleteBtn}
        </div>${skipRow}`;
  }

  function _taskCard(task, staggerIdx = 0) {
    const li = document.createElement('li');
    // Set --i so CSS animation-delay creates a stagger within each group
    li.style.setProperty('--i', staggerIdx);
    const s = statusOf.compute(task);
    li.innerHTML = `
      <article class="task-card ${s.cardClass}" data-id="${esc(task.id)}">${_cardInner(task)}
      </article>`;
    return li;
  }

  /**
   * Update a single card in-place after Done / Skip action.
   * Rebuilds the card's inner HTML from the shared builder so status,
   * done button, and Skip-control visibility always update together
   * (e.g. skipping into the future removes the Skip buttons).
   */
  function patchCard(id) {
    const article = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!article) return;
    const task = tasks.getAll().find(t => t.id === id);
    if (!task) return;

    const s = statusOf.compute(task);
    article.className = `task-card ${s.cardClass}`;
    article.innerHTML = _cardInner(task);

    _updateCountAndProgress();
  }

  return { updateRoomPickerBtn, buildRoomList, render, patchCard, setSearching, setRepo };
})();

export { ui };
