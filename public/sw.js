// Service Worker: App sofort starten (auch offline) und zuletzt geladene
// Daten zeigen, wenn der Server nicht erreichbar ist.

const VERSION = 'ffd-43';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const MAX_DATA_ENTRIES = 400;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(['./', 'index.html', 'styles.css', 'vendor/chart.umd.js', 'favicon.svg', 'manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_DATA_ENTRIES))) await cache.delete(key);
}

/** Daten: erst Netz, bei Fehler/Offline die gespeicherte Antwort (markiert). */
async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request);
    if (response.ok && !request.headers.get('x-no-cache')) {
      cache.put(request, response.clone()).then(() => trim(cache));
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set('X-FFD-Offline', '1');
    return new Response(await cached.blob(), { status: cached.status, headers });
  }
}

/** Oberfläche: sofort aus dem Speicher, im Hintergrund aktualisieren. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  const update = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  return cached || update;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/login' || url.pathname === '/logout') return; // Anmeldung immer direkt vom Server
  if (url.pathname.startsWith('/local/csvarchive/file/')) return; // große Dateien: nur Browser-Cache (unveränderlich)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/local/')) {
    if (url.pathname === '/local/stats') return;
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
