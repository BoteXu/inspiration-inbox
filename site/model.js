export function validateConnection({endpoint,model,apiKey='',auto=false}) {
  let url;try{url=new URL(endpoint.trim());}catch{throw new Error('请填写完整的模型接口地址');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new Error('模型服务请使用 HTTPS；本机服务可使用 localhost 或 127.0.0.1');
  if(url.username||url.password||url.search||url.hash)throw new Error('请不要在地址中包含密码、查询密钥或锚点');
  if(!url.pathname.endsWith('/chat/completions'))throw new Error('请填写完整的 Chat Completions 地址，以 /chat/completions 结尾');
  if(typeof model!=='string'||!model.trim()||model.length>120)throw new Error('请填写服务提供的模型名称');
  if(typeof apiKey!=='string'||apiKey.length>1000||/[\r\n]/.test(apiKey))throw new Error('密钥格式不正确');
  return {endpoint:url.href,model:model.trim(),apiKey:apiKey.trim(),auto:Boolean(auto)};
}
export async function callChat(config,prompt,{signal,fetchImpl=fetch,test=false}={}) {
  const validated=validateConnection(config),headers={'Content-Type':'application/json'};
  if(validated.apiKey)headers.Authorization=`Bearer ${validated.apiKey}`;
  const timeout=AbortSignal.timeout(60000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let response;
  try{response=await fetchImpl(validated.endpoint,{method:'POST',headers,body:JSON.stringify({model:validated.model,messages:[{role:'user',content:prompt}],stream:false,max_tokens:test?64:2500}),credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:combined,cache:'no-store'});}catch(error){
    if(signal?.aborted)throw new Error('请求已取消；模型服务可能已经产生调用费用');
    if(timeout.aborted||error.name==='TimeoutError')throw new Error('模型在 60 秒内未返回；原话仍已保存，可以稍后重试');
    throw new Error('无法连接模型：可能是网络、跨域 CORS、地址或浏览器对本机服务的限制。请检查自己的服务，或使用复制请求方式');
  }
  if(!response.ok){const messages={401:'密钥无效或没有权限',403:'服务拒绝访问，请检查密钥及服务权限',404:'接口地址或模型不存在',429:'服务额度不足或请求过于频繁'};throw new Error(messages[response.status]||`模型服务返回 HTTP ${response.status}，请到自己的服务检查状态`);}
  const text=await response.text();if(text.length>300000)throw new Error('模型响应过大，请使用较短的输出');
  let data;try{data=JSON.parse(text);}catch{throw new Error('模型服务返回的内容不是 JSON 响应');}
  if(data.choices?.[0]?.finish_reason==='length')throw new Error('模型输出被截断，请重试或改用其他模型');
  const content=data.choices?.[0]?.message?.content;
  if(typeof content!=='string'||!content.trim()||content.length>50000)throw new Error('模型没有返回可用的文本，请确认接口兼容 Chat Completions');
  return content;
}
