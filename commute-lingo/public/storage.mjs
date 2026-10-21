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

// The vocabulary has its own revision and key, independent of albums/audio.
// Read both keys in one snapshot for backup and restore previews.
export async function readPersonalData() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readonly'), store = tx.objectStore('data');
    const library = store.get('library-v2'), vocabulary = store.get('vocabulary-v1');
    tx.oncomplete = () => resolve({ library: library.result, vocabulary: vocabulary.result });
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('無法讀取設定與單字本。'));
  });
}
export async function commitVocabulary(vocabulary, { expectedRevision, expectedGeneration }) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data'); let failure;
    const request = store.get('vocabulary-v1');
    request.onsuccess = () => {
      try {
        if ((request.result?.revision ?? 0) !== expectedRevision || request.result && request.result.generation !== expectedGeneration) throw new Error('另一個分頁已更新單字本，請重新整理後再試。');
        store.put(vocabulary, 'vocabulary-v1');
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('單字儲存失敗，原有資料已保留。'));
  });
}
// Atomic restore: either both metadata records commit, or neither does.
// No album, audio, subtitle, translation cache or playback record is deleted.
export async function commitPersonalData(library, vocabulary, { expectedLibraryRevision, expectedVocabularyRevision, expectedGeneration, expectedLibrary }) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data'); let failure, ready = 0;
    const currentLibrary = store.get('library-v2'), currentVocabulary = store.get('vocabulary-v1');
    const check = () => {
      if (++ready !== 2) return;
      try {
        if ((currentLibrary.result?.revision ?? 0) !== expectedLibraryRevision || (currentVocabulary.result?.revision ?? 0) !== expectedVocabularyRevision || currentVocabulary.result && currentVocabulary.result.generation !== expectedGeneration || JSON.stringify(currentLibrary.result ?? null) !== JSON.stringify(expectedLibrary ?? null)) throw new Error('其他分頁已變更資料，請重新選擇備份以更新還原預覽。');
        store.put(library, 'library-v2'); store.put(vocabulary, 'vocabulary-v1');
      } catch (error) { failure = error; tx.abort(); }
    };
    currentLibrary.onsuccess = check; currentVocabulary.onsuccess = check;
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('還原未完成，原有設定與單字本已保留。'));
  });
}
