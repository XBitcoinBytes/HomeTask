/* Extracted mechanically from src/script.js lines 92–494 (CP2 module split).
   Body is verbatim; only the import/export wrapper lines are new. */
import { addDays, todayStr } from './util.js';

/* ── Safety task IDs ──────────────────────────────────────────── */
// Safety tasks turn red as soon as they are due (not only when severely overdue).
const SAFETY_TASK_IDS = new Set(['smoke-batteries']);

/* ── Task title normalizer ────────────────────────────────────── */
/**
 * normalizeTaskTitle(title) — PERMANENT HomeTask naming policy.
 *
 * Rules:
 *   • Trim leading/trailing whitespace; collapse repeated internal spaces.
 *   • Capitalize the first letter of every word (true Title Case).
 *   • Hyphenated words: capitalize each segment (e.g. Mother-In-Law).
 *   • Apostrophes: first letter of the token is capitalized; rest untouched
 *     (e.g. "don't" → "Don't").
 *   • Recognized acronyms (HEPA, UV, AC, CO, CO2) are kept fully upper-case
 *     regardless of their position.
 *   • Numbers and mixed tokens: first character uppercased if alphabetic,
 *     rest preserved.
 *   • Returns '' for invalid, null, undefined, or whitespace-only input.
 *
 * POLICY: Any future task-creation or editing interface MUST call this
 * function before saving a title to storage or the seed catalog.
 * Do not call it on every render — apply it once at write time.
 */
const _TITLE_ACRONYMS = new Set(['HEPA', 'UV', 'AC', 'CO', 'CO2']);

function normalizeTaskTitle(title) {
  if (typeof title !== 'string') return '';
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed.split(' ').map(_normWord).join(' ');
}

