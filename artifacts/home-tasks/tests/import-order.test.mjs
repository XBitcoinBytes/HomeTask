/* ================================================================
   import-order.test.mjs — structural regression guard for the CP2
   module split of src/script.js.

   Startup safety depends on module EVALUATION order: the interrupted-
   import staging recovery (src/app/startup.js) must execute before any
   module can read or write HomeTask localStorage. This suite proves
   the property statically — it parses the real import graph, computes
   the ES-module evaluation order, and fails on any regression.

   Pure static analysis: no browser, no DOM, no localStorage — the app
   modules are never executed here.
   ================================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = join(HERE, '..', 'src');
const ENTRY = join(SRC, 'script.js');

/* ── Tiny static-import parser + ESM evaluation-order resolver ── */

/** Extract static import specifiers (in statement order) from source.
 *  Dynamic imports — import('./foo.js') — are excluded via a negative
 *  lookahead for '(' so they never appear in the evaluated dependency graph.
 */
export function parseImports(source) {
  // Strip block and line comments so commented-out imports are ignored.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const specs = [];
  // Negative lookahead (?!\s*\() excludes dynamic import() expressions.
  const re = /^[ \t]*import\b(?!\s*\()[^'"]*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(code)) !== null) specs.push(m[1]);
  return specs;
}

/**
 * Compute ES-module evaluation order for a graph.
 * graph: Map<absPath, string[] of absPath deps in import-statement order>.
 * ESM semantics: dependencies evaluate before their importer, in import
 * order, each module exactly once. Throws on a static cycle involving
 * top-level evaluation (good enough as a cycle detector here).
 */
export function evaluationOrder(graph, entry) {
  const order = [];
  const state = new Map(); // path -> 'visiting' | 'done'
  (function visit(path, chain) {
    if (state.get(path) === 'done') return;
    if (state.get(path) === 'visiting') {
      throw new Error('import cycle: ' + [...chain, path].join(' -> '));
    }
    state.set(path, 'visiting');
    for (const dep of graph.get(path) ?? []) visit(dep, [...chain, path]);
    state.set(path, 'done');
    order.push(path);
  })(entry, []);
  return order;
}

/** Build the real import graph from disk, starting at an entry file. */
function buildGraph(entry) {
  const graph = new Map();
  (function load(path) {
    if (graph.has(path)) return;
    let deps = [];
    if (path.endsWith('.js') || path.endsWith('.mjs')) {
      let src;
      try { src = readFileSync(path, 'utf8'); }
      catch { graph.set(path, []); return; }   // non-JS or missing: leaf
      deps = parseImports(src)
        .filter(s => s.startsWith('./') || s.startsWith('../'))
        .map(s => resolve(dirname(path), s))
        .filter(p => p.endsWith('.js') || p.endsWith('.mjs'));
    }
    graph.set(path, deps);
    for (const d of deps) load(d);
  })(entry);
  return graph;
}

/* ── Checkers (pure, so they can be exercised with synthetic graphs) ── */

const rel = p => p.startsWith(SRC) ? p.slice(SRC.length + 1) : p;

/**
 * Assert the startup-safety property on an evaluation order:
 * app/startup.js must evaluate before every storage consumer.
 * Returns null when safe, or an error string describing the violation.
 */
export function checkStartupOrder(orderRel) {
  const startupIdx = orderRel.indexOf('app/startup.js');
  if (startupIdx === -1) return 'app/startup.js is not in the evaluation order';
  // Modules whose import-time or first-use behavior touches HomeTask localStorage keys.
  // NOTE: app/tasks.js was an eval-time consumer prior to CP5B; it has been lazified
  // (storage.load() deferred to first call). It remains in this list because the
  // import order is unchanged and the guard is still valid / harmless.
  const consumers = ['app/recovery.js', 'app/storage.js', 'app/meta.js',
                     'app/tasks.js', 'app/recents.js',
                     'app/backup-store.js', 'app/staging-store.js',
                     'app/backup.js', 'app/backup-ui.js', 'app/app.js'];
  for (const c of consumers) {
    const idx = orderRel.indexOf(c);
    if (idx !== -1 && idx < startupIdx) {
      return `${c} evaluates before app/startup.js (interrupted-import recovery would run too late)`;
    }
  }
  return null;
}

/* ── Test harness ─────────────────────────────────────────────── */

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' — ' + e.message); }
}

