/**
 * VENI service worker — минимальный stale-while-revalidate.
 *
 * Обновление: меняем CACHE_VERSION при каждом релизе, старые кэши
 * автоматически вычищаются в `activate`. На первом обращении тянет
 * из сети и сохраняет; следующее обращение отдаёт кэш и обновляет
 * фоном — поэтому юзер не ждёт сети, а получает свежее на след. визите.
 */
const CACHE_VERSION = "veni-v4";

// Базовый scope — директория где зарегистрирован SW. На корневом
// домене это "/", на subpath (типа GitHub Pages /veni-hub/) — "/veni-hub/".
const SCOPE = new URL("./", self.location).pathname;
const APP_SHELL = [SCOPE, SCOPE + "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_VERSION)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Не кэшируем API-вызовы и сторонние домены
  if (url.pathname.includes("/api/")) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
