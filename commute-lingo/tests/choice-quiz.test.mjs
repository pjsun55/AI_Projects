import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyVocabulary,addWord} from '../public/vocabulary.mjs';
import {choicePool,createChoiceQuiz,validateChoiceQuiz,choiceMatches,applyChoiceScore} from '../public/choice-quiz.mjs';
const book=()=>['harbor','valley','shelter','journey'].reduce((value,word,index)=>addWord(value,{word,language:'en',translation:['港口','山谷','避難所','旅程'][index]},{id:'choice-'+index,now:100}),emptyVocabulary());
test('local choice draws three unique pairs, randomizes direction and option order without mutating notebook',()=>{
 const source=book(),before=JSON.stringify(source);
 const english=createChoiceQuiz(source,()=>0),chinese=createChoiceQuiz(source,max=>max-1);
 assert.equal(english.direction,'en-zh');assert.equal(chinese.direction,'zh-en');assert.equal(chinese.options.find(item=>item.id===chinese.targetId).word,'journey');
 assert.equal(english.options.length,3);assert.notEqual(english.options[0].id,english.targetId);assert.equal(JSON.stringify(source),before);
 assert.equal(new Set(english.options.map(item=>item.translation)).size,3);
 assert.throws(()=>createChoiceQuiz(source,()=>-1));
});
test('choice skips missing meanings, non-English entries and duplicate answer labels',()=>{
 const source=book(),[a,b,c,d]=source.words;
 assert.equal(choicePool([a,{...b,translation:a.translation},c,{...d,translation:''},{...d,language:'fr'}]).length,2);
 assert.throws(()=>createChoiceQuiz({...source,words:source.words.slice(0,2)}));
 assert.equal(choicePool([a,{...b,word:a.word},c,d]).length,3);
});
test('answer validation rejects ambiguous labels and invalid targets, selections or direction',()=>{
 const quiz=createChoiceQuiz(book(),()=>0);
 for(const patch of [{direction:'auto'},{targetId:'missing'},{selectedId:'missing'},{options:[quiz.options[0],quiz.options[0],quiz.options[2]]},{options:quiz.options.map(item=>({...item,translation:'相同'}))}])assert.throws(()=>validateChoiceQuiz({...quiz,...patch}));
 assert.deepEqual(validateChoiceQuiz({...quiz,extra:'ignored'}),quiz);
});
test('scores only target and shares existing counters, while snapshot rejects changed meanings or cleared books',()=>{
 const source=book(),quiz=createChoiceQuiz(source,()=>0),wrong=quiz.options.find(item=>item.id!==quiz.targetId).id;
 const next=applyChoiceScore(source,quiz,wrong,200),target=next.words.find(item=>item.id===quiz.targetId);
 assert.deepEqual(target.quizStats,{correct:0,incorrect:1});assert.equal(target.updatedAt,200);
 assert.deepEqual(next.words.filter(item=>item.id!==quiz.targetId),source.words.filter(item=>item.id!==quiz.targetId));
 assert.ok(choiceMatches(quiz,next));assert.equal(choiceMatches(quiz,{...source,generation:'cleared'}),false);
 assert.equal(choiceMatches(quiz,{...source,words:source.words.map(item=>({...item,translation:'changed'}))}),false);
 assert.equal(choiceMatches(quiz,{...source,words:source.words.slice(1)}),false);
 assert.throws(()=>applyChoiceScore(source,{...quiz,selectedId:wrong},wrong));
 const correct=applyChoiceScore(next,quiz,quiz.targetId);assert.deepEqual(correct.words.find(item=>item.id===quiz.targetId).quizStats,{correct:1,incorrect:1});
});
