const CACHE_NAME = 'tenrary-x-v3';
const SHELL_URLS = ['/', '/index.html', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

function isBypassedPath(pathname) {
  return pathname.startsWith('/api/')
    || pathname.startsWith('/manager/')
    || pathname.startsWith('/v1/')
    || pathname.startsWith('/ws/');
}

function isHashedAsset(pathname) {
  // Vite hashed assets: /assets/index-BEWTAvrf.css, /assets/index-DloD6SnS.js
  return /\/assets\/[^/]+-[a-zA-Z0-9]{8}\.\w+$/.test(pathname);
}

function isStaticAsset(pathname) {
  return /\.(?:css|js|png|jpg|jpeg|svg|gif|webp|ico|woff2?)$/i.test(pathname);
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Delete ALL old caches (not just different names)
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (isBypassedPath(url.pathname)) return;

  // Navigation: ALWAYS network-first, cache fallback for offline only
  if (request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('/index.html', response.clone());
        return response;
      } catch {
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  if (!isStaticAsset(url.pathname)) return;

  // Hashed assets (Vite content-hashed filenames): cache-first is safe
  // because the hash changes when content changes
  if (isHashedAsset(url.pathname)) {
    e.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // Non-hashed static assets: NETWORK-FIRST to avoid stale content
  e.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      return cached || Response.error();
    }
  })());
});
