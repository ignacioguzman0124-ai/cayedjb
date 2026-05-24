/* sw.js — Service Worker de CayeDJB (PWA).
 * Estrategia:
 *   • Shell del propio origen (HTML/JS/CSS) → cache-first.
 *   • CDNs que la app necesita para arrancar (Firebase SDK en gstatic, Google
 *     Fonts, SheetJS en cdnjs) → cache-first también, para que la app cargue
 *     offline. Sin esto, sin red en frío, los `import` del SDK fallarían y la
 *     app quedaría en pantalla en blanco (§3).
 *   • RPC de datos de Firestore (firestore.googleapis.com / firebaseio.com) y
 *     cualquier otro cross-origin → red directa (network-only). La persistencia
 *     offline de los DATOS la gestiona el propio SDK en IndexedDB, no el SW.
 * Cache versionada: subir el sufijo de CACHE invalida todo; la vieja se borra en
 * 'activate'. Para publicar una versión nueva: 'cayedjb-v5-002' → '...-003', etc.
 */
const CACHE = 'cayedjb-v5-002';   // ← CACHE_VERSION: súbela en cada deploy para invalidar

// Shell del propio origen: obligatorio. Si esto falla, falla el install.
const PRECACHE = ['./', './index.html', './firebase-config.js', './manifest.json'];

// CDNs a precachear best-effort (si fallan en install NO rompen la instalación;
// además se cachean en runtime la primera vez que cargan online). Las URLs del
// SDK están pinadas por versión (10.13.0): si se sube la versión, la URL cambia
// y se recachea sola.
const CDN_PRECACHE = [
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Playfair+Display:wght@600;700&display=swap'
];

// Orígenes cross-origin que SÍ cacheamos en runtime (cache-first). Ojo: NO incluir
// firestore.googleapis.com — sus respuestas son datos dinámicos y deben ir a red.
const RUNTIME_CDN = [
  'https://www.gstatic.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdnjs.cloudflare.com'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(PRECACHE);                                  // shell: crítico
    await Promise.allSettled(CDN_PRECACHE.map(u => c.add(u))); // CDNs: best-effort
    await self.skipWaiting();
  })());
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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const sameOrigin = url.origin === self.location.origin;
  const isCDN = RUNTIME_CDN.includes(url.origin);

  if (sameOrigin) {
    // Solo documentos/scripts/estilos del propio dominio entran en cache.
    const isAsset = req.mode === 'navigate'
      || ['document', 'script', 'style'].includes(req.destination)
      || /\.(?:html|js|css)$/.test(url.pathname);
    if (!isAsset) return;
  } else if (!isCDN) {
    return;   // Firestore RPC y demás cross-origin → red directa
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;                                  // cache-first
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());     // solo respuestas válidas
      return res;
    } catch (err) {
      // Offline y sin copia en cache: en navegación, sirve el shell para no
      // dejar pantalla en blanco; el resto propaga el error.
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
