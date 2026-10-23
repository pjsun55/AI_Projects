import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function runResponsiveBrowser(page, { viewport, output, onPhase = () => {} }) {
  onPhase('tablet-resize');
  await page.locator('[data-tab="playlist"]').click();
  await page.locator('#playlist-tracks .track-main').first().click();
  await page.waitForFunction(() => document.getElementById('audio').readyState >= 2);
  await page.locator('#audio').evaluate(audio => { audio.pause(); audio.currentTime = 7.25; audio.playbackRate = 1.25; audio.dispatchEvent(new Event('timeupdate')); });
  if (await page.locator('#subtitles-panel').isHidden()) await page.locator('#toggle-subtitles').click();
  const media = () => page.locator('#audio').evaluate(audio => ({ src: audio.src, time: audio.currentTime, speed: audio.playbackRate, paused: audio.paused }));
  const before = await media();
  try {
    for (const size of [{ width: 800, height: 1280 }, { width: 1280, height: 800 }, { width: 480, height: 800 }]) {
      await page.setViewportSize(size);
      await expect(page.locator('#landscape-gate')).toBeHidden();
      await expect.poll(() => page.evaluate(() => {
        const player = document.getElementById('player'), bounds = player.getBoundingClientRect();
        const controls = ['player-close', 'playback-range', 'previous-sentence', 'player-play', 'next-sentence', 'playback-speed', 'toggle-subtitles', 'follow-subtitles'];
        return document.documentElement.scrollWidth <= innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= innerHeight + 1 && bounds.left >= -1 && bounds.right <= innerWidth + 1 && player.scrollHeight <= player.clientHeight + 1 && document.getElementById('subtitle-list').clientHeight >= 100 && controls.every(id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.height >= (id === 'playback-range' ? 24 : 44) && r.top >= bounds.top && r.bottom <= bounds.bottom + 1 && r.left >= bounds.left && r.right <= bounds.right + 1;
        });
      }), { message: 'Tablet rotation and split-window layouts must keep playback controls and captions visible' }).toBe(true);
      assert.deepEqual(await media(), before, 'Resizing must retain the loaded audio, position, speed and paused state');
      await page.screenshot({ path: new URL(`responsive-${size.width}-${size.height}.png`, output).pathname });
    }
    await page.locator('#player-close').click();
    for (const tab of ['playlist', 'library', 'vocabulary', 'import', 'settings']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tab}: split-window content must remain within the viewport`);
    }
  } finally {
    if (await page.locator('#player').isVisible()) await page.locator('#player-close').click();
    await page.setViewportSize(viewport);
  }
  console.log(JSON.stringify({ responsiveTabletPortrait: 'PASS', responsiveTabletLandscape: 'PASS', splitWindow: 'PASS', audioRetainedOnResize: 'PASS' }));
}
