/**
 * v2-startup-coordinator.test.mjs — E2 deferred V2Repository boundary.
 *
 * Synthetic-only traps prove that disabled startup does not load or construct
 * V2Repository and does not touch storage, locks, timers, migration, recovery,
 * or rollback paths.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maybeCreateV2Repository } from '../src/v2/startup-coordinator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const readSrc = (...parts) => readFileSync(join(HERE, '..', 'src', ...parts), 'utf8');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name} — ${error.message}`);
  }
}

function makeTrap(label) {
  return () => { throw new Error(`unexpected ${label}`); };
}

await check('default disabled coordinator performs zero import, I/O, lock, timer, or mutation work', async () => {
  let imports = 0;
  const trap = makeTrap('disabled v2 operation');
  const result = await maybeCreateV2Repository({
    backing: { getItem: trap, setItem: trap, removeItem: trap },
    lock: { runExclusive: trap },
    scheduler: { setTimeout: trap, clearTimeout: trap },
    _loadModule: async () => { imports++; throw new Error('unexpected v2 import'); },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(imports, 0);
});

await check('explicit disabled override ignores every injected v2 dependency', async () => {
  let imports = 0;
  const trap = makeTrap('explicitly disabled v2 operation');
  const result = await maybeCreateV2Repository({
    enabled: false,
    backing: { getItem: trap, setItem: trap, removeItem: trap },
    lock: { runExclusive: trap },
    _loadModule: async () => { imports++; throw new Error('unexpected v2 import'); },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(imports, 0);
});

await check('enabled coordinator dynamically loads and constructs V2Repository only through its injected loader', async () => {
  let imports = 0;
  let constructed;
  class FakeV2Repository {
    constructor(options) { constructed = options; }
  }
  const backing = { getItem: makeTrap('storage read'), setItem: makeTrap('storage write'), removeItem: makeTrap('storage removal') };
  const lock = { runExclusive: makeTrap('lock acquisition') };
  const result = await maybeCreateV2Repository({
    enabled: true,
    backing,
    lock,
    digestFn: () => 'digest',
    timeoutMs: 0,
    _loadModule: async specifier => {
      imports++;
      assert.equal(specifier, '../data/v2/v2-repository.js');
      return { V2Repository: FakeV2Repository };
    },
  });
  assert.equal(result.status, 'ready');
  assert.ok(result.repo instanceof FakeV2Repository);
  assert.equal(imports, 1);
  assert.equal(constructed.adapter, backing);
  assert.equal(constructed.lock, lock);
  assert.equal(constructed.timeoutMs, 0);
});

await check('enabled coordinator rejects a missing backing before importing V2Repository', async () => {
  let imports = 0;
  const result = await maybeCreateV2Repository({
    enabled: true,
    lock: { runExclusive: makeTrap('lock acquisition') },
    _loadModule: async () => { imports++; return {}; },
  });
  assert.equal(result.status, 'failed');
  assert.equal(imports, 0);
});

await check('entry loads only the coordinator for verified v2 authority and never names V2Repository', async () => {
  const script = readSrc('script.js');
  assert.match(script, /decision === 'v2-authoritative'/);
  assert.match(script, /import\('\.\/v2\/startup-coordinator\.js'\)/);
  assert.ok(!script.includes('v2-repository'));
  assert.ok(!script.includes('new V2Repository'));
});

await check('only the coordinator contains the deferred V2Repository import', async () => {
  const coordinator = readSrc('v2', 'startup-coordinator.js');
  const script = readSrc('script.js');
  assert.match(coordinator, /import\(specifier\)/);
  assert.ok(!script.includes('data/v2/v2-repository'));
});

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);