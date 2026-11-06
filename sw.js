const CACHE_NAME = 'munjiz-pwa-v10';
const CDN_CACHE_NAME = 'munjiz-cdn-v10';

const CORE_ASSETS = [
  './',
  './index.html',
  './munjiz_gtd.html',
  './manifest.json'
];

const OPTIONAL_ASSETS = [
  './icon.svg',
  'https://cdn.tailwindcss.com/3.4.17',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700;800&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each asset resiliently so a missing optional file (like icon.svg or munjiz_gtd.html vs index.html) never breaks installation
      await Promise.allSettled(
        CORE_ASSETS.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => {
              if (res && res.ok) return cache.put(url, res);
            })
            .catch(() => {})
        )
      );
      await Promise.allSettled(
        OPTIONAL_ASSETS.map((url) =>
          fetch(url)
            .then((res) => {
              if (res && (res.ok || res.type === 'opaque')) return cache.put(url, res);
            })
            .catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== CDN_CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Background Sync listener to trigger offline queue flush when internet returns
self.addEventListener('sync', (event) => {
  if (event.tag === 'munjiz-offline-sync') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'FLUSH_OFFLINE_SYNC_QUEUE' });
        });
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // CRITICAL: Never intercept or cache Google OAuth / Google Drive API calls
  if (
    url.hostname.includes('googleapis.com') && !url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('accounts.google.com') ||
    url.hostname.includes('googleusercontent.com')
  ) {
    return;
  }

  // Cache-first with background refresh for UI fonts & Tailwind CDN so the app works 100% offline
  if (
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((resp) => {
            if (resp && (resp.status === 200 || resp.type === 'opaque')) {
              const clone = resp.clone();
              caches.open(CDN_CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return resp;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Same-origin App Shell: Network-first with instant Offline Cache fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return (await caches.match('./index.html')) || (await caches.match('./munjiz_gtd.html')) || (await caches.match('./'));
          }
          return Response.error();
        })
    );
  }
});