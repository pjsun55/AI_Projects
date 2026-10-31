import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Public synthetic fixtures, intercepted Gemini, and an isolated test browser.
export async function runQuizBrowser(page, { version, output, onPhase = () => {} }) {
  const key='fixture_only_invalid_key_000000000000',pattern='https://generativelanguage.googleapis.com/**';
  const read=name=>page.evaluate(async({version,name})=>(await import('./storage.mjs?v='+version)).read(name),{version,name});
  const original=await read('vocabulary-v1'),originalLevel=(await read('library-v2')).settings.quizLevel || 'B1';
  assert.ok(!await read('gemini-key-v1'),'Previous guide suite must remove its synthetic Key');
  let requests=0;
  const handler=async route=>{
    if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'content-type,x-goog-api-key'}});return;}
    requests++;
    const request=route.request(),body=request.postDataJSON(),input=JSON.parse(body.contents[0].parts[0].text);
    assert.equal(input.task,'vocabulary-cloze');assert.equal(input.words.length,3);assert.ok(body.systemInstruction.parts[0].text.includes('本題目標 CEFR '+input.level));
    assert.ok(input.words.every(word=>Object.keys(word).sort().join(',')==='language,word'));
    assert.equal(request.headers()['x-goog-api-key'],key);assert.ok(!request.postData().includes(key));
    await route.fulfill({status:200,contentType:'text/event-stream',headers:{'Access-Control-Allow-Origin':'*'},body:'data: '+JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({title:'A short journey',passage:'We thought about {{1}} as we left home. Near {{2}}, we stopped to discuss {{3}}. <script>literal fixture text</script>',translation:'我們出門前思考旅程，途中停下來討論下一步的安排。',explanations:input.words.map(word=>({meaning:'中文意思 '+word.word,reason:'前後文提供位置或行動線索。 <script>literal explanation</script>',memory:'聯想旅途中使用這個字的情境。'}))})}]},finishReason:'STOP'}]})+'\n\n'});
  };
  await page.route(pattern,handler);
  try{
    onPhase('quiz-setup');
    await page.evaluate(async({version,key})=>{
      const storage=await import('./storage.mjs?v='+version),vocabulary=await import('./vocabulary.mjs?v='+version),vault=await import('./key-vault.mjs?v='+version);
      const old=await storage.read('vocabulary-v1');let book=old||vocabulary.emptyVocabulary();
      for(const [index,word] of ['harbor','valley','shelter'].entries())if(!book.words.some(item=>item.word===word))book=vocabulary.addWord(book,{word,language:'en'},{id:'native-quiz-'+index});
      await storage.commitVocabulary({...book,revision:(old?.revision||0)+1},{expectedRevision:old?.revision||0,expectedGeneration:book.generation});
      await storage.setGeminiKey(await vault.encryptApiKey(key),await storage.dataGeneration());
    },{version,key});
    await page.reload();await page.waitForFunction(()=>!document.getElementById('start-import').disabled);
    await page.locator('[data-tab="vocabulary"]').click();
    await expect(page.locator('#vocabulary-search')).toHaveCount(0);await expect(page.locator('#generate-quiz')).toBeEnabled();assert.equal(requests,0);
    await page.locator('#quiz-level').selectOption('A2');await expect.poll(async()=>(await read('library-v2')).settings.quizLevel).toBe('A2');
    await page.reload();await page.locator('[data-tab="vocabulary"]').click();await expect(page.locator('#quiz-level')).toHaveValue('A2');await expect(page.locator('#generate-quiz')).toBeEnabled();assert.equal(requests,0);
    await page.locator('#generate-quiz').click();await expect(page.locator('#quiz-form')).toBeVisible();await expect(page.locator('#quiz-passage input')).toHaveCount(3);assert.equal(requests,1);
    await expect(page.locator('#quiz-passage script')).toHaveCount(0);await expect(page.locator('#quiz-translation')).toContainText('我們出門前');
    const question=await read('vocabulary-quiz-v1'),before=await read('vocabulary-v1');
    assert.equal(question.level,'A2');await expect(page.locator('#quiz-heading')).toContainText('A2 · ');
    for(const [index,word] of question.words.entries()){const letters=Array.from(word.word);await expect(page.locator('#quiz-hint-'+(index+1))).toHaveText(letters.length>2?letters[0]+'…'+letters.at(-1):word.word);await expect(page.locator('#quiz-hint-'+(index+1))).toBeHidden();await expect(page.locator('#quiz-answer-'+(index+1))).toHaveAttribute('placeholder',letters.length>2?letters[0]+'…'+letters.at(-1):word.word);}
    onPhase('quiz-offline-submit');
    await page.context().setOffline(true);
    for(let i=0;i<3;i++)await page.locator('#quiz-answer-'+(i+1)).fill(i===1?'wrong-answer':question.words[i].word.toUpperCase());
    await page.locator('#submit-quiz').click();await expect(page.locator('#quiz-results')).toContainText('2 / 3');await expect(page.locator('#submit-quiz')).toBeDisabled();
    await expect(page.locator('#quiz-results details[open]')).toHaveCount(1);await expect(page.locator('#quiz-results')).toContainText('情境解析｜');await expect(page.locator('#quiz-results')).toContainText('記憶線索｜');await expect(page.locator('#quiz-results script')).toHaveCount(0);assert.equal(requests,1);
    const after=await read('vocabulary-v1');
    question.words.forEach((selected,index)=>{
      const old=before.words.find(word=>word.id===selected.id).quizStats,next=after.words.find(word=>word.id===selected.id).quizStats;
      assert.equal(next.correct-old.correct,index===1?0:1);assert.equal(next.incorrect-old.incorrect,index===1?1:0);
    });
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Quiz must fit phone and tablet widths');
    await page.screenshot({path:new URL('quiz-result.png',output).pathname});
    await page.context().setOffline(false);await page.reload();await page.locator('[data-tab="vocabulary"]').click();
    await expect(page.locator('#quiz-results')).toContainText('2 / 3');assert.equal(requests,1);
    await page.locator('#quiz-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    assert.equal((await read('vocabulary-v1')).revision,after.revision,'Reopened completed quiz never scores twice');
    await page.locator('#quiz-level').selectOption('B1');await expect.poll(async()=>(await read('library-v2')).settings.quizLevel).toBe('B1');assert.equal((await read('vocabulary-quiz-v1')).level,'A2');assert.equal(requests,1);
    onPhase('quiz-repeat-round');await expect(page.locator('#retry-quiz')).toBeVisible();await expect(page.locator('#retry-quiz')).toBeEnabled();
    await page.locator('#retry-quiz').click();await expect.poll(async()=>(await read('vocabulary-quiz-v1')).id).not.toBe(question.id);
    const second=await read('vocabulary-quiz-v1');assert.equal(second.level,'B1');await expect(page.locator('#retry-quiz')).toBeHidden();
    for(let i=0;i<3;i++){await expect(page.locator('#quiz-answer-'+(i+1))).toHaveValue('');await page.locator('#quiz-answer-'+(i+1)).fill(second.words[i].word);}
    await page.locator('#submit-quiz').click();await expect(page.locator('#quiz-results')).toContainText('3 / 3');await expect(page.locator('#retry-quiz')).toBeEnabled();
    const secondBook=await read('vocabulary-v1');assert.equal(secondBook.words.reduce((sum,word)=>sum+word.quizStats.correct,0),after.words.reduce((sum,word)=>sum+word.quizStats.correct,0)+3);assert.equal(requests,2);

    onPhase('local-choice');
    await page.evaluate(async({version})=>{
      const storage=await import('./storage.mjs?v='+version),domain=await import('./vocabulary.mjs?v='+version),book=await storage.read('vocabulary-v1');let next=book;
      for(const [word,translation] of [['harbor','港口'],['valley','山谷'],['shelter','避難所']]){const item=next.words.find(item=>item.word===word);next=domain.editWord(next,item.id,{translation});}
      await storage.commitVocabulary({...next,revision:book.revision+1},{expectedRevision:book.revision,expectedGeneration:book.generation});
      await storage.setGeminiKey(null,await storage.dataGeneration());
    },{version});
    await page.reload();await page.locator('[data-tab="vocabulary"]').click();await page.locator('#practice-mode').selectOption('choice');
    for(const direction of ['en-zh','zh-en']){
      const fixture=await page.evaluate(async({version,direction})=>{
        const storage=await import('./storage.mjs?v='+version),domain=await import('./choice-quiz.mjs?v='+version);
        const quiz=domain.createChoiceQuiz(await storage.read('vocabulary-v1'),max=>direction==='en-zh'?0:max-1);await storage.saveChoiceQuiz(quiz);return quiz;
      },{version,direction});
      await page.locator('#practice-mode').selectOption('cloze');await page.locator('#practice-mode').selectOption('choice');
      await expect(page.locator('#choice-options button')).toHaveCount(3);
      const target=fixture.options.find(item=>item.id===fixture.targetId);await expect(page.locator('#choice-prompt')).toHaveText(direction==='en-zh'?target.word:target.translation);
      const selected=direction==='en-zh'?fixture.options.find(item=>item.id!==fixture.targetId).id:fixture.targetId;
      const beforeChoice=await read('vocabulary-v1');await page.context().setOffline(true);
      await page.locator('#choice-options button[data-word-id="'+selected+'"]').click();await expect(page.locator('#choice-result')).toContainText('正確答案：');
      await expect(page.locator('#choice-options button:disabled')).toHaveCount(3);
      const afterChoice=await read('vocabulary-v1'),field=selected===fixture.targetId?'correct':'incorrect';
      assert.equal(afterChoice.words.find(item=>item.id===fixture.targetId).quizStats[field],beforeChoice.words.find(item=>item.id===fixture.targetId).quizStats[field]+1);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.context().setOffline(false);
    }
    await page.context().setOffline(true);await page.locator('#next-choice').click();await expect(page.locator('#choice-options button:enabled')).toHaveCount(3);assert.equal(requests,2);

  }finally{
    await page.context().setOffline(false);await page.unroute(pattern,handler);
    await page.evaluate(async({version,original,originalLevel})=>{
      const storage=await import('./storage.mjs?v='+version),current=await storage.read('vocabulary-v1');
      if(original)await storage.commitVocabulary({...original,revision:current.revision+1},{expectedRevision:current.revision,expectedGeneration:current.generation});
      const domain=await import('./library.mjs?v='+version),library=await storage.read('library-v2');await storage.commitLibrary({...domain.changeSettings(library,{quizLevel:originalLevel}),revision:library.revision+1},{expectedRevision:library.revision});
      await storage.write('vocabulary-choice-v1',null);await storage.write('vocabulary-quiz-v1',null);await storage.setGeminiKey(null,await storage.dataGeneration());
    },{version,original,originalLevel});
    await page.reload();
  }
  console.log(JSON.stringify({quiz:'PASS',requests,offlineGrading:'PASS',counters:'PASS',savedResultReload:'PASS'}));
}