console.log('HomeTask import-order structural guard');

const graph = buildGraph(ENTRY);
const order = evaluationOrder(graph, ENTRY).map(rel);

check('import graph is acyclic (evaluationOrder does not throw)', () => {
  assert.ok(order.length > 0);
});

check('startup recovery evaluates before every storage consumer', () => {
  const err = checkStartupOrder(order);
  assert.equal(err, null, err ?? '');
});

check('entry imports the 21 app modules in the canonical CP2+F1 order', () => {
  const canonical = [
    'app/util.js', 'app/catalog.js', 'app/due.js', 'app/startup.js',
    'app/recovery.js', 'app/storage.js', 'app/meta.js', 'app/tasks.js',
    'app/status.js', 'app/search.js', 'app/recents.js', 'app/scroll-lock.js',
    'app/custom-tasks-config.js',   // F1: evaluated between scroll-lock and ui
    'app/ui.js', 'app/onboarding.js', 'app/backup-store.js',
    'app/staging-store.js', 'app/backup.js', 'app/backup-ui.js',
    'app/deferred-delete.js', 'app/app.js',
  ];
  const appOnly = order.filter(p => p.startsWith('app/'));
  assert.deepEqual(appOnly, canonical,
    'module evaluation order diverged from the canonical order');
});

check('script.js is the last module to evaluate (entry semantics)', () => {
  assert.equal(order[order.length - 1], 'script.js');
});

check('workload.js evaluates before all app modules (original line-8 import)', () => {
  const wl = order.indexOf('workload.js');
  const firstApp = order.findIndex(p => p.startsWith('app/'));
  assert.ok(wl !== -1 && wl < firstApp, 'workload.js must evaluate first as in v1');
});

/* Negative self-test: a deliberately invalid order must FAIL the checker. */
check('checker rejects a deliberately invalid order (self-test)', () => {
  const bad = ['app/util.js', 'app/storage.js', 'app/tasks.js',
               'app/startup.js', 'script.js'];
  const err = checkStartupOrder(bad);
  assert.ok(err !== null, 'checker accepted storage-before-startup order');
});

check('cycle detector rejects a deliberately cyclic graph (self-test)', () => {
  const g = new Map([['a', ['b']], ['b', ['a']]]);
  assert.throws(() => evaluationOrder(g, 'a'), /cycle/);
});

/* CP5B adds: activation-bridge, activation-boot, activation-config, and
   shadow-fingerprint (imported by activation-bridge for webCryptoDigest).
   activation-tx remains only reachable via activation-bridge's dynamic import. */
check('only activation infrastructure is statically reachable from entry', () => {
  const v2 = [...graph.keys()].map(rel).filter(p => p.startsWith('v2/'));
  const AUTHORIZED = new Set([
    'v2/activation-bridge.js',
    'v2/activation-boot.js',
    'v2/activation-config.js',
    'v2/shadow-fingerprint.js',
  ]);
  const unauthorized = v2.filter(p => !AUTHORIZED.has(p));
  assert.deepEqual(unauthorized, [],
    'unauthorized v2 modules statically reachable from entry: ' + unauthorized.join(', '));
  // All authorized modules must actually be present.
  for (const mod of AUTHORIZED) {
    assert.ok(v2.includes(mod), `${mod} must be in the static graph`);
  }

  // CP5C-A2.1/A2.2b: authorized data/ paths statically reachable from entry.
  const data = [...graph.keys()].map(rel).filter(p => p.startsWith('data/'));
  const DATA_AUTHORIZED = new Set([
    // A2.1 — repository layer
    'data/repository/v1-repository.js',
    'data/repository/v1-adapter.js',
    'data/repository/i-repository.js',
    'data/repository/browser-storage-backing.js',
    // Shared pure v1 custom-record validation/copy boundary.
    'data/custom-record.js',
    // Dedicated v1 explicit-room validation boundary; task arrays stay task-only.
    'data/custom-room-record.js',
    // A2.2b — V1BackupService and its browser adapters (composed in script.js)
    'data/backup/v1-backup-service.js',
    'data/backup/browser-file-reader.js',
    'data/backup/browser-delivery.js',
    // B1 — v2 mutation writer and repository (disconnected; must NOT be in the
    //        production static graph — guarded by v2-mutation-writer.test.mjs section E)
    // NOTE: if these paths ever appear here, that is a disconnection violation.
  ]);
  const unauthorizedData = data.filter(p => !DATA_AUTHORIZED.has(p));
  assert.deepEqual(unauthorizedData, [],
    'unauthorized data/ modules statically reachable from entry: ' + unauthorizedData.join(', '));
});

