import { appleLookupURL, normalizeSegments, checkDecodedAudio } from './core.mjs?v=0.2.8';
import { checkDuration } from './library.mjs?v=0.2.8';
import { isMP3, decodeInWorker } from './decode.mjs?v=0.2.8';
import { publicAudioURL, readJSON } from './network.mjs?v=0.2.8';

const MAX_BYTES = 250 * 1024 * 1024;
const cancelled = signal => { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); };
export async function podcastSource(link, settings, { signal, fetchImpl = fetch } = {}) {
  const lookup = appleLookupURL(link);
  const response = await fetchImpl(lookup.url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (!response.ok) throw new Error('無法查詢 Podcast 來源，請稍後再試。');
  const data = await readJSON(response, { signal, maxBytes: 4 * 1024 * 1024, allowJavaScriptType: true }); cancelled(signal);
  const episode = Array.isArray(data?.results) ? data.results.find(item => item && String(item.trackId) === lookup.episode) : undefined;
  if (!episode?.episodeUrl) throw new Error('在公開近期清單中找不到這集，無法匯入。請確認單集連結或改用其他單集。');
  // Reject known oversized episodes BEFORE downloading the media. Unknown
  // durations require the downloaded file metadata check before any decoding.
  if (Number.isFinite(episode.trackTimeMillis) && episode.trackTimeMillis > 0) checkDuration(episode.trackTimeMillis / 1000, settings);
  const url = publicAudioURL(episode.episodeUrl);
  return { title: typeof episode.trackName === 'string' ? episode.trackName.slice(0, 1000) : 'Podcast 單集', show: typeof episode.collectionName === 'string' ? episode.collectionName.slice(0, 1000) : '', url: url.href, link, type: 'podcast' };
}
export async function downloadSource(source, { signal, progress = () => {}, fetchImpl = fetch } = {}) {
  const url = publicAudioURL(source.url);
  const response = await fetchImpl(url.href, { signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'follow' });
  if (!response.ok || response.status === 206) {
    await response.body?.cancel().catch(() => {}); throw new Error('來源未提供完整音檔或禁止跨站下載，已停止匯入。');
  }
  try { if (response.url) publicAudioURL(response.url); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  if (!(type.startsWith('audio/') || ['application/octet-stream', 'binary/octet-stream', 'application/ogg', 'application/mp4', 'video/mp4', 'video/webm'].includes(type))) {
    await response.body?.cancel().catch(() => {}); throw new Error('來源回傳的不是支援的音訊資料，已停止匯入。');
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) {
    await response.body?.cancel().catch(() => {}); throw new Error('來源音檔超過 250 MB，已停止匯入。');
  }
  if (!response.body?.getReader) throw new Error('來源沒有可讀取的音訊資料。');
  const reader = response.body.getReader(), parts = []; let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      cancelled(signal);
      const { value, done } = await reader.read(); cancelled(signal); if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error('來源音檔超過 250 MB，已停止匯入。');
      parts.push(value); progress(declared ? size / declared : null);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
  cancelled(signal);
  if (!size || (declared && declared !== size)) throw new Error('音檔下載不完整，已停止匯入。');
  return new Blob(parts, { type });
}
export function audioDuration(blob, { signal, AudioClass = Audio, urlAPI = URL } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const url = urlAPI.createObjectURL(blob), probe = new AudioClass(); let settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const seconds = probe.duration;
      probe.onloadedmetadata = probe.onerror = null; probe.removeAttribute('src'); probe.load(); urlAPI.revokeObjectURL(url);
      if (error) reject(error); else if (!Number.isFinite(seconds) || seconds <= 0) reject(new Error('無法取得音訊長度，已停止匯入。')); else resolve(seconds);
    };
    const abort = () => finish(new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('讀取音訊長度逾時。')), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    probe.onloadedmetadata = () => finish(); probe.onerror = () => finish(new Error('瀏覽器無法讀取這份音訊。'));
    probe.preload = 'metadata'; probe.src = url;
  });
}
export function workerTranscript(samples, { language, model, signal, progress = () => {}, createWorker = () => new Worker(new URL('./transcriber.mjs?v=0.2.8', import.meta.url), { type: 'module' }) } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const worker = createWorker(); let settled = false;
    const finish = (error, output) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = null; worker.terminate(); if (error) reject(error); else resolve(output);
    };
    const abort = () => finish(new DOMException('已取消', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'progress') progress(data.message);
      else if (data.type === 'complete') finish(null, data);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    worker.onerror = () => finish(new Error('無法啟動字幕轉錄，請確認連線後重試。'));
    try { worker.postMessage({ type: 'transcribe', samples, language, model }, [samples.buffer]); } catch (error) { finish(error); }
  });
}
export async function decodeAudio(blob, duration, { signal, progress = () => {}, name = '', ContextClass = globalThis.OfflineAudioContext } = {}) {
  const bytes = await blob.arrayBuffer(); cancelled(signal);
  if (isMP3({ name, type: blob.type }, new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4)))) return decodeInWorker(bytes, { duration, signal, progress });
  if (!ContextClass) throw new Error('此裝置不支援音訊解碼。');
  const decoded = await new ContextClass(1, 1, 16000).decodeAudioData(bytes); cancelled(signal);
  checkDecodedAudio(decoded.length, decoded.sampleRate, duration);
  if (decoded.sampleRate !== 16000) throw new Error('瀏覽器沒有回傳預期的取樣率，已停止匯入。');
  const samples = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / decoded.numberOfChannels;
  }
  return { samples, decoder: 'Web Audio' };
}
export async function importPodcast(link, settings, {
  signal, progress = () => {}, resolve = podcastSource, download = downloadSource,
  durationOf = audioDuration, decode = decodeAudio, transcribe = workerTranscript
} = {}) {
  const started = performance.now();
  cancelled(signal); progress({ stage: 'source', message: '正在確認來源與音訊長度…' });
  const source = await resolve(link, settings, { signal }); cancelled(signal);
  progress({ stage: 'download', message: '正在下載音訊…' });
  const blob = await download(source, { signal, progress: fraction => progress({ stage: 'download', message: fraction === null ? '正在下載音訊…' : `正在下載音訊 ${Math.round(fraction * 100)}%`, fraction }) }); cancelled(signal);
  const transcript = await transcribeSavedAudio(blob, settings, { signal, progress, durationOf, decode, transcribe, started, name: new URL(source.url).pathname });
  return { blob, track: { title: source.title, show: source.show, source: source.type, sourceURL: source.link, ...transcript, size: blob.size, type: blob.type, language: settings.language, position: 0, createdAt: Date.now() } };
}

