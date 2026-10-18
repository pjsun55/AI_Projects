// Keep the pinned Whisper pipeline's strides and tokenizer, with a numeric
// overlap merger for word timing. Release one window at a time and verify
// that the entire input was visited before reporting completion.
// https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/src/pipelines.js
export async function transcribeWindows(pipeline, samples, { language = 'en', progress = () => {}, timestampMode = 'word', allowPartial = false, checkpoint = () => {} } = {}) {
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
  let processedSeconds = 0, completed = 0, repairedWindows = 0, inferenceWindows = 0, extraInferences = 0, consecutiveFailures = 0;
  const missingRanges = [], warningCodes = new Set();
  const special = new Set(pipeline.tokenizer.all_special_ids || []);
  const hasTextVocabulary = Number.isFinite(pipeline.tokenizer.timestamp_begin);
  const generateWindow = async (offset, end, plain = false) => {
    const timed = wordTiming && !plain;
    let feature, generated;
    try {
      feature = await pipeline.processor(samples.subarray(offset, end));
      inferenceWindows++;
      generated = await pipeline.model.generate({
        inputs: feature.input_features,
        return_timestamps: plain ? false : !wordTiming,
        ...(timed ? { return_token_timestamps: true } : plain ? { return_token_timestamps: false } : {}),
        // v3.8.1's DTW extractor slices encoder attention frames directly.
        // Their time step is 20 ms, versus 10 ms for input mel frames.
        num_frames: timed ? Math.min(pipeline.model.config.max_source_positions, Math.ceil((end - offset) / rate / timePrecision)) : Math.floor((end - offset) / config.hop_length),
        ...(language !== 'en' ? { language, task: 'transcribe' } : {})
      });
      const tokens = timed ? generated.sequences?.tolist()?.[0] : generated[0].tolist();
      if (!Array.isArray(tokens) || !tokens.length || tokens.length > 1024 || tokens.some(token => !Number.isSafeInteger(Number(token)) || Number(token) < 0 || Number(token) > 1000000)) throw new Error('某段音訊沒有回傳有效轉錄結果。');
      let text = '';
      if (allowPartial && typeof pipeline.tokenizer.decode === 'function') {
        try { text = pipeline.tokenizer.decode(tokens.map(Number), { skip_special_tokens: true }).trim().slice(0, 20000); } catch { /* Audio can still be retained. */ }
      }
      const times = timed ? generated.token_timestamps?.tolist()?.[0] : undefined;
      const validTimes = !timed || Array.isArray(times) && times.length === tokens.length && times.every((time, i) => Number.isFinite(time) && time >= 0 && time <= (end - offset) / rate + 0.1 && (!i || time >= times[i - 1]));
      if (!validTimes && !allowPartial) throw new Error('模型未提供有效的逐字時間，已停止，原有字幕保持不變。');
      const tokenTimes = timed && validTimes ? times.map(time => Math.round(time * 100) / 100) : undefined;
      const textPositions = timed && hasTextVocabulary ? tokens.flatMap((token, i) => !special.has(Number(token)) && Number(token) < pipeline.tokenizer.timestamp_begin ? [i] : []) : [];
      const collapsed = !!tokenTimes && textPositions.length > 0 && textPositions.every(i => tokenTimes[i + 1] === tokenTimes[i]);
      return { tokens, ...(tokenTimes ? { token_timestamps: tokenTimes } : {}), offset, end, collapsed, textCount: textPositions.length, text, timingValid: validTimes && !collapsed && !plain, plain };

    } finally {
      try { releaseTensors(generated); }
      finally { releaseTensors(feature?.input_features); }
    }
  };
  const attempt = async (offset, end, extra = false) => {
    if (extra) extraInferences++;
    try { return await generateWindow(offset, end); }
    catch (error) {
      if (!allowPartial || error.name === 'AbortError') throw error;
      warningCodes.add('window-inference');
      // DTW can fail after recognition. A bounded text-only attempt may still
      // recover words; it never claims word timing or changes the model.
      if (!extra && extraInferences < 6) {
        extraInferences++;
        try { return await generateWindow(offset, end, true); }
        catch (retryError) { if (retryError.name === 'AbortError') throw retryError; }
      }
      return { tokens: [], text: '', offset, end, timingValid: false, missing: true };
    }
  };
  const publish = chunk => {
    if (!allowPartial) return;
    checkpoint({ start: chunk.offset / rate, end: chunk.end / rate, text: chunk.text || '', timingUncertain: true });
  };
  for (let offset = 0; offset < samples.length; offset += jump) {
    const end = Math.min(offset + window, samples.length), last = end === samples.length;
    const chunk = await attempt(offset, end);
    let selected = [chunk];
    if (chunk.collapsed || allowPartial && !chunk.timingValid && !chunk.plain && !chunk.missing) {
      if (repairedWindows >= 3 || extraInferences > 4 || end - offset < 4 * rate) {
        if (!allowPartial) throw new Error('某段音訊的字詞時間仍無法對齊，請切換模型後重試；原有收藏保持不變。');
        warningCodes.add('coarse-window');
      } else {
        repairedWindows++;
        progress({ window: completed + 1, total, processedSeconds, audioSeconds: samples.length / rate, recovering: true });
        const length = Math.ceil((end - offset) * 2 / 3), replacements = [];
        for (const [start, stop] of [[offset, offset + length], [end - length, end]]) {
          const replacement = await attempt(start, stop, true);
          if (!allowPartial && replacement.collapsed) throw new Error('縮短音訊視窗後仍無法取得有效字詞時間，請切換模型後重試；原有收藏保持不變。');
          replacements.push(replacement);
        }
        if (!allowPartial && !replacements.some(item => item.textCount > 0)) throw new Error('重新對齊後仍沒有有效字詞，已停止，原有收藏保持不變。');
        const replacementText = replacements.reduce((sum, item) => sum + (item.text?.length || 0), 0);
        if (!allowPartial || replacements.some(item => item.text || item.textCount > 0) && (replacements.every(item => item.timingValid) || replacementText > (chunk.text?.length || 0))) selected = replacements;
        else warningCodes.add('coarse-window');
      }
    }
    for (const item of selected) {
      chunks.push(item); publish(item);
      if (item.missing) missingRanges.push([item.offset / rate, item.end / rate]);
      else if (!item.timingValid) warningCodes.add('coarse-window');
    }
    consecutiveFailures = selected.every(item => item.missing) ? consecutiveFailures + 1 : 0;
    processedSeconds = end / rate;
    progress({ window: ++completed, total, processedSeconds, audioSeconds: samples.length / rate });
    if (last) break;
    if (allowPartial && consecutiveFailures >= 2) { missingRanges.push([processedSeconds, samples.length / rate]); warningCodes.add('inference-interrupted'); break; }
  }
  if (processedSeconds * rate < samples.length - 1 && !allowPartial) throw new Error('音訊仍有未處理的部分，不能標示轉錄完成。');
  // Neighboring windows own half their physical overlap. This keeps absolute
  // offsets correct for ordinary 30 s windows and shorter recovery windows.
  const outputs = chunks.map((chunk, i) => ({
    tokens: chunk.tokens, ...(wordTiming ? { token_timestamps: chunk.token_timestamps } : {}),
    stride: [(chunk.end - chunk.offset) / rate, i ? (chunks[i - 1].end - chunk.offset) / rate / 2 : 0, i + 1 < chunks.length ? (chunk.end - chunks[i + 1].offset) / rate / 2 : 0],
    is_last: i === chunks.length - 1
  }));
  // Use numeric absolute times when resolving overlap. v3.8.1's default
  // merger compares [start,end] arrays, which orders them as strings.
  const tokenizer = wordTiming ? Object.assign(Object.create(pipeline.tokenizer), { findLongestCommonSequence: mergeTimedTokens }) : pipeline.tokenizer;
  const metadata = { timestampMode, processedSeconds, audioSeconds: samples.length / rate, windowCount: chunks.length, repairedWindows, inferenceWindows };
  const fallbackChunks = chunks.filter(chunk => chunk.text).map(chunk => ({ start: chunk.offset / rate, end: chunk.end / rate, text: chunk.text, timingUncertain: true }));
  const regions = [], boundaries = [];
  const decodeRegion = list => {
    if (!list.length) return;
    const fallback = list.filter(item => item.text).map(item => ({ start: item.offset / rate, end: item.end / rate, text: item.text, timingUncertain: true }));
    const base = list[0].offset / rate;
    try {
      const local = list.map((chunk, i) => ({ tokens: chunk.tokens, ...(wordTiming ? { token_timestamps: chunk.token_timestamps } : {}), stride: [(chunk.end - chunk.offset) / rate, i ? (list[i - 1].end - chunk.offset) / rate / 2 : 0, i + 1 < list.length ? (chunk.end - list[i + 1].offset) / rate / 2 : 0] }));
      const [, optional] = tokenizer._decode_asr(local, { time_precision: timePrecision, return_timestamps: wordTiming ? 'word' : true, force_full_sequences: false });
      regions.push({ mode: wordTiming ? 'word' : 'segment', chunks: (optional.chunks || []).map(item => ({ ...item, timestamp: item.timestamp?.map(time => Number.isFinite(time) ? time + base : time) })), fallbackChunks: fallback });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (list.length > 1) {
        const middle = Math.floor(list.length / 2);
        boundaries.push([list[middle].offset / rate, list[middle - 1].end / rate]);
        decodeRegion(list.slice(0, middle)); decodeRegion(list.slice(middle));
      } else regions.push({ mode: 'coarse', chunks: [], fallbackChunks: fallback });
    }
  };
  try {
    if (allowPartial && chunks.some(chunk => !chunk.timingValid)) throw new Error('Coarse windows present');
    const [text, optional] = tokenizer._decode_asr(outputs, { time_precision: timePrecision, return_timestamps: wordTiming ? 'word' : true, force_full_sequences: false });
    return { text, ...optional, ...metadata, ...(allowPartial ? { fallbackChunks, regions: [{ mode: wordTiming ? 'word' : 'segment', chunks: optional.chunks || [], fallbackChunks }], missingRanges, warningCodes: [...warningCodes], incomplete: missingRanges.length > 0 } : {}) };
  } catch (error) {
    if (!allowPartial || error.name === 'AbortError') throw error;
    warningCodes.add('alignment-fallback');
    let run = [];
    for (const chunk of chunks) {
      if (chunk.timingValid) run.push(chunk);
      else { decodeRegion(run); run = []; if (chunk.text) regions.push({ mode: 'coarse', chunks: [], fallbackChunks: [{ start: chunk.offset / rate, end: chunk.end / rate, text: chunk.text, timingUncertain: true }] }); }
    }
    decodeRegion(run);
    return { ...metadata, timestampMode: 'mixed', chunks: [], regions, fallbackChunks, boundaries, missingRanges, warningCodes: [...warningCodes], incomplete: missingRanges.length > 0 };
  }

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
