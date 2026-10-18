import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, workerMessage, reloadVersion } from '../public/updates.mjs';

function fixture(options = {}) {
  const sw = new EventTarget(), registration = new EventTarget();
  let auto = options.auto ?? true, busy = options.busy ?? false;
  const records = [], requests = [], timers = new Map(); let serial = 0;
  registration.waiting = {}; registration.update = async () => { if (options.networkError) throw new Error('offline'); };
  sw.register = async () => registration;
  const manager = createUpdater({ serviceWorker: sw, version: '0.2.12', isAuto: () => auto, canUpdate: () => !busy,
    prepare: async () => { records.push('save'); if (options.saveError) throw new Error('save failed'); },
    lock: value => records.push(['lock', value]), render: state => records.push(state), reload: version => records.push(['reload', version]),
    timers: { setTimeout(fn) { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } },
    message: async (_, request) => {
      requests.push(request.type);
      records.push(['message', request.type]);
      return request.type === 'CACHE_VERSION' ? { ready: options.ready ?? true, version: '0.3.0', updateProtocol: 1 } : { ok: !options.otherTabs, reason: options.otherTabs ? 'other-clients' : undefined };
    }
  });
  return { manager, sw, records, requests, setBusy: value => { busy = value; }, setAuto: value => { auto = value; } };
}
test('automatic updates wait while busy, save before activation and reload on controllerchange', async () => {
  const f = fixture({ busy: true });
  try {
    await f.manager.start(); assert.deepEqual(f.requests, []);
    f.setBusy(false); await f.manager.refresh();
    assert.deepEqual(f.requests, ['CACHE_VERSION', 'APPLY_UPDATE']);
    assert.ok(f.records.indexOf('save') < f.records.findIndex(item => item?.[0] === 'message' && item[1] === 'APPLY_UPDATE'));
    assert.equal(f.records.some(item => item?.[0] === 'reload'), false);
    f.sw.dispatchEvent(new Event('controllerchange'));
    assert.deepEqual(f.records.at(-1), ['reload', '0.3.0']);
  } finally { f.manager.stop(); }
});
test('automatic updates can be disabled; manual apply remains available', async () => {
  const f = fixture({ auto: false });
  try {
    await f.manager.start(); await f.manager.check(); assert.deepEqual(f.requests, []);
    await f.manager.apply(); assert.deepEqual(f.requests, ['CACHE_VERSION', 'APPLY_UPDATE']);
  } finally { f.manager.stop(); }
});
test('failed saves and incomplete caches never request activation; other tabs keep the update waiting', async () => {
  for (const options of [{ saveError: true }, { ready: false }, { otherTabs: true }]) {
    const f = fixture({ auto: false, ...options });
    try {
      await f.manager.start(); await f.manager.apply();
      assert.equal(f.requests.includes('APPLY_UPDATE'), !!options.otherTabs);
      assert.equal(f.records.some(item => item?.[0] === 'reload'), false);
      assert.ok(f.records.some(item => item?.[0] === 'lock' && item[1] === false));
    } finally { f.manager.stop(); }
  }
});
test('failed update checks report failure rather than latest', async () => {
  const f = fixture({ auto: false, networkError: true });
  try {
    await f.manager.check();
    assert.ok(f.records.some(item => item.text?.includes('檢查更新失敗')));
    assert.equal(f.records.some(item => item.text?.includes('已是最新')), false);
  } finally { f.manager.stop(); }
});
test('worker messages return replies and time out without leaving MessagePorts open', async () => {
  const result = await workerMessage({ postMessage(_, ports) { ports[0].postMessage({ ok: true }); } }, {}, 1000);
  assert.equal(result.ok, true);
  await assert.rejects(workerMessage({ postMessage() {} }, {}, 10), /逾時/);
});

test('shell-only updates reload the document; version upgrades retain path and view', () => {
  const calls = [];
  const location = { href: 'https://example.test/AI_Projects/commute-lingo/?v=0.2.12#settings', reload: () => calls.push('reload'), replace: value => calls.push(value) };
  reloadVersion(location, '0.2.12'); assert.deepEqual(calls, ['reload']);
  reloadVersion(location, '0.3.0'); assert.equal(calls[1], 'https://example.test/AI_Projects/commute-lingo/?v=0.3.0#settings');
});
