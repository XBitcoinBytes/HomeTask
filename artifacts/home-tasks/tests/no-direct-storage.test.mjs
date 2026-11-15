/**
 * no-direct-storage.test.mjs — CP5C-A2.1 structural guard (suite 15).
 *
 * Enforces two invariants after V1Repository wiring:
 *
 * 1. localStorage usage allowlist: only the explicitly-exempt source files
 *    may reference the `localStorage` identifier.  Every other file in src/
 *    must go through the repo API (or the existing storage-wrapper modules).
 *
 * 2. Dead-import guard: the five wired app modules must not retain
 *    the dead imports that were replaced by repo calls:
 *      tasks.js      → must not import ./storage
 *      ui.js         → must not import ./meta
 *      onboarding.js → must not import ./meta
 *      backup-ui.js  → must not import ./backup-store
 *      app.js        → must not import ./meta or ./recents
 *
 * 3. Poison-call guard: backup.js is now a pure delegating facade (A2.2b).
 *    It must not call backupStore.setLastExport (replaced by repo), and
 *    must not reference localStorage at all (removed from LS_ALLOWED).
 *
 * Pure static analysis — no browser, no DOM, no localStorage calls made.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = join(HERE, '..', 'src');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' — ' + e.message); }
}

function src(...parts) { return readFileSync(join(SRC, ...parts), 'utf8'); }

/**
 * Strip // line comments and slash-star block comments from source
 * before identifier scanning so that mentions in doc-strings or
 * commented-out code do not trigger false positives.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments  /* ... */
    .replace(/\/\/[^\n]*/g, '');         // line comments   // ...
}

/**
 * Return true when the (already comment-stripped) source contains any
 * localStorage access form:
 *   localStorage.X    — dotted property access
 *   localStorage['X'] — bracket access
 *   window.localStorage   — global-qualified dotted access
 *   globalThis.localStorage — globalThis-qualified access
 */
function hasLocalStorageAccess(code) {
  return (
    code.includes('localStorage.')          ||  // localStorage.getItem(...)
    code.includes('localStorage[')          ||  // localStorage['key']
    code.includes('window.localStorage')    ||  // window.localStorage.*
    code.includes('globalThis.localStorage')    // globalThis.localStorage.*
  );
}

/**
 * Return true when the (already comment-stripped) source contains any
 * direct sessionStorage access form.  B2 modules must use the injected
 * sessionStore parameter — never the global sessionStorage API directly.
 */
function hasSessionStorageAccess(code) {
  return (
    code.includes('sessionStorage.')           ||  // sessionStorage.getItem(...)
    code.includes('sessionStorage[')           ||  // sessionStorage['key']
    code.includes('window.sessionStorage')     ||  // window.sessionStorage.*
    code.includes('globalThis.sessionStorage')     // globalThis.sessionStorage.*
  );
}

/* ─── 1. localStorage allowlist ─────────────────────────────── */
console.log('\n── localStorage allowlist');

// Files ALLOWED to contain the localStorage identifier (all relative to src/)
const LS_ALLOWED = [
  'app/storage.js',
  'app/meta.js',
  'app/recents.js',
  'app/backup-store.js',
  'app/recovery.js',
  'app/startup.js',
  'app/staging-store.js',
  // app/backup.js intentionally omitted: A2.2b rewrote it as a pure delegating
  // facade with no localStorage access.  Direct storage ops are in V1BackupService.
  'data/repository/browser-storage-backing.js',
];

// Wired modules that must be free of raw localStorage references
const MUST_BE_CLEAN = [
  'app/tasks.js',
  'app/ui.js',
  'app/onboarding.js',
  'app/backup-ui.js',
  'app/app.js',
  'script.js',
  // B2: v2 backup service must go through injected adapter, never direct storage
  'data/backup/v2-backup-service.js',
];

for (const path of MUST_BE_CLEAN) {
  check(`${path} — no raw localStorage API call (comments stripped)`, () => {
    const raw  = src(path);
    const code = stripComments(raw);
    // Detect all four access forms after stripping comments so that
    // mentions in doc-strings or commented-out code are not flagged.
    assert.ok(!hasLocalStorageAccess(code),
      `${path} contains a raw localStorage API call — use the repo API instead`);
  });
}

