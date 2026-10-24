import { readingCues, activeWord } from './reading.mjs?v=0.2.22';
import { formatTime, findActive, transcriptCoverage, sentenceTexts } from './core.mjs?v=0.2.22';
import * as storage from './storage.mjs?v=0.2.22';
import { createTranslator } from './translation.mjs?v=0.2.22';
import { DEFAULT_SETTINGS, LIBRARY_KEY, emptyLibrary, validateSettings, title, tracksIn, addAlbum, removeAlbum, removeTrack, rename, placeTrack, changeSettings, libraryBytes, playbackQueue, nextPlayback, sentenceTarget, sentencesFor, legacyLibrary, newId } from './library.mjs?v=0.2.22';
import { createGuideController } from './guide-controller.mjs?v=0.2.22';
import { guideAudioRange, GUIDE_INSTRUCTION } from './guide.mjs?v=0.2.22';
import { importPodcast, importAudioFile, transcribeSavedAudio } from './source.mjs?v=0.2.22';
import { icon, fillIcons } from './icons.mjs?v=0.2.22';
import { longPress, isMobileLandscape } from './gestures.mjs?v=0.2.22';
import { personalBackup, readPersonalBackup, planPersonalRestore } from './backup.mjs?v=0.2.22';
import { VOCABULARY_KEY, LANGUAGES, WORD_STATUSES, emptyVocabulary, validateVocabulary, validateWord, normalizeWord, wordIdentity, addWord, editWord, needsLookup } from './vocabulary.mjs?v=0.2.22';
import { lookupDictionary } from './dictionary.mjs?v=0.2.22';
import { createSubtitleFollow, subtitleScrollTop, sentenceReadingParts, createAudioExcerpt } from './subtitles.mjs?v=0.2.22';
import { createUpdater, reloadVersion } from './updates.mjs?v=0.2.22';
import { holdScreenAwake } from './wake-lock.mjs?v=0.2.22';

