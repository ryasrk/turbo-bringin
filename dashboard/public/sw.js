const CACHE_NAME = 'tenrary-x-v1';
const SHELL_URLS = ['/', '/index.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first for API, cache-first for static
  if (e.request.url.includes('/v1/') || e.request.url.includes('/manager/') || e.request.url.includes('/ws/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
