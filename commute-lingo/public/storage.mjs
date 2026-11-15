import { CHOICE_KEY, validateChoiceQuiz, choiceMatches, applyChoiceScore } from './choice-quiz.mjs?v=0.2.35';
import { QUIZ_KEY, QUIZ_JOB_KEY, validateQuizLevel, validateQuiz, quizMatches, validateAnswers, applyQuizScore } from './quiz.mjs?v=0.2.35';
import { validateVocabulary } from './vocabulary.mjs?v=0.2.35';
import { personalBackup } from './backup.mjs?v=0.2.35';
import { articleSource, articleItems, savedTranslations, validateTranslations } from './article.mjs?v=0.2.35';
import { transcriptText } from './guide.mjs?v=0.2.35';
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
    tx.objectStore('data').put(crypto.randomUUID(), 'data-generation-v1');
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
        for (const id of removeIds) { store.delete(`audio:${id}`); store.delete(`progress:${id}`); store.delete(`guide:${id}`); store.delete(`article:${id}`); }
        if (removeIds.length) {
          const bookmark = store.get('last-listened-v1');
          bookmark.onsuccess = () => { if (removeIds.includes(bookmark.result?.trackId)) store.delete('last-listened-v1'); };
        }
        store.put(library, 'library-v2');
        if (audio) store.put(audio.blob, `audio:${audio.id}`);
        if (removeSession) store.delete('session');
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('儲存失敗，可能空間不足；原有音訊已保留。'));
  });
}

// Active-player identity prevents an old save from undoing Stop/dismiss.
export async function savePlayer(snapshot, { activate = false, dismiss = false } = {}) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data');
    const library = store.get('library-v2'), player = store.get('player-v2'); let ready = 0, saved = false;
    const check = () => {
      if (++ready !== 2 || !library.result?.tracks.some(track => track.id === snapshot.trackId)) return;
      if (!activate && player.result?.sessionId !== snapshot.sessionId) return;
      store.put({ position: snapshot.position }, `progress:${snapshot.trackId}`);
      store.put({ trackId: snapshot.trackId }, 'last-listened-v1');
      store.put(dismiss ? null : snapshot, 'player-v2'); saved = true;
    };
    library.onsuccess = player.onsuccess = check;
    tx.oncomplete = () => resolve(saved); tx.onabort = tx.onerror = () => reject(new Error('播放進度無法保存。'));
  });
}

export async function dataGeneration() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data'); let generation;
    const request = store.get('data-generation-v1');
    request.onsuccess = () => { generation = request.result || crypto.randomUUID(); if (!request.result) store.put(generation, 'data-generation-v1'); };
    tx.oncomplete = () => resolve(generation); tx.onabort = tx.onerror = () => reject(new Error('無法讀取資料狀態。'));
  });
}
export async function setGeminiKey(record, expectedGeneration) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data');
    const generation = store.get('data-generation-v1');
    generation.onsuccess = () => {
      if (!expectedGeneration || generation.result !== expectedGeneration) { tx.abort(); return; }
      if (record) store.put(record, 'gemini-key-v1'); else store.delete('gemini-key-v1');
      store.delete(QUIZ_JOB_KEY);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result; if (!item) return;
        if (typeof item.key === 'string' && (item.key.startsWith('guide:') || item.key.startsWith('article:')) && item.value?.status === 'running') item.update({ ...item.value, status: 'failed', request: null, error: 'Key 已變更，請手動重新產生。' });
        item.continue();
      };
    };
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('Key 保存未完成，請稍後重試。'));
  });
}