const $ = id => document.getElementById(id);
const audio = $('audio');
const state = { library: emptyLibrary(), vocabulary: emptyVocabulary(), wordSelection: null, wordLookup: null, wordLimit: 40, restoring: false, ready: false, view: 'playlist', album: null, current: null, resumeTrack: null, queue: [], urls: new Map(), sentences: [], active: -1, activeWord: -1, seeking: false, playerToken: 0, lastProgressSave: 0, translation: null, pending: null, file: null, job: null, epoch: 0, writing: false, clearing: false, gestureCleanups: [], legacy: null, backup: null, updating: false, settingsDirty: false, loadingAudio: 0 };
const subtitleFollow = createSubtitleFollow({ onFollow: () => highlight(true), canResume: () => !audio.paused && !document.hidden && $('player').open && !$('subtitles-panel').hidden && !state.translation });
const translationAudio = createAudioExcerpt({ audio, onChange: playing => {
  $('translation-play').textContent = playing ? '停止原音' : '播放這段原音';
  $('translation-play').setAttribute('aria-pressed', String(playing));
} });
let messageTimer, readingTimer, retriedAudioSource = '';
let progressChain = Promise.resolve(), playerSession = null;
function refreshReadingClock() {
  clearTimeout(readingTimer); readingTimer = undefined;
  if (audio.paused || document.hidden || !$('player').open || $('subtitles-panel').hidden) return;
  highlight(); readingTimer = setTimeout(refreshReadingClock, 80);
}
const clock = value => formatTime(Number.isFinite(value) ? value : 0).replace(/^00:/, '');
const bytes = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const currentTrack = () => state.library.tracks.find(track => track.id === state.current);
const albumOf = track => state.library.albums.find(album => album.id === track?.albumId);
const safe = action => (...args) => { try { return Promise.resolve(action(...args)).catch(error => notify(error.message, true)); } catch (error) { notify(error.message, true); } };
const updater = createUpdater({
  serviceWorker: navigator.serviceWorker, version: '0.2.22',
  isAuto: () => state.library.settings.autoUpdate,
  visible: () => !document.hidden,
  canUpdate: () => state.ready && audio.paused && !guides.busy && !$('gemini-key').value && !state.loadingAudio && !state.job && !state.pending && !state.writing && !state.clearing && !state.backup && !state.restoring && !state.wordLookup && !state.translation && !state.settingsDirty && !$('player').open && !$('action-dialog').open && !$('source-url').value.trim() && !state.file && !document.activeElement?.matches?.('input,select,textarea'),
  prepare: async () => { await saveProgress({ strict: true }); await storage.read(LIBRARY_KEY); },
  lock: locked => { state.updating = locked; $('app').inert = locked; },
  render: ({ text, waiting, applying, checking }) => {
    if (text) $('update-status').textContent = text;
    $('apply-update').hidden = !waiting; $('apply-update').disabled = !!applying || !!checking;
    $('check-update').disabled = !!checking || !!applying;
  },
  reload: version => reloadVersion(location, version)
});
function notify(message, error = false) {
  clearTimeout(messageTimer); $('global-message').hidden = false;
  $('global-message').textContent = message; $('global-message').classList.toggle('error', error);
  messageTimer = setTimeout(() => { $('global-message').hidden = true; }, error ? 11000 : 6500);
}
const translator = createTranslator({ load: key => storage.read(`translation:${key}`), save: (key, entry) => storage.write(`translation:${key}`, entry), warn: message => notify(message, true) });
const guides = createGuideController({
  getLibrary: () => state.library, getCurrent: currentTrack, getWords: () => state.vocabulary,
  available: () => state.ready && !state.updating && !state.clearing && !state.restoring && !state.writing,
  saveWord: async entry => { await commitWords(addWord(state.vocabulary, entry)); notify(`已收藏「${entry.word}」。`); },
  notify, openSettings: () => { if ($('player').open) closeDialog($('player')); showView('settings'); },
  playQuote: async quote => {
    const cue = guideAudioRange(state.sentences, quote);
    if (!cue) { notify('這個引句尚無可用的字幕時間，請從原文字幕選擇播放。'); return; }
    closeTranslation(); await translationAudio.start(cue);
  },
  broadcast: type => state.channel?.postMessage({ type })
});
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function button(label, className, action, symbol) {
  const element = node('button', className, symbol ? undefined : label); element.type = 'button';
  if (symbol) { element.innerHTML = icon(symbol); element.setAttribute('aria-label', label); }
  element.onclick = safe(action); return element;
}
const colors = [['#eeab71', '#bb5a4c'], ['#53a9a8', '#225a76'], ['#b16aea', '#6132a0'], ['#7d8bc9', '#494b89'], ['#d387a8', '#814d83']];
function cover(element, albumId) {
  const index = Math.max(0, state.library.albums.findIndex(album => album.id === albumId)) % colors.length;
  element.style.setProperty('--cover-start', colors[index][0]); element.style.setProperty('--cover-end', colors[index][1]);
  element.innerHTML = icon(['wave', 'listen', 'podcast', 'album', 'subtitles'][index]);
  return element;
}
function empty(root, heading, description, actionLabel, action) {
  const element = node('div', 'empty-state'); element.innerHTML = icon('listen');
  element.append(node('strong', '', heading), node('p', '', description));
  if (action) element.append(button(actionLabel, 'text-button', action)); root.append(element);
}
function showView(name) {
  if (!['playlist', 'library', 'vocabulary', 'import', 'settings'].includes(name)) name = 'playlist';
  state.view = name;
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
  document.querySelectorAll('[data-tab]').forEach(tab => {
    const active = tab.dataset.tab === name; tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'library') refreshStorage();
  if (name === 'vocabulary') renderVocabulary();
  window.scrollTo({ top: 0 });
}
async function commit(next, options = {}) {
  if (state.updating) throw new Error('正在套用新版，請稍候。');
  if (!state.ready) throw new Error('收藏尚未讀取完成，請稍後再試。');
  if (state.writing || state.clearing || state.restoring) throw new Error('資料儲存中，請稍後再試。');
  if (state.job) throw new Error('請等待來源匯入完成，或先停止處理。');
  state.writing = true; renderWriteControls();
  const previous = state.library, expectedRevision = previous.revision;
  next = { ...next, revision: expectedRevision + 1 };
  const removeIds = previous.tracks.filter(track => !next.tracks.some(item => item.id === track.id)).map(track => track.id);
  try {
    await storage.commitLibrary(next, { ...options, expectedRevision, removeIds });
    state.library = next;
    for (const id of removeIds) { const url = state.urls.get(id); if (url) URL.revokeObjectURL(url); state.urls.delete(id); }
    state.queue = state.queue.filter(id => next.tracks.some(track => track.id === id));
    if (state.current && !currentTrack()) releasePlayer();
    if (state.album && !next.albums.some(album => album.id === state.album)) state.album = null;
    render(); updateMediaSession(); state.channel?.postMessage({ type: 'changed' });
  } catch (error) {
    if (error.name === 'QuotaExceededError') throw new Error(`儲存空間不足，原有資料已保留。${state.pending ? '請先整理收藏後再加入；本次轉換仍暫存在這個分頁。' : '請先整理收藏後再試。'}`);
    throw error;
  } finally { state.writing = false; renderWriteControls(); }
}
function render() {
  renderPlaylist(); renderLibrary(); renderSettings(); renderVocabulary();
  updateSourceControls();
  $('import-limit').textContent = `目前每集上限 ${state.library.settings.maxMinutes} 分鐘；每個專輯可保存 ${state.library.settings.trackLimit} 集。超過長度上限會直接停止。`;
  $('file-import-limit').textContent = $('import-limit').textContent;
  $('backup-library').disabled = !state.ready || !!state.backup || state.restoring;
  $('share-backup').disabled = $('backup-library').disabled;
  renderWriteControls();
  $('legacy-backup').hidden = !state.legacy;
  updatePlayer(); refreshStorage();
  guides.render();
}
function renderWriteControls() {
  guides.updateControls();
  const disabled = !state.ready || state.restoring || state.writing;
  $('restore-backup').disabled = disabled;
  $('restore-backup-button').disabled = disabled;
  $('add-word').disabled = disabled;
}
function trackRow(track, manage = false) {
  const row = node('div', `track-row${state.current === track.id ? ' active' : ''}`);
  row.append(cover(node('div', 'cover track-cover'), track.albumId));
  const main = button('', 'track-main', () => selectTrack(track.id, { expand: true, autoplay: true }));
  main.append(node('strong', '', track.title), node('small', '', `${clock(track.duration)} · ${manage ? bytes(track.size) : albumOf(track)?.title || 'Podcast'}`));
  main.setAttribute('aria-label', `播放 ${track.title}`); row.append(main);
  if (manage) row.append(button('編輯', 'text-button edit-track', () => renameItem('track', track)));
  row.append(button(manage ? `管理 ${track.title}` : `播放 ${track.title}`, `round-button${manage ? ' more-button' : ''}`, () => manage ? trackMenu(track) : selectTrack(track.id, { expand: true, autoplay: true }), manage ? 'more' : 'play'));
  return row;
}
function renderPlaylist() {
  const albums = $('playlist-albums'); albums.replaceChildren();
  for (const album of state.library.albums) {
    const card = button('', `album-card${state.album === album.id ? ' selected' : ''}`, () => { state.album = state.album === album.id ? null : album.id; renderPlaylist(); });
    card.setAttribute('aria-label', `查看專輯 ${album.title}`); card.setAttribute('aria-pressed', String(state.album === album.id));
    const art = cover(node('div', 'cover album-cover'), album.id); art.append(node('span', 'cover-letter', 'COMMUTELINGO'));
    const tracks = tracksIn(state.library, album.id);
    card.append(art, node('strong', '', album.title), node('small', '', `${tracks.length} 集 · ${Math.round(tracks.reduce((sum, track) => sum + track.duration, 0) / 60)} 分鐘`)); albums.append(card);
  }
  if (!state.library.albums.length) empty(albums, '收藏你的第一段旅程', '建立專輯，讓喜歡的聲音有個家。', '建立專輯', createAlbum);
  const root = $('playlist-tracks'); root.replaceChildren();
  const selected = state.library.albums.find(album => album.id === state.album);
  $('episodes-heading').textContent = selected?.title || '最近加入';
  const tracks = selected ? tracksIn(state.library, selected.id) : [...state.library.tracks].reverse();
  $('track-count').replaceChildren();
  if (selected && tracks.length) $('track-count').append(button('播放專輯', 'text-button', () => selectTrack(tracks[0].id, { queue: playbackQueue(state.library, selected.id), autoplay: true, expand: true })));
  else $('track-count').textContent = `${tracks.length} 集`;
  tracks.forEach(track => root.append(trackRow(track)));
  if (!tracks.length) empty(root, '今天想聽些什麼？', '貼上一個 Podcast 單集連結，字幕就交給我們。', '匯入來源', () => showView('import'));
  renderResume();
}
function renderResume() {
  const resume = $('resume-card'); resume.replaceChildren();
  const track = !state.current && !state.clearing && state.library.tracks.find(item => item.id === state.resumeTrack);
  resume.hidden = !track;
  if (track) {
    const card = node('div', 'resume-card'); card.append(cover(node('div', 'cover track-cover'), track.albumId));
    const resumePlayback = () => selectTrack(track.id, { expand: true, autoplay: true });
    const body = button('', 'track-main', resumePlayback); body.append(node('small', '', '接著上次，繼續聽'), node('strong', '', track.title));
    card.append(body, button('繼續播放', 'round-button', resumePlayback, 'play')); resume.append(card);
  }
}

function renderLibrary() {
  const root = $('library-albums'); root.replaceChildren();
  $('library-capacity').textContent = `${state.library.albums.length} / ${state.library.settings.albumLimit} 個專輯`;
  for (const album of state.library.albums) {
    const card = node('article', 'album-management'), header = node('div', 'album-management-header');
    const text = node('div'); const tracks = tracksIn(state.library, album.id);
    text.append(node('h3', '', album.title), node('small', '', `${tracks.length} / ${state.library.settings.trackLimit} 集 · ${bytes(tracks.reduce((sum, track) => sum + track.size, 0))}`));
    header.append(cover(node('div', 'cover'), album.id), text, button('編輯', 'text-button edit-album', () => renameItem('album', album)), button(`管理專輯 ${album.title}`, 'round-button', () => albumMenu(album), 'more')); card.append(header);
    tracks.forEach(track => card.append(trackRow(track, true)));
    if (!tracks.length) empty(card, '還沒有音訊', '下一個好故事，就放這裡。'); root.append(card);
  }
  if (!state.library.albums.length) empty(root, '你的收藏，從這裡開始', '可編輯名稱，也能隨時整理不再需要的音訊。', '建立專輯', createAlbum);
}
function renderSettings() {
  if (state.settingsDirty) return;
  const settings = state.library.settings;
  for (const [id, value] of [['setting-albums', settings.albumLimit], ['setting-tracks', settings.trackLimit], ['setting-minutes', settings.maxMinutes], ['setting-subtitles', settings.subtitleSize], ['setting-language', settings.language], ['setting-model', settings.model], ['setting-gemini-model', settings.geminiModel], ['setting-guide-prompt', settings.guidePrompt]]) $(id).value = value;
  $('setting-auto-update').checked = settings.autoUpdate;
  applyAppearance(settings);
}
async function commitWords(next) {
  if (!state.ready || state.updating || state.clearing || state.restoring || state.writing) throw new Error('資料處理中，請稍後再儲存單字。');
  const expectedRevision = state.vocabulary.revision;
  next = validateVocabulary({ ...next, revision: expectedRevision + 1 });
  personalBackup(state.library.settings, next); // Keep every saved notebook exportable within the import limit.
  state.writing = true; renderWriteControls();
  try {
    await storage.commitVocabulary(next, { expectedRevision, expectedGeneration: state.vocabulary.generation });
    state.vocabulary = next; renderVocabulary(); renderWordSelection();
    state.channel?.postMessage({ type: 'words-changed' }); guides.render();
  } finally { state.writing = false; renderWriteControls(); renderWordSelection(); }
}
function cancelWordLookup() {
  state.wordLookup?.controller.abort(); state.wordLookup = null;
}
function renderWordSelection() {
  const selected = state.wordSelection;
  const exists = selected && state.vocabulary.words.some(item => wordIdentity(item.word, item.language) === wordIdentity(selected.word, selected.language));
  $('word-selection-label').textContent = selected ? `已選取：${selected.word}` : '長按原文選取一個單字';
  $('save-selected-word').textContent = exists ? '已收藏' : '收藏單字';
  $('save-selected-word').disabled = !selected || !!exists || !state.ready || state.writing || state.restoring || state.updating;
}
function captureWordSelection() {
  if ($('translation-panel').hidden || !state.translation) return;
  const selection = document.getSelection?.() || window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const root = $('translation-original');
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
  try {
    const word = normalizeWord(selection.toString());
    state.wordSelection = { word, language: currentTrack()?.language || state.library.settings.language, sourceTitle: currentTrack()?.title || '', translationToken: state.translation };
    renderWordSelection();
  } catch {
    state.wordSelection = null; renderWordSelection();
    $('word-selection-label').textContent = '請只選取一個單字';
  }
  // Never cancel selectionchange/contextmenu or replace the native iOS menu.
  // Keep the last valid selection when tapping our button collapses the range.
}
async function saveSelectedWord() {
  const selected = state.wordSelection;
  if (!selected || selected.translationToken !== state.translation || $('translation-panel').hidden) return;
  const next = addWord(state.vocabulary, selected), id = next.words.at(-1).id;
  await commitWords(next); renderWordSelection();
  notify(`已收藏「${selected.word}」，正在補充解釋。`);
  void enrichWord(id).catch(() => notify('單字已保存，解釋尚未補齊，可稍後重試。', true));
}
async function enrichWord(id) {
  if (!state.ready || state.updating || state.restoring || state.clearing) throw new Error('目前無法查詢，請稍後重試。');
  const original = state.vocabulary.words.find(word => word.id === id); if (!original || !needsLookup(original)) return;
  cancelWordLookup();
  const job = { id, controller: new AbortController() }; state.wordLookup = job; renderVocabulary();
  try {
    const result = await Promise.allSettled([
      original.translation ? Promise.resolve(null) : translator.translate(original.word, original.language, { signal: job.controller.signal }),
      original.dictionary ? Promise.resolve(null) : lookupDictionary(original.word, original.language, { signal: job.controller.signal })
    ]);
    if (state.wordLookup !== job || job.controller.signal.aborted || state.clearing) return;
    const current = state.vocabulary.words.find(word => word.id === id);
    if (!current) return;
    if (current.version !== original.version) { notify('單字已編輯，線上結果未覆蓋你的修改。'); return; }
    const nextWord = validateWord({ ...current,
      translation: current.translation || (result[0].status === 'fulfilled' ? result[0].value?.translation?.slice(0, 500) || '' : ''),
      translationSource: current.translation ? current.translationSource : result[0].status === 'fulfilled' && result[0].value?.translation ? 'mymemory' : '',
      dictionary: current.dictionary || (result[1].status === 'fulfilled' ? result[1].value : null), updatedAt: Date.now(), version: current.version + 1 });
    if (nextWord.translation !== current.translation || !current.dictionary && nextWord.dictionary) await commitWords({ ...state.vocabulary, words: state.vocabulary.words.map(word => word.id === id ? nextWord : word) });
    const failures = result.filter(item => item.status === 'rejected');
    notify(failures.length ? `「${current.word}」已保存；部分解釋未取得，可從單字選單重試或自行填寫。` : `「${current.word}」的解釋已保存，可離線查看。`, !!failures.length);
  } finally { if (state.wordLookup === job) { state.wordLookup = null; renderVocabulary(); } }
}
function renderVocabulary() {
  const selectedTag = $('vocabulary-tag').value || 'all';
  const tags = [...new Set(state.vocabulary.words.flatMap(word => word.tags))].sort((a, b) => a.localeCompare(b));
  $('vocabulary-tag').replaceChildren();
  for (const [value, caption] of [['all', '全部標籤'], ['untagged', '未分類'], ...tags.map(tag => [`tag:${tag}`, tag])]) {
    const option = node('option', '', caption); option.value = value; $('vocabulary-tag').append(option);
  }
  $('vocabulary-tag').value = ['all', 'untagged', ...tags.map(tag => `tag:${tag}`)].includes(selectedTag) ? selectedTag : 'all';
  const query = $('vocabulary-search').value.trim().toLowerCase(), filter = $('vocabulary-filter').value, tag = $('vocabulary-tag').value;
  const words = state.vocabulary.words.filter(word =>
    (!query || [word.word, word.translation, word.note, word.sourceTitle, ...word.tags].join('\n').toLowerCase().includes(query)) &&
    (filter === 'all' || filter === 'starred' && word.starred || filter === 'pending' && needsLookup(word) || word.status === filter) &&
    (tag === 'all' || tag === 'untagged' && !word.tags.length || tag.startsWith('tag:') && word.tags.includes(tag.slice(4)))
  ).sort((a, b) => b.createdAt - a.createdAt || a.word.localeCompare(b.word));
  $('vocabulary-count').textContent = `共 ${state.vocabulary.words.length} 個單字 · 顯示 ${words.length} 個`;
  const root = $('vocabulary-list'); root.replaceChildren();
  for (const word of words.slice(0, state.wordLimit)) {
    const row = node('article', 'word-card'); row.dataset.wordId = word.id;
    const main = button('', 'word-main', () => editWordDetails(word.id));
    main.append(node('strong', '', word.word), node('span', 'word-meaning', word.translation || '中文解釋待補'));
    main.append(node('small', '', `${LANGUAGES[word.language]} · ${WORD_STATUSES[word.status]}${state.wordLookup?.id === word.id ? ' · 正在查詢…' : needsLookup(word) ? ' · 解釋待補' : ''}`));
    if (word.tags.length) main.append(node('span', 'word-tags', word.tags.slice(0, 3).join(' · ')));
    const star = button(word.starred ? '★' : '☆', 'word-star', () => commitWords(editWord(state.vocabulary, word.id, { starred: !word.starred })));
    star.setAttribute('aria-label', `${word.starred ? '取消重要' : '標記重要'} ${word.word}`); star.setAttribute('aria-pressed', String(word.starred));
    row.append(main, star, button(`管理單字 ${word.word}`, 'round-button', () => wordMenu(word.id), 'more')); root.append(row);
  }
  if (!words.length) empty(root, state.vocabulary.words.length ? '沒有符合的單字' : '每次聽懂，多留下一個字', state.vocabulary.words.length ? '試著調整搜尋或分類。' : '在翻譯視窗選取單字收藏，也可以手動新增。');
  $('vocabulary-more').hidden = words.length <= state.wordLimit;
}
function areaField(root, caption, value, id, maxLength) {
  const label = node('label', '', caption); label.htmlFor = id;
  const input = node('textarea'); Object.assign(input, { id, value, maxLength, rows: 3 }); root.append(label, input); return input;
}
async function createWord() {
  let word, language, translation, tags, saved;
  await ask({ heading: '新增單字', description: '只收藏單字，不保存原句或語音。儲存後會將單字送至 MyMemory 與 FreeDictionaryAPI.com 補充解釋；失敗時仍保留單字。', confirm: '收藏單字',
    build: root => {
      word = textField(root, '單字', '', 'new-word'); word.maxLength = 80; word.autocomplete = 'off';
      language = selectField(root, '語言', Object.entries(LANGUAGES), 'word-language'); language.value = state.library.settings.language;
      translation = areaField(root, '中文解釋（可留白，自動查詢）', '', 'word-translation', 500);
      tags = textField(root, '標籤（選填，用逗號分隔）', '', 'word-tags'); tags.required = false; tags.maxLength = 399; tags.placeholder = '例如：生活,工作';
    }, accept: async () => { const next = addWord(state.vocabulary, { word: word.value, language: language.value, translation: translation.value, tags: tags.value }); await commitWords(next); saved = next.words.at(-1).id; }
  });
  if (saved) { notify('單字已收藏，正在補充解釋。'); void enrichWord(saved).catch(() => notify('單字已保存，解釋尚未補齊，可稍後重試。', true)); }
}
async function editWordDetails(id) {
  const word = state.vocabulary.words.find(item => item.id === id); if (!word) return;
  if (state.wordLookup?.id === id) { cancelWordLookup(); renderVocabulary(); }
  let translation, tags, status, note, starred;
  await ask({ heading: word.word, description: `${LANGUAGES[word.language]}${word.sourceTitle ? ` · 來源：${word.sourceTitle}` : ''}\n收藏於 ${new Date(word.createdAt).toLocaleDateString('zh-TW')}`, confirm: '儲存變更',
    build: root => {
      translation = areaField(root, '中文解釋（可修訂或補充不同意思）', word.translation, 'word-translation', 500);
      tags = textField(root, '標籤（用逗號分隔）', word.tags.join(','), 'word-tags'); tags.required = false; tags.maxLength = 399;
      status = selectField(root, '學習狀態', Object.entries(WORD_STATUSES), 'word-status'); status.value = word.status;
      const label = node('label', 'choice-card'); starred = node('input'); starred.type = 'checkbox'; starred.checked = word.starred; starred.id = 'word-starred'; label.append(starred, node('span', '', '標記為重要單字')); root.append(label);
      note = areaField(root, '個人筆記', word.note, 'word-note', 2000);
      if (word.dictionary) {
        const dictionary = node('section', 'word-dictionary'); dictionary.append(node('h3', '', '字典釋義（節錄）'));
        if (word.dictionary.phonetic) dictionary.append(node('p', '', word.dictionary.phonetic));
        for (const sense of word.dictionary.senses) dictionary.append(node('p', '', `${sense.partOfSpeech} · ${sense.definition}`));
        const credit = node('p', 'small');
        for (const [caption, url] of [['FreeDictionaryAPI.com', 'https://freedictionaryapi.com/'], ['Wiktionary 原條目', word.dictionary.sourceURL], ['CC BY-SA 4.0', word.dictionary.license.url]]) {
          const link = node('a', '', caption); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; credit.append(link, node('span', '', ' '));
        }
        dictionary.append(credit); root.append(dictionary);
      }
      root.append(node('p', 'small muted', word.translationSource === 'gemini' ? '中文與原句來自 Gemini 導讀，可自行修訂。' : word.translationSource === 'mymemory' ? '中文為 MyMemory 翻譯，可依原意修訂。' : '中文解釋與筆記由你整理；不會因音檔刪除而消失。'));
    }, accept: async () => { await commitWords(editWord(state.vocabulary, id, { translation: translation.value, tags: tags.value, status: status.value, starred: starred.checked, note: note.value })); notify('單字已更新。'); }
  });
}
async function wordMenu(id) {
  const word = state.vocabulary.words.find(item => item.id === id); if (!word) return;
  let action;
  const choice = await ask({ heading: word.word, confirm: '繼續', build: root => { action = selectField(root, '單字操作', [['edit', '編輯解釋與分類'], ['lookup', '補充尚未取得的線上解釋'], ['delete', '刪除這個單字']], 'word-action'); }, accept: () => action.value });
  if (choice === 'edit') await editWordDetails(id);
  else if (choice === 'lookup') { if (!needsLookup(word)) notify('解釋已齊全，沒有再次發出查詢。'); else await enrichWord(id); }
  else if (choice === 'delete') await ask({ heading: `刪除「${word.word}」？`, description: '將刪除這個單字、解釋與筆記，其他單字與音檔不受影響。', confirm: '刪除單字', danger: true, accept: async () => {
    if (state.wordLookup?.id === id) cancelWordLookup();
    await commitWords({ ...state.vocabulary, words: state.vocabulary.words.filter(item => item.id !== id) }); notify('單字已刪除。');
  } });
}
function applyAppearance(settings) {
  document.documentElement.style.setProperty('--subtitle-size', { normal: '18.4px', large: '22.4px', xlarge: '27.2px' }[settings.subtitleSize]);
  $('brand-icon').src = `./icon-${settings.icon}.svg`; $('favicon').href = `./icon-${settings.icon}.svg`;
  $('touch-icon').href = `./icon-${settings.icon}-192.png`;
  $('manifest').href = `./manifest-${settings.icon}.webmanifest?v=0.2.22`;
}
async function refreshStorage() {
  const total = libraryBytes(state.library);
  $('storage-summary').textContent = `已收藏 ${state.library.tracks.length} 集 · 音訊 ${bytes(total)}`;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) {
      $('storage-fill').style.width = `${Math.min(100, (estimate.usage || 0) / estimate.quota * 100)}%`;
      $('storage-detail').textContent = `同網站用量 ${bytes(estimate.usage || 0)} / 可用配額 ${bytes(estimate.quota)}（含程式快取與同網域其他頁面）`;
    } else $('storage-detail').textContent = '此瀏覽器未提供網站配額；上方為本 App 實際保存的音訊大小。';
    if (await navigator.storage?.persisted?.()) { $('persistence-status').textContent = '瀏覽器已授予持續保存；仍建議保留備份。'; $('request-persistence').hidden = true; }
  } catch { $('storage-detail').textContent = '暫時無法取得網站可用配額；音訊用量仍可查看。'; }
}

