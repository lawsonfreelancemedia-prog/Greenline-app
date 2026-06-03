// ═══════════════════════════════════════════════════════════════
// Greenline App — Service Worker
// Caches all assets for fully offline use on iPads & tablets
// Version: bump this string to force a cache refresh on all devices
// ═══════════════════════════════════════════════════════════════
const CACHE_VERSION = 'greenline-v2';
const CACHE_NAME    = CACHE_VERSION;

// ── STATIC SHELL — always cached on install ─────────────────────
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
];

// ── RUNTIME CACHE PATTERNS ──────────────────────────────────────
const CACHE_PATTERNS = [
  /\.(glb|gltf|stl)$/i,                    // 3D models
  /\.(pdf)$/i,                               // Brochures
  /\.(mp4|webm|ogv|mov)$/i,                 // Videos
  /\.(jpg|jpeg|png|webp|gif|avif|svg)$/i,   // Gallery images
  /fonts\.googleapis\.com/,                  // Google Fonts CSS
  /fonts\.gstatic\.com/,                     // Google Fonts files
  /unpkg\.com\/three/,                       // Three.js CDN
  /cdnjs\.cloudflare\.com/,                  // PDF.js CDN
];

// ── INSTALL: cache the shell ─────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Shell cache failed:', err))
  );
});

// ── ACTIVATE: delete old caches ──────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Skip non-GET, extensions, blobs
  if (event.request.method !== 'GET') return;
  if (url.startsWith('chrome-extension://')) return;
  if (url.startsWith('blob:') || url.startsWith('data:')) return;

  const isVideo = /\.(mp4|webm|ogv|mov)$/i.test(url);
  const shouldCache = CACHE_PATTERNS.some(p => p.test(url));

  if (isVideo) {
    // ── VIDEO: range-request aware caching ──────────────────────
    // Chrome always requests video with Range headers (206 responses).
    // We must fetch the FULL file (without Range header) to cache it,
    // then serve byte ranges from the cached full response ourselves.
    event.respondWith(handleVideoRequest(event.request));
  } else if (shouldCache) {
    // ── OTHER ASSETS: cache-first ────────────────────────────────
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response && response.status === 200 && response.type !== 'opaque') {
            cache.put(event.request, response.clone());
            // Notify app that an asset was cached
            self.clients.matchAll().then(clients =>
              clients.forEach(c => c.postMessage({ type: 'ASSET_CACHED', url }))
            );
          }
          return response;
        } catch (err) {
          console.warn('[SW] Fetch failed (offline?):', url);
          throw err;
        }
      })
    );
  } else {
    // ── HTML / NAVIGATION: network-first, cache fallback ─────────
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
});

// ── VIDEO RANGE REQUEST HANDLER ──────────────────────────────────
// Stores the full video in cache keyed by URL (no Range header).
// Serves byte-range slices from the cached ArrayBuffer so Chrome
// can seek freely without hitting the network again.
async function handleVideoRequest(request) {
  const cache     = await caches.open(CACHE_NAME);
  const cacheKey  = new Request(request.url); // key without Range header
  const cached    = await cache.match(cacheKey);

  // If we have the full file cached, serve the requested range from it
  if (cached) {
    return serveRangeFromCache(cached, request);
  }

  // Not cached yet — fetch the full file (drop Range header so server
  // sends 200 with full content, which we can then cache)
  try {
    const fullRequest = new Request(request.url, {
      headers: { 'Accept': request.headers.get('Accept') || '*/*' },
      mode:    'cors',
      credentials: request.credentials,
    });
    const networkResponse = await fetch(fullRequest);

    // Only cache a clean 200 full response
    if (networkResponse && networkResponse.status === 200) {
      cache.put(cacheKey, networkResponse.clone());
      // Notify all open clients that a video was cached
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({
          type: 'VIDEO_CACHED',
          url:  request.url
        }));
      });
    }

    // If original request had a Range header, slice the response
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader && networkResponse.status === 200) {
      return serveRangeFromResponse(networkResponse, rangeHeader);
    }

    return networkResponse;
  } catch (err) {
    console.warn('[SW] Video fetch failed (offline?):', request.url);
    throw err;
  }
}

// Slice a range out of a cached Response
async function serveRangeFromCache(cachedResponse, originalRequest) {
  const rangeHeader = originalRequest.headers.get('Range');
  if (!rangeHeader) return cachedResponse;
  return serveRangeFromResponse(cachedResponse, rangeHeader);
}

async function serveRangeFromResponse(response, rangeHeader) {
  const arrayBuffer = await response.clone().arrayBuffer();
  const totalLength = arrayBuffer.byteLength;

  // Parse "bytes=start-end"
  const [, rangeSpec] = rangeHeader.split('=');
  const [startStr, endStr] = rangeSpec.split('-');
  const start = parseInt(startStr, 10) || 0;
  const end   = endStr ? parseInt(endStr, 10) : totalLength - 1;
  const slicedEnd = Math.min(end, totalLength - 1);
  const length    = slicedEnd - start + 1;

  const sliced = arrayBuffer.slice(start, slicedEnd + 1);
  const contentType = response.headers.get('Content-Type') || 'video/mp4';

  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type':  contentType,
      'Content-Length': String(length),
      'Content-Range': `bytes ${start}-${slicedEnd}/${totalLength}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
