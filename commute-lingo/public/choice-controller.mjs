import * as storage from './storage.mjs?v=0.2.35';
import { CHOICE_KEY, choicePool, createChoiceQuiz, validateChoiceQuiz, choiceMatches } from './choice-quiz.mjs?v=0.2.35';
export function createChoiceController({getBook,available,saved,notify,broadcast}) {
  const $=id=>document.getElementById(id);
  let quiz=null,busy=false,epoch=0,timer,message='';
  function controls(){
    clearTimeout(timer);
    const ready=available(),enough=choicePool(getBook().words).length>=3;
    $('next-choice').disabled=busy || !ready || !enough;
    $('next-choice').textContent=busy?'保存中…':quiz?.selectedId?'下一題':quiz?'重新抽題':'開始測驗';
    $('choice-status').textContent=message || (!enough?'至少需要 3 個附不同中文解釋的英文單字。':!ready?'資料處理中…':'');
    $('choice-panel').setAttribute('aria-busy',String(busy));
    for(const option of $('choice-options').children)option.disabled=busy || !ready || !!quiz?.selectedId;
    if(!ready)timer=setTimeout(controls,1000);
  }
  function render(){
    $('choice-question').hidden=!quiz;$('choice-options').replaceChildren();$('choice-result').textContent='';
    if(quiz){
      const target=quiz.options.find(item=>item.id===quiz.targetId),answered=quiz.selectedId!==null;
      $('choice-direction').textContent=quiz.direction==='en-zh'?'選出中文意思':'選出英文單字';
      $('choice-prompt').textContent=quiz.direction==='en-zh'?target.word:target.translation;
      for(const item of quiz.options){
        const button=document.createElement('button');button.type='button';button.className='choice-option';button.dataset.wordId=item.id;
        button.textContent=quiz.direction==='en-zh'?item.translation:item.word;
        if(answered){
          if(item.id===quiz.targetId)button.classList.add('choice-right');
          if(item.id===quiz.selectedId && item.id!==quiz.targetId)button.classList.add('choice-wrong');
          button.setAttribute('aria-pressed',String(item.id===quiz.selectedId));
        }
        button.onclick=()=>void answer(item.id);$('choice-options').append(button);
      }
      if(answered){
        const stats=getBook().words.find(item=>item.id===target.id)?.quizStats || {correct:0,incorrect:0};
        $('choice-result').textContent=(quiz.selectedId===quiz.targetId?'答對！':'答錯。')+'正確答案：'+target.word+' — '+target.translation+' · 累計答對 '+stats.correct+'／答錯 '+stats.incorrect;
      }
    }
    controls();
  }
  async function refresh(){
    if(busy)return;
    const token=++epoch;
    const [value,book]=await Promise.all([storage.read(CHOICE_KEY),storage.read('vocabulary-v1')]);
    if(token!==epoch || busy)return;
    if(book?.generation===getBook().generation && book.revision>getBook().revision)saved(book);
    try{quiz=value?validateChoiceQuiz(value):null;if(quiz && !choiceMatches(quiz,getBook()))quiz=null;}catch{quiz=null;}
    render();
  }
  async function start(){
    if(busy || !available())return;
    const token=++epoch;busy=true;message='';controls();
    try{
      const next=createChoiceQuiz(getBook());await storage.saveChoiceQuiz(next);
      if(token!==epoch)return;quiz=next;render();broadcast('choice-changed');
    }catch(error){if(token===epoch){message=error.message;notify(message,true);}}
    finally{busy=false;controls();}
  }
  async function answer(selectedId){
    if(busy || !quiz || quiz.selectedId!==null || !available())return;
    const token=++epoch;busy=true;message='';controls();
    try{
      const result=await storage.submitChoiceQuiz(quiz.id,selectedId);
      if(token!==epoch)return;
      saved(result.vocabulary);quiz=result.quiz;render();broadcast('words-changed');broadcast('choice-changed');
    }catch(error){if(token===epoch){message=error.message;notify(message,true);}}
    finally{busy=false;controls();}
  }
  function updateControls(){if(quiz && !choiceMatches(quiz,getBook())){epoch++;quiz=null;message='單字本已變更，請重新出題。';render();}else controls();}
  $('next-choice').onclick=()=>void start();
  $('practice-mode').onchange=()=>{
    const choice=$('practice-mode').value==='choice';
    $('quiz-panel').hidden=choice;$('choice-panel').hidden=!choice;
    if(choice)void refresh().catch(error=>notify(error.message,true));
  };
  return {refresh,updateControls,get busy(){return busy;},clear(){epoch++;quiz=null;message='';render();}};
}
