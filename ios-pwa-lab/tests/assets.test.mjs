import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {VERSION} from '../public/core.js';
import {TESTS} from '../public/catalog.js';
import {createProbes} from '../public/probes.js';
test('全部能力皆有操作或明確限制，沒有空白實作',()=>{
  const handlers=createProbes({});for(const item of TESTS)assert.ok(item.fixed||typeof handlers[item.id]==='function',item.id);
});
test('版本、manifest scope 與 PNG 圖示一致，shell 全部存在',async()=>{
  const sw=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');assert.ok(sw.includes(`const VERSION = '${VERSION}'`));
  const manifest=JSON.parse(await readFile(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));assert.equal(manifest.scope,'./');assert.equal(manifest.start_url,'./');
  for(const icon of manifest.icons){const bytes=await readFile(new URL('../public/'+icon.src,import.meta.url));assert.equal(bytes.subarray(1,4).toString(),'PNG');const size=Number(icon.sizes.split('x')[0]);assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
  const files=sw.match(/const SHELL = \[(.*?)\];/s)[1].matchAll(/'([^']+)'/g);for(const [,filename] of files)assert.ok((await readFile(new URL('../public/'+filename,import.meta.url))).length);
  const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isDirectory())await walk(new URL(entry.name+'/',dir));else assert.ok(!/\.md$/.test(entry.name));}};await walk(new URL('../public/',import.meta.url));
});
