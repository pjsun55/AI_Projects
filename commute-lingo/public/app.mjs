import { formatTime, findActive, transcriptCoverage, toSRT, sentenceTexts } from './core.mjs?v=0.2.9';
import * as storage from './storage.mjs?v=0.2.9';
import { createTranslator } from './translation.mjs?v=0.2.9';
import { DEFAULT_SETTINGS, LIBRARY_KEY, emptyLibrary, validateSettings, title, tracksIn, addAlbum, removeAlbum, removeTrack, rename, placeTrack, changeSettings, libraryBytes, playbackQueue, sentenceTarget, sentencesFor, legacyLibrary, newId } from './library.mjs?v=0.2.9';
import { importPodcast, transcribeSavedAudio } from './source.mjs?v=0.2.9';
import { icon, fillIcons } from './icons.mjs?v=0.2.9';
import { longPress, isMobileLandscape } from './gestures.mjs?v=0.2.9';
import { zipFiles } from './backup.mjs?v=0.2.9';
import { createSubtitleFollow, subtitleScrollTop, sentenceReadingParts } from './subtitles.mjs?v=0.2.9';
import { createUpdater, reloadVersion } from './updates.mjs?v=0.2.9';

const $ = id => document.getElementById(id);
const audio = $('audio');
const state = { library: emptyLibrary(), ready: false, view: 'playlist', album: null, current: null, queue: [], urls: new Map(), sentences: [], active: -1, seeking: false, playerToken: 0, lastProgressSave: 0, translation: null, pending: null, job: null, epoch: 0, writing: false, clearing: false, gestureCleanups: [], legacy: null, backup: null, updating: false, settingsDirty: false, loadingAudio: 0 };
const subtitleFollow = createSubtitleFollow({ onFollow: () => highlight(true), canResume: () => !audio.paused && !document.hidden && $('player').open && !$('subtitles-panel').hidden && !state.translation });
let messageTimer;
const clock = value => formatTime(Number.isFinite(value) ? value : 0).replace(/^00:/, '');
const bytes = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const currentTrack = () => state.library.tracks.find(track => track.id === state.current);
const albumOf = track => state.library.albums.find(album => album.id === track?.albumId);
const safe = action => (...args) => { try { return Promise.resolve(action(...args)).catch(error => notify(error.message, true)); } catch (error) { notify(error.message, true); } };
const updater = createUpdater({
  serviceWorker: navigator.serviceWorker, version: '0.2.9',
  isAuto: () => state.library.settings.autoUpdate,
  visible: () => !document.hidden,
  canUpdate: () => state.ready && audio.paused && !state.loadingAudio && !state.job && !state.pending && !state.writing && !state.clearing && !state.backup && !state.translation && !state.settingsDirty && !$('player').open && !$('action-dialog').open && !$('source-url').value.trim() && !document.activeElement?.matches?.('input,select,textarea'),
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
  if (!['playlist', 'library', 'import', 'settings'].includes(name)) name = 'playlist';
  state.view = name;
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
  document.querySelectorAll('[data-tab]').forEach(tab => {
    const active = tab.dataset.tab === name; tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'library') refreshStorage();
  window.scrollTo({ top: 0 });
}
async function commit(next, options = {}) {
  if (state.updating) throw new Error('正在套用新版，請稍候。');
  if (!state.ready) throw new Error('收藏尚未讀取完成，請稍後再試。');
  if (state.writing || state.clearing) throw new Error('資料儲存中，請稍後再試。');
  if (state.job) throw new Error('請等待來源匯入完成，或先停止處理。');
  state.writing = true;
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
  } finally { state.writing = false; }
}
function render() {
  renderPlaylist(); renderLibrary(); renderSettings();
  $('import-limit').textContent = `目前每集上限 ${state.library.settings.maxMinutes} 分鐘；每個專輯可保存 ${state.library.settings.trackLimit} 集。超過長度上限會直接停止。`;
  $('backup-library').disabled = !state.library.tracks.length || !!state.backup;
  $('legacy-backup').hidden = !state.legacy;
  updatePlayer(); refreshStorage();
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
  const resume = $('resume-card'); resume.replaceChildren();
  const track = currentTrack();
  if (track) {
    const card = node('div', 'resume-card'); card.append(cover(node('div', 'cover track-cover'), track.albumId));
    const body = button('', 'track-main', () => openPlayer()); body.append(node('small', '', '接著上次，繼續聽'), node('strong', '', track.title));
    card.append(body, button('繼續播放', 'round-button', play, 'play')); resume.append(card);
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
  const settings = state.library.settings;
  for (const [id, value] of [['setting-albums', settings.albumLimit], ['setting-tracks', settings.trackLimit], ['setting-minutes', settings.maxMinutes], ['setting-subtitles', settings.subtitleSize], ['setting-language', settings.language], ['setting-model', settings.model]]) $(id).value = value;
  $('setting-auto-update').checked = settings.autoUpdate;
  applyAppearance(settings);
}
function applyAppearance(settings) {
  document.documentElement.style.setProperty('--subtitle-size', { normal: '18.4px', large: '22.4px', xlarge: '27.2px' }[settings.subtitleSize]);
  $('brand-icon').src = `./icon-${settings.icon}.svg`; $('favicon').href = `./icon-${settings.icon}.svg`;
  $('touch-icon').href = `./icon-${settings.icon}-192.png`;
  $('manifest').href = `./manifest-${settings.icon}.webmanifest?v=0.2.9`;
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
  const choice = await ask({ heading: track.title, confirm: '繼續', build: root => { selected = selectField(root, '音訊操作', [['rename', '編輯音訊名稱'], ['transcribe', '重新產生字幕'], ['export', '匯出音訊與字幕備份'], ['delete', '刪除此音訊']], 'track-action'); }, accept: () => selected.value });
  if (choice === 'rename') await renameItem('track', track);
  else if (choice === 'delete') await deleteItem('track', track);
  else if (choice === 'export') await backup([track]);
  else if (choice === 'transcribe') await regenerateTranscript(track.id);
}

function setImportProgress({ stage, message, error = false }) {
  const stages = ['source', 'download', 'decode', 'transcribe', 'save'], index = stages.indexOf(stage);
  $('import-progress').hidden = false; $('import-progress').classList.toggle('error', error);
  $('import-stage').textContent = error ? '這次匯入已停止' : stage === 'save' ? '字幕準備好了' : '正在準備你的聆聽';
  $('import-message').textContent = message; $('import-spinner').hidden = error || !state.job;
  document.querySelectorAll('[data-stage]').forEach(item => { const n = stages.indexOf(item.dataset.stage); item.classList.toggle('current', n === index); item.classList.toggle('done', n < index); });
  $('cancel-import').hidden = !state.job; $('finish-import').hidden = !state.pending; $('discard-import').hidden = !state.pending;
  $('start-import').disabled = !!state.job || !!state.pending || !state.ready;
  $('source-url').disabled = !!state.job || !!state.pending;
}
function cancelImport(message = '匯入已停止，原有收藏保持完整。') {
  state.epoch++; state.job?.abort(); state.job = null;
  setImportProgress({ stage: 'source', message, error: true });
}
async function startImport(event) {
  event.preventDefault();
  if (state.updating || !state.ready || state.job || state.pending || state.clearing) return;
  const controller = new AbortController(), epoch = ++state.epoch; state.job = controller;
  // Source downloads have a bounded phase; long ASR has no artificial timeout.
  let transferTimer = setTimeout(() => controller.abort(new DOMException('讀取來源逾時', 'AbortError')), 180000);
  try {
    const result = await importPodcast($('source-url').value.trim(), { ...state.library.settings }, { signal: controller.signal,
      progress: data => { if (epoch !== state.epoch) return; if (data.stage === 'decode' || data.stage === 'transcribe') { clearTimeout(transferTimer); transferTimer = null; } setImportProgress(data); }
    });
    if (epoch !== state.epoch || controller.signal.aborted) return;
    state.job = null; state.pending = { ...result, track: { ...result.track, id: newId() } };
    setImportProgress({ stage: 'save', message: `「${result.track.title}」已完成 ${clock(result.track.duration)} 音訊與原文字幕，請選擇要加入的專輯。尚未占用收藏名額。` });
    await finishImport();
  } catch (error) {
    if (epoch === state.epoch) { state.job = null; setImportProgress({ stage: 'source', message: error.name === 'AbortError' ? '來源讀取已取消或超過 3 分鐘；請確認網路後重試。' : error.message, error: true }); }
  } finally { clearTimeout(transferTimer); }
}
async function regenerateTranscript(id) {
  if (!state.ready || state.job || state.pending || state.writing || state.clearing) throw new Error('請先完成或停止目前的處理，再重新產生字幕。');
  const track = state.library.tracks.find(item => item.id === id); if (!track) return;
  const controller = new AbortController(), epoch = ++state.epoch; state.job = controller;
  audio.pause(); closeTranslation();
  if ($('player').open) closeDialog($('player'));
  showView('import');
  setImportProgress({ stage: 'decode', message: `正在讀取「${track.title}」的已保存音訊，原有字幕會保留到成功更新。請保持此頁在前景。` });
  try {
    const blob = await storage.read(`audio:${id}`);
    if (!blob) throw new Error('找不到已保存的音訊，請重新匯入來源。');
    if (epoch !== state.epoch || controller.signal.aborted) return;
    const transcript = await transcribeSavedAudio(blob, { ...state.library.settings, language: track.language }, { signal: controller.signal, progress: data => { if (epoch === state.epoch) setImportProgress(data); } });
    if (epoch !== state.epoch || controller.signal.aborted) return;
    if (!state.library.tracks.some(item => item.id === id)) throw new Error('這個音訊已在其他分頁移除，沒有寫入字幕。');
    state.job = null;
    $('cancel-import').disabled = true;
    try { await commit({ ...state.library, tracks: state.library.tracks.map(item => item.id === id ? { ...item, ...transcript } : item) }); }
    finally { $('cancel-import').disabled = false; }
    if (state.current === id) { state.sentences = sentencesFor(currentTrack()); renderSubtitles(); updateTimeline(); }
    setImportProgress({ stage: 'save', message: '字幕已更新，音訊與收藏位置保持不變。' });
    $('import-progress').hidden = true; showView('playlist');
    if (state.current === id) openPlayer();
    notify('已使用保存的音訊重新產生字幕，沒有重新下載音檔。');
  } catch (error) {
    if (epoch === state.epoch) { state.job = null; setImportProgress({ stage: 'decode', message: `${error.name === 'AbortError' ? '字幕更新已停止。' : error.message} 原有音訊與字幕已保留。`, error: true }); }
  }
}
async function finishImport() {
  if (!state.pending || state.job) return;
  let name, destination, newName, replaceAlbum, replaceTrack, extra;
  const pending = state.pending;
  const result = await ask({ heading: '把這段聲音，放進專輯', description: '音訊與字幕已準備完成。滿額時請指定替換對象；按下確認後，才會移除所選舊資料。', confirm: '確認加入／替換',
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
  if (result) { $('source-url').value = ''; $('import-progress').hidden = true; $('start-import').disabled = false; $('source-url').disabled = false; state.album = state.library.tracks.find(track => track.id === pending.track.id)?.albumId || null; renderPlaylist(); showView('playlist'); notify('音訊與字幕已加入專輯，準備好就出發。'); }
}

function closeTranslation() {
  state.translation?.abort(); state.translation = null; $('translation-panel').hidden = true;
  document.querySelectorAll('.sentence-text.translating').forEach(sentence => sentence.classList.remove('translating'));
}
async function translateSentence(index, selectedText) {
  const cue = state.sentences[index], track = currentTrack(); if (!cue || !track) return;
  const text = selectedText || cue.text;
  audio.pause(); closeTranslation(); subtitleFollow.suspend();
  const controller = new AbortController(); state.translation = controller;
  $('translation-panel').hidden = false; $('translation-original').textContent = text;
  $('translation-text').textContent = ''; $('translation-status').textContent = '正在取得這一句的中文翻譯…';
  [...($('subtitle-list').children[index]?.querySelectorAll('.sentence-text') || [])].find(sentence => sentence.textContent === text)?.classList.add('translating');
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
  state.sentences.forEach((cue, index) => {
    const row = node('div', 'subtitle-cue');
    for (const text of sentenceTexts(cue.text, currentTrack()?.language)) {
      const sentence = node('button', 'sentence-text'); sentence.type = 'button';
      for (const part of sentenceReadingParts(text)) sentence.append(node('span', 'sentence-phrase', part));
      sentence.setAttribute('aria-label', `點一下播放此段；長按或按 Enter 翻譯：${text}`);
      state.gestureCleanups.push(longPress(sentence, () => translateSentence(index, text)));
      sentence.onclick = safe(event => { if (event.defaultPrevented) return; audio.currentTime = cue.start; closeTranslation(); updateTimeline(); play(); saveProgress(); });
      row.append(sentence);
    }
    if (cue.incomplete) row.append(node('small', '', '句尾可能不完整，請核對後續聲音。'));
    root.append(row);
  });
  state.active = -1; highlight();
}
function highlight(force = false) {
  const next = findActive(state.sentences, audio.currentTime || 0), rows = $('subtitle-list').children;
  const changed = state.active !== next;
  if (changed) {
    rows[state.active]?.classList.remove('active'); rows[state.active]?.removeAttribute('aria-current');
    state.active = next;
    rows[next]?.classList.add('active'); rows[next]?.setAttribute('aria-current', 'true');
  }
  if ((changed || force) && subtitleFollow.enabled && !$('subtitles-panel').hidden && $('player').open && !document.hidden && next >= 0) centerCue(rows[next]);
}
function centerCue(row) {
  if (!row) return;
  const root = $('subtitle-list');
  root.scrollTo({ top: subtitleScrollTop({ scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, clientTop: root.clientTop, containerTop: root.getBoundingClientRect().top, cueTop: row.getBoundingClientRect().top }), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function setSubtitlesVisible(show) {
  $('subtitles-panel').hidden = !show;
  $('toggle-subtitles').setAttribute('aria-pressed', String(show));
  $('player').classList.toggle('subtitles-open', show);
  $('player').scrollTop = 0;
  if (show) subtitleFollow.resume();
  else { closeTranslation(); subtitleFollow.reset(); }
}
function resetSubtitles() { setSubtitlesVisible(false); }
function openPlayer() { if (!currentTrack()) return; if (!$('player').open) openDialog($('player')); subtitleFollow.resume(); }
function releasePlayer() {
  state.playerToken++; audio.pause(); audio.removeAttribute('src'); audio.load(); closeTranslation();
  state.current = null; state.queue = []; state.sentences = []; resetSubtitles();
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
    state.current = id; state.queue = queue.filter(item => state.library.tracks.some(track => track.id === item));
    state.sentences = sentencesFor(track); if (!reuse) audio.src = url; audio.playbackRate = +$('playback-speed').value;
    const resumeAt = position ?? livePosition ?? saved?.position ?? track.position ?? 0;
    const start = resumeAt >= track.duration - 1 ? 0 : Math.max(0, Math.min(track.duration - 0.1, resumeAt));
    const seek = () => { if (token === state.playerToken) { audio.currentTime = start; updateTimeline(); } };
    if (!reuse || position !== undefined || audio.ended) { audio.onloadedmetadata = seek; if (audio.readyState >= 1) seek(); }
    renderSubtitles(); updatePlayer(); renderPlaylist(); updateMediaSession();
    if (expand) openPlayer();
    if (autoplay) play();
    saveProgress();
    // Prepare the album queue while in foreground so the next track doesn't
    // depend on an IndexedDB read after the phone locks.
    await Promise.allSettled(state.queue.map(next => prepareURL(next)));
    if (token !== state.playerToken) return;
    for (const [key, value] of state.urls) if (key !== id && !state.queue.includes(key)) { URL.revokeObjectURL(value); state.urls.delete(key); }
  } finally { state.loadingAudio--; }
}
function play() {
  if (state.updating || !currentTrack() || !audio.src) return;
  closeTranslation(); subtitleFollow.resume();
  $('player-feedback').textContent = '';
  audio.play().catch(() => { $('player-feedback').textContent = '音訊已就緒，請再按一下播放。'; notify('音訊已就緒，請再按一下播放。'); });
}
function togglePlay() { if (audio.paused) play(); else audio.pause(); }
function seekSentence(direction) {
  if (state.updating) return;
  const target = sentenceTarget(state.sentences, audio.currentTime || 0, direction);
  if (target === null) { $('player-feedback').textContent = '已到最後一句。'; return; }
  audio.currentTime = target; closeTranslation(); updateTimeline(); subtitleFollow.resume(); saveProgress();
}
function updatePlayer() {
  const track = currentTrack(); $('mini-player').hidden = !track; $('app').classList.toggle('has-player', !!track);
  if (!track) return;
  $('mini-title').textContent = track.title; $('mini-subtitle').textContent = albumOf(track)?.title || 'CommuteLingo';
  $('player-title').textContent = track.title; $('player-show').textContent = track.show || '你的通勤語言時光'; $('player-album').textContent = albumOf(track)?.title || '';
  cover($('mini-cover'), track.albumId); cover($('player-art'), track.albumId);
  for (const id of ['mini-play', 'player-play']) { $(id).innerHTML = icon(audio.paused ? 'play' : 'pause'); $(id).setAttribute('aria-label', audio.paused ? '播放' : '暫停'); }
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
  const coverage = transcriptCoverage(track.segments, duration);
  $('transcript-notice').hidden = !coverage.needsReview;
  if (coverage.needsReview) $('transcript-status').textContent = `${time > coverage.timedEnd ? '目前播放位置沒有已確認的字幕。' : '字幕尾段可能不完整。'}字幕時間至 ${clock(coverage.timedEnd)}，音訊全長 ${clock(duration)}。可用已保存音訊重新產生字幕。`;
  $('regenerate-subtitles').disabled = !!state.job || state.writing;
}
async function saveProgress({ strict = false } = {}) {
  const track = currentTrack(); if (!track || state.clearing || !state.ready) return;
  const position = Math.min(track.duration, audio.currentTime || 0);
  try {
    await storage.write(`progress:${track.id}`, { position });
    if (state.clearing || state.current !== track.id) return;
    await storage.write('player-v2', { trackId: track.id, queue: state.queue, position, speed: audio.playbackRate });
  } catch (error) { notify('播放進度暫時無法保存。', true); if (strict) throw error; }
}
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = currentTrack(); if (!track) return;
  if (globalThis.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.show || 'CommuteLingo', album: albumOf(track)?.title || '', artwork: [{ src: new URL(`./icon-${state.library.settings.icon}-512.png`, location.href).href, sizes: '512x512', type: 'image/png' }] });
  const actions = { play, pause: () => audio.pause(), stop: () => { audio.pause(); audio.currentTime = 0; saveProgress(); }, seekbackward: () => seekSentence(-1), seekforward: () => seekSentence(1), previoustrack: () => seekSentence(-1), nexttrack: () => seekSentence(1), seekto: event => { if (Number.isFinite(event.seekTime)) { audio.currentTime = Math.min(track.duration, Math.max(0, event.seekTime)); updateTimeline(); } } };
  for (const [action, handler] of Object.entries(actions)) { try { navigator.mediaSession.setActionHandler(action, (...args) => { if (!state.updating) handler(...args); }); } catch { /* Unsupported action on this OS. */ } }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function backup(tracks = state.library.tracks) {
  if (state.backup) return;
  const controller = new AbortController(); state.backup = controller; $('backup-library').disabled = true;
  try {
    const files = [], translations = [...await storage.entries('translation:'), ...translator.entries()];
    const metadata = { schema: 'commute-lingo-backup/2', createdAt: new Date().toISOString(), library: { ...state.library, tracks: [] }, translations: [...new Map(translations.map(item => [JSON.stringify([item.source, item.target, item.text]), item])).values()] };
    for (const track of tracks) {
      const blob = await storage.read(`audio:${track.id}`); if (!blob) throw new Error(`找不到「${track.title}」的音檔，備份未完成。`);
      const ext = /wav/.test(blob.type) ? 'wav' : /mp4|m4a/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : /flac/.test(blob.type) ? 'flac' : /webm/.test(blob.type) ? 'webm' : /aac/.test(blob.type) ? 'aac' : 'mp3';
      const progress = await storage.read(`progress:${track.id}`);
      metadata.library.tracks.push({ ...track, position: progress?.position ?? track.position ?? 0, audioFile: `audio/${track.id}.${ext}` });
      files.push({ name: `audio/${track.id}.${ext}`, blob }, { name: `subtitles/${track.id}.srt`, blob: new Blob([toSRT(sentencesFor(track))]) });
    }
    files.push({ name: 'library.json', blob: new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' }) });
    const archive = await zipFiles(files, { signal: controller.signal });
    if (!controller.signal.aborted) { download(archive, `CommuteLingo-${new Date().toISOString().slice(0, 10)}.zip`); notify('收藏備份已準備下載，請保管好這份檔案。'); }
  } finally { state.backup = null; $('backup-library').disabled = !state.library.tracks.length; }
}
async function clearAll() {
  if (state.job || state.writing) throw new Error('請先停止來源匯入，或等待儲存完成。');
  await ask({ heading: '清除全部收藏與資料？', description: `將刪除 ${state.library.albums.length} 個專輯、${state.library.tracks.length} 個音訊（${bytes(libraryBytes(state.library))}）、字幕、翻譯快取、設定、舊版資料與下載的語音模型。
此操作無法復原。App 頁面程式會保留；其他 App 的資料不受影響。`, confirm: '確認全部清除', danger: true,
    accept: async () => {
      state.clearing = true; state.backup?.abort(); closeTranslation(); audio.pause();
      try {
        await storage.clear();
        releasePlayer(); translator.clear(); state.pending = null; state.legacy = null; state.library = emptyLibrary(); state.album = null;
        const failures = [];
        try { if (globalThis.caches) for (const key of await caches.keys()) if (key === 'commute-lingo-models-v1') { try { await caches.delete(key); } catch { failures.push(key); } } }
        catch { failures.push('model-cache'); }
        render(); $('import-progress').hidden = true; $('source-url').value = ''; $('source-url').disabled = false; $('start-import').disabled = false;
        state.channel?.postMessage({ type: 'cleared' });
        notify(failures.length ? '收藏與設定已清除，但模型快取尚未清除，請稍後重試。' : '全部收藏與資料已清除。', !!failures.length);
      } finally { state.clearing = false; }
    }
  });
}
function orientation() {
  const blocked = isMobileLandscape({ coarse: matchMedia('(pointer: coarse)').matches, orientationType: screen.orientation?.type, orientationAngle: typeof window.orientation === 'number' ? window.orientation : undefined, width: screen.width, height: screen.height });
  document.body.classList.toggle('is-landscape', blocked); $('landscape-gate').hidden = !blocked; $('app').inert = blocked;
}

fillIcons();
document.querySelectorAll('[data-tab]').forEach(tab => { tab.onclick = () => showView(tab.dataset.tab); });
document.querySelectorAll('[data-go]').forEach(link => { link.onclick = () => showView(link.dataset.go); });
$('header-settings').onclick = () => showView('settings');
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
$('create-album').onclick = safe(createAlbum);
$('import-form').onsubmit = safe(startImport);
$('cancel-import').onclick = () => cancelImport();
$('finish-import').onclick = safe(finishImport);
$('discard-import').onclick = safe(async () => { const result = await ask({ heading: '捨棄這次匯入？', description: '已轉換的音訊與字幕尚未加入專輯，捨棄後需要重新下載與轉錄。', confirm: '確認捨棄', danger: true }); if (result) { state.pending = null; $('import-progress').hidden = true; $('start-import').disabled = false; $('source-url').disabled = false; } });
for (const type of ['podcast', 'youtube']) $(`source-${type}`).onclick = () => {
  for (const name of ['podcast', 'youtube']) { $(`source-${name}`).classList.toggle('selected', name === type); $(`source-${name}`).setAttribute('aria-pressed', String(name === type)); $(`${name}-source`).hidden = name !== type; }
};
$('settings-form').onsubmit = safe(async event => {
  event.preventDefault(); $('settings-message').textContent = '';
  document.activeElement?.blur?.();
  try {
    const settings = { albumLimit: +$('setting-albums').value, trackLimit: +$('setting-tracks').value, maxMinutes: +$('setting-minutes').value, autoUpdate: $('setting-auto-update').checked, subtitleSize: $('setting-subtitles').value, language: $('setting-language').value, model: $('setting-model').value, icon: 'sunrise' };
    await commit(changeSettings(state.library, settings)); state.settingsDirty = false; updateMediaSession(); $('settings-message').textContent = '設定已儲存。'; void updater.refresh();
  } catch (error) { $('settings-message').textContent = error.message; }
});
for (const event of ['input', 'change']) $('settings-form').addEventListener(event, () => { state.settingsDirty = true; });
$('check-update').onclick = () => { void updater.check(); };
$('apply-update').onclick = () => { void updater.apply(); };
$('setting-subtitles').onchange = () => { document.documentElement.style.setProperty('--subtitle-size', { normal: '18.4px', large: '22.4px', xlarge: '27.2px' }[$('setting-subtitles').value]); };
$('request-persistence').onclick = safe(async () => {
  if (!navigator.storage?.persist) { $('persistence-status').textContent = '此瀏覽器未提供持續保存請求；請定期匯出備份。'; return; }
  const granted = await navigator.storage.persist(); $('persistence-status').textContent = granted ? '瀏覽器已授予持續保存，仍建議保留備份。' : '瀏覽器未授予持續保存，仍可使用收藏，請定期備份。'; if (granted) $('request-persistence').hidden = true;
});
$('backup-library').onclick = safe(() => backup()); $('clear-data').onclick = safe(clearAll);
$('legacy-backup').onclick = () => { if (state.legacy?.file) download(state.legacy.file, state.legacy.name || 'legacy-audio.mp3'); };
$('mini-open').onclick = openPlayer; $('mini-play').onclick = togglePlay; $('player-play').onclick = togglePlay;
$('mini-next').onclick = () => seekSentence(1); $('previous-sentence').onclick = () => seekSentence(-1); $('next-sentence').onclick = () => seekSentence(1);
$('player-close').onclick = () => closeDialog($('player')); $('player').addEventListener('close', resetSubtitles);
$('player-menu').onclick = safe(() => currentTrack() && trackMenu(currentTrack()));
$('player-stop').onclick = () => { audio.pause(); audio.currentTime = 0; closeTranslation(); updateTimeline(); saveProgress(); };
$('playback-speed').onchange = () => { audio.playbackRate = +$('playback-speed').value; updateTimeline(); saveProgress(); };
$('playback-range').oninput = event => { state.seeking = true; $('elapsed').textContent = clock(+event.target.value); };
$('playback-range').onchange = event => { audio.currentTime = +event.target.value; state.seeking = false; closeTranslation(); updateTimeline(); subtitleFollow.resume(); saveProgress(); };
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
$('regenerate-subtitles').onclick = safe(() => currentTrack() && regenerateTranscript(state.current));
audio.addEventListener('play', () => { closeTranslation(); subtitleFollow.resume(); updatePlayer(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { updatePlayer(); saveProgress(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('timeupdate', () => { updateTimeline(); if (performance.now() - state.lastProgressSave > 8000) { state.lastProgressSave = performance.now(); saveProgress(); } });
audio.addEventListener('seeked', () => { updateTimeline(); if (!state.translation) subtitleFollow.resume(); });
audio.addEventListener('error', () => { if (state.current) { $('player-feedback').textContent = '音訊播放失敗，請重新選擇音訊或匯入來源。'; notify('音訊播放失敗，請重新選擇音訊或匯入來源。', true); } });
audio.addEventListener('ended', safe(async () => {
  const index = state.queue.indexOf(state.current), next = state.queue[index + 1];
  saveProgress(); if (next) await selectTrack(next, { queue: state.queue, autoplay: true, position: 0 }); else { updatePlayer(); $('player-feedback').textContent = '這段旅程已聽完。'; }
}));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.job) cancelImport('來源匯入因離開前景而停止，請回來後重新開始。原有收藏已保留。'); saveProgress(); }
  else { updateTimeline(); if (!audio.paused) subtitleFollow.resume(); orientation(); if (state.library.settings.autoUpdate) void updater.check(); }
});
window.addEventListener('pagehide', () => { if (state.job) cancelImport(); state.translation?.abort(); state.backup?.abort(); saveProgress(); });
window.addEventListener('orientationchange', orientation); screen.orientation?.addEventListener('change', orientation); window.addEventListener('resize', orientation);
async function offlineStatus() {
  if (!('serviceWorker' in navigator)) { void updater.start(); $('offline-status').textContent = '此瀏覽器未提供離線頁面支援。'; return; }
  try {
    const registration = await updater.start(); await navigator.serviceWorker.ready;
    if (state.library.settings.autoUpdate) void updater.check();
    const check = () => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); $('offline-status').textContent = '新版可在線使用；請在保存後關閉舊分頁再開啟，以更新離線頁面。'; }, 2000);
      channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); $('offline-status').textContent = data.version === '0.2.9' && data.ready ? '頁面已可離線使用；已收藏的音訊與快取翻譯可離線讀取，新匯入與新翻譯需要連線。' : '新版可在線使用，離線頁面尚待更新。'; };
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
    library.settings = validateSettings(library.settings); state.library = library; state.ready = true;
    render(); $('start-import').disabled = false;
    const savedPlayer = await storage.read('player-v2');
    if (savedPlayer && library.tracks.some(track => track.id === savedPlayer.trackId)) {
      if ([...$('playback-speed').options].some(option => option.value === String(savedPlayer.speed))) $('playback-speed').value = savedPlayer.speed;
      await selectTrack(savedPlayer.trackId, { queue: Array.isArray(savedPlayer.queue) ? savedPlayer.queue : [savedPlayer.trackId], position: savedPlayer.position });
    }
    if (globalThis.BroadcastChannel) {
      state.channel = new BroadcastChannel('commute-lingo-library-v2');
      state.channel.onmessage = safe(async ({ data }) => {
        try {
          if (data.type === 'cleared') {
            state.clearing = true; cancelImport('其他分頁已清除收藏。'); releasePlayer();
            state.pending = null; state.legacy = null; state.backup?.abort(); translator.clear();
          }
          const fresh = await storage.read(LIBRARY_KEY); state.library = fresh || emptyLibrary(); if (state.current && !currentTrack()) releasePlayer(); render(); notify('已同步這個裝置其他分頁的收藏變更。');
        } finally { state.clearing = false; }
      });
    }
  } catch (error) { notify(`無法讀取收藏：${error.message}`, true); $('storage-detail').textContent = error.message; }
  showView(location.hash.slice(1) || 'playlist'); orientation(); offlineStatus();
}
boot();
