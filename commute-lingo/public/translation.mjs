import { splitForTranslation } from './core.mjs?v=0.2.23';
import { readJSON } from './network.mjs?v=0.2.23';
export const translationKey = (source, target, text) => JSON.stringify([source, target, text]);

export function createTranslator({ fetchImpl = globalThis.fetch, load = async () => undefined, save = async () => {}, warn = () => {} } = {}) {
  const memory = new Map();
  const persisted = new Set();
  function cancelled(signal) { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); }
  return {
    entries: () => [...memory.values()],
    clear: () => { memory.clear(); persisted.clear(); },
    async seed(entries) {
      for (const entry of entries) {
        const key = translationKey(entry.source, entry.target, entry.text);
        memory.set(key, entry);
        try { await save(key, entry); persisted.add(key); } catch { warn('翻譯暫存僅保留於本次開啟，下次可能需要重新翻譯。'); }
      }
    },
    async translate(text, source, { signal, target = 'zh-TW' } = {}) {
      text = text.trim();
      const chunks = splitForTranslation(text);
      const key = translationKey(source, target, text);
      cancelled(signal);
      let cached = memory.get(key);
      if (!cached) {
        try { cached = await load(key); if (cached) persisted.add(key); } catch { warn('無法讀取本機翻譯快取。'); }
      }
      cancelled(signal);
      if (cached) { memory.set(key, cached); return { ...cached, cached: true, persisted: persisted.has(key) }; }
      const translated = [];
      for (const chunk of chunks) {
        cancelled(signal);
        const partKey = translationKey(source, target, chunk);
        let part = memory.get(partKey);
        if (!part) {
          try { part = await load(partKey); if (part) persisted.add(partKey); } catch { /* Session cache is still available. */ }
        }
        cancelled(signal);
        if (!part) {
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener('abort', abort, { once: true });
          const timeout = setTimeout(abort, 20000);
          try {
            const url = new URL('https://api.mymemory.translated.net/get');
            url.search = new URLSearchParams({ q: chunk, langpair: `${source}|${target}` });
            const response = await fetchImpl(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
            if (!response.ok) throw new Error(response.status === 429 ? '免費翻譯額度或請求頻率已達限制，請稍後再試。' : `翻譯服務回應 ${response.status}。`);
            const body = await readJSON(response, { signal: controller.signal, maxBytes: 64 * 1024 });
            cancelled(signal);
            if (body?.quotaFinished || Number(body?.responseStatus) === 429 || Number(body?.responseStatus) === 403) throw new Error('免費翻譯額度已用完；已快取的翻譯仍可查看。');
            if (Number(body?.responseStatus) !== 200 || typeof body.responseData?.translatedText !== 'string' || !body.responseData.translatedText.trim() || body.responseData.translatedText.length > 10000) throw new Error('翻譯服務未提供有效結果，請稍後再試。');
            part = { source, target, text: chunk, translation: body.responseData.translatedText };
            memory.set(partKey, part);
            try { await save(partKey, part); persisted.add(partKey); } catch { warn('翻譯暫存僅保留於本次開啟，下次可能需要重新翻譯。'); }
          } catch (error) {
            if (error.name === 'AbortError' && !signal?.aborted) throw new Error('翻譯逾時，請檢查連線後重試。');
            throw error;
          } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
          }
        }
        translated.push(part.translation);
      }
      cancelled(signal);
      const entry = { source, target, text, translation: translated.join('\n') };
      memory.set(key, entry);
      try { await save(key, entry); persisted.add(key); } catch { warn('翻譯暫存僅保留於本次開啟，下次可能需要重新翻譯。'); }
      return { ...entry, cached: false, persisted: persisted.has(key) };
    }
  };
}