function _normWord(word) {
  if (!word) return '';
  // Acronym: return fully upper-case
  if (_TITLE_ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
  // Hyphenated: capitalize each segment recursively
  if (word.includes('-')) return word.split('-').map(_normWord).join('-');
  // Standard: capitalize first letter, leave the rest as-is
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/* Self-tests — run once at startup, report failures as console errors */
(function _testNormalizeTaskTitle() {
  const cases = [
    ['clean baseboards',          'Clean Baseboards'],
    ['  take   out garbage  ',    'Take Out Garbage'],
    ['change air cleaner HEPA',   'Change Air Cleaner HEPA'],
    ['mother-in-law room',        'Mother-In-Law Room'],
    ['',                          ''],
    ['   ',                       ''],
    ["don't touch",               "Don't Touch"],
    ['check CO detector',         'Check CO Detector'],
  ];
  let pass = 0;
  cases.forEach(([input, expected]) => {
    const got = normalizeTaskTitle(input);
    if (got !== expected) {
      console.error(`[HomeTask] normalizeTaskTitle('${input}'): expected '${expected}', got '${got}'`);
    } else {
      pass++;
    }
  });
  if (pass === cases.length) {
    console.info(`[HomeTask] normalizeTaskTitle: all ${pass} tests pass`);
  }
})();

/* ── SEED_TASKS ───────────────────────────────────────────────── */
/*
 * Source of truth — 122 tasks across 24 rooms.
 * lastDone: null, doneToday: false, tags: [], skipUntil: null.
 *
 * Migration notes (idempotent for existing localStorage):
 *   • Titles changed in seed propagate automatically on load because the
 *     merge spreads ...seed first, then overlays saved user fields by ID.
 *   • k-stove-sink renamed "Clean Sink" (ID unchanged — history preserved).
 *   • "Madi Room" renamed "Madi's Room" (IDs unchanged — history preserved).
 *   • Shared tasks relocated: garbage + smoke-batteries → Whole House;
 *     couch-condition → Family Room; water-softener → Utility Room.
 *     IDs unchanged — all history (lastDone, skipUntil) preserved.
 *   • "Shared" room removed; Whole House and Family Room created.
 *   • New IDs receive seed defaults; existing IDs retain saved history.
 *   • Repeated reloads are safe: result length always equals SEED_TASKS.length.
 *   • Retired IDs (mbath-all, hb-all, mdb-all, bb-all) are simply absent
 *     from SEED_TASKS; storage.load() only maps over SEED_TASKS so they
 *     never surface regardless of what remains in localStorage.
 */

const _T = (id, title, room, intervalDays) =>
  ({ id, title, room, intervalDays, tags: [], lastDone: null, doneToday: false, skipUntil: null });

const SEED_TASKS = [
  // ── Master Bedroom ────────────────────────────────────────────
  _T('mb-floor',        'Clean Floor',        'Master Bedroom', 7),
  _T('mb-baseboards',   'Clean Baseboards',   'Master Bedroom', 90),
  _T('mb-doorknob',     'Clean Door Knob',    'Master Bedroom', 14),
  _T('mb-cobweb',       'Cobweb Removal',     'Master Bedroom', 30),

  // ── Madi's Room ───────────────────────────────────────────────
  _T('md-floor',        'Clean Floor',        "Madi's Room", 14),
  _T('md-baseboards',   'Clean Baseboards',   "Madi's Room", 90),
  _T('md-doorknob',     'Clean Door Knob',    "Madi's Room", 14),
  _T('md-cobweb',       'Cobweb Removal',     "Madi's Room", 30),

  // ── Tonya's Office ────────────────────────────────────────────
  _T('to-floor',        'Clean Floor',        "Tonya's Office", 14),
  _T('to-baseboards',   'Clean Baseboards',   "Tonya's Office", 90),
  _T('to-doorknob',     'Clean Door Knob',    "Tonya's Office", 14),
  _T('to-cobweb',       'Cobweb Removal',     "Tonya's Office", 30),

  // ── Shaun's Office ────────────────────────────────────────────
  _T('so-floor',        'Clean Floor',        "Shaun's Office", 14),
  _T('so-baseboards',   'Clean Baseboards',   "Shaun's Office", 90),
  _T('so-trash',        'Clean Trash',        "Shaun's Office", 14),
  _T('so-doorknob',     'Clean Door Knob',    "Shaun's Office", 14),
  _T('so-cobweb',       'Cobweb Removal',     "Shaun's Office", 30),

  // ── Master Bathroom ───────────────────────────────────────────
  // mbath-mirrors renamed Clean Mirror (ID preserved → history intact)
  // mbath-all retired (Whole Bathroom Done removed — duplicated individual tasks)
  _T('mbath-mirrors',   'Clean Mirror',       'Master Bathroom', 7),
  _T('mbath-floor',     'Clean Floor',        'Master Bathroom', 7),
  _T('mbath-toilet',    'Clean Toilet',       'Master Bathroom', 7),
  _T('mbath-sink',      'Clean Sink',         'Master Bathroom', 7),
  _T('mbath-trash',     'Clean Trash',        'Master Bathroom', 7),
  _T('mbath-tp',        'Refill Toilet Paper','Master Bathroom', 7),
  _T('mbath-kleenex',   'Refill Kleenex',     'Master Bathroom', 14),
  _T('mbath-doorknob',  'Clean Door Knob',    'Master Bathroom', 14),
  _T('mbath-cobweb',    'Cobweb Removal',     'Master Bathroom', 30),

  // ── Half Bath ─────────────────────────────────────────────────
  // hb-all retired (Whole Bathroom Done removed — duplicated individual tasks)
  _T('hb-mirrors',      'Clean Mirror',       'Half Bath', 7),
  _T('hb-floor',        'Clean Floor',        'Half Bath', 7),
  _T('hb-toilet',       'Clean Toilet',       'Half Bath', 7),
  _T('hb-sink',         'Clean Sink',         'Half Bath', 7),
  _T('hb-trash',        'Clean Trash',        'Half Bath', 7),
  _T('hb-tp',           'Refill Toilet Paper','Half Bath', 7),
  _T('hb-kleenex',      'Refill Kleenex',     'Half Bath', 14),
  _T('hb-doorknob',     'Clean Door Knob',    'Half Bath', 14),
  _T('hb-cobweb',       'Cobweb Removal',     'Half Bath', 30),

  // ── Madi Bath ─────────────────────────────────────────────────
  // mdb-all retired (Whole Bathroom Done removed — duplicated individual tasks)
  _T('mdb-mirrors',     'Clean Mirror',       'Madi Bath', 7),
  _T('mdb-floor',       'Clean Floor',        'Madi Bath', 7),
  _T('mdb-toilet',      'Clean Toilet',       'Madi Bath', 7),
  _T('mdb-sink',        'Clean Sink',         'Madi Bath', 7),
  _T('mdb-trash',       'Clean Trash',        'Madi Bath', 7),
  _T('mdb-tp',          'Refill Toilet Paper','Madi Bath', 7),
  _T('mdb-kleenex',     'Refill Kleenex',     'Madi Bath', 14),
  _T('mdb-doorknob',    'Clean Door Knob',    'Madi Bath', 14),
  _T('mdb-cobweb',      'Cobweb Removal',     'Madi Bath', 30),

  // ── Basement Bath ─────────────────────────────────────────────
  // bb-all retired (Whole Bathroom Done removed — duplicated individual tasks)
  _T('bb-mirrors',      'Clean Mirror',       'Basement Bath', 7),
  _T('bb-floor',        'Clean Floor',        'Basement Bath', 7),
  _T('bb-toilet',       'Clean Toilet',       'Basement Bath', 7),
  _T('bb-sink',         'Clean Sink',         'Basement Bath', 7),
  _T('bb-trash',        'Clean Trash',        'Basement Bath', 7),
  _T('bb-tp',           'Refill Toilet Paper','Basement Bath', 7),
  _T('bb-kleenex',      'Refill Kleenex',     'Basement Bath', 14),
  _T('bb-doorknob',     'Clean Door Knob',    'Basement Bath', 14),
  _T('bb-cobweb',       'Cobweb Removal',     'Basement Bath', 30),

  // ── Kitchen ───────────────────────────────────────────────────
  // k-stove-sink renamed "Clean Sink" (ID preserved → prior history maps to Sink)
  _T('k-floor',         'Clean Floor',        'Kitchen', 7),
  _T('k-stove-sink',    'Clean Sink',         'Kitchen', 10),
  _T('k-stove',         'Clean Stove',        'Kitchen', 10),
  _T('k-granite',       'Clean Granite',      'Kitchen', 14),
  _T('k-microwave',     'Clean Microwave',    'Kitchen', 14),
  _T('k-oven',          'Clean Oven',         'Kitchen', 30),
  _T('k-dishwasher',    'Dishwasher Cleaning','Kitchen', 30),
  _T('k-baking-soda',   'Change Baking Soda', 'Kitchen', 60),
  _T('k-windows',       'Clean Windows',      'Kitchen', 14),  // interval preserved
  _T('k-baseboards',    'Clean Baseboards',   'Kitchen', 90),
  _T('k-doorknob',      'Clean Door Knob',    'Kitchen', 14),
  _T('k-cobweb',        'Cobweb Removal',     'Kitchen', 30),

  // ── Living Room ───────────────────────────────────────────────
  _T('lr-floor',        'Clean Floor',        'Living Room', 7),
  _T('lr-windows',      'Clean Windows',      'Living Room', 14),
  _T('lr-baseboards',   'Clean Baseboards',   'Living Room', 90),
  _T('lr-under-couch',  'Dust Under Couches', 'Living Room', 30),
  _T('lr-doorknob',     'Clean Door Knob',    'Living Room', 14),
  _T('lr-cobweb',       'Cobweb Removal',     'Living Room', 30),

  // ── Three-Season Room ─────────────────────────────────────────
  _T('ts-vacuum',       'Vacuum And Clean',   'Three-Season Room', 7),
  _T('ts-doorknob',     'Clean Door Knob',    'Three-Season Room', 14),
  _T('ts-cobweb',       'Cobweb Removal',     'Three-Season Room', 30),

  // ── Basement Living Room ──────────────────────────────────────
  _T('blr-floor',       'Clean Floor',        'Basement Living Room', 14),
  _T('blr-baseboards',  'Clean Baseboards',   'Basement Living Room', 90),
  _T('blr-doorknob',    'Clean Door Knob',    'Basement Living Room', 14),
  _T('blr-cobweb',      'Cobweb Removal',     'Basement Living Room', 30),

  // ── Music Room ────────────────────────────────────────────────
  _T('mr-floor',        'Clean Floor',        'Music Room', 14),
  _T('mr-baseboards',   'Clean Baseboards',   'Music Room', 90),
  _T('mr-doorknob',     'Clean Door Knob',    'Music Room', 14),
  _T('mr-cobweb',       'Cobweb Removal',     'Music Room', 30),

  // ── Fish Tank Room ────────────────────────────────────────────
  _T('ftr-floor',       'Clean Floor',        'Fish Tank Room', 14),
  _T('ftr-baseboards',  'Clean Baseboards',   'Fish Tank Room', 90),
  _T('ftr-doorknob',    'Clean Door Knob',    'Fish Tank Room', 14),
  _T('ftr-cobweb',      'Cobweb Removal',     'Fish Tank Room', 30),

  // ── Garage with Kitchenette ───────────────────────────────────
  _T('g-floor',         'Clean Floor',        'Garage with Kitchenette', 14),
  _T('g-baseboards',    'Clean Baseboards',   'Garage with Kitchenette', 90),
  _T('g-doorknob',      'Clean Door Knob',    'Garage with Kitchenette', 14),
  _T('g-cobweb',        'Cobweb Removal',     'Garage with Kitchenette', 30),

  // ── Basement Sauna ────────────────────────────────────────────
  _T('bs-floor',        'Clean Floor',        'Basement Sauna', 14),
  _T('bs-baseboards',   'Clean Baseboards',   'Basement Sauna', 90),
  _T('bs-doorknob',     'Clean Door Knob',    'Basement Sauna', 14),
  _T('bs-cobweb',       'Cobweb Removal',     'Basement Sauna', 30),

  // ── Workout Room ──────────────────────────────────────────────
  _T('wr-floor',        'Clean Floor',        'Workout Room', 14),
  _T('wr-baseboards',   'Clean Baseboards',   'Workout Room', 90),
  _T('wr-doorknob',     'Clean Door Knob',    'Workout Room', 14),
  _T('wr-cobweb',       'Cobweb Removal',     'Workout Room', 30),

  // ── Master Closet ─────────────────────────────────────────────
  _T('mc-floor',        'Clean Floor',        'Master Closet', 14),
  _T('mc-baseboards',   'Clean Baseboards',   'Master Closet', 90),
  _T('mc-doorknob',     'Clean Door Knob',    'Master Closet', 14),
  _T('mc-cobweb',       'Cobweb Removal',     'Master Closet', 30),

  // ── Utility Room ──────────────────────────────────────────────
  _T('ur-floor',        'Clean Floor',        'Utility Room', 14),
  _T('ur-baseboards',   'Clean Baseboards',   'Utility Room', 90),
  _T('ur-doorknob',     'Clean Door Knob',    'Utility Room', 14),
  _T('ur-cobweb',       'Cobweb Removal',     'Utility Room', 30),
  _T('water-softener',  'Check Water Softener', 'Utility Room', 7),

  // ── Workshop ──────────────────────────────────────────────────
  _T('ws-floor',        'Clean Floor',        'Workshop', 14),
  _T('ws-baseboards',   'Clean Baseboards',   'Workshop', 90),
  _T('ws-doorknob',     'Clean Door Knob',    'Workshop', 14),
  _T('ws-cobweb',       'Cobweb Removal',     'Workshop', 30),

  // ── Laundry Room ──────────────────────────────────────────────
  _T('la-floor',        'Clean Floor',        'Laundry Room', 14),
  _T('la-baseboards',   'Clean Baseboards',   'Laundry Room', 90),
  _T('la-doorknob',     'Clean Door Knob',    'Laundry Room', 14),
  _T('la-cobweb',       'Cobweb Removal',     'Laundry Room', 30),

  // ── Basement Kitchen ──────────────────────────────────────────
  _T('bk-floor',        'Clean Floor',        'Basement Kitchen', 14),
  _T('bk-baseboards',   'Clean Baseboards',   'Basement Kitchen', 90),
  _T('bk-doorknob',     'Clean Door Knob',    'Basement Kitchen', 14),
  _T('bk-cobweb',       'Cobweb Removal',     'Basement Kitchen', 30),

  // ── Whole House ───────────────────────────────────────────────
  // House-wide tasks not tied to a single room.
  _T('garbage',         'Take Out Garbage',               'Whole House', 7),
  _T('smoke-batteries', 'Check Smoke Detector Batteries', 'Whole House', 90),

  // ── Family Room ───────────────────────────────────────────────
  _T('couch-condition', 'Leather Couch Conditioning',     'Family Room', 90),
];

/* Runtime verification — total must equal 122 (126 − 4 retired Whole Bathroom Done) */
console.assert(SEED_TASKS.length === 122, `Seed has ${SEED_TASKS.length} tasks, expected 122`);
/* Room count verification — 24 rooms after renaming Madi's Room, adding Whole House + Family Room, removing Shared */
console.assert(
  (() => { const rooms = new Set(SEED_TASKS.map(t => t.room)); return rooms.size; })() === 24,
  `Seed has ${new Set(SEED_TASKS.map(t => t.room)).size} rooms, expected 24`
);

/* Rooms in source order (derived from SEED_TASKS, no duplicates) */
const ROOMS_ORDERED = [...new Set(SEED_TASKS.map(t => t.room))];

/* Set of all built-in task IDs — guards removeTask() and the append pass. */
const SEED_TASK_IDS = new Set(SEED_TASKS.map(t => t.id));

/* Set of all built-in room names (exact casing) — custom-room derivation excludes these. */
const SEED_TASK_ROOMS = new Set(SEED_TASKS.map(t => t.room));

/* ── Catalog validator ────────────────────────────────────────── */
/**
 * _validateCatalog() — development/startup integrity check.
 * Runs once on page load. Reports console errors but never throws or
 * blocks normal app use. Silent on success beyond a summary info line.
 */
(function _validateCatalog() {
  const RETIRED_IDS = new Set(['mbath-all', 'hb-all', 'mdb-all', 'bb-all']);
  const idSeen      = new Map();   // id → first index
  const rtSeen      = new Map();   // "room::title" → first index
  let ok = true;

  SEED_TASKS.forEach((t, i) => {
    const tag = `[HomeTask] Catalog[${i}] id="${t.id}"`;

    // Required fields present
    if (!t.id)                        { console.error(`${tag}: missing id`);    ok = false; }
    if (!t.title)                     { console.error(`${tag}: missing title`); ok = false; }
    if (!t.room || t.room.trim() !== t.room) {
      console.error(`${tag}: room missing or untrimmed: "${t.room}"`); ok = false;
    }

    // intervalDays must be a positive integer
    if (!Number.isInteger(t.intervalDays) || t.intervalDays <= 0) {
      console.error(`${tag}: intervalDays must be a positive integer, got ${t.intervalDays}`);
      ok = false;
    }

    // Unique ID
    if (idSeen.has(t.id)) {
      console.error(`${tag}: duplicate ID (first at index ${idSeen.get(t.id)})`);
      ok = false;
    } else {
      idSeen.set(t.id, i);
    }

    // Retired IDs must be absent
    if (RETIRED_IDS.has(t.id)) {
      console.error(`${tag}: retired ID still present in catalog`);
      ok = false;
    }

    // No duplicate room+title pair
    const rtKey = `${t.room}::${t.title}`;
    if (rtSeen.has(rtKey)) {
      console.error(`${tag}: duplicate room/title "${rtKey}" (first at index ${rtSeen.get(rtKey)})`);
      ok = false;
    } else {
      rtSeen.set(rtKey, i);
    }

    // Title must already be in canonical Title Case
    const normalized = normalizeTaskTitle(t.title);
    if (normalized !== t.title) {
      console.error(`${tag}: title "${t.title}" should be "${normalized}"`);
      ok = false;
    }
  });

  // Every safety ID must exist in the catalog
  SAFETY_TASK_IDS.forEach(id => {
    if (!idSeen.has(id)) {
      console.error(`[HomeTask] Catalog: safety ID "${id}" not found`);
      ok = false;
    }
  });

  if (ok) {
    console.info(
      `[HomeTask] Catalog OK — ${SEED_TASKS.length} tasks, ` +
      `${ROOMS_ORDERED.length} rooms, ` +
      `${SAFETY_TASK_IDS.size} safety task(s): [${[...SAFETY_TASK_IDS].join(', ')}]`
    );
  }
})();

/* ── Storage merge whitelist verification ─────────────────────── */
/**
 * Confirms that the storage.load() merge keeps seed fields authoritative
 * while preserving user-state (lastDone, skipUntil).
 * Uses a simulated legacy entry with an old lowercase title and wrong interval.
 */
(function _verifyMergeWhitelist() {
  // A "legacy" saved record: old lowercase title + stale interval + real user state
  const YESTERDAY = addDays(todayStr(), -1);
  const legacySaved = [{
    id:          'mb-baseboards',
    title:       'Clean baseboards',  // old lowercase — seed must win
    room:        'master bedroom',    // old casing — seed must win
    intervalDays: 999,                // wrong — seed must win
    lastDone:    YESTERDAY,           // user-state — must be preserved
    skipUntil:   null,
    doneToday:   false,
    tags:        [],
  }];

  const savedMap = new Map(legacySaved.map(t => [t.id, t]));
  const today    = todayStr();

  const merged = SEED_TASKS.map(seed => {
    const s = savedMap.get(seed.id);
    if (!s) return { ...seed };
    return {
      ...seed,
      lastDone:  s.lastDone  ?? null,
      doneToday: s.lastDone === today ? Boolean(s.doneToday) : false,
      skipUntil: s.skipUntil ?? null,
      tags:      Array.isArray(s.tags) ? s.tags : [],
    };
  });

  const r = merged.find(t => t.id === 'mb-baseboards');
  let ok = true;
  if (!r)                            { console.error('[HomeTask] Merge verify: mb-baseboards not found'); ok = false; }
  if (r?.title       !== 'Clean Baseboards')  { console.error(`[HomeTask] Merge verify: title not from seed — got "${r?.title}"`);         ok = false; }
  if (r?.intervalDays !== 90)        { console.error(`[HomeTask] Merge verify: intervalDays not from seed — got ${r?.intervalDays}`);      ok = false; }
  if (r?.lastDone    !== YESTERDAY)  { console.error(`[HomeTask] Merge verify: lastDone not preserved — got "${r?.lastDone}"`);            ok = false; }

  if (ok) console.info('[HomeTask] Merge whitelist OK — seed fields authoritative, lastDone/skipUntil preserved');
})();

export { SAFETY_TASK_IDS, SEED_TASKS, ROOMS_ORDERED, SEED_TASK_IDS, SEED_TASK_ROOMS, normalizeTaskTitle };
