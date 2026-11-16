const STATIC_CACHE = 'bp-static-assets-v1';

const PRECACHE_URLS = [
  '/logo.png',
  '/apoio-reference-header.svg',
  '/apoio-reference-ribbons.svg',
];

const API_HOST_OR_PATH_PATTERN = /(\/rest\/v1\/|\/functions\/v1\/|\/auth\/v1\/|\/storage\/v1\/|supabase\.co)/i;
const DEV_MODULE_PATTERN = /(\/@vite|\/@react-refresh|\/@fs\/|\/@id\/|\/src\/|\/node_modules\/|[?&](?:t|v)=|\.(?:ts|tsx|jsx)(?:\?|$))/i;
const STATIC_ASSET_PATTERN = /(\/logo\.png$|\/apoio-reference-.*\.svg$|\/pdf\.worker\.min\.mjs$|\/assets\/|\/equipamentos\/|\/equipment-types\/|\.(?:png|svg|webp|jpg|jpeg|ico|woff2?|ttf|css)(?:\?|$))/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('bp-static-assets-') && key !== STATIC_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!request || request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const fullUrl = url.href;
  const pathWithSearch = `${url.pathname}${url.search}`;

  // Nunca interceptar Supabase, APIs dinâmicas ou módulos de desenvolvimento Vite.
  if (API_HOST_OR_PATH_PATTERN.test(fullUrl) || DEV_MODULE_PATTERN.test(pathWithSearch)) {
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isGoogleFont =
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isStaticAsset =
    (isSameOrigin && STATIC_ASSET_PATTERN.test(url.pathname)) || isGoogleFont;

  if (!isStaticAsset) return;

  // Cache-First para ativos estáticos e logotipo da empresa (latência zero e sem re-download).
  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      const networkResponse = await fetch(request);
      if (
        networkResponse &&
        (networkResponse.status === 200 || networkResponse.type === 'opaque')
      ) {
        cache.put(request, networkResponse.clone()).catch(() => undefined);
      }
      return networkResponse;
    })
  );
});
