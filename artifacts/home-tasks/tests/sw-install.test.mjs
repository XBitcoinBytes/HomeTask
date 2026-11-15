/* ================================================================
    sw-install.test.mjs — 16 checks for service-worker installation.

   Tests the atomic install handler in public/sw.js:
     1     Successful install
     2–5   Individual fetch failures (JS, CSS, manifest, HTML)
     6–7   cache.put failure / skipWaiting ordering
      8–9   Cache name and existing-cache preservation
      10–11 Missing asset references in HTML
      12    Ambiguous references
      13    Partial cache-write failure + cleanup
      14–16 Rooted, relative, and base-prefixed exact asset paths

   Strategy: sw.js is loaded via new Function() with injected mocks
   for self, caches, fetch, and Request so no browser context is needed.
   ================================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE    = dirname(fileURLToPath(import.meta.url));
const SW_PATH = join(HERE, '..', 'public', 'sw.js');
const SW_SRC  = readFileSync(SW_PATH, 'utf8');

const CACHE_NAME = 'hometask-v22-f1';
const OLD_CACHE_NAME = 'hometask-previous-release';

/* ── Mock Request (avoids Node URL-resolution issues with relative paths) ── */
class MockRequest {
  constructor(url, opts = {}) {
    this.url    = String(url);
    this.method = opts.method ?? 'GET';
    this.mode   = opts.mode   ?? 'no-cors';
    this.cache  = opts.cache  ?? 'default';
  }
}

/* ── Mock Response ────────────────────────────────────────────── */
function mockResponse(body = '', ok = true, status = 200) {
  return {
    ok, status,
    clone() { return mockResponse(body, ok, status); },
    text()  { return Promise.resolve(String(body)); },
  };
}

/* ── Valid HTML containing exactly one JS and one CSS hashed ref ── */
const JS_PATH  = '/assets/index-abc123.js';
const CSS_PATH = '/assets/index-def456.css';
const VALID_HTML = [
  '<!DOCTYPE html><html><head>',
  `<link rel="stylesheet" href="${CSS_PATH}">`,
  '</head><body>',
  `<script type="module" src="${JS_PATH}"></script>`,
  '</body></html>',
].join('\n');

function htmlFor(jsPath, cssPath) {
  return [
    '<!DOCTYPE html><html><head>',
    `<link rel="stylesheet" href="${cssPath}">`,
    '</head><body>',
    `<script type="module" src="${jsPath}"></script>`,
    '</body></html>',
  ].join('\n');
}

/* ── Mock environment factory ────────────────────────────────── */
function makeEnv() {
  const handlers         = {};
  const skipWaitingCalls = [];
  const deletedCaches    = [];
  const putsByCache      = {};  // cacheName -> [url, ...]

  const self = {
    location:     { origin: 'https://example.com' },
    addEventListener(type, fn) { handlers[type] = fn; },
    async skipWaiting()        { skipWaitingCalls.push(true); },
    clients: {
      claim:      async () => {},
      matchAll:   async () => [],
      openWindow: async () => {},
    },
    registration: { showNotification: async () => {} },
  };

  const caches = {
    async open(name) {
      if (!putsByCache[name]) putsByCache[name] = [];
      return {
        async put(req, _res) {
          putsByCache[name].push(req instanceof MockRequest ? req.url : String(req));
        },
        async addAll() {},
        async match()  { return undefined; },
      };
    },
    async keys()        { return Object.keys(putsByCache).filter(k => !deletedCaches.includes(k)); },
    async delete(name)  { deletedCaches.push(name); return true; },
    async match()       { return undefined; },
  };

  return { self, caches, handlers, skipWaitingCalls, deletedCaches, putsByCache };
}

/* ── Fetch factory ─────────────────────────────────────────────── */
function makeFetch(overrides) {
  // overrides: [[urlSubstring, responseOrFn], ...]
  return async (req) => {
    const url = req instanceof MockRequest ? req.url : String(req);
    for (const [test, res] of overrides) {
      if (url.includes(test)) return typeof res === 'function' ? res() : res;
    }
    return mockResponse('', false, 404);
  };
}

function defaultFetch() {
  return makeFetch([
    ['index.html',   mockResponse(VALID_HTML)],
    ['manifest.json', mockResponse('{}')],
    [JS_PATH,        mockResponse('// js bundle')],
    [CSS_PATH,       mockResponse('/* css */')],
  ]);
}

/* ── Loader: injects SW code into mock env ────────────────────── */
function loadAndInstall(env, mockFetch) {
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Request', SW_SRC)(
    env.self, env.caches, mockFetch, MockRequest
  );
  let installPromise;
  env.handlers.install({ waitUntil(p) { installPromise = p; } });
  return installPromise;
}

/* ── Test harness ─────────────────────────────────────────────── */
let passed = 0, failed = 0;
async function check(name, fn) {
  try   { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' — ' + e.message); }
}

console.log('\nHomeTask sw-install checks');