check('no shadow diagnostic module is statically reachable from entry', () => {
  const shadowMods = [...graph.keys()].map(rel).filter(p =>
    p.startsWith('v2/shadow-') && p !== 'v2/shadow-fingerprint.js');
  assert.deepEqual(shadowMods, [],
    'shadow diagnostic modules statically reachable from entry: ' + shadowMods.join(', '));
});

check('no src/app module imports a shadow diagnostic module', () => {
  const srcDir = join(SRC, 'app');
  let entries;
  try { entries = readdirSync(srcDir).filter(f => f.endsWith('.js')); }
  catch { entries = []; }
  for (const f of entries) {
    if (f === 'shadow-status.js') continue; // orphaned diagnostic state is not in the production graph
    const content = readFileSync(join(srcDir, f), 'utf8');
    assert.ok(!content.includes('shadow-'),
      `app/${f} must not import a shadow diagnostic module`);
  }
});

check('no src/app module references hometask-v2-shadow key', () => {
  // app/*.js must never reference the shadow key.
  // shadow-bridge.js is authorized but uses SHADOW_KEY from dynamic import,
  // not the hardcoded string — so this check covers all files in the graph.
  const srcDir = join(SRC, 'app');
  let entries;
  try { entries = readdirSync(srcDir).filter(f => f.endsWith('.js')); }
  catch { entries = []; }
  for (const f of entries) {
    let content;
    try { content = readFileSync(join(srcDir, f), 'utf8'); } catch { continue; }
    assert.ok(!content.includes('hometask-v2-shadow'),
      `app/${f} must not reference the shadow key "hometask-v2-shadow"`);
  }
});

check('script.js does not hardcode hometask-v2-shadow key', () => {
  const content = readFileSync(ENTRY, 'utf8');
  assert.ok(!content.includes('hometask-v2-shadow'),
    'script.js must not reference the shadow key (bridge uses SHADOW_KEY constant)');
});

/* ── B2 disconnection guards ──────────────────────────────────────────
   All three B2 modules must remain absent from the production static
   import graph until Batch C wires them to the production startup path.
   The DATA_AUTHORIZED set above already rejects them as "unauthorized"
   if they appear; these explicit presence-negation checks surface the
   violation with a clear per-module message rather than a combined list.

   v2-mutation-writer.js is also guarded in section E of
   v2-mutation-writer.test.mjs — the duplication is intentional:
   import-order.test.mjs is the canonical static-graph authority.          */

check('data/backup/v2-backup-service.js is NOT statically reachable from entry (B2 disconnected until C)', () => {
  const reachable = [...graph.keys()].map(rel);
  assert.ok(
    !reachable.includes('data/backup/v2-backup-service.js'),
    'data/backup/v2-backup-service.js must not be in the production static graph ' +
    'until Batch C wires V2BackupService into script.js',
  );
});

check('data/backup/v2-locked-import.js is NOT statically reachable from entry (B2 disconnected until C)', () => {
  const reachable = [...graph.keys()].map(rel);
  assert.ok(
    !reachable.includes('data/backup/v2-locked-import.js'),
    'data/backup/v2-locked-import.js must not be in the production static graph ' +
    'until Batch C wires the locked-import engine into script.js',
  );
});