function openDialog(dialog) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
function closeDialog(dialog) { document.activeElement?.blur?.(); if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
function ask({ heading, description = '', confirm = '確認', danger = false, build = () => {}, accept = () => true }) {
  const dialog = $('action-dialog'), form = $('dialog-form');
  if (dialog.open) return Promise.reject(new Error('請先完成目前的操作。'));
  $('dialog-title').textContent = heading; $('dialog-description').textContent = description; $('dialog-error').textContent = '';
  $('dialog-fields').replaceChildren(); build($('dialog-fields'));
  $('dialog-confirm').textContent = confirm; $('dialog-confirm').classList.toggle('danger', danger); $('dialog-confirm').disabled = false; $('dialog-cancel').disabled = false;
  return new Promise(resolve => {
    let completed = false, submitting = false;
    function finish(value) {
      if (completed) return; completed = true;
      form.onsubmit = null; dialog.oncancel = null; dialog.onclose = null;
      $('dialog-cancel').onclick = null; closeDialog(dialog); resolve(value);
    }
    $('dialog-cancel').onclick = () => { if (!submitting) finish(null); };
    dialog.oncancel = event => { event.preventDefault(); if (!submitting) finish(null); };
    dialog.onclose = () => { if (!dialog.open) finish(null); };
    form.onsubmit = async event => {
      event.preventDefault(); if (submitting) return;
      document.activeElement?.blur?.();
      submitting = true; $('dialog-confirm').disabled = true; $('dialog-cancel').disabled = true; $('dialog-error').textContent = '';
      try { const result = await accept(); if (result !== false) finish(result ?? true); }
      catch (error) { $('dialog-error').textContent = error.message; }
      finally { submitting = false; $('dialog-confirm').disabled = false; $('dialog-cancel').disabled = false; }
    };
    openDialog(dialog);
  });
}
function textField(root, label, value = '', id = 'edit-title') {
  const caption = node('label', '', label); caption.htmlFor = id;
  const input = node('input'); Object.assign(input, { id, type: 'text', value, required: true, maxLength: 120 });
  root.append(caption, input); return input;
}
function selectField(root, label, options, id) {
  const caption = node('label', '', label); caption.htmlFor = id;
  const select = node('select'); select.id = id; select.required = true;
  for (const [value, labelText] of options) { const option = node('option', '', labelText); option.value = value; select.append(option); }
  root.append(caption, select); return select;
}
async function createAlbum() {
  let input, replacement;
  const full = state.library.albums.length >= state.library.settings.albumLimit;
  await ask({ heading: full ? '專輯已滿，選擇替換' : '建立新的專輯', description: full ? '請指定要移除的專輯。確認後會連同該專輯中的音訊與字幕刪除，再建立新專輯。' : '給下一段旅程，一個喜歡的名字。', confirm: full ? '刪除所選並建立' : '建立專輯', danger: full,
    build: root => { input = textField(root, '專輯名稱'); if (full) replacement = selectField(root, '要移除的專輯', [['', '請選擇，不會自動刪除'], ...state.library.albums.map(album => [album.id, `${album.title}（${tracksIn(state.library, album.id).length} 集）`])], 'replace-album'); },
    accept: async () => { const next = replacement ? removeAlbum(state.library, replacement.value) : state.library; if (replacement && !replacement.value) throw new Error('請選擇要移除的專輯。'); await commit(addAlbum(next, input.value)); notify('專輯已建立。'); }
  });
}
async function renameItem(kind, item) {
  let input;
  await ask({ heading: kind === 'album' ? '編輯專輯名稱' : '編輯音訊名稱', confirm: '儲存名稱', build: root => { input = textField(root, '名稱', item.title); }, accept: async () => { await commit(rename(state.library, kind, item.id, input.value)); notify('名稱已更新。'); } });
}
async function deleteItem(kind, item) {
  await ask({ heading: kind === 'album' ? '刪除這個專輯？' : '刪除這個音訊？', description: kind === 'album' ? `「${item.title}」及其中 ${tracksIn(state.library, item.id).length} 個音訊與字幕將從此裝置移除，無法復原。` : `「${item.title}」的音訊與字幕將從此裝置移除，無法復原。`, confirm: '確認刪除', danger: true, accept: async () => { await commit(kind === 'album' ? removeAlbum(state.library, item.id) : removeTrack(state.library, item.id)); notify('已刪除所選資料。'); } });
}
async function albumMenu(album) {
  let selected;
  const choice = await ask({ heading: album.title, confirm: '繼續', build: root => { selected = selectField(root, '專輯操作', [['play', '播放整個專輯'], ['rename', '編輯專輯名稱'], ['delete', '刪除專輯及音訊']], 'album-action'); }, accept: () => selected.value });
  if (choice === 'rename') await renameItem('album', album);
  else if (choice === 'delete') await deleteItem('album', album);
  else if (choice === 'play') { const queue = playbackQueue(state.library, album.id); if (!queue.length) notify('這個專輯還沒有音訊。'); else await selectTrack(queue[0], { queue, autoplay: true, expand: true }); }
}
async function trackMenu(track) {
  let selected;
  const choice = await ask({ heading: track.title, confirm: '繼續', build: root => { selected = selectField(root, '音訊操作', [['rename', '編輯音訊名稱'], ['transcribe', '重新產生字幕'], ['delete', '刪除此音訊']], 'track-action'); }, accept: () => selected.value });
  if (choice === 'rename') await renameItem('track', track);
  else if (choice === 'delete') await deleteItem('track', track);
  else if (choice === 'transcribe') await regenerateTranscript(track.id);
}

function updateSourceControls() {
  const busy = !!state.job || !!state.pending || !state.ready;
  $('source-url').disabled = busy;
  $('clear-source-url').disabled = $('source-url').disabled || !$('source-url').value;
  $('start-import').disabled = busy;
  $('audio-file').disabled = busy;
  $('clear-audio-file').disabled = busy || !state.file;
  $('start-file-import').disabled = busy || !state.file;
  $('selected-audio').textContent = state.file ? `${state.file.name} · ${bytes(state.file.size)}` : '尚未選擇音檔。';
  for (const type of ['podcast', 'file']) $(`source-${type}`).disabled = busy;
}
function clearAudioFile() {
  state.file = null; $('audio-file').value = '';
}
function keepConversionAwake(controller) {
  const messages = {
    requesting: '正在啟用轉換期間的螢幕防休眠…',
    active: '轉換期間已啟用螢幕防休眠，完成或停止後會恢復。請保持此 App 在前景。',
    unavailable: '目前無法啟用防休眠。請手動保持螢幕開啟，並保持此 App 在前景。',
    released: '系統已解除防休眠。請手動保持螢幕開啟，並保持此 App 在前景。',
    'release-failed': '無法確認防休眠已解除，請關閉此 App 視窗以恢復。'
  };
  return holdScreenAwake({ signal: controller.signal, visible: () => !document.hidden, onChange: status => {
    if (state.job && state.job !== controller) return;
    const element = $('wake-lock-status');
    element.hidden = status === 'idle'; element.textContent = messages[status] || '';
  } });
}
function setImportProgress({ stage = state.importStage || 'source', message, error = false }) {
  const stages = ['source', 'download', 'decode', 'transcribe', 'save'], index = stages.indexOf(stage);
  state.importStage = stage;
  $('import-progress').hidden = false; $('import-progress').classList.toggle('error', error);
  $('import-stage').textContent = error ? '這次匯入已停止' : stage === 'save' ? '音訊已準備好' : '正在準備你的聆聽';
  $('import-message').textContent = message; $('import-spinner').hidden = error || !state.job;
  document.querySelectorAll('[data-stage]').forEach(item => { const n = stages.indexOf(item.dataset.stage); item.classList.toggle('current', n === index); item.classList.toggle('done', n < index); });
  $('cancel-import').hidden = !state.job; $('finish-import').hidden = !state.pending; $('discard-import').hidden = !state.pending;
  updateSourceControls();
}
function transcriptSummary(track) {
  if (track.transcriptStatus === 'audio-only') return '音訊可保存與播放；這次沒有可用字幕，之後可重新產生。';
  if (track.transcriptStatus === 'partial' || track.segments?.some(segment => segment.timingUncertain)) return '音訊與可用文字已保留；部分字幕未對齊或尚未辨識，已標示，可之後重新產生。';
  return '音訊與原文字幕已完成。';
}
function cancelImport(message = '匯入已停止，原有收藏保持完整。') {
  state.epoch++; state.job?.abort(); state.job = null;
  setImportProgress({ message, error: true });
}
async function startImport(event, type = 'podcast') {
  event.preventDefault();
  if (state.updating || !state.ready || state.job || state.pending || state.clearing) return;
  const controller = new AbortController(), epoch = ++state.epoch; state.job = controller;
  const awake = keepConversionAwake(controller);
  document.querySelector('[data-stage="download"]').hidden = type === 'file';
  document.querySelector('[data-stage="source"]').textContent = type === 'file' ? '檔案' : '來源';
  // Source downloads have a bounded phase; long ASR has no artificial timeout.
  let transferTimer = type === 'podcast' ? setTimeout(() => controller.abort(new DOMException('讀取來源逾時', 'AbortError')), 180000) : null;
  try {
    const importer = type === 'file' ? importAudioFile : importPodcast;
    const result = await importer(type === 'file' ? state.file : $('source-url').value.trim(), { ...state.library.settings }, { signal: controller.signal,
      progress: data => { if (epoch !== state.epoch) return; if (data.stage === 'decode' || data.stage === 'transcribe') { clearTimeout(transferTimer); transferTimer = null; } setImportProgress(data); }
    });
    if (epoch !== state.epoch || controller.signal.aborted) return;
    await awake.release();
    if (epoch !== state.epoch || controller.signal.aborted) return;
    state.job = null; state.pending = { ...result, track: { ...result.track, id: newId() } };
    setImportProgress({ stage: 'save', message: `「${result.track.title}」${clock(result.track.duration)}，${transcriptSummary(result.track)}請選擇要加入的專輯，尚未占用收藏名額。` });
    await finishImport();
  } catch (error) {
    if (epoch === state.epoch) { state.job = null; setImportProgress({ message: error.name === 'AbortError' ? type === 'podcast' && transferTimer ? '來源讀取已取消或超過 3 分鐘；請確認網路後重試。' : '音檔匯入已停止，原有收藏保持完整。' : error.message, error: true }); }
  } finally { clearTimeout(transferTimer); await awake.release(); }
}
async function regenerateTranscript(id) {
  if (!state.ready || state.job || state.pending || state.writing || state.clearing) throw new Error('請先完成或停止目前的處理，再重新產生字幕。');
  const track = state.library.tracks.find(item => item.id === id); if (!track) return;
  const controller = new AbortController(), epoch = ++state.epoch; state.job = controller;
  const awake = keepConversionAwake(controller);
  audio.pause(); closeTranslation();
  document.querySelector('[data-stage="download"]').hidden = true;
  document.querySelector('[data-stage="source"]').textContent = '已存音檔';
  if ($('player').open) closeDialog($('player'));
  showView('import');
  setImportProgress({ stage: 'decode', message: `正在讀取「${track.title}」的已保存音訊，原有字幕會保留到成功更新。請保持此頁在前景。` });
  try {
    const blob = await storage.read(`audio:${id}`);
    if (!blob) throw new Error('找不到已保存的音訊，請重新匯入來源。');
    if (epoch !== state.epoch || controller.signal.aborted) return;
    const transcript = await transcribeSavedAudio(blob, { ...state.library.settings, language: track.language }, { signal: controller.signal, progress: data => { if (epoch === state.epoch) setImportProgress(data); } });
    if (epoch !== state.epoch || controller.signal.aborted) return;
    if (!transcript.segments.length) {
      state.job = null;
      setImportProgress({ stage: 'save', message: '這次未取得新字幕，原有音訊與字幕保持完整，可稍後重試。' });
      return;
    }
    if (!state.library.tracks.some(item => item.id === id)) throw new Error('這個音訊已在其他分頁移除，沒有寫入字幕。');
    state.job = null;
    $('cancel-import').disabled = true;
    try { await commit({ ...state.library, tracks: state.library.tracks.map(item => item.id === id ? { ...item, ...transcript } : item) }); }
    finally { $('cancel-import').disabled = false; }
    if (state.current === id) { state.sentences = readingCues(sentencesFor(currentTrack()), currentTrack().language); renderSubtitles(); updateTimeline(); }
    setImportProgress({ stage: 'save', message: `${transcriptSummary(transcript)}音訊與收藏位置保持不變。` });
    $('import-progress').hidden = true; showView('playlist');
    if (state.current === id) openPlayer();
    notify(transcript.transcriptStatus === 'partial' ? transcriptSummary(transcript) : '已使用保存的音訊重新產生字幕，沒有重新下載音檔。');
  } catch (error) {
    if (epoch === state.epoch) { state.job = null; setImportProgress({ message: `${error.name === 'AbortError' ? '字幕更新已停止。' : error.message} 原有音訊與字幕已保留。`, error: true }); }
  } finally { await awake.release(); }
}
async function finishImport() {
  if (!state.pending || state.job) return;
  let name, destination, newName, replaceAlbum, replaceTrack, extra;
  const pending = state.pending;
  const result = await ask({ heading: '把這段聲音，放進專輯', description: `${transcriptSummary(pending.track)}滿額時請指定替換對象；按下確認後，才會移除所選舊資料。`, confirm: '確認加入／替換',
    build: root => {
      name = textField(root, '音訊名稱', pending.track.title, 'new-track-title');
      destination = selectField(root, '加入專輯', [['', '請選擇專輯'], ...state.library.albums.map(album => [album.id, `${album.title}（${tracksIn(state.library, album.id).length}/${state.library.settings.trackLimit}）`]), ['__new', '＋ 建立新專輯']], 'destination-album');
      extra = node('div'); root.append(extra);
      const update = () => {
        extra.replaceChildren(); newName = replaceAlbum = replaceTrack = null;
        if (destination.value === '__new') {
          newName = textField(extra, '新專輯名稱', '', 'new-album-title');
          if (state.library.albums.length >= state.library.settings.albumLimit) replaceAlbum = selectField(extra, '專輯已滿，確認移除哪一個（含其中所有音訊）', [['', '請選擇要移除的專輯'], ...state.library.albums.map(album => [album.id, `${album.title}（${tracksIn(state.library, album.id).length} 集將刪除）`])], 'new-replace-album');
        } else {
          const existing = tracksIn(state.library, destination.value);
          if (existing.length >= state.library.settings.trackLimit) replaceTrack = selectField(extra, '此專輯已滿，確認要替換哪一個音訊', [['', '請選擇，不會自動刪除'], ...existing.map(track => [track.id, `${track.title} · ${clock(track.duration)}`])], 'replace-track');
        }
      };
      destination.onchange = update;
      if (!state.library.albums.length) destination.value = '__new'; update();
    },
    accept: async () => {
      if (!destination.value) throw new Error('請選擇專輯或建立新專輯。');
      let next = state.library, albumId = destination.value;
      if (albumId === '__new') {
        if (replaceAlbum) { if (!replaceAlbum.value) throw new Error('請選擇要移除的專輯。'); next = removeAlbum(next, replaceAlbum.value); }
        albumId = newId(); next = addAlbum(next, newName.value, albumId);
      }
      if (replaceTrack && !replaceTrack.value) throw new Error('請選擇要替換的音訊。');
      next = placeTrack(next, { ...pending.track, title: name.value }, albumId, replaceTrack?.value);
      await commit(next, { audio: { id: pending.track.id, blob: pending.blob } });
      state.pending = null; return true;
    }
  });
  if (result) { $('source-url').value = ''; clearAudioFile(); $('import-progress').hidden = true; updateSourceControls(); state.album = state.library.tracks.find(track => track.id === pending.track.id)?.albumId || null; renderPlaylist(); showView('playlist'); notify(pending.track.transcriptStatus === 'complete' ? '音訊與字幕已加入專輯，準備好就出發。' : `已加入專輯。${transcriptSummary(pending.track)}`); }
}

function closeTranslation() {
  state.wordSelection = null; renderWordSelection();
  translationAudio.reset(); state.translationCue = null;
  state.translation?.abort(); state.translation = null; $('translation-panel').hidden = true;
  document.querySelectorAll('.sentence-text.translating').forEach(sentence => sentence.classList.remove('translating'));
}
async function translateSentence(index, selectedText) {
  const cue = state.sentences[index], track = currentTrack(); if (!cue || !track) return;
  const text = cue.sourceText || selectedText || cue.text;
  audio.pause(); closeTranslation(); subtitleFollow.suspend();
  const controller = new AbortController(); state.translation = controller;
  state.translationCue = { trackId: track.id, start: cue.sourceStart ?? cue.start, end: Math.min(cue.sourceEnd ?? cue.end, track.duration) };
  $('translation-play').disabled = !(Number.isFinite(cue.start) && Number.isFinite(state.translationCue.end) && state.translationCue.end > cue.start);
  $('translation-panel').hidden = false; $('translation-original').textContent = text;
  $('translation-text').textContent = ''; $('translation-status').textContent = '正在取得這一句的中文翻譯…';
  $('subtitle-list').children[index]?.querySelector('.sentence-text')?.classList.add('translating');
  try {
    const output = await translator.translate(text, track.language, { signal: controller.signal });
    if (state.translation !== controller) return;
    $('translation-text').textContent = output.translation;
    $('translation-status').textContent = output.persisted
      ? output.cached ? '已讀取本機保存，未發出翻譯請求。' : '已保存在此裝置，下次查看不需重新翻譯。'
      : '僅本次暫存；本機保存未完成，關閉後可能需要重新翻譯。';
  } catch (error) { if (state.translation === controller && error.name !== 'AbortError') $('translation-status').textContent = error.message; }
}
function renderSubtitles() {
  state.gestureCleanups.forEach(cleanup => cleanup()); state.gestureCleanups = [];
  const root = $('subtitle-list'); root.replaceChildren();
  if (!state.sentences.length) root.append(node('p', 'small', '尚無字幕'));
  state.sentences.forEach((cue, index) => {
    const row = node('div', 'subtitle-cue');
    const sentence = node('button', 'sentence-text'); sentence.type = 'button';
    if (cue.words?.length) {
      cue.words.forEach((word, wordIndex) => {
        if (wordIndex && !/^(ja|zh)/u.test(currentTrack()?.language || 'en')) sentence.append(document.createTextNode(' '));
        const span = node('span', 'reading-word', word.text); span.dataset.wordIndex = String(wordIndex); sentence.append(span);
      });
    } else sentence.textContent = cue.text;
    sentence.setAttribute('aria-label', '點一下播放此段；長按或按 Enter 翻譯完整原句');
    state.gestureCleanups.push(longPress(sentence, () => translateSentence(index, cue.sourceText || cue.text)));
    sentence.onclick = safe(event => { if (!event.defaultPrevented) seekPlayback(cue.start, true); });
    row.append(sentence);
    if (cue.words?.length) row.classList.add('timed-reading');
    if (cue.incomplete) row.append(node('small', '', '句尾未完整'));
    if (cue.timingUncertain) row.append(node('small', '', '時間範圍估計'));
    root.append(row);
  });
  state.active = state.activeWord = -1; highlight();
}
function highlight(force = false) {
  const time = audio.currentTime || 0, next = findActive(state.sentences, time), rows = $('subtitle-list').children;
  const changed = state.active !== next;
  const word = next >= 0 ? activeWord(state.sentences[next].words, time) : -1, wordChanged = changed || state.activeWord !== word;
  if (changed) {
    rows[state.active]?.classList.remove('active'); rows[state.active]?.removeAttribute('aria-current');
    state.active = next;
    rows[next]?.classList.add('active'); rows[next]?.setAttribute('aria-current', 'true');
  }
  if (wordChanged) {
    $('subtitle-list').querySelectorAll('.spoken-word').forEach(element => { element.classList.remove('spoken-word'); element.removeAttribute('aria-current'); });
    state.activeWord = word;
    const target = rows[next]?.querySelector('[data-word-index="' + word + '"]');
    if (word >= 0 && target) { target.classList.add('spoken-word'); target.setAttribute('aria-current', 'true'); }
  }
  if ((changed || wordChanged || force) && subtitleFollow.enabled && !$('subtitles-panel').hidden && $('player').open && !document.hidden && next >= 0) {
    const target = rows[next]?.querySelector('.spoken-word') || rows[next], list = $('subtitle-list'), bounds = list.getBoundingClientRect(), position = target.getBoundingClientRect();
    if (changed || force || position.top < bounds.top + 8 || position.bottom > bounds.bottom - 8) centerCue(target);
  }
}
function centerCue(row) {
  if (!row) return;
  const root = $('subtitle-list');
  root.scrollTo({ top: subtitleScrollTop({ scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, clientTop: root.clientTop, containerTop: root.getBoundingClientRect().top, cueTop: row.getBoundingClientRect().top }), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function setSubtitlesVisible(show) {
  if (show) { $('guide-panel').hidden = true; $('toggle-guide').setAttribute('aria-pressed', 'false'); $('player').classList.remove('guide-open'); }
  $('subtitles-panel').hidden = !show;
  $('toggle-subtitles').setAttribute('aria-pressed', String(show));
  $('player').classList.toggle('subtitles-open', show);
  $('player').scrollTop = 0;
  if (show) { subtitleFollow.resume(); refreshReadingClock(); }
  else { clearTimeout(readingTimer); closeTranslation(); subtitleFollow.reset(); }
}
function setGuideVisible(show) {
  if (show) setSubtitlesVisible(false);
  else closeTranslation();
  $('guide-panel').hidden = !show; $('toggle-guide').setAttribute('aria-pressed', String(show));
  $('player').classList.toggle('guide-open', show);
  $('player').classList.toggle('subtitles-open', show || !$('subtitles-panel').hidden);
  $('player').scrollTop = 0;
  if (show) void guides.refresh().catch(error => notify(error.message, true));
}
function resetSubtitles() { setSubtitlesVisible(false); setGuideVisible(false); }
function openPlayer() { if (!currentTrack()) return; if (!$('player').open) openDialog($('player')); subtitleFollow.resume(); }
function releasePlayer() {
  state.playerToken++; closeTranslation(); audio.pause(); audio.removeAttribute('src'); audio.load();
  state.current = null; state.queue = []; state.sentences = []; resetSubtitles();
  playerSession = null;
  if ($('player').open) closeDialog($('player'));
  for (const url of state.urls.values()) URL.revokeObjectURL(url); state.urls.clear();
  if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
  state.gestureCleanups.forEach(cleanup => cleanup()); state.gestureCleanups = []; updatePlayer();
}
async function prepareURL(id) {
  if (state.urls.has(id)) return state.urls.get(id);
  const blob = await storage.read(`audio:${id}`);
  if (!blob || !state.library.tracks.some(track => track.id === id)) throw new Error('這個音訊的本機檔案已不存在，請重新匯入來源。');
  if (state.urls.has(id)) return state.urls.get(id);
  const url = URL.createObjectURL(blob); state.urls.set(id, url); return url;
}
async function selectTrack(id, { queue = [id], autoplay = false, expand = false, position } = {}) {
  if (state.updating || !state.ready || state.clearing) return;
  state.loadingAudio++;
  try {
    const track = state.library.tracks.find(track => track.id === id); if (!track) return;
    const token = ++state.playerToken;
    const reuse = state.current === id && state.urls.get(id) === audio.src && audio.readyState >= 1;
    const livePosition = reuse ? audio.currentTime : undefined;
    saveProgress(); if (!reuse) audio.pause(); closeTranslation(); resetSubtitles();
    let url = state.urls.get(id);
    if (!url) url = await prepareURL(id);
    if (token !== state.playerToken) return;
    const saved = position === undefined && !reuse ? await storage.read(`progress:${id}`) : null; if (token !== state.playerToken) return;
    state.current = id; state.resumeTrack = id; state.queue = queue.filter(item => state.library.tracks.some(track => track.id === item));
    const sessionId = crypto.randomUUID(); playerSession = sessionId;
    state.sentences = readingCues(sentencesFor(track), track.language); if (!reuse) { retriedAudioSource = ''; audio.src = url; } audio.playbackRate = +$('playback-speed').value;
    const resumeAt = position ?? livePosition ?? saved?.position ?? track.position ?? 0;
    const start = resumeAt >= track.duration - 1 ? 0 : Math.max(0, Math.min(track.duration - 0.1, resumeAt));
    const seek = () => { if (token === state.playerToken) { audio.currentTime = start; updateTimeline(); } };
    if (!reuse || position !== undefined || audio.ended) { audio.onloadedmetadata = seek; if (audio.readyState >= 1) seek(); }
    renderSubtitles(); updatePlayer(); renderPlaylist(); updateMediaSession();
    if (expand) openPlayer();
    const snapshot = { sessionId, trackId: id, queue: [...state.queue], position: start, speed: audio.playbackRate };
    // Persist player actions in their captured order, including a later dismiss.
    // Start playback in this turn: waiting for IDB must not override a newer pause.
    progressChain = progressChain.catch(() => {}).then(() => storage.savePlayer(snapshot, { activate: true }));
    if (autoplay) play();
    await progressChain;
    if (token !== state.playerToken) return;
    void guides.refresh().catch(() => {});
    saveProgress();
    // Prepare the album queue while in foreground so the next track doesn't
    // depend on an IndexedDB read after the phone locks.
    const preparedQueue = state.library.settings.repeatMode === 'album' ? tracksIn(state.library, track.albumId).map(item => item.id) : state.queue;
    await Promise.allSettled(preparedQueue.map(next => prepareURL(next)));
    if (token !== state.playerToken) return;
    for (const [key, value] of state.urls) if (key !== id && !preparedQueue.includes(key)) { URL.revokeObjectURL(value); state.urls.delete(key); }
  } finally { state.loadingAudio--; }
}
function play() {
  if (state.updating || !currentTrack() || !audio.src) return;
  closeTranslation(); subtitleFollow.resume();
  $('player-feedback').textContent = '';
  audio.play().catch(() => { $('player-feedback').textContent = '音訊已就緒，請再按一下播放。'; notify('音訊已就緒，請再按一下播放。'); });
}
function togglePlay() { if (audio.paused) play(); else audio.pause(); }
function seekPlayback(target, resume = !audio.paused) {
  closeTranslation(); audio.currentTime = target; updateTimeline(); subtitleFollow.resume();
  if (resume && audio.paused) play();
  saveProgress();
}
function seekSentence(direction) {
  if (state.updating) return;
  if (!state.sentences.length) { $('player-feedback').textContent = '目前尚無字幕，可使用播放進度移動。'; return; }
  const target = sentenceTarget(state.sentences, audio.currentTime || 0, direction);
  if (target === null) { $('player-feedback').textContent = '已到最後一句。'; return; }
  seekPlayback(target);
}
function updatePlayer() {
  const track = currentTrack(); $('mini-player').hidden = !track; $('app').classList.toggle('has-player', !!track); renderResume();
  if (!track) return;
  const mode = state.library.settings.repeatMode || 'off';
  $('repeat-label').textContent = { off: '順序', track: '單曲', album: '專輯' }[mode];
  $('playback-repeat').setAttribute('aria-label', `播放模式：${{ off: '一般播放', track: '單曲循環', album: '專輯循環' }[mode]}，點按切換`);
  $('playback-repeat').classList.toggle('repeat-active', mode !== 'off');
  $('mini-title').textContent = track.title; $('mini-subtitle').textContent = albumOf(track)?.title || 'CommuteLingo';
  $('player-title').textContent = track.title; $('player-show').textContent = track.show || '你的通勤語言時光'; $('player-album').textContent = albumOf(track)?.title || '';
  cover($('mini-cover'), track.albumId); cover($('player-art'), track.albumId);
  for (const id of ['mini-play', 'player-play']) { $(id).innerHTML = icon(audio.paused ? 'play' : 'pause'); $(id).setAttribute('aria-label', audio.paused ? '播放' : '暫停'); }
  for (const id of ['mini-next', 'previous-sentence', 'next-sentence']) $(id).disabled = !state.sentences.length;
  updateTimeline();
}
function updateTimeline() {
  const track = currentTrack(); if (!track) return;
  const time = Math.max(0, audio.currentTime || 0), duration = track.duration;
  $('playback-range').max = duration;
  if (!state.seeking) $('playback-range').value = time;
  $('elapsed').textContent = clock(time); $('remaining').textContent = `−${clock(Math.max(0, duration - time))}`;
  $('mini-progress-fill').style.width = `${Math.min(100, time / duration * 100)}%`;
  if ('mediaSession' in navigator && Number.isFinite(duration) && duration > 0) {
    try { navigator.mediaSession.setPositionState?.({ duration, playbackRate: audio.playbackRate, position: Math.min(duration, time) }); } catch { /* Optional OS integration. */ }
  }
  highlight();
  const subtitleState = !track.segments.length ? '尚無字幕' : track.transcriptStatus === 'partial' || transcriptCoverage(track.segments, duration).needsReview ? '字幕未完整' : track.segments.some(segment => segment.timingUncertain) ? '字幕時間為估計範圍' : state.sentences.some(cue => !cue.words) ? '句子字幕' : '逐字字幕';
  $('toggle-subtitles').setAttribute('aria-label', subtitleState);
}
async function saveProgress({ strict = false } = {}) {
  const track = currentTrack(); if (!track || state.clearing || !state.ready) return;
  const position = Math.min(track.duration, translationAudio.returnTime ?? (audio.currentTime || 0));
  const snapshot = { sessionId: playerSession, trackId: track.id, queue: [...state.queue], position, speed: audio.playbackRate };
  try {
    progressChain = progressChain.catch(() => {}).then(() => state.clearing ? undefined : storage.savePlayer(snapshot));
    await progressChain;
  } catch (error) { notify('播放進度暫時無法保存。', true); if (strict) throw error; }
}
async function dismissPlayer() {
  const track = currentTrack(); if (!track) return;
  const snapshot = { sessionId: playerSession, trackId: track.id, queue: [...state.queue], position: translationAudio.returnTime ?? audio.currentTime ?? 0, speed: audio.playbackRate };
  releasePlayer();
  progressChain = progressChain.catch(() => {}).then(() => storage.savePlayer(snapshot, { dismiss: true }));
  await progressChain;
}
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = currentTrack(); if (!track) return;
  if (globalThis.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.show || 'CommuteLingo', album: albumOf(track)?.title || '', artwork: [{ src: new URL(`./icon-${state.library.settings.icon}-512.png`, location.href).href, sizes: '512x512', type: 'image/png' }] });
  const actions = { play, pause: () => audio.pause(), stop: () => { closeTranslation(); audio.pause(); audio.currentTime = 0; saveProgress(); }, seekbackward: () => seekSentence(-1), seekforward: () => seekSentence(1), previoustrack: () => seekSentence(-1), nexttrack: () => seekSentence(1), seekto: event => { if (Number.isFinite(event.seekTime)) seekPlayback(Math.min(track.duration, Math.max(0, event.seekTime))); } };
  for (const [action, handler] of Object.entries(actions)) { try { navigator.mediaSession.setActionHandler(action, (...args) => { if (!state.updating) handler(...args); }); } catch { /* Unsupported action on this OS. */ } }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function backup({ share = false } = {}) {
  if (!state.ready || state.backup || state.writing || state.restoring) return;
  if (state.wordLookup) throw new Error('請等待單字解釋查詢完成，再備份最新資料。');
  const controller = new AbortController(); state.backup = controller;
  $('backup-library').disabled = true; $('share-backup').disabled = true;
  try {
    const snapshot = await storage.readPersonalData();
    const archive = personalBackup((snapshot.library || state.library).settings, snapshot.vocabulary || state.vocabulary);
    if (controller.signal.aborted) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = 'CommuteLingo-personal-' + stamp + '.json';
    if (share) {
      if (typeof File !== 'function' || !navigator.share || !navigator.canShare) throw new Error('此瀏覽器不支援分享備份檔，請使用「備份設定與單字本」下載。');
      const file = new File([archive], name, { type: 'application/json' });
      if (!navigator.canShare({ files: [file] })) throw new Error('此瀏覽器不支援分享 JSON，請改用下載備份。');
      await ask({ heading: '備份已準備好', description: '只包含一般設定與單字本。按下按鈕後，可在系統分享選單中選擇「儲存到檔案」；實際選項由裝置提供。', confirm: '選擇儲存位置', accept: async () => {
        if (controller.signal.aborted) throw new Error('備份已取消，請重新準備。');
        try { await navigator.share({ files: [file], title: 'CommuteLingo 設定與單字本' }); }
        catch (error) { if (error.name !== 'AbortError') throw new Error('無法開啟分享，請改用下載備份。'); }
      } });
    } else {
      download(archive, name); notify('設定與單字本已準備下載；請在「檔案」確認保存，不包含音訊或 API Key。');
    }
  } finally { state.backup = null; $('backup-library').disabled = !state.ready || state.restoring; $('share-backup').disabled = $('backup-library').disabled; }
}
async function restoreBackup(file) {
  if (!file) return;
  if (!state.ready || state.restoring || state.writing || state.clearing || state.updating || state.job || state.pending || state.wordLookup) throw new Error('請先完成或停止目前的處理，再還原備份。');
  state.restoring = true; $('restore-backup').disabled = true; $('restore-backup-button').disabled = true;
  try {
    const incoming = await readPersonalBackup(file);
    const snapshot = await storage.readPersonalData();
    const library = snapshot.library || state.library;
    const vocabulary = validateVocabulary(snapshot.vocabulary || state.vocabulary);
    const preview = planPersonalRestore(library, vocabulary, incoming);
    personalBackup(library.settings, preview.vocabulary);
    let settings;
    await ask({ heading: '預覽備份還原', description: '備份日期：' + new Date(incoming.createdAt).toLocaleString('zh-TW') + '\n新增 ' + preview.added + ' 個單字，重複 ' + preview.duplicates + ' 個（其中 ' + preview.enriched + ' 個可補充資料）。\n重複單字保留本機解釋、學習狀態與筆記，只補空白欄位、合併標籤與星號；既有音檔與專輯不變。', confirm: '確認合併還原',
      build: root => {
        const label = node('label', 'choice-card'); settings = node('input'); settings.type = 'checkbox'; settings.id = 'restore-settings'; settings.checked = false;
        label.append(settings, node('span', '', '同時套用備份中的一般設定')); root.append(label);
        root.append(node('p', 'small muted', '若備份設定的容量或長度上限低於現有收藏，會停止還原；取消勾選後仍可只合併單字，不會自動刪除音檔。'));
      }, accept: async () => {
        if (state.clearing || state.updating || state.writing || state.job) throw new Error('資料處理中，請稍後重新還原。');
        const nextLibrary = settings.checked ? changeSettings(library, incoming.settings) : library;
        const restoredLibrary = { ...nextLibrary, revision: library.revision + 1 };
        const restoredVocabulary = { ...preview.vocabulary, revision: vocabulary.revision + 1 };
        personalBackup(restoredLibrary.settings, restoredVocabulary);
        state.writing = true;
        try {
          await storage.commitPersonalData(restoredLibrary, restoredVocabulary, { expectedLibraryRevision: library.revision, expectedVocabularyRevision: vocabulary.revision, expectedGeneration: vocabulary.generation, expectedLibrary: snapshot.library });
          state.library = restoredLibrary; state.vocabulary = restoredVocabulary;
          if (settings.checked) state.settingsDirty = false;
        } finally { state.writing = false; }
        render(); state.channel?.postMessage({ type: 'personal-restored' });
        notify('單字本已合併還原' + (settings.checked ? '，一般設定已套用。' : '，保留目前設定。'));
      }
    });
  } finally { state.restoring = false; $('restore-backup').disabled = !state.ready; $('restore-backup-button').disabled = $('restore-backup').disabled; $('backup-library').disabled = !state.ready || !!state.backup; $('share-backup').disabled = $('backup-library').disabled; $('add-word').disabled = !state.ready; renderWordSelection(); }
}

async function clearAll() {
  if (state.job || state.writing || state.restoring || guides.keyBusy) throw new Error('請先停止來源匯入，或等待儲存完成。');
  await ask({ heading: '清除全部收藏與資料？', description: `將刪除 ${state.library.albums.length} 個專輯、${state.library.tracks.length} 個音訊（${bytes(libraryBytes(state.library))}）、${state.vocabulary.words.length} 個單字與筆記、字幕、導讀、Gemini Key、翻譯快取、設定、舊版資料與下載的語音模型。
此操作無法復原。App 頁面程式會保留；其他 App 的資料不受影響。`, confirm: '確認全部清除', danger: true,
    accept: async () => {
      state.clearing = true; guides.clear(); cancelWordLookup(); state.backup?.abort(); closeTranslation(); audio.pause();
      try {
        await storage.clear();
        releasePlayer(); translator.clear(); state.pending = null; state.legacy = null; state.library = emptyLibrary(); state.vocabulary = emptyVocabulary(); state.settingsDirty = false; state.album = null;
        const failures = [];
        try { if (globalThis.caches) for (const key of await caches.keys()) if (key === 'commute-lingo-models-v1') { try { await caches.delete(key); } catch { failures.push(key); } } }
        catch { failures.push('model-cache'); }
        clearAudioFile(); render(); $('import-progress').hidden = true; $('source-url').value = ''; updateSourceControls();
        state.channel?.postMessage({ type: 'cleared' });
        notify(failures.length ? '收藏與設定已清除，但模型快取尚未清除，請稍後重試。' : '全部收藏與資料已清除。', !!failures.length);
      } finally { state.clearing = false; renderWriteControls(); }
    }
  });
}
function orientation() {
  const blocked = isMobileLandscape({ coarse: matchMedia('(pointer: coarse)').matches, orientationType: screen.orientation?.type, orientationAngle: typeof window.orientation === 'number' ? window.orientation : undefined, width: screen.width, height: screen.height });
  document.body.classList.toggle('is-landscape', blocked); $('landscape-gate').hidden = !blocked; $('app').inert = blocked;
  if (!blocked && state.ready && !audio.paused) highlight(true);
}

fillIcons();
document.querySelectorAll('[data-tab]').forEach(tab => { tab.onclick = () => showView(tab.dataset.tab); });
document.querySelectorAll('[data-go]').forEach(link => { link.onclick = () => showView(link.dataset.go); });
$('header-settings').onclick = () => showView('settings');
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
$('create-album').onclick = safe(createAlbum);
$('import-form').onsubmit = safe(startImport);
$('file-import-form').onsubmit = safe(event => startImport(event, 'file'));
$('audio-file').addEventListener('change', () => {
  if (state.updating || $('audio-file').disabled) return;
  state.file = $('audio-file').files?.[0] || null; updateSourceControls();
});
$('clear-audio-file').onclick = () => {
  if (state.updating || $('audio-file').disabled) return;
  clearAudioFile(); updateSourceControls(); $('audio-file').focus();
};
$('source-url').addEventListener('input', updateSourceControls);
$('clear-source-url').onclick = () => {
  if (state.updating || $('source-url').disabled) return;
  $('source-url').value = ''; updateSourceControls(); $('source-url').focus();
};
$('cancel-import').onclick = () => cancelImport();
$('finish-import').onclick = safe(finishImport);
$('discard-import').onclick = safe(async () => { const result = await ask({ heading: '捨棄這次匯入？', description: '已轉換的音訊與字幕尚未加入專輯，捨棄後需要重新匯入與轉錄。', confirm: '確認捨棄', danger: true }); if (result) { state.pending = null; $('import-progress').hidden = true; updateSourceControls(); } });
for (const type of ['podcast', 'file']) $(`source-${type}`).onclick = () => {
  if (state.updating || state.job || state.pending) return;
  for (const name of ['podcast', 'file']) { $(`source-${name}`).classList.toggle('selected', name === type); $(`source-${name}`).setAttribute('aria-pressed', String(name === type)); $(`${name}-source`).hidden = name !== type; }
};
$('settings-form').onsubmit = safe(async event => {
  event.preventDefault(); $('settings-message').textContent = '';
  document.activeElement?.blur?.();
  try {
    const settings = { albumLimit: +$('setting-albums').value, trackLimit: +$('setting-tracks').value, maxMinutes: +$('setting-minutes').value, autoUpdate: $('setting-auto-update').checked, subtitleSize: $('setting-subtitles').value, language: $('setting-language').value, model: $('setting-model').value, icon: 'sunrise', autoGuide: false, geminiModel: $('setting-gemini-model').value, guidePrompt: $('setting-guide-prompt').value };
    await commit(changeSettings(state.library, settings)); state.settingsDirty = false; updateMediaSession(); $('settings-message').textContent = '設定已儲存。'; void updater.refresh();
  } catch (error) { $('settings-message').textContent = error.message; }
});
for (const event of ['input', 'change']) $('settings-form').addEventListener(event, () => { state.settingsDirty = true; });
$('check-update').onclick = () => { void updater.check(); };
$('apply-update').onclick = () => { void updater.apply(); };
$('reset-guide-prompt').onclick = () => { $('setting-guide-prompt').value = GUIDE_INSTRUCTION; state.settingsDirty = true; $('settings-message').textContent = '已恢復預設 Prompt，請按儲存設定。'; };
$('setting-subtitles').onchange = () => { document.documentElement.style.setProperty('--subtitle-size', { normal: '18.4px', large: '22.4px', xlarge: '27.2px' }[$('setting-subtitles').value]); };
$('request-persistence').onclick = safe(async () => {
  if (!navigator.storage?.persist) { $('persistence-status').textContent = '此瀏覽器未提供持續保存請求；請定期匯出備份。'; return; }
  const granted = await navigator.storage.persist(); $('persistence-status').textContent = granted ? '瀏覽器已授予持續保存，仍建議保留備份。' : '瀏覽器未授予持續保存，仍可使用收藏，請定期備份。'; if (granted) $('request-persistence').hidden = true;
});
$('backup-library').onclick = safe(() => backup()); $('clear-data').onclick = safe(clearAll);
$('share-backup').onclick = safe(() => backup({ share: true }));
$('restore-backup-button').onclick = () => $('restore-backup').click();
$('restore-backup').addEventListener('change', safe(async () => { const file = $('restore-backup').files?.[0]; try { await restoreBackup(file); } finally { $('restore-backup').value = ''; } }));
$('add-word').onclick = safe(createWord);
$('save-selected-word').onclick = safe(saveSelectedWord);
document.addEventListener('selectionchange', captureWordSelection);
for (const name of ['vocabulary-search', 'vocabulary-filter', 'vocabulary-tag']) $(name).addEventListener(name === 'vocabulary-search' ? 'input' : 'change', () => { state.wordLimit = 40; renderVocabulary(); });
$('vocabulary-more').onclick = () => { state.wordLimit += 40; renderVocabulary(); };
$('legacy-backup').onclick = () => { if (state.legacy?.file) download(state.legacy.file, state.legacy.name || 'legacy-audio.mp3'); };
$('mini-open').onclick = openPlayer; $('mini-play').onclick = togglePlay; $('player-play').onclick = togglePlay;
$('mini-dismiss').onclick = safe(dismissPlayer);
$('toggle-guide').onclick = () => setGuideVisible($('guide-panel').hidden);
$('playback-repeat').onclick = safe(async () => {
  const modes = ['off', 'track', 'album'], mode = modes[(modes.indexOf(state.library.settings.repeatMode) + 1) % modes.length];
  await commit(changeSettings(state.library, { repeatMode: mode }));
  if (mode === 'album' && currentTrack()) await Promise.allSettled(tracksIn(state.library, currentTrack().albumId).map(track => prepareURL(track.id)));
});
$('mini-next').onclick = () => seekSentence(1); $('previous-sentence').onclick = () => seekSentence(-1); $('next-sentence').onclick = () => seekSentence(1);
$('player-close').onclick = () => closeDialog($('player')); $('player').addEventListener('close', resetSubtitles);
$('player-menu').onclick = safe(() => currentTrack() && trackMenu(currentTrack()));
$('player-stop').onclick = () => { closeTranslation(); audio.pause(); audio.currentTime = 0; updateTimeline(); saveProgress(); };
$('playback-speed').onchange = () => { audio.playbackRate = +$('playback-speed').value; updateTimeline(); saveProgress(); };
$('playback-range').oninput = event => { state.seeking = true; $('elapsed').textContent = clock(+event.target.value); };
$('playback-range').onchange = event => { state.seeking = false; seekPlayback(+event.target.value); };
$('toggle-subtitles').onclick = () => setSubtitlesVisible($('subtitles-panel').hidden);
$('follow-subtitles').onclick = () => subtitleFollow.resume();
$('subtitle-list').addEventListener('pointerdown', event => { if (event.pointerType !== 'touch') subtitleFollow.hold('pointer'); }, { passive: true });
for (const name of ['pointerup', 'pointercancel']) window.addEventListener(name, () => subtitleFollow.release('pointer'), { passive: true });
$('subtitle-list').addEventListener('touchstart', () => subtitleFollow.hold('touch'), { passive: true });
for (const name of ['touchend', 'touchcancel']) window.addEventListener(name, () => subtitleFollow.release('touch'), { passive: true });
$('subtitle-list').addEventListener('wheel', () => subtitleFollow.browse(), { passive: true });
$('subtitle-list').addEventListener('scroll', () => subtitleFollow.scrolled(), { passive: true });
$('subtitle-list').addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) subtitleFollow.browse(); });
$('translation-close').onclick = () => { const shown = !$('translation-panel').hidden; closeTranslation(); if (shown) play(); };
$('translation-play').onclick = safe(async () => {
  const cue = state.translationCue, controller = state.translation;
  if (!controller || !cue || cue.trackId !== state.current || state.updating) return;
  if (translationAudio.playing) { translationAudio.pause(); return; }
  try { await translationAudio.start(cue); }
  catch { if (state.translation === controller) $('translation-status').textContent = '原音無法播放，請再按一次，或重新選擇音訊。'; }
  updateTimeline();
});
audio.addEventListener('play', () => {
  // Normal play actions close translation before calling audio.play(). A late
  // native play event must not undo a newer pause-to-read action.
  if (state.translation && !translationAudio.active) { audio.pause(); updatePlayer(); return; }
  if (!translationAudio.active) { closeTranslation(); subtitleFollow.resume(); }
  updatePlayer(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => { updatePlayer(); saveProgress(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('timeupdate', () => { updateTimeline(); if (performance.now() - state.lastProgressSave > 8000) { state.lastProgressSave = performance.now(); saveProgress(); } });
audio.addEventListener('seeked', () => { updateTimeline(); if (!state.translation) subtitleFollow.resume(); });
audio.addEventListener('error', () => {
  if (!state.current) return;
  const failed = () => {
    $('player-feedback').textContent = '音訊播放失敗，請重新選擇音訊或匯入來源。';
    notify('音訊播放失敗，請重新選擇音訊或匯入來源。', true);
  };
  // Re-loading a failing stored-Blob URL synchronously can fail again in WebKit.
  // Rehydrate its unchanged bytes once; never fetch a remote source or retry
  // after a newer pause, stop, source selection, translation, clear or update.
  if (audio.error?.code === 4 && audio.readyState === 0 && !audio.paused && audio.src.startsWith('blob:') && retriedAudioSource !== audio.src && !state.translation && !state.clearing && !state.updating) {
    const source = audio.src, id = state.current, token = state.playerToken;
    retriedAudioSource = source;
    const valid = () => token === state.playerToken && state.current === id && audio.src === source && state.urls.get(id) === source && !audio.paused && !state.translation && !state.clearing && !state.updating;
    void (async () => {
      const blob = await storage.read(`audio:${id}`);
      if (!valid()) return;
      if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > 250 * 1024 * 1024) throw Error('Invalid local audio');
      const bytes = await blob.arrayBuffer();
      if (!valid()) return;
      if (bytes.byteLength !== blob.size) throw Error('Incomplete local audio');
      const rate = audio.playbackRate, fresh = URL.createObjectURL(new Blob([bytes], { type: blob.type }));
      // Mark the replacement too, so a genuine decoder/format error stops here.
      retriedAudioSource = fresh; state.urls.set(id, fresh); audio.src = fresh;
      URL.revokeObjectURL(source); audio.load(); audio.playbackRate = rate;
      $('player-feedback').textContent = '';
      try { await audio.play(); }
      catch { if (token === state.playerToken && audio.src === fresh && !audio.paused && audio.error) failed(); }
    })().catch(() => { if (valid()) failed(); });
    return;
  }
  failed();
});
audio.addEventListener('ended', safe(async () => {
  if (translationAudio.active) return;
  const next = nextPlayback(state.library, state.current, state.queue);
  saveProgress(); if (next) await selectTrack(next.id, { queue: next.queue, autoplay: true, position: 0 }); else { updatePlayer(); $('player-feedback').textContent = '這段旅程已聽完。'; }
}));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { translationAudio.pause(); if (state.job) cancelImport('來源匯入因離開前景而停止，請回來後重新開始。原有收藏已保留。'); saveProgress(); }
  else { updateTimeline(); if (!audio.paused) subtitleFollow.resume(); orientation(); if (state.library.settings.autoUpdate) void updater.check(); }
});
window.addEventListener('pagehide', () => { guides.clear(); translationAudio.pause(); if (state.job) cancelImport(); state.translation?.abort(); state.backup?.abort(); cancelWordLookup(); saveProgress(); });
window.addEventListener('orientationchange', orientation); screen.orientation?.addEventListener('change', orientation); window.addEventListener('resize', orientation);
async function offlineStatus() {
  if (!('serviceWorker' in navigator)) { void updater.start(); $('offline-status').textContent = '此瀏覽器未提供離線頁面支援。'; return; }
  try {
    const registration = await updater.start(); await navigator.serviceWorker.ready;
    if (state.library.settings.autoUpdate) void updater.check();
    const check = () => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); $('offline-status').textContent = '新版可在線使用；請在保存後關閉舊分頁再開啟，以更新離線頁面。'; }, 2000);
      channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); $('offline-status').textContent = data.version === '0.2.22' && data.ready ? '頁面已可離線使用；已收藏的音訊與快取翻譯可離線讀取，新匯入與新翻譯需要連線。' : '新版可在線使用，離線頁面尚待更新。'; };
      registration.active?.postMessage({ type: 'CACHE_VERSION' }, [channel.port2]);
    };
    navigator.serviceWorker.addEventListener('controllerchange', check); check();
  } catch { $('offline-status').textContent = '離線頁面尚未就緒，目前可在線使用。'; }
}
async function boot() {
  $('start-import').disabled = true;
  try {
    let library = await storage.read(LIBRARY_KEY);
    if (!library) {
      const saved = await storage.read('session'), migration = legacyLibrary(saved);
      if (migration) {
        library = { ...migration.library, revision: 1 };
        await storage.commitLibrary(library, { expectedRevision: 0, audio: migration.audio, removeSession: true });
        if (migration.translations.length) await translator.seed(migration.translations);
        notify(`已保留舊版音訊與字幕，放入「上次的通勤」。${library.settings.maxMinutes > DEFAULT_SETTINGS.maxMinutes ? `為保留這集，長度上限調整為 ${library.settings.maxMinutes} 分鐘。` : ''}`);
      } else { library = emptyLibrary(); state.legacy = saved || null; }
    }
    if (library.schema !== 2 || !Array.isArray(library.albums) || !Array.isArray(library.tracks)) throw new Error('收藏資料格式無法讀取；原始資料仍保留，請勿清除。');
    // The user settled on a fixed orange identity; upgrade earlier icon
    // preferences without changing any saved albums, audio or translations.
    if (library.appearanceVersion !== 2) {
      const previousRevision = library.revision;
      library = { ...library, appearanceVersion: 2, revision: previousRevision + 1, settings: { ...library.settings, icon: 'sunrise' } };
      await storage.commitLibrary(library, { expectedRevision: previousRevision });
    }
    const vocabulary = await storage.read(VOCABULARY_KEY);
    state.vocabulary = vocabulary ? validateVocabulary(vocabulary) : emptyVocabulary();
    library.settings = validateSettings(library.settings); state.library = library; state.ready = true;
    await guides.refresh();
    render();
    const restoreToken = state.playerToken;
    const [savedPlayer, lastListened] = await Promise.all([storage.read('player-v2'), storage.read('last-listened-v1')]);
    if (restoreToken === state.playerToken) { state.resumeTrack = lastListened?.trackId || null; renderResume(); }
    if (restoreToken === state.playerToken && savedPlayer && library.tracks.some(track => track.id === savedPlayer.trackId)) {
      if ([...$('playback-speed').options].some(option => option.value === String(savedPlayer.speed))) $('playback-speed').value = savedPlayer.speed;
      await selectTrack(savedPlayer.trackId, { queue: Array.isArray(savedPlayer.queue) ? savedPlayer.queue : [savedPlayer.trackId], position: savedPlayer.position });
    }
    $('start-import').disabled = false;
    if (globalThis.BroadcastChannel) {
      state.channel = new BroadcastChannel('commute-lingo-library-v2');
      state.channel.onmessage = safe(async ({ data }) => {
        if (data.type === 'gemini-key-changed') { guides.clear(); await guides.refresh(); return; }
        if (data.type === 'guide-changed') { await guides.refresh(); return; }
        try {
          if (data.type === 'cleared') {
            state.clearing = true; guides.clear(); cancelImport('其他分頁已清除收藏。'); releasePlayer();
            state.pending = null; state.legacy = null; state.backup?.abort(); cancelWordLookup(); state.settingsDirty = false; translator.clear();
          }
          const fresh = await storage.readPersonalData();
          const libraryChanged = (fresh.library?.revision ?? 0) !== state.library.revision;
          const nextVocabulary = fresh.vocabulary ? validateVocabulary(fresh.vocabulary) : emptyVocabulary();
          if (state.wordLookup && (nextVocabulary.generation !== state.vocabulary.generation || nextVocabulary.revision !== state.vocabulary.revision)) cancelWordLookup();
          state.vocabulary = nextVocabulary;
          state.library = fresh.library || emptyLibrary();
          if (state.current && !currentTrack()) releasePlayer();
          if (data.type === 'words-changed' && !libraryChanged) { renderVocabulary(); renderWordSelection(); }
          else render();
          await guides.refresh();
          notify('已同步這個裝置其他分頁的資料變更。');
        } finally { state.clearing = false; renderWriteControls(); }
      });
    }
  } catch (error) { notify(`無法讀取收藏：${error.message}`, true); $('storage-detail').textContent = error.message; }
  showView(location.hash.slice(1) || 'playlist'); orientation(); offlineStatus();
}
boot();

for (const event of ['play', 'playing', 'pause', 'ended', 'seeked', 'ratechange']) audio.addEventListener(event, refreshReadingClock);
document.addEventListener('visibilitychange', refreshReadingClock);
