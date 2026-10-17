import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeWindows } from '../public/asr.mjs';

function fixture() {
  let live = 0, maximumLive = 0;
  const seen = [], calls = [], merged = [];
  const processor = async samples => {
    live++; maximumLive = Math.max(maximumLive, live);
    const first = samples[0]; seen.push({ first, length: samples.length });
    return { input_features: { first, dispose() { live--; } } };
  };
  processor.feature_extractor = { config: { sampling_rate: 10, chunk_length: 30, hop_length: 2 } };
  const pipeline = {
    processor,
    model: { config: { max_source_positions: 1500 }, generate: async args => { calls.push(args); return { 0: { tolist: () => [BigInt(args.inputs.first)] }, dispose() {} }; } },
    tokenizer: { _decode_asr: (chunks, options) => { merged.push({ chunks, options }); return ['Full transcript.', { chunks: [{ timestamp: [0, 1335], text: 'Full transcript.' }] }]; } }
  };
  return { pipeline, seen, calls, merged, maximumLive: () => maximumLive, live: () => live };
}

test('streams all 67 windows through 22-minute audio with correct overlap and absolute strides', async () => {
  const f = fixture(); const progress = [];
  const samples = Float32Array.from({ length: 13350 }, (_, i) => i);
  const result = await transcribeWindows(f.pipeline, samples, { progress: p => progress.push(p) });
  assert.equal(result.processedSeconds, 1335); assert.equal(result.windowCount, 67);
  assert.equal(f.seen[0].first, 0); assert.equal(f.seen.at(-1).first, 13200); assert.equal(f.seen.at(-1).length, 150);
  assert.equal(progress.at(-1).processedSeconds, 1335); assert.ok(progress.some(p => p.processedSeconds > 120));
  assert.deepEqual(f.merged[0].chunks[0].stride, [30, 0, 5]);
  assert.deepEqual(f.merged[0].chunks[1].stride, [30, 5, 5]);
  assert.deepEqual(f.merged[0].chunks.at(-1).stride, [15, 5, 0]);
  assert.equal(f.maximumLive(), 1); assert.equal(f.live(), 0);
});
test('a generation failure releases the current window and never reports completion', async () => {
  const f = fixture(); let count = 0;
  f.pipeline.model.generate = async () => { if (++count === 2) throw new Error('model failed'); return { 0: { tolist: () => [1n] } }; };
  await assert.rejects(transcribeWindows(f.pipeline, new Float32Array(1000)), /model failed/);
  assert.equal(f.live(), 0); assert.equal(f.merged.length, 0);
});
test('one short window has no artificial overlap and non-English transcription keeps source language', async () => {
  const f = fixture(); const result = await transcribeWindows(f.pipeline, new Float32Array(110), { language: 'ja' });
  assert.equal(result.windowCount, 1); assert.deepEqual(f.merged[0].chunks[0].stride, [11, 0, 0]);
  assert.equal(f.calls[0].language, 'ja'); assert.equal(f.calls[0].task, 'transcribe');
});
