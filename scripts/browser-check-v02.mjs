import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createCard,STORAGE_KEY,emptyState} from '../site/core.js';
import {PREFERENCES_KEY} from '../site/model.js';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root=fileURLToPath(new URL('../',import.meta.url));
const origin=process.env.CHECK_URL||'http://127.0.0.1:4173/';
const out=fileURLToPath(new URL('../test-results/',import.meta.url));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const errors=[],checks=[];
const modelURL='https://models.example.test/v1/chat/completions';
try{
  const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  let calls=0,concurrent=0,peak=0,failNext=false,delay=180,payloads=[];
  await page.route(modelURL,async route=>{
    const req=route.request();
    if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS'}});return;}
    calls++;concurrent++;peak=Math.max(peak,concurrent);
    const shouldFail=failNext;failNext=false;
    const body=req.postDataJSON(),prompt=body.messages[0].content;
    payloads.push(body);
    try{
      await new Promise(resolve=>setTimeout(resolve,delay));
      if(shouldFail){await route.fulfill({status:429,headers:{'Access-Control-Allow-Origin':'*'},body:'never print this provider body'});return;}
      let content='连接正常';
      if(prompt.includes('待分析数据：')){
        const data=JSON.parse(prompt.split('待分析数据：\n')[1]);
        content=JSON.stringify({requestId:data.requestId,cardId:data.idea.id,title:`整理：${data.idea.raw.slice(0,20)}`,tags:['想法'],keywords:['知识缺口'],nextStep:'试一个小动作',relations:[]});
      }
      await route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})});
    }finally{concurrent--;}
  });
  await page.goto(origin);
  const store=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
  await page.locator('#model-open').click();
  assert.equal(await page.locator('#model-remember').isChecked(),false);
  await page.locator('#model-preset').selectOption('deepseek');assert.equal(await page.locator('#model-key').inputValue(),'');assert((await page.locator('#model-endpoint').inputValue()).includes('api.deepseek.com'));
  await page.locator('#model-preset').selectOption('custom');await page.locator('#model-endpoint').fill(modelURL);await page.locator('#model-name').fill('synthetic-model');await page.locator('#model-key').fill('fake-v02-key');await page.locator('#model-auto').check();await page.locator('#model-expanded').check();
  await page.locator('#model-remember').check();
  await page.getByRole('button',{name:'保存并测试'}).click();await page.locator('#model-config-status').filter({hasText:'连接验证成功'}).waitFor();await page.getByRole('button',{name:'关闭模型连接'}).click();
  assert.equal(calls,1);checks.push('template does not call provider; explicit connection test');
  delay=700;
  for(const text of ['读完论文，记下作者没有回答的问题。','产品应该帮助用户发现知识缺口。','周末留意公园里花朵的颜色。']){await page.locator('#idea-input').fill(text);await page.getByRole('button',{name:'收下灵感'}).click();}
  await page.waitForFunction(key=>{const s=JSON.parse(localStorage.getItem(key));return s?.cards.length===3&&s.cards.every(c=>c.task.status==='completed');},STORAGE_KEY);
  assert.equal(peak,1);assert.equal(calls,4);assert((await store()).cards.every(card=>card.history.length===1));checks.push('three captures processed serially; original text retained; history captured');
  await page.locator('.card-open').filter({hasText:'读完论文'}).click();const oldRaw=await page.locator('#detail-raw').innerText();await page.getByRole('button',{name:'撤销最近一次修改'}).click();assert.equal(await page.locator('#detail-raw').innerText(),oldRaw);assert(!(await page.locator('#detail-title').inputValue()).startsWith('整理：'));await page.getByRole('button',{name:'关闭详情',exact:true}).click();checks.push('undo restores pre-model metadata');
  failNext=true;delay=180;await page.locator('#idea-input').fill('模型失败时，也要保留我随手写下的念头。');await page.getByRole('button',{name:'收下灵感'}).click();
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).cards.some(c=>c.raw.startsWith('模型失败')&&c.task.status==='failed'),STORAGE_KEY);
  const afterFailure=calls;await page.waitForTimeout(450);assert.equal(calls,afterFailure);
  await page.locator('#queue-open').click();const failed=page.locator('.queue-item').filter({hasText:'模型失败时'});await failed.getByRole('button',{name:'手动重试'}).click();await failed.filter({hasText:'整理完成'}).waitFor();await page.getByRole('button',{name:'关闭整理队列'}).click();assert.equal(calls,afterFailure+1);checks.push('429 failure retained; no hidden retry; explicit retry succeeds');
  delay=1200;await page.locator('#idea-input').fill('等待模型时，我先手动改一下标题。');await page.getByRole('button',{name:'收下灵感'}).click();await page.locator('.card-open').filter({hasText:'等待模型时'}).click();await page.locator('#detail-title').fill('我的新标题优先');await page.getByRole('button',{name:'保存修改'}).click();await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).cards.some(c=>c.raw.startsWith('等待模型时')&&c.task.status==='failed'),STORAGE_KEY);assert.equal(await page.locator('#detail-title').inputValue(),'我的新标题优先');await page.getByRole('button',{name:'关闭详情',exact:true}).click();checks.push('late model result cannot overwrite a user edit');
  await page.locator('#idea-input').fill('这一次我主动取消整理。');await page.getByRole('button',{name:'收下灵感'}).click();await page.locator('#queue-open').click();await page.locator('.queue-item').filter({hasText:'主动取消'}).getByRole('button',{name:'取消任务'}).click();await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).cards.some(c=>c.raw.startsWith('这一次我')&&c.task.status==='cancelled'),STORAGE_KEY);await page.getByRole('button',{name:'关闭整理队列'}).click();checks.push('explicit task cancellation retains the card');
  const persisted=await page.evaluate(()=>({local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage})}));assert(!JSON.stringify(persisted).includes('fake-v02-key'));
  const prefs=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),PREFERENCES_KEY);assert.deepEqual(Object.keys(prefs).sort(),['endpoint','expanded','model','preset']);
  await page.reload();await page.locator('#model-open').click();assert.equal(await page.locator('#model-endpoint').inputValue(),modelURL);assert.equal(await page.locator('#model-name').inputValue(),'synthetic-model');assert.equal(await page.locator('#model-key').inputValue(),'');assert.equal(await page.locator('#model-auto').isChecked(),false);await page.getByRole('button',{name:'关闭模型连接'}).click();checks.push('non-secret preferences restored; key and auto authorization cleared');
  // Simulate a reload-interrupted task owned by this tab; no provider request is made to resume it.
  await page.evaluate(key=>{const s=JSON.parse(localStorage.getItem(key));s.cards[0].task={status:'running',error:'',kind:'organize',jobId:'interrupted-test',owner:sessionStorage.getItem('shinian.tab.id'),attempts:2,updatedAt:new Date().toISOString()};localStorage.setItem(key,JSON.stringify(s));},STORAGE_KEY);
  const beforeReload=calls;await page.reload();assert.equal((await store()).cards[0].task.status,'interrupted');assert.equal(calls,beforeReload);checks.push('reload marks unfinished work; does not resend');
  await page.locator('#review-open').click();const beforeReview=await page.locator('.review-item').count();assert(beforeReview>0&&beforeReview<=3);await page.locator('.review-item').first().getByRole('button',{name:'暂时放下七天'}).click();assert((await store()).cards.some(card=>Boolean(card.snoozedUntil)));await page.getByRole('button',{name:'关闭回顾'}).click();await page.locator('#review-open').click();await page.locator('.review-item').first().getByRole('button',{name:'继续想',exact:true}).click();await page.getByRole('button',{name:'关闭详情',exact:true}).click();checks.push('review chooses at most three and persists review/snooze');
  await page.locator('#idea-input').focus();await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:out+'desktop-v02.png',fullPage:true});
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mp=await mobile.newPage();mp.on('pageerror',e=>errors.push(e.message));await mp.goto(origin);await mp.getByRole('button',{name:'加入示例，看看它如何工作'}).click();await mp.locator('#review-open').click();assert((await mp.locator('.review-item').count())<=3);await mp.getByRole('button',{name:'关闭回顾'}).click();await mp.locator('#idea-input').focus();await mp.locator('#toast').waitFor({state:'hidden'});const widths=await mp.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(widths.scroll<=widths.width);await mp.screenshot({path:out+'mobile-v02.png',fullPage:true});await mobile.close();checks.push('mobile review and no horizontal overflow');
  assert.deepEqual(errors,[]);
  await context.close();

  // Upgrade an actual 0.1 service-worker cache with the real 0.2 source, using synthetic data only.
  if(!process.env.SKIP_UPGRADE_CHECK){
    const initial=execFileSync('git',['rev-list','--max-parents=0','HEAD'],{cwd:root,encoding:'utf8'}).trim();
    const names=['index.html','app.js','core.js','model.js','styles.css','model.css','sw.js','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png'];
    const oldFiles=new Map(names.map(name=>[name,execFileSync('git',['show',`${initial}:site/${name}`],{cwd:root,maxBuffer:1024*1024})]));
    let latest=false;
    const mime={html:'text/html',js:'text/javascript',css:'text/css',png:'image/png',svg:'image/svg+xml',webmanifest:'application/manifest+json'};
    const server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!/^[a-zA-Z0-9.-]+$/.test(name)){res.writeHead(404);res.end();return;}try{const bytes=latest?await readFile(new URL('../site/'+name,import.meta.url)):oldFiles.get(name);if(!bytes)throw Error();res.writeHead(200,{'Content-Type':mime[name.split('.').at(-1)]||'text/plain','Cache-Control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`;
    const upgrade=await browser.newContext();const up=await upgrade.newPage();up.on('pageerror',e=>errors.push(e.message));
    try{
      await up.goto(url);await up.getByRole('button',{name:'加入示例，看看它如何工作'}).click();await up.evaluate(async()=>{await navigator.serviceWorker.ready;});await up.reload();
      latest=true;await up.reload();await up.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});await up.locator('#update-app').waitFor();
      await up.locator('#idea-input').fill('升级前尚未保存的草稿');await up.locator('#update-app').click();assert.equal(await up.locator('#idea-input').inputValue(),'升级前尚未保存的草稿');await up.locator('#idea-input').fill('');
      await up.locator('#update-app').click();await up.waitForFunction(()=>document.querySelector('.main-footer')?.textContent.includes('v0.2'));await up.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
      await up.locator('#idea-input').fill('升级完成后保存的第四张卡片。');await up.getByRole('button',{name:'收下灵感'}).click();assert.equal(await up.locator('.idea-card').count(),4);
      await upgrade.setOffline(true);await up.reload();assert.equal(await up.locator('.idea-card').count(),4);assert.equal(await up.evaluate(key=>JSON.parse(localStorage.getItem(key)).version,STORAGE_KEY),2);checks.push('actual 0.1 cache upgrade preserves cards and protects unsaved draft; 0.2 works offline');
    }finally{await upgrade.close();await new Promise(resolve=>server.close(resolve));}
  }
  assert.deepEqual(errors,[]);
  await writeFile(out+'browser-v02.json',JSON.stringify({checkedAt:new Date().toISOString(),target:process.env.CHECK_URL?'published site':'local preview',checks,errors,realProviderCall:false,syntheticModelCalls:calls},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,realProviderCall:false,uncaughtErrors:errors.length}));
}finally{await browser.close();}
