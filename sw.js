// Caches the app shell so the booking form itself works with zero
// connectivity. Syncing still requires reaching the Macbook, but entering
// and saving an appointment never does.
const CACHE_NAME = 'afspraken-v3';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API calls - those need to always hit the network live.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    // ignoreSearch matters a lot here: the very first launch (from the
    // pairing link) carries a ?t=token query string, which the app strips
    // from the visible address afterwards - but if the home-screen icon
    // was created before that stripping happened, it can permanently
    // remember the address with the token attached. An exact-match cache
    // lookup would then never hit, silently falling through to a live
    // network request on every single launch - working fine whenever the
    // Mac happens to be reachable, and hanging with no error the moment
    // it isn't. Matching on path alone (ignoring the query string) fixes
    // that regardless of which exact address got saved.
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      // Also fall back to the cached shell if the network request itself
      // fails outright (genuinely offline, Mac unreachable, etc.) rather
      // than leaving the request to hang with no response at all.
      return fetch(event.request).catch(() => caches.match('./', { ignoreSearch: true }));
    })
  );
});
