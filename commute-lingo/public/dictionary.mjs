import { readJSON } from './network.mjs?v=0.2.19';
import { normalizeWord, wordIdentity, normalizeDictionary, LANGUAGES } from './vocabulary.mjs?v=0.2.19';

export async function lookupDictionary(word, language, { signal, fetchImpl = globalThis.fetch } = {}) {
  word = normalizeWord(word);
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error('單字語言無效。');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 12000);
  try {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const response = await fetchImpl(`https://freedictionaryapi.com/api/v1/entries/${language}/${encodeURIComponent(word)}`, { signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(response.status === 429 ? '字典查詢頻率已達限制，請稍後重試。' : '字典暫時無法查詢；單字已保留。'); }
    const body = await readJSON(response, { signal: controller.signal, maxBytes: 256 * 1024 });
    if (!body || typeof body.word !== 'string' || !Array.isArray(body.entries) || body.entries.length > 100 || !body.source || body.source.license?.name !== 'CC BY-SA 4.0') throw new Error('字典回應格式不符，未保存內容。');
    if (wordIdentity(body.word, language) !== wordIdentity(word, language)) throw new Error('字典回傳的單字不符，未保存內容。');
    const senses = []; let phonetic = '';
    for (const entry of body.entries) {
      if (entry?.language?.code !== language) continue;
      if (!phonetic && Array.isArray(entry.pronunciations)) phonetic = entry.pronunciations.find(item => item?.type === 'ipa' && typeof item.text === 'string')?.text?.slice(0, 120) || '';
      if (!Array.isArray(entry.senses) || typeof entry.partOfSpeech !== 'string') continue;
      for (const sense of entry.senses.slice(0, 20)) {
        if (typeof sense?.definition !== 'string' || !sense.definition.trim()) continue;
        senses.push({ partOfSpeech: entry.partOfSpeech.slice(0, 50), definition: sense.definition.trim().slice(0, 400) });
        if (senses.length === 4) break;
      }
      if (senses.length === 4) break;
    }
    if (!senses.length) throw new Error('字典尚無這個單字的釋義，可自行填寫中文解釋。');
    return normalizeDictionary({ phonetic, senses, sourceURL: body.source.url }, word);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (controller.signal.aborted) throw new Error('字典查詢逾時；單字已保留，可稍後重試。');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
