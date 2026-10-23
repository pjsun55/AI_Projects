export const GEMINI_KEY = 'gemini-key-v1';
export function validateApiKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(value)) throw Error('請輸入有效格式的 Gemini API Key。');
  return value;
}
export async function encryptApiKey(value) {
  let key = validateApiKey(value);
  const bytes = new TextEncoder().encode(key);
  try {
    if (!globalThis.crypto?.subtle) throw Error('這個瀏覽器無法使用安全的本機加密，未儲存 Key。');
    const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(GEMINI_KEY) }, cryptoKey, bytes);
    return { schema: 1, id: crypto.randomUUID(), cryptoKey, iv, ciphertext };
  } finally { key = ''; bytes.fill(0); }
}
export async function decryptApiKey(record) {
  try {
    if (record?.schema !== 1 || typeof record.id !== 'string' || record.cryptoKey?.extractable !== false || record.cryptoKey.type !== 'secret' || record.cryptoKey.algorithm?.name !== 'AES-GCM' || record.iv?.byteLength !== 12 || record.ciphertext?.byteLength < 16 || record.ciphertext.byteLength > 1024) throw Error();
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(GEMINI_KEY) }, record.cryptoKey, record.ciphertext));
    try { return validateApiKey(new TextDecoder().decode(bytes)); } finally { bytes.fill(0); }
  } catch { throw Error('無法讀取已保存的 Key，請至設定重新輸入。'); }
}
