// The native player and decodeAudioData can disagree on concatenated podcast MP3s.
// Decode MP3 bytes independently, then send only checked 16 kHz mono PCM to ASR.
export const MP3_DECODER_URL = 'https://cdn.jsdelivr.net/npm/mpg123-decoder@1.0.2/+esm';
export const SAMPLE_RATE = 16000;

export function isMP3(file, header) {
  if (/\.mp3$/i.test(file.name) || /^audio\/(mpeg|mp3)(?:;|$)/i.test(file.type)) return true;
  if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) return true;
  return header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 6) === 2;
}

export function decodeInWorker(bytes, { duration, signal, progress = () => {}, createWorker = () => new Worker(new URL('./decoder.mjs?v=0.2.8', import.meta.url), { type: 'module' }) } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const worker = createWorker(); let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = null; worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new DOMException('已取消', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'progress') progress(data.message);
      else if (data.type === 'complete') finish(null, data);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    worker.onerror = () => finish(new Error('無法載入 MP3 解碼器，請確認連線後重試。'));
    try { worker.postMessage({ type: 'decode', bytes, duration }, [bytes]); }
    catch (error) { finish(error); }
  });
}

// Stateful windowed-sinc resampler: retain the filter history and fractional
// position across decoded chunks, rather than rounding each chunk separately.
export function createResampler(inputRate, outputRate = SAMPLE_RATE) {
  if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000 || !Number.isFinite(outputRate) || outputRate < 8000 || outputRate > 192000) throw new Error('不支援的音訊取樣率。');
  const radius = 24, taps = radius * 2, phases = 1024;
  const cutoff = 0.46 * Math.min(1, outputRate / inputRate);
  const coefficients = new Float32Array(phases * taps);
  for (let phase = 0; phase < phases; phase++) {
    let total = 0;
    for (let tap = 0; tap < taps; tap++) {
      const distance = tap - radius + 1 - phase / phases;
      const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
      const window = 0.42 + 0.5 * Math.cos(Math.PI * distance / radius) + 0.08 * Math.cos(2 * Math.PI * distance / radius);
      const value = sinc * window;
      coefficients[phase * taps + tap] = value; total += value;
    }
    for (let tap = 0; tap < taps; tap++) coefficients[phase * taps + tap] /= total;
  }
  let history = new Float32Array(), inputCount = 0, outputCount = 0, finished = false;
  return {
    push(channels, final = false) {
      if (finished) throw new Error('音訊重採樣已結束。');
      if (!Array.isArray(channels) || !channels.length || channels.some(c => c.length !== channels[0].length)) throw new Error('音訊聲道長度不符。');
      const length = channels[0].length;
      const buffer = new Float32Array(history.length + length), base = inputCount - history.length;
      buffer.set(history);
      for (const channel of channels) for (let i = 0; i < length; i++) buffer[history.length + i] += channel[i] / channels.length;
      inputCount += length;
      const target = final ? Math.floor(inputCount * outputRate / inputRate) : Math.max(0, Math.ceil((inputCount - radius) * outputRate / inputRate));
      const result = new Float32Array(Math.max(0, target - outputCount));
      for (let i = 0; i < result.length; i++, outputCount++) {
        const position = outputCount * inputRate / outputRate, center = Math.floor(position);
        const phase = Math.min(phases - 1, Math.floor((position - center) * phases));
        let value = 0;
        for (let tap = 0; tap < taps; tap++) {
          const index = Math.max(0, Math.min(inputCount - 1, center + tap - radius + 1)) - base;
          value += buffer[index] * coefficients[phase * taps + tap];
        }
        result[i] = value;
      }
      history = buffer.slice(Math.max(0, buffer.length - taps));
      finished = final;
      return result;
    }
  };
}

export async function decodeMP3(bytes, { loadDecoder = () => import(MP3_DECODER_URL), progress = () => {} } = {}) {
  const { MPEGDecoder } = await loadDecoder();
  const decoder = new MPEGDecoder();
  let resampler, sourceRate, ready = false, sourceSamples = 0, outputSamples = 0;
  const parts = [], chunkSize = 256 * 1024;
  try {
    await decoder.ready;
    ready = true;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const decoded = decoder.decode(bytes.subarray(offset, offset + chunkSize));
      if (decoded.errors?.length) throw new Error('MP3 含有無法解碼的片段，請改用完整音檔或匯入字幕。');
      if (decoded.samplesDecoded) {
        if (sourceRate && decoded.sampleRate !== sourceRate) throw new Error('MP3 中途變更取樣率，請先轉成單一取樣率的 WAV 或匯入字幕。');
        sourceRate = decoded.sampleRate;
        resampler ??= createResampler(sourceRate);
        sourceSamples += decoded.samplesDecoded;
        const part = resampler.push(decoded.channelData);
        parts.push(part); outputSamples += part.length;
      }
      progress({ bytesRead: Math.min(offset + chunkSize, bytes.length), totalBytes: bytes.length, decodedSeconds: sourceSamples / (sourceRate || 1) });
    }
    if (!resampler) throw new Error('MP3 未解碼出可用的聲音。');
    const tail = resampler.push([new Float32Array()], true);
    parts.push(tail); outputSamples += tail.length;
    const samples = new Float32Array(outputSamples);
    let offset = 0;
    for (let i = 0; i < parts.length; i++) { samples.set(parts[i], offset); offset += parts[i].length; parts[i] = null; }
    return { samples, decoder: 'mpg123-decoder@1.0.2', sourceRate, sourceSamples };
  } finally { if (ready) decoder.free(); }
}
