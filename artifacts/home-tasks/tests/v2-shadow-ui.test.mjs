/**
 * v2-shadow-ui.test.mjs — disabled shadow diagnostic isolation.
 *
 * E2 keeps the existing Backup & Restore UI authoritative while removing the
 * dormant diagnostic runtime wiring from disabled startup. This suite is pure
 * source and bridge coverage; it never opens a browser or accesses storage.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maybeShadowMigrate } from '../src/v2/shadow-bridge.js';
import { isValidVerifiedWrapper } from '../src/v2/shadow-validate.js';
import { buildPresentation } from '../src/v2/shadow-presenter.js';
import {
  shadowStatus,
  onShadowUpdate,
  notifyShadowUpdate,
} from '../src/app/shadow-status.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (...parts) => readFileSync(join(HERE, '..', 'src', ...parts), 'utf8');

const VALID_FP = 'a'.repeat(64);

function makeValidWrapper(overrides = {}) {
  const base = {
    shadowSchemaVersion: 1,
    status: 'verified',
    sourceFingerprint: VALID_FP,
    targetSchema: 2,
    sourceSchema: 1,
    generatedAt: '2024-01-15T10:30:00.000Z',
    appBuild: 'v20-shadow',
    catalogVersion: 42,
    candidate: {
      state: [],
      userZones: [],
      userTasks: [],
      completionEvents: [],
      overrides: {},
      recentSearches: [],
      prefs: {},
      meta: {},
      schemaVersion: 2,
    },
    verificationSummary: {
      unexpectedDiffCount: 0,
      diffCategoryCodes: [],
      stateCount: 5,
      userZoneCount: 3,
      userTaskCount: 10,
      completionEventCount: 0,
      overrideCount: 0,
      recentSearchCount: 2,
      repairsFromMigration: {
        droppedUnknownIdsCount: 0,
        malformedCount: 0,
        normalizedDoneTodayCount: 0,
        sanitizedFieldsCount: 0,
        sanitizedFieldCategories: [],
        roomFilterResolved: false,
        dueNowDefaultFold: false,
      },
    },
  };
  return Object.assign(JSON.parse(JSON.stringify(base)), overrides);
}

function makeValidBridgeResult(wrapperOverrides = {}, resultOverrides = {}) {
  return Object.assign({
    ok: true,
    status: 'verified',
    wrapper: makeValidWrapper(wrapperOverrides),
    byteSize: 1000,
    errors: [],
    warnings: [],
    preservedExistingVerified: false,
  }, resultOverrides);
}

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

// Intentionally retired: the nine checks for Upgrade Check/Share Report
// markup, status UI, flag-driven reveal, automatic startup, and dialog
// subscriptions. The checks below exercise only pure, synthetic modules.
await check('validator rejects non-wrapper values', async () => {
  assert.equal(isValidVerifiedWrapper(null), false);
  assert.equal(isValidVerifiedWrapper(undefined), false);
  assert.equal(isValidVerifiedWrapper('verified'), false);
  assert.equal(isValidVerifiedWrapper(42), false);
  assert.equal(isValidVerifiedWrapper([]), false);
});

await check('validator requires verified status', async () => {
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ status: 'failed' })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ status: 'VERIFIED' })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ status: null })), false);
});

await check('validator requires shadow schema version one', async () => {
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ shadowSchemaVersion: 2 })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ shadowSchemaVersion: 0 })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ shadowSchemaVersion: '1' })), false);
});

await check('validator requires a lowercase 64-character source fingerprint', async () => {
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ sourceFingerprint: 'abc' })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ sourceFingerprint: 'A'.repeat(64) })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ sourceFingerprint: 'g'.repeat(64) })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ sourceFingerprint: null })), false);
  assert.equal(isValidVerifiedWrapper(makeValidWrapper({ sourceFingerprint: 'a'.repeat(63) })), false);
});

await check('validator rejects malformed candidate structures', async () => {
  const missingState = makeValidWrapper();
  delete missingState.candidate.state;
  assert.equal(isValidVerifiedWrapper(missingState), false);

  const arrayOverrides = makeValidWrapper();
  arrayOverrides.candidate.overrides = [1, 2];
  assert.equal(isValidVerifiedWrapper(arrayOverrides), false);

  const nullCandidate = makeValidWrapper();
  nullCandidate.candidate = null;
  assert.equal(isValidVerifiedWrapper(nullCandidate), false);
});

await check('validator rejects unexpected migration differences', async () => {
  const wrapper = makeValidWrapper();
  wrapper.verificationSummary.unexpectedDiffCount = 1;
  assert.equal(isValidVerifiedWrapper(wrapper), false);
});

await check('validator accepts a fully verified wrapper', async () => {
  assert.equal(isValidVerifiedWrapper(makeValidWrapper()), true);
});

await check('presenter rejects non-object results', async () => {
  for (const value of [null, undefined, 'string', 42]) {
    const presentation = buildPresentation(value);
    assert.equal(presentation.phase, 'needs-review');
    assert.equal(presentation.shareAllowed, false);
    assert.equal(presentation.safeReport, null);
  }
});

await check('presenter treats disabled status as idle without a report', async () => {
  const presentation = buildPresentation({ status: 'disabled' });
  assert.equal(presentation.phase, 'idle');
  assert.equal(presentation.safeReport, null);
  assert.equal(presentation.shareAllowed, false);
});

await check('presenter rejects failed status', async () => {
  const presentation = buildPresentation({ status: 'failed', errors: ['x'], warnings: [] });
  assert.equal(presentation.phase, 'needs-review');
  assert.equal(presentation.shareAllowed, false);
});

await check('presenter rejects a verified result with a bad fingerprint', async () => {
  const presentation = buildPresentation(
    makeValidBridgeResult({ sourceFingerprint: 'not-a-valid-fp' }),
  );
  assert.equal(presentation.phase, 'needs-review');
  assert.equal(presentation.shareAllowed, false);
  assert.equal(presentation.safeReport, null);
});

await check('presenter strictly rejects invalid sanitized field categories', async () => {
  const result = makeValidBridgeResult();
  result.wrapper.verificationSummary.repairsFromMigration.sanitizedFieldCategories =
    ['ValidCode', 'invalid entry with spaces'];
  const presentation = buildPresentation(result);
  assert.equal(presentation.phase, 'needs-review');
  assert.equal(presentation.shareAllowed, false);
});

await check('presenter rejects excessive sanitized field categories without truncation', async () => {
  const result = makeValidBridgeResult();
  result.wrapper.verificationSummary.repairsFromMigration.sanitizedFieldCategories =
    Array.from({ length: 21 }, (_, i) => `Cat${String(i).padStart(2, '0')}`);
  const presentation = buildPresentation(result);
  assert.equal(presentation.phase, 'needs-review');
});

await check('presenter rejects verified results with difference categories', async () => {
  const result = makeValidBridgeResult();
  result.wrapper.verificationSummary.diffCategoryCodes = ['VALID_CODE'];
  const presentation = buildPresentation(result);
  assert.equal(presentation.phase, 'needs-review');
  assert.equal(presentation.shareAllowed, false);
});

await check('presenter rejects invalid difference category formats', async () => {
  const result = makeValidBridgeResult();
  result.wrapper.verificationSummary.diffCategoryCodes = ['VALID', 'invalid lowercase'];
  const presentation = buildPresentation(result);
  assert.equal(presentation.phase, 'needs-review');
});

await check('presenter requires room-filter repair state to be boolean', async () => {
  const result = makeValidBridgeResult();
  result.wrapper.verificationSummary.repairsFromMigration.roomFilterResolved = 1;
  const presentation = buildPresentation(result);
  assert.equal(presentation.phase, 'needs-review');
});

await check('presenter rejects null warnings', async () => {
  const presentation = buildPresentation(makeValidBridgeResult({}, { warnings: null }));
  assert.equal(presentation.phase, 'needs-review');
});

await check('presenter rejects invalid generation timestamps', async () => {
  const presentation = buildPresentation(makeValidBridgeResult({ generatedAt: 'not-a-date' }));
  assert.equal(presentation.phase, 'needs-review');
});

await check('presenter requires source schema version one', async () => {
  const presentation = buildPresentation(makeValidBridgeResult({ sourceSchema: 2 }));
  assert.equal(presentation.phase, 'needs-review');
});

await check('presenter rejects unexpected differences without safe sharing', async () => {
  const result = makeValidBridgeResult();
  result.wrapper.verificationSummary.unexpectedDiffCount = 1;
  const presentation = buildPresentation(result);
  assert.equal(presentation.phase, 'needs-review');
  assert.equal(presentation.shareAllowed, false);
});

await check('presenter produces a privacy-safe report for a verified result', async () => {
  const presentation = buildPresentation(makeValidBridgeResult());
  assert.equal(presentation.phase, 'verified');
  assert.ok(presentation.safeReport !== null);
  assert.equal(presentation.shareAllowed, true);
  assert.ok(!('candidate' in presentation.safeReport));
  assert.ok(
    typeof presentation.safeReport._notice === 'string' &&
      presentation.safeReport._notice.includes('does not include'),
  );
  assert.equal(presentation.safeReport.status, 'verified');
});

await check('shadow status notifies the registered listener', async () => {
  const calls = [];
  const unsubscribe = onShadowUpdate(() => calls.push(1));
  notifyShadowUpdate();
  unsubscribe();
  assert.equal(calls.length, 1);
});

await check('shadow status unsubscribe prevents later notification', async () => {
  const calls = [];
  const unsubscribe = onShadowUpdate(() => calls.push(1));
  unsubscribe();
  notifyShadowUpdate();
  assert.equal(calls.length, 0);
});

await check('shadow status isolates listener exceptions', async () => {
  const phaseBefore = shadowStatus.phase;
  const shareAllowedBefore = shadowStatus.shareAllowed;
  const unsubscribe = onShadowUpdate(() => { throw new Error('listener error'); });
  assert.doesNotThrow(() => notifyShadowUpdate());
  unsubscribe();
  assert.equal(shadowStatus.phase, phaseBefore);
  assert.equal(shadowStatus.shareAllowed, shareAllowedBefore);
});

await check('shadow status replaces the prior listener', async () => {
  const firstCalls = [];
  const secondCalls = [];
  const unsubscribeFirst = onShadowUpdate(() => firstCalls.push(1));
  const unsubscribeSecond = onShadowUpdate(() => secondCalls.push(1));
  notifyShadowUpdate();
  unsubscribeFirst();
  unsubscribeSecond();
  assert.equal(firstCalls.length, 0);
  assert.equal(secondCalls.length, 1);
});

await check('shadow default is disabled and source-controlled', async () => {
  const config = src('v2', 'shadow-config.js');
  assert.match(config, /SHADOW_MIGRATION_ENABLED = false/);
  assert.ok(!config.includes('localStorage.') && !config.includes('URLSearchParams'));
});

await check('disabled bridge does not import, touch storage, create timers, or invoke migration', async () => {
  let imports = 0;
  const trap = () => { throw new Error('disabled shadow path touched a trap'); };
  const result = await maybeShadowMigrate({
    enabled: false,
    adapter: { getItem: trap, setItem: trap, removeItem: trap },
    scheduler: { setTimeout: trap, clearTimeout: trap },
    _loadModule: async () => { imports++; throw new Error('disabled shadow path imported'); },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(imports, 0);
});

await check('entry point has no shadow diagnostic import or invocation', async () => {
  const script = src('script.js');
  assert.ok(!script.includes('shadow-bridge'));
  assert.ok(!script.includes('shadow-presenter'));
  assert.ok(!script.includes('startShadowDiagnostic'));
});

await check('backup UI retains its accepted facade without diagnostic runtime imports', async () => {
  const backupUi = src('app', 'backup-ui.js');
  assert.ok(!backupUi.includes('shadow-status'));
  assert.ok(!backupUi.includes('shadow-config'));
  assert.ok(!backupUi.includes('maybeShadowMigrate'));
  assert.match(backupUi, /backup\.exportBackup\(\)/);
  assert.match(backupUi, /backup\.readAndValidate\(/);
  assert.match(backupUi, /backup\.applyImport\(/);
  assert.match(backupUi, /backup\.applyUndo\(\)/);
});

console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);