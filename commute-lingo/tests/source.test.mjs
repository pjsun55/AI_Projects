import test from 'node:test';
import assert from 'node:assert/strict';
import { podcastSource, downloadSource, importPodcast, transcribeSavedAudio, workerTranscript, audioDuration } from '../public/source.mjs';
import { DEFAULT_SETTINGS } from '../public/library.mjs';
const link = 'https://podcasts.apple.com/tw/podcast/example/id189330872?i=1000796641961';
test('catalog duration over the preference rejects before any media download', async () => {
  let calls = 0;
  await assert.rejects(podcastSource(link, DEFAULT_SETTINGS, { fetchImpl: async () => { calls++; return Response.json({ results: [{ trackId: 1000796641961, trackName: 'Example', episodeUrl: 'https://media.example.com/audio.mp3', trackTimeMillis: 1500001 }] }); } }), /超過目前 25/);
  assert.equal(calls, 1);
});
test('media download rejects partial responses, HTML, and declared truncation', async () => {
  const source = { url: 'https://media.example.com/audio.mp3' };
  for (const response of [new Response('partial', { status: 206 }), new Response('<html>', { headers: { 'content-type': 'text/html' } }), new Response('short', { headers: { 'content-type': 'audio/mpeg', 'content-length': '999' } })]) await assert.rejects(downloadSource(source, { fetchImpl: async () => response }));
  const blob = await downloadSource(source, { fetchImpl: async () => new Response('audio', { headers: { 'content-type': 'audio/mpeg', 'content-length': '5' } }) });
  assert.equal(blob.size, 5); assert.equal(blob.type, 'audio/mpeg');
});
function pipeline(overrides = {}) {
  const events = [], source = { title: 'A test episode', show: 'Test show', url: 'https://media.example.com/audio.mp3', link, type: 'podcast' };
  return { events, dependencies: {
    progress: event => events.push(event.stage),
    resolve: async () => source, download: async () => new Blob(['public test fixture']),
    durationOf: async () => 60, decode: async () => ({ samples: new Float32Array(60 * 16000), decoder: 'fixture' }),
    transcribe: async () => ({ processedSeconds: 60, chunks: [{ timestamp: [0, 60], text: 'A complete test sentence.' }], metrics: {} }), ...overrides
  } };
}
test('one import runs lookup → download → decode → ASR and returns a pending item, without persisting', async () => {
  const { events, dependencies } = pipeline();
  const result = await importPodcast(link, DEFAULT_SETTINGS, dependencies);
  assert.deepEqual(events, ['source', 'download', 'decode', 'transcribe']);
  assert.equal(result.track.duration, 60); assert.equal(result.track.segments.length, 1); assert.equal(result.track.sourceURL, link);
  assert.ok(result.blob instanceof Blob); assert.equal(result.track.albumId, undefined);
});
test('a saved audio repair decodes the existing Blob without lookup or download and keeps full-length guards', async () => {
  const blob = new Blob(['saved original audio']);
  const { events, dependencies } = pipeline({ decode: async received => { assert.equal(received, blob); return { samples: new Float32Array(60 * 16000), decoder: 'fixture' }; } });
  const result = await transcribeSavedAudio(blob, DEFAULT_SETTINGS, dependencies);
  assert.deepEqual(events, ['decode', 'transcribe']);
  assert.equal(result.duration, 60); assert.equal(result.segments[0].end, 60);
  const truncated = pipeline({ decode: async () => ({ samples: new Float32Array(5 * 16000), decoder: 'fixture' }), transcribe: async () => { throw new Error('must not start ASR'); } });
  await assert.rejects(transcribeSavedAudio(blob, DEFAULT_SETTINGS, truncated.dependencies), /解碼長度/);
});
test('measured duration is checked before decoder or ASR, even without catalog duration', async () => {
  const { dependencies } = pipeline({ durationOf: async () => 1500.01, decode: async () => { throw new Error('must not decode'); } });
  await assert.rejects(importPodcast(link, DEFAULT_SETTINGS, dependencies), /超過/);
});
test('errors at each stage terminate without proceeding; a truncated ASR result cannot succeed', async () => {
  for (const stage of ['resolve', 'download', 'durationOf', 'decode', 'transcribe']) {
    let after = 0;
    const { dependencies } = pipeline(); const keys = ['resolve', 'download', 'durationOf', 'decode', 'transcribe'];
    for (const key of keys.slice(keys.indexOf(stage) + 1)) dependencies[key] = async () => { after++; throw new Error('unexpected continuation'); };
    dependencies[stage] = async () => { throw new Error('stage failed'); };
    await assert.rejects(importPodcast(link, DEFAULT_SETTINGS, dependencies), /stage failed/); assert.equal(after, 0);
  }
  const { dependencies } = pipeline({ transcribe: async () => ({ processedSeconds: 15, chunks: [] }) });
  await assert.rejects(importPodcast(link, DEFAULT_SETTINGS, dependencies), /沒有走完整/);
});
test('cancellation after a late stage result does not start the next stage', async () => {
  const controller = new AbortController(); let downloaded = false;
  const { dependencies } = pipeline({ signal: controller.signal, resolve: async () => { controller.abort(); return {}; }, download: async () => { downloaded = true; } });
  await assert.rejects(importPodcast(link, DEFAULT_SETTINGS, dependencies), { name: 'AbortError' }); assert.equal(downloaded, false);
});
test('stopping model inference terminates its worker and settles the waiting import', async () => {
  const controller = new AbortController(); let ended = 0;
  const worker = { postMessage() {}, terminate() { ended++; } };
  const promise = workerTranscript(new Float32Array(3), { signal: controller.signal, createWorker: () => worker });
  controller.abort(); await assert.rejects(promise, { name: 'AbortError' }); assert.equal(ended, 1);
});
test('metadata probe releases both its audio source and object URL after success or cancellation', async () => {
  let probe, released = 0, unloaded = 0;
  class AudioStub { duration = 123; removeAttribute() { unloaded++; } load() {} constructor() { probe = this; } }
  const options = { AudioClass: AudioStub, urlAPI: { createObjectURL: () => 'blob:test', revokeObjectURL: () => { released++; } } };
  const first = audioDuration(new Blob(['test']), options); probe.onloadedmetadata(); assert.equal(await first, 123);
  const controller = new AbortController(), second = audioDuration(new Blob(['test']), { ...options, signal: controller.signal });
  controller.abort(); await assert.rejects(second, { name: 'AbortError' }); assert.equal(released, 2); assert.equal(unloaded, 2);
});
