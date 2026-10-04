import { DB_NAME } from './core.js';
export class ResultStore {
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('results', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('資料庫被其他分頁占用，請關閉其他測試分頁'));
      request.onsuccess = () => resolve(request.result);
    });
    this.db.onversionchange = () => this.db.close();
  }
  async transaction(method, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('results', method === 'getAll' ? 'readonly' : 'readwrite');
      const request = tx.objectStore('results')[method](...(value === undefined ? [] : [value]));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('儲存交易中止'));
    });
  }
  all() { return this.transaction('getAll'); }
  put(value) { return this.transaction('put', value); }
  clear() { return this.transaction('clear'); }
}
