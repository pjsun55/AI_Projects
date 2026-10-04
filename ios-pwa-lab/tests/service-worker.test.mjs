import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
function harness({broken=false,version='0.1.0'}={}){
  const scope='https://example.test/AI_Projects/ios-pwa-lab/',listeners={},storage=new Map();let claimed=0,skipped=0,network=0;
  const cache={addAll:async urls=>{if(broken)throw new Error('missing asset');for(const url of urls)storage.set(url,new Response(`cached:${url}`));},match:async url=>storage.get(url)};
  const names=new Set(['ios-pwa-lab:shell-0.0.9','ios-pwa-lab:probe','other-app:shell-1']);
  const caches={open:async name=>{names.add(name);return cache;},keys:async()=>[...names],delete:async name=>names.delete(name)};
  const self={registration:{scope},clients:{claim:async()=>claimed++},skipWaiting:()=>skipped++,addEventListener:(name,fn)=>{listeners[name]=fn;}};
  vm.runInNewContext(source.replace(/const VERSION = '[^']+'/u,`const VERSION = '${version}'`),{self,caches,URL,fetch:async()=>{network++;return new Response('network');}});
  const lifecycle=async name=>{let promise;listeners[name]({waitUntil:p=>{promise=p;}});await promise;};
  const request=async(url,options={})=>{let promise;listeners.fetch({request:{url,method:'GET',mode:'cors',...options},respondWith:p=>{promise=p;}});return promise===undefined?undefined:await promise;};
  return {scope,storage,names,listeners,lifecycle,request,claimed:()=>claimed,skipped:()=>skipped,network:()=>network};
}
test('完整 shell 可安裝並離線取得子目錄首頁、模組與帶 query 資源',async()=>{
  const h=harness();await h.lifecycle('install');assert.equal(h.storage.size,11);
  const home=await h.request(h.scope,{mode:'navigate'});assert.match(await home.text(),/cached:.*index.html/);
  assert.match(await(await h.request(h.scope+'app.js?x=1')).text(),/cached/);assert.equal(h.network(),0);
});
test('快取下載失敗時安裝失敗，不跳過等待啟用新版',async()=>{
  const h=harness({broken:true});await assert.rejects(h.lifecycle('install'),/missing/);assert.equal(h.storage.size,0);assert.equal(h.skipped(),0);
});
test('啟用新版只清除本 App 的舊 shell；保留測試與其他 App 快取',async()=>{
  const h=harness({version:'0.1.1'});await h.lifecycle('install');await h.lifecycle('activate');
  assert.ok(!h.names.has('ios-pwa-lab:shell-0.0.9'));assert.ok(h.names.has('ios-pwa-lab:shell-0.1.1'));assert.ok(h.names.has('ios-pwa-lab:probe'));assert.ok(h.names.has('other-app:shell-1'));assert.equal(h.claimed(),1);
});
test('更新僅在明確 SKIP_WAITING 訊息後切換',()=>{
  const h=harness();h.listeners.message({data:{type:'OTHER'}});assert.equal(h.skipped(),0);h.listeners.message({data:{type:'SKIP_WAITING'}});assert.equal(h.skipped(),1);
});
test('不攔截網路測試檔、其他專案、跨網域與非 GET',async()=>{
  const h=harness();await h.lifecycle('install');
  for(const url of [h.scope+'network-test.json','https://example.test/AI_Projects/other/index.html','https://other.test/app.js'])assert.equal(await h.request(url),undefined);
  assert.equal(await h.request(h.scope+'app.js',{method:'POST'}),undefined);
  assert.equal(await h.request(h.scope+'unknown',{mode:'navigate'}),undefined);
});
