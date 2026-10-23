import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
export async function runReadingBrowser(page, { version, output, onPhase = () => {} }) {
  onPhase('reading-word-storage');
  const original = await page.evaluate(async version => {
    const storage = await import('./storage.mjs?v=' + version), core = await import('./core.mjs?v=' + version), library = await storage.read('library-v2');
    const chunks = Array.from({ length: 53 }, (_, i) => ({ text: 'word' + i + (i === 52 ? '.' : ''), timestamp: [i * .4, (i + 1) * .4] }));
    const segments = core.normalizeWordSentences(chunks, 120).segments;
    segments.push({ start: 119, end: 120, text: 'Last.' });
    await storage.commitLibrary({ ...library, revision: library.revision + 1, tracks: library.tracks.map(track => track.id === 'fixture-track' ? { ...track, alignment: 'word-v1', transcriptStatus: 'complete', segments } : track) }, { expectedRevision: library.revision });
    return library;
  }, version);
  async function openCaptions() {
    await page.reload(); await page.waitForFunction(() => !document.getElementById('start-import').disabled);
    await page.locator('[data-tab="playlist"]').click(); await page.locator('#playlist-tracks .track-main').first().click();
    await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
    await page.locator('#audio').evaluate(audio => audio.pause());
    if (await page.locator('#subtitles-panel').isHidden()) await page.locator('#toggle-subtitles').click();
  }
  await openCaptions(); onPhase('reading-word-cursor');
  await expect(page.locator('.timed-reading')).toHaveCount(1);
  await expect(page.locator('.subtitle-cue')).toHaveCount(2);
  await expect(page.locator('.timed-reading .reading-word')).toHaveCount(53);
  await expect(page.locator('.timed-reading .sentence-text')).toHaveText(Array.from({ length: 53 }, (_, i) => 'word' + i + (i === 52 ? '.' : '')).join(' '));
  await expect(page.locator('.reading-pages')).toHaveCount(0);
  for (const time of [.1, .5, 1.3, 5.1, 11.1, 20.5]) {
    await page.locator('#audio').evaluate((audio, time) => { audio.currentTime = time; audio.dispatchEvent(new Event('timeupdate')); }, time);
    await expect(page.locator('.spoken-word')).toHaveCount(1);
    await expect(page.locator('.spoken-word')).toHaveText('word' + Math.floor(time / .4) + (Math.floor(time / .4) === 52 ? '.' : ''));
  }
  for (const pixels of [18.4, 22.4, 27.2]) {
    await page.evaluate(pixels => document.documentElement.style.setProperty('--subtitle-size', pixels + 'px'), pixels);
    // A complete long sentence can exceed the viewport. Follow its current word
    // inside the same card at every supported font size, including the last line.
    for (const time of [.1, 11.1, 21.1]) {
      await page.locator('#audio').evaluate((audio, time) => { audio.currentTime = time; audio.dispatchEvent(new Event('timeupdate')); }, time);
      await expect(page.locator('.spoken-word')).toHaveCount(1);
      await expect(page.locator('.spoken-word')).toHaveText('word' + Math.floor(time / .4) + (time > 21 ? '.' : ''));
      await expect.poll(() => page.locator('.spoken-word').evaluate(word => {
        const bounds = document.getElementById('subtitle-list').getBoundingClientRect(), position = word.getBoundingClientRect();
        return position.top >= bounds.top && position.bottom <= bounds.bottom;
      })).toBe(true);
    }
    assert.equal(await page.locator('.subtitle-cue.active .sentence-text').evaluate(element => +getComputedStyle(element).fontWeight), 500);
  }
  await page.screenshot({ path: new URL('word-follow.png', output).pathname });
  await page.locator('#audio').evaluate(audio => { audio.currentTime = 30; audio.dispatchEvent(new Event('timeupdate')); });
  await expect(page.locator('.spoken-word')).toHaveCount(0);
  await expect(page.locator('.subtitle-cue.active')).toHaveCount(0);
  // The complete card remains the translation and original-audio context.
  await page.locator('.sentence-text').first().evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await expect(page.locator('#translation-original')).toContainText('word52.');
  assert.equal((await page.locator('#translation-original').textContent()).trim().split(/\s+/u).length, 53);
  await page.locator('#translation-close').click(); await page.locator('#audio').evaluate(audio => audio.pause()); await page.locator('#player-close').click();
  onPhase('reading-legacy-sentence');
  await page.evaluate(async version => {
    const storage = await import('./storage.mjs?v=' + version), library = await storage.read('library-v2');
    const original = library.tracks.find(track => track.id === 'fixture-track');
    const text = original.segments.map(cue => cue.text).slice(0, -1).join(' ');
    await storage.commitLibrary({ ...library, revision: library.revision + 1, tracks: library.tracks.map(track => track.id === 'fixture-track' ? { ...track, alignment: 'segment-v1', segments: [{ start: 0, end: 21.2, text }, { start: 119, end: 120, text: 'Last.' }] } : track) }, { expectedRevision: library.revision });
  }, version);
  await openCaptions(); const row = page.locator('.subtitle-cue').first();
  assert.equal((await row.locator('.sentence-text').textContent()).trim().split(/\s+/u).length, 53);
  await expect(page.locator('.subtitle-cue')).toHaveCount(2);
  await expect(page.locator('.reading-pages')).toHaveCount(0);
  await expect(page.locator('.spoken-word')).toHaveCount(0);
  await expect(page.locator('#transcript-notice')).toHaveCount(0);
  await expect(page.locator('#toggle-subtitles')).toHaveAttribute('aria-label', '句子字幕');
  await page.screenshot({ path: new URL('legacy-sentence.png', output).pathname });
  await page.locator('#player-close').click();
  await page.evaluate(async ({ version, original }) => {
    const storage = await import('./storage.mjs?v=' + version), current = await storage.read('library-v2');
    await storage.commitLibrary({ ...original, revision: current.revision + 1 }, { expectedRevision: current.revision });
  }, { version, original });
  await page.reload();
}
