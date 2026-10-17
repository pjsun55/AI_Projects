// These checks reject known local destinations. A browser cannot resolve DNS
// ahead of fetch, so they are not a substitute for server-side SSRF controls.
export function publicAudioURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('音訊來源網址無效。');
  let url;
  try { url = new URL(value); } catch { throw new Error('音訊來源網址無效。'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      labels.length < 2 || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
      !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('音訊來源必須是公開 HTTPS 網域，不能使用本機／內網位址、帳密或自訂連接埠。');
  }
  return url;
}

export async function readJSON(response, { maxBytes = 2 * 1024 * 1024, signal, allowJavaScriptType = false } = {}) {
  const abortError = () => new DOMException('已取消', 'AbortError');
  const cancelled = () => { if (signal?.aborted) throw abortError(); };
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!(type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type || '') || allowJavaScriptType && type === 'text/javascript')) {
    await response.body?.cancel().catch(() => {});
    throw new Error('外部服務沒有回傳有效的 JSON 資料。');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('外部服務回應超過大小限制，已停止。');
  }
  if (!response.body?.getReader) throw new Error('外部服務沒有可讀取的資料。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    cancelled();
    while (true) {
      const { value, done } = await reader.read(); cancelled(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('外部服務回應超過大小限制，已停止。');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new Error('外部服務的 JSON 格式無效。'); }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
