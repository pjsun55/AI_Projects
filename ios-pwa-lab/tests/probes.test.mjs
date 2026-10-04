import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbes } from '../public/probes.js';
import { Resources, classifyError } from '../public/core.js';
function setup(){const resources=new Resources(),events=[],values=[];const ctx={resources,show:v=>values.push(v),element:()=>({}),finish:(id,value)=>events.push({id,...value}),environment:{mode:'pwa'},version:'0.1.0',text:()=> 'private test text',lifecycle:()=>[]};return{probes:createProbes(ctx),resources,events,values};}
test('定位成功只保存精度與時間，不保存完整座標',()=>{
  const {probes,events,values}=setup();const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{geolocation:{getCurrentPosition:success=>success({coords:{latitude:25.123456,longitude:121.987654,accuracy:5},timestamp:1000})}}});
  try{probes.location();assert.equal(values[0].latitude,25.123456);assert.equal(events[0].status,'success');assert.ok(!events[0].summary.includes('25.123456'));assert.ok(!events[0].summary.includes('121.987654'));}finally{Object.defineProperty(globalThis,'navigator',original);}
});
test('定位拒絕／逾時不判成功，停止追蹤後忽略遲到回呼',()=>{
  const {probes,resources,events}=setup();const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');let receive,stopped;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{geolocation:{getCurrentPosition:(_,error)=>error({code:3}),watchPosition:success=>{receive=success;return 99;},clearWatch:id=>{stopped=id;}}}});
  try{probes.location();assert.equal(events[0].status,'condition');assert.match(events[0].summary,/逾時/);probes['watch-location']();resources.stop();receive({});assert.equal(stopped,99);assert.equal(events.length,1);}finally{Object.defineProperty(globalThis,'navigator',original);}
});
test('媒體拒絕可分類為缺少条件，且不影響後續計算測試',async()=>{
  const {probes}=setup();const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{throw Object.assign(new Error('denied'),{name:'NotAllowedError'});}}}});
  try{await assert.rejects(probes['camera-front'](),error=>classifyError(error).status==='condition');assert.equal((await probes.wasm()).status,'success');assert.equal((await probes.crypto()).status,'success');}finally{Object.defineProperty(globalThis,'navigator',original);}
});
test('真實 AbortController 中止請求判為取消',async()=>{
  const {probes}=setup();const original=globalThis.fetch;
  globalThis.fetch=(url,options)=>original(new URL(url,'http://127.0.0.1:4173/'),options);
  try{await assert.rejects(probes['abort-fetch'](),error=>classifyError(error).status==='cancelled');}finally{globalThis.fetch=original;}
});
