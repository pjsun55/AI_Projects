import { transcribeWindows } from './asr.mjs?v=0.2.7';
import { formatTime } from './core.mjs?v=0.2.7';
let pipeline;
self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;
  try {
    const library = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
    library.env.allowLocalModels = false;
    library.env.useFS = false;
    library.env.useFSCache = false;
    library.env.useBrowserCache = false;
    try {
      library.env.customCache = await caches.open('commute-lingo-models-v1');
      library.env.useCustomCache = true;
    } catch {
      library.env.useCustomCache = false;
      self.postMessage({ type: 'progress', message: '模型快取無法使用，本次仍可下載後轉錄。' });
    }
    library.env.backends.onnx.wasm.numThreads = 1;
    library.env.backends.onnx.wasm.proxy = false;
    const model = `Xenova/whisper-${data.model}${data.language === 'en' ? '.en' : ''}`;
    const started = performance.now();
    pipeline = await library.pipeline('automatic-speech-recognition', model, {
      device: 'wasm', dtype: 'q8',
      progress_callback: event => self.postMessage({ type: 'progress', message: event.status === 'progress' ? `下載模型 ${Math.round(event.progress ?? 0)}%` : '準備語音模型…' })
    });
    const ready = performance.now();
    self.postMessage({ type: 'progress', message: '正在轉錄，請保持此頁開啟。' });
    const output = await transcribeWindows(pipeline, data.samples, {
      language: data.language,
      progress: event => self.postMessage({ type: 'progress', message: `已處理 ${formatTime(event.processedSeconds)}／${formatTime(event.audioSeconds)}（${event.window}/${event.total}）` })
    });
    self.postMessage({ type: 'complete', chunks: output.chunks, processedSeconds: output.processedSeconds, metrics: { model, windowCount: output.windowCount, audioSeconds: output.audioSeconds, modelLoadSeconds: (ready - started) / 1000, inferenceSeconds: (performance.now() - ready) / 1000 } });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || '轉錄失敗。' });
  } finally {
    await pipeline?.dispose();
    self.close();
  }
};
