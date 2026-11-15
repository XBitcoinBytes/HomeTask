/**
 * harness-fixture-fail.mjs — deliberately failing async test fixture.
 *
 * Used by v2-shadow.test.mjs §harness-self-test to prove the repaired
 * async harness detects delayed asynchronous failures and exits nonzero.
 *
 * This file intentionally exits with code 1. Do not add it to run-all.mjs.
 */
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const _pending = [];
function check(name, fn) {
  const p = Promise.resolve().then(() => fn()).then(
    ()  => { pass++; },
    e   => { fail++; process.stderr.write(`  ✗ ${name}\n    ${e.message}\n`); },
  );
  _pending.push(p);
  return p;
}

/* One synchronous passing check — proves the harness records passes correctly. */
check('sync pass', () => { assert.equal(1, 1); });

/* One asynchronous failing check with a real delay — the key assertion:
   the harness must WAIT for this before printing results. */
check('async delayed failure', () =>
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('intentional delayed failure for harness self-test')), 20),
  ),
);

/* ── Summary (must be printed AFTER all checks settle) ── */
await Promise.all(_pending);
process.stdout.write(`Results: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
