/* ================================================================
   CSS import — must be first so Vite bundles the stylesheet with a
   content-hashed filename (e.g. /assets/index-[hash].css) that is
   atomically paired with this JS bundle. The <link> is injected
   automatically into the built HTML; do not add a manual <link>.
   ================================================================ */
import './style.css';
import { computeWorkload, isActionableNow, belongsInToday } from './workload.js';

/* Build identifier — bump together with public/sw.js cache name. */
const APP_BUILD = 'v22-f1';

/* ================================================================
   HomeTask — script.js
   Phase 3 · Hardened · Smart Start onboarding · Room picker
   ================================================================
   Modules (IIFE):
     SEED_TASKS      — 126-task source of truth (23 rooms)
     storage         — localStorage (key: hometask-v1) + idempotent merge
     meta            — preferences + onboarding state (key: hometask-meta-v1)
     computeEffectiveDue — single due-date resolver
     tasks           — markDone · skipToday · skipWeek · applyBaseline
     statusOf        — 5-type color system (done/future/soon/overdue/critical)
     search          — filter by query + room
     ui              — render room groups + room picker + patchCard
     onboarding      — Smart Start first-use dialog
     app             — init · event wiring · onboarding · room picker
   ================================================================ */

// CSS is served as a static file from public/style.css linked in index.html.


/* ================================================================
   CP2 module split: each section of the original script.js now lives
   in src/app/. Imports below run in the EXACT original top-to-bottom
   order, so every startup side effect fires in the same sequence.
   ('use strict' is implicit in ES modules.)
   ================================================================ */
import './app/util.js';
import './app/catalog.js';
import './app/due.js';
import './app/startup.js';
import './app/recovery.js';
import './app/storage.js';
import './app/meta.js';
import './app/tasks.js';
import './app/status.js';
import './app/search.js';
import './app/recents.js';
import './app/scroll-lock.js';
import './app/custom-tasks-config.js';
import './app/ui.js';
import './app/onboarding.js';
import { backupStore } from './app/backup-store.js';
import { stagingStore } from './app/staging-store.js';
import { backup }       from './app/backup.js';
import './app/backup-ui.js';
import './app/app.js';
import { app } from './app/app.js';

/* ── CP5C-A2.1: V1Repository wiring ──────────────────────────── */
import { V1Repository }               from './data/repository/v1-repository.js';
import { createBrowserStorageBacking } from './data/repository/browser-storage-backing.js';
import { SEED_TASKS, ROOMS_ORDERED }  from './app/catalog.js';
import { recoveryStore }              from './app/recovery.js';
import { todayStr as _todayStr }      from './app/util.js';

/* ── CP5C-A2.2b: V1BackupService wiring ──────────────────────────── */
import { V1BackupService }         from './data/backup/v1-backup-service.js';
import { createBrowserFileReader } from './data/backup/browser-file-reader.js';
import { createBrowserDelivery }   from './data/backup/browser-delivery.js';

/* ── CP5B activation recovery bridge ─────────────────────────── *
 * maybeRecoverActivation() checks V2_ACTIVATION_ENABLED at runtime.
 * When false (committed default) it returns { status:'disabled' }
 * immediately with zero side effects — no storage, no timers, no
 * dynamic imports, no console output.
 * bootDecision() is a pure fail-closed gate: only 'boot-v1' results
 * allow app.init() to run. With V2_ACTIVATION_ENABLED=false the
 * decision is always 'boot-v1'. Both modules are independently tested.
 * ──────────────────────────────────────────────────────────────── */
import { maybeRecoverActivation } from './v2/activation-bridge.js';
import { bootDecision }           from './v2/activation-boot.js';

