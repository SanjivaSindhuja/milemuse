// MileMuse service worker - cache-first so a downloaded route plays with no signal.
// Caches the app shell plus EVERY route's manifest, geometry, and audio.
const CACHE = "milemuse-v4";
const CORE = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./geo.js",
  "./app.webmanifest",
  "./icon.svg",
  "./routes.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE).catch(() => {});
      try {
        const routes = await (await fetch("./routes.json", { cache: "no-store" })).json();
        for (const r of routes) {
          const base = "./" + r.dir;
          const m = await (await fetch(base + "/manifest.json", { cache: "no-store" })).json();
          const assets = [
            base + "/manifest.json",
            base + "/route.json",
            ...(m.clips || []).map((c) => base + "/" + c.audio),
          ];
          await cache.addAll(assets).catch(() => {});
        }
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
