const CACHE = "rfi-daily-v1";
const OFFLINE_URLS = [
  "/rfi-daily/",
  "/rfi-daily/index.html",
  "/rfi-daily/data/today.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.url.includes("today.json")) {
    // today.json 永遠先嘗試網路（取最新內容），失敗才用快取
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // 其他資源：有快取就用快取
    e.respondWith(
      caches.match(e.request).then((r) => r || fetch(e.request))
    );
  }
});
