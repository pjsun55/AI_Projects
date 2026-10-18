// Keep the pinned Whisper pipeline's strides and tokenizer, with a numeric
// overlap merger for word timing. Release one window at a time and verify
// that the entire input was visited before reporting completion.
// https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/src/pipelines.js
export async function transcribeWindows(pipeline, samples, { language = 'en', progress = () => {}, timestampMode = 'word' } = {}) {
  if (!['word', 'segment'].includes(timestampMode)) throw new Error('不支援的字幕時間模式。');
  const wordTiming = timestampMode === 'word';
  const config = pipeline.processor.feature_extractor.config;
  const timePrecision = config.chunk_length / pipeline.model.config.max_source_positions;
  const rate = config.sampling_rate;
  const window = config.chunk_length * rate;
  const stride = 5 * rate;
  const jump = window - 2 * stride;
  if (!samples?.length || !Number.isFinite(rate) || jump <= 0 || !Number.isFinite(timePrecision) || timePrecision <= 0 || typeof pipeline.tokenizer._decode_asr !== 'function') throw new Error('語音模型或音訊長度不正確。');
  const chunks = [];
  const total = Math.max(1, Math.ceil((samples.length - window) / jump) + 1);
  let processedSeconds = 0;
  for (let offset = 0; offset < samples.length; offset += jump) {
    const end = Math.min(offset + window, samples.length);
    const last = end === samples.length;
    let feature, generated;
    try {
      feature = await pipeline.processor(samples.subarray(offset, end));
      generated = await pipeline.model.generate({
        inputs: feature.input_features,
        return_timestamps: !wordTiming,
        ...(wordTiming ? { return_token_timestamps: true } : {}),
        // v3.8.1's DTW extractor slices encoder attention frames directly.
        // Their time step is 20 ms, versus 10 ms for input mel frames. Cropping
        // here prevents short final windows aligning words to padded silence.
        num_frames: wordTiming ? Math.min(pipeline.model.config.max_source_positions, Math.ceil((end - offset) / rate / timePrecision)) : Math.floor((end - offset) / config.hop_length),
        ...(language !== 'en' ? { language, task: 'transcribe' } : {})
      });
      const tokens = wordTiming ? generated.sequences?.tolist()?.[0] : generated[0].tolist();
      if (!Array.isArray(tokens) || !tokens.length) throw new Error('某段音訊沒有回傳有效轉錄結果。');
      const times = wordTiming ? generated.token_timestamps?.tolist()?.[0] : undefined;
      if (wordTiming && (!Array.isArray(times) || times.length !== tokens.length || times.some((time, i) => !Number.isFinite(time) || time < 0 || time > (end - offset) / rate + 0.1 || i > 0 && time < times[i - 1]))) throw new Error('模型未提供有效的逐字時間，已停止，原有字幕保持不變。');
      chunks.push({ tokens, ...(wordTiming ? { token_timestamps: times.map(time => Math.round(time * 100) / 100) } : {}), stride: [(end - offset) / rate, offset === 0 ? 0 : 5, last ? 0 : 5], is_last: last });
    } finally {
      // Word timing returns a dictionary of attention tensors, rather than a
      // single tensor. Release every window before processing the next one.
      try { releaseTensors(generated); }
      finally { releaseTensors(feature?.input_features); }
    }
    processedSeconds = end / rate;
    progress({ window: chunks.length, total, processedSeconds, audioSeconds: samples.length / rate });
    if (last) break;
  }
  if (processedSeconds * rate < samples.length - 1) throw new Error('音訊仍有未處理的部分，不能標示轉錄完成。');
  // Use numeric absolute times when resolving overlap. v3.8.1's default
  // merger compares [start,end] arrays, which orders them as strings.
  const tokenizer = wordTiming ? Object.assign(Object.create(pipeline.tokenizer), { findLongestCommonSequence: mergeTimedTokens }) : pipeline.tokenizer;
  const [text, optional] = tokenizer._decode_asr(chunks, {
    time_precision: timePrecision,
    return_timestamps: wordTiming ? 'word' : true,
    force_full_sequences: false
  });
  return { text, ...optional, timestampMode, processedSeconds, audioSeconds: samples.length / rate, windowCount: chunks.length };
}

export function mergeTimedTokens(sequences, timings) {
  if (!Array.isArray(sequences) || !sequences.length || !Array.isArray(timings) || sequences.length !== timings.length) throw new Error('跨段逐字時間資料不完整。');
  const result = [], resultTimes = [];
  let left = sequences[0], leftTimes = timings[0];
  for (let i = 1; i < sequences.length; i++) {
    const right = sequences[i], rightTimes = timings[i];
    let best, score = 0;
    for (let shift = 1; shift < left.length + right.length; shift++) {
      const leftStart = Math.max(0, left.length - shift), rightStart = Math.max(0, shift - left.length);
      const count = Math.min(left.length - leftStart, right.length - rightStart);
      let matches = 0;
      for (let j = 0; j < count; j++) {
        if (left[leftStart + j] === right[rightStart + j] && Math.abs(leftTimes[leftStart + j][0] - rightTimes[rightStart + j][0]) <= 5) matches++;
      }
      const candidate = matches / shift + shift / 10000;
      if (matches > 1 && candidate > score) {
        // Keep a splice whose token starts remain chronological. This retains
        // model anchors without averaging or stretching their time ranges.
        const middle = Math.floor(count / 2), zero = pair => pair[0] === pair[1];
        let cut, penalty = Infinity, leftZero = 0;
        let rightZero = rightTimes.slice(rightStart, rightStart + count).filter(zero).length;
        for (let position = 0; position <= count; position++) {
          const a = leftStart + position, b = rightStart + position;
          // Prefer the window that resolves more of the overlapping tokens
          // to a real span, then break ties near the middle of the overlap.
          const candidatePenalty = (leftZero + rightZero) * (count + 1) + Math.abs(position - middle);
          if ((!a || b === right.length || leftTimes[a - 1][0] <= rightTimes[b][0]) && candidatePenalty < penalty) {
            cut = [a, b]; penalty = candidatePenalty;
          }
          if (position < count) { leftZero += Number(zero(leftTimes[leftStart + position])); rightZero -= Number(zero(rightTimes[rightStart + position])); }
        }
        if (cut) { best = cut; score = candidate; }
      }
    }
    if (!best) {
      // Silence can separate windows with no common words. Overlapping speech
      // without a stable match is rejected rather than guessed or dropped.
      if (left.length && right.length && leftTimes.at(-1)[1] > rightTimes[0][0]) throw new Error('跨段字詞無法穩定對齊，請切換模型後重試。');
      best = [left.length, 0];
    }
    result.push(...left.slice(0, best[0])); resultTimes.push(...leftTimes.slice(0, best[0]));
    left = right.slice(best[1]); leftTimes = rightTimes.slice(best[1]);
  }
  result.push(...left); resultTimes.push(...leftTimes);
  return [result, resultTimes];
}

function releaseTensors(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (typeof value.dispose === 'function') { value.dispose(); return; }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  for (const child of Object.values(value)) releaseTensors(child, seen);
}
