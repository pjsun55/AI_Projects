import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Called by browser-smoke against its synthetic audio and mocked APIs only.
// An actual iPhone native edit menu and system share sheet still need manual QA.
export async function runVocabularyBrowser(page, { version, output, onPhase = () => {} }) {
  onPhase('vocabulary-create');
  const words = () => page.evaluate(async version => (await import(`./storage.mjs?v=${version}`)).read('vocabulary-v1'), version);
  await page.locator('[data-tab="vocabulary"]').click();
  await page.locator('#add-word').click();
  await page.locator('#new-word').fill('resilience'); await page.locator('#word-tags').fill('生活,工作');
  await page.locator('#dialog-confirm').click();
  await expect.poll(async () => (await words())?.words[0]?.dictionary?.senses.length).toBeGreaterThan(0);
  const id = (await words()).words[0].id;
  const card = () => page.locator(`[data-word-id="${id}"]`);
  onPhase('vocabulary-edit-reload');
  await card().locator('.word-main').click();
  await page.locator('#word-translation').fill('復原力'); await page.locator('#word-note').fill('<img src=x onerror=alert(1)> public text note');
  await page.locator('#word-status').selectOption('known'); await page.locator('#dialog-confirm').click();
  await card().locator('.word-star').click();
  await expect.poll(async () => (await words()).words[0].starred).toBe(true);
  await page.locator('#vocabulary-filter').selectOption('known'); await page.locator('#vocabulary-tag').selectOption('tag:工作');
  await expect(page.locator('.word-card')).toHaveCount(1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: new URL('vocabulary.png', output).pathname });
  await page.reload();
  await expect(page.locator('.word-card')).toHaveCount(1);
  assert.equal((await words()).words[0].note, '<img src=x onerror=alert(1)> public text note');
  await expect(page.locator('#vocabulary-list img')).toHaveCount(0);

  onPhase('vocabulary-select-word');
  await page.locator('[data-tab="playlist"]').click();
  await page.locator('#playlist-tracks .track-main').first().click();
  if (await page.locator('#subtitles-panel').isHidden()) await page.locator('#toggle-subtitles').click();
  await page.locator('.sentence-text').first().evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await expect(page.locator('#translation-original')).toBeVisible();
  await page.locator('#translation-original').evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 8); // Sentence
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator('#save-selected-word')).toBeEnabled();
  assert.equal(await page.locator('#translation-original').evaluate(element => element.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }))), true);
  await page.locator('#save-selected-word').click();
  await expect.poll(async () => (await words()).words.find(word => word.word === 'Sentence')?.dictionary?.senses.length).toBeGreaterThan(0);
  const selected = (await words()).words.find(word => word.word === 'Sentence');
  assert.ok(selected.sourceTitle); assert.ok(!Object.hasOwn(selected, 'sentence')); assert.ok(!Object.hasOwn(selected, 'audio'));
  await page.locator('#player-close').click();
  await page.locator('#audio').evaluate(audio => audio.pause());

  // Copy fixture bytes before deletion. WebKit may invalidate an IndexedDB
  // Blob's backing file when its record is deleted; retaining that Blob does
  // not provide an independent audio fixture for the later offline tests.
  onPhase('vocabulary-delete-source');
  await page.evaluate(async version => {
    const storage = await import(`./storage.mjs?v=${version}`);
    const audio = await storage.read('audio:fixture-track');
    window.__vocabularySourceFixture = { library: await storage.read('library-v2'), audio: new Blob([await audio.arrayBuffer()], { type: audio.type }) };
  }, version);
  await page.locator('[data-tab="library"]').click();
  await page.locator('.album-management-header .round-button').first().click(); await page.locator('#album-action').selectOption('delete'); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#dialog-title')).toHaveText('刪除這個專輯？'); await page.locator('#dialog-confirm').click();
  assert.equal((await words()).words.length, 2);
  assert.equal(await page.evaluate(async version => !!await (await import(`./storage.mjs?v=${version}`)).read('audio:fixture-track'), version), false);

  onPhase('personal-backup-download');
  await page.locator('[data-tab="settings"]').click();
  const downloadEvent = page.waitForEvent('download'); await page.locator('#backup-library').click(); const download = await downloadEvent;
  const filename = new URL('personal-backup.json', output).pathname; await download.saveAs(filename);
  const backup = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(backup.vocabulary.words.length, 2); assert.ok(!Object.hasOwn(backup, 'library')); assert.ok(!Object.hasOwn(backup, 'translations'));
  await page.locator('[data-tab="vocabulary"]').click();
  await card().locator('.round-button').click(); await page.locator('#word-action').selectOption('delete'); await page.locator('#dialog-confirm').click();
  await expect(page.locator('#dialog-title')).toContainText('刪除「'); await page.locator('#dialog-confirm').click();
  await expect.poll(async () => (await words()).words.length).toBe(1);
  await page.locator('[data-tab="settings"]').click();
  onPhase('personal-backup-restore');
  const chooserEvent = page.waitForEvent('filechooser');
  await page.locator('#restore-backup-button').click();
  await (await chooserEvent).setFiles(filename);
  await expect(page.locator('#dialog-title')).toHaveText('預覽備份還原'); await expect(page.locator('#dialog-description')).toContainText('新增 1');
  await expect(page.locator('#restore-settings')).not.toBeChecked(); await page.locator('#dialog-confirm').click();
  await expect.poll(async () => (await words()).words.length).toBe(2);
  assert.equal((await words()).words.find(word => word.word === 'resilience').note, '<img src=x onerror=alert(1)> public text note');
  onPhase('vocabulary-fixture-reset');
  await page.evaluate(async version => {
    const storage = await import(`./storage.mjs?v=${version}`), current = await storage.read('library-v2'), fixture = window.__vocabularySourceFixture;
    await storage.commitLibrary({ ...fixture.library, revision: current.revision + 1 }, { expectedRevision: current.revision, audio: { id: 'fixture-track', blob: fixture.audio } });
    const stored = await storage.read('audio:fixture-track');
    if (!(stored instanceof Blob) || stored.size !== fixture.audio.size || stored.type !== fixture.audio.type) throw new Error('Restored synthetic audio metadata changed.');
    const actual = new Uint8Array(await stored.arrayBuffer()), expected = new Uint8Array(await fixture.audio.arrayBuffer());
    if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) throw new Error('Restored synthetic audio bytes changed.');
    delete window.__vocabularySourceFixture;
  }, version);
  await page.reload();
}