// The same full-length guards apply to a saved recording. No source lookup,
// download or persistence happens here; the caller commits only after success.
export async function transcribeSavedAudio(blob, settings, {
  signal, progress = () => {}, durationOf = audioDuration, decode = decodeAudio,
  transcribe = workerTranscript, started = performance.now(), name = ''
} = {}) {
  cancelled(signal);
  const duration = await durationOf(blob, { signal }); cancelled(signal); checkDuration(duration, settings);
  progress({ stage: 'decode', message: '正在解碼完整音訊…' });
  const decoded = await decode(blob, duration, { signal, name, progress: message => progress({ stage: 'decode', message }) }); cancelled(signal);
  const decodedSeconds = checkDecodedAudio(decoded.samples.length, 16000, duration);
  const decodeSeconds = (performance.now() - started) / 1000;
  progress({ stage: 'transcribe', message: '正在準備字幕模型…' });
  const output = await transcribe(decoded.samples, { signal, language: settings.language, model: settings.model, progress: message => progress({ stage: 'transcribe', message }) }); cancelled(signal);
  if (!Number.isFinite(output.processedSeconds) || Math.abs(output.processedSeconds - decodedSeconds) > 0.1) throw new Error('字幕轉錄沒有走完整份音訊，已停止匯入。');
  const segments = normalizeSegments(output.chunks, duration);
  return { duration, segments, metrics: { ...output.metrics, decoder: decoded.decoder, decodedSeconds, decodeSeconds, totalSeconds: (performance.now() - started) / 1000 } };
}