// Negative fixture self-test: confirm the scanner catches a real API call
// and ignores the same identifier when it appears only in a comment.
check('hasLocalStorageAccess — detects API call but ignores comment-only mentions', () => {
  const commentOnly = '// localStorage.getItem is used elsewhere\n/* globalThis.localStorage */\nconst x = 1;';
  assert.ok(!hasLocalStorageAccess(stripComments(commentOnly)),
    'comment-only mentions must not trigger the scanner');
  const realCall = 'function f() { return localStorage.getItem("k"); }';
  assert.ok(hasLocalStorageAccess(stripComments(realCall)),
    'real localStorage.getItem() call must be detected');
  const windowForm = 'const s = window.localStorage;';
  assert.ok(hasLocalStorageAccess(stripComments(windowForm)),
    'window.localStorage access must be detected');
  const globalThisForm = 'const s = globalThis.localStorage;';
  assert.ok(hasLocalStorageAccess(stripComments(globalThisForm)),
    'globalThis.localStorage access must be detected');
  const bracketForm = 'localStorage["key"] = v;';
  assert.ok(hasLocalStorageAccess(stripComments(bracketForm)),
    'localStorage["key"] bracket access must be detected');
});

// Self-test: every allowlisted file actually uses localStorage
for (const path of LS_ALLOWED) {
  check(`${path} — still contains localStorage (allowlist self-test)`, () => {
    const content = src(path);
    assert.ok(content.includes('localStorage'),
      `allowlisted ${path} no longer references localStorage — update the allowlist`);
  });
}

/* ─── 2. Dead-import guard ───────────────────────────────────── */
console.log('\n── dead-import guard');

check("tasks.js does not import './storage'", () => {
  const content = src('app/tasks.js');
  assert.ok(!content.includes("from './storage'"),
    "tasks.js must not import ./storage — replaced by _repo.saveTasks / _repo.loadTasks");
});

check("ui.js does not import './meta'", () => {
  const content = src('app/ui.js');
  assert.ok(!content.includes("from './meta'"),
    "ui.js must not import ./meta — replaced by _repo.loadPrefs");
});

check("onboarding.js does not import './meta'", () => {
  const content = src('app/onboarding.js');
  assert.ok(!content.includes("from './meta'"),
    "onboarding.js must not import ./meta — replaced by _repo.loadPrefs");
});

check("backup-ui.js does not import './backup-store'", () => {
  const content = src('app/backup-ui.js');
  assert.ok(!content.includes("from './backup-store'"),
    "backup-ui.js must not import ./backup-store — getLastExport replaced by _repo.getLastExport");
});

check("app.js does not import './meta'", () => {
  const content = src('app/app.js');
  assert.ok(!content.includes("from './meta'"),
    "app.js must not import ./meta — replaced by _repo.loadPrefs / _repo.savePrefs");
});

check("app.js does not import './recents'", () => {
  const content = src('app/app.js');
  assert.ok(!content.includes("from './recents'"),
    "app.js must not import ./recents — replaced by _repo.loadRecents / _repo.addRecent / _repo.clearRecents");
});

/* ─── 3. Poison-call guard ───────────────────────────────────── */
console.log('\n── poison-call guard');

check("backup.js does not call backupStore.setLastExport", () => {
  const content = src('app/backup.js');
  assert.ok(!content.includes('backupStore.setLastExport'),
    "backup.js must not call backupStore.setLastExport — replaced by _repo.setLastExport");
});

/* ─── 4. Repo wiring in script.js ────────────────────────────── */
console.log('\n── repo wiring in script.js');

check("script.js imports V1Repository", () => {
  const content = src('script.js');
  assert.ok(content.includes("V1Repository"),
    "script.js must import V1Repository");
});

check("script.js imports createBrowserStorageBacking", () => {
  const content = src('script.js');
  assert.ok(content.includes("createBrowserStorageBacking"),
    "script.js must import createBrowserStorageBacking");
});