check('data/v2/v2-mutation-writer.js is NOT statically reachable from entry (B2 disconnected until C; also guarded in v2-mutation-writer.test.mjs §E)', () => {
  const reachable = [...graph.keys()].map(rel);
  assert.ok(
    !reachable.includes('data/v2/v2-mutation-writer.js'),
    'data/v2/v2-mutation-writer.js must not be in the production static graph ' +
    'until Batch C wires V2Repository into script.js',
  );
});

check('SHADOW_MIGRATION_ENABLED flag is false in source', () => {
  const configPath = join(SRC, 'v2', 'shadow-config.js');
  const content = readFileSync(configPath, 'utf8');
  assert.ok(content.includes('SHADOW_MIGRATION_ENABLED = false'),
    'shadow-config.js must export SHADOW_MIGRATION_ENABLED = false');
  // Must not make runtime calls to localStorage or URL APIs (checking for API calls, not comment mentions).
  assert.ok(!content.includes('localStorage.') && !content.includes('localStorage['),
    'flag must not call localStorage API');
  assert.ok(!content.includes('URLSearchParams') && !content.includes('location.search'),
    'flag must not be read from URL parameters');
});

check('boot code imports no shadow diagnostic bridge or presenter', () => {
  const content = readFileSync(ENTRY, 'utf8');
  assert.ok(!content.includes('shadow-bridge'),
    'script.js must not import the shadow bridge');
  assert.ok(!content.includes('shadow-presenter'),
    'script.js must not import the shadow presenter');
  assert.ok(!content.includes('startShadowDiagnostic'),
    'script.js must not invoke a shadow diagnostic');
});

check('boot code: CP5B _boot() function wires activation before app.init (CP5B)', () => {
  const content = readFileSync(ENTRY, 'utf8');
  // Must define _boot as a named function.
  assert.ok(content.includes('function _boot()'),
    'script.js must define _boot() helper for CP5B activation recovery wiring');
  // CP5C-A2.1: init accepts the injected v1 repository exactly once.
  const callCount = [...content.matchAll(/^\s+app\.init\(repo\);/gm)].length;
  assert.equal(callCount, 1,
    'app.init(repo) must appear exactly once (inside _boot)');
  // Both DOMContentLoaded and the else branch must call _boot().
  const bootCount = [...content.matchAll(/_boot\(\)/g)].length;
  assert.ok(bootCount >= 2, '_boot() must be called in both boot branches (DOMContentLoaded + else)');
  // maybeRecoverActivation must be called inside _boot.
  assert.ok(content.includes('maybeRecoverActivation'),
    '_boot must call maybeRecoverActivation');
  // bootDecision must be called on the result.
  assert.ok(content.includes('bootDecision'),
    '_boot must call bootDecision');
  // activation-tx must not be directly imported (only via bridge's dynamic import).
  assert.ok(!content.includes('activation-tx'),
    'script.js must not directly import activation-tx');
});

check('shadow status is absent from the production static graph', () => {
  assert.ok(!order.includes('app/shadow-status.js'),
    'app/shadow-status.js must not evaluate during disabled startup');
});

/* ─── CP5C-C: v2-backup-wiring.js must not appear in production graph ─── */
check('v2-backup-wiring.js is absent from the script.js static import graph (CP5C-C)', () => {
  // The factory module is non-shipping: no production file may import it
  // while V2_ACTIVATION_ENABLED=false.  This check proves the property
  // by tracing the static graph from ENTRY = script.js.
  const inGraph = order.some(p => p.includes('v2-backup-wiring'));
  assert.ok(!inGraph,
    'v2-backup-wiring.js must not appear in the script.js static import graph — it is non-shipping');
});

check('script.js contains no textual reference to v2-backup-wiring (CP5C-C)', () => {
  // Belt-and-suspenders: confirm no static import, dynamic import(), or
  // comment reference to the factory module appears in the entry file.
  const content = readFileSync(ENTRY, 'utf8');
  assert.ok(!content.includes('v2-backup-wiring'),
    'script.js must not reference v2-backup-wiring in any form');
});

