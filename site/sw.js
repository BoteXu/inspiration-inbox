const CACHE = 'shinian-shell-v02';
const FILES = ['./', './index.html', './styles.css', './model.css', './app.js', './core.js', './model.js', './queue.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('message', event => { if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('shinian-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  const known = FILES.some(file => new URL(file, self.registration.scope).pathname === url.pathname);
  if (!known) return;
  // Serve one installed version consistently. A new worker activates on explicit safe refresh.
  event.respondWith(caches.open(CACHE).then(async cache => {
    const key = new URL(url.pathname, self.location.origin);
    return (await cache.match(key)) || (await fetch(event.request));
  }));
});