/* ── Test 1: Successful install ───────────────────────────────── */
await check('1: successful install — all 4 assets cached; skipWaiting called once', async () => {
  const env = makeEnv();
  await loadAndInstall(env, defaultFetch());
  assert.equal(env.skipWaitingCalls.length, 1,  'skipWaiting must be called exactly once');
  const puts = env.putsByCache[CACHE_NAME] ?? [];
  assert.equal(puts.length, 4, 'exactly 4 assets must be cached');
  assert.deepEqual(puts, ['./index.html', './manifest.json', JS_PATH, CSS_PATH],
    'all cache keys must exactly match the fetched paths');
});

/* ── Test 2: JS fetch fails ───────────────────────────────────── */
await check('2: JS 404 → install fails; skipWaiting not called; new cache deleted', async () => {
  const env = makeEnv();
  const fetch = makeFetch([
    ['index.html',   mockResponse(VALID_HTML)],
    ['manifest.json', mockResponse('{}')],
    [JS_PATH,        mockResponse('', false, 404)],
    [CSS_PATH,       mockResponse('/* css */')],
  ]);
  await assert.rejects(loadAndInstall(env, fetch));
  assert.equal(env.skipWaitingCalls.length, 0, 'skipWaiting must not be called on failure');
  assert.ok(env.deletedCaches.includes(CACHE_NAME), 'new cache must be deleted on failure');
});

/* ── Test 3: CSS fetch fails ──────────────────────────────────── */
await check('3: CSS 404 → install fails; cleanup performed', async () => {
  const env = makeEnv();
  const fetch = makeFetch([
    ['index.html',   mockResponse(VALID_HTML)],
    ['manifest.json', mockResponse('{}')],
    [JS_PATH,        mockResponse('// js bundle')],
    [CSS_PATH,       mockResponse('', false, 404)],
  ]);
  await assert.rejects(loadAndInstall(env, fetch));
  assert.equal(env.skipWaitingCalls.length, 0);
  assert.ok(env.deletedCaches.includes(CACHE_NAME));
});

/* ── Test 4: Manifest fetch fails ─────────────────────────────── */
await check('4: manifest 404 → install fails; cleanup performed', async () => {
  const env = makeEnv();
  const fetch = makeFetch([
    ['index.html',    mockResponse(VALID_HTML)],
    ['manifest.json', mockResponse('', false, 404)],
  ]);
  await assert.rejects(loadAndInstall(env, fetch));
  assert.equal(env.skipWaitingCalls.length, 0);
  assert.ok(env.deletedCaches.includes(CACHE_NAME));
});

/* ── Test 5: HTML fetch fails ─────────────────────────────────── */
await check('5: index.html 404 → install fails immediately; cache deleted', async () => {
  const env = makeEnv();
  const fetch = makeFetch([['index.html', mockResponse('', false, 404)]]);
  await assert.rejects(loadAndInstall(env, fetch), /404/);
  assert.equal(env.skipWaitingCalls.length, 0);
  assert.ok(env.deletedCaches.includes(CACHE_NAME));
});

/* ── Test 6: cache.put failure ────────────────────────────────── */
await check('6: cache.put failure → install fails; new cache deleted; skipWaiting not called', async () => {
  const env = makeEnv();
  let putCount = 0;
  const origOpen = env.caches.open.bind(env.caches);
  env.caches.open = async (name) => {
    const c = await origOpen(name);
    const origPut = c.put.bind(c);
    c.put = async (req, res) => {
      putCount++;
      if (putCount >= 3) throw new Error('simulated cache.put failure');
      return origPut(req, res);
    };
    return c;
  };
  await assert.rejects(loadAndInstall(env, defaultFetch()), /cache\.put failure/);
  assert.equal(env.skipWaitingCalls.length, 0);
  assert.ok(env.deletedCaches.includes(CACHE_NAME));
});

/* ── Test 7: skipWaiting called only after all writes ─────────── */
await check('7: skipWaiting called only after all cache.put calls succeed', async () => {
  const env = makeEnv();
  let putCount = 0;
  const origOpen = env.caches.open.bind(env.caches);
  env.caches.open = async (name) => {
    const c = await origOpen(name);
    const origPut = c.put.bind(c);
    c.put = async (req, res) => {
      assert.equal(env.skipWaitingCalls.length, 0,
        'skipWaiting must not be called before all puts complete');
      putCount++;
      return origPut(req, res);
    };
    return c;
  };
  await loadAndInstall(env, defaultFetch());
  assert.equal(putCount, 4,                         '4 puts must occur');
  assert.equal(env.skipWaitingCalls.length, 1, 'skipWaiting called after all puts');
});

/* ── Test 8: cache name is correct ───────────────────────────── */
await check('8: assets written to the v22-f1 cache without writing a prior cache', async () => {
  const env = makeEnv();
  await loadAndInstall(env, defaultFetch());
  assert.ok(CACHE_NAME in env.putsByCache,
    `assets must be written to ${CACHE_NAME}`);
  assert.ok(!(OLD_CACHE_NAME in env.putsByCache),
    'nothing must be written to a prior cache during install');
});