/* ─── CP5C-D: v2-backup-service-adapter.js must not appear in production graph ─── */
check('v2-backup-service-adapter.js is absent from the script.js static import graph (CP5C-D)', () => {
  // The facade-arity adapter is non-shipping: zero static imports, not reachable
  // from the production entry while V2_ACTIVATION_ENABLED=false.
  // This check proves the property by tracing the static graph from ENTRY.
  const inGraph = order.some(p => p.includes('v2-backup-service-adapter'));
  assert.ok(!inGraph,
    'v2-backup-service-adapter.js must not appear in the script.js static import graph — it is non-shipping');
});

check('script.js contains no textual reference to v2-backup-service-adapter (CP5C-D)', () => {
  // Belt-and-suspenders: confirm no static import, dynamic import(), or
  // comment reference to the adapter appears in the entry file.
  const content = readFileSync(ENTRY, 'utf8');
  assert.ok(!content.includes('v2-backup-service-adapter'),
    'script.js must not reference v2-backup-service-adapter in any form');
});

/* ─── E1: v2-repository.js must not appear in production graph ─── */
check('v2-repository.js is absent from the script.js static import graph (E1)', () => {
  // V2Repository is the disconnected read/write repository for v2 data.
  // While V2_ACTIVATION_ENABLED=false it must not be reachable from the
  // production entry.  This check proves the property by tracing the static
  // graph from ENTRY = script.js.
  const inGraph = order.some(p => p.includes('v2-repository'));
  assert.ok(!inGraph,
    'v2-repository.js must not appear in the script.js static import graph — it is disconnected');
});

check('script.js contains no textual reference to v2-repository (E1)', () => {
  // Belt-and-suspenders: confirm no static import, dynamic import(), or
  // comment reference to the repository module appears in the entry file.
  const content = readFileSync(ENTRY, 'utf8');
  assert.ok(!content.includes('v2-repository'),
    'script.js must not reference v2-repository in any form');
});

/* ── F1 guard checks ──────────────────────────────────────────── */

check('SEED_TASK_IDS is exported from catalog.js (F1 guard)', () => {
  const content = readFileSync(join(SRC, 'app', 'catalog.js'), 'utf8');
  assert.ok(content.includes('SEED_TASK_IDS'),
    'catalog.js must define SEED_TASK_IDS');
  assert.ok(/export[^;]*SEED_TASK_IDS/.test(content),
    'SEED_TASK_IDS must appear in an export statement in catalog.js');
});

check('SEED_TASK_ROOMS is exported from catalog.js (F1 guard)', () => {
  const content = readFileSync(join(SRC, 'app', 'catalog.js'), 'utf8');
  assert.ok(content.includes('SEED_TASK_ROOMS'),
    'catalog.js must define SEED_TASK_ROOMS');
  assert.ok(/export[^;]*SEED_TASK_ROOMS/.test(content),
    'SEED_TASK_ROOMS must appear in an export statement in catalog.js');
});

check('CUSTOM_TASKS_UI_ENABLED is true in custom-tasks-config.js (accepted build)', () => {
  const configPath = join(SRC, 'app', 'custom-tasks-config.js');
  const content = readFileSync(configPath, 'utf8');
  assert.ok(content.includes('CUSTOM_TASKS_UI_ENABLED = true'),
    'custom-tasks-config.js must commit CUSTOM_TASKS_UI_ENABLED = true in the accepted build');
  assert.ok(!content.includes('localStorage.getItem') && !content.includes('localStorage.setItem'),
    'flag must not call localStorage API methods');
});

check('custom-tasks-config.js is statically reachable from script.js entry (F1)', () => {
  const reachable = [...graph.keys()].map(rel);
  assert.ok(
    reachable.includes('app/custom-tasks-config.js'),
    'app/custom-tasks-config.js must be in the static import graph rooted at script.js'
  );
});

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
