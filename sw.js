/* Service worker: app shell + a persistent data cache for the big corpus.
 *
 * Why two caches:
 *  - SHELL is versioned and wiped on every release (small html/css/js).
 *  - DATA holds the large corpus.js (~10MB). It is cached on demand and is NEVER
 *    wiped on a version bump, so reading content survives app updates and does not
 *    need to be re-downloaded every release (which previously caused "阅读为空"
 *    whenever a bump landed while the network was flaky/offline).
 */
const SHELL = "vt-shell-v45";
const DATA = "vt-data-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./grammar.js",
  "./phrases.js",
  "./dialogues.js",
  "./samples.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];
// Large, slow-changing data files kept in the persistent DATA cache.
const isData = (url) => /\/corpus\.js(\?|$)/.test(url) || /\/audio\/.*\.(m4a|mp3|opus|aac)(\?|$)/.test(url);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      // Keep the current shell and the persistent data cache; drop everything else.
      Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  const cacheName = isData(req.url) ? DATA : SHELL;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && sameOrigin) {
            const copy = res.clone();
            caches.open(cacheName).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
