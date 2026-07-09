// Minimal service worker – csak a telepíthetőséghez kell.
// Élő hívás miatt szándékosan NEM cache-eli agresszívan a tartalmat,
// hogy mindig a legfrissebb verzió töltődjön be.
const CACHE_NAME = 'forditohivas-v1';
const CORE_ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first, hogy a hívás logika mindig friss legyen; cache csak fallback offline esetén.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
