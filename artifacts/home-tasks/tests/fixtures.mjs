/**
 * fixtures.mjs — immutable golden v1 fixtures for the CP1 suite.
 *
 * Sanitized, realistic copies of existing v1 states (CP1 guardrail 3).
 * Every fixture is deep-frozen; tests receive RAW STRINGS (as the keys
 * would hold) via raw(), so no fixture can be mutated by a test and no
 * real localStorage/sessionStorage is ever touched (guardrail 9).
 *
 * All dates are relative to the injected FIXED_TODAY so results are
 * deterministic forever.
 */

export const FIXED_TODAY = '2026-07-31';

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

/** Serialize a fixture the way the v1 keys store it. */
export const raw = v => (v === null || v === undefined) ? null : JSON.stringify(v);

// Date helpers relative to FIXED_TODAY (precomputed, not clock-derived).
export const D = deepFreeze({
  today: FIXED_TODAY,
  yesterday: '2026-07-30',
  lastWeek: '2026-07-24',
  monthAgo: '2026-07-01',
  longAgo: '2026-01-15',
  tomorrow: '2026-08-01',
  nextWeek: '2026-08-05',
});

const t = (id, over = {}) =>
  ({ id, title: 'ignored — seed wins', room: 'ignored', intervalDays: 999,
     tags: [], lastDone: null, doneToday: false, skipUntil: null, ...over });

export const FIXTURES = deepFreeze({

  /** 1 · Fresh install / pre-onboarding: no keys at all. */
  fresh: { v1TasksRaw: null, v1MetaRaw: null, v1RecentsRaw: null, lastExport: null },

  /** 2 · Empty-but-present storage. */
  empty: { v1TasksRaw: '[]', v1MetaRaw: '{}', v1RecentsRaw: '[]', lastExport: null },

  /** 3 · Typical heavy use: done-today, history, skips, tags, prefs, recents. */
  typical: {
    v1TasksRaw: raw([
      t('mb-floor',        { lastDone: D.today, doneToday: true }),          // completed today
      t('mb-baseboards',   { lastDone: D.longAgo }),                          // deep history
      t('mb-doorknob',     { lastDone: D.lastWeek }),
      t('md-floor',        { lastDone: D.monthAgo, skipUntil: D.nextWeek }), // skip override
      t('md-cobweb',       { skipUntil: D.tomorrow }),                        // never done, skipped
      t('smoke-batteries', { lastDone: D.longAgo }),                          // safety, overdue
      t('to-floor',        { lastDone: D.yesterday, tags: ['deep-clean'] }), // user tag preserved
    ]),
    v1MetaRaw: raw({ onboarded: true, choice: 'guided', completedAt: '2026-06-01T10:00:00.000Z',
                     viewMode: 'week', roomFilter: "Madi's Room" }),
    v1RecentsRaw: raw(['oven', 'windows']),
    lastExport: '2026-07-20',
  },

  /** 4 · Legacy / inconsistent doneToday combinations. */
  inconsistentDoneToday: {
    v1TasksRaw: raw([
      t('mb-floor',      { doneToday: true, lastDone: D.yesterday }),  // true + stale lastDone
      t('mb-doorknob',   { doneToday: true, lastDone: null }),         // true + never done
      t('mb-baseboards', { doneToday: false, lastDone: D.today }),     // false + done today (legal, stays false)
      t('md-floor',      { doneToday: 'yes', lastDone: D.today }),     // non-boolean truthy
    ]),
    v1MetaRaw: raw({ onboarded: true, viewMode: 'today', roomFilter: '' }),
    v1RecentsRaw: null, lastExport: null,
  },

  /** 5 · Legacy dueNowDefault metas (no viewMode saved). */
  legacyDueNowTrue:  { v1TasksRaw: '[]', v1MetaRaw: raw({ onboarded: true, dueNowDefault: true }),  v1RecentsRaw: null, lastExport: null },
  legacyDueNowFalse: { v1TasksRaw: '[]', v1MetaRaw: raw({ onboarded: true, dueNowDefault: false }), v1RecentsRaw: null, lastExport: null },

  /** 6 · Retired + unknown IDs mixed with real history. */
  retiredAndUnknown: {
    v1TasksRaw: raw([
      t('mb-floor',   { lastDone: D.lastWeek }),
      t('mbath-all',  { lastDone: D.monthAgo }),   // retired (tombstoned)
      t('hb-all',     { skipUntil: D.tomorrow }),  // retired
      t('ghost-task', { lastDone: D.today }),      // unknown — never existed
    ]),
    v1MetaRaw: raw({ onboarded: true, viewMode: 'all', roomFilter: 'No Such Room' }),
    v1RecentsRaw: null, lastExport: null,
  },

  /** 7 · Malformed-but-recoverable records. */
  malformedRecords: {
    v1TasksRaw: raw([
      t('mb-floor',      { lastDone: 'not-a-date' }),        // bad date → null
      t('mb-doorknob',   { skipUntil: 12345 }),               // bad type → null
      t('mb-baseboards', { tags: 'deep-clean' }),             // bad tags → []
      { title: 'record with no id' },                          // dropped, reported
      t('md-floor',      { lastDone: D.lastWeek }),           // healthy neighbor survives
    ]),
    v1MetaRaw: raw({ onboarded: true, viewMode: 'bogus-mode', roomFilter: '' }),
    v1RecentsRaw: raw(['ok', 42, null]),                       // non-strings filtered
    lastExport: 'not-a-date',
  },

  /** 8 · Damaged JSON (recoverable elsewhere; migration must not throw). */
  damagedJson: { v1TasksRaw: '{"not":"an array"', v1MetaRaw: '<<<garbage>>>', v1RecentsRaw: '{', lastExport: null },

  /** 9 · Partially populated: tasks only, no meta/recents. */
  partial: {
    v1TasksRaw: raw([t('k-stove-sink', { lastDone: D.yesterday })]),
    v1MetaRaw: null, v1RecentsRaw: null, lastExport: null,
  },
});
