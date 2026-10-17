const DB_NAME = 'commute-lingo-v1';
let connection;
function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('瀏覽器不支援本機保存。'));
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => { connection = undefined; reject(new Error('請關閉其他 CommuteLingo 分頁後重試。')); };
  });
  return connection;
}
export async function read(key) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readonly');
    const req = tx.objectStore('data').get(key);
    let value;
    req.onsuccess = () => { value = req.result; };
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(tx.error ?? req.error ?? new Error('讀取失敗。'));
  });
}
export async function write(key, value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite');
    tx.objectStore('data').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('保存失敗，可能儲存空間不足。'));
  });
}
export async function clear() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite');
    tx.objectStore('data').clear();
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('清除失敗。'));
  });
}

// Library metadata and audio replacement must succeed in one transaction. A
// quota failure or stale tab must leave the old episode and album intact.
export async function commitLibrary(library, { expectedRevision, audio, removeIds = [], removeSession = false } = {}) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data');
    let failure;
    const request = store.get('library-v2');
    request.onsuccess = () => {
      try {
        if ((request.result?.revision ?? 0) !== expectedRevision) throw new Error('另一個分頁已更新資料，請重新整理後再試。');
        for (const id of removeIds) { store.delete(`audio:${id}`); store.delete(`progress:${id}`); }
        store.put(library, 'library-v2');
        if (audio) store.put(audio.blob, `audio:${audio.id}`);
        if (removeSession) store.delete('session');
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('儲存失敗，可能空間不足；原有音訊已保留。'));
  });
}

export async function entries(prefix) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readonly'), values = [];
    const request = tx.objectStore('data').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { values.push(cursor.value); cursor.continue(); } };
    tx.oncomplete = () => resolve(values);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('無法讀取備份資料。'));
  });
}
