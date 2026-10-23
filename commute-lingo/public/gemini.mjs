import { GUIDE_INSTRUCTION, GUIDE_SCHEMA, GUIDE_MAX_INPUT, GUIDE_MODEL, validateGuide } from './guide.mjs?v=0.2.20';
import { validateApiKey } from './key-vault.mjs?v=0.2.20';

export class GeminiError extends Error {
  constructor(code, status) {
    const messages = { TIMEOUT: '導讀等待逾時，可稍後手動重試。', CANCELLED: '導讀已停止。', NETWORK: '無法連線 Gemini，請確認網路後重試。', RESPONSE: 'Gemini 回應不完整或格式無效，未儲存。', TOO_LARGE: 'Gemini 回應超出大小限制，未儲存。', BLOCKED: 'Gemini 未提供可用導讀。' };
    super(status ? ({ 400: 'Gemini 請求或 Key 無效。', 401: 'Gemini Key 驗證未通過。', 403: 'Gemini Key 權限不足，請檢查設定。', 404: 'Gemini 模型不可用。', 429: 'Gemini 額度或頻率受限，請稍後手動重試。' }[status] || 'Gemini 服務暫時無法完成請求。') : messages[code] || '無法完成 Gemini 導讀。');
    this.code = code; if (status) this.status = status;
  }
}
// Exactly one request per invocation. Provider errors, keys and prompts are never logged.
async function request({ key, model, text, signal, progress = () => {}, verify = false, fetchImpl = globalThis.fetch }) {
  validateApiKey(key);
  if (model !== GUIDE_MODEL) throw Error('導讀模型不可用，請使用 3.5 Flash-Lite。');
  if (typeof text !== 'string' || !text.trim() || text.length > GUIDE_MAX_INPUT || text.includes(key)) throw Error('導讀輸入格式或長度無效；每次最多 60,000 字元。');
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, verify ? 60000 : 180000);
  let reader, result = '', finish, bytes = 0, count = 0;
  const usage = {};
  try {
    if (signal?.aborted) throw new GeminiError('CANCELLED');
    const generationConfig = { maxOutputTokens: verify ? 1024 : 8192 };
    if (!verify) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseJsonSchema = GUIDE_SCHEMA; }
    progress('等待 Gemini 回應…');
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: verify ? '只回覆 OK。' : GUIDE_INSTRUCTION }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig })
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new GeminiError('HTTP', response.status); }
    if (!/\btext\/event-stream\b/i.test(response.headers.get('content-type') || '')) throw new GeminiError('RESPONSE');
    reader = response.body?.getReader(); if (!reader) throw new GeminiError('RESPONSE');
    const decoder = new TextDecoder(); let buffer = '', data = [];
    const consume = () => {
      if (!data.length) return;
      const payload = data.join('\n'); data = []; if (payload === '[DONE]') return;
      if (++count > 4096) throw new GeminiError('TOO_LARGE');
      let value; try { value = JSON.parse(payload); } catch { throw new GeminiError('RESPONSE'); }
      const candidate = value?.candidates?.[0];
      if (value?.error || value?.promptFeedback?.blockReason || candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw new GeminiError('BLOCKED');
      if (candidate?.finishReason) finish = candidate.finishReason;
      result += candidate?.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('') || '';
      if (result.length > 65536) throw new GeminiError('TOO_LARGE');
      for (const name of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']) if (Number.isSafeInteger(value.usageMetadata?.[name]) && value.usageMetadata[name] >= 0) usage[name] = value.usageMetadata[name];
      progress(`已收到 ${result.length.toLocaleString()} 字元，正在完成導讀…`);
    };
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > 1024 * 1024) throw new GeminiError('TOO_LARGE');
      buffer += decoder.decode(part.value, { stream: true }); let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) consume(); else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    buffer += decoder.decode();
    if (controller.signal.aborted) throw new GeminiError('CANCELLED');
    if (buffer.trim() || data.length || finish !== 'STOP' || !result.trim()) throw new GeminiError('RESPONSE');
    // Reject rather than render or persist a response containing credential material.
    if (result.includes(key) || /AIza[A-Za-z0-9_-]{20,}/u.test(result)) throw new GeminiError('RESPONSE');
    if (verify) return { usage };
    let parsed; try { parsed = JSON.parse(result); } catch { throw new GeminiError('RESPONSE'); }
    return { content: validateGuide(parsed, text), usage };
  } catch (error) {
    if (controller.signal.aborted) throw new GeminiError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
    if (error instanceof GeminiError) throw error;
    throw new GeminiError(error?.message?.startsWith('導讀') ? 'RESPONSE' : 'NETWORK');
  } finally { key = ''; result = ''; clearTimeout(timer); signal?.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); }
}
export function generateGuide(options) { return request(options); }
export function verifyGeminiKey(options) { return request({ ...options, text: 'Please reply with OK.', verify: true }); }
