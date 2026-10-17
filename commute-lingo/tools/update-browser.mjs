import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from './server.mjs';
import { seedFixture } from './browser-fixture.mjs';

// Real SW updates on an isolated loopback server; repository files stay intact.
export async function runUpdateBrowser(engine) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.ok(source.includes('-r1`'));
  let revision = 'old';
  const basePath = '/AI_Projects/commute-lingo/';
  const server = await createServer({ basePath }), serve = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (new URL(request.url, 'http://localhost').pathname === basePath + 'sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(source.replace('-r1`', `-browser-${revision}\``));
    } else void serve(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
    try {
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(`${origin}${basePath}?v=${version}`);
      await page.waitForFunction(() => !document.getElementById('start-import').disabled && navigator.serviceWorker.controller?.state === 'activated');
      await page.evaluate(seedFixture, { version });
      await page.evaluate(async version => {
        const storage = await import(`./storage.mjs?v=${version}`);
        const { createTranslator } = await import(`./translation.mjs?v=${version}`);
        const library = await storage.read('library-v2');
        const translator = createTranslator({ save: (key, entry) => storage.write(`translation:${key}`, entry) });
        await translator.seed([{ source: 'en', target: 'zh-TW', text: library.tracks[0].segments[0].text, translation: '這是保存在裝置上的公開測試翻譯。' }]);
        await caches.open('other-app-retain');
      }, version);
      await page.reload();
      await page.locator('#playlist-tracks .track-main').first().click();
      await page.waitForFunction(() => document.getElementById('player').open && !document.getElementById('audio').paused);
      await page.locator('#player-close').click();
      await page.locator('[data-tab="settings"]').click();
      await page.locator('#setting-minutes').fill('30');
      await page.locator('#settings-form button[type=submit]').click();
      await page.waitForFunction(() => document.getElementById('settings-message').textContent === '設定已儲存。');
      await page.evaluate(() => { window.__priorUpdateDocument = true; });
      revision = 'new';
      await page.locator('#check-update').click();
      await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
      await page.locator('#apply-update').click();
      await page.waitForFunction(() => document.getElementById('update-status').textContent.includes('播放、處理或編輯'));
      assert.equal(await page.evaluate(() => !document.getElementById('audio').paused && window.__priorUpdateDocument === true), true);
      // Pause listening and let the ordinary automatic-update timer apply it.
      const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame(), timeout: 25000 });
      await page.locator('#mini-play').click();
      await navigation;
      await page.waitForFunction(() => !document.getElementById('start-import').disabled && document.getElementById('setting-minutes').value === '30');
      const saved = await page.evaluate(async version => {
        const storage = await import(`./storage.mjs?v=${version}`);
        const { createTranslator } = await import(`./translation.mjs?v=${version}`);
        const library = await storage.read('library-v2');
        const translator = createTranslator({ load: key => storage.read(`translation:${key}`), fetchImpl() { throw new Error('A retained translation must not need the network.'); } });
        const translation = await translator.translate(library.tracks[0].segments[0].text, 'en');
        return { translation, trackCount: library.tracks.length, segments: library.tracks[0].segments.length, blobSize: (await storage.read('audio:fixture-track'))?.size,
          otherCache: (await caches.keys()).includes('other-app-retain'), oldDocument: window.__priorUpdateDocument === true,
          audioPaused: document.getElementById('audio').paused };
      }, version);
      assert.equal(saved.translation.translation, '這是保存在裝置上的公開測試翻譯。');
      assert.equal(saved.translation.cached, true); assert.equal(saved.translation.persisted, true);
      assert.equal(saved.trackCount, 1); assert.equal(saved.segments, 20);
      assert.equal(saved.blobSize, 120 * 32000 + 44); assert.equal(saved.otherCache, true);
      assert.equal(saved.oldDocument, false); assert.equal(saved.audioPaused, true);
      console.log(JSON.stringify({ browser: 'chromium', updateWhilePlaying: 'DEFERRED', idleAutomaticUpdate: 'PASS', settingsAndAudioRetained: 'PASS' }));
    } finally { await context.close(); }
  } finally {
    await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
