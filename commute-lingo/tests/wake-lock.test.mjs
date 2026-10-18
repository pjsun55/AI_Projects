import test from 'node:test';
import assert from 'node:assert/strict';
import { holdScreenAwake } from '../public/wake-lock.mjs';

function fixture(request) {
  const controller = new AbortController(), states = [];
  const sentinel = new EventTarget(); sentinel.released = false;
  let releases = 0, requests = 0, visible = true;
  sentinel.release = async () => { releases++; sentinel.released = true; sentinel.dispatchEvent(new Event('release')); };
  const lock = holdScreenAwake({ signal: controller.signal, visible: () => visible, onChange: value => states.push(value),
    wakeLock: { request: async type => { requests++; assert.equal(type, 'screen'); return request ? request(sentinel) : sentinel; } } });
  return { controller, sentinel, lock, states, releases: () => releases, requests: () => requests, hide: () => { visible = false; } };
}
test('conversion holds a screen lock and releases it once on completion', async () => {
  const f = fixture(); await f.lock.ready;
  assert.equal(f.states.at(-1), 'active'); assert.equal(f.releases(), 0);
  await f.lock.release(); await f.lock.release(); f.controller.abort();
  assert.equal(f.releases(), 1); assert.equal(f.states.at(-1), 'idle');
});
test('abort immediately releases an acquired lock without waiting for model completion', async () => {
  const f = fixture(); await f.lock.ready; f.controller.abort();
  assert.equal(f.sentinel.released, true); assert.equal(f.states.at(-1), 'idle');
});
test('a lock granted after cancellation is released and never reported active', async () => {
  let grant;
  const f = fixture(sentinel => new Promise(resolve => { grant = () => resolve(sentinel); }));
  f.controller.abort(); grant(); await f.lock.ready;
  assert.equal(f.releases(), 1); assert.equal(f.states.includes('active'), false);
});
test('a late grant after job completion or leaving the foreground cannot keep the screen awake', async () => {
  for (const action of ['complete', 'hide']) {
    let grant;
    const f = fixture(sentinel => new Promise(resolve => { grant = () => resolve(sentinel); }));
    if (action === 'complete') await f.lock.release(); else f.hide();
    grant(); await f.lock.ready;
    assert.equal(f.releases(), 1); assert.equal(f.states.includes('active'), false);
    await f.lock.release();
  }
});
test('unsupported, hidden and denied requests report fallback without failing the conversion', async () => {
  for (const options of [{ wakeLock: null }, { visible: () => false, wakeLock: { request() { throw Error('must not request'); } } },
    { wakeLock: { request() { throw new DOMException('Not allowed', 'NotAllowedError'); } } }]) {
    const states = [], lock = holdScreenAwake({ ...options, onChange: state => states.push(state) });
    await lock.ready; assert.equal(states.at(-1), 'unavailable'); await lock.release();
  }
});
test('an operating-system release removes the active claim while the conversion continues', async () => {
  const f = fixture(); await f.lock.ready; await f.sentinel.release();
  assert.equal(f.states.at(-1), 'released'); await f.lock.release(); assert.equal(f.releases(), 1);
});
test('an already cancelled job does not request a lock', async () => {
  const controller = new AbortController(); controller.abort();
  const lock = holdScreenAwake({ signal: controller.signal, wakeLock: { request() { assert.fail('must not request'); } } });
  await lock.ready; await lock.release();
});
test('release errors are contained and reported rather than failing a completed conversion', async () => {
  const f = fixture(); await f.lock.ready;
  f.sentinel.release = async () => { throw Error('platform failure'); };
  await f.lock.release(); assert.equal(f.states.at(-1), 'release-failed');
});