// Claim and complete using one IDB transaction each: no duplicate tab requests,
// and deleted/changed transcripts or keys cannot be resurrected by late replies.
export async function updateGuide(id, { action, source, fingerprint, keyId, requestId, model, content, usage, error, automatic = false, force = false }) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data'); let ready = 0, result = { changed: false };
    const library = store.get('library-v2'), key = store.get('gemini-key-v1'), current = store.get(`guide:${id}`);
    const check = () => {
      if (++ready !== 3) return;
      const track = library.result?.tracks.find(item => item.id === id), previous = current.result;
      result.record = previous;
      if (!track || transcriptText(track) !== source || key.result?.id !== keyId) return;
      if (action === 'claim') {
        if (automatic && !library.result.settings.autoGuide || !force && previous?.status === 'ready' && previous.fingerprint === fingerprint || previous?.status === 'running' && previous.request?.fingerprint === fingerprint && Date.now() - previous.request?.startedAt < 190000) return;
        result.record = { ...previous, status: 'running', request: { id: requestId, fingerprint, keyId, startedAt: Date.now(), model }, error: '' };
      } else {
        if (previous?.request?.id !== requestId) return;
        result.record = action === 'complete' ? { status: 'ready', fingerprint, content, usage, model, createdAt: Date.now(), request: null } : { ...previous, status: 'failed', request: null, error };
      }
      store.put(result.record, `guide:${id}`); result.changed = true;
    };
    library.onsuccess = key.onsuccess = current.onsuccess = check;
    tx.oncomplete = () => resolve(result); tx.onabort = tx.onerror = () => reject(new Error('導讀儲存未完成，原有收藏已保留。'));
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
        const choice = store.get(CHOICE_KEY);
        choice.onsuccess = () => { try { if (choice.result && !choiceMatches(validateChoiceQuiz(choice.result), vocabulary)) store.delete(CHOICE_KEY); } catch { store.delete(CHOICE_KEY); } };
        const quiz = store.get(QUIZ_KEY);
        quiz.onsuccess = () => { try { if (quiz.result && !quizMatches(validateQuiz(quiz.result), vocabulary)) store.delete(QUIZ_KEY); } catch { store.delete(QUIZ_KEY); } };
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

// Each batch is a checkpoint; ownership/source/key checks occur atomically.
export async function updateArticle(id, { action, source, fingerprint, keyId, requestId, model, items = [], error = '' }) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data'); let ready = 0, result = { changed: false }, failure;
    const library = store.get('library-v2'), key = store.get('gemini-key-v1'), current = store.get(`article:${id}`);
    const check = () => {
      if (++ready !== 3) return;
      try {
        const track = library.result?.tracks.find(item => item.id === id), previous = current.result;
        result.record = previous;
        if (!track || articleSource(track) !== source || key.result?.id !== keyId) return;
        if (action === 'claim') {
          if (previous?.status === 'running' && previous.fingerprint === fingerprint && Date.now() - previous.request?.startedAt < 190000) return;
          result.record = { version: 1, source, fingerprint, model, items: previous?.fingerprint === fingerprint ? savedTranslations(previous, track) : [], status: 'running', error: '', request: { id: requestId, startedAt: Date.now() } };
        } else {
          if (previous?.request?.id !== requestId || previous.fingerprint !== fingerprint) return;
          if (action === 'renew') {
            result.record = { ...previous, request: { ...previous.request, startedAt: Date.now() } };
          } else if (action === 'batch') {
            const validated = validateTranslations({ translations: items }, articleItems(track), false);
            const merged = new Map(savedTranslations(previous, track).map(item => [item.id, item]));
            validated.forEach(item => merged.set(item.id, item));
            result.record = { ...previous, items: [...merged.values()].sort((a,b) => a.id-b.id), request: { ...previous.request, startedAt: Date.now() } };
          } else result.record = { ...previous, status: action === 'complete' && savedTranslations(previous, track).length === articleItems(track).length ? 'ready' : 'partial', request: null, error: String(error).slice(0, 240) };
        }
        store.put(result.record, `article:${id}`); result.changed = true;
      } catch (error) { failure = error; tx.abort(); }
    };
    library.onsuccess = key.onsuccess = current.onsuccess = check;
    tx.oncomplete = () => resolve(result); tx.onabort = tx.onerror = () => reject(failure || new Error('翻譯保存未完成，已保存的批次仍保留。'));
  });
}

