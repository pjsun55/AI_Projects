import { validateSettings, changeSettings } from './library.mjs?v=0.2.19';
import { validateVocabulary, mergeVocabulary } from './vocabulary.mjs?v=0.2.19';

export const PERSONAL_BACKUP_SCHEMA = 'commute-lingo-personal-backup/1';
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const preferenceKeys = ['albumLimit', 'trackLimit', 'maxMinutes', 'autoUpdate', 'subtitleSize', 'icon', 'language', 'model', 'repeatMode', 'autoGuide', 'geminiModel'];
function backupSettings(value) {
  const settings = validateSettings(value);
  return Object.fromEntries(preferenceKeys.map(key => [key, settings[key]]));
}

export function personalBackup(settings, vocabulary, now = new Date()) {
  const book = validateVocabulary(vocabulary);
  const backup = { schema: PERSONAL_BACKUP_SCHEMA, createdAt: now.toISOString(), settings: backupSettings(settings), vocabulary: { ...book, revision: 0 } };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_BACKUP_BYTES) throw new Error('備份超過 32 MB，請先整理過長的筆記或字典內容。');
  return blob;
}
export async function readPersonalBackup(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_BACKUP_BYTES || typeof file.text !== 'function') throw new Error('請選擇不超過 32 MB 的設定與單字本 JSON 備份。');
  let value;
  try { value = JSON.parse(await file.text()); } catch { throw new Error('備份不是有效的 JSON，沒有變更原有資料。'); }
  if (!value || value.schema !== PERSONAL_BACKUP_SCHEMA || typeof value.createdAt !== 'string' || value.createdAt.length > 40 || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('僅支援新版「設定與單字本」JSON 備份；不支援舊收藏 ZIP。');
  const keys = ['schema', 'createdAt', 'settings', 'vocabulary'];
  if (Object.keys(value).some(key => !keys.includes(key)) || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new Error('備份包含非預期的資料欄位，未進行還原。');
  return { schema: PERSONAL_BACKUP_SCHEMA, createdAt: value.createdAt, settings: backupSettings(value.settings), vocabulary: validateVocabulary(value.vocabulary) };
}
export function planPersonalRestore(library, vocabulary, backup, { restoreSettings = false, ...options } = {}) {
  if (backup.schema !== PERSONAL_BACKUP_SCHEMA) throw new Error('備份格式無效。');
  const nextLibrary = restoreSettings ? changeSettings(library, backup.settings) : library;
  return { library: nextLibrary, ...mergeVocabulary(vocabulary, backup.vocabulary, options) };
}

// Legacy ZIP encoder is retained for existing callers/tests; the app's personal
// backup path above never reads or exports audio, albums or translation caches.
const table = Uint32Array.from({ length: 256 }, (_, i) => { let n = i; for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export async function crc32(blob, signal) {
  let value = 0xffffffff;
  const reader = blob.stream().getReader();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const { value: bytes, done } = await reader.read(); if (done) break;
      for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return (value ^ 0xffffffff) >>> 0;
}
// ZIP STORE references the existing Blob parts and never base64-duplicates an
// entire library into a giant JSON string. Each checksum streams one file.
export async function zipFiles(files, { signal } = {}) {
  const parts = [], directory = []; let offset = 0, directorySize = 0;
  if (files.length > 65535) throw new Error('備份檔案數量過多。');
  for (const { name, blob } of files) {
    if (/^\/|(^|\/)\.\.(\/|$)|\\/.test(name)) throw new Error('備份檔案名稱無效。');
    const filename = encoder.encode(name), crc = await crc32(blob, signal);
    if (blob.size > 0xffffffff || offset + blob.size > 0xffffffff) throw new Error('備份超過 ZIP 大小限制，請先減少收藏。');
    const local = new Uint8Array(30), view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint32(14, crc, true); view.setUint32(18, blob.size, true); view.setUint32(22, blob.size, true); view.setUint16(26, filename.length, true);
    parts.push(local, filename, blob);
    const central = new Uint8Array(46), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, blob.size, true); cv.setUint32(24, blob.size, true); cv.setUint16(28, filename.length, true); cv.setUint32(42, offset, true);
    directory.push(central, filename); directorySize += 46 + filename.length; offset += 30 + filename.length + blob.size;
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
