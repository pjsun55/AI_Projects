// Interaction + IndexedDB simulation, NOT a rendered browser/iPhone test.
// Uses public pinned DOM/IDB implementations in memory, without installation.
// node --experimental-vm-modules tools/ui-smoke.mjs
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const timers = new Set();
const schedule = (callback, delay, ...args) => { const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, delay); timers.add(timer); return timer; };
const cancel = timer => { clearTimeout(timer); timers.delete(timer); };
const context = vm.createContext({ console, URL, URLSearchParams, Request, Response, Headers, Blob, TextEncoder, TextDecoder, AbortController, AbortSignal, DOMException, structuredClone, performance, crypto, setTimeout: schedule, clearTimeout: cancel, queueMicrotask, setImmediate, clearImmediate });
const modules = new Map(), requests = new Set();
function load(url) {
  if (!modules.has(url)) modules.set(url, createModule(url));
  return modules.get(url);
}
async function createModule(url) {
  const parsed = new URL(url); let code;
  if (parsed.protocol === 'file:') {
    const file = await realpath(fileURLToPath(parsed));
    if (!file.startsWith(root + path.sep)) throw new Error('Module escaped project.');
    code = await readFile(file, 'utf8');
  } else {
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.jsdelivr.net') throw new Error('Only public CDN module downloads are allowed.');
    requests.add(parsed.hostname); const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`Module ${response.status}: ${url}`); code = await response.text();
  }
  return new vm.SourceTextModule(code, { context, identifier: url, initializeImportMeta(meta) { meta.url = url; }, importModuleDynamically: async (specifier, parent) => evaluate(await load(new URL(specifier, parent.identifier).href)) });
}
async function evaluate(module) {
  if (module.status === 'unlinked') await module.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
  if (module.status === 'linked') await module.evaluate();
  return module;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) { const end = Date.now() + 7000; while (Date.now() < end) { if (await predicate()) return; await delay(15); } throw new Error(`Timed out: ${label}`); }
