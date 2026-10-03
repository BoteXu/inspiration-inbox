import { STORAGE_KEY, RELATION_TYPES, emptyState, createCard, validateState, mergeBackup, safeURL, tagsFromInput, pairKey, relatedSuggestions, fingerprint, makeAIRequest, parseAIResult } from './core.js';
import { validateConnection, callChat } from './model.js';
const $=id=>document.getElementById(id);
const node=(tag,text='',className='')=>{const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;};
let state=emptyState(), persisted=null, storageBlocked=false, view='inbox', tagFilter='', selectedId='', editFingerprint='', aiBundle=null, aiPreview=null;
let toastTimer;
let modelConfig=null, modelRevision=0, modelBusy=false;
const activeCalls=new Set();
function updateModelMode(verified=false){$('model-mode').textContent=modelConfig?(verified?'模型已验证':'模型已设置'):'本地整理';}
function stopCalls(){for(const controller of activeCalls)controller.abort();activeCalls.clear();modelRevision++;}
function showModel(){
  $('model-endpoint').value=modelConfig?.endpoint||'';$('model-name').value=modelConfig?.model||'';$('model-key').value='';$('model-auto').checked=modelConfig?.auto||false;
  $('model-key').placeholder=modelConfig?.apiKey?'当前地址的密钥已在内存中；留空可沿用':'无密钥的个人服务可留空';openDialog('model-dialog');
}
function saveModel(){
  if(!$('model-form').reportValidity())return false;
  const entered=$('model-key').value,endpoint=$('model-endpoint').value.trim();
  const config=validateConnection({endpoint,model:$('model-name').value,apiKey:entered||((modelConfig?.endpoint===endpoint)?modelConfig.apiKey:''),auto:$('model-auto').checked});
  stopCalls();modelConfig=config;$('model-key').value='';$('model-key').placeholder=config.apiKey?'密钥已保留在本页内存；刷新后清除':'无密钥的个人服务';updateModelMode();
  $('model-config-status').textContent='本次连接已设置，尚未经测试。地址或密钥有误时，原话仍会先保存。';return true;
}
async function withModel(prompt,options={}){
  if(!modelConfig)throw new Error('请先连接你自己的模型服务，也可以复制请求到常用 AI');
  if(modelBusy)throw new Error('已有模型请求进行中，请等待或取消后重试');
  const config={...modelConfig},revision=modelRevision,controller=new AbortController();modelBusy=true;activeCalls.add(controller);
  try{const result=await callChat(config,prompt,{signal:controller.signal,...options});if(revision!==modelRevision)throw new Error('模型连接已更改，本次结果已忽略');updateModelMode(true);return result;}
  finally{activeCalls.delete(controller);modelBusy=false;}
}
async function autoOrganize(card){
  if(!modelConfig?.auto)return;
  const status=$('auto-status');status.hidden=false;
  if(modelBusy){status.textContent='原话已保存。已有模型请求进行中，这张卡片可稍后打开手动整理。';return;}
  const bundle=makeAIRequest(card,state);status.textContent=`原话已保存，正在交给你的模型整理（包含 ${bundle.request.candidateIds.length} 张候选旧卡片）…`;
  try{const result=await withModel(bundle.prompt),checked=parseAIResult(result,bundle.request,state);commit(next=>{const target=next.cards.find(item=>item.id===card.id);Object.assign(target,checked,{origin:'ai',updatedAt:new Date().toISOString()});});status.textContent='模型整理完成。候选关联需要你打开卡片、查看依据后确认。';toast('卡片已由你的模型整理，原话保留');}
  catch(error){status.textContent=`原话已保存；自动整理未完成：${error.message}`;}
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
function empty(title,description,examples=false){const el=node('div','','empty');el.append(node('div','✧','empty-symbol'),node('h3',title),node('p',description));if(examples){const button=node('button','加入示例，看看它如何工作','secondary');button.addEventListener('click',addExamples);el.append(button);}return el;}
function render(){
  const active=state.cards.filter(card=>!card.archived),archived=state.cards.filter(card=>card.archived);
  $('count-inbox').textContent=active.length;$('count-archive').textContent=archived.length;$('count-links').textContent=state.links.length;
  $('total-stat').replaceChildren(node('span',String(state.cards.length)),node('small',' 个念头'));$('connection-stat').textContent=`${state.links.length} 条已确认的联系`;
  document.querySelectorAll('[data-view]').forEach(button=>{const on=button.dataset.view===view;button.classList.toggle('active',on);button.setAttribute('aria-current',on?'page':'false');});
  const tags=new Map();for(const card of active)for(const tag of card.tags)tags.set(tag,(tags.get(tag)||0)+1);
  $('tag-nav').replaceChildren();for(const [tag,count] of [...tags].sort((a,b)=>b[1]-a[1]).slice(0,8)){const button=node('button',`# ${tag}   ${count}`);button.classList.toggle('selected',tag===tagFilter);button.addEventListener('click',()=>{view='inbox';tagFilter=tag;render();});$('tag-nav').append(button);}
  const titles={inbox:['最近拾起的念头','先记录，再慢慢展开。'],connections:['灵感之间的联系','先看依据，再决定是否连起来。'],archive:['暂时放一放','归档的念头仍然保留，可以随时找回。']};
  $('view-title').textContent=titles[view][0];$('view-subtitle').textContent=titles[view][1];
  $('filter-banner').hidden=!tagFilter;if(tagFilter){$('filter-banner').replaceChildren(node('span',`正在查看：# ${tagFilter}`));const clear=node('button','查看全部');clear.addEventListener('click',()=>{tagFilter='';render();});$('filter-banner').append(clear);}
  const query=$('search').value.trim().toLowerCase(),matches=card=>(!tagFilter||card.tags.includes(tagFilter))&&[card.raw,card.title,card.nextStep,...card.tags].join(' ').toLowerCase().includes(query);
  $('cards').replaceChildren();
  if(view==='connections'){renderConnections(query);return;}
  const cards=(view==='archive'?archived:active).filter(matches).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  if(!cards.length){$('cards').append(empty(query||tagFilter?'还没找到对应的念头':view==='archive'?'这里暂时没有归档':'第一张卡片，留给现在的你',query||tagFilter?'试试其他词语，或清除标签筛选。':view==='archive'?'打开卡片，可以把暂时不用的想法归档。':'随手写下一句话，或先加入三张示例。',view==='inbox'&&!query&&!tagFilter));return;}
  for(const card of cards){
    const el=node('article','','idea-card'),meta=node('div','','card-meta');meta.append(node('span',card.origin==='ai'?'AI 协作整理':'随手拾起','card-kind'),node('time',dateText(card.createdAt)));el.append(meta);
    const open=node('button','','card-open');open.type='button';open.append(node('h3',card.title),node('p',card.raw,'card-raw'));open.addEventListener('click',()=>showDetail(card.id));el.append(open);
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
function showDetail(id){
  const card=state.cards.find(card=>card.id===id);if(!card)return;
  selectedId=id;editFingerprint=fingerprint(card);$('detail-title').value=card.title;$('detail-raw').textContent=card.raw;$('detail-tags').value=card.tags.join('，');$('detail-next').value=card.nextStep;$('detail-archive').textContent=card.archived?'恢复到收件箱':'归档';
  $('detail-source').replaceChildren();if(card.sourceURL){const a=node('a','查看记录的来源 ↗','card-source');a.href=safeURL(card.sourceURL);a.target='_blank';a.rel='noopener noreferrer';$('detail-source').append(a);}
  renderDetailConnections();openDialog('detail-dialog');
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
  aiBundle=makeAIRequest(card,state);aiPreview=null;$('ai-prompt').value=aiBundle.prompt;$('ai-result').value='';$('ai-preview').hidden=true;$('ai-preview').replaceChildren();$('model-call-status').textContent='';$('ai-scope').textContent=`本次请求：这张卡片 ＋ ${aiBundle.request.candidateIds.length} 张候选卡片的原话。点击发送或自行复制、粘贴后，内容才交给外部 AI。`;openDialog('ai-dialog');
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
$('detail-form').addEventListener('submit',event=>{event.preventDefault();safely(()=>{if(!current()||fingerprint(current())!==editFingerprint)throw new Error('卡片已在其他窗口更改，请关闭后重新打开');commit(next=>{const card=next.cards.find(item=>item.id===selectedId);card.title=$('detail-title').value.trim();card.tags=tagsFromInput($('detail-tags').value);card.nextStep=$('detail-next').value.trim();card.updatedAt=new Date().toISOString();});editFingerprint=fingerprint(current());toast('修改已保存，原话保留');});});
$('detail-archive').addEventListener('click',()=>safely(()=>{commit(next=>{const card=next.cards.find(item=>item.id===selectedId);card.archived=!card.archived;card.updatedAt=new Date().toISOString();});closeDialog('detail-dialog');toast(current().archived?'已归档，可以在“已归档”里恢复':'已恢复到收件箱');}));
$('detail-ai').addEventListener('click',()=>beginAI(selectedId));
$('model-open').addEventListener('click',showModel);
$('model-form').addEventListener('submit',event=>{event.preventDefault();safely(()=>{if(saveModel()){closeDialog('model-dialog');toast('模型连接已设置，密钥仅保留在当前页面');}});});
$('test-model').addEventListener('click',async()=>{
  try{if(!saveModel())return;$('test-model').disabled=true;$('model-config-status').textContent='正在用固定测试文字检查连接…';await withModel('请仅回复：连接正常。',{test:true});$('model-config-status').textContent='连接验证成功。测试没有发送卡片内容。';}
  catch(error){$('model-config-status').textContent=error.message;}finally{$('test-model').disabled=false;}
});
$('disconnect-model').addEventListener('click',()=>{stopCalls();modelConfig=null;$('model-key').value='';$('model-auto').checked=false;updateModelMode();$('model-config-status').textContent='已断开，当前页面保留的密钥已清除。';toast('模型已断开，卡片仍保留');});
$('call-model').addEventListener('click',async()=>{
  if(!modelConfig){showModel();return;}const bundle=aiBundle;if(!bundle)return;
  $('call-model').disabled=true;$('cancel-model').hidden=false;$('model-call-status').textContent='正在发送本次请求到你的模型…';
  try{const result=await withModel(bundle.prompt);if(aiBundle!==bundle||!$('ai-dialog').open)return;$('ai-result').value=result;$('preview-ai').click();$('model-call-status').textContent='模型已返回。请检查预览，再确认更新卡片。';}
  catch(error){$('model-call-status').textContent=error.message;}finally{$('call-model').disabled=false;$('cancel-model').hidden=true;}
});
$('cancel-model').addEventListener('click',stopCalls);
$('ai-dialog').addEventListener('close',()=>{if(!$('cancel-model').hidden)stopCalls();});
$('copy-prompt').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('ai-prompt').value);toast('已复制，在常用 AI 中粘贴即可');}catch{$('ai-prompt').focus();$('ai-prompt').select();toast('浏览器没有允许自动复制，请复制已选中的请求');}});
$('ai-result').addEventListener('input',()=>{aiPreview=null;$('ai-preview').hidden=true;});
$('preview-ai').addEventListener('click',()=>safely(()=>{
  if(!aiBundle)throw new Error('请先打开一张卡片生成请求');
  aiPreview=parseAIResult($('ai-result').value,aiBundle.request,state);const box=$('ai-preview');box.replaceChildren(node('h3','将要更新的内容'),node('p',`标题：${aiPreview.title}`),node('p',`标签：${aiPreview.tags.join('、')||'无'}`),node('p',`下一步：${aiPreview.nextStep||'暂不添加'}`));
  for(const rel of aiPreview.aiSuggestions)box.append(node('p',`候选关联：${rel.type} · ${rel.reason}\n原话：「${rel.targetQuote}」 ↔ 「${rel.candidateQuote}」`));
  box.append(node('p','原话保留。关联仅作为候选建议，仍需你逐条确认。','hint'));
  const apply=node('button','确认更新卡片','primary');apply.addEventListener('click',()=>safely(()=>{const checked=parseAIResult($('ai-result').value,aiBundle.request,state);commit(next=>{const card=next.cards.find(item=>item.id===aiBundle.request.cardId);Object.assign(card,checked,{origin:'ai',updatedAt:new Date().toISOString()});});closeDialog('ai-dialog');showDetail(aiBundle.request.cardId);toast('AI 整理已保存，候选关联等待你确认');}));box.append(apply);box.hidden=false;
}));
$('export').addEventListener('click',()=>safely(()=>{const raw=storageBlocked?localStorage.getItem(STORAGE_KEY):JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2);if(!raw)throw new Error('没有可以导出的数据');downloadJSON(raw,`shinian-backup-${new Date().toISOString().slice(0,10)}.json`);toast(storageBlocked?'已导出原始存储，请保留以便恢复':'备份已导出');}));
$('import-open').addEventListener('click',()=>$('import-file').click());
$('import-file').addEventListener('change',async()=>{const file=$('import-file').files[0];if(!file)return;try{if(file.size>15*1024*1024)throw new Error('备份文件请小于 15 MB');const incoming=validateState(JSON.parse(await file.text()));const before=state.cards.length;commit(next=>Object.assign(next,mergeBackup(next,incoming)));toast(`已合并备份，新增 ${state.cards.length-before} 张卡片；已有卡片保留当前版本`);}catch(error){toast(error.message||'备份导入失败');}finally{$('import-file').value='';}});
window.addEventListener('storage',event=>{if(event.key!==STORAGE_KEY)return;try{state=event.newValue?validateState(JSON.parse(event.newValue)):emptyState();persisted=event.newValue;storageBlocked=false;render();if($('detail-dialog').open||$('ai-dialog').open)toast('其他窗口更新了数据，保存前会检查卡片是否变化');}catch{storageBlocked=true;toast('其他窗口的数据无法读取，已停止写入以保护原记录');}});
try{persisted=localStorage.getItem(STORAGE_KEY);if(persisted)state=validateState(JSON.parse(persisted));}catch{storageBlocked=true;toast('现有数据无法读取，已停止写入；请从使用说明导出原始备份');}
$('date-label').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());render();
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
