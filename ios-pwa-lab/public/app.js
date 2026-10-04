import { VERSION, STATES, CACHE_PREFIX, classifyError, makeResult, mode, Resources } from './core.js';
import { CATEGORIES, TESTS } from './catalog.js';
import { ResultStore } from './storage.js';
import { createProbes, download } from './probes.js';
const $ = selector => document.querySelector(selector);
const environment = { mode: mode(), secure: isSecureContext };
const resources = new Resources(), store = new ResultStore();
let results = [], persistent = false, category = CATEGORIES[0], runToken = 0, busy = false, registration, currentTestId;
let clearing = false, writeQueue = Promise.resolve();
const operated = new Set(), waiting = new Set();
const events = [];
const notice = message => { $('#notice').textContent = message; };
function show(value, replace = false) {
  if(replace) $('#live').replaceChildren();
  const pre = document.createElement('pre'); pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); $('#live').append(pre);
}
function element(tag, content = '') { const node = document.createElement(tag); node.textContent = content; $('#live').append(node); return node; }
async function finish(id, outcome) {
  if(clearing) return;
  const result = makeResult({ id, ...outcome, environment, device: { model: $('#model').value, ios: $('#ios').value } });
  if(outcome.status==='untested' && (outcome.summary.startsWith('等待') || outcome.summary.includes('錄製中'))) waiting.add(id); else waiting.delete(id);
  results.push(result); renderResults();
  const task = writeQueue.then(async()=>{
    if(persistent) { try { await store.put(result); } catch(e) { persistent=false;notice(`儲存失敗：${e.message}。結果只在記憶體，請立即匯出。`); } }
  });
  writeQueue=task.catch(()=>{});await task;
}
const probes = createProbes({resources,show,element,finish,store,environment,version:VERSION,
  text:()=>document.querySelector('[data-text]')?.value || '你好，這是 iOS PWA Lab 測試。',
  lifecycle:()=>events.slice() });
