import { normalizeSegments, groupSentences } from './core.mjs?v=0.2.19';

export const LIBRARY_KEY = 'library-v2';
export const MAX_AUDIO_MINUTES = 60;
export const DEFAULT_SETTINGS = Object.freeze({ albumLimit: 3, trackLimit: 3, maxMinutes: 25, autoUpdate: true, subtitleSize: 'normal', icon: 'sunrise', language: 'en', model: 'tiny', repeatMode: 'off', autoGuide: false, geminiModel: 'gemini-3.5-flash-lite' });
export const ICONS = [
  { id: 'journey', title: '聲音旅程', caption: '沿著聲音，抵達下一站', color: '#963ee7' },
  { id: 'dialogue', title: '一句世界', caption: '耳朵聽見，對話展開', color: '#147c8b' },
  { id: 'sunrise', title: '晨光通勤', caption: '讓每次出發都有收穫', color: '#ed7350' }
];
export const newId = () => crypto.randomUUID();
export function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('名稱請輸入 1–120 個字元。');
  return value.trim();
}
export function validateSettings(value) {
  const settings = { ...DEFAULT_SETTINGS, ...value };
  for (const name of ['albumLimit', 'trackLimit']) if (!Number.isInteger(settings[name]) || settings[name] < 1 || settings[name] > 5) throw new Error('專輯與每專輯音訊上限必須為 1–5 個。');
  if (!Number.isInteger(settings.maxMinutes) || settings.maxMinutes < 1 || settings.maxMinutes > MAX_AUDIO_MINUTES) throw new Error('音訊長度上限必須為 1–60 分鐘。');
  if (!['normal', 'large', 'xlarge'].includes(settings.subtitleSize)) throw new Error('字幕大小設定無效。');
  if (!ICONS.some(icon => icon.id === settings.icon)) throw new Error('圖示選擇無效。');
  settings.icon = 'sunrise'; // Retain old preference compatibility, with the chosen fixed identity.
  if (!['en', 'ja', 'ko', 'es', 'fr', 'de'].includes(settings.language) || !['tiny', 'base'].includes(settings.model)) throw new Error('轉錄設定無效。');
  if (typeof settings.autoUpdate !== 'boolean') throw new Error('自動更新設定無效。');
  if (!['off', 'track', 'album'].includes(settings.repeatMode) || typeof settings.autoGuide !== 'boolean' || !['gemini-3.5-flash-lite', 'gemini-3.8-flash'].includes(settings.geminiModel)) throw new Error('播放模式或導讀設定無效。');
  settings.autoGuide = false; // Legacy preferences/backups adopt manual-only generation.
  // Only known preferences are persisted; credentials are never part of a library.
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, settings[key]]));
}
export function emptyLibrary() { return { schema: 2, revision: 0, appearanceVersion: 2, settings: { ...DEFAULT_SETTINGS }, albums: [], tracks: [], playback: null }; }
export function checkDuration(seconds, settings) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('來源沒有有效的音訊長度，已停止匯入。');
  if (!Number.isInteger(settings?.maxMinutes) || settings.maxMinutes < 1 || settings.maxMinutes > MAX_AUDIO_MINUTES) throw new Error('音訊長度上限必須為 1–60 分鐘。');
  if (seconds > settings.maxMinutes * 60) throw new Error(`來源長度 ${(seconds / 60).toFixed(1)} 分鐘，超過目前 ${settings.maxMinutes} 分鐘上限。已停止，未進行轉錄；可至個人設定調整（最長 60 分鐘）。`);
}
export const tracksIn = (library, albumId) => library.tracks.filter(track => track.albumId === albumId);
export function changeSettings(library, input) {
  const settings = validateSettings({ ...library.settings, ...input });
  if (library.albums.length > settings.albumLimit) throw new Error(`目前有 ${library.albums.length} 個專輯，請先至檔案管理刪除後再降低上限。`);
  if (library.albums.some(album => tracksIn(library, album.id).length > settings.trackLimit)) throw new Error('有專輯的音訊數量超過新上限，請先至檔案管理選擇刪除。');
  if (library.tracks.some(track => track.duration > settings.maxMinutes * 60)) throw new Error('有音訊超過新的長度上限，請先至檔案管理選擇刪除。');
  return { ...library, settings };
}
export function addAlbum(library, name, id = newId()) {
  if (library.albums.length >= library.settings.albumLimit) throw new Error('專輯數量已滿，請先選擇移除一個專輯，或在設定提高上限。');
  return { ...library, albums: [...library.albums, { id, title: title(name), createdAt: Date.now() }] };
}
export function rename(library, kind, id, name) {
  const key = kind === 'album' ? 'albums' : 'tracks';
  if (!library[key].some(item => item.id === id)) throw new Error('項目已不存在，請重新整理。');
  return { ...library, [key]: library[key].map(item => item.id === id ? { ...item, title: title(name) } : item) };
}
export function removeTrack(library, id) {
  return { ...library, tracks: library.tracks.filter(track => track.id !== id), playback: library.playback?.trackId === id ? null : library.playback };
}
export function removeAlbum(library, id) {
  const removed = new Set(tracksIn(library, id).map(track => track.id));
  return { ...library, albums: library.albums.filter(album => album.id !== id), tracks: library.tracks.filter(track => !removed.has(track.id)), playback: removed.has(library.playback?.trackId) ? null : library.playback };
}
export function placeTrack(library, track, albumId, replaceId) {
  if (!library.albums.some(album => album.id === albumId)) throw new Error('請選擇一個存在的專輯。');
  checkDuration(track.duration, library.settings);
  const segments = track.transcriptStatus === 'audio-only' && Array.isArray(track.segments) && !track.segments.length ? [] : normalizeSegments(track.segments, track.duration);
  const normalized = { ...track, title: title(track.title), albumId, segments };
  if (!normalized.id || library.tracks.some(item => item.id === normalized.id)) throw new Error('音訊識別碼重複，請重新匯入。');
  const existing = tracksIn(library, albumId);
  if (replaceId && !existing.some(item => item.id === replaceId)) throw new Error('只能替換所選專輯中的音訊。');
  if (existing.length >= library.settings.trackLimit && !replaceId) throw new Error('這個專輯已滿，請選擇要替換的音訊。');
  const next = replaceId ? removeTrack(library, replaceId) : library;
  return { ...next, tracks: [...next.tracks, normalized] };
}
export function libraryBytes(library) { return library.tracks.reduce((sum, track) => sum + (track.size || 0), 0); }
export function playbackQueue(library, albumId, trackId) {
  const ids = (albumId ? tracksIn(library, albumId) : library.tracks.filter(track => track.id === trackId)).map(track => track.id);
  const index = trackId ? ids.indexOf(trackId) : 0;
  return index >= 0 ? ids.slice(index) : [];
}
export function nextPlayback(library, currentId, queue) {
  const track = library.tracks.find(item => item.id === currentId);
  if (!track) return null;
  const mode = library.settings.repeatMode || 'off';
  if (mode === 'track') return { id: currentId, queue };
  const ids = mode === 'album' ? tracksIn(library, track.albumId).map(item => item.id) : queue.filter(id => library.tracks.some(item => item.id === id));
  const index = ids.indexOf(currentId);
  const next = index >= 0 ? ids[index + 1] || (mode === 'album' ? ids[0] : null) : null;
  return next ? { id: next, queue: ids } : null;
}
export function sentenceTarget(sentences, currentTime, direction) {
  if (direction > 0) return sentences.find(cue => cue.start > currentTime + 0.05)?.start ?? null;
  const earlier = sentences.filter(cue => cue.start < currentTime - 0.5);
  return earlier.at(-1)?.start ?? sentences[0]?.start ?? 0;
}
export function legacyLibrary(saved) {
  if (!saved?.file || !saved.doc?.segments?.length) return null;
  const library = addAlbum(emptyLibrary(), '上次的通勤', 'legacy-album');
  const duration = saved.doc.audio?.duration;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_MINUTES * 60) return null;
  library.settings.maxMinutes = Math.max(DEFAULT_SETTINGS.maxMinutes, Math.ceil(duration / 60));
  const track = { id: 'legacy-track', title: saved.name || '上次保存的節目', albumId: 'legacy-album', duration, size: saved.file.size, type: saved.file.type, language: saved.doc.language || 'en', segments: normalizeSegments(saved.doc.segments, duration), metrics: saved.doc.metrics ?? null, source: 'legacy', createdAt: Date.now(), position: 0 };
  library.tracks.push(track);
  return { library, audio: { id: track.id, blob: saved.file }, translations: saved.doc.translations || [] };
}
export function sentencesFor(track) {
  return ['word-v1', 'mixed-v1'].includes(track.alignment) || track.segments.some(segment => segment.words?.length)
    ? track.segments.map(segment => ({ ...segment, incomplete: groupSentences([segment], track.language)[0]?.incomplete ?? true }))
    : groupSentences(track.segments, track.language);
}
