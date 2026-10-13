// sw — the service worker that makes Futbol Lab installable (Chrome's "Install app") and lets it
// open without a network.
//
// Rules it lives by:
//   · only same-origin GETs are touched. Firestore, the Google auth frames, the gstatic SDK and the
//     Vercel live functions go straight to the network, uncached — a cached slate would be exactly
//     the staleness we are trying to fix.
//   · the app shell is cache-first but revalidated in the background, so a new deploy lands on the
//     next load rather than being pinned forever.
//   · a navigation falls back to the cached shell only when the network fails, so being offline
//     shows the app (with whatever Firestore cached) instead of the browser's dinosaur.
// CACHE is stamped by web/build.mjs with the build id, so every deploy gets a fresh cache and the
// old one is deleted on activate.
const CACHE = "futbol-__BUILD__";
const SHELL = ["./", "./index.html", "./style.css", "./web.css", "./renderer.js", "./wc.js", "./site-config.js", "./firebase-config.js", "./icon.png", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Firestore, auth, the live API: never cached
  if (url.pathname.startsWith("/api/")) return;             // the live functions on the Vercel copy
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html").then((r) => r || caches.match("./"))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
