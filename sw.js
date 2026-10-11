// Offline support: the app shell is cached on install; everything else is network-first with a cache fallback.
const VERSION = "vp-2.1.0";
const SHELL = [
  "./", "index.html", "css/styles.css", "manifest.webmanifest",
  "js/app.js", "js/calc.js", "js/i18n.js", "js/store.js", "js/backend-local.js", "js/cloud.js", "js/firebase-config.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // never cache Firebase/Google API traffic; Firestore handles its own offline cache
  if (/googleapis\.com$|firebaseio\.com$/.test(url.hostname) && !url.hostname.startsWith("fonts.")) return;

  const cacheable = url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$|www\.gstatic\.com$/.test(url.hostname);
  if (!cacheable) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
