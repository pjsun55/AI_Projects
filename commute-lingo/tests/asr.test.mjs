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

function collapsedFixture(fails, failRecovery = false) {
  const f = fixture(), original = f.pipeline.processor, generated = [];
  let liveTensors = 0;
  const processor = async samples => {
    const feature = await original(samples); feature.input_features.length = samples.length; return feature;
  };
  processor.feature_extractor = original.feature_extractor; f.pipeline.processor = processor;
  Object.assign(f.pipeline.tokenizer, { all_special_ids: [0, 99], timestamp_begin: 100 });
  f.pipeline.model.generate = async ({ inputs, num_frames }) => {
    const broken = fails(inputs) || failRecovery && inputs.length < 300;
    generated.push({ first: inputs.first, length: inputs.length, num_frames });
    const end = inputs.length / 10 - 0.02;
    const tensor = values => { liveTensors++; return { tolist: () => [values], dispose() { liveTensors--; } }; };
    return { sequences: tensor([0n, 1n, 2n, 99n]), token_timestamps: tensor(broken ? [0, end, end, end] : [0, 0, 1, 2]) };
  };
  return { ...f, generated, liveTensors: () => liveTensors };
}
test('collapsed word window retries two shorter overlaps without losing audio or changing absolute offsets', async () => {
  const f = collapsedFixture(input => input.first === 800 && input.length === 300), progress = [];
  const result = await transcribeWindows(f.pipeline, Float32Array.from({ length: 1400 }, (_, i) => i), { progress: event => progress.push(event) });
  assert.equal(result.processedSeconds, 140); assert.equal(result.repairedWindows, 1);
  assert.equal(result.windowCount, 8); assert.equal(result.inferenceWindows, 9);
  assert.deepEqual(f.generated.filter(item => item.first >= 800 && item.first <= 900).map(({ first, length }) => [first, length]), [[800, 300], [800, 200], [900, 200]]);
  const outputs = f.merged[0].chunks;
  let offset = 0;
  const starts = outputs.map(chunk => { offset -= chunk.stride[1]; const start = offset; offset += chunk.stride[0] - chunk.stride[2]; return start; });
  assert.deepEqual(starts, [0, 20, 40, 60, 80, 90, 100, 120]);
  assert.deepEqual(outputs[4].stride, [20, 5, 5]); assert.deepEqual(outputs[5].stride, [20, 5, 5]);
  assert.equal(progress.filter(event => event.recovering).length, 1);
  assert.equal(progress.at(-1).window, 7); assert.equal(progress.at(-1).total, 7);
  assert.equal(f.live(), 0); assert.equal(f.maximumLive(), 1); assert.equal(f.liveTensors(), 0);
});
test('a failed short-window recovery stops without partial success or retained tensors', async () => {
  const f = collapsedFixture(input => input.first === 800 && input.length === 300, true), progress = [];
  await assert.rejects(transcribeWindows(f.pipeline, Float32Array.from({ length: 1400 }, (_, i) => i), { progress: event => progress.push(event) }), /縮短音訊視窗後仍/);
  assert.equal(f.generated.length, 6); assert.equal(f.merged.length, 0);
  assert.ok(progress.every(event => event.processedSeconds < 140));
  assert.equal(f.live(), 0); assert.equal(f.liveTensors(), 0);
});
test('empty recovery results cannot silently replace a collapsed speech window', async () => {
  const f = collapsedFixture(input => input.first === 800 && input.length === 300);
  const generate = f.pipeline.model.generate;
  f.pipeline.model.generate = async args => args.inputs.length === 200
    ? { sequences: { tolist: () => [[0n, 99n]] }, token_timestamps: { tolist: () => [[0, 0]] } }
    : generate(args);
  await assert.rejects(transcribeWindows(f.pipeline, Float32Array.from({ length: 1400 }, (_, i) => i)), /仍沒有有效字詞/);
  assert.equal(f.merged.length, 0); assert.equal(f.live(), 0); assert.equal(f.liveTensors(), 0);
});
test('word-window recovery is capped at three intervals and never recursively retries', async () => {
  const f = collapsedFixture(input => input.length === 300);
  await assert.rejects(transcribeWindows(f.pipeline, Float32Array.from({ length: 1400 }, (_, i) => i)), /仍無法對齊/);
  assert.equal(f.generated.length, 10); assert.equal(f.merged.length, 0);
  assert.equal(f.live(), 0); assert.equal(f.liveTensors(), 0);
});
test('fractional final-window recovery preserves exact coverage and tiny invalid windows stop', async () => {
  const f = collapsedFixture(input => input.first === 1200 && input.length === 253);
  const result = await transcribeWindows(f.pipeline, Float32Array.from({ length: 1453 }, (_, i) => i));
  let offset = 0;
  const ranges = f.merged[0].chunks.map(chunk => { offset -= chunk.stride[1]; const start = offset; offset += chunk.stride[0] - chunk.stride[2]; return [start, start + chunk.stride[0]]; });
  assert.ok(Math.abs(ranges.at(-2)[0] - 120) < 1e-8);
  assert.ok(Math.abs(ranges.at(-1)[0] - 128.4) < 1e-8);
  assert.ok(Math.abs(ranges.at(-1)[1] - 145.3) < 1e-8);
  assert.equal(result.processedSeconds, 145.3); assert.equal(result.repairedWindows, 1);
  const tiny = collapsedFixture(() => true);
  await assert.rejects(transcribeWindows(tiny.pipeline, new Float32Array(30)), /仍無法對齊/);
  assert.equal(tiny.generated.length, 1); assert.equal(tiny.live(), 0);
});

