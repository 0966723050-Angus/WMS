var CACHE_NAME = "wms-cache-v29";
var CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./config.js",
  "./app.js",
  "./manifest.json",
  "./data.enc",
  "./vendor/xlsx.full.min.js",
  "./vendor/pako_inflate.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/atk-logo.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(CORE_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  // 只處理本站檔案;儲位編輯的儲存服務(跨網域)一律直接連線,不快取
  if (new URL(event.request.url).origin !== self.location.origin) return;

  // data.enc 每次都帶 ?_=時間 參數,快取時去掉參數存成同一份,避免快取越積越多
  var url = new URL(event.request.url);
  var cacheKey = /\/data\.enc$/.test(url.pathname) ? url.origin + url.pathname : event.request;

  event.respondWith(
    // cache:"no-cache" = 每次都向伺服器確認檔案有沒有更新(沒變時只回 304,很快),
    // 避開 GitHub Pages 的 10 分鐘瀏覽器快取,發布後使用者馬上拿到新版
    fetch(event.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(cacheKey, copy); });
        return response;
      })
      .catch(function () {
        return caches.match(cacheKey).then(function (cached) {
          return cached || caches.match("./index.html");
        });
      })
  );
});
