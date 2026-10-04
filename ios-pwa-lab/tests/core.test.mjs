import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, Outcome, classifyError, makeResult, report, Resources, mode } from '../public/core.js';
import { TESTS, CATEGORIES } from '../public/catalog.js';
test('狀態覆蓋拒絕、取消、不支援、逾時與單項故障',()=>{
  assert.equal(classifyError({name:'NotAllowedError',message:'denied'}).status,'condition');
  assert.equal(classifyError({name:'AbortError'}).status,'cancelled');
  assert.equal(classifyError({name:'NotSupportedError'}).status,'unsupported');
  assert.equal(classifyError({code:3,message:'timeout'}).status,'condition');
  assert.equal(classifyError(new Error('broken')).status,'failed');
  assert.equal(classifyError(new Outcome('backend','server required')).status,'backend');
  assert.throws(()=>makeResult({status:'invented'}),/未知狀態/);
});
test('結果只保留指定欄位，模式與裝置可分開匯出',()=>{
  const result=makeResult({id:'location',status:'success',summary:'precision 20m',environment:{mode:'pwa',secure:true},device:{model:'iPhone',ios:'27',secret:'private'},latitude:25,photo:'private',now:new Date('2026-10-04T10:00:00Z')});
  const json=JSON.parse(report([result],'json'));
  assert.equal(json.results[0].mode,'pwa');assert.equal(result.time,'2026-10-04T10:00:00.000Z');
  assert.ok(!JSON.stringify(json).includes('private'));assert.ok(!Object.hasOwn(result,'latitude'));
  const markdown=report([{...result,summary:'a|b\n<script>'}],'md');
  assert.ok(markdown.includes('a b &lt;script&gt;'));assert.ok(!markdown.includes('<script>'));
  for(const status of Object.keys(STATES))assert.equal(makeResult({id:'test',status,summary:'test',environment:{mode:'safari-tab',secure:false}}).status,status);
});
test('顯示模式不以 userAgent 猜測 PWA',()=>{
  assert.equal(mode({navigator:{standalone:true}}),'pwa');
  assert.equal(mode({navigator:{},matchMedia:()=>({matches:true})}),'pwa');
  assert.equal(mode({navigator:{userAgent:'iPhone'}}),'safari-tab');
});
test('資源清理可重複、单一失敗不妨礙其他清理',()=>{
  const r=new Resources();const called=[];r.add(()=>called.push('camera'));r.add(()=>{throw new Error('bad cleanup');});r.add(()=>called.push('location'));r.stop();r.stop();assert.deepEqual(called,['location','camera']);
});
test('停止後才回傳的媒體立即釋放，不殘留串流',async()=>{
  const r=new Resources();let resolve;let stopped=0;
  const acquire=r.acquire(new Promise(done=>{resolve=done;}),()=>stopped++);
  r.stop();resolve({});await assert.rejects(acquire,error=>error.status==='cancelled');assert.equal(stopped,1);assert.equal(r.cleanups.length,0);
});
test('成功取得的資源會在停止時釋放',async()=>{
  const r=new Resources();let stopped=0;const resource={};assert.equal(await r.acquire(Promise.resolve(resource),()=>stopped++),resource);r.stop();assert.equal(stopped,1);
});
test('非同步清理失敗不產生未處理的 Promise rejection',async()=>{
  const r=new Resources();let done=false;r.add(()=>{done=true;});r.add(()=>Promise.reject(new Error('release failed')));r.stop();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(done,true);
});
test('分類與能力 id 唯一，包含全部 19 類別與後端／原生限制',()=>{
  assert.equal(CATEGORIES.length,19);assert.equal(new Set(TESTS.map(t=>t.id)).size,TESTS.length);
  assert.ok(TESTS.find(t=>t.id==='push').fixed==='backend');assert.ok(TESTS.find(t=>t.id==='native').fixed==='native');
});
