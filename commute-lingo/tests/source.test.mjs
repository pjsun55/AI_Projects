import test from 'node:test';
import assert from 'node:assert/strict';
import { podcastSource, downloadSource, importPodcast, importAudioFile, transcribeSavedAudio, workerTranscript, audioDuration } from '../public/source.mjs';
import { DEFAULT_SETTINGS } from '../public/library.mjs';
const link = 'https://podcasts.apple.com/tw/podcast/example/id189330872?i=1000796641961';
test('catalog duration over the preference rejects before any media download', async () => {
  let calls = 0;
  await assert.rejects(podcastSource(link, DEFAULT_SETTINGS, { fetchImpl: async () => { calls++; return Response.json({ results: [{ trackId: 1000796641961, trackName: 'Example', episodeUrl: 'https://media.example.com/audio.mp3', trackTimeMillis: 1500001 }] }); } }), /超過目前 25/);
  assert.equal(calls, 1);
});
test('catalog accepts exactly one hour and rejects anything longer with the raised preference', async () => {
  for (const duration of [3600000, 3600001]) {
    const result = podcastSource(link, { ...DEFAULT_SETTINGS, maxMinutes: 60 }, { fetchImpl: async () => Response.json({ results: [{ trackId: 1000796641961, trackName: 'One-hour fixture', episodeUrl: 'https://media.example.com/hour.mp3', trackTimeMillis: duration }] }) });
    if (duration === 3600000) assert.equal((await result).title, 'One-hour fixture');
    else await assert.rejects(result, /超過目前 60/);
  }
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
function audioFile(name = 'My lesson.mp3', type = 'audio/mpeg', bytes = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]) {
  return Object.assign(new Blob([new Uint8Array(bytes)], { type }), { name });
}
test('local MP3, M4A and WAV imports use full transcription guards and return pending local audio only', async () => {
  for (const file of [audioFile(), audioFile('Lesson.M4A', '', [0, 0, 0, 20, 102, 116, 121, 112, 77, 52, 65, 32]), audioFile('Lesson.wav', 'audio/x-wav', [82, 73, 70, 70, 20, 0, 0, 0, 87, 65, 86, 69])]) {
    const { events, dependencies } = pipeline({
      resolve: () => { throw new Error('must not look up a URL'); },
      download: () => { throw new Error('must not download audio'); },
      decode: async (blob, duration, { name }) => { assert.equal(name, file.name); assert.equal(duration, 60); assert.deepEqual(await blob.arrayBuffer(), await file.arrayBuffer()); return { samples: new Float32Array(60 * 16000), decoder: 'fixture' }; }
    });
    const result = await importAudioFile(file, DEFAULT_SETTINGS, dependencies);
    assert.deepEqual(events, ['source', 'decode', 'transcribe']);
    assert.equal(result.track.title, file.name.replace(/\.(mp3|m4a|wav)$/i, ''));
    assert.equal(result.track.source, 'file'); assert.equal(result.track.sourceURL, '');
    assert.equal(result.track.duration, 60); assert.equal(result.track.albumId, undefined);
    assert.equal(result.blob.size, file.size); assert.match(result.blob.type, /^audio\//);
  }
});
test('file import rejects empty, oversized, unsupported, mismatched or disguised files before metadata or decoding', async () => {
  let probed = 0;
  const oversized = audioFile(); Object.defineProperty(oversized, 'size', { value: 250 * 1024 * 1024 + 1 });
  for (const file of [null, Object.assign(new Blob([]), { name: 'empty.mp3' }), oversized,
    audioFile('movie.mp4', 'video/mp4'), audioFile('fake.mp3', 'text/html'),
    audioFile('fake.mp3', 'audio/mpeg', [60, 104, 116, 109, 108, 62]), audioFile('fake.wav'), audioFile('fake.m4a')]) {
    await assert.rejects(importAudioFile(file, DEFAULT_SETTINGS, { durationOf: async () => { probed++; return 60; } }));
  }
  assert.equal(probed, 0);
});
test('file import enforces the measured duration, rejects truncated decoding/ASR and propagates decoding failure', async () => {
  for (const [overrides, message] of [
    [{ durationOf: async () => 1501, decode: async () => { throw new Error('must not decode'); } }, /超過目前 25/],
    [{ decode: async () => ({ samples: new Float32Array(16000), decoder: 'fixture' }) }, /解碼長度/],
    [{ transcribe: async () => ({ processedSeconds: 1, chunks: [] }) }, /沒有走完整/],
    [{ decode: async () => { throw new Error('Unreadable audio'); } }, /Unreadable audio/]
  ]) {
    const { dependencies } = pipeline(overrides);
    await assert.rejects(importAudioFile(audioFile(), DEFAULT_SETTINGS, dependencies), message);
  }
});
test('file import cancellation prevents the next stage and filenames remain bounded plain metadata', async () => {
  const controller = new AbortController(); let decoded = false;
  const { dependencies } = pipeline({ signal: controller.signal, durationOf: async () => { controller.abort(); return 60; }, decode: async () => { decoded = true; } });
  await assert.rejects(importAudioFile(audioFile(), DEFAULT_SETTINGS, dependencies), { name: 'AbortError' }); assert.equal(decoded, false);
  const { dependencies: valid } = pipeline();
  const result = await importAudioFile(audioFile('<script>\u0000' + 'a'.repeat(150) + '.mp3'), DEFAULT_SETTINGS, valid);
  assert.equal(result.track.title.length, 120); assert.ok(!result.track.title.includes('\u0000'));
});
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
test('automatic transcription retains model text with disclosed timing repairs', async () => {
  const { dependencies } = pipeline({ transcribe: async () => ({ processedSeconds: 60, chunks: [{ timestamp: [null, 2], text: 'Start words.' }, { timestamp: [2, 60], text: 'Remaining words.' }], metrics: {} }) });
  const result = await importPodcast(link, DEFAULT_SETTINGS, dependencies);
  assert.equal(result.track.segments.length, 2); assert.equal(result.track.segments[0].timingUncertain, true);
  assert.equal(result.track.metrics.timestampWarnings.length, 1); assert.equal(result.track.segments[0].text, 'Start words.');
  const broken = pipeline({ transcribe: async () => ({ processedSeconds: 60, chunks: [{ timestamp: [55, 1], text: 'Invalid.' }] }) });
  await assert.rejects(importPodcast(link, DEFAULT_SETTINGS, broken.dependencies), /時間無法安全對齊/);
});
test('word timing becomes independent sentence ranges with exact model anchors and no mutation', async () => {
  const chunks = [
    { timestamp: [0.4, 1.2], text: 'With' }, { timestamp: [1.2, 2], text: 'so many bottles?' },
    { timestamp: [3, 3.8], text: 'The answer' }, { timestamp: [3.8, 5], text: 'lies on the label.' },
    { timestamp: [6, 8], text: 'The supreme grade' }, { timestamp: [8, 10], text: 'is extra virgin.' }
  ];
  const before = JSON.stringify(chunks);
  const { dependencies } = pipeline({ transcribe: async () => ({ timestampMode: 'word', processedSeconds: 60, chunks }) });
  const result = await transcribeSavedAudio(new Blob(['fixture']), DEFAULT_SETTINGS, dependencies);
  assert.equal(result.alignment, 'word-v1'); assert.equal(result.metrics.timestampMode, 'word');
  assert.deepEqual(result.segments.map(({ start, end, text }) => [start, end, text]), [
    [0.4, 2, 'With so many bottles?'], [3, 5, 'The answer lies on the label.'], [6, 10, 'The supreme grade is extra virgin.']
  ]);
  assert.equal(JSON.stringify(chunks), before);
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
