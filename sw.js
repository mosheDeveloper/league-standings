const CACHE = "sprint-max-v12";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/anticheat.js",
  "./js/compare.js",
  "./js/demo.js",
  "./js/tracker.js",
  "./js/store.js",
  "./js/share.js",
  "./js/auth.js",
  "./js/records.js",
  "./js/pr-progress.js",
  "./js/simulator.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./data/catalog.json",
  "./data/auth.json",
  "./data/records.json",
  "./data/leagues/athletics-stars.json",
  "./data/leagues/premier-league.json",
  "./data/leagues/la-liga.json",
  "./data/leagues/israeli-premier.json",
  "./data/leagues/football-world.json",
  "./data/leagues/nba.json",
];

function isAppShell(url) {
  const path = url.pathname;
  return (
    path.endsWith("/") ||
    path.endsWith("/index.html") ||
    path.endsWith(".js") ||
    path.endsWith(".css") ||
    path.endsWith(".webmanifest")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (isAppShell(url) || req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});
