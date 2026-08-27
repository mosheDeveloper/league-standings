const CACHE = "sprint-max-v9";
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
  "./js/simulator.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./data/tables.json",
  "./data/auth.json",
  "./data/records.json",
  "./data/football-stars.json",
  "./data/premier-league.json",
  "./data/athletics.json",
  "./data/nba.json",
  "./data/israeli-football.json",
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

  // App shell: network-first so sport/league/team UI updates aren't stuck on old cache.
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
