const CACHE_NAME = "forditohivas-v4";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS).catch((err) => {
        // Ha valamelyik ikon hiányzik, ne akadályozza az installálást
        console.warn("SW: Egyes fájlok nem cache-elhetők:", err);
      });
    })
  );
  // Azonnal aktívvá válik, nem vár a régi SW leállására
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  // Azonnal átveszi az irányítást minden kliens felett
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // POST, stb. kéréseket átengedi (Supabase Realtime WebSocket)
  if (event.request.method !== "GET") return;

  // WebSocket kéréseket nem kezeli a SW
  if (event.request.url.startsWith("wss://") || event.request.url.startsWith("ws://")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Csak érvényes, alap GET válaszokat cache-elünk
        if (
          response &&
          response.status === 200 &&
          response.type === "basic"
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Offline fallback: cache-ből szolgál ki
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Ha az index.html sem érhető el, üres 503-at ad vissza
          return new Response("Offline – nincs gyorsítótárazott tartalom.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        });
      })
  );
});
