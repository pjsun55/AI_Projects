// CI only: use this app's locked Playwright dependency. No Mac install.
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { seedFixture } from './browser-fixture.mjs';
import { runUpdateBrowser } from './update-browser.mjs';
import { runReadingBrowser } from './reading-browser.mjs';
import { runResponsiveBrowser } from './responsive-browser.mjs';
import { runVocabularyBrowser } from './vocabulary-browser.mjs';
import { runGuideBrowser } from './guide-browser.mjs';
import { createServer } from './server.mjs';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const basePath = '/AI_Projects/commute-lingo/';
const server = await createServer({ basePath });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}${basePath}?v=${version}`;
const output = new URL('../.tmp/browser-results/', import.meta.url); await mkdir(output, { recursive: true });
const failures = [];
const translationFixture = '這是公開的版面測試資料。'.repeat(100);
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = name === 'webkit' ? null : await engine.launch();
    try {
      for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }, { width: 800, height: 1280 }, { width: 1280, height: 800 }]) {
        // WebKit's ephemeral data store rejects IndexedDB Blobs. Exercise the
        // ordinary persistent storage path using a fresh CI-only profile.
        // Profiles stay outside browser-results and are never uploaded.
        // WebKit cannot route SW-owned requests. Keep its layout/API fixture
        // test isolated; real SW/offline behavior is exercised in Chromium.
        const options = { viewport, isMobile: true, hasTouch: true, serviceWorkers: name === 'webkit' ? 'block' : 'allow' };
        const context = name === 'webkit'
          ? await engine.launchPersistentContext(await mkdtemp(new URL('../.tmp/webkit-profile-', import.meta.url).pathname), options)
          : await browser.newContext(options);
        const page = await context.newPage(), errors = [];
        let phase = 'fixture-storage', offlineState, layoutState, sourceControlState, mockedTranslations = 0;
        try {
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
          window.__mediaEvents = [];
          for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'ended', 'error', 'abort', 'emptied']) {
            document.addEventListener(type, event => {
              if (event.target?.id !== 'audio') return;
              const audio = event.target;
              window.__mediaEvents.push({ type, paused: audio.paused, ready: audio.readyState, time: audio.currentTime, error: audio.error?.code });
              if (window.__mediaEvents.length > 20) window.__mediaEvents.shift();
            }, true);
          }
        });
        await context.route('**/*', route => {
          const target = new URL(route.request().url());
          if (target.origin === origin) return route.continue();
          if (target.hostname === 'api.mymemory.translated.net') {
            mockedTranslations++;
            return route.fulfill({ json: { responseStatus: 200, responseData: { translatedText: translationFixture } } });
          }
          if (target.hostname === 'freedictionaryapi.com') {
            return route.fulfill({ json: { word: decodeURIComponent(target.pathname.split('/').at(-1)), source: { license: { name: 'CC BY-SA 4.0' } }, entries: [{ language: { code: 'en' }, partOfSpeech: 'noun', pronunciations: [{ type: 'ipa', text: '/test/' }], senses: [{ definition: 'A public fixture definition.' }] }] } });
          }
          return route.abort(); // No private data or fixture audio leaves CI.
        });
        await page.goto(url);
        await page.waitForFunction(() => !document.getElementById('start-import').disabled);
        await page.evaluate(seedFixture, { version });
        await page.reload();
        await page.waitForFunction(() => !document.getElementById('start-import').disabled && document.querySelector('#playlist-tracks .track-main'));
        await expect(page.locator('#landscape-gate')).toBeHidden();
        if (Math.min(viewport.width, viewport.height) >= 600) {
          assert.ok(await page.locator('.app-shell').evaluate(element => element.getBoundingClientRect().width > 480), 'Tablet content must use the available width');
        }
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '20px');
        assert.ok(Math.abs(await page.locator('#playlist-title').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) - 35.2) < 0.05, 'Large headings must retain their original size');
        for (const tab of ['playlist', 'library', 'vocabulary', 'import', 'settings']) {
          await page.locator(`[data-tab="${tab}"]`).click();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tab}: enlarged interface must fit portrait width`);
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-${tab}-ui125.png`, output).pathname });
        }
        await expect(page.locator('#setting-minutes')).toHaveValue('25');
        await expect(page.locator('#setting-minutes')).toHaveAttribute('max', '60');
        await page.locator('#setting-minutes').fill('60');
        await page.locator('#settings-form button[type=submit]').click();
        await expect(page.locator('#settings-message')).toHaveText('設定已儲存。');
        await page.reload();
        await expect(page.locator('#setting-minutes')).toHaveValue('60');
        await page.locator('[data-tab="import"]').click();
        phase = 'source-controls';
        const oldURL = 'https://podcasts.apple.com/example/id123?i=456&previous='.padEnd(300, 'x');
        await page.locator('#source-url').fill(oldURL);
        await expect(page.locator('#clear-source-url')).toBeEnabled();
        await expect.poll(async () => {
          sourceControlState = await page.locator('#clear-source-url').evaluate(element => {
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, transform: style.transform, scale: visualViewport?.scale ?? 1 };
          });
          return sourceControlState.width >= 44 && sourceControlState.height >= 44 && sourceControlState.left >= 0 && sourceControlState.right <= sourceControlState.viewport;
        }, { message: 'Source clear control must remain reachable beside a long URL' }).toBe(true);
        console.log(JSON.stringify({ browser: name, viewport, sourceControlState }));
        await page.locator('#clear-source-url').click();
        await expect(page.locator('#source-url')).toHaveValue('');
        await expect(page.locator('#source-url')).toBeFocused();
        await expect(page.locator('#clear-source-url')).toBeDisabled();
        await page.locator('#source-file').click();
        await expect(page.locator('#file-source')).toBeVisible();
        await expect(page.locator('#start-file-import')).toBeDisabled();
        await page.locator('#audio-file').setInputFiles({ name: `${'Public lesson '.repeat(10)}.wav`, mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVE') });
        await expect(page.locator('#start-file-import')).toBeEnabled();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Local file picker and long filename must fit portrait width');
        await page.screenshot({ path: new URL(`${name}-${viewport.width}-local-audio.png`, output).pathname });
        await page.locator('#clear-audio-file').click();
        await expect(page.locator('#audio-file')).toHaveValue('');
        await expect(page.locator('#start-file-import')).toBeDisabled();
        await page.locator('#source-podcast').click();
        await page.locator('[data-tab="settings"]').click();
        const scale = await page.evaluate(() => visualViewport?.scale ?? 1);
        for (const id of ['setting-minutes', 'setting-albums', 'setting-tracks', 'setting-subtitles', 'setting-language', 'setting-model']) {
          assert.ok(await page.locator(`#${id}`).evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16), `${id} needs readable text without focus zoom`);
        }
        await page.locator('#setting-minutes').fill('30');
        await page.locator('#settings-form button[type=submit]').click();
        await expect(page.locator('#settings-message')).toHaveText('設定已儲存。');
        assert.equal(await page.evaluate(() => document.activeElement?.id === 'setting-minutes'), false);
        assert.equal(await page.evaluate(() => visualViewport?.scale ?? 1), scale);
        await page.reload();
        await expect(page.locator('#setting-minutes')).toHaveValue('30');
        await page.locator('[data-tab="library"]').click();
        await page.locator('.edit-album').first().click();
        assert.ok(await page.locator('#edit-title').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16));
        await page.locator('#edit-title').fill('Renamed public fixture');
        await page.locator('#dialog-confirm').click();
        await expect(page.locator('#action-dialog')).not.toBeVisible();
        await page.locator('[data-tab="import"]').click();
        assert.ok(await page.locator('#source-url').evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16));
        phase = 'layout';
        for (const size of ['normal', 'large', 'xlarge']) {
          phase = `caption-layout-${size}`;
          await page.locator('[data-tab="settings"]').click();
          await page.locator('#setting-subtitles').selectOption(size);
          await page.locator('#settings-form button[type=submit]').click();
          await page.waitForFunction(() => document.getElementById('settings-message').textContent === '設定已儲存。');
          await page.locator('[data-tab="playlist"]').click();
          await page.locator('#playlist-tracks .track-main').first().click();
          phase = `episode-ready-${size}`;
          await page.waitForFunction(() => document.getElementById('player').open && !document.getElementById('audio').paused && document.getElementById('audio').readyState >= 2);
          await page.evaluate(() => document.getElementById('audio').pause());
          phase = `caption-layout-${size}`;
          await page.locator('#toggle-subtitles').click();
          const layout = await page.evaluate(() => {
            const sheet = document.getElementById('player'), list = document.getElementById('subtitle-list'), rect = sheet.getBoundingClientRect();
            const controls = ['player-close', 'player-menu', 'playback-range', 'previous-sentence', 'player-play', 'next-sentence', 'playback-speed', 'player-stop', 'playback-repeat', 'toggle-subtitles', 'toggle-guide', 'follow-subtitles'];
            return { top: rect.top, bottom: rect.bottom, height: innerHeight, listHeight: list.clientHeight, overflow: sheet.scrollHeight - sheet.clientHeight, artwork: getComputedStyle(document.getElementById('player-art')).display,
              controlsVisible: controls.every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= rect.top && r.bottom <= rect.bottom + 1 && r.left >= rect.left && r.right <= rect.right + 1; }) };
          });
          const captionFont = await page.locator('.sentence-text').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
          assert.ok(Math.abs(captionFont - { normal: 18.4, large: 22.4, xlarge: 27.2 }[size]) < 0.05, 'Interface scaling must preserve caption sizes');
          assert.ok(layout.top >= -1 && layout.bottom <= layout.height + 1, JSON.stringify({ name, viewport, size, layout }));
          assert.ok(layout.controlsVisible && layout.overflow <= 1 && layout.artwork === 'none', JSON.stringify({ name, viewport, size, layout }));
          assert.ok(layout.listHeight > (viewport.width > 360 ? viewport.height * 0.45 : 100), JSON.stringify({ name, viewport, size, layout }));
          await page.evaluate(() => { const audio = document.getElementById('audio'); audio.currentTime = 6.5; audio.dispatchEvent(new Event('timeupdate')); });
          await expect(page.locator('.subtitle-cue.active')).toHaveCount(1);
          await expect(page.locator('.subtitle-cue').nth(1)).toHaveAttribute('aria-current', 'true');
          const emphasis = await page.evaluate(() => {
            const active = document.querySelector('.subtitle-cue.active .sentence-text');
            const inactive = document.querySelector('.subtitle-cue:not(.active) .sentence-text');
            return { activeWeight: +getComputedStyle(active).fontWeight, inactiveWeight: +getComputedStyle(inactive).fontWeight, differentColors: getComputedStyle(active).color !== getComputedStyle(inactive).color };
          });
          assert.ok(emphasis.activeWeight <= 500 && emphasis.inactiveWeight <= 500 && emphasis.differentColors, JSON.stringify(emphasis));
          await page.evaluate(() => { const audio = document.getElementById('audio'); audio.currentTime = 0; audio.dispatchEvent(new Event('timeupdate')); });
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-${size}-captions.png`, output).pathname });
          // Keyboard translation reaches the same long-press action, using a fake service.
          await page.locator('.sentence-text').first().focus(); await page.keyboard.press('Enter');
          phase = `translation-layout-${size}`;
          await expect(page.locator('#translation-text')).toHaveText(translationFixture);
          assert.ok(mockedTranslations > 0, 'The translation fixture must be provided by the route, not the real service.');
          phase = `translation-native-play-${size}`;
          await page.locator('#audio').evaluate(async audio => {
            try { await audio.play(); } catch (error) { if (error.name !== 'AbortError') throw error; }
          });
          await expect(page.locator('#translation-panel')).toBeVisible();
          await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
          phase = `translation-layout-${size}`;
          // Require both complete fixture content and settled scroll geometry.
          // Poll the same layout requirements rather than sampling once.
          await expect.poll(async () => {
            layoutState = await page.evaluate(() => {
              const panel = document.getElementById('translation-panel'), sheet = document.getElementById('player'), list = document.getElementById('subtitle-list');
              return { bottom: panel.getBoundingClientRect().bottom, sheetBottom: sheet.getBoundingClientRect().bottom, captionHeight: list.clientHeight,
                scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, textLength: document.getElementById('translation-text').textContent.length,
                scrolls: panel.scrollHeight > panel.clientHeight, equalFonts: getComputedStyle(document.getElementById('translation-text')).fontSize === getComputedStyle(document.getElementById('translation-original')).fontSize };
            });
            return layoutState.bottom <= layoutState.sheetBottom + 1 && layoutState.captionHeight >= 40 && layoutState.scrolls && layoutState.equalFonts;
          }, { message: `${name} ${viewport.width} ${size}: long translation must scroll and preserve readable captions` }).toBe(true);
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-${size}-translation.png`, output).pathname });
          phase = `translation-original-audio-${size}`;
          const excerptSource = await page.locator('#audio').evaluate(audio => audio.src), translationsBeforeExcerpt = mockedTranslations;
          await page.locator('#translation-play').click();
          await page.waitForFunction(() => !document.getElementById('audio').paused && !document.getElementById('translation-panel').hidden);
          await expect(page.locator('#translation-play')).toHaveAttribute('aria-pressed', 'true');
          // Let the native media clock cross the real sentence boundary. The
          // excerpt must stop itself without a synthetic timeupdate event.
          await page.locator('#audio').evaluate(audio => { audio.currentTime = 5.9; });
          await page.waitForFunction(() => document.getElementById('audio').paused);
          assert.equal(await page.locator('#audio').evaluate(audio => audio.currentTime), 6);
          await expect(page.locator('#translation-panel')).toBeVisible();
          await page.locator('#translation-play').click();
          await page.waitForFunction(() => !document.getElementById('audio').paused);
          await page.locator('#translation-play').click();
          assert.equal(await page.locator('#audio').evaluate(audio => audio.paused && audio.src), excerptSource);
          assert.equal(mockedTranslations, translationsBeforeExcerpt);
          phase = `translation-close-resume-${size}`;
          await page.locator('#translation-close').click();
          await page.waitForFunction(() => document.getElementById('translation-panel').hidden && !document.getElementById('audio').paused);
          await page.evaluate(() => document.getElementById('audio').pause());
          phase = `cached-translation-${size}`;
          await page.locator('.sentence-text').first().focus(); await page.keyboard.press('Enter');
          await expect(page.locator('#translation-text')).toHaveText(translationFixture);
          await page.locator('#player-play').click();
          assert.equal(await page.locator('#translation-panel').isVisible(), false);
          await page.locator('#toggle-subtitles').click();
          assert.equal(await page.locator('#player-art').isVisible(), true);
          await page.locator('#player-close').click();
          console.log(JSON.stringify({ browser: name, viewport, subtitleSize: size, status: 'PASS', captionPixels: layout.listHeight }));
        }
        phase = 'available-output-persistence';
        const beforeAvailable = await page.evaluate(async version => {
          const storage = await import(`./storage.mjs?v=${version}`), library = await import(`./library.mjs?v=${version}`);
          const original = await storage.read(library.LIBRARY_KEY), audio = await storage.read('audio:fixture-track');
          let current = original;
          for (const track of [
            { id: 'fixture-audio-only', title: 'Audio-only public fixture', duration: 120, segments: [], transcriptStatus: 'audio-only', alignment: 'mixed-v1' },
            { id: 'fixture-partial', title: 'Partial public fixture', duration: 120, transcriptStatus: 'partial', alignment: 'mixed-v1', segments: [{ start: 0, end: 1, text: 'Aligned public words.' }, { start: 1, end: 2, text: 'Unaligned public words. More words.', timingUncertain: true }] }
          ]) {
            const next = { ...library.placeTrack(current, { ...track, size: audio.size, language: 'en' }, original.albums[0].id), revision: current.revision + 1 };
            await storage.commitLibrary(next, { expectedRevision: current.revision, audio: { id: track.id, blob: audio } }); current = next;
          }
          return original;
        }, version);
        await page.reload(); await page.locator('[data-tab="playlist"]').click();
        await page.locator('#playlist-tracks .track-main').filter({ hasText: 'Audio-only public fixture' }).click();
        await page.waitForFunction(() => !document.getElementById('audio').paused);
        await expect(page.locator('#toggle-subtitles')).toHaveAttribute('aria-label', '尚無字幕');
        await expect(page.locator('#transcript-notice')).toHaveCount(0);
        await page.locator('#toggle-subtitles').click();
        await expect(page.locator('#subtitle-list')).toContainText('目前尚無字幕');
        await page.locator('#player-close').click();
        await page.locator('#playlist-tracks .track-main').filter({ hasText: 'Partial public fixture' }).click();
        await page.locator('#toggle-subtitles').click();
        await expect(page.locator('#subtitle-list .subtitle-cue')).toHaveCount(2);
        await expect(page.locator('#toggle-subtitles')).toHaveAttribute('aria-label', '字幕未完整');
        await expect(page.locator('#transcript-notice')).toHaveCount(0);
        await expect(page.locator('#subtitle-list')).toContainText('時間範圍估計');
        assert.ok(await page.locator('#subtitle-list').evaluate(list => list.clientHeight >= 40), 'Partial transcript notices must leave room to read the subtitles.');
        await page.locator('#audio').evaluate(audio => { audio.pause(); audio.currentTime = 1.5; audio.dispatchEvent(new Event('timeupdate')); });
        await expect(page.locator('#subtitle-list .active')).toHaveCount(1);
        await page.locator('#player-close').click();
        await page.evaluate(async ({ version, original }) => {
          const storage = await import(`./storage.mjs?v=${version}`), current = await storage.read('library-v2');
          await storage.commitLibrary({ ...original, revision: current.revision + 1 }, { expectedRevision: current.revision, removeIds: ['fixture-audio-only', 'fixture-partial'] });
        }, { version, original: beforeAvailable });
        await page.reload();
        phase = 'vocabulary-and-personal-backup';
        const vocabularyOutput = new URL(`${name}-${viewport.width}-vocabulary/`, output); await mkdir(vocabularyOutput, { recursive: true });
        await runVocabularyBrowser(page, { version, output: vocabularyOutput, onPhase: value => { phase = value; } });
        const guideOutput = new URL(name + '-' + viewport.width + '-guide/', output); await mkdir(guideOutput, { recursive: true });
        await runGuideBrowser(page, { version, output: guideOutput, onPhase: value => { phase = value; } });
        const readingOutput = new URL(name + '-' + viewport.width + '-reading/', output); await mkdir(readingOutput, { recursive: true });
        await runReadingBrowser(page, { version, output: readingOutput, onPhase: value => { phase = value; } });
        if (Math.min(viewport.width, viewport.height) >= 600) {
          await runResponsiveBrowser(page, { viewport, output: readingOutput, onPhase: value => { phase = value; } });
        }
        if (name === 'chromium') {
          phase = 'offline-preconditions';
          // Cache readiness alone does not establish that this document is
          // controlled. Verify a real SW navigation before cutting the network.
          await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
          await page.waitForFunction(() => document.getElementById('offline-status').textContent.startsWith('頁面已可離線使用'));
          const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
          assert.equal(scope, origin + basePath);
          offlineState = await page.evaluate(async () => ({
            path: location.pathname + location.search + location.hash,
            controller: navigator.serviceWorker.controller?.state,
            cachedNavigation: !!(await caches.match(location.href)),
            cacheNames: await caches.keys()
          }));
          const controlledResponse = await page.reload();
          assert.equal(controlledResponse?.fromServiceWorker(), true, 'Online navigation must already be served by the service worker.');
          await page.waitForFunction(() => document.querySelector('#playlist-tracks .track-main'));
          offlineState = await page.evaluate(async () => ({
            path: location.pathname + location.search + location.hash,
            controller: navigator.serviceWorker.controller?.state,
            cachedNavigation: !!(await caches.match(location.href)),
            cacheNames: await caches.keys()
          }));
          assert.equal(offlineState.cachedNavigation, true, JSON.stringify(offlineState));
          // End the translation mock before this separate network test. The
          // browser offline flag now rejects every actual network request.
          await context.unrouteAll({ behavior: 'wait' });
          phase = 'offline-reload';
          await context.setOffline(true);
          const offlineResponse = await page.reload();
          assert.equal(offlineResponse?.fromServiceWorker(), true, 'Offline navigation must come from the service worker.');
          await page.waitForFunction(() => document.querySelector('#playlist-tracks .track-main'));
          for (const tab of ['settings', 'library', 'vocabulary', 'import', 'playlist']) {
            await page.locator(`[data-tab="${tab}"]`).click();
            const response = await page.reload();
            assert.equal(response?.fromServiceWorker(), true, `Offline ${tab} navigation must come from the service worker.`);
            await page.waitForFunction(() => !document.getElementById('start-import').disabled);
            assert.equal(new URL(page.url()).hash, `#${tab}`);
          }
          await page.waitForFunction(() => document.querySelector('#playlist-tracks .track-main'));
          const uncachedFailed = await page.evaluate(() => fetch('./index.html?uncached-offline-probe=1').then(() => false, () => true));
          assert.equal(uncachedFailed, true, 'An uncached network request must fail while offline.');
          await page.locator('#playlist-tracks .track-main').first().click();
          await page.locator('#toggle-guide').click();
          await expect(page.locator('.guide-save-word')).toHaveCount(1);
          await expect(page.locator('#generate-guide')).toBeDisabled();
          await expect(page.locator('#guide-status')).toContainText('可離線閱讀');
          await page.locator('#player-close').click(); await page.locator('#audio').evaluate(audio => audio.pause());
          console.log(JSON.stringify({ browser: name, offlineReload: 'PASS', scope }));
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: new URL(`${name}-${viewport.width}.png`, output).pathname });
        } catch (error) {
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-failure.png`, output).pathname }).catch(() => {});
          const mediaState = await page.evaluate(() => {
            const audio = document.getElementById('audio');
            return { paused: audio.paused, ended: audio.ended, ready: audio.readyState, network: audio.networkState, time: audio.currentTime, duration: audio.duration,
              error: audio.error?.code, errorMessage: audio.error?.message, sourceProtocol: audio.currentSrc.split(':')[0], translationHidden: document.getElementById('translation-panel').hidden,
              feedback: document.getElementById('player-feedback').textContent, events: window.__mediaEvents };
          }).catch(() => undefined);
          const fixtureState = await page.evaluate(async version => {
            const storage = await import(`./storage.mjs?v=${version}`), blob = await storage.read('audio:fixture-track');
            if (!(blob instanceof Blob)) return { missingAudio: true };
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const result = { size: blob.size, type: blob.type, byteLength: bytes.length, header: [...bytes.slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
            // Inspect only the known generated silent PCM fixture. Never probe
            // arbitrary saved audio or print its URL, bytes or transcript.
            if (bytes.length !== 120 * 32000 + 44 || blob.type !== 'audio/wav') return result;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
            const pcm = { riff: ascii(0, 4), riffSize: view.getUint32(4, true), wave: ascii(8, 4), fmt: ascii(12, 4), fmtSize: view.getUint32(16, true), format: view.getUint16(20, true), channels: view.getUint16(22, true), sampleRate: view.getUint32(24, true), byteRate: view.getUint32(28, true), blockAlign: view.getUint16(32, true), bits: view.getUint16(34, true), data: ascii(36, 4), dataSize: view.getUint32(40, true) };
            const expected = { riff: 'RIFF', riffSize: bytes.length - 8, wave: 'WAVE', fmt: 'fmt ', fmtSize: 16, format: 1, channels: 1, sampleRate: 16000, byteRate: 32000, blockAlign: 2, bits: 16, data: 'data', dataSize: bytes.length - 44 };
            if (JSON.stringify(pcm) !== JSON.stringify(expected) || !bytes.subarray(44).every(byte => byte === 0)) return { ...result, knownFixture: false };
            result.knownFixture = true; result.pcm = pcm;
            result.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
            // Diagnostic probes run only after the original assertion failed.
            // They cannot turn a failed scenario into a pass or retry playback.
            const probe = source => new Promise(resolve => {
              const audio = new Audio(); let settled = false;
              const finish = status => {
                if (settled) return; settled = true; clearTimeout(timer);
                const state = { status, ready: audio.readyState, network: audio.networkState, duration: Number.isFinite(audio.duration) ? audio.duration : null, error: audio.error?.code, support: audio.canPlayType('audio/wav') };
                audio.onloadeddata = audio.oncanplay = audio.onerror = null;
                audio.removeAttribute('src'); audio.load(); resolve(state);
              };
              const timer = setTimeout(() => finish('timeout'), 6000);
              audio.preload = 'auto'; audio.onloadeddata = audio.oncanplay = () => { if (audio.readyState >= 2) finish('loaded'); };
              audio.onerror = () => finish('error'); audio.src = source; audio.load();
            });
            const source = document.getElementById('audio').currentSrc;
            if (source.startsWith('blob:' + location.origin + '/')) result.originalUrlProbe = await probe(source);
            const copied = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }));
            try { result.copiedBytesProbe = await probe(copied); } finally { URL.revokeObjectURL(copied); }
            return result;
          }, version).catch(failure => ({ readError: failure.message }));
          failures.push(new Error(JSON.stringify({ browser: name, viewport, phase, mockedTranslations, offlineState, layoutState, sourceControlState, mediaState, fixtureState, message: error.message, stack: error.stack }), { cause: error }));
          // GitHub truncates each annotation at 4,096 characters. Emit a compact
          // annotation per scenario so later failures remain independently visible.
          if (process.env.GITHUB_ACTIONS === 'true') {
            const detail = JSON.stringify({ browser: name, viewport, phase, message: String(error.message).slice(0, 1200), layoutState,
              media: mediaState && { paused: mediaState.paused, ready: mediaState.ready, time: mediaState.time, error: mediaState.error, translationHidden: mediaState.translationHidden } });
            console.error(`::error title=CommuteLingo ${name} ${viewport.width} ${phase}::${detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
          }
        } finally { await context.close(); }
      }
    } finally { await browser?.close(); }
  }
  try { await runUpdateBrowser(chromium); } catch (error) { failures.push(new Error('Update lifecycle: ' + error.message, { cause: error })); }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
} catch (error) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const message = String(error.message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error title=CommuteLingo browser smoke::${message}`);
  }
  throw error;
} finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