/* ── Boot ─────────────────────────────────────────────────────── */
/*
 * Startup sequence (CP5B):
 *
 *   A. Import-staging recovery (startup.js IIFE) — fires synchronously at
 *      module-evaluation time, before DOMContentLoaded. May restore
 *      hometask-v1 and hometask-meta-v1 from an interrupted import.
 *
 *   B. Activation recovery (maybeRecoverActivation) — async, after
 *      DOMContentLoaded. With V2_ACTIVATION_ENABLED=false returns
 *      { status:'disabled' } immediately; zero storage, zero timers,
 *      zero dynamic imports. When enabled, reads/writes only activation
 *      keys and source-key fingerprints — never writes source keys.
 *      Fingerprints the post-A v1 state, so any import-staging rollback
 *      that modified v1 is correctly detected as source_changed.
 *
 *   C. Boot decision (bootDecision) — pure, fail-closed. Only 'boot-v1'
 *      allows app.init() to proceed. All other outcomes (v2-authoritative,
 *      ambiguous, indeterminate, or any unexpected result) halt the boot
 *      to prevent starting the writable v1 app with incorrect authority.
 *      With V2_ACTIVATION_ENABLED=false the decision is always 'boot-v1'.
 *
 *   D. app.init() — first authoritative reads of hometask-v1 (tasks.js
 *      lazification deferred the eval-time read) and hometask-meta-v1.
 *      Disabled startup imports no shadow diagnostic path.
 *
 * Rejection semantics (identical to pre-CP5B):
 *   maybeRecoverActivation() never rejects — the bridge catches all
 *   exceptions internally and returns a structured result.
 *   app.init() failures are NOT caught inside _boot() and propagate
 *   as unhandled rejections — the same observable behavior as before.
 */

/** Captured by CP5C to determine whether v2 serving is ready. */
let _activationRecoveryResult = null;

function _boot() {
  maybeRecoverActivation({ appBuild: APP_BUILD }).then(result => {
    _activationRecoveryResult = result;
    const decision = bootDecision(result);

    if (decision === 'boot-v1') {
      // Normal v1 boot — rejection semantics identical to pre-CP5B.
      // app.init() failures are not caught and propagate as unhandled rejections.

      // Shared backing: same localStorage wrapper for V1Repository writes and
      // V1BackupService atomic-commit writes, so the write path is identical.
      const _backing = createBrowserStorageBacking();
      const repo = new V1Repository({
        backing:         _backing,
        catalog:         SEED_TASKS,
        todayFn:         () => _todayStr(),
        recoveryAdapter: recoveryStore,
      });

      // CP5C-A2.2b: construct V1BackupService and inject into backup facade.
      // setService() must be called before app.init() so the facade is ready
      // when backup-ui.js first opens the Backup & Restore sheet.
      const _backupSvc = new V1BackupService({
        catalogTasks: SEED_TASKS,
        catalogRooms: ROOMS_ORDERED,
        repo,
        backing:      _backing,
        backupStore,
        stagingStore,
        recoveryStore,
        fileReader:   createBrowserFileReader(),
        delivery:     createBrowserDelivery(),
        clock:        () => new Date().toISOString(),
        sessionStore: {
          getItem:    k => sessionStorage.getItem(k),
          setItem:    (k, v) => sessionStorage.setItem(k, v),
          removeItem: k => sessionStorage.removeItem(k),
        },
      });
      backup.setService(_backupSvc);

      app.init(repo);
      return;
    }

    if (decision === 'v2-authoritative') {
      // E2: load the coordinator only after verified v2 authority. It owns the
      // deferred V2Repository import and preserves the existing no-v1-write halt.
      import('./v2/startup-coordinator.js')
        .then(({ maybeCreateV2Repository }) =>
          maybeCreateV2Repository({ backing: createBrowserStorageBacking() }))
        .then(v2 => {
          console.warn('[HomeTask] Boot halted — v2 serving is not enabled:', v2.status);
        })
        .catch(() => {
          console.warn('[HomeTask] Boot halted — v2 coordinator unavailable');
        });
      return;
    }

    // Unsafe to run the writable v1 app:
    //   'ambiguous'        — authority indeterminate; retain evidence.
    //   'indeterminate'    — unknown/forged/contradictory result.
    // With V2_ACTIVATION_ENABLED=false this branch is structurally unreachable.
    console.warn('[HomeTask] Boot halted — activation authority:', decision,
      result?.action ?? '');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _boot);
} else {
  _boot();
}