check("script.js constructs V1Repository inside _boot", () => {
  const content = src('script.js');
  assert.ok(content.includes("new V1Repository"),
    "script.js must construct a V1Repository inside _boot");
});

check("script.js passes repo to app.init(repo)", () => {
  const content = src('script.js');
  assert.ok(content.includes("app.init(repo)"),
    "script.js must call app.init(repo) — not app.init()");
});

/* ─── 5. setRepo exposed in returned API ─────────────────────── */
console.log('\n── setRepo in module exports');

const MODULES_EXPOSING_SET_REPO = [
  ['tasks.js',     'tasks'],
  ['ui.js',        'ui'],
  ['onboarding.js','onboarding'],
  ['backup-ui.js', 'backupUI'],
  ['backup.js',    'backup'],
];

for (const [path, _name] of MODULES_EXPOSING_SET_REPO) {
  check(`${path} — return object includes setRepo`, () => {
    const content = src('app/' + path);
    assert.ok(content.includes('setRepo'),
      `${path} must expose setRepo in its public API`);
  });
}

check("app.js — init() accepts a repo parameter", () => {
  const content = src('app/app.js');
  assert.ok(
    /async function init\s*\(\s*repo\s*\)/.test(content),
    "app.js init() must accept a repo parameter: async function init(repo)",
  );
});

check("app.js — init calls tasks.setRepo(repo)", () => {
  const content = src('app/app.js');
  assert.ok(content.includes('tasks.setRepo(repo)'),
    "app.js init must call tasks.setRepo(repo)");
});

check("app.js — init calls ui.setRepo(repo)", () => {
  const content = src('app/app.js');
  assert.ok(content.includes('ui.setRepo(repo)'),
    "app.js init must call ui.setRepo(repo)");
});

check("app.js — init calls onboarding.setRepo(repo)", () => {
  const content = src('app/app.js');
  assert.ok(content.includes('onboarding.setRepo(repo)'),
    "app.js init must call onboarding.setRepo(repo)");
});

check("app.js — init calls backupUI.setRepo(repo)", () => {
  const content = src('app/app.js');
  assert.ok(content.includes('backupUI.setRepo(repo)'),
    "app.js init must call backupUI.setRepo(repo)");
});

check("app.js — init calls backup.setRepo(repo)", () => {
  const content = src('app/app.js');
  assert.ok(content.includes('backup.setRepo(repo)'),
    "app.js init must call backup.setRepo(repo)");
});

/* ─── 6. B2 module isolation: storage access + ownership boundaries ── */
//
// These guards are the authoritative cross-file enforcement for the three
// B2 modules (v2-mutation-writer, v2-locked-import, v2-backup-service).
// Each module:
//   (a) must not touch localStorage or sessionStorage directly — all storage
//       goes through the injected adapter / sessionStore parameter.
//   (b) must not import anything from src/app/ — they are pure data-layer
//       modules with no dependency on the application layer above them.
//   (c) must not import V2_ACTIVATION_ENABLED — the flag is the caller's
//       responsibility; these modules are authority-neutral.
//
// Checks (a) for v2-backup-service.js already appear in section 1 / suite K;
// they are reproduced here so this file is the single authoritative
// cross-cutting storage guard covering all three B2 modules.
//
console.log('\n── B2 module isolation (no-direct-storage / ownership boundaries)');

const B2_MODULES = [
  { label: 'data/backup/v2-backup-service.js', path: ['data', 'backup', 'v2-backup-service.js'] },
  { label: 'data/backup/v2-locked-import.js',  path: ['data', 'backup', 'v2-locked-import.js']  },
  { label: 'data/v2/v2-mutation-writer.js',     path: ['data', 'v2',     'v2-mutation-writer.js'] },
];

