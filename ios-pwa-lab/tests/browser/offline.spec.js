import {test,expect} from '@playwright/test';
test('Chromium 真實 Service Worker 完整快取後離線重載，網路測試失敗不假裝成功',async({page,context,browserName})=>{
  test.skip(browserName!=='chromium','Service Worker 專項先使用 Chromium');
  await page.goto('./');await expect(page.locator('#sw-status')).toContainText('離線快取就緒');
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();
  await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBeTruthy();
  await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{name:/探索手機的/})).toBeVisible();
  await page.locator('#categories').getByRole('button',{name:'圖形與計算'}).click();await page.locator('[data-test="wasm"] [data-run]').click();await expect(page.locator('#results .record').first()).toContainText('成功');
  await page.locator('#categories').getByRole('button',{name:'網路與通訊'}).click();await page.locator('[data-test="fetch"] [data-run]').click();await expect(page.locator('#results .record').first()).toContainText('失敗');
});
