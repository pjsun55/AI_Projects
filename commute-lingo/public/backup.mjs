const encoder = new TextEncoder();
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
