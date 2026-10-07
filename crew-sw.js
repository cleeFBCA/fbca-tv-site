// Service worker for the crew guide at /crew. It keeps a copy of the page and
// its fonts on the phone so the guide still opens in the press box or on the
// sideline with no signal. Scope is /crew only; the rest of fbca.tv is untouched.
//
// The page is fetched network-first, so a crew member online always gets the
// latest guide, and the saved copy is refreshed every time. If the network
// doesn't answer within a few seconds, the saved copy is shown instead.
// Fonts change rarely, so they come from the saved copy first.

const CACHE = 'eota-crew-v3';
const PAGE = '/crew';
const PRECACHE = [PAGE, '/crew.webmanifest', '/crew-icon-192.png', '/crew-icon-512.png', '/crew-icon-maskable-512.png'];
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=Barlow:wght@400;500;600;700&display=swap';
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all([cache.addAll(PRECACHE), saveFonts(cache)]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('eota-crew-') && k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate' && url.origin === location.origin) {
    event.respondWith(pageNetworkFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
  } else if (url.origin === location.origin && PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
  // Everything else (analytics beacon, links off the page) goes straight to the network.
});

// The first visit loads the fonts before this worker is running, so fetch the
// stylesheet and every font file it names now. A failure here only means the
// guide falls back to system fonts offline, so it doesn't block install.
async function saveFonts(cache) {
  try {
    const res = await fetch(FONTS_CSS);
    if (!res.ok) return;
    const css = await res.clone().text();
    // One variable font file serves several weights, so the same URL repeats.
    const files = new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]));
    await cache.put(FONTS_CSS, res);
    await cache.addAll([...files]);
  } catch (e) {}
}

async function pageNetworkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then(res => {
    if (res.ok) cache.put(PAGE, res.clone());
    return res;
  });
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (e) {
    // Offline: fall through to the saved copy.
  }
  const saved = await cache.match(PAGE);
  if (saved) {
    // Let a slow network response still refresh the saved copy in the background.
    network.catch(() => {});
    return saved;
  }
  return network;
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