// A separate generation lease retains the previous usable quiz on API failure.
export async function updateQuizJob({ action, requestId, keyId, generation, words, content, level = 'B1' }) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('data','readwrite'),store=tx.objectStore('data');let ready=0,changed=false,failure;
    const book=store.get('vocabulary-v1'),key=store.get('gemini-key-v1'),job=store.get(QUIZ_JOB_KEY),current=store.get(QUIZ_KEY);
    const check=()=>{
      if(++ready!==4)return;
      try {
        if(action==='cancel') {if(job.result?.id===requestId){store.delete(QUIZ_JOB_KEY);changed=true;}return;}
        if(key.result?.id!==keyId || !quizMatches({generation,words},book.result))return;
        if(action==='claim') {
          let validLease=false,completedLease=false;
          try{validLease=!!job.result && quizMatches(job.result,book.result);completedLease=current.result?.id===job.result?.id && !!current.result && quizMatches(validateQuiz(current.result),book.result);}catch{/* Invalid stored lease cannot own a new request. */}
          if(validLease && !completedLease && Date.now()-job.result.startedAt<190000)return;
          store.put({id:requestId,keyId,generation,words,level:validateQuizLevel(level),startedAt:Date.now()},QUIZ_JOB_KEY);changed=true;
        } else if(action==='complete' && job.result?.id===requestId) {
          const quiz=validateQuiz({...content,id:requestId,generation,words,level:job.result.level ?? validateQuizLevel(level),graded:false});
          store.put(quiz,QUIZ_KEY);store.delete(QUIZ_JOB_KEY);changed=true;
        }
      }catch(error){failure=error;tx.abort();}
    };
    book.onsuccess=key.onsuccess=job.onsuccess=current.onsuccess=check;
    tx.oncomplete=()=>resolve(changed);tx.onabort=tx.onerror=()=>reject(failure||Error('測驗保存未完成，原有內容已保留。'));
  });
}

// Grade once and increment all three words in the same transaction. Reading
// the latest notebook preserves concurrent edits rather than overwriting them.
export async function submitQuiz(id, answers) {
  const input=validateAnswers(answers),db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('data','readwrite'),store=tx.objectStore('data');let ready=0,result,failure;
    const book=store.get('vocabulary-v1'),saved=store.get(QUIZ_KEY),library=store.get('library-v2');
    const check=()=>{
      if(++ready!==3)return;
      try {
        const quiz=validateQuiz(saved.result),vocabulary=validateVocabulary(book.result);
        if(quiz.id!==id || !quizMatches(quiz,vocabulary))throw Error('測驗或單字本已變更，請重新開啟測驗。');
        if(quiz.graded){result={quiz,vocabulary,changed:false};return;}
        const next=validateVocabulary(applyQuizScore(vocabulary,quiz,input));
        personalBackup(library.result?.settings||{},next);
        const graded={...quiz,answers:input,graded:true};
        store.put(next,'vocabulary-v1');store.put(graded,QUIZ_KEY);
        result={quiz:graded,vocabulary:next,changed:true};
      }catch(error){failure=error;tx.abort();}
    };
    book.onsuccess=saved.onsuccess=library.onsuccess=check;
    tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(failure||Error('交卷未保存，答題次數沒有變更，請重試。'));
  });
}

// Local choice questions and their counters commit atomically, independent of API keys.
export async function saveChoiceQuiz(value) {
  const quiz=validateChoiceQuiz(value),db=await database();
  if(quiz.selectedId!==null)throw Error('新題目不可帶有作答紀錄。');
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('data','readwrite'),store=tx.objectStore('data');let failure;
    const request=store.get('vocabulary-v1');
    request.onsuccess=()=>{try{
      const book=validateVocabulary(request.result);
      if(!choiceMatches(quiz,book))throw Error('單字本已變更，請重新出題。');
      store.put(quiz,CHOICE_KEY);
    }catch(error){failure=error;tx.abort();}};
    tx.oncomplete=()=>resolve(quiz);tx.onabort=tx.onerror=()=>reject(failure||Error('題目未保存，請重試。'));
  });
}
export async function submitChoiceQuiz(id,selectedId) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('data','readwrite'),store=tx.objectStore('data');let ready=0,result,failure;
    const book=store.get('vocabulary-v1'),saved=store.get(CHOICE_KEY),library=store.get('library-v2');
    const check=()=>{if(++ready!==3)return;try{
      const quiz=validateChoiceQuiz(saved.result),vocabulary=validateVocabulary(book.result);
      if(quiz.id!==id || !choiceMatches(quiz,vocabulary) || !quiz.options.some(item=>item.id===selectedId))throw Error('題目或單字本已變更，請重新出題。');
      if(quiz.selectedId!==null){result={quiz,vocabulary,changed:false};return;}
      const next=applyChoiceScore(vocabulary,quiz,selectedId);
      personalBackup(library.result?.settings||{},next);
      const graded={...quiz,selectedId};store.put(next,'vocabulary-v1');store.put(graded,CHOICE_KEY);
      result={quiz:graded,vocabulary:next,changed:true};
    }catch(error){failure=error;tx.abort();}};
    book.onsuccess=saved.onsuccess=library.onsuccess=check;
    tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(failure||Error('作答未保存，次數沒有變更，請重試。'));
  });
}
