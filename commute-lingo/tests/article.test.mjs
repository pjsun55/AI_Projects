import test from 'node:test';
import assert from 'node:assert/strict';
import { articleItems, articleSource, articleBatches, articleFingerprint, validateTranslations, savedTranslations, retryArticleBatch, waitForArticleRetry, canRetryArticle, articleErrorLabel } from '../public/article.mjs';
import { translateArticleBatch, GeminiError, parseRetryAfter } from '../public/gemini.mjs';
import { validateSettings } from '../public/library.mjs';
const track = count => ({ alignment: 'word-v1', segments: Array.from({length: count}, (_, id) => ({ start: id*2, end: id*2+2, text: `We follow the train on journey ${id}.` })) });
const key = 'fixture_only_invalid_key_000000000000';
const sse = (value, finishReason = 'STOP') => new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(value)}]},finishReason}]})+'\n\n', {headers:{'Content-Type':'text/event-stream'}});
test('article batches preserve stable sentence IDs and include context beyond the targets', () => {
 const source = track(40), batches=articleBatches(source);
 assert.equal(batches.length,4); assert.deepEqual(batches.flatMap(batch=>batch.targets.map(item=>item.id)), Array.from({length:40},(_,i)=>i));
 for(const batch of batches) { const body=JSON.parse(batch.text);assert.equal(body.task,'article-translation');assert.ok(body.context.includes('journey 0.'));assert.ok(body.context.includes('journey 39.'));assert.ok(batch.text.length<=60000); }
 assert.equal(articleBatches(source,articleItems(source)).length,0);
 assert.deepEqual(articleBatches(source,[{id:2},{id:8}]).flatMap(batch=>batch.targets.map(item=>item.id)),Array.from({length:40},(_,i)=>i).filter(i=>![2,8].includes(i)));
});
test('large articles use a bounded window and reject oversized input before an API call',()=>{
 const source=track(100);source.segments.forEach((segment,i)=>segment.text='word '.repeat(110)+i+'.');
 for(const batch of articleBatches(source)) assert.ok(batch.text.length<=60000);
 source.segments.push({start:201,end:202,text:'x'.repeat(8001)});assert.throws(()=>articleBatches(source));
 assert.throws(()=>articleBatches(track(0)));
 assert.throws(()=>articleBatches(track(769)), /64/);
});
test('translation validation accepts AI wording but rejects missing, duplicate or foreign IDs',()=>{
 const targets=articleItems(track(2));
 const valid={translations:[{id:1,text:'依上下文修正的自然中文。'},{id:0,text:'<img src=x onerror=alert(1)>'}]};
 assert.equal(validateTranslations(valid,targets)[0].id,1);
 for(const translations of [[{id:0,text:'甲'}],[{id:0,text:'甲'},{id:0,text:'乙'}],[{id:0,text:'甲'},{id:4,text:'乙'}],[{id:0,text:'甲'},{id:1,text:''}]]) assert.throws(()=>validateTranslations({translations},targets));
 const source=track(2), record={version:1,source:articleSource(source),items:valid.translations};
 assert.equal(savedTranslations(record,source).length,2); source.segments[0].text+=' Changed.'; assert.deepEqual(savedTranslations(record,source),[]);
});
test('source fingerprint invalidates changed sentence mapping and model',async()=>{
 const source=articleSource(track(2)), model='gemini-3.5-flash-lite';
 assert.equal(await articleFingerprint(source,model),await articleFingerprint(source,model));
 assert.notEqual(await articleFingerprint(source,model),await articleFingerprint(articleSource(track(3)),model));
 assert.notEqual(await articleFingerprint(source,model),await articleFingerprint(source,'other'));
});
test('translation SSE uses fixed HTTPS endpoint and a restricted ID schema, never key in body',async()=>{
 const batch=articleBatches(track(2))[0];let requests=0;
 const result=await translateArticleBatch({key,model:'gemini-3.5-flash-lite',...batch,fetchImpl:async(url,options)=>{
 requests++;assert.match(url,/^https:\/\/generativelanguage\.googleapis\.com\//);assert.equal(options.headers['x-goog-api-key'],key);assert.ok(!options.body.includes(key));assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
 const body=JSON.parse(options.body);assert.ok(body.generationConfig.responseJsonSchema.properties.translations);assert.ok(body.systemInstruction.parts[0].text.includes('不可信'));return sse({translations:batch.targets.map(item=>({id:item.id,text:'這是自然的中文譯文。'}))});
 }});assert.equal(requests,1);assert.equal(result.content.length,2);
});
test('translation rejects truncated or credential-bearing responses and never retries',async()=>{
 const batch=articleBatches(track(1))[0];
 for(const [value,finish,code] of [[{translations:[{id:0,text:'被截斷'}]},'MAX_TOKENS','OUTPUT_LIMIT'],[{translations:[{id:0,text:key}]},'STOP','RESPONSE'],[{translations:[{id:5,text:'錯誤編號'}]},'STOP','FORMAT']]) {
 let requests=0;await assert.rejects(translateArticleBatch({key,model:'gemini-3.5-flash-lite',...batch,fetchImpl:async()=>{requests++;return sse(value,finish);}}),error=>error.code===code);assert.equal(requests,1);
 }
});
test('old preferences default to English only and no extra API job; boolean settings validated',()=>{
 assert.equal(validateSettings({}).bilingual,false);assert.equal(validateSettings({}).translateWithGuide,false);
 assert.equal(validateSettings({bilingual:true,translateWithGuide:true}).bilingual,true);
 assert.throws(()=>validateSettings({bilingual:'true'}));assert.throws(()=>validateSettings({translateWithGuide:1}));
});


test('transient failed batch retries at 3/6/12 seconds with a hard four-request limit',async()=>{
 let calls=0,claims=0;const waits=[],events=[];
 await assert.rejects(retryArticleBatch(async()=>{calls++;throw new GeminiError('HTTP',503);},{beforeAttempt:async()=>{claims++;},wait:async ms=>{waits.push(ms);},onRetry:async event=>{events.push(event.attempt);},random:()=>0}),error=>error.status===503);
 assert.equal(calls,4);assert.equal(claims,4);assert.deepEqual(waits,[3000,6000,12000]);assert.deepEqual(events,[1,2,3]);
});
test('a recovered batch returns the result, and the next batch gets its own retry budget',async()=>{
 const waits=[];let calls=0;
 const send=async()=>{calls++;if(calls%2)throw new GeminiError('NETWORK');return {content:[{id:calls,text:'中文'}]};};
 for(let i=0;i<2;i++)assert.ok((await retryArticleBatch(send,{wait:async ms=>{waits.push(ms);},random:()=>0})).content);
 assert.equal(calls,4);assert.deepEqual(waits,[3000,3000]);
});
test('retryable faults include timeouts and malformed/incomplete data; permanent or unsafe failures stop immediately',async()=>{
 for(const code of ['TIMEOUT','NETWORK','INCOMPLETE','RESPONSE','FORMAT'])assert.ok(canRetryArticle(new GeminiError(code)));
 const unsafe=new GeminiError('RESPONSE');unsafe.retryable=false;
 for(const error of [unsafe,...[400,401,402,403,404,501].map(status=>new GeminiError('HTTP',status)),...['CANCELLED','BLOCKED','OUTPUT_LIMIT','TOO_LARGE'].map(code=>new GeminiError(code)),new Error('local storage failed')]){
  let calls=0;await assert.rejects(retryArticleBatch(async()=>{calls++;throw error;},{wait:async()=>assert.fail('must not wait')}));assert.equal(calls,1);
 }
});
test('Retry-After handles seconds/dates, waits no earlier than the service asks, and refuses excessive automatic waits',async()=>{
 const now=Date.parse('2026-11-15T00:00:00Z');
 assert.equal(parseRetryAfter('10',now),10000);assert.equal(parseRetryAfter('Sun, 15 Nov 2026 00:00:15 GMT',now),15000);
 for(const value of [null,'','nonsense','Sat, 14 Nov 2026 00:00:00 GMT'])assert.equal(parseRetryAfter(value,now),0);
 let calls=0;const waits=[];
 assert.equal(await retryArticleBatch(async()=>{if(!calls++){const error=new GeminiError('HTTP',429);error.retryAfterMs=15000;throw error;}return 'ok';},{wait:async ms=>{waits.push(ms);},random:()=>0.5}),'ok');
 assert.deepEqual(waits,[15500]);
 calls=0;const error=new GeminiError('HTTP',429);error.retryAfterMs=61000;
 await assert.rejects(retryArticleBatch(async()=>{calls++;throw error;},{wait:async()=>assert.fail('no long background sleep')}));assert.equal(calls,1);
});
test('cancellation while waiting or before the first request stops all subsequent API attempts',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(retryArticleBatch(async()=>{calls++;throw new GeminiError('NETWORK');},{signal:controller.signal,wait:async(ms,signal)=>{const pending=waitForArticleRetry(60000,signal);controller.abort();await pending;}}),error=>error.name==='AbortError');assert.equal(calls,1);
 await assert.rejects(retryArticleBatch(async()=>{calls++;},{signal:controller.signal}));assert.equal(calls,1);
});
test('ownership renewal failures never enter the network retry loop',async()=>{
 let calls=0,renews=0;
 await assert.rejects(retryArticleBatch(async()=>{calls++;throw new GeminiError('HTTP',503);},{beforeAttempt:async()=>{if(++renews===2)throw Error('Key changed');},wait:async()=>{},random:()=>0}),/Key changed/);
 assert.equal(calls,1);assert.equal(renews,2);
});
test('HTTP and stream faults keep safe status/delay metadata, while credential output disables retry',async()=>{
 const batch=articleBatches(track(1))[0],options={key,model:'gemini-3.5-flash-lite',...batch};
 await assert.rejects(translateArticleBatch({...options,fetchImpl:async()=>new Response('not logged',{status:429,headers:{'Retry-After':'9'}})}),error=>error.status===429 && error.retryAfterMs===9000 && articleErrorLabel(error)==='額度／頻率限制');
 await assert.rejects(translateArticleBatch({...options,fetchImpl:async()=>new Response('data: '+JSON.stringify({error:{code:503,message:'not logged'}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}})}),error=>error.code==='HTTP' && error.status===503);
 await assert.rejects(translateArticleBatch({...options,fetchImpl:async()=>sse({translations:[{id:0,text:key}]})}),error=>error.code==='RESPONSE' && !canRetryArticle(error) && !error.message.includes(key));
});
