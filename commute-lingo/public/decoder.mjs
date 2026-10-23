import { decodeMP3 } from './decode.mjs?v=0.2.19';
import { checkDecodedAudio, formatTime } from './core.mjs?v=0.2.19';

self.onmessage = async ({ data }) => {
  if (data.type !== 'decode') return;
  try {
    self.postMessage({ type: 'progress', message: '準備 MP3 解碼器；首次使用需要連線…' });
    const output = await decodeMP3(new Uint8Array(data.bytes), {
      progress: event => self.postMessage({ type: 'progress', message: `正在解碼 ${Math.round(event.bytesRead / event.totalBytes * 100)}% · 已讀出 ${formatTime(event.decodedSeconds)}／${formatTime(data.duration)}` })
    });
    checkDecodedAudio(output.samples.length, 16000, data.duration);
    self.postMessage({ type: 'complete', ...output }, [output.samples.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'MP3 解碼失敗，請檢查網路或匯入字幕。' });
  } finally { self.close(); }
};
