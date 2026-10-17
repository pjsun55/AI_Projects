import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAudioURL, readJSON } from '../public/network.mjs';
import { downloadSource, podcastSource } from '../public/source.mjs';
import { DEFAULT_SETTINGS } from '../public/library.mjs';

test('audio URLs reject normalized local/IP destinations, credentials and unusual ports', () => {
  for (const url of ['http://media.example.com/a', 'https://localhost/a', 'https://localhost./a', 'https://x.local/a', 'https://x.internal/a', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://0177.0.0.1/a', 'https://[::1]/a', 'https://192.168.1.1/a', 'https://8.8.8.8/a', 'https://u:p@media.example.com/a', 'https://media.example.com:8443/a', 'https://a.test/a', 'https://a..com/a']) {
    assert.throws(() => publicAudioURL(url), undefined, url);
  }
  assert.equal(publicAudioURL('https://MEDIA.example.com:443/a?signature=a%2Bb').href, 'https://media.example.com/a?signature=a%2Bb');
});

test('unsafe feed URL is rejected before any media request; malformed records are skipped', async () => {
  let calls = 0;
  await assert.rejects(downloadSource({ url: 'https://127.0.0.1/a' }, { fetchImpl: async () => { calls++; } }));
  assert.equal(calls, 0);
  const link = 'https://podcasts.apple.com/id1?i=2';
  await assert.rejects(podcastSource(link, DEFAULT_SETTINGS, { fetchImpl: async () => Response.json({ results: [null, { trackId: 2, episodeUrl: 'https://x.local/a' }] }) }), /公開 HTTPS/);
});

test('bounded JSON preserves UTF-8 split across chunks and rejects executable or malformed input', async () => {
  const bytes = new TextEncoder().encode('{"text":"中文"}');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await readJSON(new Response(stream, { headers: { 'content-type': 'application/json' } })), { text: '中文' });
  await assert.rejects(readJSON(new Response('<script/>', { headers: { 'content-type': 'text/html' } })), /JSON/);
  await assert.rejects(readJSON(Response.json('hello'), { maxBytes: 2 }), /大小限制/);
  await assert.rejects(readJSON(new Response('callback({})', { headers: { 'content-type': 'text/javascript' } }), { allowJavaScriptType: true }), /JSON 格式/);
});

test('oversized declared and chunked JSON are cancelled without parsing', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } });
    const headers = { 'content-type': 'application/json', ...(declared ? { 'content-length': '20' } : {}) };
    await assert.rejects(readJSON(new Response(stream, { headers }), { maxBytes: 10 }), /大小限制/);
    assert.equal(cancelled, true);
  }
});

test('aborting a pending JSON or audio read cancels the stream and settles promptly', async () => {
  for (const audio of [false, true]) {
    const controller = new AbortController(); let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const response = new Response(stream, { headers: { 'content-type': audio ? 'audio/mpeg' : 'application/json' } });
    const pending = audio ? downloadSource({ url: 'https://media.example.com/a' }, { signal: controller.signal, fetchImpl: async () => response }) : readJSON(response, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, true);
  }
});

test('media download rejects active content, oversized declared files and unsafe final URLs', async () => {
  for (const type of ['text/javascript', 'application/xml', 'text/html']) {
    await assert.rejects(downloadSource({ url: 'https://media.example.com/a' }, { fetchImpl: async () => new Response('data', { headers: { 'content-type': type } }) }), /不是支援的音訊/);
  }
  await assert.rejects(downloadSource({ url: 'https://media.example.com/a' }, { fetchImpl: async () => new Response('data', { headers: { 'content-type': 'audio/mpeg', 'content-length': '999999999' } }) }), /250 MB/);
  const redirected = new Response('data', { headers: { 'content-type': 'audio/mpeg' } });
  Object.defineProperty(redirected, 'url', { value: 'https://127.0.0.1/private' });
  await assert.rejects(downloadSource({ url: 'https://media.example.com/a' }, { fetchImpl: async () => redirected }), /公開 HTTPS/);
});
