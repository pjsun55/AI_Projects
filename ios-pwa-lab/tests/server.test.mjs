import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../tools/server.mjs';
test('預覽提供正確 MIME、子目錄路徑並阻擋文件／越界／未知路徑',async()=>{
  const server=await createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const prefix of ['/','/ios-pwa-lab/']){const response=await fetch(base+prefix);assert.equal(response.status,200);assert.match(await response.text(),/iOS PWA Lab/);}
    const js=await fetch(base+'/ios-pwa-lab/app.js');assert.match(js.headers.get('content-type'),/javascript/);
    for(const name of ['PROJECT_PLAN.md','DailyReport/20261004-170734.md','%2e%2e%2fPROJECT_PLAN.md','missing'])assert.ok((await fetch(base+'/ios-pwa-lab/'+name)).status>=400);
    assert.equal((await fetch(base+'/ios-pwa-lab/',{method:'POST'})).status,405);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
