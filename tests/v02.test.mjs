import test from 'node:test';
import assert from 'node:assert/strict';
import {createCard,emptyState,validateState,applyMetadata,undoLatest,expandedRelated,makeAIRequest,parseAIResult,selectReviewCards,recoverTasks,MAX_HISTORY,MAX_REQUEST_CHARS} from '../site/core.js';
import {createCard as oldCard} from './legacy-core.mjs';
import {publicPreferences,parsePreferences} from '../site/model.js';
import {SerialQueue} from '../site/queue.js';

test('migrates 0.1 cards in place without losing original text or accepted links',()=>{
  const old={version:1,cards:[oldCard('读完论文，记录一个尚未回答的问题。','','a'),oldCard('寻找知识缺口，生成研究方向。','','b')],links:[{a:'a',b:'b',type:'同一个问题',reason:'用户确认',createdAt:new Date().toISOString()}],dismissed:[]};
  const migrated=validateState(old);assert.equal(migrated.version,2);assert.equal(migrated.cards[0].raw,old.cards[0].raw);assert.deepEqual(migrated.links,old.links);assert.deepEqual(migrated.cards[0].keywords,[]);assert.equal(migrated.cards[0].task.status,'idle');
  assert.equal(old.version,1);
});
test('AI and manual metadata edits can be undone while raw text remains immutable',()=>{
  const card=createCard('保留当时的原话。','','a'),initial=structuredClone(card);
  applyMetadata(card,{title:'AI 标题',keywords:['原文保留'],origin:'ai'},'ai');
  applyMetadata(card,{title:'手动修正'},'manual');assert.equal(card.history.length,2);
  undoLatest(card);assert.equal(card.title,'AI 标题');undoLatest(card);assert.equal(card.title,initial.title);assert.equal(card.raw,initial.raw);assert.equal(card.origin,'local');assert.throws(()=>undoLatest(card));
  for(let i=0;i<20;i++)applyMetadata(card,{title:`版本 ${i}`},'manual');assert.equal(card.history.length,MAX_HISTORY);
  assert.doesNotThrow(()=>validateState({...emptyState(),cards:[card]}));
});
test('same meaning with different words can be found through transparent language rules',()=>{
  const a=createCard('读完论文，记下作者没有回答的问题。','','a');
  const b=createCard('产品应该帮人发现知识缺口。','','b');
  const c=createCard('今天去公园观察花朵颜色。','','c');
  const result=expandedRelated(a,[a,b,c]);assert.equal(result[0].card.id,'b');assert(result[0].reason.includes('同义表达'));assert(!result.some(item=>item.card.id==='c'));
});
test('model-provided keywords participate in later local retrieval',()=>{
  const a=createCard('手边的碎片怎样再利用？','','a'),b=createCard('把灵感重新组合成有用的项目。','','b');
  a.keywords=['灵感'];assert(expandedRelated(a,[a,b]).some(item=>item.card.id==='b'));
});
test('expanded requests obey count, input-character and excerpt boundaries',()=>{
  const target=createCard('一个完整念头。'.repeat(1000),'','a'),cards=[target];
  for(let i=0;i<20;i++)cards.push(createCard('完全不同的旧想法。'.repeat(1200),'',`b${i}`));
  const bundle=makeAIRequest(target,{...emptyState(),cards});const data=JSON.parse(bundle.prompt.split('待分析数据：\n')[1]);
  assert(data.candidates.length<=8);assert(JSON.stringify(data).length<=MAX_REQUEST_CHARS);assert(data.candidates.every(card=>card.raw.length<=1400));assert.equal(data.idea.raw,target.raw);
});
test('AI may quote only the candidate excerpt that was actually sent',()=>{
  const a=createCard('保留原话作为依据。','','a'),b=createCard('重复的文字'.repeat(500)+'未发送的内容','','b');
  const state={...emptyState(),cards:[a,b]},bundle=makeAIRequest(a,state);
  const result={requestId:bundle.request.requestId,cardId:'a',title:'测试',tags:[],keywords:[],nextStep:'',relations:[{candidateId:'b',type:'同一个问题',reason:'一条提议',targetQuote:'保留原话',candidateQuote:'未发送的内容'}]};
  assert.throws(()=>parseAIResult(JSON.stringify(result),bundle.request,state),/提供的原文/);
});
test('review prioritizes a pending action, respects snooze and completion',()=>{
  const now=new Date('2026-10-03T00:00:00Z'),a=createCard('旧念头。','','a','2026-09-25T00:00:00Z'),b=createCard('新念头。','','b','2026-10-02T00:00:00Z');
  b.nextStep='做一个小动作';let state={...emptyState(),cards:[a,b]};assert.equal(selectReviewCards(state,now)[0].card.id,'b');
  b.snoozedUntil='2026-10-10T00:00:00Z';assert(!selectReviewCards(state,now).some(item=>item.card.id==='b'));
  a.lastReviewedAt='2026-10-02T23:00:00Z';assert.equal(selectReviewCards(state,now).length,0);
});
test('preferences whitelist non-secret settings and never restore auto authorization',()=>{
  const config={endpoint:'https://models.example.test/v1/chat/completions',model:'mine',apiKey:'fake-secret',auto:true,expanded:true};
  const prefs=publicPreferences(config);assert.deepEqual(Object.keys(prefs).sort(),['endpoint','expanded','model','preset']);assert(!JSON.stringify(prefs).includes('fake-secret'));
  const imported=parsePreferences(JSON.stringify({...config}));assert(!Object.hasOwn(imported,'apiKey'));assert(!Object.hasOwn(imported,'auto'));
});
test('reload recovery marks unfinished work without running it',()=>{
  const card=createCard('一张卡片。','','a');card.task={status:'running',error:'',kind:'organize',jobId:'job',owner:'tab',attempts:1,updatedAt:new Date().toISOString()};
  const state={...emptyState(),cards:[card]};assert.equal(recoverTasks(state,'different'),0);assert.equal(recoverTasks(state,'tab'),1);assert.equal(card.task.status,'interrupted');
});
test('queue is serial, survives a failed item and never automatically retries',async()=>{
  let concurrent=0,peak=0,calls=0;const order=[],queue=new SerialQueue();
  const work=id=>async()=>{calls++;concurrent++;peak=Math.max(peak,concurrent);order.push(id);await new Promise(resolve=>setTimeout(resolve,10));concurrent--;if(id===2)throw new Error('failed');return id;};
  const all=await Promise.allSettled([queue.enqueue('a',work(1)),queue.enqueue('b',work(2)),queue.enqueue('c',work(3))]);
  assert.equal(peak,1);assert.deepEqual(order,[1,2,3]);assert.equal(calls,3);assert.equal(all[1].status,'rejected');assert.equal(all[2].value,3);assert.equal(queue.size,0);
});
test('cancelled waiting task is never sent, and in-flight work receives abort',async()=>{
  const queue=new SerialQueue();let calls=0,finish;
  const a=queue.enqueue('a',signal=>new Promise((resolve,reject)=>{calls++;finish=resolve;signal.addEventListener('abort',()=>reject(new Error('cancelled')));}));
  const b=queue.enqueue('b',async()=>{calls++;});const results=Promise.allSettled([a,b]);queue.cancel('b');queue.cancel('a');await results;
  assert.equal(calls,1);assert.equal(queue.size,0);void finish;
});
