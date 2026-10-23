import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function fixture() {
  const handlers = new Map(), stores = new Map();
  const scope = 'https://example.test/commute-lingo/';
  let windows = [{ id: 'caller', url: scope }], activations = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const data = stores.get(name);
      return {
        async addAll(assets) { for (const asset of assets) data.set(new URL(asset, scope).href, { asset }); },
        async match(request) { return data.get(typeof request === 'string' ? request : request.url); }
      };
    },
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name)
  };
  const context = vm.createContext({ URL, caches, fetch: async request => ({ network: request.url }), self: { registration: { scope }, clients: { claim: async () => {}, matchAll: async () => windows }, skipWaiting: async () => { activations++; }, addEventListener: (name, fn) => handlers.set(name, fn) } });
  vm.runInContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  async function run(name, data = {}) { let promise; handlers.get(name)({ ...data, waitUntil: p => { promise = p; } }); await promise; }
  return { scope, stores, caches, handlers, run, setWindows: value => { windows = value; }, activations: () => activations };
}

test('update activation requires complete cache, one app window and the actual requesting client', async () => {
  const f = await fixture(); let result;
  const apply = (id = 'caller') => f.run('message', { data: { type: 'APPLY_UPDATE' }, source: { id }, ports: [{ postMessage: value => { result = value; } }] });
  await apply(); assert.equal(result.reason, 'incomplete'); assert.equal(f.activations(), 0);
  await f.run('install');
  f.setWindows([{ id: 'caller', url: f.scope }, { id: 'other', url: f.scope + '?v=0.2.8' }]);
  await apply(); assert.equal(result.reason, 'other-clients'); assert.equal(f.activations(), 0);
  f.setWindows([{ id: 'caller', url: f.scope }, { id: 'lab', url: 'https://example.test/ios-pwa-lab/' }]);
  await apply('unknown'); assert.equal(result.ok, false); assert.equal(f.activations(), 0);
  await apply(); assert.equal(result.ok, true); assert.equal(f.activations(), 1);
});

test('offline readiness requires every versioned asset, not just an active worker', async () => {
  const f = await fixture(); let result;
  const message = () => f.run('message', { data: { type: 'CACHE_VERSION' }, ports: [{ postMessage: value => { result = value; } }] });
  await message(); assert.equal(result.ready, false);
  await f.run('install'); await message(); assert.equal(result.version, '0.2.17'); assert.equal(result.ready, true);
  const store = [...f.stores.values()][0];
  assert.ok(store.has(f.scope + '?v=0.2.17'));
  store.delete(f.scope + 'decoder.mjs?v=0.2.17');
  await message(); assert.equal(result.ready, false);
});
test('versioned module requests are served from matching cache and other app paths pass through', async () => {
  const f = await fixture(); await f.run('install');
  let response;
  f.handlers.get('fetch')({ request: { method: 'GET', url: f.scope + 'asr.mjs?v=0.2.17' }, respondWith: p => { response = p; } });
  assert.equal((await response).asset, './asr.mjs?v=0.2.17');
  response = undefined;
  f.handlers.get('fetch')({ request: { method: 'GET', url: 'https://example.test/another-app/app.mjs' }, respondWith: p => { response = p; } });
  assert.equal(response, undefined);
});
test('navigation fragments reuse the cached document while unknown queries, other apps and writes pass through', async () => {
  const f = await fixture(); await f.run('install');
  for (const hash of ['#playlist', '#settings', '#library', '#vocabulary', '#import']) {
    let response;
    const request = new Request(f.scope + '?v=0.2.17' + hash);
    f.handlers.get('fetch')({ request, respondWith: value => { response = value; } });
    assert.ok(response, `Navigation ${hash} must be handled offline`);
    assert.equal((await response).asset, './?v=0.2.17');
  }
  for (const request of [
    new Request(f.scope + '?uncached-offline-probe=1#playlist'),
    new Request(f.scope + '?v=0.1.0#playlist'),
    new Request('https://example.test/another-app/?v=0.2.17#playlist'),
    new Request(f.scope + '?v=0.2.17#playlist', { method: 'POST' })
  ]) {
    let response;
    f.handlers.get('fetch')({ request, respondWith: value => { response = value; } });
    assert.equal(response, undefined);
  }
});
test('activation keeps model cache and other apps while retiring this app previous shell', async () => {
  const f = await fixture();
  await f.caches.open('commute-lingo-shell-0.1.0-r2'); await f.caches.open('commute-lingo-models-v1'); await f.caches.open('another-app-shell');
  await f.run('install'); await f.run('activate');
  assert.equal(f.stores.has('commute-lingo-shell-0.1.0-r2'), false);
  assert.equal(f.stores.has('commute-lingo-models-v1'), true); assert.equal(f.stores.has('another-app-shell'), true);
});
