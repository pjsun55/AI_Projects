import { wordIdentity, validateVocabulary } from './vocabulary.mjs?v=0.2.35';
export const CHOICE_KEY = 'vocabulary-choice-v1';
const normalized = text => text.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(value);
function snapshot(word) {
  if (!identifier(word?.id) || word.language !== 'en') throw Error('選擇題單字格式無效。');
  wordIdentity(word.word,word.language);
  if (typeof word.translation !== 'string' || !word.translation.trim() || word.translation.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(word.translation)) throw Error('請先補上單字的中文解釋。');
  return {id:word.id,word:word.word,language:'en',translation:word.translation.trim()};
}
function randomInt(max) {
  const array=new Uint32Array(1),limit=2**32-(2**32%max);
  do {crypto.getRandomValues(array);} while(array[0]>=limit);
  return array[0]%max;
}
function draw(max,random) {
  const value=random(max);
  if(!Number.isInteger(value) || value<0 || value>=max)throw Error('無法抽選單字。');
  return value;
}
export function choicePool(words) {
  const seenWords=new Set(),seenMeanings=new Set(),pool=[];
  for(const word of words) {
    let item;try{item=snapshot(word);}catch{continue;}
    const spelling=normalized(item.word),meaning=normalized(item.translation);
    if(seenWords.has(spelling) || seenMeanings.has(meaning))continue;
    seenWords.add(spelling);seenMeanings.add(meaning);pool.push(item);
  }
  return pool;
}
export function createChoiceQuiz(book,random=randomInt) {
  const pool=choicePool(book.words);
  if(pool.length<3)throw Error('至少需要 3 個附中文解釋、且拼字與解釋不同的英文單字。');
  for(let i=0;i<3;i++){const j=i+draw(pool.length-i,random);[pool[i],pool[j]]=[pool[j],pool[i]];}
  const options=pool.slice(0,3),targetId=options[0].id,direction=draw(2,random)===0?'en-zh':'zh-en';
  for(let i=options.length-1;i>0;i--){const j=draw(i+1,random);[options[i],options[j]]=[options[j],options[i]];}
  return validateChoiceQuiz({id:crypto.randomUUID(),generation:book.generation,options,targetId,direction,selectedId:null});
}
export function validateChoiceQuiz(value) {
  if(!identifier(value?.id) || !identifier(value.generation) || !Array.isArray(value.options) || value.options.length!==3 || !['en-zh','zh-en'].includes(value.direction))throw Error('保存的選擇題格式無效。');
  const options=value.options.map(snapshot);
  if(new Set(options.map(item=>item.id)).size!==3 || choicePool(options).length!==3 || !options.some(item=>item.id===value.targetId) || value.selectedId!==null && !options.some(item=>item.id===value.selectedId))throw Error('選擇題選項無效。');
  return {id:value.id,generation:value.generation,options,targetId:value.targetId,direction:value.direction,selectedId:value.selectedId};
}
export function choiceMatches(quiz,book) {
  return quiz.generation===book?.generation && quiz.options.every(item=>book.words.some(word=>word.id===item.id && wordIdentity(word.word,word.language)===wordIdentity(item.word,item.language) && word.translation.trim()===item.translation));
}
export function applyChoiceScore(book,value,selectedId,now=Date.now()) {
  const quiz=validateChoiceQuiz(value),current=validateVocabulary(book);
  if(quiz.selectedId!==null || !choiceMatches(quiz,current) || !quiz.options.some(item=>item.id===selectedId))throw Error('題目已變更或已作答，請重新出題。');
  const field=selectedId===quiz.targetId?'correct':'incorrect';
  return validateVocabulary({...current,revision:current.revision+1,words:current.words.map(word=>word.id!==quiz.targetId?word:{...word,version:word.version+1,updatedAt:now,quizStats:{...word.quizStats,[field]:word.quizStats[field]+1}})});
}
