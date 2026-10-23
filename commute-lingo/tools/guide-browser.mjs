import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Synthetic fixture only. Google requests are intercepted; no real Key or quota.
// Run for both engines and every phone/tablet viewport in browser-smoke.mjs.
export async function runGuideBrowser(page, { version, output, onPhase = () => {} }) {
  const key = 'fixture_only_invalid_key_000000000000';
  const read = name => page.evaluate(async ({ version, name }) => (await import(`./storage.mjs?v=${version}`)).read(name), { version, name });
  const source = (await read('library-v2')).tracks.find(track => track.id === 'fixture-track').segments.map(cue => cue.text).join(' ');
  const quote = 'Sentence 1 is public test content for the commute reading layout.';
  const content = { intro: '<img src=x onerror=alert(1)> 這是通勤聽力導讀的測試文字。', route: ['留意每一句表達的重點。'], vocabulary: [{ term: 'commute', pos: 'n.', meaning: '通勤', quote, clue: '從閱讀旅程的語境猜字義。' }], sentence: { quote, translation: '這是通勤閱讀版面測試的公開內容。', explanation: 'for 說明用途。' } };
  let requests = 0;
  const route = async intercepted => {
    if (intercepted.request().method() === 'OPTIONS') {
      await intercepted.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type,x-goog-api-key' } }); return;
    }
    requests++;
    const request = intercepted.request(), body = request.postDataJSON();
    assert.equal(request.headers()['x-goog-api-key'], key);
    assert.ok(!request.url().includes(key) && !request.postData().includes(key));
    const verifying = body.contents[0].parts[0].text === 'Please reply with OK.';
    if (!verifying) assert.equal(body.contents[0].parts[0].text, source);
    await intercepted.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: verifying ? 'OK' : JSON.stringify(content) }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 100 } }) + '\n\n' });
  };
  const pattern = 'https://generativelanguage.googleapis.com/**';
  await page.route(pattern, route);
  onPhase('guide-removed-model-migration');
  await page.evaluate(async version => {
    const storage = await import(`./storage.mjs?v=${version}`), library = await storage.read('library-v2');
    await storage.commitLibrary({ ...library, revision: library.revision + 1, settings: { ...library.settings, geminiModel: 'gemini-3.8-flash', autoGuide: true }, tracks: library.tracks.map(track => track.id === 'fixture-track' ? { ...track, transcriptStatus: 'partial' } : track) }, { expectedRevision: library.revision });
  }, version);
  await page.reload(); await page.waitForFunction(() => !document.getElementById('start-import').disabled);
  await expect(page.locator('#setting-gemini-model option')).toHaveCount(1);
  await expect(page.locator('#setting-gemini-model')).toHaveValue('gemini-3.5-flash-lite');
  assert.equal(requests, 0);
  onPhase('guide-encrypted-key');
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#gemini-key').fill(key); await page.locator('#save-gemini-key').click();
  await expect(page.locator('#gemini-key')).toHaveValue('');
  await expect.poll(async () => !!await read('gemini-key-v1')).toBe(true);
  assert.equal(requests, 0);
  assert.ok(await page.evaluate(async version => {
    const storage = await import(`./storage.mjs?v=${version}`), record = await storage.read('gemini-key-v1');
    return record.cryptoKey.extractable === false && record.cryptoKey.algorithm.length === 256 && record.ciphertext.byteLength > 16;
  }, version));
  await page.reload(); await page.waitForFunction(() => !document.getElementById('start-import').disabled); await expect(page.locator('#verify-gemini-key')).toBeEnabled();
  await page.locator('#verify-gemini-key').click();
  await expect.poll(() => requests).toBe(1); await expect(page.locator('#remove-gemini-key')).toBeEnabled();
  onPhase('guide-generate');
  await page.locator('[data-tab="playlist"]').click(); await page.locator('#playlist-tracks .track-main').first().click();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await page.locator('#audio').evaluate(audio => audio.pause());
  await page.locator('#toggle-guide').click();
  await expect(page.locator('#guide-status')).toContainText('尚未產生'); assert.equal(requests, 1);
  await page.locator('#generate-guide').click();
  await expect.poll(async () => (await read('guide:fixture-track'))?.status).toBe('ready');
  await page.evaluate(async version => {
    const storage = await import(`./storage.mjs?v=${version}`), library = await storage.read('library-v2');
    await storage.commitLibrary({ ...library, revision: library.revision + 1, tracks: library.tracks.map(track => track.id === 'fixture-track' ? { ...track, transcriptStatus: 'complete' } : track) }, { expectedRevision: library.revision });
  }, version);
  await expect(page.locator('.guide-save-word')).toHaveCount(1); await expect(page.locator('#guide-content img')).toHaveCount(0);
  assert.equal(requests, 2);
  await expect(page.locator('#guide-status')).toContainText('已完成');
  await expect(page.locator('#subtitles-panel')).not.toBeVisible();
  const geometry = await page.evaluate(() => {
    const sheet = document.getElementById('player').getBoundingClientRect(), list = document.getElementById('guide-content');
    const bounds = list.getBoundingClientRect(), controls = ['toggle-guide', 'toggle-subtitles', 'playback-repeat', 'generate-guide', 'player-close'];
    return { pixels: list.clientHeight, overflow: document.documentElement.scrollWidth - innerWidth, scrolls: list.scrollHeight > list.clientHeight,
      contained: bounds.top >= sheet.top && bounds.bottom <= sheet.bottom + 1,
      controls: controls.every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= sheet.left && r.right <= sheet.right + 1; }) };
  });
  assert.ok(geometry.pixels > 80 && geometry.overflow <= 1 && geometry.contained && geometry.controls, JSON.stringify(geometry));
  await page.screenshot({ path: new URL('guide.png', output).pathname });
  await page.locator('.guide-save-word').click();
  await expect.poll(async () => (await read('vocabulary-v1')).words.find(word => word.word === 'commute')?.translationSource).toBe('gemini');
  await expect(page.locator('.guide-save-word')).toBeDisabled(); assert.equal(requests, 2);
  onPhase('guide-local-reload');
  await page.reload(); await expect(page.locator('#mini-player')).toBeVisible();
  await expect(page.locator('#resume-card')).toBeHidden();
  await page.locator('#mini-open').click(); await page.locator('#toggle-guide').click();
  await expect(page.locator('.guide-save-word')).toHaveCount(1); assert.equal(requests, 2);
  await page.locator('#player-close').click();
  await page.locator('[data-tab="vocabulary"]').click();
  const topBar = await page.evaluate(() => {
    const bar = document.getElementById('mini-player').getBoundingClientRect(), search = document.getElementById('vocabulary-search').getBoundingClientRect();
    return { top: bar.top, bottom: bar.bottom, searchTop: search.top, viewport: innerHeight };
  });
  assert.ok(topBar.top >= 0 && topBar.bottom < topBar.viewport / 2 && topBar.searchTop >= topBar.bottom, JSON.stringify(topBar));
  await page.screenshot({ path: new URL('top-player.png', output).pathname });
  await page.locator('#mini-open').click(); await page.locator('#playback-repeat').click();
  await expect.poll(async () => (await read('library-v2')).settings.repeatMode).toBe('track');
  await page.locator('#audio').evaluate(audio => { audio.currentTime = 120; audio.dispatchEvent(new Event('ended')); });
  await page.waitForFunction(() => document.getElementById('audio').currentTime < 2 && !document.getElementById('audio').paused);
  await page.locator('#playback-repeat').click(); await expect.poll(async () => (await read('library-v2')).settings.repeatMode).toBe('album');
  await page.locator('#playback-repeat').click(); await expect.poll(async () => (await read('library-v2')).settings.repeatMode).toBe('off');
  await page.locator('#audio').evaluate(audio => { audio.pause(); audio.currentTime = 12; });
  await page.locator('#player-close').click(); await page.locator('#mini-dismiss').click();
  await expect(page.locator('#mini-player')).not.toBeVisible(); await expect.poll(() => read('player-v2')).toBe(null);
  assert.ok(Math.abs((await read('progress:fixture-track')).position - 12) < 0.2);
  await page.reload(); await page.waitForFunction(() => !document.getElementById('start-import').disabled);
  await expect(page.locator('#mini-player')).not.toBeVisible();
  await page.locator('[data-tab="playlist"]').click();
  await expect(page.locator('#view-playlist')).toBeVisible();
  await expect(page.locator('#resume-card')).toBeVisible();
  await page.locator('#resume-card .round-button').click();
  await expect(page.locator('#player')).toBeVisible(); await expect(page.locator('#resume-card')).toBeHidden();
  await page.waitForFunction(() => { const audio = document.getElementById('audio'); return audio.readyState >= 1 && !audio.seeking && Math.abs(audio.currentTime - 12) < 1; });
  await page.locator('#audio').evaluate(audio => audio.pause());
  assert.ok(Math.abs(await page.locator('#audio').evaluate(audio => audio.currentTime) - 12) < 1, 'Resume must retain the saved playback position');
  await page.locator('#player-close').click(); await page.locator('#mini-dismiss').click();
  onPhase('guide-key-removal');
  await page.locator('[data-tab="settings"]').click(); await page.locator('#remove-gemini-key').click();
  await expect.poll(async () => !!await read('gemini-key-v1')).toBe(false);
  await page.locator('[data-tab="playlist"]').click(); await page.locator('#playlist-tracks .track-main').first().click();
  await page.locator('#audio').evaluate(audio => audio.pause()); await page.locator('#toggle-guide').click();
  await expect(page.locator('.guide-save-word')).toHaveCount(1); await expect(page.locator('#generate-guide')).toBeDisabled(); await expect(page.locator('#guide-help')).toContainText('API Key'); assert.equal(requests, 2);
  await page.locator('#player-close').click();
  await page.unroute(pattern, route);
  console.log(JSON.stringify({ guide: 'PASS', encryptedKeyReload: 'PASS', noRepeatedCalls: requests, geometry, topBar }));
}
