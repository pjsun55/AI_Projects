// Interaction + IndexedDB simulation, NOT a rendered browser/iPhone test.
// Uses public pinned DOM/IDB implementations in memory, without installation.
// node --experimental-vm-modules tools/ui-smoke.mjs
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
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
  const audio = $('audio'); let paused = true;
  Object.defineProperties(audio, { paused: { get: () => paused }, src: { get() { return this.getAttribute('src') || ''; }, set(value) { this.setAttribute('src', value); } }, readyState: { get: () => 1 } });
  audio.currentTime = 0; audio.playbackRate = 1;
  audio.play = async () => { paused = false; audio.dispatchEvent(event('play')); };
  audio.pause = () => { if (!paused) { paused = true; audio.dispatchEvent(event('pause')); } };
  audio.load = () => { audio.currentTime = 0; };
  const fakeCaches = new Map([['commute-lingo-models-v1', true], ['another-app-models', true], ['commute-lingo-shell-0.2.9-r1', true]]);
  const location = { href: 'https://example.test/commute-lingo/?v=0.2.9', hash: '' };
  const screen = { width: 393, height: 852, orientation: { type: 'portrait-primary', addEventListener() {} } };
  const fixtureSentence = 'While the train moves through the city and the morning sun fills the windows, I listen to a familiar story and notice the expressions I missed yesterday, then I repeat a useful sentence quietly and save the lesson for another journey.';
  const translatedTexts = [];
  let fixtureName = 'A short test episode', fixtureMillis = 4000, fixtureSeconds = 4, partialTranscript = false, holdWorker = false, failWorker = false, mediaDownloads = 0, translated = 0;
  const runtimeFetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'itunes.apple.com') return Response.json({ results: [{ trackId: 1000796641961, trackName: fixtureName, collectionName: 'Public fixture', trackTimeMillis: fixtureMillis, episodeUrl: 'https://media.example.com/fixture.wav' }] });
    if (url.hostname === 'media.example.com') { mediaDownloads++; return new Response(new Blob(['wav fixture'], { type: 'audio/wav' })); }
    if (url.hostname === 'api.mymemory.translated.net') { translated++; translatedTexts.push(url.searchParams.get('q')); return Response.json({ responseStatus: 200, responseData: { translatedText: '每段旅程都會帶來新的發現。' } }); }
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
    postMessage() { schedule(() => this.onmessage?.({ data: failWorker ? { type: 'error', message: 'Simulated inference failure' } : { type: 'complete', processedSeconds: fixtureSeconds, chunks: [{ timestamp: [0, 2], text: fixtureSentence + ' We learn one idea at a time.' }, ...partialTranscript ? [] : [{ timestamp: [2, fixtureSeconds], text: 'Listen and learn along the way.' }]], metrics: {} } }), holdWorker ? 60000 : 10); }
    terminate() { this.onmessage = null; }
  }
  Object.assign(context, { document, window, location, history: { replaceState(_, __, hash) { location.hash = hash; } }, screen, matchMedia: () => ({ matches: true }), navigator: { storage: { estimate: async () => ({ usage: 1024, quota: 1000000000 }), persisted: async () => false, persist: async () => false }, mediaSession: { setActionHandler() {}, setPositionState() {} } }, caches: { keys: async () => [...fakeCaches.keys()], delete: async key => fakeCaches.delete(key) }, indexedDB: fake.namespace.indexedDB, IDBKeyRange: fake.namespace.IDBKeyRange, Audio: Probe, OfflineAudioContext: Context, Worker, fetch: runtimeFetch });
  await evaluate(await load(new URL('../public/app.mjs?v=0.2.9', import.meta.url).href));
  const storageModule = (await load(new URL('../public/storage.mjs?v=0.2.9', import.meta.url).href)).namespace;
  const library = () => storageModule.read('library-v2');
  const click = id => $(id).dispatchEvent(event('click'));
  const submit = id => $(id).dispatchEvent(event('submit'));
  const confirm = async () => { submit('dialog-form'); await until(() => !$('action-dialog').open || $('dialog-error').textContent, 'dialog saved or error'); if ($('dialog-error').textContent) throw new Error($('dialog-error').textContent); };
  await until(() => !$('start-import').disabled, 'app boot');
  check($('setting-minutes').value === '25', 'new libraries default to 25 minutes');
  check($('view-playlist').hidden === false && $('subtitles-panel').hidden, 'playlist opens with subtitles off');
  check(!document.querySelector('input[type=file]'), 'manual file import is absent');
  check(!$('icon-options') && $('brand-icon').getAttribute('src').includes('sunrise') && $('gemini-key').disabled, 'fixed orange identity has no appearance switcher and Gemini remains inactive');
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
  await until(() => $('import-message').textContent.includes('Simulated inference failure'), 'model error displayed');
  check(!$('action-dialog').open && !$('start-import').disabled && (await library()).tracks.length === 0, 'inference error stops the pipeline, reports error and permits retry');
  failWorker = false;
  async function importTrack(name, replace = '') {
    fixtureName = name; $('source-url').value = sourceLink; submit('import-form');
    await until(() => $('action-dialog').open && $('destination-album'), 'automatic download and ASR reaches album selection');
    $('destination-album').value = albumId; $('destination-album').dispatchEvent(event('change'));
    if (replace) $('replace-track').value = replace;
    await confirm();
  }
  await importTrack('First episode');
  check(mediaDownloads === 2 && (await library()).tracks.length === 1, 'one submit automatically downloads, decodes, transcribes and saves');
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
  playRow.dispatchEvent(event('click')); await until(() => $('player').open && !audio.paused, 'track playback');
  check($('subtitles-panel').hidden, 'opening a new track keeps subtitles hidden');
  click('toggle-subtitles'); check(!$('subtitles-panel').hidden && $('subtitle-list').children.length === 2, 'subtitle toggle displays timeline-aligned sentences');
  check($('player').classList.contains('subtitles-open') && $('toggle-subtitles').getAttribute('aria-pressed') === 'true', 'opening subtitles enters the expanded reading layout');
  const beforeLayoutToggle = { time: audio.currentTime, speed: audio.playbackRate, paused: audio.paused, source: audio.src };
  click('toggle-subtitles');
  check($('subtitles-panel').hidden && !$('player').classList.contains('subtitles-open') && audio.currentTime === beforeLayoutToggle.time && audio.playbackRate === beforeLayoutToggle.speed && audio.paused === beforeLayoutToggle.paused && audio.src === beforeLayoutToggle.source, 'closing the reading layout restores normal mode without changing playback');
  click('toggle-subtitles');
  const cue = $('subtitle-list').children[0].querySelector('.sentence-text');
  check($('subtitle-list').children[0].querySelectorAll('.sentence-text').length === 2 && cue.children.length > 1 && cue.textContent === fixtureSentence, 'sentences sharing a timestamp have separate cards; long clause breaks preserve every original character');
  cue.dispatchEvent(event('pointerdown', { button: 0, clientX: 10, clientY: 10 }));
  await until(() => !$('translation-panel').hidden && $('translation-text').textContent, 'long-press translation');
  check(audio.paused && translated === 1, 'long press pauses playback and translates the selected sentence');
  check(translatedTexts[0] === fixtureSentence && $('translation-original').textContent === fixtureSentence && cue.classList.contains('translating') && !cue.nextElementSibling.classList.contains('translating'), 'long-pressing any clause translates and marks only its complete sentence');
  cue.dispatchEvent(event('click'));
  check(audio.paused && !$('translation-panel').hidden, 'the click after a long press never seeks or resumes playback');
  const translationModule = (await load(new URL('../public/translation.mjs?v=0.2.9', import.meta.url).href)).namespace;
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
  await openRepairTrack();
  check(!$('transcript-notice').hidden && $('transcript-status').textContent.includes('00:02') && $('transcript-status').textContent.includes('02:00'), 'partial subtitles show actual caption coverage and full audio duration');
  audio.currentTime = 60; audio.dispatchEvent(event('timeupdate'));
  check($('transcript-status').textContent.includes('目前播放位置沒有已確認的字幕'), 'seeking beyond available captions explains missing data instead of pretending more captions will appear');
  failWorker = true; click('regenerate-subtitles');
  await until(() => $('import-message').textContent.includes('Simulated inference failure'), 'failed saved-audio repair');
  check((await library()).revision === repairBefore.revision && !!await storageModule.read(`audio:${repairTrack.id}`), 'failed regeneration preserves saved audio and original subtitle revision');
  failWorker = false; holdWorker = true; await openRepairTrack(); click('regenerate-subtitles');
  await until(() => document.querySelector('[data-stage="transcribe"]').classList.contains('current') && !$('cancel-import').hidden, 'saved-audio repair enters model stage');
  click('cancel-import'); await delay(20);
  check((await library()).revision === repairBefore.revision && (await library()).tracks[0].segments.at(-1).end === 2, 'cancelling regeneration retains the original subtitles');
  holdWorker = false; partialTranscript = false; await openRepairTrack(); click('regenerate-subtitles');
  await until(async () => (await library()).tracks[0].segments.at(-1).end === 120 && $('player').open, 'successful regeneration commits complete captions');
  const repaired = (await library()).tracks[0];
  check(mediaDownloads === downloadsBeforeRepair && repaired.id === repairTrack.id && repaired.albumId === repairTrack.albumId && repaired.title === repairTrack.title && !!await storageModule.read(`audio:${repairTrack.id}`), 'successful regeneration reuses saved audio and preserves its identity, title and album without downloading');
  audio.currentTime = 60; audio.dispatchEvent(event('timeupdate')); click('toggle-subtitles');
  check($('transcript-notice').hidden && $('subtitle-list').children[1].getAttribute('aria-current') === 'true', 'new captions are immediately available past the former cutoff');
  console.log(JSON.stringify({ status: 'UI_AND_IDB_SIMULATION_PASS', assertions, externalModuleHosts: [...requests], renderer: 'none; not browser or iPhone verification' }, null, 2));
} catch (error) {
  console.error(error.stack ?? error);
  if (context.document) console.error(JSON.stringify({ translationHidden: context.document.getElementById('translation-panel')?.hidden, translationStatus: context.document.getElementById('translation-status')?.textContent, settingsStatus: context.document.getElementById('settings-message')?.textContent, globalStatus: context.document.getElementById('global-message')?.textContent }));
  process.exitCode = 1;
}
finally { for (const timer of timers) clearTimeout(timer); }