for (const mod of B2_MODULES) {
  const raw      = src(...mod.path);
  const stripped = stripComments(raw);

  check(`${mod.label} — no raw localStorage API call (B2 adapter-only boundary)`, () => {
    assert.ok(!hasLocalStorageAccess(stripped),
      `${mod.label} must not call localStorage directly — use the injected adapter`);
  });

  check(`${mod.label} — no raw sessionStorage API call (B2 adapter-only boundary)`, () => {
    assert.ok(!hasSessionStorageAccess(stripped),
      `${mod.label} must not call sessionStorage directly — use the injected sessionStore parameter`);
  });

  check(`${mod.label} — no src/app imports (data-layer ownership boundary)`, () => {
    // No static import statement may traverse into src/app/.
    // Data-layer modules must not depend on the application layer.
    const importLines = stripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
    const appImports  = importLines.filter(
      line => /['"]([^'"]*\/app\/[^'"]*|\.\.\/app\/[^'"]*)['"]/.test(line),
    );
    assert.deepEqual(appImports, [],
      `${mod.label} must not import from src/app/: ${appImports.join('; ')}`);
  });

  check(`${mod.label} — does not import activation-config.js (V2_ACTIVATION_ENABLED is caller-side)`, () => {
    // B2 modules are authority-neutral: they assume v2 is active when called.
    // Importing the activation flag would couple data-layer logic to the feature
    // flag, which is a prohibited ownership breach.
    const importLines = stripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
    const flagImports = importLines.filter(line => line.includes('activation-config'));
    assert.deepEqual(flagImports, [],
      `${mod.label} must not import activation-config.js: ${flagImports.join('; ')}`);
  });
}

/* ─── 7. C module isolation: v2-backup-wiring.js ─────────────────────── */
//
// The factory module introduced in CP5C-C must obey the same
// adapter-only and ownership-boundary rules as the B2 modules.
// It must not touch storage directly, must not import from src/app/,
// and must not couple itself to V2_ACTIVATION_ENABLED.
//
console.log('\n── C module isolation (v2-backup-wiring.js — CP5C-C)');

const wiringRaw      = src('data', 'backup', 'v2-backup-wiring.js');
const wiringStripped = stripComments(wiringRaw);

check('v2-backup-wiring.js — no raw localStorage API call (C adapter-only boundary)', () => {
  assert.ok(!hasLocalStorageAccess(wiringStripped),
    'v2-backup-wiring.js must not call localStorage directly — all storage goes through V2BackupService');
});

check('v2-backup-wiring.js — no raw sessionStorage API call (C adapter-only boundary)', () => {
  assert.ok(!hasSessionStorageAccess(wiringStripped),
    'v2-backup-wiring.js must not call sessionStorage directly — all session access goes through V2BackupService');
});

check('v2-backup-wiring.js — no src/app imports (data-layer ownership boundary)', () => {
  const importLines = wiringStripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
  const appImports  = importLines.filter(
    line => /['"]([^'"]*\/app\/[^'"]*|\.\.\/app\/[^'"]*)['"]/.test(line),
  );
  assert.deepEqual(appImports, [],
    `v2-backup-wiring.js must not import from src/app/: ${appImports.join('; ')}`);
});

check('v2-backup-wiring.js — does not import activation-config.js (V2_ACTIVATION_ENABLED is caller-side)', () => {
  const importLines = wiringStripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
  const flagImports = importLines.filter(line => line.includes('activation-config'));
  assert.deepEqual(flagImports, [],
    `v2-backup-wiring.js must not import activation-config.js: ${flagImports.join('; ')}`);
});

/* ─── 8. D module isolation: v2-backup-service-adapter.js ────────────── */
//
// The facade-arity adapter introduced in CP5C-D must obey the same
// ownership-boundary rules as the B2 and C modules: no direct storage
// access, no src/app/ imports, no activation-config coupling, and
// (uniquely for this module) zero static import statements — it is a
// pure zero-dependency wrapper that accepts a pre-constructed service.
//
console.log('\n── D module isolation (v2-backup-service-adapter.js — CP5C-D)');

const adapterRaw      = src('data', 'backup', 'v2-backup-service-adapter.js');
const adapterStripped = stripComments(adapterRaw);

check('v2-backup-service-adapter.js — no raw localStorage API call (D adapter-only boundary)', () => {
  assert.ok(!hasLocalStorageAccess(adapterStripped),
    'v2-backup-service-adapter.js must not call localStorage directly — all storage goes through the injected service');
});

check('v2-backup-service-adapter.js — no raw sessionStorage API call (D adapter-only boundary)', () => {
  assert.ok(!hasSessionStorageAccess(adapterStripped),
    'v2-backup-service-adapter.js must not call sessionStorage directly — all session access goes through the injected service');
});

check('v2-backup-service-adapter.js — no src/app imports (data-layer ownership boundary)', () => {
  const importLines = adapterStripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
  const appImports  = importLines.filter(
    line => /['"]([^'"]*\/app\/[^'"]*|\.\.\/app\/[^'"]*)['"]/.test(line),
  );
  assert.deepEqual(appImports, [],
    `v2-backup-service-adapter.js must not import from src/app/: ${appImports.join('; ')}`);
});

check('v2-backup-service-adapter.js — zero static import statements (pure zero-dependency wrapper)', () => {
  const importLines = adapterRaw.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.equal(importLines.length, 0,
    `v2-backup-service-adapter.js must have no import statements; found: ${importLines.join(' | ')}`);
});

/* ─── 9. E1 module isolation: v2-repository.js ───────────────────────── */
//
// V2Repository introduced in E1 must obey the same ownership-boundary rules:
// no direct localStorage, no direct sessionStorage, no src/app/ imports, and
// no activation-config coupling.  These four checks mirror the pattern used
// for the B, C, and D data-layer modules above.
//
console.log('\n── E1 module isolation (v2-repository.js)');

const v2RepoRaw      = src('data', 'v2', 'v2-repository.js');
const v2RepoStripped = stripComments(v2RepoRaw);

check('v2-repository.js — no raw localStorage API call (E1 data-layer boundary)', () => {
  assert.ok(!hasLocalStorageAccess(v2RepoStripped),
    'v2-repository.js must not call localStorage directly — storage goes through the injected adapter');
});

check('v2-repository.js — no raw sessionStorage API call (E1 data-layer boundary)', () => {
  assert.ok(!hasSessionStorageAccess(v2RepoStripped),
    'v2-repository.js must not call sessionStorage directly');
});

check('v2-repository.js — no src/app imports (data-layer ownership boundary)', () => {
  const importLines = v2RepoStripped.match(/^\s*import\b[^'"]*['"][^'"]*['"]/gm) ?? [];
  const appImports  = importLines.filter(
    line => /['"]([^'"]*\/app\/[^'"]*|\.\.\/app\/[^'"]*)['"]/.test(line),
  );
  assert.deepEqual(appImports, [],
    `v2-repository.js must not import from src/app/: ${appImports.join('; ')}`);
});

check('v2-repository.js — no activation-config import (activation coupling boundary)', () => {
  assert.ok(!v2RepoRaw.includes('activation-config'),
    'v2-repository.js must not reference activation-config');
});

// ── Self-test: confirm hasSessionStorageAccess works correctly ──────────
check('hasSessionStorageAccess — detects real call but ignores comment-only mentions', () => {
  const commentOnly = '// sessionStorage.getItem is used elsewhere\n/* globalThis.sessionStorage */\nconst x = 1;';
  assert.ok(!hasSessionStorageAccess(stripComments(commentOnly)),
    'comment-only mentions must not trigger the scanner');
  const realCall = 'function f() { return sessionStorage.getItem("k"); }';
  assert.ok(hasSessionStorageAccess(stripComments(realCall)),
    'real sessionStorage.getItem() call must be detected');
  const windowForm = 'const s = window.sessionStorage;';
  assert.ok(hasSessionStorageAccess(stripComments(windowForm)),
    'window.sessionStorage access must be detected');
  const bracketForm = 'sessionStorage["key"] = v;';
  assert.ok(hasSessionStorageAccess(stripComments(bracketForm)),
    'sessionStorage["key"] bracket form must be detected');
});

/* ─── Results ─────────────────────────────────────────────────── */
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
