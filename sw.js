// ════════════════════════════════════════════════════════════════════════════
// Jel’ vakat? by Divan — Service Worker
// ────────────────────────────────────────────────────────────────────────────
// Strategija:
//   - App shell (HTML/manifest/ikone): network-first sa fallback na cache
//     → korisnik uvijek dobija svježu verziju kad ima internet
//     → ako je offline, app i dalje radi iz keša
//   - Statički asseti (fonts, ikone): cache-first
//     → brže učitavanje, manje mreže
//   - API pozivi (open-meteo, nominatim): network-only
//     → uvijek svježi podaci, nikada keš
//
// Verzija keša se mijenja sa svakom novom verzijom app-a. Stari keš se briše.
// ════════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'jv-v3.0.0';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Fajlovi koji se pre-keširaju pri instalaciji
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Lokalni fontovi — pre-keširaju se pri instalaciji, posluživani cache-first
const FONT_ASSETS = [
  './fonts/cormorant-garamond-latin.woff2',
  './fonts/cormorant-garamond-latin-ext.woff2',
  './fonts/amiri-400-latin.woff2',
  './fonts/amiri-400-latin-ext.woff2'
];

// API hostovi koji se NIKADA ne keširaju
const API_HOSTS = [
  'api.open-meteo.com',
  'nominatim.openstreetmap.org'
];

// ── INSTALL ─────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(cache => cache.addAll([...APP_SHELL, ...FONT_ASSETS]))
  );
  // Aktiviraj odmah, ne čekaj na zatvaranje svih tabova
  self.skipWaiting();
});

// ── ACTIVATE ────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k !== APP_SHELL_CACHE && k !== RUNTIME_CACHE)
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. API pozivi → uvijek mreža, nikada keš
  if (API_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    return;  // ne perehvatamo, browser zove direktno
  }

  // 2. App shell (HTML, manifest) → network-first, fallback na keš
  const isShell = APP_SHELL.some(s => url.pathname.endsWith(s.replace('./', '/')) ||
                                      url.pathname === '/' ||
                                      url.pathname.endsWith('/index.html'));
  if (isShell || url.pathname === '/' || req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  // 3. Sve ostalo (fonts, ikone) → cache-first
  event.respondWith(cacheFirst(req));
});

// ── STRATEGIJE ──────────────────────────────────────────────────────────────
async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(APP_SHELL_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Fallback ako ni keš nema
    return new Response('Offline. App je dostupna kad imaš internet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (e) {
    return new Response('', { status: 503 });
  }
}
