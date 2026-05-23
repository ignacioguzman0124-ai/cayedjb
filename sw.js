/* sw.js — Service Worker de CayeDJB (PWA).
 * Estrategia:
 *   • mismo origen, HTML/JS/CSS  → cache-first (sirve de cache; si no está, red + cachea).
 *   • gstatic / firebase / cdnjs / cualquier cross-origin → network-only (nunca se cachea).
 * Cache versionada: subir el sufijo de CACHE invalida todo; la vieja se borra en 'activate'.
 * Así actualizamos la app subiendo 'cayedjb-v5-001' → 'cayedjb-v5-002', etc.
 */
const CACHE = 'cayedjb-v5-001';
const PRECACHE = ['./', './index.html', './firebase-config.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo GET del propio origen entra en cache. El resto (gstatic, firebase,
  // cdnjs, google fonts…) se deja pasar a la red sin tocar (network-only).
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Cache-first solo para documentos/scripts/estilos del propio dominio.
  const isAsset = req.mode === 'navigate'
    || ['document', 'script', 'style'].includes(req.destination)
    || /\.(?:html|js|css)$/.test(url.pathname);
  if (!isAsset) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;                       // cache-first
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  })());
});
