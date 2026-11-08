// ════════════════════════════════════════════════════════════════════════════
// Jel’ vakat? by Divan — Service Worker
// ────────────────────────────────────────────────────────────────────────────
// Strategija:
//   - App shell (HTML/manifest/ikone): stale-while-revalidate (od v3.11.0)
//     → keš odgovara ODMAH, mreža osvježava keš u pozadini
//     → nova verzija stiže kroz novi sw.js (CACHE_VERSION) i controllerchange
//       reload u index.html, najkasnije pri sljedećem otvaranju
//     → ako je offline, app i dalje radi iz keša
//     Do v3.10.4 bilo je network-first BEZ timeouta: izmjereno 08.11.2026. da na
//     Slow 4G topao keš ne skraćuje ništa (prvi prikaz 1,3 s hladan i topao), a na
//     „lie-fi“ vezi korisnik s punim kešom gleda prazan ekran dok mreža ne odgovori
//     (25 s u probi). Mjerni harness: scratchpad tehnika/mjerenje.mjs.
//   - Statički asseti (fonts, ikone): cache-first
//     → brže učitavanje, manje mreže
//   - API pozivi (open-meteo, nominatim): network-only
//     → uvijek svježi podaci, nikada keš
//
// Verzija keša se mijenja sa svakom novom verzijom app-a. Stari keš se briše.
// ════════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'jv-v3.11.1';
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
  './fonts/inter-400-latin.woff2',
  './fonts/inter-400-latin-ext.woff2',
  './fonts/inter-500-latin.woff2',
  './fonts/inter-500-latin-ext.woff2',
  './fonts/inter-600-latin.woff2',
  './fonts/inter-600-latin-ext.woff2'
];

// API hostovi koji se NIKADA ne keširaju
const API_HOSTS = [
  'api.open-meteo.com',
  'nominatim.openstreetmap.org'
];

// ── INSTALL ─────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  // v3.11.0: `cache:'reload'` zaobilazi HTTP keš preglednika (GitHub Pages šalje
  // max-age=600), da novi radnik ne pokupi STARI index.html i tako „instalira“ staro.
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(cache =>
      cache.addAll([...APP_SHELL, ...FONT_ASSETS].map(u => new Request(u, { cache: 'reload' })))
    )
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
    event.respondWith(kesPaMreza(event, req));
    return;
  }

  // 3. Sve ostalo (fonts, ikone) → cache-first
  event.respondWith(cacheFirst(req));
});

// ── STRATEGIJE ──────────────────────────────────────────────────────────────

// ⚠ v3.6.9 (audit 04.08.2026.) — NAVIGACIJA SE KEŠIRA BEZ QUERY STRINGA.
//
// Ranije se keširalo pod PUNIM URL-om, a čitalo bez `ignoreSearch`. Posljedica:
// link podijeljen preko WhatsAppa ili Facebooka dolazi kao `/?fbclid=...`, pa je
// taj korisnik OFFLINE dobijao golu poruku o grešci iako je cijela app keširana
// pod `/`. Za app za namaska vremena offline put je upravo onaj koji je bitan.
// Uz to je svaki različit query trajno dodavao novu kopiju app-e u keš (~310 KB),
// pa je keš neograničeno rastao do izbacivanja cijelog origina iz kvote.
//
// Sada: ključ je uvijek origin + putanja, a čitanje ide s `ignoreSearch`.
// TEST_MODE parametri (`?lat=&lng=&time=`) i dalje rade — oni se čitaju u
// aplikaciji iz stvarnog URL-a, keš samo poslužuje isti app shell.
function kljucBezUpita(req) {
  const url = new URL(req.url);
  return new Request(url.origin + url.pathname, { method: 'GET' });
}

// v3.11.0: STALE-WHILE-REVALIDATE za app shell (zamijenio networkFirst).
// Keš odgovara odmah; mreža ide u pozadini s `cache:'no-cache'` (uvijek do servera,
// ne do HTTP keša preglednika) i osvježava keš za sljedeće otvaranje. Nova VERZIJA
// ne zavisi od ovog puta: preglednik pri navigaciji provjerava sw.js, promijenjen
// CACHE_VERSION instalira novog radnika s novim kešom, a controllerchange u
// index.html osvježi stranicu čim ode u pozadinu. Bez keša (prvo otvaranje) čeka se
// mreža, a bez mreže ostaje ista offline poruka kao prije.
async function kesPaMreza(event, req) {
  const cache = await caches.open(APP_SHELL_CACHE);
  const kljuc = kljucBezUpita(req);
  const cached = await cache.match(kljuc, { ignoreSearch: true });
  const osvjezi = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    .then(fresh => {
      if (fresh && fresh.status === 200) return cache.put(kljuc, fresh.clone()).then(() => fresh);
      return fresh;
    });
  if (cached) {
    event.waitUntil(osvjezi.catch(() => {}));
    return cached;
  }
  try {
    return await osvjezi;
  } catch (e) {
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
