const PREFIX = 'commute-lingo-shell-';
const VERSION = '0.2.8';
const CACHE = `${PREFIX}${VERSION}-r1`;
const ASSETS = ['./', `./?v=${VERSION}`, './index.html', './icon.svg',
  ...['journey', 'dialogue', 'sunrise'].flatMap(name => [`./icon-${name}.svg`, `./icon-${name}-192.png`, `./icon-${name}-512.png`, `./manifest-${name}.webmanifest?v=${VERSION}`]),
  ...['styles.css', 'app.mjs', 'core.mjs', 'storage.mjs', 'translation.mjs', 'transcriber.mjs', 'asr.mjs', 'decode.mjs', 'decoder.mjs', 'library.mjs', 'source.mjs', 'network.mjs', 'icons.mjs', 'gestures.mjs', 'subtitles.mjs', 'backup.mjs', 'manifest.webmanifest'].map(name => `./${name}?v=${VERSION}`)];
const allowed = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try { await (await caches.open(CACHE)).addAll(ASSETS); }
    catch (error) { await caches.delete(CACHE); throw error; }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !allowed.has(event.request.url)) return;
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(event.request);
    return cached || fetch(event.request);
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_VERSION') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const ready = (await Promise.all(ASSETS.map(asset => cache.match(new URL(asset, self.registration.scope).href)))).every(Boolean);
    event.ports[0]?.postMessage({ version: VERSION, ready });
  })());
});