function renderResults() {
  const filter=$('#mode-filter').value;
  const selected=results.filter(result=>filter==='all'||result.mode===filter);
  $('#count').textContent=String(selected.length);$('#results').replaceChildren();
  if(!selected.length){const p=document.createElement('p');p.textContent='尚無紀錄。選擇分類開始測試。';$('#results').append(p);return;}
  for(const result of selected.slice().reverse().slice(0,100)) {
    const row=document.createElement('article');row.className='record';
    const title=document.createElement('strong');title.textContent=TESTS.find(test=>test.id===result.testId)?.title||result.testId;
    const state=document.createElement('span');state.className=result.status;state.textContent=STATES[result.status];
    const details=document.createElement('small');details.textContent=`${new Date(result.time).toLocaleString('zh-TW')} · ${result.mode} · ${result.evidence} · v${result.version}`;
    const summary=document.createElement('p');summary.textContent=result.summary;row.append(title,state,details,summary);$('#results').append(row);
  }
  if(selected.length>100){const p=document.createElement('p');p.textContent='畫面顯示最新 100 筆；匯出包含全部紀錄。';$('#results').append(p);}
}
function controls(test) {
  const container=document.createElement('div');container.className='controls';
  if(test.control==='text'){const label=document.createElement('label');label.textContent='測試文字';const input=document.createElement('textarea');input.dataset.text='';input.value='你好，這是 iOS PWA Lab 測試。';label.append(input);container.append(label);}
  if(test.control==='keyboard'){for(const [type,labelText] of [['text','文字鍵盤'],['number','數字鍵盤']]){const label=document.createElement('label');label.textContent=labelText;const input=document.createElement('input');input.type=type;input.inputMode=type==='number'?'decimal':'text';label.append(input);container.append(label);}}
  if(test.control==='files'){const label=document.createElement('label');label.textContent='選擇照片／影片／檔案';const input=document.createElement('input');input.type='file';input.multiple=true;input.dataset.files='';label.append(input);container.append(label);}
  if(test.control==='system') {
    const label=document.createElement('label');label.textContent='電話或電子郵件目標（不保存）';const input=document.createElement('input');input.type='text';label.append(input);container.append(label);
    for(const [protocol,title] of [['tel','電話'],['sms','簡訊'],['mailto','郵件']]){const link=document.createElement('a');link.className='link-button';link.textContent=`開啟${title}`;link.href='#';link.onclick=e=>{const value=input.value.trim();if(!value){e.preventDefault();notice('請先填寫目標。');}else{link.href=`${protocol}:${encodeURIComponent(value)}`;}};container.append(link);}
  }
  return container;
}
function renderCategory() {
  $('#category-index').textContent=`${String(CATEGORIES.indexOf(category)+1).padStart(2,'0')} / ${CATEGORIES.length} CATEGORIES`;
  $('#category-title').textContent=category.title;$('#category-note').textContent=category.note;$('#tests').replaceChildren();
  for(const button of $('#categories').children) button.setAttribute('aria-pressed',String(button.dataset.category===category.id));
  for(const test of category.tests){
    const card=document.createElement('article');card.className='test-card';card.dataset.test=test.id;
    const copy=document.createElement('div');const title=document.createElement('h3');title.textContent=test.title;const description=document.createElement('p');description.textContent=test.note;const api=document.createElement('span');api.className='state';
    let supported=false;try{supported=!!test.detect();}catch{}
    api.textContent=`API 偵測：${supported?'介面存在（尚未操作驗證）':'未提供介面'}${test.fixed?` · ${STATES[test.fixed]}`:''}`;copy.append(title,description,api);
    const actions=document.createElement('div');actions.className='actions';
    const detect=document.createElement('button');detect.textContent='記錄偵測';detect.onclick=()=>{void finish(test.id,{status:test.fixed|| (supported?'untested':'unsupported'),summary:api.textContent,evidence:'API 偵測'});};
    const run=document.createElement('button');run.textContent=test.fixed?'記錄限制':'開始測試';run.className='primary';run.dataset.run=test.id;run.onclick=()=>{void execute(test);};
    actions.append(detect,run);card.append(copy,actions,controls(test));
    if(!test.fixed){const confirm=document.createElement('div');confirm.className='actions controls';for(const [state,label]of [['success','人工確認成功'],['failed','人工確認失敗']]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{if(!operated.has(test.id)){notice('請先執行測試，再確認效果。');return;}void finish(test.id,{status:state,summary:'使用者確認本項操作效果；非自動驗證',evidence:'人工確認'});};confirm.append(button);}card.append(confirm);}
    $('#tests').append(card);
  }
}
async function execute(test) {
  if(busy){notice('另一項操作正在等待回應，請先停止或等它完成。');return;}
  const token=++runToken;busy=true;currentTestId=test.id;
  const button=document.querySelector(`[data-run="${test.id}"]`);button.disabled=true;notice(`正在測試：${test.title}`);
  try {
    if(test.fixed){await finish(test.id,{status:test.fixed,summary:test.note,evidence:'限制說明'});return;}
    let supported=false;try{supported=!!test.detect();}catch{}
    if(!supported){await finish(test.id,{status:'unsupported',summary:'此環境未提供必要 API',evidence:'API 偵測'});return;}
    const handler=probes[test.id];if(!handler)throw new Error('未實作操作');
    operated.add(test.id);
    // Invoke before awaiting anything to retain the button's transient activation.
    const outcome=await handler();
    if(token!==runToken)return;
    await finish(test.id,outcome);notice(`${test.title}：${STATES[outcome.status]}。${persistent?'紀錄已保存。':'紀錄只在記憶體，請匯出。'}`);
  } catch(error) {
    if(token!==runToken)return;
    const outcome=classifyError(error);await finish(test.id,outcome);notice(`${test.title}：${outcome.summary}`);
  } finally { if(token===runToken){busy=false;currentTestId=null;}button.disabled=false; }
}
function stop(message='已停止操作並釋放媒體、定位、感測器與其他資源。') {
  if(busy && currentTestId)void finish(currentTestId,{status:'cancelled',summary:'操作等待回應時已停止；遲到的資源將釋放'});
  currentTestId=null;
  runToken++;busy=false;resources.stop();
  for(const id of waiting)void finish(id,{status:'cancelled',summary:'使用者停止或離開前景，尚未完成的測試已取消'});
  waiting.clear();notice(message);for(const button of document.querySelectorAll('[data-run]'))button.disabled=false;
}
function logEvent(name){events.push({event:name,time:new Date().toISOString(),visibility:document.visibilityState});if(events.length>100)events.shift();}
document.addEventListener('visibilitychange',()=>{logEvent('visibilitychange');if(document.visibilityState==='hidden')stop('離開前景：資源已釋放，回來後請重新啟動測試。');});
addEventListener('pagehide',()=>{logEvent('pagehide');stop();});addEventListener('pageshow',()=>logEvent('pageshow'));
let tick=performance.now();setInterval(()=>{const now=performance.now();events.push({event:'timer',intervalMs:Math.round(now-tick),visibility:document.visibilityState});tick=now;if(events.length>100)events.shift();},5000);
const connection=()=>{$('#connection').textContent=navigator.onLine?'連線中 · 硬體能力待實測':'離線 · 僅已快取功能可用';logEvent(navigator.onLine?'online':'offline');};
addEventListener('online',connection);addEventListener('offline',connection);connection();
$('#environment').textContent=`${environment.mode==='pwa'?'主畫面 PWA':'瀏覽器分頁'} · ${isSecureContext?'安全環境':'非安全環境'}`;
for(const entry of CATEGORIES){const button=document.createElement('button');button.textContent=entry.title;button.dataset.category=entry.id;button.onclick=()=>{stop();$('#live').replaceChildren();category=entry;renderCategory();};$('#categories').append(button);}
$('#stop').onclick=()=>stop();$('#mode-filter').onchange=renderResults;
for(const format of ['json','md'])document.querySelector(`#export-${format}`).onclick=async()=>{
  const { report }=await import('./core.js');const selected=results.filter(result=>$('#mode-filter').value==='all'||result.mode===$('#mode-filter').value);
  download(report(selected,format==='json'?'json':'md'),`ios-pwa-lab-${new Date().toISOString().replace(/[:.]/g,'-')}.${format}`,format==='json'?'application/json':'text/markdown');
};
async function deleteProbeDB(){await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase('ios-pwa-lab-probe');request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('測試資料庫被其他分頁占用'));});}
$('#clear').onclick=async()=>{
  clearing=true;stop();
  try{
    await writeQueue;if(persistent)await store.clear();
    // Open a fresh store if startup failed, so old results are not silently retained.
    else if(globalThis.indexedDB){const fresh=new ResultStore();await fresh.open();await fresh.clear();fresh.db.close();}
    if(globalThis.indexedDB)await deleteProbeDB();
    for(const key of ['ios-pwa-lab:device','ios-pwa-lab:probe'])localStorage.removeItem(key);
    if(globalThis.caches)for(const key of await caches.keys())if(key.startsWith(CACHE_PREFIX))await caches.delete(key);
    if(registration)await registration.unregister();registration=null;
    results=[];operated.clear();$('#model').value='';$('#ios').value='';$('#live').replaceChildren();renderResults();$('#apply-update').hidden=true;$('#sw-status').textContent='快取已清除，請連線重新載入以重新建立';
    notice('本 App 資料已清除；其他站點資料未變更。');
  }catch(error){notice(`清除未全部完成：${error.message}。請關閉其他分頁後重試。`);}finally{clearing=false;}
};
for(const input of [$('#model'),$('#ios')])input.onchange=()=>{try{localStorage.setItem('ios-pwa-lab:device',JSON.stringify({model:$('#model').value,ios:$('#ios').value}));}catch(error){notice(`機型設定未保存：${error.message}`);}};
async function setupServiceWorker(){
  if(!isSecureContext||!navigator.serviceWorker){$('#sw-status').textContent='Service Worker 需要 HTTPS 或 localhost 與瀏覽器支援';return;}
  try{
    registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
    const update=()=>{if(registration?.waiting){$('#apply-update').hidden=false;$('#sw-status').textContent='新版已完整快取，請套用更新。';}};
    update();registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'){update();if(!navigator.serviceWorker.controller)$('#sw-status').textContent=`離線快取就緒 · v${VERSION}`;}});});
    await navigator.serviceWorker.ready;
    if(!registration.waiting)$('#sw-status').textContent=`離線快取就緒 · v${VERSION}`;
  }catch(error){$('#sw-status').textContent=`快取未就緒：${error.message}`;}
}
$('#check-update').onclick=async()=>{try{if(!registration){await setupServiceWorker();return;}await registration.update();notice(registration.waiting?'新版可套用。':'更新檢查已完成；若有新版請等下載完成。');}catch(error){notice(`更新檢查失敗：${error.message}`);}};
$('#apply-update').onclick=()=>{if(!registration?.waiting)return;stop();let reloaded=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!reloaded){reloaded=true;location.reload();}},{once:true});registration.waiting.postMessage({type:'SKIP_WAITING'});};
renderCategory();
try{const saved=JSON.parse(localStorage.getItem('ios-pwa-lab:device')||'{}');$('#model').value=saved.model||'';$('#ios').value=saved.ios||'';}catch{}
try{await store.open();results=await store.all();persistent=true;notice('準備就緒。選擇分類，按「開始測試」。');}catch(error){notice(`IndexedDB 無法保存：${error.message}。目前使用記憶體，離開前請匯出。`);}
renderResults();void setupServiceWorker();
