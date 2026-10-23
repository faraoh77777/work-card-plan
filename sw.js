/* 공제플랜 서비스워커: 인터넷이 없을 때도 앱 화면이 열리게 합니다.
   화면(index.html)은 항상 인터넷에서 먼저 받고(예전 화면이 남지 않게), 안 되면 저장해 둔 사본을 씁니다.
   같은 주소의 GET 요청만 다루고, 다른 주소(SheetJS cdnjs 등)는 건드리지 않습니다.
   파일을 바꿔 배포할 때는 SW_VERSION을 올립니다. */
const SW_VERSION = '2026-10-23-12';
const CACHE = 'card-plan-' + SW_VERSION;
const FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('card-plan-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); }
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
