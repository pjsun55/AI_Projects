export const VOCABULARY_KEY = 'vocabulary-v1';
export const MAX_WORDS = 10000;
export const LANGUAGES = Object.freeze({ en: '英文', ja: '日文', ko: '韓文', es: '西班牙文', fr: '法文', de: '德文' });
export const WORD_STATUSES = Object.freeze({ new: '未學習', learning: '學習中', known: '已熟悉' });
export const DICTIONARY_LICENSE = Object.freeze({ name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' });
export const emptyVocabulary = () => ({ schema: 1, generation: crypto.randomUUID(), revision: 0, words: [] });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label}格式或長度無效。`);
  return value.trim();
}
export function normalizeWord(value) {
  const word = text(value, 80, '單字').normalize('NFC');
  if (!word || [...word].length > 64 || !/^\p{L}[\p{L}\p{M}]*(?:['’\-‐‑][\p{L}\p{M}]+)*$/u.test(word)) throw new Error('請只選取一個單字，不含空白、數字或句子標點。');
  return word;
}
export function wordIdentity(word, language) {
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error('單字語言無效。');
  return `${language}:${normalizeWord(word).normalize('NFKC').toLowerCase().replaceAll('’', "'").replace(/[‐‑]/g, '-')}`;
}
export function normalizeTags(value) {
  if (typeof value === 'string') value = value.split(/[,，、]/u).map(part => part.trim()).filter(Boolean);
  if (!Array.isArray(value) || value.length > 16) throw new Error('每個單字最多 16 個標籤，請用逗號分隔。');
  return [...new Set(value.map(tag => { const item = text(tag, 24, '標籤'); if (!item) throw new Error('標籤不能為空白。'); return item; }))];
}
export function normalizeDictionary(value, word) {
  if (value == null) return null;
  if (!object(value) || !Array.isArray(value.senses) || !value.senses.length || value.senses.length > 4) throw new Error('字典資料格式無效。');
  let sourceURL = `https://en.wiktionary.org/wiki/${encodeURIComponent(normalizeWord(word))}`;
  if (typeof value.sourceURL === 'string' && value.sourceURL.length <= 1024) {
    try {
      const url = new URL(value.sourceURL);
      if (url.protocol === 'https:' && url.hostname === 'en.wiktionary.org' && !url.username && !url.password && !url.port && !url.search && url.pathname.startsWith('/wiki/') &&
        normalizeWord(decodeURIComponent(url.pathname.slice(6))).normalize('NFKC').toLowerCase() === normalizeWord(word).normalize('NFKC').toLowerCase()) sourceURL = url.href;
    } catch { /* Fall back to the canonical, encoded word URL. */ }
  }
  return {
    phonetic: text(value.phonetic, 120, '音標'),
    senses: value.senses.map(sense => {
      if (!object(sense)) throw new Error('字典義項格式無效。');
      const definition = text(sense.definition, 400, '英文釋義'); if (!definition) throw new Error('英文釋義不能空白。');
      return { partOfSpeech: text(sense.partOfSpeech, 50, '詞性'), definition };
    }),
    // Retain the upstream attribution only for the same word on a fixed host.
    provider: 'FreeDictionaryAPI.com', sourceURL,
    license: { ...DICTIONARY_LICENSE }, excerpt: true
  };
}
export function validateWord(value) {
  if (!object(value)) throw new Error('單字資料格式無效。');
  const word = normalizeWord(value.word); wordIdentity(word, value.language);
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id)) throw new Error('單字識別碼無效。');
  if (!Object.hasOwn(WORD_STATUSES, value.status) || typeof value.starred !== 'boolean') throw new Error('學習狀態或星號格式無效。');
  for (const name of ['createdAt', 'updatedAt', 'version']) if (!Number.isSafeInteger(value[name]) || value[name] < 0 || (name !== 'version' && value[name] > 8640000000000000)) throw new Error('單字日期或版本無效。');
  if (!['', 'mymemory', 'manual', 'gemini'].includes(value.translationSource)) throw new Error('翻譯來源無效。');
  // Whitelist every persisted field: no audio, transcript, credentials or arbitrary URLs.
  return { id: value.id, word, language: value.language, translation: text(value.translation, 500, '中文解釋'), translationSource: value.translationSource,
    dictionary: normalizeDictionary(value.dictionary, word), tags: normalizeTags(value.tags), starred: value.starred, status: value.status,
    note: text(value.note, 2000, '個人筆記'), sourceTitle: text(value.sourceTitle, 120, '來源名稱'), createdAt: value.createdAt, updatedAt: value.updatedAt, version: value.version };
}
export function validateVocabulary(value) {
  if (!object(value) || value.schema !== 1 || typeof value.generation !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.generation) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.words) || value.words.length > MAX_WORDS) throw new Error('單字本格式無效或超過 10,000 筆上限。');
  const ids = new Set(), identities = new Set();
  const words = value.words.map(item => {
    const word = validateWord(item), identity = wordIdentity(word.word, word.language);
    if (ids.has(word.id) || identities.has(identity)) throw new Error('單字本含有重複的單字或識別碼。');
    ids.add(word.id); identities.add(identity); return word;
  });
  return { schema: 1, generation: value.generation, revision: value.revision, words };
}
export function addWord(book, { word, language, sourceTitle = '', translation = '', tags = [], translationSource, note = '' }, { id = crypto.randomUUID(), now = Date.now() } = {}) {
  const identity = wordIdentity(word, language);
  if (book.words.some(item => wordIdentity(item.word, item.language) === identity)) throw new Error('這個單字已在單字本，不會重複新增。');
  if (book.words.length >= MAX_WORDS) throw new Error('單字本已達 10,000 筆，請先整理後再加入。');
  const meaning = text(translation, 500, '中文解釋');
  const entry = validateWord({ id, word, language, translation: meaning, translationSource: meaning ? translationSource || 'manual' : '', dictionary: null, tags, starred: false, status: 'new', note, sourceTitle, createdAt: now, updatedAt: now, version: 0 });
  return { ...book, words: [...book.words, entry] };
}
export function editWord(book, id, changes, now = Date.now()) {
  const old = book.words.find(word => word.id === id); if (!old) throw new Error('單字已不存在，請重新整理。');
  const translation = text(changes.translation ?? old.translation, 500, '中文解釋');
  const next = validateWord({ ...old, translation, translationSource: translation === old.translation ? old.translationSource : translation ? 'manual' : '', tags: changes.tags ?? old.tags,
    starred: changes.starred ?? old.starred, status: changes.status ?? old.status, note: changes.note ?? old.note, updatedAt: now, version: old.version + 1 });
  return { ...book, words: book.words.map(word => word.id === id ? next : word) };
}
export function needsLookup(word) { return !word.translation || !word.dictionary; }
export function mergeVocabulary(local, incoming, { now = Date.now(), idFactory = () => crypto.randomUUID() } = {}) {
  const current = validateVocabulary(local), imported = validateVocabulary(incoming);
  const words = [...current.words], index = new Map(words.map((word, i) => [wordIdentity(word.word, word.language), i]));
  let added = 0, duplicates = 0, enriched = 0;
  for (const word of imported.words) {
    const identity = wordIdentity(word.word, word.language), position = index.get(identity);
    if (position === undefined) {
      if (words.length >= MAX_WORDS) throw new Error('合併後超過 10,000 筆單字上限，原有資料未變更。');
      index.set(identity, words.length); words.push(validateWord({ ...word, id: idFactory(), version: 0 })); added++; continue;
    }
    duplicates++;
    const old = words[position];
    const tags = [...new Set([...old.tags, ...word.tags])];
    if (tags.length > 16) throw new Error(`「${old.word}」合併後超過 16 個標籤，請先整理標籤再還原。`);
    const next = { ...old, translation: old.translation || word.translation, translationSource: old.translation ? old.translationSource : word.translationSource,
      dictionary: old.dictionary || word.dictionary, note: old.note || word.note, sourceTitle: old.sourceTitle || word.sourceTitle, starred: old.starred || word.starred, tags };
    if (JSON.stringify(next) !== JSON.stringify(old)) { words[position] = validateWord({ ...next, version: old.version + 1, updatedAt: now }); enriched++; }
  }
  return { vocabulary: { ...current, words }, added, duplicates, enriched };
}
