import {test,expect} from '@playwright/test';
const choose=async(page,title)=>{await page.getByRole('button',{name:title,exact:true}).click();};
const card=(page,id)=>page.locator(`[data-test="${id}"]`);
const run=async(page,id)=>{await card(page,id).getByRole('button',{name:'開始測試',exact:true}).click();};
const result=page=>page.locator('#results .record').first();
test.beforeEach(async({page})=>{await page.goto('./');await expect(page.locator('#notice')).toContainText('準備就緒');});
test('19 個分類可導覽，手機寬度沒有整頁橫向溢出',async({page})=>{
  const categories=page.locator('#categories button');await expect(categories).toHaveCount(19);
  for(let i=0;i<19;i++){await categories.nth(i).click();await expect(page.locator('#tests .test-card').first()).toBeVisible();}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('未執行測試無法人工宣告成功，API 存在只記錄未測試',async({page})=>{
  await card(page,'environment').getByRole('button',{name:'人工確認成功',exact:true}).click();await expect(page.locator('#count')).toHaveText('0');
  await card(page,'environment').getByRole('button',{name:'記錄偵測'}).click();await expect(result(page)).toContainText('API 偵測');await expect(result(page)).toContainText('未測試');
});
test('資料保存、重啟讀回、JSON 與 Markdown 匯出及可見內容防注入',async({page})=>{
  await page.locator('#model').fill('<script>private</script>');await page.locator('#model').blur();
  await run(page,'environment');await expect(result(page)).toContainText('成功');
  await page.reload();await expect(page.locator('#count')).toHaveText('1');await expect(page.locator('#model')).toHaveValue('<script>private</script>');
  for(const format of ['json','md']){const wait=page.waitForEvent('download');await page.locator(`#export-${format}`).click();const download=await wait;const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);const content=Buffer.concat(chunks).toString();
    if(format==='json'){const report=JSON.parse(content);expect(report.results).toHaveLength(1);expect(report.results[0].testId).toBe('environment');}
    else{expect(content).toContain('API 偵測與操作不同');expect(content).not.toContain('<script>');}
  }
});
test('Safari 與 PWA 紀錄可分開保存與篩選',async({page})=>{
  await run(page,'environment');await expect(page.locator('#count')).toHaveText('1');
  await page.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true,configurable:true}));await page.reload();await expect(page.locator('#environment')).toContainText('主畫面 PWA');
  await run(page,'environment');await expect(page.locator('#count')).toHaveText('2');
  await page.locator('#mode-filter').selectOption('pwa');await expect(page.locator('#count')).toHaveText('1');await expect(result(page)).toContainText('pwa');
  await page.locator('#mode-filter').selectOption('safari-tab');await expect(page.locator('#count')).toHaveText('1');
});
test('不支援與待後端／需原生有明確狀態',async({page})=>{
  await page.evaluate(()=>Object.defineProperty(navigator,'bluetooth',{value:undefined,configurable:true}));
  await choose(page,'條件式 Web API');await run(page,'bluetooth');await expect(result(page)).toContainText('不支援');
  await choose(page,'Passkey 與原生限制');await card(page,'passkey-flow').getByRole('button',{name:'記錄限制'}).click();await expect(result(page)).toContainText('待後端');
  await card(page,'native').getByRole('button',{name:'記錄限制'}).click();await expect(result(page)).toContainText('需原生');
});
test('模擬相機拒絕不影響其他測試',async({page})=>{
  await page.evaluate(()=>Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{throw new DOMException('denied','NotAllowedError');}},configurable:true}));
  await choose(page,'相機');await run(page,'camera-front');await expect(result(page)).toContainText('缺少測試條件');
  await choose(page,'圖形與計算');await run(page,'wasm');await expect(result(page)).toContainText('成功');
});
test('模擬停止後才回傳的串流會釋放',async({page})=>{
  await page.evaluate(()=>{window.stopped=0;Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(resolve=>{window.releaseMedia=()=>resolve({getTracks:()=>[{stop:()=>window.stopped++}]});})}});});
  await choose(page,'相機');await run(page,'camera-front');await page.getByRole('button',{name:'停止目前操作'}).click();await page.evaluate(()=>window.releaseMedia());
  await expect.poll(()=>page.evaluate(()=>window.stopped)).toBe(1);await expect(card(page,'camera-front').locator('[data-run]')).toBeEnabled();
});
test('模擬前景定位可停止且報告不保存座標',async({page})=>{
  await page.evaluate(()=>{window.cleared=0;Object.defineProperty(navigator,'geolocation',{configurable:true,value:{watchPosition:success=>{setTimeout(()=>success({coords:{latitude:25.123456,longitude:121.987654,accuracy:8},timestamp:Date.now()}),20);return 42;},clearWatch:id=>window.cleared=id}});});
  await choose(page,'定位');await run(page,'watch-location');await expect(result(page)).toContainText('精度 8');await expect(result(page)).not.toContainText('25.123456');
  await choose(page,'環境與顯示');expect(await page.evaluate(()=>window.cleared)).toBe(42);
});
test('模擬定位逾時與取消請求有不同狀態',async({page})=>{
  await page.evaluate(()=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:(_,error)=>setTimeout(()=>error({code:3}),20)}}));
  await choose(page,'定位');await run(page,'location');await expect(result(page)).toContainText('逾時');
  await choose(page,'網路與通訊');await run(page,'abort-fetch');await expect(result(page)).toContainText('使用者取消');
});
test('分享呼叫完成仍待人工確認，AbortError 分類為取消',async({page})=>{
  await page.evaluate(()=>Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{}}));
  await choose(page,'分享與剪貼簿');await run(page,'share');await expect(result(page)).toContainText('未測試');
  await card(page,'share').getByRole('button',{name:'人工確認成功',exact:true}).click();await expect(result(page)).toContainText('人工確認');
  await page.evaluate(()=>Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new DOMException('cancelled','AbortError');}}));
  await run(page,'share');await expect(result(page)).toContainText('使用者取消');
});
test('localStorage／IndexedDB 重測可讀回上次值，Cache Storage 可讀回',async({page})=>{
  await choose(page,'本機儲存');for(const id of ['local-storage','indexeddb','cache']){await run(page,id);await expect(result(page)).toContainText('成功');}
  await page.reload();await choose(page,'本機儲存');for(const id of ['local-storage','indexeddb']){await run(page,id);await expect(result(page)).toContainText('先前值');await expect(result(page)).not.toContainText('先前值 無');}
});
test('只清除本 App 資料，其他 localStorage／快取保留',async({page})=>{
  await expect(page.locator('#apply-update')).toBeHidden();
  await page.evaluate(async()=>{localStorage.setItem('other-app','keep');await caches.open('other-app-cache');});
  await run(page,'environment');await expect(page.locator('#count')).toHaveText('1');await page.getByText('清除本 App 資料',{exact:true}).click();await page.locator('#clear').click();
  await expect(page.locator('#notice')).toContainText('本 App 資料已清除');await expect(page.locator('#count')).toHaveText('0');
  await expect(page.locator('#apply-update')).toBeHidden();
  expect(await page.evaluate(()=>localStorage.getItem('other-app'))).toBe('keep');expect(await page.evaluate(async()=>(await caches.keys()).includes('other-app-cache'))).toBeTruthy();
  await page.reload();await expect(page.locator('#count')).toHaveText('0');
});
test('Canvas、WebAssembly、Worker 與 Crypto 使用真實回傳值驗證',async({page})=>{
  await choose(page,'圖形與計算');for(const id of ['canvas','wasm','worker','crypto']){await run(page,id);await expect(result(page)).toContainText('成功');}
});
test('IndexedDB 不可用時顯示記憶體模式，仍可操作與匯出',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'indexedDB',{configurable:true,value:{open:()=>{throw new Error('blocked test');}}}));await page.reload();await expect(page.locator('#notice')).toContainText('記憶體');
  await run(page,'environment');await expect(result(page)).toContainText('成功');await expect(page.locator('#notice')).toContainText('記憶體');
});
test('模擬感測器授權與資料、停止時移除監聽',async({page})=>{
  await page.evaluate(()=>{
    class Motion extends Event { static async requestPermission(){return 'granted';} }
    Object.defineProperty(window,'DeviceMotionEvent',{configurable:true,value:Motion});
    window.emitMotion=()=>{const event=new Event('devicemotion');Object.defineProperties(event,{acceleration:{value:{x:1,y:2,z:3}},accelerationIncludingGravity:{value:{x:1,y:2,z:9}},rotationRate:{value:{alpha:1,beta:2,gamma:3}}});dispatchEvent(event);};
  });
  await choose(page,'動作與方向');await run(page,'motion');await expect(result(page)).toContainText('等待');await page.evaluate(()=>window.emitMotion());await expect(result(page)).toContainText('有效感測資料');
  await page.getByRole('button',{name:'停止目前操作'}).click();const count=await page.locator('#count').textContent();await page.evaluate(()=>window.emitMotion());await expect(page.locator('#count')).toHaveText(count);
});
test('模擬權限視窗尚未完成時停止，不重新啟動感測器',async({page})=>{
  await page.evaluate(()=>{class Motion extends Event{static requestPermission(){return new Promise(resolve=>{window.resolvePermission=()=>resolve('granted');});}}Object.defineProperty(window,'DeviceMotionEvent',{configurable:true,value:Motion});});
  await choose(page,'動作與方向');await run(page,'motion');await page.getByRole('button',{name:'停止目前操作'}).click();await page.evaluate(()=>window.resolvePermission());
  await expect(card(page,'motion').locator('[data-run]')).toBeEnabled();await expect(page.locator('#count')).toHaveText('1');await expect(result(page)).toContainText('使用者取消');
});
test('模擬麥克風录音回放，切換分類後釋放串流與 AudioContext',async({page})=>{
  await page.evaluate(()=>{
    window.tracksStopped=0;window.audioClosed=0;
    const track={stop:()=>window.tracksStopped++};const stream=new MediaStream();stream.getTracks=()=>[track];stream.getAudioTracks=()=>[track];stream.getVideoTracks=()=>[];
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>stream}});
    class Audio {async resume(){}async close(){window.audioClosed++;}createMediaStreamSource(){return{connect:()=>{}};}createAnalyser(){return{fftSize:32,getByteTimeDomainData:array=>array.fill(128)};}}
    Object.defineProperty(window,'AudioContext',{configurable:true,value:Audio});
    class Recorder{constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fake audio'],{type:'audio/webm'})});this.onstop?.();}}
    Object.defineProperty(window,'MediaRecorder',{configurable:true,value:Recorder});
  });
  await choose(page,'麥克風');await run(page,'microphone');await expect(result(page)).toContainText('成功');
  await run(page,'record');await expect(result(page)).toContainText('錄製中');await page.getByRole('button',{name:'停止錄製並回放'}).click();await expect(result(page)).toContainText('錄製完成');await expect(page.locator('#live audio')).toHaveCount(1);
  await choose(page,'環境與顯示');expect(await page.evaluate(()=>window.tracksStopped)).toBe(1);expect(await page.evaluate(()=>window.audioClosed)).toBe(1);
});
