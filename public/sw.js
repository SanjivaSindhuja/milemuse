// MileMuse service worker - cache-first so a downloaded route plays with no signal.
const CACHE = "milemuse-v1";
const CORE = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./geo.js",
  "./manifest.json",
  "./route.json",
  "./app.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE).catch(() => {});
      // Also pre-cache every audio clip listed in the manifest.
      try {
        const m = await (await fetch("./manifest.json", { cache: "no-store" })).json();
        await cache.addAll((m.clips || []).map((c) => "./" + c.audio)).catch(() => {});
      } catch {}
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(e.request);
        if (res && res.status === 200 && res.type === "basic") {
          const cache = await caches.open(CACHE);
          cache.put(e.request, res.clone()).catch(() => {});
        }
        return res;
      } catch {
        return cached || Response.error();
      }
    })()
  );
});
