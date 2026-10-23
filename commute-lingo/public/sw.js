const PREFIX = 'commute-lingo-shell-';
const VERSION = '0.2.22';
const CACHE = `${PREFIX}${VERSION}-r1`;
const ASSETS = ['./', `./?v=${VERSION}`, './index.html', './icon.svg',
  ...['journey', 'dialogue', 'sunrise'].flatMap(name => [`./icon-${name}.svg`, `./icon-${name}-192.png`, `./icon-${name}-512.png`, `./manifest-${name}.webmanifest?v=${VERSION}`]),
  ...['styles.css', 'app.mjs', 'core.mjs', 'storage.mjs', 'translation.mjs', 'transcriber.mjs', 'asr.mjs', 'decode.mjs', 'decoder.mjs', 'library.mjs', 'source.mjs', 'network.mjs', 'icons.mjs', 'gestures.mjs', 'subtitles.mjs', 'backup.mjs', 'vocabulary.mjs', 'dictionary.mjs', 'manifest.webmanifest', 'updates.mjs', 'wake-lock.mjs', 'reading.mjs', 'guide.mjs', 'gemini.mjs', 'key-vault.mjs', 'guide-controller.mjs'].map(name => `./${name}?v=${VERSION}`)];
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
  // A navigation Request can retain the tab fragment (#playlist, #settings).
  // Fragments identify a view in the same document, not another HTTP asset.
  const assetURL = new URL(event.request.url);
  assetURL.hash = '';
  if (event.request.method !== 'GET' || !allowed.has(assetURL.href)) return;
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(assetURL.href);
    return cached || fetch(event.request);
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'APPLY_UPDATE') {
    event.waitUntil((async () => {
      const reply = value => event.ports[0]?.postMessage(value);
      const scope = new URL(self.registration.scope);
      const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(client => {
        const url = new URL(client.url); return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
      });
      if (clients.length !== 1 || clients[0].id !== event.source?.id) { reply({ ok: false, reason: 'other-clients' }); return; }
      const cache = await caches.open(CACHE);
      const ready = (await Promise.all(ASSETS.map(asset => cache.match(new URL(asset, scope).href)))).every(Boolean);
      if (!ready) { reply({ ok: false, reason: 'incomplete' }); return; }
      await self.skipWaiting(); reply({ ok: true });
    })());
    return;
  }
  if (event.data?.type !== 'CACHE_VERSION') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const ready = (await Promise.all(ASSETS.map(asset => cache.match(new URL(asset, self.registration.scope).href)))).every(Boolean);
    event.ports[0]?.postMessage({ version: VERSION, ready, updateProtocol: 1 });
  })());
});
