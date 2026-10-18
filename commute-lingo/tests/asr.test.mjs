import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeWindows, mergeTimedTokens } from '../public/asr.mjs';

function fixture() {
  let live = 0, maximumLive = 0, released = 0;
  const seen = [], calls = [], merged = [];
  const processor = async samples => {
    live++; maximumLive = Math.max(maximumLive, live);
    const first = samples[0]; seen.push({ first, length: samples.length });
    return { input_features: { first, dispose() { live--; } } };
  };
  processor.feature_extractor = { config: { sampling_rate: 10, chunk_length: 30, hop_length: 2 } };
  const pipeline = {
    processor,
    model: { config: { max_source_positions: 1500 }, generate: async args => {
      calls.push(args);
      if (!args.return_token_timestamps) return { 0: { tolist: () => [BigInt(args.inputs.first)] }, dispose() {} };
      const attention = { dispose() { released++; } };
      return { sequences: { tolist: () => [[BigInt(args.inputs.first)]], dispose() { released++; } }, token_timestamps: { tolist: () => [[0]], dispose() { released++; } }, cross_attentions: [[attention, attention]] };
    } },
    tokenizer: { _decode_asr: (chunks, options) => { merged.push({ chunks, options }); return ['Full transcript.', { chunks: [{ timestamp: [0, 1335], text: 'Full transcript.' }] }]; } }
  };
  return { pipeline, seen, calls, merged, maximumLive: () => maximumLive, live: () => live, released: () => released };
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
  assert.equal(result.timestampMode, 'word'); assert.equal(f.merged[0].options.return_timestamps, 'word');
  assert.ok(f.calls.every(call => call.return_token_timestamps === true && call.return_timestamps === false));
  assert.ok(f.merged[0].chunks.every(chunk => chunk.token_timestamps.length === chunk.tokens.length));
  assert.equal(f.released(), 67 * 3);
  assert.equal(f.calls[0].num_frames, 1500); assert.equal(f.calls.at(-1).num_frames, 750);
});
test('a generation failure releases the current window and never reports completion', async () => {
  const f = fixture(); let count = 0;
  f.pipeline.model.generate = async () => { if (++count === 2) throw new Error('model failed'); return { 0: { tolist: () => [1n] } }; };
  await assert.rejects(transcribeWindows(f.pipeline, new Float32Array(1000), { timestampMode: 'segment' }), /model failed/);
  assert.equal(f.live(), 0); assert.equal(f.merged.length, 0);
});
test('invalid or missing word timestamps fail without returning partial subtitles and release tensors', async () => {
  for (const times of [null, [0], [0, NaN], [0, -1], [1, 0], [0, 12]]) {
    const f = fixture(); let released = 0;
    f.pipeline.model.generate = async () => ({
      sequences: { tolist: () => [[1n, 2n]], dispose() { released++; } },
      token_timestamps: { tolist: () => [times], dispose() { released++; } }
    });
    await assert.rejects(transcribeWindows(f.pipeline, new Float32Array(110)), /逐字時間/);
    assert.equal(released, 2); assert.equal(f.live(), 0); assert.equal(f.merged.length, 0);
  }
});
test('fractional word timestamps survive window merging with the existing segment mode still available', async () => {
  const f = fixture();
  f.pipeline.model.generate = async () => ({ sequences: { tolist: () => [[1n, 2n, 3n]] }, token_timestamps: { tolist: () => [[0, 1.237, 2.998]] } });
  await transcribeWindows(f.pipeline, new Float32Array(110));
  assert.deepEqual(f.merged[0].chunks[0].token_timestamps, [0, 1.24, 3]);
  const segment = fixture();
  const result = await transcribeWindows(segment.pipeline, new Float32Array(110), { timestampMode: 'segment' });
  assert.equal(result.timestampMode, 'segment'); assert.equal(segment.merged[0].options.return_timestamps, true);
});
test('numeric overlap merging preserves repeated speech and does not lexically compare timestamp arrays', () => {
  const sequences = [[1n, 2n, 3n, 4n], [3n, 4n, 1n, 2n]];
  const times = [[[8, 9], [9, 10], [10, 11], [11, 12]], [[10.02, 11], [11.02, 12], [20, 21], [21, 22]]];
  const before = JSON.stringify(times);
  const [tokens, anchors] = mergeTimedTokens(sequences, times);
  assert.deepEqual(tokens, [1n, 2n, 3n, 4n, 1n, 2n]);
  assert.deepEqual(anchors.map(pair => pair[0]), [8, 9, 10, 11.02, 20, 21]);
  assert.equal(JSON.stringify(times), before);
});
test('overlap merging appends disjoint speech and rejects ambiguous overlapping words', () => {
  assert.deepEqual(mergeTimedTokens([[1n], [2n]], [[[0, 1]], [[2, 3]]])[0], [1n, 2n]);
  assert.throws(() => mergeTimedTokens([[1n, 2n], [3n, 4n]], [[[0, 1], [1, 2]], [[1, 2], [2, 3]]]), /無法穩定對齊/);
});
test('overlap timing prefers the window that resolves shared zero-duration tokens', () => {
  const times = [[[20, 20], [20, 20], [20, 20], [20, 20]], [[24, 24.2], [24.2, 24.4], [24.4, 24.6], [24.6, 25]]];
  const [tokens, anchors] = mergeTimedTokens([[1n, 2n, 3n, 4n], [1n, 2n, 3n, 4n]], times);
  assert.deepEqual(tokens, [1n, 2n, 3n, 4n]); assert.deepEqual(anchors, times[1]);
});
test('one-hour audio visits every sample with bounded live model windows', async () => {
  const f = fixture(), progress = [];
  const result = await transcribeWindows(f.pipeline, new Float32Array(36000), { progress: value => progress.push(value) });
  assert.equal(result.processedSeconds, 3600); assert.equal(result.windowCount, 180);
  assert.equal(progress.at(-1).audioSeconds, 3600); assert.equal(progress.at(-1).total, 180);
  assert.equal(f.seen.at(-1).length, 200); assert.equal(f.merged[0].chunks.at(-1).is_last, true);
  assert.equal(f.maximumLive(), 1); assert.equal(f.live(), 0);
});
test('one short window has no artificial overlap and non-English transcription keeps source language', async () => {
  const f = fixture(); const result = await transcribeWindows(f.pipeline, new Float32Array(110), { language: 'ja' });
  assert.equal(result.windowCount, 1); assert.deepEqual(f.merged[0].chunks[0].stride, [11, 0, 0]);
  assert.equal(f.calls[0].language, 'ja'); assert.equal(f.calls[0].task, 'transcribe');
  assert.equal(f.calls[0].num_frames, 550);
});
