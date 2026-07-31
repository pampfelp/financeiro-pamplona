const CACHE_NAME = "finpamplona-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-init.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first com fallback pro cache (abre mesmo offline/instável), mas
// NUNCA cacheia chamadas ao Firestore nem à Pluggy (precisam sempre de
// dados frescos; Firestore usa conexões de streaming de longa duração).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.endsWith("googleapis.com") || url.hostname.includes("script.google.com")) return;
  if (url.hostname.endsWith("pluggy.ai")) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