let assertions = 0;
const check = (condition, label) => { assert.ok(condition, label); assertions++; console.log('PASS', label); };
try {
  const dom = await evaluate(await load('https://cdn.jsdelivr.net/npm/linkedom@0.18.12/+esm'));
  const fake = await evaluate(await load('https://cdn.jsdelivr.net/npm/fake-indexeddb@6.2.4/+esm'));
  const { document, window } = dom.namespace.parseHTML(await readFile(path.join(root, 'public/index.html'), 'utf8'));
  const $ = id => document.getElementById(id), event = (name, props = {}) => Object.assign(new window.Event(name, { bubbles: true, cancelable: true }), props);
  // linkedom has no layout, audio engine, dialog modality or full select setter.
  // These are explicit stubs; tests below check app logic rather than those APIs.
  for (const option of document.querySelectorAll('option:not([value])')) option.setAttribute('value', option.textContent.trim());
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return this.querySelector('option[selected]')?.value ?? this.querySelector('option')?.value ?? ''; }, set(value) { for (const option of this.querySelectorAll('option')) { if (option.value === String(value)) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } } });
  for (const element of document.querySelectorAll('dialog')) {
    Object.defineProperty(element, 'open', { get: () => element.hasAttribute('open') });
    element.showModal = () => element.setAttribute('open', '');
    element.close = () => { element.removeAttribute('open'); schedule(() => element.dispatchEvent(event('close')), 0); };
  }
  for (const element of document.querySelectorAll('*')) element.scrollTo = () => {};
  const subtitleScrolls = [], subtitleList = $('subtitle-list');
  Object.defineProperties(subtitleList, { clientHeight: { get: () => 200 }, scrollHeight: { get: () => 800 }, clientTop: { get: () => 0 } });
  subtitleList.scrollTop = 0;
  subtitleList.getBoundingClientRect = () => ({ top: 400, bottom: 600 });
  window.HTMLElement.prototype.getBoundingClientRect = function() { return { top: 400 + [...(this.parentNode?.children || [])].indexOf(this) * 300 - subtitleList.scrollTop }; };
  subtitleList.scrollTo = ({ top }) => { subtitleList.scrollTop = top; subtitleScrolls.push(top); };
  window.scrollTo = () => {}; let hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden });
  const audio = $('audio'); let paused = true, audioAssignments = 0, mediaReady = 1, mediaLoads = 0;
  Object.defineProperties(audio, { paused: { get: () => paused }, src: { get() { return this.getAttribute('src') || ''; }, set(value) { audioAssignments++; this.setAttribute('src', value); } }, readyState: { get: () => mediaReady } });
  audio.currentTime = 0; audio.playbackRate = 1;
  audio.play = async () => { paused = false; audio.dispatchEvent(event('play')); };
  audio.pause = () => { if (!paused) { paused = true; audio.dispatchEvent(event('pause')); } };
  audio.load = () => { mediaLoads++; audio.currentTime = 0; };
  const fakeCaches = new Map([['commute-lingo-models-v1', true], ['another-app-models', true], [`commute-lingo-shell-${version}-r1`, true]]);
  const location = { href: `https://example.test/commute-lingo/?v=${version}`, hash: '' };
  const screen = { width: 393, height: 852, orientation: { type: 'portrait-primary', addEventListener() {} } };
  const fixtureSentence = 'While the train moves through the city and the morning sun fills the windows, I listen to a familiar story and notice the expressions I missed yesterday, then I repeat a useful sentence quietly and save the lesson for another journey.';
  const translatedTexts = [], dictionaryWords = [], heldWordLookups = []; let failWordLookups = false, holdWordLookups = false;
  const geminiCalls = [], heldGuides = []; let holdGuides = false, failGuides = false;
  let fixtureName = 'A short test episode', fixtureMillis = 4000, fixtureSeconds = 4, partialTranscript = false, missingModelStart = false, wordTranscript = false, mixedTranscript = false, holdWorker = false, failWorker = false, mediaDownloads = 0, catalogLookups = 0, translated = 0;
  const runtimeFetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const body = JSON.parse(options.body), original = body.contents[0].parts[0].text;
      geminiCalls.push({ url: url.href, body, header: options.headers['x-goog-api-key'] });
      const content = { intro: '這一集從通勤旅程切入，介紹如何留意熟悉故事中的表達方式。', route: ['旅途中的觀察\n這個主題從熟悉的故事切入，說明沿途的觀察如何幫助理解英文表達，並留意前後文的關係。'], vocabulary: [{ term: 'familiar', pos: 'adj.', meaning: '熟悉的', quote: fixtureSentence, clue: '昨天聽過的故事提供了語境。' }], sentence: { quote: 'Listen and learn along the way.', translation: '一路聆聽與學習。', explanation: '兩個動詞以 and 連接。' } };
      const reply = () => failGuides ? new Response('provider detail omitted', { status: 429 }) : new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: original === 'Please reply with OK.' ? 'OK' : JSON.stringify(content) }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 100 } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      if (holdGuides) return new Promise(resolve => heldGuides.push(() => resolve(reply())));
      return reply();
    }
    if (url.hostname === 'itunes.apple.com') { catalogLookups++; return Response.json({ results: [{ trackId: 1000796641961, trackName: fixtureName, collectionName: 'Public fixture', trackTimeMillis: fixtureMillis, episodeUrl: 'https://media.example.com/fixture.wav' }] }); }
    if (url.hostname === 'media.example.com') { mediaDownloads++; return new Response(new Blob(['wav fixture'], { type: 'audio/wav' })); }
    if (url.hostname === 'api.mymemory.translated.net') { translated++; translatedTexts.push(url.searchParams.get('q')); if (failWordLookups) throw new Error('Simulated offline lookup'); const response = Response.json({ responseStatus: 200, responseData: { translatedText: '每段旅程都會帶來新的發現。' } }); if (holdWordLookups) return new Promise(resolve => heldWordLookups.push(() => resolve(response))); return response; }
    if (url.hostname === 'freedictionaryapi.com') {
      const word = decodeURIComponent(url.pathname.split('/').at(-1)); dictionaryWords.push(word);
      if (failWordLookups) return new Response('', { status: 503 });
      const response = Response.json({ word, source: { license: { name: 'CC BY-SA 4.0' } }, entries: [{ language: { code: 'en' }, partOfSpeech: 'noun', pronunciations: [{ type: 'ipa', text: '/test/' }], senses: [{ definition: 'A public fixture definition.' }] }] });
      if (holdWordLookups) return new Promise(resolve => heldWordLookups.push(() => resolve(response))); return response;
    }
    throw new Error('No user content may leave this simulated environment.');
  };
  class Probe {
    get duration() { return fixtureSeconds; }
    set src(value) { if (value) schedule(() => this.onloadedmetadata?.(), 0); }
    removeAttribute() {} load() {}
  }
  class Context {
    async decodeAudioData() { return { length: fixtureSeconds * 16000, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(fixtureSeconds * 16000) }; }
  }
  class Worker {
    postMessage() { schedule(() => this.onmessage?.({ data: failWorker ? { type: 'error', message: 'Simulated inference failure' } : mixedTranscript ? { type: 'complete', timestampMode: 'mixed', processedSeconds: fixtureSeconds, chunks: [], regions: [{ mode: 'word', chunks: [{ timestamp: [0, .5], text: 'First sentence.' }] }, { mode: 'coarse', fallbackChunks: [{ start: 1, end: 2, text: 'Unaligned sentence. More words.' }] }, { mode: 'word', chunks: [{ timestamp: [2.5, fixtureSeconds], text: 'Last sentence.' }] }], metrics: {} } : wordTranscript ? {
      type: 'complete', timestampMode: 'word', processedSeconds: fixtureSeconds,
      chunks: [{ timestamp: [0, 1], text: 'Dr.' }, { timestamp: [1, 4], text: 'Wang speaks?' }, { timestamp: [5, 6], text: 'The answer' }, { timestamp: [6, 8], text: 'lies on the label.' }, { timestamp: [9, 10], text: 'The supreme grade' }, { timestamp: [10, fixtureSeconds], text: 'is extra virgin.' }], metrics: {}
    } : { type: 'complete', processedSeconds: fixtureSeconds, chunks: [{ timestamp: [missingModelStart ? null : 0, 2], text: fixtureSentence + ' We learn one idea at a time.' }, ...partialTranscript ? [] : [{ timestamp: [2, fixtureSeconds], text: 'Listen and learn along the way.' }]], metrics: {} } }), holdWorker ? 60000 : 10); }
    terminate() { this.onmessage = null; }
  }
  const wakeLocks = []; let denyWakeLock = false;
  const wakeLock = { async request(type) {
    assert.equal(type, 'screen');
    if (denyWakeLock) throw new DOMException('Simulated platform refusal', 'NotAllowedError');
    const sentinel = new EventTarget(); sentinel.released = false;
    sentinel.release = async () => { sentinel.released = true; sentinel.dispatchEvent(new Event('release')); };
    wakeLocks.push(sentinel); return sentinel;
  } };
  Object.assign(context, { document, window, location, history: { replaceState(_, __, hash) { location.hash = hash; } }, screen, matchMedia: () => ({ matches: true }), navigator: { wakeLock, storage: { estimate: async () => ({ usage: 1024, quota: 1000000000 }), persisted: async () => false, persist: async () => false }, mediaSession: { setActionHandler() {}, setPositionState() {} } }, caches: { keys: async () => [...fakeCaches.keys()], delete: async key => fakeCaches.delete(key) }, indexedDB: fake.namespace.indexedDB, IDBKeyRange: fake.namespace.IDBKeyRange, Audio: Probe, OfflineAudioContext: Context, Worker, fetch: runtimeFetch });
  await evaluate(await load(new URL(`../public/app.mjs?v=${version}`, import.meta.url).href));
  const storageModule = (await load(new URL(`../public/storage.mjs?v=${version}`, import.meta.url).href)).namespace;
  const PlayerStore = fake.namespace.IDBObjectStore, originalPlayerPut = PlayerStore.prototype.put;
  let holdPlayerCompletion = false;
  const heldPlayerCompletions = [];
  PlayerStore.prototype.put = function(value, key) {
    const result = originalPlayerPut.call(this, value, key);
    if (holdPlayerCompletion && key === 'player-v2' && value?.sessionId) {
      holdPlayerCompletion = false;
      const complete = this.transaction.oncomplete;
      this.transaction.oncomplete = event => heldPlayerCompletions.push(() => complete(event));
    }
    return result;
  };
  const library = () => storageModule.read('library-v2');
  const click = id => $(id).dispatchEvent(event('click'));
  const submit = id => $(id).dispatchEvent(event('submit'));
  const confirm = async () => { submit('dialog-form'); await until(() => !$('action-dialog').open || $('dialog-error').textContent, 'dialog saved or error'); if ($('dialog-error').textContent) throw new Error($('dialog-error').textContent); };
  await until(() => !$('start-import').disabled, 'app boot');
  check($('setting-minutes').value === '25', 'new libraries default to 25 minutes');
  check($('setting-minutes').getAttribute('max') === '60', 'duration setting offers up to 60 minutes');
  $('setting-minutes').value = '60'; submit('settings-form');
  await until(async () => (await library()).settings.maxMinutes === 60, 'one-hour preference saved');
  check((await library()).settings.maxMinutes === 60, '60-minute preference persists to IndexedDB');
  $('setting-minutes').value = '25'; submit('settings-form');
  await until(async () => (await library()).settings.maxMinutes === 25, 'restore 25-minute preference');
  const originalPrompt = $('setting-guide-prompt').value;
  $('setting-guide-prompt').value = '依每個聽力主題完整解說。'; submit('settings-form');
  await until(async () => (await library()).settings.guidePrompt === '依每個聽力主題完整解說。', 'custom guide prompt saved');
  check(geminiCalls.length === 0, 'saving a guide prompt never calls Gemini');
  click('reset-guide-prompt');
  check($('setting-guide-prompt').value === originalPrompt && (await library()).settings.guidePrompt !== originalPrompt, 'reset previews the default without overwriting saved preferences');
  submit('settings-form');
  await until(async () => (await library()).settings.guidePrompt === originalPrompt, 'default prompt restored');
  check($('clear-source-url').disabled, 'empty URL has a disabled clear control');
  $('source-url').value = 'https://podcasts.apple.com/old-link'; $('source-url').dispatchEvent(event('input'));
  check(!$('clear-source-url').disabled, 'typing or pasting a URL enables its clear control');
  const revisionBeforeClear = (await library()).revision; click('clear-source-url');
  check($('source-url').value === '' && $('clear-source-url').disabled && (await library()).revision === revisionBeforeClear && mediaDownloads === 0, 'clear removes the old URL without submitting or changing saved data');
  check($('view-playlist').hidden === false && $('subtitles-panel').hidden, 'playlist opens with subtitles off');
  check(!!$('audio-file') && !$('source-youtube') && !$('youtube-source') && $('start-file-import').disabled, 'local audio selection replaces the inactive YouTube entry and requires a file');
  check(!$('icon-options') && $('brand-icon').getAttribute('src').includes('sunrise') && !$('gemini-key').disabled && !$('save-gemini-key').disabled && $('remove-gemini-key').disabled, 'fixed orange identity and optional Gemini setup are available without a saved key');
  click('create-album'); $('edit-title').value = 'My commute'; await confirm();
  check((await library()).albums[0].title === 'My commute', 'album created and committed to IndexedDB');
  const albumId = (await library()).albums[0].id;
  $('library-albums').querySelector('.album-management-header .round-button').dispatchEvent(event('click'));
  $('album-action').value = 'rename'; submit('dialog-form');
  await until(() => $('edit-title'), 'nested menu opens rename dialog');
  $('edit-title').value = 'Daily listening'; await confirm();
  check((await library()).albums[0].title === 'Daily listening', 'album action menu can chain to rename confirmation');
  $('library-albums').querySelector('.edit-album').dispatchEvent(event('click'));
  $('edit-title').value = 'Edited album'; await confirm();
  check((await library()).albums[0].title === 'Edited album', 'visible album edit button opens and persists the name');
  const sourceLink = 'https://podcasts.apple.com/tw/podcast/example/id189330872?i=1000796641961';
  fixtureMillis = 1500001; $('source-url').value = sourceLink; submit('import-form');
  await until(() => $('import-message').textContent.includes('超過目前 25'), 'oversized source rejected');
  check(mediaDownloads === 0 && (await library()).tracks.length === 0, 'oversized source stops before media download and leaves the library unchanged');
  fixtureMillis = 4000; failWorker = true; submit('import-form');
  await until(() => $('action-dialog').open && $('destination-album'), 'model failure still offers saved audio');
  check(document.querySelector('[data-stage="save"]').classList.contains('current') && $('dialog-description').textContent.includes('沒有可用字幕'), 'failed transcription offers audio-only output with a truthful save-stage message');
  check((await library()).tracks.length === 0 && !$('discard-import').hidden, 'audio-only output awaits explicit placement rather than changing existing data');
  check(wakeLocks.every(lock => lock.released) && $('wake-lock-status').hidden, 'completed audio-only preparation releases every screen lock');
  click('dialog-cancel'); await delay(10); click('discard-import'); await until(() => $('dialog-title').textContent.includes('捨棄'), 'discard unsaved audio'); await confirm();
  failWorker = false; holdWorker = true; submit('import-form');
  await until(() => document.querySelector('[data-stage="transcribe"]').classList.contains('current'), 'new import held in transcription');
  check(!wakeLocks.at(-1).released && $('wake-lock-status').textContent.includes('已啟用') && $('clear-source-url').disabled, 'conversion holds a screen lock and disables URL clearing');
  hidden = true; document.dispatchEvent(event('visibilitychange'));
  await until(() => !$('start-import').disabled, 'backgrounded import stops');
  check(wakeLocks.at(-1).released && (await library()).tracks.length === 0, 'leaving foreground cancels conversion and releases the screen lock');
  hidden = false; document.dispatchEvent(event('visibilitychange'));
  denyWakeLock = true; submit('import-form');
  await until(() => document.querySelector('[data-stage="transcribe"]').classList.contains('current') && $('wake-lock-status').textContent.includes('無法啟用'), 'denied wake lock permits model attempt');
  check(!$('wake-lock-status').hidden && (await library()).tracks.length === 0, 'denied wake lock shows a manual screen-awake fallback while transcription continues');
  click('cancel-import'); await until(() => !$('start-import').disabled, 'cancel denied-lock conversion');
  holdWorker = false; denyWakeLock = false;
  failWorker = false;
  async function importTrack(name, replace = '') {
    fixtureName = name; $('source-url').value = sourceLink; submit('import-form');
    await until(() => $('action-dialog').open && $('destination-album'), 'automatic download and ASR reaches album selection');
    $('destination-album').value = albumId; $('destination-album').dispatchEvent(event('change'));
    if (replace) $('replace-track').value = replace;
    await confirm();
  }
  const downloadsBeforeFirstSuccess = mediaDownloads;
  await importTrack('First episode');
  check(mediaDownloads === downloadsBeforeFirstSuccess + 1 && (await library()).tracks.length === 1, 'one submit automatically downloads, decodes, transcribes and saves');
  check(wakeLocks.every(lock => lock.released) && $('wake-lock-status').hidden && $('clear-source-url').disabled, 'successful import releases screen locks and resets its source control');
  await importTrack('Second episode'); await importTrack('Third episode');
  $('library-albums').querySelector('.edit-track').dispatchEvent(event('click')); $('edit-title').value = 'Edited first episode'; await confirm();
  check((await library()).tracks[0].title === 'Edited first episode', 'visible episode edit button persists its name without altering audio');
  const before = await library(), oldId = before.tracks[0].id;
  fixtureName = 'Fourth episode'; $('source-url').value = sourceLink; submit('import-form');
  await until(() => $('action-dialog').open && $('destination-album'), 'fourth episode selection');
  $('destination-album').value = albumId; $('destination-album').dispatchEvent(event('change'));
  check($('replace-track').value === '' && (await library()).tracks.length === 3, 'full album prompts without selecting or deleting an old episode');
  click('dialog-cancel'); await delay(10);
  check((await library()).tracks.some(track => track.id === oldId) && !$('finish-import').hidden, 'cancelling placement preserves old audio and pending conversion');
  click('finish-import'); await until(() => $('destination-album'), 'reopen pending placement');
  $('destination-album').value = albumId; $('destination-album').dispatchEvent(event('change')); $('replace-track').value = oldId; await confirm();
  check(!(await storageModule.read(`audio:${oldId}`)) && (await library()).tracks.length === 3, 'explicit replacement removes only the chosen old audio');
  const activeTrack = (await library()).tracks[0];
  const playRow = [...$('playlist-tracks').querySelectorAll('.track-main')].find(element => element.textContent.includes(activeTrack.title));
  holdPlayerCompletion = true;
  playRow.dispatchEvent(event('click'));
  await until(() => heldPlayerCompletions.length === 1, 'player activation persistence held');
  check($('player').open && !audio.paused, 'autoplay begins without waiting for progress persistence');
  audio.pause(); heldPlayerCompletions.shift()(); await delay(20);
  check(audio.paused, 'a delayed player save cannot override a newer pause');
  click('player-play'); await until(() => $('player').open && !audio.paused, 'track playback');
  check($('subtitles-panel').hidden, 'opening a new track keeps subtitles hidden');
  const assignmentsBeforeReopen = audioAssignments;
  audio.currentTime = 1.25; click('player-close'); await delay(10);
  [...$('playlist-tracks').querySelectorAll('.track-main')].find(element => element.textContent.includes(activeTrack.title)).dispatchEvent(event('click'));
  await until(() => $('player').open && !audio.paused, 'same episode reopens');
  check(audioAssignments === assignmentsBeforeReopen && audio.currentTime === 1.25, 'reopening the current episode preserves the loaded audio resource and live position');
  audio.currentTime = 0;

  click('toggle-subtitles'); check(!$('subtitles-panel').hidden && $('subtitle-list').children.length === 2, 'subtitle toggle displays timeline-aligned sentences');
  check($('player').classList.contains('subtitles-open') && $('toggle-subtitles').getAttribute('aria-pressed') === 'true', 'opening subtitles enters the expanded reading layout');
  const beforeLayoutToggle = { time: audio.currentTime, speed: audio.playbackRate, paused: audio.paused, source: audio.src };
  click('toggle-subtitles');
  check($('subtitles-panel').hidden && !$('player').classList.contains('subtitles-open') && audio.currentTime === beforeLayoutToggle.time && audio.playbackRate === beforeLayoutToggle.speed && audio.paused === beforeLayoutToggle.paused && audio.src === beforeLayoutToggle.source, 'closing the reading layout restores normal mode without changing playback');
  click('toggle-subtitles');
  const cue = $('subtitle-list').children[0].querySelector('.sentence-text');
  const completeFirstCue = fixtureSentence + ' We learn one idea at a time.';
  check(cue.textContent === completeFirstCue && !$('subtitle-list').querySelector('.reading-pages'), 'legacy long subtitles display the complete original text in one card without pagination');
  cue.dispatchEvent(event('pointerdown', { button: 0, clientX: 10, clientY: 10 }));
  await until(() => !$('translation-panel').hidden && $('translation-text').textContent, 'long-press translation');
  check(audio.paused && translated === 1, 'long press pauses playback and translates the selected sentence');
  await audio.play();
  check(audio.paused && !$('translation-panel').hidden && translated === 1, 'a delayed native play event cannot close a newer translation or resume its paused audio');
  check(translatedTexts[0] === completeFirstCue && $('translation-original').textContent === completeFirstCue && cue.classList.contains('translating') && !$('subtitle-list').children[1].querySelector('.sentence-text').classList.contains('translating'), 'long-pressing a card translates and marks only its complete original text');
  cue.dispatchEvent(event('click'));
  check(audio.paused && !$('translation-panel').hidden, 'the click after a long press never seeks or resumes playback');
  const translationModule = (await load(new URL(`../public/translation.mjs?v=${version}`, import.meta.url).href)).namespace;
  const freshTranslator = translationModule.createTranslator({ load: key => storageModule.read(`translation:${key}`), save: (key, entry) => storageModule.write(`translation:${key}`, entry), fetchImpl: async () => { throw new Error('No network expected after persisted cache'); } });
  const restored = await freshTranslator.translate($('translation-original').textContent, 'en');
  check(restored.cached && restored.persisted && translated === 1, 'a fresh translation client reads saved Chinese from IndexedDB without an external request');
  const pausedAt = audio.currentTime;
  click('translation-close'); await until(() => !audio.paused, 'closing translation resumes playback');
  check($('translation-panel').hidden && audio.currentTime === pausedAt, 'closing translation resumes the same track at the paused position');
  cue.dispatchEvent(event('keydown', { key: 'Enter' }));
  await until(() => audio.paused && !$('translation-panel').hidden && $('translation-text').textContent, 'translation reopened from cache');
  subtitleList.scrollTop = 450;
  click('player-play'); await until(() => !audio.paused, 'resume playback');
  check($('translation-panel').hidden, 'pressing play immediately dismisses the translation');
  check(subtitleList.scrollTop === 0, 'resuming play brings the same current subtitle back into view');
  click('next-sentence'); check(audio.currentTime === 2, 'next sentence seeks to its original timestamp');
  click('previous-sentence'); check(audio.currentTime === 0, 'previous sentence seeks to its original timestamp');
  audio.pause(); $('subtitle-list').children[1].querySelector('.sentence-text').dispatchEvent(event('click'));
  check(audio.currentTime === 2 && !audio.paused && $('translation-panel').hidden, 'tapping a subtitle starts playback from its original source timestamp');
  $('playback-speed').value = '1.5'; $('playback-speed').dispatchEvent(event('change')); check(audio.playbackRate === 1.5, 'speed control reaches native media element');
  subtitleList.scrollTop = 450;
  $('playback-range').value = '1.5'; $('playback-range').dispatchEvent(event('input')); $('playback-range').dispatchEvent(event('change'));
  check(audio.currentTime === 1.5 && +$('playback-range').value === 1.5, 'scrubbing the progress slider updates native media time');
  check(subtitleList.scrollTop === 0, 'seeking within the same cue still restores subtitle visibility');
  audio.currentTime = 2.1; audio.dispatchEvent(event('timeupdate'));
  check($('subtitle-list').children[1].getAttribute('aria-current') === 'true', 'playback time selects the matching subtitle cue');
  check(subtitleList.scrollTop === 250, 'playback scrolls the active cue into the subtitle viewport');
  subtitleList.dispatchEvent(event('wheel')); subtitleList.scrollTop = 0; subtitleList.dispatchEvent(event('scroll'));
  const whileBrowsing = subtitleScrolls.length;
  audio.dispatchEvent(event('timeupdate'));
  check(subtitleList.scrollTop === 0 && subtitleScrolls.length === whileBrowsing, 'manual browsing can inspect other subtitles without being pulled back immediately');
  await until(() => subtitleList.scrollTop === 250, 'automatic subtitle follow resumes after idle browsing');
  check(subtitleList.scrollTop === 250, 'following resumes automatically after browsing without requiring the current-sentence button');
  hidden = true; document.dispatchEvent(event('visibilitychange')); check(!audio.paused, 'backgrounding while listening does not programmatically pause audio'); hidden = false;
  screen.orientation.type = 'landscape-primary'; window.dispatchEvent(event('orientationchange')); check(!$('landscape-gate').hidden, 'mobile landscape shows portrait-only gate');
  screen.orientation.type = 'portrait-primary'; window.dispatchEvent(event('orientationchange')); check($('landscape-gate').hidden, 'portrait restores the app');
  screen.width = 1280; screen.height = 800; screen.orientation.type = 'landscape-primary'; window.dispatchEvent(event('orientationchange'));
  check($('landscape-gate').hidden && !$('app').inert, 'tablet landscape keeps the application available');
  screen.width = 800; screen.height = 1280; screen.orientation.type = 'portrait-primary'; window.dispatchEvent(event('resize'));
  check($('landscape-gate').hidden && !$('app').inert, 'tablet portrait and viewport changes remain available');
  screen.width = 393; screen.height = 852;
  click('player-close'); await delay(10);
  check(!$('player').classList.contains('subtitles-open') && $('subtitles-panel').hidden, 'closing the player clears its expanded subtitle state');
  const albumCard = $('playlist-albums').children[0];
  if (albumCard.getAttribute('aria-pressed') !== 'true') albumCard.dispatchEvent(event('click'));
  $('track-count').querySelector('button').dispatchEvent(event('click'));
  await until(() => $('player').open && !audio.paused, 'album playback starts'); await delay(50);
  const ordered = (await library()).tracks; audio.dispatchEvent(event('ended'));
  await until(() => $('player-title').textContent === ordered[1].title && !audio.paused, 'next album track plays');
  check($('player-title').textContent === ordered[1].title, 'album queue advances to the next saved episode');
  click('player-stop'); check(audio.paused && audio.currentTime === 0, 'stop pauses and resets the current episode');
  click('player-close'); await delay(10); click('header-settings');
  $('setting-albums').value = '5'; $('setting-tracks').value = '5'; $('setting-minutes').value = '35'; $('setting-subtitles').value = 'xlarge';
  submit('settings-form');
  await until(async () => (await library()).settings.albumLimit === 5, 'settings saved');
  check((await library()).settings.icon === 'sunrise' && $('manifest').getAttribute('href').includes('sunrise'), 'saving settings preserves the fixed orange icon and portrait manifest');
  check((await library()).settings.subtitleSize === 'xlarge', 'subtitle size preference persists');
  for (let i = 0; i < 4; i++) { click('create-album'); $('edit-title').value = `Extra album ${i}`; await confirm(); }
  const fullAlbums = await library(); click('create-album');
  check($('replace-album').value === '' && (await library()).albums.length === 5, 'full album capacity prompts for explicit replacement without deleting');
  click('dialog-cancel'); await delay(10); click('create-album');
  $('edit-title').value = 'Replacement album'; $('replace-album').value = fullAlbums.albums[1].id; await confirm();
  check((await library()).albums.length === 5 && (await library()).albums.some(album => album.title === 'Replacement album'), 'confirmed album replacement respects the configured album limit');
  // Exercise the actual storage transaction against fake-indexeddb, including
  // quota failure after delete requests and stale-revision rejection.
  const snapshot = await library(), victim = snapshot.tracks[0], next = { ...snapshot, revision: snapshot.revision + 1, tracks: snapshot.tracks.slice(1) };
  const originalPut = fake.namespace.IDBObjectStore.prototype.put;
  fake.namespace.IDBObjectStore.prototype.put = function(value, key) { if (key === 'audio:quota-test') throw new DOMException('Simulated quota exceeded', 'QuotaExceededError'); return originalPut.call(this, value, key); };
  await assert.rejects(storageModule.commitLibrary(next, { expectedRevision: snapshot.revision, audio: { id: 'quota-test', blob: new Blob(['new']) }, removeIds: [victim.id] }));
  fake.namespace.IDBObjectStore.prototype.put = originalPut;
  check(!!(await storageModule.read(`audio:${victim.id}`)) && (await library()).revision === snapshot.revision, 'quota failure rolls back metadata AND deleted audio in the same transaction');
  await assert.rejects(storageModule.commitLibrary(next, { expectedRevision: snapshot.revision - 1, removeIds: [victim.id] }));
  check(!!(await storageModule.read(`audio:${victim.id}`)), 'stale tab cannot delete audio with an outdated library');
  const deletion = (await library()).tracks.at(-1);
  const deletionRow = [...$('library-albums').querySelectorAll('.track-row')].find(row => row.textContent.includes(deletion.title));
  deletionRow.querySelector('.more-button').dispatchEvent(event('click')); $('track-action').value = 'delete'; submit('dialog-form');
  await until(() => $('dialog-title').textContent === '刪除這個音訊？', 'episode deletion confirmation'); click('dialog-cancel'); await delay(10);
  check(!!(await storageModule.read(`audio:${deletion.id}`)), 'cancelling episode deletion retains its real saved Blob');
  deletionRow.querySelector('.more-button').dispatchEvent(event('click')); $('track-action').value = 'delete'; submit('dialog-form');
  await until(() => $('dialog-title').textContent === '刪除這個音訊？', 'episode deletion confirmation again'); await confirm();
  check(!(await storageModule.read(`audio:${deletion.id}`)) && (await library()).tracks.length === 2, 'confirmed episode deletion removes only that audio and metadata');
  click('clear-data'); await until(() => $('action-dialog').open, 'clear confirmation'); click('dialog-cancel'); await delay(10);
  check((await library()).tracks.length === 2, 'cancelling clear preserves every saved track');
  click('clear-data'); await until(() => $('action-dialog').open, 'clear confirmation again'); await confirm();
  check((await library()) === undefined && !(await storageModule.read(`audio:${victim.id}`)), 'confirmed clear removes all app user data');
  check(fakeCaches.has('another-app-models') && !fakeCaches.has('commute-lingo-models-v1'), 'clear removes own model cache while preserving other apps');
  // Verify the other requested placement branch against the actual UI: a
  // converted source creates its own album, then replaces a full album only
  // after the user confirms removal of that album and its saved audio.
  fixtureName = 'Converted into a new album'; $('source-url').value = sourceLink; submit('import-form');
  await until(() => $('action-dialog').open && $('new-album-title'), 'first source creates a new album');
  check($('destination-album').value === '__new', 'empty library offers new album after successful conversion');
  $('new-album-title').value = 'Created from import'; await confirm();
  const createdFromImport = await library(), importedAlbum = createdFromImport.albums[0], importedAudio = createdFromImport.tracks[0];
  check(createdFromImport.albums.length === 1 && importedAudio.albumId === importedAlbum.id && !!await storageModule.read(`audio:${importedAudio.id}`), 'source placement atomically creates its album, metadata and audio');
  for (let i = 0; i < 2; i++) { click('create-album'); $('edit-title').value = `Empty collection ${i}`; await confirm(); }
  fixtureName = 'Converted into replacement album'; $('source-url').value = sourceLink; submit('import-form');
  await until(() => $('action-dialog').open && $('destination-album'), 'full album import placement');
  $('destination-album').value = '__new'; $('destination-album').dispatchEvent(event('change'));
  $('new-album-title').value = 'New journey';
  check($('new-replace-album').value === '' && !!await storageModule.read(`audio:${importedAudio.id}`), 'creating an album at capacity requires a removal choice and preserves the saved audio');
  click('dialog-cancel'); await delay(10);
  check((await library()).albums.some(album => album.id === importedAlbum.id) && !!await storageModule.read(`audio:${importedAudio.id}`), 'cancelling converted album replacement retains the entire old album');
  click('finish-import'); await until(() => $('destination-album'), 'resume converted album placement');
  $('destination-album').value = '__new'; $('destination-album').dispatchEvent(event('change'));
  $('new-album-title').value = 'New journey'; $('new-replace-album').value = importedAlbum.id; await confirm();
  const replacedAlbums = await library(), newAlbum = replacedAlbums.albums.find(album => album.title === 'New journey'), newAudio = replacedAlbums.tracks[0];
  check(replacedAlbums.albums.length === 3 && newAudio.albumId === newAlbum.id && !(await storageModule.read(`audio:${importedAudio.id}`)) && !!await storageModule.read(`audio:${newAudio.id}`), 'confirming converted album replacement removes only the selected album and saves the new audio');
  const albumRow = [...$('library-albums').querySelectorAll('.album-management')].find(row => row.querySelector('h3').textContent === 'New journey');
  albumRow.querySelector('.album-management-header .round-button').dispatchEvent(event('click')); $('album-action').value = 'delete'; submit('dialog-form');
  await until(() => $('dialog-title').textContent === '刪除這個專輯？', 'album deletion confirmation'); click('dialog-cancel'); await delay(10);
  check(!!await storageModule.read(`audio:${newAudio.id}`) && (await library()).albums.length === 3, 'cancelling album deletion preserves its audio and subtitles');
  albumRow.querySelector('.album-management-header .round-button').dispatchEvent(event('click')); $('album-action').value = 'delete'; submit('dialog-form');
  await until(() => $('dialog-title').textContent === '刪除這個專輯？', 'album deletion confirmation again'); await confirm();
  check(!(await storageModule.read(`audio:${newAudio.id}`)) && (await library()).albums.length === 2 && (await library()).tracks.length === 0, 'confirmed album deletion removes its audio and subtitles while keeping other albums');
  // A saved partial transcript must explain its coverage and be repairable
  // without another media download, while cancelled/failed jobs keep it intact.
  fixtureName = 'Saved partial transcript'; fixtureSeconds = 120; fixtureMillis = 120000; partialTranscript = true;
  $('source-url').value = sourceLink; submit('import-form');
  await until(() => $('destination-album'), 'partial transcript placement');
  $('destination-album').value = (await library()).albums[0].id; $('destination-album').dispatchEvent(event('change')); await confirm();
  const repairBefore = await library(), repairTrack = repairBefore.tracks[0], downloadsBeforeRepair = mediaDownloads;
  const openRepairTrack = async () => { [...$('playlist-tracks').querySelectorAll('.track-main')].find(row => row.textContent.includes(fixtureName)).dispatchEvent(event('click')); await until(() => $('player').open, 'open saved partial transcript'); };
  const repairFromMenu = async () => { click('player-menu'); await until(() => $('track-action'), 'audio management'); $('track-action').value = 'transcribe'; await confirm(); };
  await openRepairTrack();
  check(!$('transcript-notice') && $('toggle-subtitles').getAttribute('aria-label') === '字幕未完整' && repairTrack.segments.at(-1).end === 2 && repairTrack.duration === 120, 'partial timing stays truthful without a persistent explanation box');
  audio.currentTime = 60; audio.dispatchEvent(event('timeupdate'));
  check(!$('subtitle-list').querySelector('.active') && !$('transcript-notice'), 'seeking beyond available captions has no false highlight or explanation box');
  failWorker = true; await repairFromMenu();
  await until(() => $('import-message').textContent.includes('未取得新字幕'), 'failed saved-audio repair retains the old result');
  check(document.querySelector('[data-stage="save"]').classList.contains('current'), 'empty regeneration completes without replacing existing subtitles');
  check((await library()).revision === repairBefore.revision && !!await storageModule.read(`audio:${repairTrack.id}`), 'failed regeneration preserves saved audio and original subtitle revision');
  check(wakeLocks.every(lock => lock.released), 'failed saved-audio regeneration releases its screen lock');
  failWorker = false; holdWorker = true; await openRepairTrack(); await repairFromMenu();
  await until(() => document.querySelector('[data-stage="transcribe"]').classList.contains('current') && !$('cancel-import').hidden, 'saved-audio repair enters model stage');
  check(!wakeLocks.at(-1).released, 'saved-audio regeneration holds a screen lock during model work');
  click('cancel-import'); await delay(20);
  check((await library()).revision === repairBefore.revision && (await library()).tracks[0].segments.at(-1).end === 2, 'cancelling regeneration retains the original subtitles');
  check(wakeLocks.every(lock => lock.released), 'cancelling saved-audio regeneration releases its screen lock');
  holdWorker = false; partialTranscript = false; await openRepairTrack(); await repairFromMenu();
  await until(async () => (await library()).tracks[0].segments.at(-1).end === 120 && $('player').open, 'successful regeneration commits complete captions');
  const repaired = (await library()).tracks[0];
  check(mediaDownloads === downloadsBeforeRepair && repaired.id === repairTrack.id && repaired.albumId === repairTrack.albumId && repaired.title === repairTrack.title && !!await storageModule.read(`audio:${repairTrack.id}`), 'successful regeneration reuses saved audio and preserves its identity, title and album without downloading');
  check(wakeLocks.every(lock => lock.released), 'successful saved-audio regeneration restores normal screen sleep');
  audio.currentTime = 60; audio.dispatchEvent(event('timeupdate')); click('toggle-subtitles');
  check(!$('transcript-notice') && $('toggle-subtitles').getAttribute('aria-label') === '句子字幕' && $('subtitle-list').children[1].getAttribute('aria-current') === 'true', 'new captions remain available past the cutoff while missing word timing is disclosed');
  missingModelStart = true; await repairFromMenu();
  await until(async () => (await library()).tracks[0].segments[0].timingUncertain && $('player').open, 'missing model time retained as a disclosed range');
  const uncertainTrack = (await library()).tracks[0];
  check(uncertainTrack.segments[0].text.includes(fixtureSentence) && uncertainTrack.metrics.timestampWarnings.length === 1 && uncertainTrack.id === repairTrack.id && mediaDownloads === downloadsBeforeRepair, 'missing model timestamps preserve original words and saved audio without another download');
  check(!$('transcript-notice') && ['字幕未完整', '字幕時間為估計範圍'].includes($('toggle-subtitles').getAttribute('aria-label')) && $('subtitle-list').children[0].textContent.includes('時間範圍估計'), 'player and affected caption visibly disclose uncertain timing');
  missingModelStart = false; await repairFromMenu();
  await until(async () => !(await library()).tracks[0].segments[0].timingUncertain && $('player').open, 'normal model timing replaces the coarse range');
  check(!$('subtitle-list').textContent.includes('時間範圍估計') && (await library()).tracks[0].metrics.timestampWarnings.length === 0, 'successful sentence-time regeneration clears coarse warnings without claiming word timing');
  wordTranscript = true; await repairFromMenu();
  await until(async () => (await library()).tracks[0].alignment === 'word-v1' && $('player').open, 'word timing saved as sentence captions');
  const aligned = (await library()).tracks[0];
  check(aligned.segments.length === 3 && aligned.id === repairTrack.id && aligned.albumId === repairTrack.albumId && mediaDownloads === downloadsBeforeRepair && !!await storageModule.read(`audio:${aligned.id}`), 'aligned regeneration replaces only captions while preserving the saved audio and album');
  check($('subtitle-list').children.length === 3 && [...$('subtitle-list').children].every(row => row.querySelectorAll('.sentence-text').length === 1) && !$('transcript-notice'), 'each aligned sentence has its own time card without coarse-timing warnings');
  const activeRows = () => [...$('subtitle-list').children].filter(row => row.classList.contains('active'));
  for (const [time, index] of [[0.5, 0], [5.5, 1], [9.5, 2]]) {
    audio.currentTime = time; audio.dispatchEvent(event('timeupdate'));
    check(activeRows().length === 1 && activeRows()[0] === $('subtitle-list').children[index] && activeRows()[0].getAttribute('aria-current') === 'true', `word-aligned playback at ${time}s highlights only sentence ${index + 1}`);
  }
  audio.currentTime = .5; audio.dispatchEvent(event('timeupdate'));
  check($('subtitle-list').querySelector('.spoken-word')?.textContent === 'Dr.' && aligned.segments[0].words.length === 2, 'saved word anchors drive a single live word cursor');
  audio.currentTime = 4.5; audio.dispatchEvent(event('timeupdate'));
  check(activeRows().length === 0 && !$('subtitle-list').querySelector('.spoken-word'), 'a gap between aligned sentences leaves every card and word inactive');
  audio.currentTime = 0.5; audio.dispatchEvent(event('timeupdate')); click('next-sentence');
  check(audio.currentTime === 5 && activeRows()[0] === $('subtitle-list').children[1], 'next sentence seeks to the second model-aligned start');
  click('next-sentence'); click('previous-sentence');
  check(audio.currentTime === 5, 'previous sentence uses the same aligned boundaries');
  $('subtitle-list').children[2].querySelector('.sentence-text').dispatchEvent(event('click'));
  check(audio.currentTime === 9 && activeRows().length === 1 && activeRows()[0] === $('subtitle-list').children[2], 'tapping an aligned card seeks to its own start and leaves one active card');
  $('subtitle-list').children[1].querySelector('.sentence-text').dispatchEvent(event('keydown', { key: 'Enter' }));
  await until(() => !$('translation-panel').hidden && $('translation-text').textContent, 'aligned sentence translation');
  check(translatedTexts.at(-1) === 'The answer lies on the label.' && audio.paused && $('subtitle-list').querySelectorAll('.sentence-text.translating').length === 1, 'aligned cards translate their complete sentence and mark only the selected one');
  const excerptSource = audio.src, excerptDownloads = mediaDownloads, excerptTranslations = translated, excerptReturnTime = audio.currentTime;
  click('translation-play'); await until(() => !audio.paused, 'original excerpt starts');
  check(audio.currentTime === 5 && !$('translation-panel').hidden && $('translation-play').getAttribute('aria-pressed') === 'true', 'translation replays only its selected sentence from the model-aligned start without closing');
  audio.currentTime = 8.12; audio.dispatchEvent(event('timeupdate'));
  check(audio.paused && audio.currentTime === 8 && !$('translation-panel').hidden && $('translation-play').getAttribute('aria-pressed') === 'false', 'sentence playback stops at its aligned end and leaves the translation readable');
  click('translation-play'); await until(() => !audio.paused, 'original excerpt repeats');
  click('translation-play');
  check(audio.paused && !$('translation-panel').hidden && audio.currentTime === 5, 'the original-audio button can stop and replay the selected sentence');
  await until(async () => (await storageModule.read(`progress:${aligned.id}`))?.position === excerptReturnTime, 'excerpt keeps original resume position');
  check((await storageModule.read(`progress:${aligned.id}`)).position === excerptReturnTime, 'sentence previews preserve the main listening position in saved progress');
  check(audio.src === excerptSource && mediaDownloads === excerptDownloads && translated === excerptTranslations, 'sentence playback reuses saved original audio without fetching audio or translating again');
  click('translation-close'); await until(() => !audio.paused, 'aligned translation resumes');
  check(audio.currentTime === excerptReturnTime, 'closing translation after excerpt playback resumes the original listening position');
  $('subtitle-list').children[1].querySelector('.sentence-text').dispatchEvent(event('keydown', { key: 'Enter' }));
  await until(() => !$('translation-panel').hidden && $('translation-text').textContent, 'translation before seeking away');
  click('translation-play'); await until(() => !audio.paused, 'excerpt before seek');
  $('playback-range').value = '10'; $('playback-range').dispatchEvent(event('change'));
  audio.dispatchEvent(event('timeupdate'));
  check($('translation-panel').hidden && audio.currentTime === 10 && !audio.paused, 'scrubbing away from an excerpt cancels its end limit and preserves the requested position');
  wordTranscript = false;
  click('player-close'); click('source-file');
  check(!$('file-source').hidden && $('podcast-source').hidden && $('source-file').getAttribute('aria-pressed') === 'true', 'source selector exposes local audio import');
  let pickedFiles = [];
  Object.defineProperty($('audio-file'), 'files', { get: () => pickedFiles });
  const pickFile = file => { pickedFiles = file ? [file] : []; $('audio-file').dispatchEvent(event('change')); };
  const file = Object.assign(new Blob([new Uint8Array([82, 73, 70, 70, 20, 0, 0, 0, 87, 65, 86, 69])], { type: 'audio/wav' }), { name: '<img src=x onerror=alert(1)>.wav' });
  pickFile(file);
  check(!$('start-file-import').disabled && !$('clear-audio-file').disabled && !$('selected-audio').querySelector('img') && $('selected-audio').textContent.includes(file.name), 'local filename renders as inert text and enables import');
  click('clear-audio-file');
  check($('start-file-import').disabled && $('clear-audio-file').disabled && $('selected-audio').textContent === '尚未選擇音檔。', 'clearing a selection permits choosing the same file again');
  const localBefore = await library(), downloadsBeforeFile = mediaDownloads, lookupsBeforeFile = catalogLookups, translationsBeforeFile = translated;
  pickFile(Object.assign(new Blob(['<html>'], { type: 'audio/mpeg' }), { name: 'disguised.mp3' })); submit('file-import-form');
  await until(() => $('import-message').textContent.includes('內容與副檔名不符'), 'disguised local audio rejected');
  check((await library()).revision === localBefore.revision && !$('action-dialog').open, 'invalid local media leaves saved audio and captions untouched');
  fixtureSeconds = 1501; pickFile(file); submit('file-import-form');
  await until(() => $('import-message').textContent.includes('超過目前 25'), 'local duration preference enforced');
  check((await library()).revision === localBefore.revision, 'local audio exceeding the duration preference cannot enter placement');
  fixtureSeconds = 4; holdWorker = true; submit('file-import-form');
  await until(() => document.querySelector('[data-stage="transcribe"]').classList.contains('current') && !$('cancel-import').hidden, 'local audio model started');
  check($('audio-file').disabled && $('source-podcast').disabled && $('start-import').disabled && document.querySelector('[data-stage="download"]').hidden && !wakeLocks.at(-1).released, 'file conversion locks both sources, skips downloading and holds the screen awake');
  click('cancel-import'); await until(() => !$('start-file-import').disabled, 'local import cancellation completed');
  check((await library()).revision === localBefore.revision && wakeLocks.every(lock => lock.released), 'cancelled local inference preserves existing data and releases its screen lock');
  holdWorker = false; failWorker = true; submit('file-import-form');
  await until(() => $('action-dialog').open && $('destination-album'), 'local model failure retains original audio for placement');
  check((await library()).revision === localBefore.revision && $('dialog-description').textContent.includes('沒有可用字幕'), 'local inference failure retains a pending audio-only result without changing saved data');
  click('dialog-cancel'); await delay(10); click('discard-import'); await until(() => $('dialog-title').textContent.includes('捨棄'), 'discard pending local audio'); await confirm();
  failWorker = false; submit('file-import-form');
  await until(() => $('action-dialog').open && $('destination-album'), 'local audio reaches placement');
  click('dialog-cancel'); await delay(10);
  check((await library()).revision === localBefore.revision && !$('finish-import').hidden && $('audio-file').disabled, 'cancelled local placement retains the pending conversion without saving');
  click('finish-import'); await until(() => $('action-dialog').open && $('destination-album'), 'resume local placement');
  $('destination-album').value = repairTrack.albumId; $('destination-album').dispatchEvent(event('change')); await confirm();
  const localTrack = (await library()).tracks.find(track => track.source === 'file'), storedFile = await storageModule.read(`audio:${localTrack?.id}`);
  check(localTrack.title === file.name.slice(0, -4) && localTrack.sourceURL === '' && localTrack.segments.length === 2 && storedFile.size === file.size && localTrack.albumId === repairTrack.albumId, 'local import atomically persists its audio, generated captions and selected album');
  check(mediaDownloads === downloadsBeforeFile && catalogLookups === lookupsBeforeFile && translated === translationsBeforeFile, 'local audio conversion sends no audio or text to source or translation services');
  check($('start-file-import').disabled && $('selected-audio').textContent === '尚未選擇音檔。' && wakeLocks.every(lock => lock.released), 'successful local placement clears the file selection and restores sleep');
  failWorker = true; pickFile(file); submit('file-import-form');
  await until(() => $('destination-album') && $('action-dialog').open, 'audio-only save');
  $('new-track-title').value = 'Audio without subtitles'; $('destination-album').value = repairTrack.albumId; $('destination-album').dispatchEvent(event('change')); await confirm();
  const audioOnly = (await library()).tracks.find(track => track.title === 'Audio without subtitles');
  check(audioOnly.transcriptStatus === 'audio-only' && !audioOnly.segments.length && !!await storageModule.read(`audio:${audioOnly.id}`), 'audio-only placement atomically saves the original Blob without fabricating subtitles');
  [...$('playlist-tracks').querySelectorAll('.track-main')].find(row => row.textContent.includes(audioOnly.title)).dispatchEvent(event('click'));
  await until(() => $('player').open && !audio.paused, 'audio-only playback'); click('toggle-subtitles');
  check($('toggle-subtitles').getAttribute('aria-label') === '尚無字幕' && $('subtitle-list').textContent.includes('尚無字幕'), 'saved audio-only files play normally and explain how to add subtitles later');
  check($('previous-sentence').disabled && $('next-sentence').disabled && !$('player-play').disabled, 'audio-only playback disables unavailable sentence jumps while keeping transport usable');
  click('player-close'); await delay(10); failWorker = false; mixedTranscript = true; pickFile(file); submit('file-import-form');
  await until(() => $('destination-album') && $('action-dialog').open, 'partial output placement');
  check($('dialog-description').textContent.includes('部分字幕未對齊'), 'partial output is disclosed before placement');
  $('new-track-title').value = 'Partial subtitle output'; $('destination-album').value = repairTrack.albumId; $('destination-album').dispatchEvent(event('change'));
  $('replace-track').value = audioOnly.id; await confirm();
  const partial = (await library()).tracks.find(track => track.title === 'Partial subtitle output');
  check(partial.transcriptStatus === 'partial' && partial.segments.length === 3 && partial.segments[1].timingUncertain && !partial.segments[0].timingUncertain, 'partial placement preserves healthy sentence timing and retains unaligned text');
  [...$('playlist-tracks').querySelectorAll('.track-main')].find(row => row.textContent.includes(partial.title)).dispatchEvent(event('click'));
  await until(() => $('player').open, 'partial player'); click('toggle-subtitles');
  check($('subtitle-list').querySelectorAll('.subtitle-cue').length === 3 && $('toggle-subtitles').getAttribute('aria-label') === '字幕未完整', 'mixed timing renders one card per available region with a visible completion notice');
  audio.currentTime = 1.5; audio.dispatchEvent(event('timeupdate'));
  check($('subtitle-list').querySelectorAll('.active').length === 1 && $('subtitle-list').textContent.includes('時間範圍估計'), 'coarse timing stays disclosed and still highlights at most one region');
  check(mediaDownloads === downloadsBeforeFile && catalogLookups === lookupsBeforeFile && translated === translationsBeforeFile, 'audio-only and partial local results never upload audio or request extra translation');
  // Vocabulary and personal-backup regression uses only fake API responses.
  click('player-close'); await delay(10); audio.pause();
  document.querySelector('[data-tab="vocabulary"]').dispatchEvent(event('click'));
  const words = () => storageModule.read('vocabulary-v1');
  click('add-word'); $('new-word').value = 'resilience'; $('word-tags').value = '生活,工作'; await confirm();
  await until(async () => (await words())?.words[0]?.dictionary && !$('vocabulary-list').textContent.includes('正在查詢'), 'word translation and dictionary persisted');
  check((await words()).words.length === 1 && translatedTexts.at(-1) === 'resilience' && dictionaryWords.at(-1) === 'resilience', 'one collection sends only the word to translation and dictionary and saves its metadata');
  $('vocabulary-list').querySelector('.word-main').dispatchEvent(event('click'));
  $('word-translation').value = '我的復原力解釋'; $('word-note').value = '<img src=x onerror=alert(1)> My note'; $('word-status').value = 'known'; await confirm();
  check((await words()).words[0].note.includes('<img') && !document.querySelector('#vocabulary-list img'), 'manual notes persist as text without executing markup');
  $('vocabulary-list').querySelector('.word-star').dispatchEvent(event('click')); await until(async () => (await words()).words[0].starred, 'star committed');
  $('vocabulary-filter').value = 'known'; $('vocabulary-filter').dispatchEvent(event('change'));
  check($('vocabulary-list').querySelectorAll('.word-card').length === 1, 'learning-state filter finds the edited word');
  $('vocabulary-tag').value = 'tag:工作'; $('vocabulary-tag').dispatchEvent(event('change'));
  check($('vocabulary-list').querySelectorAll('.word-card').length === 1, 'topic filter can be combined with learning state');
  $('vocabulary-search').value = 'not-found'; $('vocabulary-search').dispatchEvent(event('input'));
  check(!$('vocabulary-list').querySelector('.word-card'), 'search filters without altering saved data');
  $('vocabulary-search').value = ''; $('vocabulary-filter').value = 'all'; $('vocabulary-tag').value = 'all'; $('vocabulary-search').dispatchEvent(event('input'));
  const lookupCount = translated + dictionaryWords.length;
  click('add-word'); $('new-word').value = 'RESILIENCE'; submit('dialog-form'); await until(() => $('dialog-error').textContent.includes('已在單字本'), 'duplicate rejected');
  check((await words()).words.length === 1 && translated + dictionaryWords.length === lookupCount, 'duplicate collection keeps notes and makes no new API request');
  click('dialog-cancel'); await delay(10);
  failWordLookups = true; click('add-word'); $('new-word').value = 'outage'; await confirm();
  await until(() => !$('vocabulary-list').textContent.includes('正在查詢'), 'failed enrichment ends');
  check((await words()).words.some(word => word.word === 'outage' && !word.translation && !word.dictionary), 'offline or failed API never discards the newly collected word');
  failWordLookups = false;
  const outageRow = [...$('vocabulary-list').querySelectorAll('.word-card')].find(row => row.textContent.includes('outage'));
  outageRow.querySelector('.round-button').dispatchEvent(event('click')); $('word-action').value = 'lookup'; submit('dialog-form');
  await until(async () => (await words()).words.find(word => word.word === 'outage')?.dictionary && !$('vocabulary-list').textContent.includes('正在查詢'), 'explicit retry fills missing data');
  check(!!(await words()).words.find(word => word.word === 'outage').translation, 'explicit retry completes the saved word without replacing another word');

  // Preserve native selection behavior and survive the range collapsing when
  // the separate page button is tapped; no native menu is simulated here.
  document.querySelector('[data-tab="playlist"]').dispatchEvent(event('click'));
  [...$('playlist-tracks').querySelectorAll('.track-main')].find(row => row.textContent.includes(partial.title)).dispatchEvent(event('click'));
  await until(() => $('player').open, 'reopen selection source'); if ($('subtitles-panel').hidden) click('toggle-subtitles');
  $('subtitle-list').querySelector('.sentence-text').dispatchEvent(event('keydown', { key: 'Enter' }));
  await until(() => !$('translation-panel').hidden, 'selection translation panel');
  const original = $('translation-original'), selectedWord = original.textContent.match(/\p{L}+/u)[0];
  let selection = { isCollapsed: false, rangeCount: 1, anchorNode: original.firstChild, focusNode: original.firstChild, toString: () => selectedWord };
  document.getSelection = () => selection;
  const change = event('selectionchange'); document.dispatchEvent(change);
  check(!$('save-selected-word').disabled && !change.defaultPrevented && $('word-selection-label').textContent.includes(selectedWord), 'valid original-text selection enables the separate save action without cancelling native selection');
  selection.isCollapsed = true; document.dispatchEvent(event('selectionchange')); click('save-selected-word');
  await until(async () => (await words()).words.length === 3 && (await words()).words.find(word => word.word === selectedWord)?.dictionary && !$('vocabulary-list').textContent.includes('正在查詢'), 'selected word saved after collapsed selection');
  const selectedEntry = (await words()).words.find(word => word.word === selectedWord);
  check(selectedEntry.sourceTitle === partial.title && !Object.hasOwn(selectedEntry, 'sentence') && !Object.hasOwn(selectedEntry, 'audio'), 'selection saves only the word and source title, with no sentence or audio');
  selection = { ...selection, isCollapsed: false, toString: () => 'two words' }; document.dispatchEvent(event('selectionchange'));
  check($('save-selected-word').disabled, 'multi-word selection cannot be collected in the single-word version');
  const menu = event('contextmenu'); original.dispatchEvent(menu); check(!menu.defaultPrevented, 'translation original leaves the browser context menu untouched');
  click('player-close'); await delay(10); audio.pause();

  const sourceAlbum = (await library()).albums.find(album => album.id === partial.albumId);
  const sourceRow = [...$('library-albums').querySelectorAll('.album-management')].find(row => row.querySelector('h3').textContent === sourceAlbum.title);
  sourceRow.querySelector('.album-management-header .round-button').dispatchEvent(event('click')); $('album-action').value = 'delete'; submit('dialog-form');
  await until(() => $('dialog-title').textContent === '刪除這個專輯？', 'remove word source album'); await confirm();
  check(!(await storageModule.read(`audio:${partial.id}`)) && (await words()).words.length === 3 && (await words()).words.some(word => word.id === selectedEntry.id), 'deleting the source album and audio leaves all vocabulary and notes intact');
  check(!$('restore-backup-button').disabled && !$('restore-backup').disabled && !$('add-word').disabled, 'finishing a library write re-enables restore and vocabulary actions');

  const downloads = [];
  document.addEventListener('click', event => { if (event.target.localName === 'a' && event.target.download) downloads.push({ href: event.target.href, name: event.target.download }); });
  click('backup-library'); await until(() => downloads.length === 1, 'personal JSON download prepared');
  const exportedBlob = await (await fetch(downloads[0].href)).blob(), exported = JSON.parse(await exportedBlob.text());
  check(downloads[0].name.endsWith('.json') && exported.vocabulary.words.length === 3 && !Object.hasOwn(exported, 'library') && !Object.hasOwn(exported, 'translations'), 'UI backup exports settings and words as JSON without albums, audio, subtitles or translation caches');
  const resilience = (await words()).words.find(word => word.word === 'resilience');
  const resilienceRow = [...$('vocabulary-list').querySelectorAll('.word-card')].find(row => row.dataset.wordId === resilience.id);
  resilienceRow.querySelector('.round-button').dispatchEvent(event('click')); $('word-action').value = 'delete'; submit('dialog-form');
  await until(() => $('dialog-title').textContent.includes('刪除「'), 'delete word confirm'); await confirm();
  check((await words()).words.length === 2, 'single-word deletion leaves other entries unchanged');
  check(!$('restore-backup-button').disabled && !$('restore-backup').disabled && !$('add-word').disabled, 'finishing a vocabulary write re-enables restore and vocabulary actions');
  Object.defineProperty($('restore-backup'), 'files', { configurable: true, value: [exportedBlob] }); $('restore-backup').dispatchEvent(event('change'));
  await until(() => $('dialog-title').textContent === '預覽備份還原' && $('action-dialog').open, 'restore preview');
  const revisionBeforeCancel = (await words()).revision;
  check($('dialog-description').textContent.includes('新增 1') && !$('restore-settings').checked, 'restore previews additions and duplicates, with settings opt-in');
  click('dialog-cancel'); await delay(20); check((await words()).revision === revisionBeforeCancel, 'cancelling restore leaves the vocabulary unchanged');
  $('restore-backup').dispatchEvent(event('change')); await until(() => $('action-dialog').open && $('restore-settings'), 'reopen restore preview'); await confirm();
  check((await words()).words.length === 3 && (await words()).words.find(word => word.word === 'resilience').note.includes('My note') && (await library()).tracks.length === 0, 'confirmed restore merges entries and notes without restoring deleted audio or albums');
  const revisionBeforeBadFile = (await words()).revision;
  Object.defineProperty($('restore-backup'), 'files', { configurable: true, value: [new Blob(['invalid JSON'])] }); $('restore-backup').dispatchEvent(event('change'));
  await until(() => $('global-message').textContent.includes('有效的 JSON'), 'invalid backup rejected');
  check((await words()).revision === revisionBeforeBadFile, 'malformed backup cannot change existing data');

  // Transactions are exercised against fake-indexeddb, including an injected
  // second-put quota failure after the library put has already been queued.
  const stable = await storageModule.readPersonalData();
  await assert.rejects(storageModule.commitVocabulary(stable.vocabulary, { expectedRevision: stable.vocabulary.revision - 1, expectedGeneration: stable.vocabulary.generation }));
  await assert.rejects(storageModule.commitVocabulary(stable.vocabulary, { expectedRevision: stable.vocabulary.revision, expectedGeneration: 'another-generation' }));
  const VocabularyStore = fake.namespace.IDBObjectStore, vocabularyOriginalPut = VocabularyStore.prototype.put;
  VocabularyStore.prototype.put = function(value, key) { if (key === 'vocabulary-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError'); return vocabularyOriginalPut.call(this, value, key); };
  try {
    await assert.rejects(storageModule.commitPersonalData({ ...stable.library, revision: stable.library.revision + 1, settings: { ...stable.library.settings, subtitleSize: 'large' } }, { ...stable.vocabulary, revision: stable.vocabulary.revision + 1 }, { expectedLibraryRevision: stable.library.revision, expectedVocabularyRevision: stable.vocabulary.revision, expectedGeneration: stable.vocabulary.generation, expectedLibrary: stable.library }));
  } finally { VocabularyStore.prototype.put = vocabularyOriginalPut; }
  const afterFailure = await storageModule.readPersonalData();
  check(JSON.stringify(afterFailure) === JSON.stringify(stable), 'quota failure rolls back both settings and vocabulary, and stale revisions or generations are rejected');
  const sameRevisionNewLibrary = { ...stable.library, albums: [...stable.library.albums, { id: 'replacement-generation-album', title: 'New after clear' }] };
  await storageModule.write('library-v2', sameRevisionNewLibrary);
  await assert.rejects(storageModule.commitPersonalData(stable.library, stable.vocabulary, { expectedLibraryRevision: stable.library.revision, expectedVocabularyRevision: stable.vocabulary.revision, expectedGeneration: stable.vocabulary.generation, expectedLibrary: stable.library }));
  check((await library()).albums.some(album => album.id === 'replacement-generation-album'), 'restore rejects different library content even when a clear-and-recreate cycle reuses the revision number');
  await storageModule.write('library-v2', stable.library);
  let sharedBackup;
  context.File = File;
  context.navigator.canShare = ({ files }) => files.length === 1 && files[0].name.endsWith('.json');
  context.navigator.share = async ({ files }) => { sharedBackup = JSON.parse(await files[0].text()); };
  click('share-backup'); await until(() => $('action-dialog').open && $('dialog-title').textContent === '備份已準備好', 'share backup prepared'); await confirm();
  check(sharedBackup.vocabulary.words.length === 3 && !sharedBackup.library && !sharedBackup.translations, 'share flow prepares the same text-only JSON and waits for the explicit system-share action');
  $('setting-subtitles').value = 'normal'; submit('settings-form');
  await until(async () => (await library()).settings.subtitleSize === 'normal', 'change preference before settings restore');
  Object.defineProperty($('restore-backup'), 'files', { configurable: true, value: [exportedBlob] }); $('restore-backup').dispatchEvent(event('change'));
  await until(() => $('action-dialog').open && $('restore-settings'), 'settings restore preview'); $('restore-settings').checked = true; await confirm();
  check((await library()).settings.subtitleSize === exported.settings.subtitleSize && $('setting-subtitles').value === exported.settings.subtitleSize, 'opting in restores validated settings along with vocabulary without restoring albums');
  holdWordLookups = true; click('add-word'); $('new-word').value = 'delayed'; await confirm();
  await until(() => heldWordLookups.length === 2, 'both API responses held after initial word persistence');
  click('clear-data'); await until(() => $('dialog-title').textContent === '清除全部收藏與資料？' && $('action-dialog').open, 'clear during lookup confirmation'); await confirm();
  for (const release of heldWordLookups) release(); await delay(30);
  check(!(await words()) && !(await library()) && !(await storageModule.entries('translation:')).length, 'clearing all data cancels lookups and late API responses cannot resurrect words or translation caches');

  // Formal guide workflow: only synthetic fixtures enter the mocked provider.
  const vault = (await load(new URL(`../public/key-vault.mjs?v=${version}`, import.meta.url).href)).namespace;
  const guideModule = (await load(new URL(`../public/guide.mjs?v=${version}`, import.meta.url).href)).namespace;
  const fixtureKey = 'fixture_only_invalid_key_000000000000';
  $('gemini-key').value = fixtureKey; click('save-gemini-key');
  check($('gemini-key').value === '', 'saving a Key immediately clears the input');
  await until(async () => !!await storageModule.read('gemini-key-v1') && !$('remove-gemini-key').disabled, 'encrypted Key saved');
  const encrypted = await storageModule.read('gemini-key-v1');
  check(encrypted.cryptoKey.extractable === false && await vault.decryptApiKey(encrypted) === fixtureKey && geminiCalls.length === 0 && !JSON.stringify(encrypted).includes(fixtureKey), 'IndexedDB retains a decryptable nonextractable CryptoKey and ciphertext without calling Google on save');
  click('verify-gemini-key'); await until(() => geminiCalls.length === 1 && !$('verify-gemini-key').disabled, 'saved Key verification');
  check(geminiCalls[0].body.contents[0].parts[0].text === 'Please reply with OK.', 'saved Key verifies with a fixed short prompt only');
  click('create-album'); $('edit-title').value = 'Guide fixtures'; await confirm();
  const guideAlbum = (await library()).albums[0].id;
  mixedTranscript = wordTranscript = partialTranscript = missingModelStart = holdWorker = failWorker = false; failWordLookups = false; holdWordLookups = false; fixtureSeconds = 4; fixtureMillis = 4000;
  const guideImport = async name => {
    fixtureName = name; $('source-url').value = sourceLink; submit('import-form');
    await until(() => $('action-dialog').open && $('destination-album'), 'guide fixture placement');
    $('destination-album').value = guideAlbum; $('destination-album').dispatchEvent(event('change')); await confirm();
    return (await library()).tracks.find(track => track.title === name);
  };
  const guidedTrack = await guideImport('Guided episode');
  await delay(40);
  check(geminiCalls.length === 1 && !await storageModule.read(`guide:${guidedTrack.id}`) && (await library()).settings.autoGuide === false && !$('setting-auto-guide'), 'imports never generate guides automatically and the automatic setting is removed');
  const openGuided = async () => { [...$('playlist-tracks').querySelectorAll('.track-main')].find(row => row.textContent.includes(guidedTrack.title)).dispatchEvent(event('click')); await until(() => $('player').open && $('player-title').textContent === guidedTrack.title && !audio.paused, 'guided playback'); };
  await openGuided();
  check($('resume-card').hidden && !$('resume-card').children.length && !$('mini-player').hidden, 'the active top playback bar hides the duplicate resume card');
  const beforeMediaRetry = mediaLoads, retrySource = audio.src;
  const storedBeforeRecovery = await storageModule.read(`audio:${guidedTrack.id}`);
  mediaReady = 0; audio.error = { code: 4 }; audio.dispatchEvent(event('error'));
  await until(() => mediaLoads === beforeMediaRetry + 1, 'stored Blob rehydrated');
  const recoveredBytes = await (await fetch(audio.src)).arrayBuffer();
  check(audio.src !== retrySource && !audio.paused && Buffer.from(recoveredBytes).equals(Buffer.from(await storedBeforeRecovery.arrayBuffer())), 'one recovery uses a fresh local Blob URL with exactly the original audio bytes');
  check(await storageModule.read(`audio:${guidedTrack.id}`) === storedBeforeRecovery || (await storageModule.read(`audio:${guidedTrack.id}`)).size === storedBeforeRecovery.size, 'media recovery retains the saved audio');
  audio.dispatchEvent(event('error')); await delay(20);
  check(mediaLoads === beforeMediaRetry + 1, 'a repeated media error cannot trigger an unbounded reload');
  audio.pause(); audio.dispatchEvent(event('error')); await delay(20);
  check(mediaLoads === beforeMediaRetry + 1 && audio.paused, 'a user pause prevents media recovery from resuming playback');
  // A new selection permits one recovery, but a pause while bytes are pending
  // must cancel it before creating a URL or calling play/load again.
  mediaReady = 0; audio.error = null; await openGuided();
  const arrayBuffer = Blob.prototype.arrayBuffer; let releaseRecovery;
  Blob.prototype.arrayBuffer = function() { return new Promise(resolve => { releaseRecovery = async () => resolve(await arrayBuffer.call(this)); }); };
  const pendingSource = audio.src, pendingLoads = mediaLoads;
  mediaReady = 0; audio.error = { code: 4 }; audio.dispatchEvent(event('error'));
  await until(() => releaseRecovery, 'recovery bytes pending');
  audio.pause(); await releaseRecovery(); Blob.prototype.arrayBuffer = arrayBuffer; await delay(30);
  check(audio.src === pendingSource && mediaLoads === pendingLoads && audio.paused, 'pausing during asynchronous recovery prevents source replacement and playback');
  for (const action of ['player-stop', 'mini-dismiss']) {
    audio.pause(); mediaReady = 0; audio.error = null; await openGuided();
    let releaseBytes;
    Blob.prototype.arrayBuffer = function() { return new Promise(resolve => { releaseBytes = async () => resolve(await arrayBuffer.call(this)); }); };
    audio.error = { code: 4 }; audio.dispatchEvent(event('error'));
    await until(() => releaseBytes, 'recovery pending before ' + action);
    click(action);
    const loadsAfterAction = mediaLoads, sourceAfterAction = audio.src;
    await releaseBytes(); Blob.prototype.arrayBuffer = arrayBuffer; await delay(30);
    check(audio.paused && audio.src === sourceAfterAction && mediaLoads === loadsAfterAction, action + ' cancels pending recovery without late playback or URL replacement');
  }
  mediaReady = 1; audio.error = null; await openGuided();
  mediaReady = 1; audio.error = null; audio.onloadedmetadata?.(); click('player-play');
  click('toggle-guide'); await until(() => !$('generate-guide').disabled, 'manual generation ready');
  check($('guide-status').textContent.includes('尚未產生') && $('guide-help').hidden, 'missing guide has a compact status without a standing explanation');
  holdGuides = true; click('generate-guide'); click('generate-guide');
  await until(() => heldGuides.length === 1, 'manual guide waiting');
  check($('guide-panel').dataset.state === 'running' && /（\d+ 秒）/u.test($('guide-status').textContent) && $('generate-guide').disabled && !$('cancel-guide').hidden && $('guide-state-label').textContent.includes('…'), 'a manual request immediately shows progress and prevents duplicate clicks');
  const firstGuideSeconds = Number($('guide-status').textContent.match(/（(\d+) 秒）/u)[1]);
  await delay(1100);
  check(Number($('guide-status').textContent.match(/（(\d+) 秒）/u)[1]) > firstGuideSeconds, 'waiting status advances its elapsed seconds without another request');
  heldGuides.shift()(); holdGuides = false;
  await until(async () => (await storageModule.read(`guide:${guidedTrack.id}`))?.status === 'ready' && !$('generate-guide').disabled, 'manual guide persisted');
  check(geminiCalls.length === 2 && geminiCalls[1].body.contents[0].parts[0].text === guideModule.transcriptText(guidedTrack) && $('guide-status').textContent.includes('已完成') && $('guide-state-label').textContent.includes('✓'), 'exactly one manual request saves the full transcript guide and visibly reports completion');
  await until(() => $('guide-content').querySelector('.guide-save-word'), 'saved guide displayed');
  check(!$('guide-panel').hidden && $('subtitles-panel').hidden && $('guide-content').textContent.includes('熟悉的') && geminiCalls.length === 2, 'opening a saved guide renders local content without a second request');
  const translationsBeforeGuideWord = translated, dictionaryBeforeGuideWord = dictionaryWords.length;
  check($('guide-content').querySelector('.guide-route strong')?.textContent === '旅途中的觀察' && !$('guide-content').querySelector('.guide-intro'), 'expanded roadmap renders as the main guide with no duplicate introduction');
  $('guide-content').querySelector('.guide-save-word').dispatchEvent(event('click'));
  await until(async () => (await words())?.words.some(word => word.word === 'familiar'), 'guide word collection');
  const collected = (await words()).words.find(word => word.word === 'familiar');
  check(collected.translation === '熟悉的' && collected.translationSource === 'gemini' && collected.note.includes(fixtureSentence) && translated === translationsBeforeGuideWord && dictionaryWords.length === dictionaryBeforeGuideWord && geminiCalls.length === 2, 'guide collection retains meaning, attribution and original quote without extra API calls');
  failGuides = true; click('generate-guide');
  await until(async () => (await storageModule.read(`guide:${guidedTrack.id}`))?.status === 'failed' && !$('generate-guide').disabled, 'manual regeneration failure');
  await delay(40);
  check(geminiCalls.length === 3 && $('guide-content').textContent.includes('熟悉的') && $('guide-status').textContent.includes('額度') && $('guide-status').textContent.includes('未完成') && $('guide-state-label').textContent.includes('!'), 'quota failure stays visible inside the player, preserves the saved guide and never retries automatically');
  failGuides = false; click('generate-guide');
  await until(async () => (await storageModule.read(`guide:${guidedTrack.id}`))?.status === 'ready' && !$('generate-guide').disabled, 'explicit manual guide retry');
  const successfulGuideCalls = geminiCalls.length;
  check(successfulGuideCalls === 4, 'explicit retry makes one request and replaces the saved guide only after success');
  click('toggle-subtitles'); check($('guide-panel').hidden && !$('subtitles-panel').hidden, 'subtitle and guide panels are mutually exclusive');
  click('playback-repeat'); await until(async () => (await library()).settings.repeatMode === 'track', 'single repeat enabled');
  audio.currentTime = 4; audio.dispatchEvent(event('ended'));
  await until(() => audio.currentTime === 0 && !audio.paused, 'single track restarts');
  check($('player-title').textContent === guidedTrack.title && $('repeat-label').textContent === '單曲', 'single repeat restarts the current audio from zero');
  click('player-close'); await delay(10); audio.currentTime = 1.2; click('mini-dismiss');
  await until(async () => $('mini-player').hidden && (await storageModule.read('player-v2')) === null, 'top player dismissed');
  const staleSnapshot = { sessionId: 'old-session', trackId: guidedTrack.id, position: 3, queue: [guidedTrack.id], speed: 1 };
  check(audio.paused && (await storageModule.read(`progress:${guidedTrack.id}`)).position === 1.2 && !(await storageModule.savePlayer(staleSnapshot)) && await storageModule.read('player-v2') === null, 'dismiss stops playback, retains per-track position and rejects late progress resurrection');
  check(!$('resume-card').hidden && $('resume-card').textContent.includes(guidedTrack.title) && (await storageModule.read('last-listened-v1')).trackId === guidedTrack.id, 'dismissing the top player shows one resume card with a persisted nonplaying bookmark');
  document.querySelector('[data-tab="vocabulary"]').dispatchEvent(event('click'));
  check($('view-playlist').hidden && !$('resume-card').hidden, 'resume cards belong to the playlist even when another tab is selected');
  document.querySelector('[data-tab="playlist"]').dispatchEvent(event('click'));
  check(!$('view-playlist').hidden && !$('resume-card').hidden, 'returning to the playlist makes the saved resume card available');
  $('resume-card').querySelector('.round-button').dispatchEvent(event('click'));
  await until(() => $('player').open && !audio.paused, 'resume card playback');
  check(audio.currentTime === 1.2 && $('resume-card').hidden, 'the resume card reopens the saved position and hides itself while the top bar is active');
  click('player-close'); await delay(10); holdGuides = true;
  const legacyAutomatic = await library();
  await storageModule.write('library-v2', { ...legacyAutomatic, settings: { ...legacyAutomatic.settings, autoGuide: true } });
  await delay(40);
  const queuedTrack = await guideImport('Held guide');
  await delay(40);
  check(geminiCalls.length === successfulGuideCalls && !await storageModule.read(`guide:${queuedTrack.id}`), 'a legacy automatic preference cannot upload a new episode transcript');
  [...$('playlist-tracks').querySelectorAll('.track-main')].find(row => row.textContent.includes(queuedTrack.title)).dispatchEvent(event('click'));
  await until(() => $('player').open && !audio.paused, 'manual guide track opened'); click('toggle-guide');
  await until(() => !$('generate-guide').disabled, 'manual guide available'); click('generate-guide');
  await until(() => heldGuides.length === 1, 'second guide held');
  const sourceForHeld = guideModule.transcriptText(queuedTrack), fingerprintForHeld = await guideModule.guideFingerprint(sourceForHeld);
  const claimContext = { source: sourceForHeld, fingerprint: fingerprintForHeld, keyId: encrypted.id, model: 'gemini-3.5-flash-lite', requestId: 'another-tab' };
  const competing = await storageModule.updateGuide(queuedTrack.id, { ...claimContext, action: 'claim' });
  check(!competing.changed && geminiCalls.length === successfulGuideCalls + 1, 'atomic guide claim prevents another tab from starting a duplicate request');
  click('remove-gemini-key'); await until(async () => !await storageModule.read('gemini-key-v1') && !$('save-gemini-key').disabled, 'Key removed');
  heldGuides.shift()(); await delay(60); holdGuides = false;
  check((await storageModule.read(`guide:${queuedTrack.id}`)).status === 'failed' && !(await storageModule.read(`guide:${queuedTrack.id}`)).content && (await storageModule.read(`guide:${guidedTrack.id}`)).status === 'ready', 'Key removal rejects a late response and preserves already saved guides');
  await openGuided(); click('toggle-guide'); await until(() => $('guide-content').querySelector('.guide-save-word'), 'saved guide without Key');
  check($('generate-guide').disabled && $('guide-help').textContent.includes('API Key') && $('guide-content').textContent.includes('熟悉的') && geminiCalls.length === successfulGuideCalls + 1, 'missing Key has a visible reason while offline guides remain readable');
  click('player-close'); await delay(10);
  const backupModule = (await load(new URL(`../public/backup.mjs?v=${version}`, import.meta.url).href)).namespace;
  const safeBackup = await (await backupModule.personalBackup((await library()).settings, await words())).text();
  check(!safeBackup.includes(fixtureKey) && !safeBackup.includes('cryptoKey') && !safeBackup.includes('ciphertext') && !safeBackup.includes('guide:'), 'personal backup excludes credentials, encryption keys and guide records');
  const generationBeforeClear = await storageModule.dataGeneration();
  click('clear-data'); await until(() => $('action-dialog').open, 'guide data clearing confirmation'); await confirm();
  await assert.rejects(storageModule.setGeminiKey(encrypted, generationBeforeClear));
  check(!(await storageModule.read('gemini-key-v1')) && !(await storageModule.entries('guide:')).length && !$('save-gemini-key').disabled, 'clear deletes all guides and credentials, blocks stale encrypted saves and restores setup controls');
  // Isolated transaction checks after the interactive flow has cleared its data.
  const isolatedLibrary = { schema: 2, revision: 1, settings: { autoGuide: true }, albums: [{ id: guideAlbum }], tracks: [guidedTrack] };
  await storageModule.write('library-v2', isolatedLibrary);
  await storageModule.setGeminiKey(encrypted, await storageModule.dataGeneration());
  const isolatedContext = { source: guideModule.transcriptText(guidedTrack), fingerprint: await guideModule.guideFingerprint(guideModule.transcriptText(guidedTrack)), keyId: encrypted.id, model: 'gemini-3.5-flash-lite' };
  const claims = await Promise.all(['first', 'second'].map(requestId => storageModule.updateGuide(guidedTrack.id, { ...isolatedContext, requestId, action: 'claim' })));
  check(claims.filter(result => result.changed).length === 1, 'concurrent IndexedDB transactions acquire exactly one guide claim');
  const ownedId = claims.find(result => result.changed).record.request.id;
  await storageModule.write('library-v2', { ...isolatedLibrary, tracks: [{ ...guidedTrack, segments: [{ start: 0, end: 4, text: 'Changed transcript.' }] }] });
  check(!(await storageModule.updateGuide(guidedTrack.id, { ...isolatedContext, requestId: ownedId, action: 'complete', content: {} })).changed, 'changed source rejects an old in-flight guide completion');
  const changedSource = 'Changed transcript.';
  check((await storageModule.updateGuide(guidedTrack.id, { ...isolatedContext, source: changedSource, fingerprint: await guideModule.guideFingerprint(changedSource), requestId: 'new-source', action: 'claim' })).changed, 'a newly saved transcript can acquire a guide claim without waiting for the obsolete source lease');
  await storageModule.write('library-v2', isolatedLibrary);
  await storageModule.write('last-listened-v1', { trackId: guidedTrack.id });
  await storageModule.commitLibrary({ ...isolatedLibrary, tracks: [], revision: 2 }, { expectedRevision: 1, removeIds: [guidedTrack.id] });
  check(!await storageModule.read('last-listened-v1'), 'removing the bookmarked episode deletes its resume bookmark in the same transaction');
  check(!(await storageModule.updateGuide(guidedTrack.id, { ...isolatedContext, requestId: ownedId, action: 'complete', content: {} })).changed && !await storageModule.read(`guide:${guidedTrack.id}`), 'episode deletion atomically deletes its guide and rejects late completion');
  await storageModule.clear();
  console.log(JSON.stringify({ status: 'UI_AND_IDB_SIMULATION_PASS', assertions, externalModuleHosts: [...requests], renderer: 'none; not browser or iPhone verification' }, null, 2));
} catch (error) {
  console.error(error.stack ?? error);
  if (context.document) console.error(JSON.stringify({ translationHidden: context.document.getElementById('translation-panel')?.hidden, translationStatus: context.document.getElementById('translation-status')?.textContent, settingsStatus: context.document.getElementById('settings-message')?.textContent, globalStatus: context.document.getElementById('global-message')?.textContent }));
  process.exitCode = 1;
}
finally { for (const timer of timers) clearTimeout(timer); }
