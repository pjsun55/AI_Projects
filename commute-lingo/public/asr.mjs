// The pinned Transformers.js 3.8.1 Whisper pipeline uses these same strides
// and tokenizer merger. Process and release one window at a time so we can
// verify the entire input was visited and report real progress to the UI.
// https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/src/pipelines.js
export async function transcribeWindows(pipeline, samples, { language = 'en', progress = () => {} } = {}) {
  const config = pipeline.processor.feature_extractor.config;
  const rate = config.sampling_rate;
  const window = config.chunk_length * rate;
  const stride = 5 * rate;
  const jump = window - 2 * stride;
  if (!samples?.length || !Number.isFinite(rate) || jump <= 0 || typeof pipeline.tokenizer._decode_asr !== 'function') throw new Error('語音模型或音訊長度不正確。');
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
        return_timestamps: true,
        num_frames: Math.floor((end - offset) / config.hop_length),
        ...(language !== 'en' ? { language, task: 'transcribe' } : {})
      });
      const tokens = generated[0].tolist();
      if (!Array.isArray(tokens) || !tokens.length) throw new Error('某段音訊沒有回傳有效轉錄結果。');
      chunks.push({ tokens, stride: [(end - offset) / rate, offset === 0 ? 0 : 5, last ? 0 : 5], is_last: last });
    } finally {
      generated?.dispose?.();
      feature?.input_features?.dispose?.();
    }
    processedSeconds = end / rate;
    progress({ window: chunks.length, total, processedSeconds, audioSeconds: samples.length / rate });
    if (last) break;
  }
  if (processedSeconds * rate < samples.length - 1) throw new Error('音訊仍有未處理的部分，不能標示轉錄完成。');
  const [text, optional] = pipeline.tokenizer._decode_asr(chunks, {
    time_precision: config.chunk_length / pipeline.model.config.max_source_positions,
    return_timestamps: true,
    force_full_sequences: false
  });
  return { text, ...optional, processedSeconds, audioSeconds: samples.length / rate, windowCount: chunks.length };
}