/* ── Test 9: existing cache not deleted during install ────────── */
await check('9: existing cache untouched during install (only activate deletes old caches)', async () => {
  const env = makeEnv();
  // Simulate a pre-existing cache.
  env.putsByCache[OLD_CACHE_NAME] = ['./index.html'];
  await loadAndInstall(env, defaultFetch());
  assert.ok(!env.deletedCaches.includes(OLD_CACHE_NAME),
    'an existing cache must not be deleted during install');
});

/* ── Test 10: JS reference absent ────────────────────────────── */
await check('10: HTML with no JS reference → install fails; cache deleted', async () => {
  const noJsHtml = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="${CSS_PATH}">
</head><body></body></html>`;
  const env = makeEnv();
  const fetch = makeFetch([
    ['index.html',    mockResponse(noJsHtml)],
    ['manifest.json', mockResponse('{}')],
  ]);
  await assert.rejects(loadAndInstall(env, fetch), /no JS asset reference/i);
  assert.equal(env.skipWaitingCalls.length, 0);
  assert.ok(env.deletedCaches.includes(CACHE_NAME));
});

/* ── Test 11: CSS reference absent ───────────────────────────── */
await check('11: HTML with no CSS reference → install fails; cache deleted', async () => {
  const noCssHtml = `<!DOCTYPE html><html><head></head><body>
<script type="module" src="${JS_PATH}"></script>
</body></html>`;
  const env = makeEnv();
  const fetch = makeFetch([
    ['index.html',    mockResponse(noCssHtml)],
    ['manifest.json', mockResponse('{}')],
  ]);
  await assert.rejects(loadAndInstall(env, fetch), /no CSS asset reference/i);
  assert.equal(env.skipWaitingCalls.length, 0);
  assert.ok(env.deletedCaches.includes(CACHE_NAME));
});

/* ── Test 12: Ambiguous JS references ────────────────────────── */
await check('12: two JS references in HTML → install fails (ambiguous)', async () => {
  const ambigHtml = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="${CSS_PATH}">
</head><body>
<script src="/assets/index-aaa111.js"></script>
<script src="/assets/index-bbb222.js"></script>
</body></html>`;
  const env = makeEnv();
  const fetch = makeFetch([['index.html', mockResponse(ambigHtml)]]);
  await assert.rejects(loadAndInstall(env, fetch), /ambiguous JS/i);
  assert.equal(env.skipWaitingCalls.length, 0);
  assert.ok(env.deletedCaches.includes(CACHE_NAME));
});

/* ── Test 13: Partial write failure — full cleanup ───────────── */
await check('13: partial cache.put failure → entire new cache deleted; existing cache untouched', async () => {
  const env = makeEnv();
  env.putsByCache[OLD_CACHE_NAME] = ['./index.html']; // pre-existing cache
  let putCount = 0;
  const origOpen = env.caches.open.bind(env.caches);
  env.caches.open = async (name) => {
    const c = await origOpen(name);
    const origPut = c.put.bind(c);
    c.put = async (req, res) => {
      putCount++;
      if (putCount === 2) throw new Error('write failed at put 2');
      return origPut(req, res);
    };
    return c;
  };
  await assert.rejects(loadAndInstall(env, defaultFetch()));
  assert.ok(env.deletedCaches.includes(CACHE_NAME),
    'new cache must be fully deleted after partial write failure');
  assert.ok(!env.deletedCaches.includes(OLD_CACHE_NAME),
    'an existing cache must remain intact');
  assert.equal(env.skipWaitingCalls.length, 0,
    'skipWaiting must not be called after failed install');
});

/* ── Tests 14–16: exact generated asset-path preservation ─────── */
for (const [number, label, jsPath, cssPath] of [
  ['14', 'rooted', '/assets/index-root123.js', '/assets/index-root456.css'],
  ['15', 'relative', './assets/index-relative123.js', './assets/index-relative456.css'],
  ['16', 'base-prefixed', '/home-tasks/assets/index-prefix123.js', '/home-tasks/assets/index-prefix456.css'],
]) {
  await check(`${number}: ${label} generated paths are fetched and cached exactly`, async () => {
    const env = makeEnv();
    const fetch = makeFetch([
      ['index.html', mockResponse(htmlFor(jsPath, cssPath))],
      ['manifest.json', mockResponse('{}')],
      [jsPath, mockResponse('// js bundle')],
      [cssPath, mockResponse('/* css */')],
    ]);
    await loadAndInstall(env, fetch);
    assert.deepEqual(env.putsByCache[CACHE_NAME], [
      './index.html', './manifest.json', jsPath, cssPath,
    ], 'cache keys must preserve the exact Vite-generated paths');
  });
}

/* ── Results ──────────────────────────────────────────────────── */
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
