import { STORAGE_KEY, RELATION_TYPES, emptyState, createCard, validateState, mergeBackup, safeURL, tagsFromInput, pairKey, relatedSuggestions, fingerprint, makeAIRequest, parseAIResult, applyMetadata, undoLatest, recoverTasks, idleTask, selectReviewCards } from './core.js';
import { validateConnection, callChat, PREFERENCES_KEY, MODEL_PRESETS, publicPreferences, parsePreferences } from './model.js';
import { SerialQueue } from './queue.js';
const $=id=>document.getElementById(id);
const node=(tag,text='',className='')=>{const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;};
let state=emptyState(), persisted=null, storageBlocked=false, view='inbox', tagFilter='', selectedId='', editFingerprint='', aiBundle=null, aiPreview=null, detailDirty=false;
let toastTimer;
let modelConfig=null, modelRevision=0, modelPreferences=null;
let tabId=crypto.randomUUID();
try {tabId=sessionStorage.getItem('shinian.tab.id')||tabId;sessionStorage.setItem('shinian.tab.id',tabId);} catch {}
const TASK_LABELS={idle:'本地已保存',queued:'等待整理',running:'正在整理',preview:'等待你确认',completed:'整理完成',failed:'整理未完成',cancelled:'已取消',interrupted:'上次未完成'};
const queue=new SerialQueue({onChange:()=>renderQueue()});
function updateModelMode(verified=false){$('model-mode').textContent=modelConfig?(verified?'模型已验证':'模型已设置'):'本地整理';}
function stopCalls(){
  queue.cancelAll();modelRevision++;
  safely(()=>commit(next=>{for(const card of next.cards)if(card.task.owner===tabId&&['queued','running','preview'].includes(card.task.status))card.task={...card.task,status:'cancelled',error:'已取消。服务端仍可能已经计费；不会自动重试。',updatedAt:new Date().toISOString()};}));
}
function showModel(){
  const saved=modelConfig||modelPreferences;
  $('model-endpoint').value=saved?.endpoint||'';$('model-name').value=saved?.model||'';$('model-preset').value=saved?.preset||'custom';$('model-expanded').checked=saved?.expanded||false;
  $('model-key').value='';$('model-auto').checked=modelConfig?.auto||false;$('model-remember').checked=Boolean(modelPreferences);
  $('preset-hint').textContent=MODEL_PRESETS[$('model-preset').value].hint;
  $('model-key').placeholder=modelConfig?.apiKey?'当前地址的密钥已在内存中；留空可沿用':'无密钥的个人服务可留空';openDialog('model-dialog');
}
function saveModel(){
  if(!$('model-form').reportValidity())return false;
  const entered=$('model-key').value,endpoint=$('model-endpoint').value.trim();
  const config=validateConnection({endpoint,model:$('model-name').value,apiKey:entered||((modelConfig?.endpoint===endpoint)?modelConfig.apiKey:''),auto:$('model-auto').checked,expanded:$('model-expanded').checked,preset:$('model-preset').value});
  stopCalls();modelConfig=config;$('model-key').value='';$('model-key').placeholder=config.apiKey?'密钥已保留在本页内存；刷新后清除':'无密钥的个人服务';updateModelMode();
  try {if($('model-remember').checked){modelPreferences=publicPreferences(config);localStorage.setItem(PREFERENCES_KEY,JSON.stringify(modelPreferences));}else{modelPreferences=null;localStorage.removeItem(PREFERENCES_KEY);}} catch {toast('当前连接可用，但地址和模型名称没有成功记住');}
  $('model-config-status').textContent='本次连接已设置，尚未经测试。地址或密钥有误时，原话仍会先保存。';return true;
}
async function withModel(prompt,options={}){
  if(!modelConfig)throw new Error('请先连接你自己的模型服务，也可以复制请求到常用 AI');
  const config={...modelConfig},revision=modelRevision;
  const invoke=()=>callChat(config,prompt,options);
  const result=navigator.locks?await navigator.locks.request('shinian-model-request',{signal:options.signal},invoke):await invoke();
  if(revision!==modelRevision||options.signal?.aborted)throw new Error('模型连接已更改或请求已取消，本次结果已忽略');
  updateModelMode(true);return result;
}
function scheduleCard(id,{bundle=null,manual=false,expanded=modelConfig?.expanded||false}={}){
  if(!modelConfig)throw new Error('请先连接自己的模型，随后可以重试；原话已保存');
  const card=state.cards.find(item=>item.id===id);if(!card||card.archived)throw new Error('请先恢复这张卡片再整理');
  if(queue.has(id)||['queued','running'].includes(card.task.status))throw new Error('这张卡片已有任务，请等待或取消后重试');
  const expected=fingerprint(card),jobId=crypto.randomUUID(),revision=modelRevision;
  commit(next=>{const target=next.cards.find(item=>item.id===id);target.task={status:'queued',error:'',kind:'organize',jobId,owner:tabId,attempts:target.task.attempts+1,updatedAt:new Date().toISOString()};});
  const promise=queue.enqueue(id,async signal=>{
    const latest=state.cards.find(item=>item.id===id);
    if(!latest||latest.task.jobId!==jobId||revision!==modelRevision||fingerprint(latest)!==expected)throw new Error('卡片或连接已更改，本次任务停止，不会覆盖新内容');
    const requestBundle=bundle||makeAIRequest(latest,state,undefined,{expanded});
    commit(next=>next.cards.find(item=>item.id===id).task.status='running');
    const result=await withModel(requestBundle.prompt,{signal});
    if(signal.aborted||state.cards.find(item=>item.id===id)?.task.jobId!==jobId)throw new Error('任务已取消或更改，迟到的结果已忽略');
    const checked=parseAIResult(result,requestBundle.request,state);
    commit(next=>{const target=next.cards.find(item=>item.id===id);if(!manual)applyMetadata(target,{...checked,origin:'ai'},'ai');target.task={...target.task,status:manual?'preview':'completed',error:'',updatedAt:new Date().toISOString()};});
    if(!manual){refreshDetailIfUnedited(id,expected);toast('模型整理完成，原话保留；关联仍需确认');}
    return {result,requestBundle,checked};
  });
  return promise.catch(error=>{
    safely(()=>commit(next=>{const target=next.cards.find(item=>item.id===id);if(target?.task.jobId===jobId&&['queued','running','preview'].includes(target.task.status))target.task={...target.task,status:revision!==modelRevision||error.message.includes('取消')?'cancelled':'failed',error:error.message.slice(0,500),updatedAt:new Date().toISOString()};}));
    throw error;
  });
}
function autoOrganize(card){
  if(!modelConfig?.auto)return;
  safely(()=>{const status=$('auto-status');status.hidden=false;status.textContent='原话已保存，卡片将依次整理；可在整理队列中查看进度。';scheduleCard(card.id).then(()=>{status.textContent='模型整理完成。候选关联需要你打开卡片、查看依据后确认。';}).catch(error=>{status.textContent=`原话已保存；整理未完成：${error.message}`;});});
}
function refreshDetailIfUnedited(id,before){
  if(selectedId!==id||!$('detail-dialog').open)return;
  if(!detailDirty)showDetail(id,false);else toast('模型已返回；你正在编辑的内容没有被覆盖，请重新打开卡片查看');
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
function commit(change){
  if(storageBlocked)throw new Error('浏览器存储不可用或数据损坏，请先导出原始备份；当前不会覆盖旧数据');
  const disk=localStorage.getItem(STORAGE_KEY);
  if(disk!==persisted){if(disk){state=validateState(JSON.parse(disk));}else{state=emptyState();}persisted=disk;render();throw new Error('另一窗口修改了卡片，已加载最新版本，请重试');}
  const next=structuredClone(state);change(next);const checked=validateState(next),json=JSON.stringify(checked);
  try{localStorage.setItem(STORAGE_KEY,json);}catch{throw new Error('没有保存成功：浏览器存储空间不足或不可用，请先导出备份');}
  state=checked;persisted=json;render();
}
function safely(fn){try{return fn();}catch(error){toast(error.message||'操作未完成，请重试');return false;}}
function current(){return state.cards.find(card=>card.id===selectedId);}
function openDialog(id){const dialog=$(id);if(!dialog.open)dialog.showModal();}
function closeDialog(id){$(id).close();}
function dateText(iso){return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit'}).format(new Date(iso));}
function cardButton(card,label=card.title){const button=node('button',label);button.type='button';button.addEventListener('click',()=>showDetail(card.id));return button;}
function cancelCard(id){
  queue.cancel(id);
  safely(()=>commit(next=>{const card=next.cards.find(item=>item.id===id);if(card)card.task={...card.task,status:'cancelled',error:'已取消。服务端仍可能已经计费。',updatedAt:new Date().toISOString()};}));
}
function retryCard(id){
  if(!modelConfig){showModel();toast('连接自己的模型后，再点击重试；不会自动补发');return;}
  safely(()=>{scheduleCard(id).catch(error=>toast(error.message));toast('已加入整理队列');});
}
function renderQueue(){
  const tasks=state.cards.filter(card=>card.task.status!=='idle').sort((a,b)=>{
    const order={running:0,queued:1,failed:2,interrupted:2,preview:3,cancelled:4,completed:5};
    return order[a.task.status]-order[b.task.status]||b.task.updatedAt.localeCompare(a.task.updatedAt);
  });
  const pending=tasks.filter(card=>['queued','running'].includes(card.task.status)).length;
  $('queue-count').textContent=pending;
  $('queue-summary').textContent=`${pending} 张等待或正在整理 · ${tasks.filter(card=>['failed','interrupted'].includes(card.task.status)).length} 张未完成。失败后只由你手动重试。`;
  const list=$('queue-list');list.replaceChildren();
  if(!tasks.length){list.append(node('p','还没有模型整理任务。本地记录不需要连接模型。','hint'));return;}
  for(const card of tasks.slice(0,60)){
    const el=node('article','','queue-item');el.append(node('h3',card.title),node('p',TASK_LABELS[card.task.status]));
    if(card.task.error)el.append(node('p',card.task.error));
    const actions=node('div','','button-row'),open=cardButton(card,'查看卡片');open.className='secondary';actions.append(open);
    if(['queued','running'].includes(card.task.status)){
      const cancel=node('button','取消任务','quiet');cancel.addEventListener('click',()=>cancelCard(card.id));actions.append(cancel);
    }else if(['failed','interrupted','cancelled'].includes(card.task.status)&&!card.archived){
      const retry=node('button','手动重试','primary');retry.addEventListener('click',()=>retryCard(card.id));actions.append(retry);
    }
    el.append(actions);list.append(el);
  }
  if(tasks.length>60)list.append(node('p','这里只显示最近及优先处理的 60 个任务。所有卡片仍可在收件箱查看。','hint'));
}
function renderDetailAux(){
  const card=current();if(!card)return;
  $('detail-task').textContent=`${TASK_LABELS[card.task.status]}${card.task.error?` · ${card.task.error}`:''}`;
  $('detail-retry').hidden=!['failed','interrupted','cancelled'].includes(card.task.status)||card.archived;
  const box=$('detail-history');box.replaceChildren();
  if(!card.history.length){box.append(node('p','整理或修改前会保存版本，最多保留最近 8 次。','hint'));return;}
  box.append(node('h3','修改历史'));
  const restore=node('button','撤销最近一次修改','secondary');restore.addEventListener('click',()=>safely(()=>{cancelCard(card.id);commit(next=>undoLatest(next.cards.find(item=>item.id===card.id)));showDetail(card.id,false);toast('已恢复上一版本。原话与已确认联系保留');}));box.append(restore);
  const details=node('details'),summary=node('summary',`查看 ${card.history.length} 个历史版本`);details.append(summary);
  for(const version of [...card.history].reverse()){
    const item=node('div','','history-item');item.append(node('p',`${version.change==='ai'?'AI 整理前':'手动修改前'} · ${dateText(version.savedAt)}`),node('p',version.title),node('p',version.nextStep?`下一步：${version.nextStep}`:'尚无下一步'));details.append(item);
  }
  box.append(details,node('p','撤销按最近一次逐步恢复，不会撤销已经确认的联系。','hint'));
}
function renderReview(){
  const list=$('review-list');list.replaceChildren();
  const chosen=selectReviewCards(state);
  if(!chosen.length){list.append(node('p','今天暂时没有需要重温的卡片。已回顾或暂缓的想法会在合适的时候再出现。','hint'));return;}
  for(const {card,reason}of chosen){
    const el=node('article','','review-item');el.append(node('h3',card.title),node('p',reason),node('p',card.raw.slice(0,280)));
    if(card.nextStep)el.append(node('p',`下一步：${card.nextStep}${card.nextStepDone?'（已完成）':''}`));
    const actions=node('div','','button-row'),continueButton=node('button','继续想','primary'),later=node('button','暂时放下七天','secondary');
    continueButton.addEventListener('click',()=>safely(()=>{commit(next=>{const target=next.cards.find(item=>item.id===card.id);target.lastReviewedAt=new Date().toISOString();target.snoozedUntil='';});closeDialog('review-dialog');showDetail(card.id);toast('已记录本次回顾，你可以继续编辑下一步');}));
    later.addEventListener('click',()=>safely(()=>{commit(next=>{const target=next.cards.find(item=>item.id===card.id);target.lastReviewedAt=new Date().toISOString();target.snoozedUntil=new Date(Date.now()+7*86400000).toISOString();});renderReview();toast('这张卡片将在七天后再进入回顾候选');}));
    actions.append(continueButton,later);el.append(actions);list.append(el);
  }
}
function empty(title,description,examples=false){const el=node('div','','empty');el.append(node('div','✧','empty-symbol'),node('h3',title),node('p',description));if(examples){const button=node('button','加入示例，看看它如何工作','secondary');button.addEventListener('click',addExamples);el.append(button);}return el;}
function render(){
  renderQueue();if($('detail-dialog').open)renderDetailAux();
  const active=state.cards.filter(card=>!card.archived),archived=state.cards.filter(card=>card.archived);
  $('count-inbox').textContent=active.length;$('count-archive').textContent=archived.length;$('count-links').textContent=state.links.length;
  $('total-stat').replaceChildren(node('span',String(state.cards.length)),node('small',' 个念头'));$('connection-stat').textContent=`${state.links.length} 条已确认的联系`;
  document.querySelectorAll('[data-view]').forEach(button=>{const on=button.dataset.view===view;button.classList.toggle('active',on);button.setAttribute('aria-current',on?'page':'false');});
  const tags=new Map();for(const card of active)for(const tag of card.tags)tags.set(tag,(tags.get(tag)||0)+1);
  $('tag-nav').replaceChildren();for(const [tag,count] of [...tags].sort((a,b)=>b[1]-a[1]).slice(0,8)){const button=node('button',`# ${tag}   ${count}`);button.classList.toggle('selected',tag===tagFilter);button.addEventListener('click',()=>{view='inbox';tagFilter=tag;render();});$('tag-nav').append(button);}
  const titles={inbox:['最近拾起的念头','先记录，再慢慢展开。'],connections:['灵感之间的联系','先看依据，再决定是否连起来。'],archive:['暂时放一放','归档的念头仍然保留，可以随时找回。']};
  $('view-title').textContent=titles[view][0];$('view-subtitle').textContent=titles[view][1];
  $('filter-banner').hidden=!tagFilter;if(tagFilter){$('filter-banner').replaceChildren(node('span',`正在查看：# ${tagFilter}`));const clear=node('button','查看全部');clear.addEventListener('click',()=>{tagFilter='';render();});$('filter-banner').append(clear);}
  const query=$('search').value.trim().toLowerCase(),matches=card=>(!tagFilter||card.tags.includes(tagFilter))&&[card.raw,card.title,card.nextStep,...card.tags,...card.keywords].join(' ').toLowerCase().includes(query);
  $('cards').replaceChildren();
  if(view==='connections'){renderConnections(query);return;}
  const cards=(view==='archive'?archived:active).filter(matches).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  if(!cards.length){$('cards').append(empty(query||tagFilter?'还没找到对应的念头':view==='archive'?'这里暂时没有归档':'第一张卡片，留给现在的你',query||tagFilter?'试试其他词语，或清除标签筛选。':view==='archive'?'打开卡片，可以把暂时不用的想法归档。':'随手写下一句话，或先加入三张示例。',view==='inbox'&&!query&&!tagFilter));return;}
  for(const card of cards){
    const el=node('article','','idea-card'),meta=node('div','','card-meta');meta.append(node('span',card.origin==='ai'?'AI 协作整理':'随手拾起','card-kind'),node('time',dateText(card.createdAt)));el.append(meta);
    const open=node('button','','card-open');open.type='button';open.append(node('h3',card.title),node('p',card.raw,'card-raw'));open.addEventListener('click',()=>showDetail(card.id));el.append(open);
    if(card.task.status!=='idle'){
      const taskRow=node('div','','card-task-row');taskRow.append(node('span',TASK_LABELS[card.task.status],`task-badge ${card.task.status}`));
      if(['failed','interrupted','cancelled'].includes(card.task.status)&&!card.archived){const retry=node('button','重试','quiet');retry.addEventListener('click',()=>retryCard(card.id));taskRow.append(retry);}
      el.append(taskRow);
    }
    if(card.sourceURL){const a=node('a','来源链接 ↗','card-source');a.href=card.sourceURL;a.target='_blank';a.rel='noopener noreferrer';el.append(a);}
    const footer=node('div','','card-footer'),chips=node('div','','tag-chips');for(const tag of card.tags.slice(0,3)){const b=node('button',`# ${tag}`,'tag-chip');b.addEventListener('click',()=>{tagFilter=tag;render();});chips.append(b);}if(!card.tags.length)chips.append(node('span','尚无标签','hint'));
    const links=state.links.filter(link=>link.a===card.id||link.b===card.id).length;
    const more=node('button',links?`${links} 条联系 ↗`:'展开想法 ↗','quiet');more.addEventListener('click',()=>showDetail(card.id));footer.append(chips,more);el.append(footer);$('cards').append(el);
  }
}
function renderConnections(query){
  const byId=new Map(state.cards.map(card=>[card.id,card]));let count=0;
  for(const link of [...state.links].reverse()){
    const a=byId.get(link.a),b=byId.get(link.b);if(![a.title,b.title,a.raw,b.raw,link.reason,link.type].join(' ').toLowerCase().includes(query))continue;
    const el=node('article','','connection-card'),titles=node('div','','connection-titles');titles.append(cardButton(a),node('span',`← ${link.type} →`,'connection-type'),cardButton(b));el.append(titles,node('p',link.reason||'这条联系由你确认。'));
    const remove=node('button','撤销这条联系','quiet');remove.addEventListener('click',()=>safely(()=>{commit(next=>next.links=next.links.filter(item=>pairKey(item.a,item.b)!==pairKey(link.a,link.b)));toast('联系已撤销，卡片原话保留');}));el.append(remove);$('cards').append(el);count++;
  }
  if(!count)$('cards').append(empty(query?'没有找到相关联系':'旧念头与新想法，在这里相遇',query?'试试其他词语。':'打开一张卡片，查看候选关联并确认。没有发现合适关联，也没关系。'));
}
function showDetail(id,recordView=true){
  const card=state.cards.find(card=>card.id===id);if(!card)return;
  if(recordView)safely(()=>commit(next=>next.cards.find(item=>item.id===id).lastViewedAt=new Date().toISOString()));
  selectedId=id;editFingerprint=fingerprint(card);$('detail-title').value=card.title;$('detail-raw').textContent=card.raw;$('detail-tags').value=card.tags.join('，');$('detail-next').value=card.nextStep;$('detail-archive').textContent=card.archived?'恢复到收件箱':'归档';
  $('detail-keywords').value=card.keywords.join('，');$('detail-next-done').checked=card.nextStepDone;detailDirty=false;
  $('detail-source').replaceChildren();if(card.sourceURL){const a=node('a','查看记录的来源 ↗','card-source');a.href=safeURL(card.sourceURL);a.target='_blank';a.rel='noopener noreferrer';$('detail-source').append(a);}
  renderDetailConnections();renderDetailAux();openDialog('detail-dialog');
}
function renderDetailConnections(){
  const card=current();if(!card)return;$('detail-related').replaceChildren();$('detail-links').replaceChildren();
  const suggestions=card.archived?[]:relatedSuggestions(card,state);
  if(!suggestions.length)$('detail-related').append(node('p',card.archived?'归档期间不推荐新关联。':'目前没有找到足够相近的旧卡片。','hint'));
  for(const suggestion of suggestions){
    const el=node('div','','related-item');el.append(node('h4',suggestion.card.title),node('p',suggestion.reason));
    if(suggestion.origin==='ai')el.append(node('p',`AI 提议 · 原话：「${suggestion.targetQuote}」 ↔ 「${suggestion.candidateQuote}」`));
    const actions=node('div','','related-actions'),select=node('select');select.setAttribute('aria-label','关联类型');for(const type of RELATION_TYPES){const option=node('option',type);option.value=type;select.append(option);}select.value=suggestion.type;
    const accept=node('button','连起来','primary');accept.addEventListener('click',()=>safely(()=>{commit(next=>{if(!next.links.some(link=>pairKey(link.a,link.b)===pairKey(card.id,suggestion.card.id)))next.links.push({a:card.id,b:suggestion.card.id,type:select.value,reason:suggestion.reason,createdAt:new Date().toISOString()});next.dismissed=next.dismissed.filter(key=>key!==pairKey(card.id,suggestion.card.id));});renderDetailConnections();toast('已连起来，你可以随时撤销');}));
    const dismiss=node('button','暂不关联','quiet');dismiss.addEventListener('click',()=>safely(()=>{commit(next=>next.dismissed.push(pairKey(card.id,suggestion.card.id)));renderDetailConnections();toast('已忽略这组候选关联');}));
    const open=cardButton(suggestion.card,'查看原话 ↗');open.className='quiet';actions.append(select,accept,dismiss,open);el.append(actions);$('detail-related').append(el);
  }
  const links=state.links.filter(link=>link.a===card.id||link.b===card.id);
  if(!links.length)$('detail-links').append(node('p','还没有确认的联系。','hint'));
  for(const link of links){const other=state.cards.find(item=>item.id===(link.a===card.id?link.b:link.a));const el=node('div','','related-item');el.append(cardButton(other,`${link.type} · ${other.title}`),node('p',link.reason));const remove=node('button','撤销联系','quiet');remove.addEventListener('click',()=>safely(()=>{commit(next=>next.links=next.links.filter(item=>pairKey(item.a,item.b)!==pairKey(link.a,link.b)));renderDetailConnections();}));el.append(remove);$('detail-links').append(el);}
}
function addExamples(){safely(()=>{
  const examples=[['demo-research-tool','想做一个让科研读文献更容易产生实验想法的工具。'],['demo-reading-question','每篇论文读完，记录一个还没被回答的问题，让文献阅读产生新的实验想法。'],['demo-walking','周末散步时不带耳机，看看能不能注意到平时忽略的小细节。']];
  let added=0;commit(next=>{for(const [id,raw]of examples)if(!next.cards.some(card=>card.id===id)){next.cards.push(createCard(raw,'',id));added++;}});toast(added?`已加入 ${added} 张示例。打开前两张，看看它们的联系。`:'示例已经在卡片列表里');
});}
function beginAI(id){
  const card=state.cards.find(item=>item.id===id);if(!card)return;
  $('ai-expanded').checked=modelConfig?.expanded||false;regenerateAI(id);openDialog('ai-dialog');
}
function regenerateAI(id=aiBundle?.request.cardId){
  const card=state.cards.find(item=>item.id===id);if(!card)return;
  aiBundle=makeAIRequest(card,state,undefined,{expanded:$('ai-expanded').checked});aiPreview=null;$('ai-prompt').value=aiBundle.prompt;$('ai-result').value='';$('ai-preview').hidden=true;$('ai-preview').replaceChildren();$('model-call-status').textContent='';
  const titles=aiBundle.request.candidateIds.map(candidateId=>state.cards.find(item=>item.id===candidateId).title).join('；');
  $('ai-scope').textContent=`本次发送：当前原话 ＋ ${aiBundle.request.candidateIds.length} 张旧卡片片段（每张最多 1400 字符）。${titles?`候选：${titles}。`:''}点击发送或自行复制粘贴后，内容才交给你选择的服务。`;
}
function downloadJSON(content,filename){const blob=new Blob([content],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('capture-form').addEventListener('submit',event=>{event.preventDefault();safely(()=>{const card=createCard($('idea-input').value,$('source-input').value.trim());commit(next=>next.cards.push(card));$('idea-input').value='';$('source-input').value='';$('source-row').hidden=true;view='inbox';tagFilter='';$('search').value='';render();toast('已保存原话，点开卡片可查看候选关联');$('idea-input').focus();void autoOrganize(card);});});
$('idea-input').addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();$('capture-form').requestSubmit();}});
$('source-toggle').addEventListener('click',()=>{$('source-row').hidden=!$('source-row').hidden;if(!$('source-row').hidden)$('source-input').focus();else $('source-input').value='';});
$('search').addEventListener('input',render);
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;tagFilter='';render();}));
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>closeDialog(button.dataset.close)));
$('settings-open').addEventListener('click',()=>openDialog('settings-dialog'));
$('settings-compact').addEventListener('click',()=>openDialog('settings-dialog'));
$('examples').addEventListener('click',addExamples);
$('detail-form').addEventListener('submit',event=>{event.preventDefault();safely(()=>{if(!current()||fingerprint(current())!==editFingerprint)throw new Error('卡片已更改，请保留输入后重新打开；不会覆盖新内容');commit(next=>{const card=next.cards.find(item=>item.id===selectedId);const keywords=[...new Set($('detail-keywords').value.split(/[,，、\n]/).map(word=>word.trim()).filter(Boolean))];applyMetadata(card,{title:$('detail-title').value.trim(),tags:tagsFromInput($('detail-tags').value),keywords,nextStep:$('detail-next').value.trim(),nextStepDone:$('detail-next-done').checked},'manual');});editFingerprint=fingerprint(current());detailDirty=false;toast('修改已保存，原话保留；可撤销最近一次修改');});});
for(const id of ['detail-title','detail-tags','detail-keywords','detail-next','detail-next-done'])$(id).addEventListener('input',()=>detailDirty=true);
$('detail-retry').addEventListener('click',()=>retryCard(selectedId));
$('detail-archive').addEventListener('click',()=>safely(()=>{if(queue.has(selectedId))cancelCard(selectedId);commit(next=>{const card=next.cards.find(item=>item.id===selectedId);card.archived=!card.archived;card.updatedAt=new Date().toISOString();});closeDialog('detail-dialog');toast(current().archived?'已归档，可以在“已归档”里恢复':'已恢复到收件箱');}));
$('detail-ai').addEventListener('click',()=>beginAI(selectedId));
$('model-open').addEventListener('click',showModel);
$('model-preset').addEventListener('change',()=>{const preset=MODEL_PRESETS[$('model-preset').value];if(preset.endpoint){$('model-endpoint').value=preset.endpoint;$('model-key').value='';$('model-name').value='';}$('preset-hint').textContent=preset.hint;});
$('model-form').addEventListener('submit',event=>{event.preventDefault();safely(()=>{if(saveModel()){closeDialog('model-dialog');toast('模型连接已设置，密钥仅保留在当前页面');}});});
$('test-model').addEventListener('click',async()=>{
  try{if(!saveModel())return;$('test-model').disabled=true;$('model-config-status').textContent='正在用固定测试文字检查连接…';await queue.enqueue('__connection-test',signal=>withModel('请仅回复：连接正常。',{test:true,signal}));$('model-config-status').textContent='连接验证成功。测试没有发送卡片内容；这不保证后续整理质量。';}
  catch(error){$('model-config-status').textContent=error.message;}finally{$('test-model').disabled=false;}
});
$('disconnect-model').addEventListener('click',()=>{stopCalls();modelConfig=null;$('model-key').value='';$('model-auto').checked=false;updateModelMode();$('model-config-status').textContent='已断开，当前页面保留的密钥已清除。';toast('模型已断开，卡片仍保留');});
$('forget-model').addEventListener('click',()=>{stopCalls();modelConfig=null;modelPreferences=null;safely(()=>localStorage.removeItem(PREFERENCES_KEY));$('model-endpoint').value='';$('model-name').value='';$('model-key').value='';$('model-auto').checked=false;updateModelMode();$('model-config-status').textContent='已忘记地址和模型名称，并清除当前页面密钥。';});
$('call-model').addEventListener('click',async()=>{
  if(!modelConfig){showModel();return;}const bundle=aiBundle;if(!bundle)return;
  $('call-model').disabled=true;$('cancel-model').hidden=false;$('model-call-status').textContent='正在发送本次请求到你的模型…';
  $('ai-expanded').disabled=true;
  try{const response=await scheduleCard(bundle.request.cardId,{bundle,manual:true});if(aiBundle!==bundle||!$('ai-dialog').open)return;$('ai-result').value=response.result;$('preview-ai').click();$('model-call-status').textContent='模型已返回。请检查预览，再确认更新卡片。';}
  catch(error){$('model-call-status').textContent=error.message;}finally{$('call-model').disabled=false;$('cancel-model').hidden=true;$('ai-expanded').disabled=false;}
});
$('cancel-model').addEventListener('click',()=>{if(aiBundle)cancelCard(aiBundle.request.cardId);});
$('ai-expanded').addEventListener('change',()=>regenerateAI());
$('ai-dialog').addEventListener('close',()=>{if(!aiBundle)return;const card=state.cards.find(item=>item.id===aiBundle.request.cardId);if(!$('cancel-model').hidden)cancelCard(aiBundle.request.cardId);else if(card?.task.status==='preview')safely(()=>commit(next=>{const target=next.cards.find(item=>item.id===card.id);target.task={...target.task,status:'interrupted',error:'模型结果未确认保存。可重新整理，也可粘贴原结果。',updatedAt:new Date().toISOString()};}));});
$('copy-prompt').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('ai-prompt').value);toast('已复制，在常用 AI 中粘贴即可');}catch{$('ai-prompt').focus();$('ai-prompt').select();toast('浏览器没有允许自动复制，请复制已选中的请求');}});
$('ai-result').addEventListener('input',()=>{aiPreview=null;$('ai-preview').hidden=true;});
$('preview-ai').addEventListener('click',()=>safely(()=>{
  if(!aiBundle)throw new Error('请先打开一张卡片生成请求');
  aiPreview=parseAIResult($('ai-result').value,aiBundle.request,state);const box=$('ai-preview');box.replaceChildren(node('h3','将要更新的内容'),node('p',`标题：${aiPreview.title}`),node('p',`标签：${aiPreview.tags.join('、')||'无'}`),node('p',`下一步：${aiPreview.nextStep||'暂不添加'}`));
  for(const rel of aiPreview.aiSuggestions)box.append(node('p',`候选关联：${rel.type} · ${rel.reason}\n原话：「${rel.targetQuote}」 ↔ 「${rel.candidateQuote}」`));
  box.append(node('p','原话保留。关联仅作为候选建议，仍需你逐条确认。','hint'));
  const apply=node('button','确认更新卡片','primary');apply.addEventListener('click',()=>safely(()=>{const checked=parseAIResult($('ai-result').value,aiBundle.request,state);commit(next=>{const card=next.cards.find(item=>item.id===aiBundle.request.cardId);applyMetadata(card,{...checked,origin:'ai'},'ai');card.task={...card.task,status:'completed',error:'',updatedAt:new Date().toISOString()};});closeDialog('ai-dialog');showDetail(aiBundle.request.cardId,false);toast('AI 整理已保存，可撤销修改；关联等待你确认');}));box.append(apply);box.hidden=false;
}));
$('export').addEventListener('click',()=>safely(()=>{const raw=storageBlocked?localStorage.getItem(STORAGE_KEY):JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2);if(!raw)throw new Error('没有可以导出的数据');downloadJSON(raw,`shinian-backup-${new Date().toISOString().slice(0,10)}.json`);toast(storageBlocked?'已导出原始存储，请保留以便恢复':'备份已导出');}));
$('import-open').addEventListener('click',()=>$('import-file').click());
$('import-file').addEventListener('change',async()=>{const file=$('import-file').files[0];if(!file)return;try{if(file.size>15*1024*1024)throw new Error('备份文件请小于 15 MB');const incoming=validateState(JSON.parse(await file.text()));const before=state.cards.length;commit(next=>Object.assign(next,mergeBackup(next,incoming)));toast(`已合并备份，新增 ${state.cards.length-before} 张卡片；已有卡片保留当前版本`);}catch(error){toast(error.message||'备份导入失败');}finally{$('import-file').value='';}});
window.addEventListener('storage',event=>{if(event.key!==STORAGE_KEY)return;try{state=event.newValue?validateState(JSON.parse(event.newValue)):emptyState();persisted=event.newValue;storageBlocked=false;render();if($('detail-dialog').open||$('ai-dialog').open)toast('其他窗口更新了数据，保存前会检查卡片是否变化');}catch{storageBlocked=true;toast('其他窗口的数据无法读取，已停止写入以保护原记录');}});
try{persisted=localStorage.getItem(STORAGE_KEY);if(persisted)state=validateState(JSON.parse(persisted));}catch{storageBlocked=true;toast('现有数据无法读取，已停止写入；请从使用说明导出原始备份');}
try{const prefs=localStorage.getItem(PREFERENCES_KEY);if(prefs)modelPreferences=parsePreferences(prefs);}catch{modelPreferences=null;}
if(!storageBlocked)safely(()=>{const recovered=structuredClone(state);if(recoverTasks(recovered,tabId))commit(next=>Object.assign(next,recovered));});
$('queue-open').addEventListener('click',()=>{renderQueue();openDialog('queue-dialog');});
$('cancel-all').addEventListener('click',()=>{stopCalls();toast('当前窗口的整理任务已取消，不会自动重试');});
$('recover-abandoned').addEventListener('click',()=>safely(()=>{let count=0;commit(next=>{for(const card of next.cards)if(['queued','running','preview'].includes(card.task.status)&&!queue.has(card.id)){card.task={...card.task,status:'interrupted',error:'已由你标记为未完成。请确认原窗口已关闭，再决定是否重试。',updatedAt:new Date().toISOString()};count++;}});toast(count?`已标记 ${count} 个遗留任务，未调用模型`:'没有可处理的遗留任务');}));
$('review-open').addEventListener('click',()=>{renderReview();openDialog('review-dialog');});
$('date-label').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());render();
if('serviceWorker' in navigator){
  let waitingWorker=null;
  navigator.serviceWorker.register('./sw.js').then(registration=>{
    const offer=worker=>{waitingWorker=worker;$('update-app').hidden=false;};
    if(registration.waiting)offer(registration.waiting);
    registration.addEventListener('updatefound',()=>{const installing=registration.installing;installing?.addEventListener('statechange',()=>{if(installing.state==='installed'&&navigator.serviceWorker.controller)offer(installing);});});
  }).catch(()=>{});
  $('update-app').addEventListener('click',()=>{if(queue.size||($('detail-dialog').open&&detailDirty)||$('ai-dialog').open||$('idea-input').value.trim()){toast('请先保存输入、关闭编辑，并等待或取消模型任务后再更新');return;}waitingWorker?.postMessage({type:'ACTIVATE_UPDATE'});});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(waitingWorker)location.reload();});
}
