/* The World Between Two Frames — offline service worker.
 * Generated at build time from pwa/sw.js by vite.config.ts; do not edit dist/sw.js. */
const CACHE_VERSION = '__CACHE_VERSION__';
const BUILD_TIME = '__BUILD_TIME__';
const CACHE_NAME = `twbtf-${CACHE_VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('twbtf-') && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ cache: CACHE_NAME, built: BUILD_TIME });
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Network first so a fresh deploy shows up; fall back to the cached shell offline.
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          void cache.put('index.html', response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('index.html', { ignoreVary: true })) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Hashed assets and artwork: cache first, then network (and remember it).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') void cache.put(request, response.clone());
    return response;
  })());
});