test('resilient mode keeps failed recovery text, continues later audio and emits local checkpoints', async () => {
  const f = collapsedFixture(input => input.first === 800 && input.length === 300, true), checkpoints = [];
  f.pipeline.tokenizer.decode = () => 'Recognized window words.';
  const output = await transcribeWindows(f.pipeline, Float32Array.from({ length: 1400 }, (_, i) => i), { allowPartial: true, checkpoint: item => checkpoints.push(item) });
  assert.equal(output.processedSeconds, 140); assert.equal(output.timestampMode, 'mixed');
  assert.ok(output.regions.some(region => region.mode === 'coarse')); assert.ok(output.fallbackChunks.every(item => item.text));
  assert.equal(checkpoints.at(-1).end, 140); assert.ok(output.inferenceWindows <= 13);
  assert.equal(f.live(), 0); assert.equal(f.liveTensors(), 0);
});
test('DTW failure can retain text from a bounded plain recognition attempt', async () => {
  const f = fixture(); let calls = 0;
  f.pipeline.tokenizer.decode = () => 'Words recovered without timing.';
  f.pipeline.model.generate = async args => { calls++; if (args.return_token_timestamps) throw new Error('DTW failed'); return { 0: { tolist: () => [1n, 2n] }, dispose() {} }; };
  const output = await transcribeWindows(f.pipeline, new Float32Array(400), { allowPartial: true });
  assert.equal(output.processedSeconds, 40); assert.equal(calls, 4);
  assert.equal(output.regions.length, 2); assert.ok(output.fallbackChunks.every(item => item.text.includes('recovered')));
  assert.equal(f.live(), 0);
});
test('resilient recovery never replaces recognized text with two empty windows', async () => {
  const f = collapsedFixture(input => input.first === 800 && input.length === 300);
  f.pipeline.tokenizer.decode = tokens => tokens.some(token => token === 1 || token === 2) ? 'Keep these recognized words.' : '';
  const generate = f.pipeline.model.generate;
  f.pipeline.model.generate = async args => args.inputs.first >= 800 && args.inputs.first <= 900 && args.inputs.length === 200
    ? { sequences: { tolist: () => [[0n, 99n]] }, token_timestamps: { tolist: () => [[0, 0]] } }
    : generate(args);
  const output = await transcribeWindows(f.pipeline, Float32Array.from({ length: 1400 }, (_, i) => i), { allowPartial: true });
  assert.ok(output.fallbackChunks.some(item => item.start === 80 && item.end === 110 && item.text.includes('Keep these')));
  assert.equal(output.processedSeconds, 140);
});
test('persistent inference failure retains partial progress and never swallows explicit cancellation', async () => {
  const f = fixture(); let calls = 0;
  f.pipeline.model.generate = async () => { calls++; throw new Error('model unavailable'); };
  const output = await transcribeWindows(f.pipeline, new Float32Array(1400), { allowPartial: true });
  assert.equal(calls, 4); assert.equal(output.processedSeconds, 50); assert.equal(output.incomplete, true);
  assert.ok(output.missingRanges.some(range => range[0] === 50 && range[1] === 140)); assert.equal(f.live(), 0);
  f.pipeline.model.generate = async () => { throw new DOMException('Cancelled', 'AbortError'); };
  await assert.rejects(transcribeWindows(f.pipeline, new Float32Array(300), { allowPartial: true }), { name: 'AbortError' }); assert.equal(f.live(), 0);
});
test('a failed cross-window merge is isolated while independently valid word regions survive', async () => {
  const f = fixture(); f.pipeline.tokenizer.decode = () => 'Available words.';
  f.pipeline.tokenizer._decode_asr = chunks => {
    if (chunks.length > 1) throw new Error('Unstable overlap');
    return ['Available words.', { chunks: [{ timestamp: [0, 1], text: 'Available words.' }] }];
  };
  const output = await transcribeWindows(f.pipeline, new Float32Array(400), { allowPartial: true });
  assert.equal(output.timestampMode, 'mixed'); assert.equal(output.regions.length, 2);
  assert.deepEqual(output.regions.map(region => region.chunks[0].timestamp), [[0, 1], [20, 21]]);
  assert.deepEqual(output.boundaries, [[20, 30]]); assert.equal(output.processedSeconds, 40);
});
