/* ================================================================
   HomeTask — Service Worker  ·  Cache: hometask-v22-f1

   Strategy:
     install         → atomic: fetch index.html, extract exactly one
                        hashed JS and one hashed CSS reference, fetch
                        all critical assets, write all sequentially,
                         preserving the generated asset paths, then await
                         skipWaiting().
                        If any fetch or write fails the incomplete new
                         cache is deleted and installation fails, leaving
                         the previous cache fully intact for offline use.
     navigate        → network-first; offline fallback to cached shell
     static assets   → cache-first (versioned by cache name bump)
   ================================================================ */

const CACHE = 'hometask-v22-f1';

/* ── Install — critical-asset caching with failure cleanup ───── */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // All assets must be fetched and written before skipWaiting is called.
    // On any failure the catch block deletes the incomplete new cache and
    // re-throws, causing event.waitUntil to reject and install to fail.
    // Existing caches are never touched during install.
    // NOTE: sequential cache.put() calls are NOT atomic — partial-write
    // failures are handled by deleting the entire new cache in the catch.
    try {
      /* Step 1: Fetch index.html (no-store forces a fresh copy). */
      const htmlRes = await fetch(new Request('./index.html', { cache: 'no-store' }));
      if (!htmlRes.ok) throw new Error(`index.html: ${htmlRes.status}`);
      const html = await htmlRes.clone().text();

       /* Step 2: Require exactly one hashed JS reference and one CSS reference.
          Capture the complete generated attribute value so Vite bases such as
          '/', './', or '/home-tasks/' are fetched and cached exactly as emitted.
          Install fails when a reference is absent or ambiguous. */
       const jsMatches = [...html.matchAll(
         /<script\b[^>]*\bsrc=(["'])((?:[^"'<>]*\/)?assets\/index-[A-Za-z0-9_-]+\.js)\1[^>]*>/gi
       )];
       const cssMatches = [...html.matchAll(
         /<link\b[^>]*\bhref=(["'])((?:[^"'<>]*\/)?assets\/index-[A-Za-z0-9_-]+\.css)\1[^>]*>/gi
       )];
      if (jsMatches.length  === 0) throw new Error('install: no JS asset reference in index.html');
      if (cssMatches.length === 0) throw new Error('install: no CSS asset reference in index.html');
      if (jsMatches.length  >   1) throw new Error('install: ambiguous JS asset references in index.html');
      if (cssMatches.length >   1) throw new Error('install: ambiguous CSS asset references in index.html');
       const jsPath  = jsMatches[0][2];
       const cssPath = cssMatches[0][2];

      /* Step 3: Fetch remaining critical assets. */
      const manifestRes = await fetch(new Request('./manifest.json', { cache: 'no-store' }));
      if (!manifestRes.ok) throw new Error(`manifest.json: ${manifestRes.status}`);
      const jsRes = await fetch(new Request(jsPath, { cache: 'no-store' }));
      if (!jsRes.ok) throw new Error(`${jsPath}: ${jsRes.status}`);
      const cssRes = await fetch(new Request(cssPath, { cache: 'no-store' }));
      if (!cssRes.ok) throw new Error(`${cssPath}: ${cssRes.status}`);

      /* Step 4: Write to new cache sequentially.
         Any write failure triggers cleanup in the catch block. */
      const cache = await caches.open(CACHE);
      await cache.put(new Request('./index.html'),    htmlRes);
      await cache.put(new Request('./manifest.json'), manifestRes);
      await cache.put(new Request(jsPath),            jsRes);
      await cache.put(new Request(cssPath),           cssRes);

      /* Step 5: All assets written — now safe to activate. */
      await self.skipWaiting();
    } catch (err) {
       /* Delete any partial writes to the new cache.
          Existing caches are not touched; they remain intact for offline use. */
      await caches.delete(CACHE);
      throw err;  // re-throw: event.waitUntil rejects, install fails
    }
  })());
});

/* ── Activate — evict obsolete caches ────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();   // take control of all open tabs immediately
});

/* ── Fetch ────────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  /*
   * Navigation requests (HTML pages): network-first.
   * Fresh HTML is fetched on every navigate so a newly deployed build
   * immediately delivers updated markup, JS bundle references, and CSS.
   * If the network is unavailable, the cached shell is returned.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match('./index.html').then(r => r || new Response('Offline', { status: 503 }))
        )
    );
    return;
  }

  /*
   * Static assets (JS bundles, CSS, manifest, icons): cache-first.
   * Vite-built JS has content-addressed filenames ([hash].js) so a cache
   * hit is always correct; stale entries from prior builds are evicted when
   * CACHE version is bumped on activate. Unknown assets fall through to
   * network and are opportunistically cached.
   */
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      });
    })
  );
});

/* ── Push notifications (stub — no server yet) ───────────────── */
self.addEventListener('push', event => {
  const data = event.data?.json() ?? { title: 'HomeTask', body: 'You have tasks due.' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body, icon: './icon-192.png', tag: 'hometask',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const c = clients.find(w => w.focus);
      return c ? c.focus() : self.clients.openWindow('./');
    })
  );
});
