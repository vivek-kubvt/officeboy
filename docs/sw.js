// App files load from the phone's cache instantly and are refreshed in the background, so a new
// release shows up on the next open. Bump CACHE on every release.
// API calls go to script.google.com (another origin) and are never cached.
const CACHE = 'officeboy-v4';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/api.js', './js/ui.js', './js/config.js', './js/platform.js', './js/push.js',
  './js/views/start.js', './js/views/today.js', './js/views/board.js', './js/views/admin.js', './js/views/calls.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const request = event.request.mode === 'navigate' ? './index.html' : event.request;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cachedResponse = await cache.match(request, { ignoreSearch: true });
    const network = fetch(event.request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cachedResponse || Response.error());
    if (cachedResponse) {
      event.waitUntil(network);
      return cachedResponse;
    }
    return network;
  })());
});

// Push from Firebase (data-only messages sent by Apps Script). Always show a notification:
// iOS stops delivering pushes to apps that receive one without showing anything.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {}
  const data = payload.data || payload;
  const title = data.title || 'OfficeBoy';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'You have a new call.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.callId ? `call-${data.callId}` : 'officeboy',
    renotify: true,
    requireInteraction: true,
    vibrate: [400, 150, 400, 150, 800],
    data: { url: data.url || './#/calls' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => w.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.focus();
      return existing.navigate(target).catch(() => {});
    }
    return self.clients.openWindow(target);
  })());
});
