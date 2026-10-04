const VERSION = '0.1.1';
const PREFIX = 'ios-pwa-lab:';
const CACHE = `${PREFIX}shell-${VERSION}`;
const SHELL = ['index.html','styles.css','app.js','core.js','catalog.js','storage.js','probes.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','worker.js'];
const url = path => new URL(path, self.registration.scope).href;
self.addEventListener('install', event => {
  // addAll is atomic: a missing asset prevents installing an incomplete shell.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(url))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async()=>{
    for(const name of await caches.keys())if(name.startsWith(`${PREFIX}shell-`)&&name!==CACHE)await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => { if(event.data?.type==='SKIP_WAITING')void self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const request=event.request,target=new URL(request.url),scope=new URL(self.registration.scope);
  if(request.method!=='GET'||target.origin!==scope.origin||!target.pathname.startsWith(scope.pathname))return;
  // Network probe is always a real request; never mask offline failures.
  if(target.pathname===new URL('network-test.json',scope).pathname)return;
  const path=target.pathname.slice(scope.pathname.length);
  if(request.mode==='navigate'){
    if(path!==''&&path!=='index.html')return;
    event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(url('index.html')))||fetch(request)));return;
  }
  if(!SHELL.includes(path))return;
  event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(url(path)))||fetch(request)));
});
