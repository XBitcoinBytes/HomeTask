/* ================================================================
   run-all.mjs — runs the complete HomeTask regression suite.

   Usage:  node artifacts/home-tasks/tests/run-all.mjs
   Exits non-zero if any suite fails.
   ================================================================ */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['backup.test.mjs', 'workload.test.mjs', 'v2.test.mjs', 'import-order.test.mjs',
  'v2-backup.test.mjs', 'v2-tx.test.mjs', 'v2-tripwire.test.mjs', 'v2-shadow.test.mjs',
   'v2-shadow-bridge.test.mjs', 'v2-shadow-ui.test.mjs', 'sw-install.test.mjs',
   'release-hardening.test.mjs',
  'v2-activation.test.mjs', 'v2-activation-bridge.test.mjs', 'v1-repository.test.mjs',
  'no-direct-storage.test.mjs', 'v1-wiring.test.mjs', 'backup-service.test.mjs',
  'backup-facade.test.mjs', 'v2-mutation-writer.test.mjs',
  'v2-backup-service.test.mjs',
  'v2-locked-import.test.mjs',
  'v2-wiring.test.mjs',
  'v2-adapter.test.mjs',
  'v2-composition.test.mjs',
  'v2-startup-coordinator.test.mjs',
  'custom-data-preservation.test.mjs',
  'f1-custom-tasks.test.mjs',
   'f1-ui-accessibility.test.mjs',
   'step2-custom-task-creation.test.mjs',
   'step3-safe-delete.test.mjs',
   'step4-custom-room-lifecycle.test.mjs'];

let failed = false;
for (const file of suites) {
  console.log(`\n═══ ${file} ═══`);
  const r = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
console.log(failed ? '\nSUITE FAILED' : '\nALL SUITES PASSED');
process.exit(failed ? 1 : 0);
