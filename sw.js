// Bump this whenever a deployed file changes so clients pick up the update.
const CACHE_NAME = 'waytrace-shell-v1';

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './msal-browser.min.js',
  './icons/icon-192.png',
  './icons/icon-524.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) {
    // Refresh in the background; a failed revalidation (offline) is fine, we already have a cached copy.
    fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw e;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes (POST activities, etc.)

  const url = new URL(req.url);

  // The API is never cached – always hit the network so data stays fresh.
  // The app's own offline queue (wt_queue in localStorage) already handles
  // retrying activity uploads when the worker is unreachable.
  if (url.hostname.endsWith('.workers.dev')) return;

  // Same-origin app shell: cache-first, falling back to the cached
  // index.html for navigations so the app still boots while offline.
  if (url.origin === self.location.origin) {
    const isNavigation = req.mode === 'navigate' || url.pathname.endsWith('/index.html');
    event.respondWith(cacheFirst(req, isNavigation ? './index.html' : null));
    return;
  }

  // MapLibre's JS/CSS from unpkg: cache-first so the map library still
  // loads on a repeat offline visit (tiles themselves are not cached).
  if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(req, null));
  }

  // Everything else (OSM tiles, Microsoft login, etc.) – default browser behaviour.
});
