// CI only: use this app's locked Playwright dependency. No Mac install.
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { seedFixture } from './browser-fixture.mjs';
import { runUpdateBrowser } from './update-browser.mjs';
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
        // WebKit cannot route SW-owned requests. Keep its layout/API fixture
        // test isolated; real SW/offline behavior is exercised in Chromium.
        const options = { viewport, isMobile: true, hasTouch: true, serviceWorkers: name === 'webkit' ? 'block' : 'allow' };
        const context = name === 'webkit'
          ? await engine.launchPersistentContext(await mkdtemp(new URL('../.tmp/webkit-profile-', import.meta.url).pathname), options)
          : await browser.newContext(options);
        const page = await context.newPage(), errors = [];
        let phase = 'fixture-storage', offlineState, layoutState, mockedTranslations = 0;
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
          return route.abort(); // No private data or fixture audio leaves CI.
        });
        await page.goto(url);
        await page.waitForFunction(() => !document.getElementById('start-import').disabled);
        await page.evaluate(seedFixture, { version });
        await page.reload();
        await page.waitForFunction(() => !document.getElementById('start-import').disabled && document.querySelector('#playlist-tracks .track-main'));
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '20px');
        assert.ok(Math.abs(await page.locator('#playlist-title').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) - 35.2) < 0.05, 'Large headings must retain their original size');
        for (const tab of ['playlist', 'library', 'import', 'settings']) {
          await page.locator(`[data-tab="${tab}"]`).click();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tab}: enlarged interface must fit portrait width`);
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-${tab}-ui125.png`, output).pathname });
        }
        await expect(page.locator('#setting-minutes')).toHaveValue('25');
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
            const controls = ['player-close', 'player-menu', 'playback-range', 'previous-sentence', 'player-play', 'next-sentence', 'playback-speed', 'player-stop', 'toggle-subtitles', 'follow-subtitles'];
            return { top: rect.top, bottom: rect.bottom, height: innerHeight, listHeight: list.clientHeight, overflow: sheet.scrollHeight - sheet.clientHeight, artwork: getComputedStyle(document.getElementById('player-art')).display,
              controlsVisible: controls.every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= rect.top && r.bottom <= rect.bottom + 1 && r.left >= rect.left && r.right <= rect.right + 1; }) };
          });
          const captionFont = await page.locator('.sentence-text').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
          assert.ok(Math.abs(captionFont - { normal: 18.4, large: 22.4, xlarge: 27.2 }[size]) < 0.05, 'Interface scaling must preserve caption sizes');
          assert.ok(layout.top >= -1 && layout.bottom <= layout.height + 1, JSON.stringify({ name, viewport, size, layout }));
          assert.ok(layout.controlsVisible && layout.overflow <= 1 && layout.artwork === 'none', JSON.stringify({ name, viewport, size, layout }));
          assert.ok(layout.listHeight > (viewport.width > 360 ? viewport.height * 0.45 : 100), JSON.stringify({ name, viewport, size, layout }));
          await page.screenshot({ path: new URL(`${name}-${viewport.width}-${size}-captions.png`, output).pathname });
          // Keyboard translation reaches the same long-press action, using a fake service.
          await page.locator('.sentence-text').first().focus(); await page.keyboard.press('Enter');
          phase = `translation-layout-${size}`;
          await expect(page.locator('#translation-text')).toHaveText(translationFixture);
          assert.ok(mockedTranslations > 0, 'The translation fixture must be provided by the route, not the real service.');
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
          const mediaState = await page.evaluate(() => {
            const audio = document.getElementById('audio');
            return { paused: audio.paused, ended: audio.ended, ready: audio.readyState, network: audio.networkState, time: audio.currentTime, duration: audio.duration,
              error: audio.error?.code, translationHidden: document.getElementById('translation-panel').hidden,
              feedback: document.getElementById('player-feedback').textContent, events: window.__mediaEvents };
          }).catch(() => undefined);
          failures.push(new Error(JSON.stringify({ browser: name, viewport, phase, mockedTranslations, offlineState, layoutState, mediaState, message: error.message }), { cause: error }));
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
