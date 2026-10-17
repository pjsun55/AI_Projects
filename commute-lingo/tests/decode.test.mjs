import test from 'node:test';
import assert from 'node:assert/strict';
import { createResampler, decodeMP3, decodeInWorker, isMP3 } from '../public/decode.mjs';
import { checkDecodedAudio } from '../public/core.mjs';

function collect(parts) {
  const result = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
test('MP3 detection covers downloaded MPEG, imported files and header-only sources', () => {
  assert.equal(isMP3({ name: 'episode.mp3', type: '' }, []), true);
  assert.equal(isMP3({ name: 'episode', type: 'audio/mpeg' }, []), true);
  assert.equal(isMP3({ name: 'episode', type: '' }, [0x49, 0x44, 0x33]), true);
  assert.equal(isMP3({ name: 'episode', type: '' }, [0xff, 0xfb]), true);
  assert.equal(isMP3({ name: 'episode.aac', type: 'audio/aac' }, [0xff, 0xf1]), false);
  assert.equal(isMP3({ name: 'episode.wav', type: 'audio/wav' }, [0x52, 0x49, 0x46, 0x46]), false);
});
test('resampling keeps exact duration, stereo mix and identical output across irregular chunks', () => {
  const count = 44100 * 3 + 127;
  const left = Float32Array.from({ length: count }, (_, i) => Math.sin(2 * Math.PI * 1234 * i / 44100) * 0.7);
  const right = Float32Array.from(left, value => value * 0.2);
  const whole = createResampler(44100).push([left, right], true);
  const streaming = createResampler(44100), parts = [];
  for (let i = 0; i < count; i += 791) parts.push(streaming.push([left.subarray(i, i + 791), right.subarray(i, i + 791)]));
  parts.push(streaming.push([new Float32Array()], true));
  const joined = collect(parts);
  assert.equal(joined.length, Math.floor(count * 16000 / 44100));
  assert.deepEqual(joined, whole);
  assert.ok(joined.every(Number.isFinite));
  assert.ok(Math.max(...joined.subarray(100, 10000)) > 0.41);
});
test('resampling preserves constant mono level and suppresses above-Nyquist aliasing', () => {
  const dc = createResampler(48000).push([new Float32Array(48000).fill(0.4)], true);
  assert.ok(dc.every(value => Math.abs(value - 0.4) < 1e-6));
  const rms = frequency => {
    const source = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * frequency * i / 48000));
    const result = createResampler(48000).push([source], true).subarray(100, 15900);
    return Math.sqrt(result.reduce((sum, value) => sum + value * value, 0) / result.length);
  };
  assert.ok(rms(1000) > 0.69);
  assert.ok(rms(12000) < 0.001);
});
test('decoder traverses every byte, retains PCM after 1:58, and frees resources on success/error', async () => {
  let freed = 0, calls = 0;
  class Decoder {
    ready = Promise.resolve();
    decode(bytes) { calls++; assert.ok(bytes.length); return { channelData: [new Float32Array(16000).fill(0.2)], samplesDecoded: 16000, sampleRate: 16000, errors: [] }; }
    free() { freed++; }
  }
  let last;
  const output = await decodeMP3(new Uint8Array(262144 * 120 + 1), { loadDecoder: async () => ({ MPEGDecoder: Decoder }), progress: value => { last = value; } });
  assert.equal(calls, 121); assert.equal(freed, 1);
  assert.equal(output.samples.length, 121 * 16000); assert.equal(output.sourceSamples, output.samples.length);
  assert.equal(last.bytesRead, last.totalBytes); assert.equal(last.decodedSeconds, 121);
  assert.doesNotThrow(() => checkDecodedAudio(output.samples.length, 16000, 121));
  class Broken extends Decoder { decode() { throw new Error('bad data'); } }
  await assert.rejects(decodeMP3(new Uint8Array(5), { loadDecoder: async () => ({ MPEGDecoder: Broken }) }), /bad data/);
  assert.equal(freed, 2);
  class Corrupt extends Decoder { decode() { return { errors: [{ message: 'corrupt frame' }] }; } }
  await assert.rejects(decodeMP3(new Uint8Array(5), { loadDecoder: async () => ({ MPEGDecoder: Corrupt }) }), /無法解碼的片段/);
  assert.equal(freed, 3);
  class Unavailable extends Decoder { ready = Promise.reject(new Error('WASM unavailable')); }
  await assert.rejects(decodeMP3(new Uint8Array(5), { loadDecoder: async () => ({ MPEGDecoder: Unavailable }) }), /WASM unavailable/);
  assert.equal(freed, 3);
});
test('stopping a decode terminates its worker, settles the await and ignores late completion', async () => {
  const controller = new AbortController(); let terminated = 0, sent;
  const worker = { terminate() { terminated++; }, postMessage(message, transfers) { sent = { message, transfers }; } };
  const input = new ArrayBuffer(3);
  const promise = decodeInWorker(input, { duration: 1335, signal: controller.signal, createWorker: () => worker });
  const late = worker.onmessage;
  assert.equal(sent.message.bytes, input); assert.deepEqual(sent.transfers, [input]);
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(terminated, 1); assert.equal(worker.onmessage, null);
  // A message queued before termination must not turn cancellation into success.
  late({ data: { type: 'complete', samples: new Float32Array(10) } });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(terminated, 1);
});
test('worker completion and worker startup errors both release the worker', async () => {
  let worker, terminated = 0;
  const createWorker = () => (worker = { terminate() { terminated++; }, postMessage() {} });
  let promise = decodeInWorker(new ArrayBuffer(2), { createWorker });
  const samples = new Float32Array(20);
  worker.onmessage({ data: { type: 'complete', samples } });
  assert.equal((await promise).samples, samples); assert.equal(terminated, 1);
  promise = decodeInWorker(new ArrayBuffer(2), { createWorker }); worker.onerror();
  await assert.rejects(promise, /無法載入 MP3 解碼器/); assert.equal(terminated, 2);
});
