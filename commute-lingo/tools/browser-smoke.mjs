// CI only: use this app's locked Playwright dependency. No Mac install.
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
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
      for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }]) {
        // WebKit's ephemeral data store rejects IndexedDB Blobs. Exercise the
        // ordinary persistent storage path using a fresh CI-only profile.
        // Profiles stay outside browser-results and are never uploaded.
        const options = { viewport, isMobile: true, hasTouch: true };
        const context = name === 'webkit'
          ? await engine.launchPersistentContext(await mkdtemp(new URL('../.tmp/webkit-profile-', import.meta.url).pathname), options)
          : await browser.newContext(options);
        const page = await context.newPage(), errors = [];
        let phase = 'fixture-storage', offlineState, layoutState;
        try {
        page.on('pageerror', error => errors.push(error.message));
        await context.route('**/*', route => {
          const target = new URL(route.request().url());
          if (target.origin === origin) return route.continue();
          if (target.hostname === 'api.mymemory.translated.net') return route.fulfill({ json: { responseStatus: 200, responseData: { translatedText: translationFixture } } });
          return route.abort(); // No private data or fixture audio leaves CI.
        });
        await page.goto(url);
        await page.waitForFunction(() => !document.getElementById('start-import').disabled);
        await page.evaluate(async ({ version }) => {
          const library = await import(`./library.mjs?v=${version}`), storage = await import(`./storage.mjs?v=${version}`);
          let data = library.addAlbum(library.emptyLibrary(), 'Public browser fixture', 'fixture-album');
          data = library.placeTrack(data, { id: 'fixture-track', title: 'A public test episode with a longer title for narrow mobile screens', duration: 120, language: 'en', size: 32044,
            segments: Array.from({ length: 20 }, (_, i) => ({ start: i * 6, end: (i + 1) * 6, text: `Sentence ${i + 1} is public test content for the commute reading layout.` })) }, 'fixture-album');
          const bytes = new ArrayBuffer(32044), view = new DataView(bytes);
          const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
          text(0, 'RIFF'); view.setUint32(4, 32036, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
          view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
          view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 32000, true);
          data.revision = 1;
          await storage.commitLibrary(data, { expectedRevision: 0, audio: { id: 'fixture-track', blob: new Blob([bytes], { type: 'audio/wav' }) } });
          const stored = await storage.read('audio:fixture-track');
          if (!(stored instanceof Blob) || stored.size !== bytes.byteLength || stored.type !== 'audio/wav') throw new Error('Stored fixture audio must retain its Blob size and MIME type.');
          const actual = new Uint8Array(await stored.arrayBuffer()), expected = new Uint8Array(bytes);
          if (actual.some((byte, index) => byte !== expected[index])) throw new Error('Stored fixture audio bytes changed.');
        }, { version });
        await page.reload();
        await page.waitForFunction(() => !document.getElementById('start-import').disabled && document.querySelector('#playlist-tracks .track-main'));
        phase = 'layout';
        for (const size of ['normal', 'large', 'xlarge']) {
          phase = `caption-layout-${size}`;
          await page.locator('[data-tab="settings"]').click();
          await page.locator('#setting-subtitles').selectOption(size);
          await page.locator('#settings-form button[type=submit]').click();
          await page.waitForFunction(() => document.getElementById('settings-message').textContent === '設定已儲存。');
          await page.locator('[data-tab="playlist"]').click();
          await page.locator('#playlist-tracks .track-main').first().click();
          await page.waitForFunction(() => document.getElementById('player').open);
          await page.evaluate(() => document.getElementById('audio').pause());
          await page.locator('#toggle-subtitles').click();
          const layout = await page.evaluate(() => {
            const sheet = document.getElementById('player'), list = document.getElementById('subtitle-list'), rect = sheet.getBoundingClientRect();
            const controls = ['player-close', 'player-menu', 'playback-range', 'previous-sentence', 'player-play', 'next-sentence', 'playback-speed', 'player-stop', 'toggle-subtitles', 'follow-subtitles'];
            return { top: rect.top, bottom: rect.bottom, height: innerHeight, listHeight: list.clientHeight, overflow: sheet.scrollHeight - sheet.clientHeight, artwork: getComputedStyle(document.getElementById('player-art')).display,
              controlsVisible: controls.every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= rect.top && r.bottom <= rect.bottom + 1 && r.left >= rect.left && r.right <= rect.right + 1; }) };
          });
          assert.ok(layout.top >= -1 && layout.bottom <= layout.height + 1, JSON.stringify({ name, viewport, size, layout }));
          assert.ok(layout.controlsVisible && layout.overflow <= 1 && layout.artwork === 'none', JSON.stringify({ name, viewport, size, layout }));
          assert.ok(layout.listHeight > (viewport.width > 360 ? viewport.height * 0.45 : 100), JSON.stringify({ name, viewport, size, layout }));
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-${size}-captions.png`, output).pathname });
          // Keyboard translation reaches the same long-press action, using a fake service.
          await page.locator('.sentence-text').first().focus(); await page.keyboard.press('Enter');
          phase = `translation-layout-${size}`;
          await expect(page.locator('#translation-text')).toHaveText(translationFixture);
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
          await page.locator('#player-play').click();
          assert.equal(await page.locator('#translation-panel').isVisible(), false);
          await page.locator('#toggle-subtitles').click();
          assert.equal(await page.locator('#player-art').isVisible(), true);
          await page.locator('#player-close').click();
          console.log(JSON.stringify({ browser: name, viewport, subtitleSize: size, status: 'PASS', captionPixels: layout.listHeight }));
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
          for (const tab of ['settings', 'library', 'import', 'playlist']) {
            await page.locator(`[data-tab="${tab}"]`).click();
            const response = await page.reload();
            assert.equal(response?.fromServiceWorker(), true, `Offline ${tab} navigation must come from the service worker.`);
            await page.waitForFunction(() => !document.getElementById('start-import').disabled);
            assert.equal(new URL(page.url()).hash, `#${tab}`);
          }
          await page.waitForFunction(() => document.querySelector('#playlist-tracks .track-main'));
          const uncachedFailed = await page.evaluate(() => fetch('./index.html?uncached-offline-probe=1').then(() => false, () => true));
          assert.equal(uncachedFailed, true, 'An uncached network request must fail while offline.');
          console.log(JSON.stringify({ browser: name, offlineReload: 'PASS', scope }));
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: new URL(`${name}-${viewport.width}.png`, output).pathname });
        } catch (error) {
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-failure.png`, output).pathname }).catch(() => {});
          failures.push(new Error(JSON.stringify({ browser: name, viewport, phase, offlineState, layoutState, message: error.message }), { cause: error }));
        } finally { await context.close(); }
      }
    } finally { await browser?.close(); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
} catch (error) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const message = String(error.message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error title=CommuteLingo browser smoke::${message}`);
  }
  throw error;
} finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
