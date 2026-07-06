// Service worker: offline-first app shell cache.
//
// WICHTIG: Der Service Worker verwaltet ausschließlich den CODE-Cache (HTML/CSS/JS/
// Icons). Beim Aktivieren einer neuen Version werden nur ALTE CODE-CACHES gelöscht –
// niemals der localStorage. Die Nutzerdaten (Übungen, Trainings, Verlauf, laufendes
// Training, Fortschritt) liegen im localStorage und bleiben bei Updates unangetastet.
const CACHE = 'kraft-v6';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './beep.wav',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Cache-first with network fallback; update cache in background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
