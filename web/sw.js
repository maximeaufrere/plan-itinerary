// Mode hors ligne : l'app (pages, code, styles, polices) est gardée sur l'appareil pour s'ouvrir sans réseau.
// Favoris, historique et réglages sont déjà dans le stockage du navigateur ; seuls le calcul de nouveaux
// parcours (OpenRouteService), la recherche d'adresse et les fonds de carte demandent une connexion.
//
// Stratégie : réseau d'abord (on a toujours la dernière version publiée), copie locale si le réseau manque.

const VERSION = 'dev'; // remplacé à chaque publication (scripts/version-assets.sh)
const CACHE = `plan-itineraire-${VERSION}`;

const APP_FILES = [
  './',
  'index.html',
  'aide.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-512.png',
  'js/account.js',
  'js/address.js',
  'js/analysis.js',
  'js/app.js',
  'js/chart.js',
  'js/cloud.js',
  'js/config.js',
  'js/criteria.js',
  'js/dom.js',
  'js/favorites.js',
  'js/format.js',
  'js/generator.js',
  'js/geo.js',
  'js/geocode.js',
  'js/gpx.js',
  'js/icons.js',
  'js/labels.js',
  'js/layers.js',
  'js/library.js',
  'js/onboarding.js',
  'js/ors.js',
  'js/planner.js',
  'js/settings.js',
  'js/share-link.js',
  'js/share.js',
  'js/storage.js',
  'js/sync.js',
  'js/terrain.js',
  'js/thumbnail.js',
  'js/views.js',
  'vendor/fonts/bricolage-grotesque-latin-wght-normal.woff2',
  'vendor/fonts/manrope-latin-wght-normal.woff2',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/supabase/supabase.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('plan-itineraire-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Seulement les fichiers de l'app : les API et les fonds de carte passent directement.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        // Hors ligne : même fichier, quel que soit son numéro de version (?v=…) ; une page → l'app.
        const cached = (await caches.match(request)) ?? (await caches.match(request, { ignoreSearch: true }));
        if (cached) return cached;
        if (request.mode === 'navigate') return (await caches.match('index.html', { ignoreSearch: true })) ?? Response.error();
        return Response.error();
      }),
  );
});
