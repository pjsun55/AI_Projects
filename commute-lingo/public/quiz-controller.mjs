import { validateVocabulary } from './vocabulary.mjs?v=0.2.36';
import * as storage from './storage.mjs?v=0.2.36';
import { GEMINI_KEY, decryptApiKey } from './key-vault.mjs?v=0.2.36';
import { generateQuiz } from './gemini.mjs?v=0.2.36';
import { QUIZ_KEY, QUIZ_JOB_KEY, validateQuizLevel, pickQuizWords, validateQuiz, quizMatches, quizParts, gradeQuiz } from './quiz.mjs?v=0.2.36';

export function createQuizController({ getBook, getModel, available, notify, saved, broadcast, getLevel = () => 'B1', saveLevel = async () => {} }) {
  const $=id=>document.getElementById(id);
  const element=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
  let quiz, active, submitting=false, levelSaving=false, hasKey=false, epoch=0, lifetime=0, externalJob, timer, message='', invalid=false;
  function controls() {
    clearTimeout(timer);
    let enough=true;try{pickQuizWords(getBook().words,()=>0);}catch{enough=false;}
    const running=!!active || externalJob?.generation===getBook().generation && externalJob?.id!==quiz?.id && Date.now()-externalJob.startedAt<190000;
    const ready=available();
    if(!levelSaving)$('quiz-level').value=getLevel();
    $('quiz-level').disabled=!!running || submitting || levelSaving || !ready;
    $('generate-quiz').disabled=!!running || submitting || levelSaving || !enough || !hasKey || !ready;
    $('generate-quiz').textContent=running?'出題中…':quiz?.graded?'再測一次':quiz?'重新抽題':'隨機出題';
    $('retry-quiz').hidden=!quiz?.graded;$('retry-quiz').disabled=$('generate-quiz').disabled;$('retry-quiz').textContent=running?'出題中…':'再測一次';
    $('cancel-quiz').hidden=!active;
    $('quiz-status').textContent=running?'AI 正在編寫短文…':message||(!enough?'至少收藏 3 個不同拼字的單字。':!hasKey?'請先在設定保存 Gemini API Key。':!ready?'資料處理中，完成後即可再測。':quiz?.graded?'已完成，可按「再測一次」。':quiz?'':'隨機抽 3 個單字，生成短文填空。');
    $('quiz-status').classList.toggle('error-text',!!message);
    $('submit-quiz').disabled=submitting || !!running || !quiz || quiz.graded || invalid || !available();
    $('submit-quiz').textContent=submitting?'保存中…':'對答案';
    $('quiz-panel').setAttribute('aria-busy',String(!!running || submitting));
    if(running || hasKey && enough && !ready)timer=setTimeout(controls,1000);
  }
  function render() {
    const root=$('quiz-passage');root.replaceChildren();$('quiz-results').replaceChildren();
    $('quiz-form').hidden=!quiz;
    if(quiz) {
      $('quiz-heading').textContent=(quiz.level?quiz.level+' · ':'')+quiz.title;$('quiz-translation').textContent=quiz.translation;
      for(const part of quizParts(quiz.passage)) {
        if(part.text!==undefined)root.append(document.createTextNode(part.text));
        else {
          const wrap=element('span','quiz-blank'),label=element('label','quiz-number',String(part.blank));label.htmlFor='quiz-answer-'+part.blank;
          const input=element('input','quiz-answer');Object.assign(input,{id:'quiz-answer-'+part.blank,type:'text',maxLength:80,required:true,autocomplete:'off',spellcheck:false});
          const word=quiz.words[part.blank-1].word.normalize('NFC');
          const letters=typeof Intl.Segmenter==='function'?Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(word),item=>item.segment):Array.from(word);
          const hint=element('span','quiz-letter-hint',letters.length>2?letters[0]+'…'+letters[letters.length-1]:letters.join(''));
          hint.hidden=true;input.placeholder=hint.textContent;
          hint.id='quiz-hint-'+part.blank;hint.setAttribute('aria-label',letters.length>1?'提示：首字 '+letters[0]+'，尾字 '+letters[letters.length-1]:'提示：'+letters[0]);
          input.setAttribute('autocapitalize','none');input.setAttribute('aria-label','第 '+part.blank+' 空，請輸入完整單字');input.setAttribute('aria-describedby',hint.id);input.name='answer-'+part.blank;
          input.value=quiz.answers?.[part.blank-1]||'';input.disabled=quiz.graded || invalid;
          wrap.append(label,hint,input);root.append(wrap);
        }
      }
      if(quiz.graded) {
        const results=gradeQuiz(quiz,quiz.answers),total=results.filter(result=>result.correct).length;
        $('quiz-results').append(element('strong','',`${total} / 3 答對`));
        results.forEach((result,index)=>{
          const word=getBook().words.find(word=>word.id===result.id),stats=word?.quizStats||{correct:0,incorrect:0};
          const row=element('p',result.correct?'quiz-correct':'quiz-incorrect');
          row.textContent=`${index+1}. ${result.correct?'答對':'答錯'} · ${result.correct?'':'正確答案：'}${result.word}${result.correct?'':`（你的答案：${result.answer}）`} · 累計答對 ${stats.correct}／答錯 ${stats.incorrect}`;
          const explanation=quiz.explanations?.[index],section=element('section','quiz-result-item');section.append(row);
          if(explanation){
            const details=element('details','quiz-explanation');if(!result.correct)details.setAttribute('open','');
            details.append(element('summary','',result.correct?'查看答案解析':'為什麼是這個答案？'),element('p','',`中文意思｜${explanation.meaning}`),element('p','',`情境解析｜${explanation.reason}`),element('p','quiz-memory',`記憶線索｜${explanation.memory}`));section.append(details);
          }else if(!result.correct){
            if(word?.translation)section.append(element('p','quiz-explanation',`中文意思｜${word.translation}`));
            section.append(element('p','small muted','這是舊題；重新抽題即可取得情境解析與記憶線索。'));
          }
          $('quiz-results').append(section);
        });
      }
    }
    controls();
  }
  async function refresh() {
    const token=++epoch;
    const [record,key,job,book]=await Promise.all([storage.read(QUIZ_KEY),storage.read(GEMINI_KEY),storage.read(QUIZ_JOB_KEY),storage.read('vocabulary-v1')]);
    if(token!==epoch)return;
    if(book?.generation===getBook().generation && book.revision>getBook().revision)saved(validateVocabulary(book));
    hasKey=!!key;externalJob=job;
    let next;try{if(record){next=validateQuiz(record);if(!quizMatches(next,getBook()))next=null;}}catch(error){next=null;if(error.code==='QUIZ_ANSWER_LEAK')message='這份舊題已透露答案，請重新抽題。';}
    if(next?.id===quiz?.id && next?.graded===quiz?.graded){controls();return;}
    quiz=next;invalid=false;render();
  }
  async function start() {
    if(active || submitting || levelSaving)return;
    if(!available()){notify('資料處理中，請稍後再測。');controls();return;}
    const book=getBook();let words,level;
    try{words=pickQuizWords(book.words);level=validateQuizLevel(getLevel());}catch(error){notify(error.message,true);return;}
    const job={controller:new AbortController(),generation:book.generation,words,level};epoch++;active=job;message='';controls();
    let key='',context;
    try {
      const record=await storage.read(GEMINI_KEY);if(!record){hasKey=false;throw Error('請先在設定保存 Gemini API Key。');}
      context={requestId:crypto.randomUUID(),keyId:record.id,generation:book.generation,words,level};
      if(job.controller.signal.aborted || !available())return;
      if(!await storage.updateQuizJob({...context,action:'claim'}))throw Error('另一個視窗正在出題，或單字本／Key 已變更，請稍後再試。');
      broadcast('quiz-changed');key=await decryptApiKey(record);
      if(job.controller.signal.aborted || (await storage.read(GEMINI_KEY))?.id!==record.id)return;
      const output=await generateQuiz({key,model:getModel(),level,text:JSON.stringify({level,task:'vocabulary-cloze',words:words.map(({word,language})=>({word,language}))}),signal:job.controller.signal});
      if(job.controller.signal.aborted)return;
      if(!await storage.updateQuizJob({...context,action:'complete',content:output.content}))throw Error('單字本或Key已變更，這次測驗未保存。');
      epoch++;quiz=validateQuiz({...output.content,id:context.requestId,generation:book.generation,words,level,graded:false});invalid=false;render();$('quiz-panel').scrollIntoView?.({block:'start',behavior:'auto'});broadcast('quiz-changed');
    }catch(error){if(!job.controller.signal.aborted){message=error.message.replaceAll('導讀','測驗');notify(message,true);}}
    finally{key='';if(context && await storage.updateQuizJob({...context,action:'cancel'}).catch(()=>false))broadcast('quiz-changed');if(active===job)active=null;epoch++;externalJob=null;controls();}
  }
  async function submit(event) {
    event.preventDefault();if(!quiz || quiz.graded || submitting || active || invalid || !available())return;
    const answers=[1,2,3].map(id=>$('quiz-answer-'+id).value);
    const token=lifetime;epoch++;submitting=true;message='';controls();
    try {
      const result=await storage.submitQuiz(quiz.id,answers);
      if(result.vocabulary.generation===getBook().generation)saved(result.vocabulary);
      if(token!==lifetime)return;
      epoch++;quiz=result.quiz;render();broadcast('words-changed');broadcast('quiz-changed');
    }catch(error){if(token!==lifetime)return;message=error.message;notify(message,true);}
    finally{submitting=false;controls();}
  }
  function updateControls() {
    if(active && !quizMatches(active,getBook()))active.controller.abort();
    if(quiz && !quizMatches(quiz,getBook())){quiz=null;invalid=false;message='單字本已變更，請重新出題。';render();return;}
    controls();
  }
  $('quiz-level').onchange=async()=>{
    if(active || submitting || levelSaving){controls();return;}
    const level=$('quiz-level').value;levelSaving=true;controls();
    try{await saveLevel(validateQuizLevel(level));}catch(error){notify(error.message,true);}
    finally{levelSaving=false;controls();}
  };
  $('generate-quiz').onclick=()=>void start();
  $('retry-quiz').onclick=()=>void start();
  $('cancel-quiz').onclick=()=>{active?.controller.abort();message='已停止出題。';controls();};
  $('quiz-form').onsubmit=event=>void submit(event);
  return {refresh,render,updateControls,get editing(){return !!quiz && !quiz.graded && [1,2,3].some(id=>!!$('quiz-answer-'+id)?.value.trim());},get busy(){return !!active || submitting || levelSaving;},get saving(){return submitting;},clear(){lifetime++;epoch++;active?.controller.abort();quiz=null;externalJob=null;message='';hasKey=false;invalid=false;render();}};
}
